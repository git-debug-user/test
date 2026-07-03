/* ============================================================
   main.js
   WebAR Scene Generator — Three.js r185 / WebXR Depth API
   ------------------------------------------------------------
   · Hit-Test     : 平面検出 & リング表示 (requiredFeatures)
   · Depth API    : XRWebGLBinding + カスタムシェーダー GPU オクルージョン (Pixel 7a)
   · Physics      : cannon-es 重力・衝突・積み重ね
   · AI           : TensorFlow.js COCO-SSD (端末内推論)
   · Hosting      : GitHub Pages 対応 (モジュール分割構成)

   Pixel 7a + Chrome 150 対応メモ:
   このファイルの末尾で window.onerror / unhandledrejection を捕捉している。
   type="module" のスクリプトは読み込み・実行時にエラーが起きると
   イベントリスナーが一切登録されないまま静かに止まることがあり、
   それが「ARを開始ボタンを押しても完全に無反応」に見える典型的な
   原因のひとつ。捕捉した内容は画面上のエラー表示にも出すため、
   今後同様の問題が起きた場合はブラウザのコンソール以外でも
   気付けるようになっている。
============================================================ */
import * as THREE from 'three';
import { startAR, onShutterPress, onSessionEnd } from './ar.js';
import { createPhysicsWorld } from './physics.js';
import { loadDetectionModel } from './ai.js';

/* ============================================================
   STATE
============================================================ */
const state = {
  session: null,        // XRSession
  hitTestSource: null,
  reticleVisible: false,
  busy: false,
  lastReticlePose: null,
};

const el = {
  startOverlay: document.getElementById('start-overlay'),
  startBtn: document.getElementById('start-btn'),
  notSupported: document.getElementById('not-supported'),
  hud: document.getElementById('hud'),
  statusDot: document.getElementById('status-dot'),
  statusText: document.getElementById('status-text'),
  exitBtn: document.getElementById('exit-btn'),
  shutter: document.getElementById('shutter'),
  reticleLabel: document.getElementById('reticle-label'),
  resultCard: document.getElementById('result-card'),
  resultScene: document.getElementById('result-scene'),
  resultObjType: document.getElementById('result-objtype'),
  resultDesc: document.getElementById('result-desc'),
  resultClose: document.getElementById('result-close'),
  errorToast: document.getElementById('error-toast'),
};

function setStatus(text, mode) {
  el.statusText.textContent = text;
  el.statusDot.className = mode || '';
}

/* permanent=true の場合は自動で消えない致命的エラー表示にする
   (今回の不具合のように「一瞬出て消えるトーストに気付けない」ことを防ぐ) */
function showError(msg, permanent = false) {
  el.errorToast.textContent = msg;
  el.errorToast.classList.add('visible');
  clearTimeout(showError._t);
  if (permanent) {
    el.errorToast.classList.add('permanent');
  } else {
    el.errorToast.classList.remove('permanent');
    showError._t = setTimeout(() => el.errorToast.classList.remove('visible'), 4200);
  }
}

/* ============================================================
   THREE.JS SETUP
============================================================ */
let renderer, scene, camera, reticle;
const placedObjects = [];
const physicsBodies = []; // { body: CANNON.Body, mesh: THREE.Group }
const planeColliders = []; // CANNON.Body for each detected/placed plane (static)
let physicsWorld;

function initThree() {
  scene = new THREE.Scene();
  camera = new THREE.PerspectiveCamera();

  renderer = new THREE.WebGLRenderer({ alpha: true, antialias: true });
  renderer.setPixelRatio(window.devicePixelRatio);
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.xr.enabled = true; // WebXR AR セッションを有効化
  document.getElementById('app').appendChild(renderer.domElement);

  physicsWorld = createPhysicsWorld();

  // Lighting
  const hemi = new THREE.HemisphereLight(0xffffff, 0x444466, 1.1);
  scene.add(hemi);
  const dir = new THREE.DirectionalLight(0xffffff, 1.0);
  dir.position.set(1, 2, 1);
  scene.add(dir);

  // Reticle (placement indicator) — depthTest 無効で常に前面表示
  const ringGeo = new THREE.RingGeometry(0.07, 0.09, 32).rotateX(-Math.PI / 2);
  const ringMat = new THREE.MeshBasicMaterial({
    color: 0x00f0c0, side: THREE.DoubleSide, transparent: true, opacity: 0.9,
    depthTest: false, depthWrite: false,
  });
  reticle = new THREE.Mesh(ringGeo, ringMat);
  reticle.matrixAutoUpdate = false;
  reticle.visible = false;
  reticle.renderOrder = 999; // 深度オクルージョンより手前に描画
  scene.add(reticle);

  // 内側ドット
  const dotGeo = new THREE.CircleGeometry(0.015, 16).rotateX(-Math.PI / 2);
  const dotMat = new THREE.MeshBasicMaterial({ color: 0x00f0c0, depthTest: false, depthWrite: false });
  const dot = new THREE.Mesh(dotGeo, dotMat);
  reticle.add(dot);

  window.addEventListener('resize', () => {
    renderer.setSize(window.innerWidth, window.innerHeight);
  });
}

