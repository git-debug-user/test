/* ============================================================
   ar.js
   WebAR セッション管理 / Hit-Test / フレームループ
   ------------------------------------------------------------
   Pixel 7a + Chrome 150 向け修正点:
   ・requestSession() にタイムアウトを設けた
     (許可プロンプトが出ないまま Promise が無期限 pending になる
      既知の挙動があり、それが「ボタンを押しても完全に無反応」に
      見える最大の原因だったため)
   ・クリック直後に即座にボタンの見た目を変える
     (体感的な "無反応" をなくす)
   ・depth-sensing を全く要求しない設定も含めた3段階フォールバック
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

/* depth-sensing を required で試行 → optional → 完全に要求しない、の3段階
   でフォールバックする。Chrome 150 では 'luminance-alpha' の
   dataFormatPreference が特定端末で requestSession 自体を拒否させる
   ケースが報告されているため、depth を一切求めない構成も用意する。 */
function buildSessionConfigs() {
  return [
    {
      label: 'hit-test + depth-sensing(必須)',
      config: {
        requiredFeatures: ['hit-test', 'depth-sensing'],
        optionalFeatures: ['dom-overlay'],
        depthSensing: {
          usagePreference: ['gpu-optimized'],
          dataFormatPreference: ['luminance-alpha'],
        },
        domOverlay: { root: document.body },
      },
    },
    {
      label: 'hit-test(必須) + depth-sensing(任意)',
      config: {
        requiredFeatures: ['hit-test'],
        optionalFeatures: ['dom-overlay', 'depth-sensing'],
        depthSensing: {
          usagePreference: ['gpu-optimized'],
          dataFormatPreference: ['luminance-alpha', 'float32'],
        },
        domOverlay: { root: document.body },
      },
    },
    {
      label: 'hit-testのみ(depth-sensingなし)',
      config: {
        requiredFeatures: ['hit-test'],
        optionalFeatures: ['dom-overlay'],
        domOverlay: { root: document.body },
      },
    },
  ];
}

export async function requestARSession(navigatorXr) {
  const attempts = buildSessionConfigs();
  let lastErr;
  for (const { label, config } of attempts) {
    try {
      console.info('[AR] requestSession attempt:', label);
      const session = await withTimeout(
        navigatorXr.requestSession('immersive-ar', config),
        SESSION_REQUEST_TIMEOUT_MS,
        `ARセッションの許可プロンプトがタイムアウトしました(${label})。Chromeのカメラ/AR権限設定をご確認ください。`
      );
      console.info('[AR] session started with config:', label);
      return session;
    } catch (e) {
      lastErr = e;
      console.warn('[AR] config failed:', label, '-', e.message);
    }
  }
  throw lastErr || new Error('ARセッションを開始できませんでした');
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

    el.startOverlay.style.display = 'none';
    el.hud.style.display = 'block';

    ctx.renderer.xr.setReferenceSpaceType('local');
    await ctx.renderer.xr.setSession(session);

    ctx.xrRefSpace = ctx.renderer.xr.getReferenceSpace();
    const viewerSpace = await session.requestReferenceSpace('viewer');
    state.hitTestSource = await session.requestHitTestSource({ space: viewerSpace });

    ctx.depthState.isFloatFormat = session.preferredDepthFormat === 'float32';

    if (session.enabledFeatures?.includes('depth-sensing')) {
      console.info('[Depth] feature enabled, usage:', session.depthUsage, 'format:', session.preferredDepthFormat);
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
    ctx.depthState.lastGlTex = null;
    ctx.depthState.threeDepthTexture = null;
  }
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
  const depthOk = updateDepthOcclusion(state.session, renderer, frame, refSpace, ctx.depthState, ctx.placedObjects);
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
