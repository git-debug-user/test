/* ============================================================
   ar.js
   WebAR セッション管理 / Hit-Test / フレームループ
   ------------------------------------------------------------
   Pixel 7a + Chrome 150 向け修正点:
   ・requestSession() は1クリックにつき必ず1回だけ呼ぶ
     (以前は depth-sensing required → optional → なし、の3段階で
      同じクリック内に最大3回 requestSession() を呼んでいたが、
      requestSession() は呼んだ瞬間に transient user activation を
      消費する仕様のため、1回目が(許可プロンプトが出る前に)
      即 reject されると2回目以降は SecurityError で確実に失敗するだけ
      だった。これが「ARを開始を押してもカメラ画面に遷移しない」の
      直接の原因だったため、1回の requestSession() で
      depth-sensing を optionalFeatures として要求する構成に統一した)
   ・requestSession() にタイムアウトを設けた
     (許可プロンプトが出ないまま Promise が無期限 pending になる
      既知の挙動があり、それも「ボタンを押しても無反応」に見える
      原因になり得るため)
   ・クリック直後に即座にボタンの見た目を変える
     (体感的な "無反応" をなくす)
   ・エラーを showError (自動で消える) だけでなく console.error にも
     必ず出し、致命的な場合は本当にAR非対応と誤認させないよう
     区別して案内する
============================================================ */
import * as THREE from 'three';
import { patchOcclusionOnGroup } from './shaders.js';
import { createDepthState, updateDepthOcclusion } from './depth.js';
import { syncMeshesToPhysics, clockDelta, ensurePlaneColliderNear, addPhysicsBodyForGroup } from './physics.js';
import { buildObjectFromSpec, clamp } from './objects.js';
import { analyzeScene, labelForType } from './ai.js';

const SESSION_REQUEST_TIMEOUT_MS = 12000;

function withTimeout(promise, ms, message) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/* 重要: navigator.xr.requestSession() は Fullscreen API などと同じ
   "activation-consuming API" で、呼び出した瞬間にそのクリック(タップ)の
   transient user activation を消費する。これは呼び出しが成功しても
   失敗しても関係なく消費される。
   そのため「1回目は depth-sensing を required で試す → 失敗したら
   2回目・3回目を同じクリック内で呼んでフォールバックする」という
   多段リトライは、1回目が(許可プロンプトが出る前に) NotSupportedError
   等で即 reject された場合、2回目以降は user activation が
   残っておらず SecurityError で即座に失敗するだけになる。
   これが「ARを開始を押してもカメラ画面に遷移しない」の実体だった。
   → 1クリックにつき requestSession() は必ず1回だけ呼ぶ。
   depth-sensing は最初から optionalFeatures にしておき、ARCore が
   提供できなければ黙って外れるだけで hit-test セッション自体は
   成立するようにする(depth を requiredFeatures に入れて全体を
   道連れにしない)。 */
function buildSessionConfig() {
  return {
    requiredFeatures: ['hit-test'],
    optionalFeatures: ['dom-overlay', 'depth-sensing'],
    depthSensing: {
      usagePreference: ['gpu-optimized'],
      dataFormatPreference: ['luminance-alpha', 'float32'],
    },
    domOverlay: { root: document.body },
  };
}

export async function requestARSession(navigatorXr) {
  const config = buildSessionConfig();
  try {
    console.info('[AR] requestSession (single attempt, depth-sensing optional)');
    const session = await withTimeout(
      navigatorXr.requestSession('immersive-ar', config),
      SESSION_REQUEST_TIMEOUT_MS,
      'ARセッションの許可プロンプトがタイムアウトしました。Chromeのカメラ/AR権限設定をご確認ください。'
    );
    console.info('[AR] session started. enabledFeatures:', session.enabledFeatures);
    return session;
  } catch (e) {
    console.warn('[AR] requestSession failed:', e.name, '-', e.message);
    // dom-overlay 込みの要求自体が原因で reject されるごく一部の端末向けに、
    // "次のタップ" で再挑戦できるよう、ここでは同一クリック内で
    // 再度 requestSession() を呼ばずにそのままエラーを投げる
    // (呼んでも user activation が無いので必ず SecurityError になるだけ)。
    throw e;
  }
}

/**
 * ctx: {
 *   state, el, renderer, scene, camera, reticle,
 *   physicsWorld, placedObjects, physicsBodies, planeColliders
 * }
 */