/* ============================================================
   CONTEXT — 各モジュールへ渡す共有参照の束
============================================================ */
const ctx = {
  state, el, setStatus, showError,
  get renderer() { return renderer; },
  get scene() { return scene; },
  get camera() { return camera; },
  get reticle() { return reticle; },
  get physicsWorld() { return physicsWorld; },
  placedObjects, physicsBodies, planeColliders,
  depthState: null, // startAR() 内で生成
  xrGlBinding: null, // startAR() 内で `new XRWebGLBinding(session, gl)` として自前生成
};

/* ============================================================
   ANIMATION TICK for placed objects (decorative micro-animations)
============================================================ */
function animatePlacedObjects() {
  const t = performance.now() / 1000;
  placedObjects.forEach(group => {
    const mode = group.userData.animMode;
    const target = group.userData.animOffset;
    if (!target || target === group) return;
    switch (mode) {
      case 'idle_bob':
        target.position.y = (target.userData.baseY ?? (target.userData.baseY = target.position.y)) + Math.sin(t * 1.6 + group.id) * 0.04;
        break;
      case 'pulse': {
        const s = 1 + Math.sin(t * 2.4 + group.id) * 0.06;
        target.scale.setScalar(s);
        break;
      }
      case 'spin':
        target.rotation.y = t * 0.8;
        break;
      default:
        if (group.userData.floaty) {
          target.position.y = (target.userData.baseY ?? (target.userData.baseY = target.position.y)) + Math.sin(t * 1.2 + group.id) * 0.03;
          target.rotation.y = t * 0.3;
        }
    }
  });
  requestAnimationFrame(animatePlacedObjects);
}

/* ============================================================
   EVENT WIRING
============================================================ */
el.startBtn.addEventListener('click', () => {
  startAR(ctx);
});
el.shutter.addEventListener('click', () => onShutterPress(ctx));
el.resultClose.addEventListener('click', () => el.resultCard.classList.remove('visible'));
el.exitBtn.addEventListener('click', () => {
  if (state.session) state.session.end();
});

/* ============================================================
   GLOBAL ERROR HANDLERS
   モジュール読み込み失敗・未捕捉の例外を必ず画面に出す。
   (index.html 側の crossorigin="anonymous" と合わせて、CDN起因の
   エラーでもメッセージが "Script error." に潰されないようにしている)
============================================================ */
window.addEventListener('error', (event) => {
  console.error('[Fatal] Uncaught error:', event.error || event.message);
  showError('予期しないエラーが発生しました: ' + (event.message || 'unknown error'), true);
});
window.addEventListener('unhandledrejection', (event) => {
  console.error('[Fatal] Unhandled promise rejection:', event.reason);
  showError('予期しないエラー(Promise)が発生しました: ' + (event.reason?.message || event.reason), true);
});

/* ============================================================
   INIT
============================================================ */
initThree();
animatePlacedObjects();

if (!navigator.xr) {
  console.warn('[AR] navigator.xr is not available on this browser.');
}

/* Pre-load the on-device detection model before allowing AR start.
   No network calls beyond fetching the model weights once (from the
   TF.js CDN) — no API key, no per-frame network traffic. */
(async function bootDetectionModel() {
  try {
    await loadDetectionModel();
    el.startBtn.disabled = false;
    el.startBtn.textContent = 'ARを開始';
  } catch (err) {
    console.error('[AI] model load failed:', err);
    el.startBtn.textContent = 'モデル読み込み失敗(再読み込みしてください)';
    showError(err.message || 'AIモデルの読み込みに失敗しました', true);
  }
})();
