/* ============================================================
   depth.js
   WebXR Depth Sensing — GPU 深度テクスチャの取得と反映
   Pixel 7a 等 ARCore 端末向け:
   Three.js 組み込み depth mesh (sampler2DArray) は単眼 AR で効かないことがあるため、
   XRWebGLBinding.getDepthInformation() + カスタムシェーダーで GPU オクルージョンを行う。
   深度 UV は normDepthBufferFromNormView 行列で変換 (W3C WebXR Depth Sensing 準拠)。
============================================================ */
import * as THREE from 'three';
import { applyDepthUniformsToPlacedObjects } from './shaders.js';

export function createDepthState() {
  return {
    enabled: false,
    notified: false,
    lastGlTex: null,
    threeDepthTexture: null,
    uvMatrix: null,
    rawValueToMeters: 0.001,
    isFloatFormat: false,
    // Chrome 150 のバージョンによっては binding.getDepthInformation が
    // 例外を投げるのではなく "undefined を返し続ける" ケースがあるため、
    // 一定回数連続で取得失敗したら諦めるようにする(無限に処理コストを払わない)。
    failCount: 0,
  };
}

/** 毎フレーム GPU 深度テクスチャを取得し配置オブジェクトへ適用 */
export function updateDepthOcclusion(session, renderer, frame, refSpace, depthState, placedObjects) {
  if (!session?.enabledFeatures?.includes('depth-sensing')) return false;
  if (session.depthUsage !== 'gpu-optimized') return false;
  if (depthState.failCount > 30) return false; // 継続的に失敗する環境では諦める

  const binding = renderer.xr.getBinding();
  if (!binding?.getDepthInformation) return false;

  const pose = frame.getViewerPose(refSpace);
  if (!pose) return false;

  for (const view of pose.views) {
    let depthInfo;
    try {
      depthInfo = binding.getDepthInformation(view);
    } catch (e) {
      depthState.failCount++;
      console.warn('[Depth] getDepthInformation failed:', e.message);
      return false;
    }
    if (!depthInfo || !depthInfo.isValid || !depthInfo.texture) continue;

    if (depthState.lastGlTex !== depthInfo.texture) {
      depthState.threeDepthTexture = new THREE.ExternalTexture(depthInfo.texture);
      depthState.lastGlTex = depthInfo.texture;
    }
    if (!depthState.uvMatrix) depthState.uvMatrix = new THREE.Matrix4();
    depthState.uvMatrix.fromArray(depthInfo.normDepthBufferFromNormView.matrix);
    depthState.rawValueToMeters = depthInfo.rawValueToMeters || 0.001;

    applyDepthUniformsToPlacedObjects(
      placedObjects,
      depthState.threeDepthTexture,
      depthState.uvMatrix,
      depthState.rawValueToMeters,
      depthState.isFloatFormat
    );
    depthState.failCount = 0;
    return true;
  }
  return false;
}