export async function startAR(ctx) {
  const { state, el } = ctx;

  if (!navigator.xr) {
    ctx.el.notSupported.style.display = 'flex';
    return;
  }

  // クリック直後、何かが起きていることを即座に見せる(体感の "無反応" を無くす)
  el.startBtn.disabled = true;
  const originalLabel = el.startBtn.textContent;
  el.startBtn.textContent = 'ARセッションを起動中…';

  try {
    const supported = await navigator.xr.isSessionSupported('immersive-ar').catch(() => null);
    if (supported === false) {
      el.notSupported.style.display = 'flex';
      return;
    }

    const session = await requestARSession(navigator.xr);
    state.session = session;

    ctx.depthState = createDepthState();
    ctx.xrGlBinding = null;

    el.startOverlay.style.display = 'none';
    el.hud.style.display = 'block';

    ctx.renderer.xr.setReferenceSpaceType('local');
    await ctx.renderer.xr.setSession(session);

    ctx.xrRefSpace = ctx.renderer.xr.getReferenceSpace();
    const viewerSpace = await session.requestReferenceSpace('viewer');
    state.hitTestSource = await session.requestHitTestSource({ space: viewerSpace });

    // 重要: XRSession のプロパティは `preferredDepthFormat` ではなく
    // 仕様上 `depthDataFormat` が正しい名前 (W3C WebXR Depth Sensing Module /
    // MDN XRSession.depthDataFormat 準拠)。存在しないプロパティへの
    // アクセスは常に undefined を返すため例外にはならず、この綴り間違いは
    // 「isFloatFormat が常に false のまま」という形で静かに残ってしまい、
    // luminance-alpha 以外(float32)が選択された端末ではシェーダーが
    // 誤ったパッキング解釈で深度をサンプリングし続け、
    // オクルージョンが無効/破綻して見える原因になっていた。
    // また `depthDataFormat` は depth-sensing が有効でないセッションで
    // 参照すると InvalidStateError を投げる仕様のため、
    // enabledFeatures の確認より前で読んではいけない。
    if (session.enabledFeatures?.includes('depth-sensing')) {
      ctx.depthState.isFloatFormat = session.depthDataFormat === 'float32';
      console.info('[Depth] feature enabled, usage:', session.depthUsage, 'format:', session.depthDataFormat);
      // renderer.xr.getBinding() は使わず、この時点(setSession完了後、
      // = renderer.getContext() が XR compatible になった後) に
      // 自前で XRWebGLBinding を生成する。Chrome 150 では
      // getBinding() のキャッシュ管理が絡んで depth 情報が
      // 取得できない/オクルージョンが効かないケースがあったため。
      try {
        const gl = ctx.renderer.getContext();
        ctx.xrGlBinding = new XRWebGLBinding(session, gl);
      } catch (e) {
        console.warn('[Depth] XRWebGLBinding の生成に失敗しました:', e.message);
        ctx.showError('Depth API の初期化に失敗しました(物理のみ動作)');
      }
    } else {
      console.warn('[Depth] depth-sensing not in enabledFeatures — occlusion disabled');
      ctx.showError('この端末/ブラウザでは Depth API が無効です(物理のみ動作)');
    }

    session.addEventListener('end', () => onSessionEnd(ctx));
    ctx.setStatus('平面を探しています…', '');
    ctx.renderer.setAnimationLoop((t, frame) => onXRFrame(ctx, t, frame));
  } catch (err) {
    console.error('[AR] startAR failed:', err);
    ctx.showError('ARセッションを開始できませんでした: ' + err.message, true);
  } finally {
    // 失敗時のみボタンを元に戻す(成功時はオーバーレイごと非表示になる)
    if (!state.session) {
      el.startBtn.disabled = false;
      el.startBtn.textContent = originalLabel;
    }
  }
}

export function onSessionEnd(ctx) {
  const { state, el, renderer, scene, placedObjects, physicsBodies, planeColliders, physicsWorld } = ctx;
  renderer.setAnimationLoop(null);
  state.session = null;
  state.hitTestSource = null;
  if (ctx.depthState) {
    ctx.depthState.enabled = false;
    ctx.depthState.notified = false;
    ctx.depthState.depthTextureWrapper = null;
  }
  ctx.xrGlBinding = null;
  el.hud.style.display = 'none';
  el.startOverlay.style.display = 'flex';
  el.startBtn.disabled = false;
  el.startBtn.textContent = 'ARを開始';
  // clear placed objects
  placedObjects.forEach(o => scene.remove(o));
  placedObjects.length = 0;
  // clear physics bodies
  physicsBodies.forEach(pb => physicsWorld.removeBody(pb.body));
  physicsBodies.length = 0;
  planeColliders.forEach(b => physicsWorld.removeBody(b));
  planeColliders.length = 0;
}

/* ============================================================
   CAPTURE CAMERA FRAME -> Canvas (for local TF.js inference)
============================================================ */
function captureFrameCanvas(renderer) {
  const glCanvas = renderer.domElement;
  const targetW = 480;
  const targetH = Math.round(targetW * (glCanvas.height / glCanvas.width));
  const tmp = document.createElement('canvas');
  tmp.width = targetW;
  tmp.height = targetH;
  const ctx2d = tmp.getContext('2d');
  ctx2d.drawImage(glCanvas, 0, 0, targetW, targetH);
  return tmp;
}

function placeObject(ctx, spec, matrixArray) {
  const { scene, placedObjects, physicsWorld, planeColliders, physicsBodies } = ctx;
  const group = buildObjectFromSpec(spec);
  group.matrixAutoUpdate = true;
  const m = new THREE.Matrix4().fromArray(matrixArray);
  const pos = new THREE.Vector3();
  const quat = new THREE.Quaternion();
  const scaleV = new THREE.Vector3();
  m.decompose(pos, quat, scaleV);

  group.position.copy(pos);
  scene.add(group);
  placedObjects.push(group);

  // GPU Depth Occlusion 用シェーダーパッチを全メッシュに適用
  patchOcclusionOnGroup(group);

  ensurePlaneColliderNear(physicsWorld, planeColliders, pos, quat);
  addPhysicsBodyForGroup(physicsWorld, physicsBodies, group, spec, 0.18);

  const targetScale = group.scale.x;
  group.scale.setScalar(0.001);
  const start = performance.now();
  function pop() {
    const t = clamp((performance.now() - start) / 320, 0, 1);
    const eased = 1 - Math.pow(1 - t, 3);
    group.scale.setScalar(targetScale * eased);
    if (t < 1) requestAnimationFrame(pop);
  }
  pop();
}

export async function onShutterPress(ctx) {
  const { state, el } = ctx;
  if (state.busy) return;
  if (!state.lastReticlePose) {
    ctx.showError('まず平面を検出してください');
    return;
  }

  state.busy = true;
  el.shutter.classList.add('busy');
  ctx.setStatus('シーンを解析中…', 'busy');

  const placementMatrix = state.lastReticlePose.transform.matrix.slice();

  try {
    const frameCanvas = captureFrameCanvas(ctx.renderer);
    const spec = await analyzeScene(frameCanvas);
    placeObject(ctx, spec, placementMatrix);
    showResultCard(ctx, spec);
    ctx.setStatus('配置完了 — 次の場所もスキャンできます', 'ready');
  } catch (err) {
    console.error(err);
    ctx.showError(err.message || '生成に失敗しました');
    ctx.setStatus('平面検出 OK — シャッターでスキャン', 'ready');
  } finally {
    state.busy = false;
    el.shutter.classList.remove('busy');
  }
}

function showResultCard(ctx, spec) {
  const { el } = ctx;
  el.resultScene.textContent = spec.scene_label || 'シーン';
  el.resultObjType.textContent = labelForType(spec.object_type);
  el.resultDesc.textContent = spec.description || '';
  el.resultCard.classList.add('visible');
  clearTimeout(showResultCard._t);
  showResultCard._t = setTimeout(() => el.resultCard.classList.remove('visible'), 6000);
}

/* ============================================================
   XR FRAME LOOP — Hit-Test / Physics / GPU Depth Occlusion
============================================================ */
export function onXRFrame(ctx, timestamp, frame) {
  if (!frame) return;
  const { state, el, renderer, reticle, physicsWorld, physicsBodies } = ctx;
  const refSpace = renderer.xr.getReferenceSpace();
  const dt = clockDelta();

  // --- GPU Depth Occlusion ---
  const depthOk = updateDepthOcclusion(state.session, renderer, ctx.xrGlBinding, frame, refSpace, ctx.depthState, ctx.placedObjects);
  if (depthOk && !ctx.depthState.notified) {
    ctx.depthState.enabled = true;
    ctx.depthState.notified = true;
    if (state.reticleVisible) {
      ctx.setStatus('平面検出 OK — GPUオクルージョン ON', 'ready');
    } else {
      ctx.setStatus('平面を探しています…(GPUオクルージョン ON)', '');
    }
  }

  // --- Physics step ---
  if (physicsWorld) {
    physicsWorld.step(1 / 60, dt, 3);
    syncMeshesToPhysics(physicsBodies);
  }

  // --- Hit-Test: 平面検出 & リング表示 ---
  if (state.hitTestSource) {
    const hitResults = frame.getHitTestResults(state.hitTestSource);
    if (hitResults.length > 0) {
      const pose = hitResults[0].getPose(refSpace);
      reticle.visible = true;
      reticle.matrix.fromArray(pose.transform.matrix);
      state.lastReticlePose = pose;
      if (!state.reticleVisible) {
        state.reticleVisible = true;
        const depthLabel = ctx.depthState.enabled ? ' — GPUオクルージョン ON' : '';
        ctx.setStatus(`平面検出 OK — シャッターでスキャン${depthLabel}`, 'ready');
        el.reticleLabel.textContent = 'タップしてその場をスキャン';
        el.shutter.classList.remove('disabled');
      }
    } else {
      reticle.visible = false;
      state.lastReticlePose = null;
      if (state.reticleVisible) {
        state.reticleVisible = false;
        const depthLabel = ctx.depthState.enabled ? '(GPUオクルージョン ON) ' : '';
        ctx.setStatus(`${depthLabel}平面を探しています…`, '');
        el.reticleLabel.textContent = '床や机にカメラを向けてください';
        el.shutter.classList.add('disabled');
      }
    }
  }

  renderer.render(ctx.scene, ctx.camera);
}
