/* ============================================================
   depth.js
   WebXR Depth Sensing — GPU 深度テクスチャの取得と反映
   Pixel 7a 等 ARCore 端末向け:
   Three.js 組み込み depth mesh (sampler2DArray) は単眼 AR で効かないことがあるため、
   XRWebGLBinding.getDepthInformation() + カスタムシェーダーで GPU オクルージョンを行う。
   深度 UV は normDepthBufferFromNormView 行列で変換 (W3C WebXR Depth Sensing 準拠)。

   Chrome 150 対応メモ:
   ・renderer.xr.getBinding() は廃止。three.js 側が内部キャッシュした
     XRWebGLBinding を返す実装で、Chrome 150 との組み合わせでは
     生成タイミングや取得結果がずれることがあったため、
     XRWebGLBinding はセッション開始時 (ar.js) で明示的に
     `new XRWebGLBinding(session, gl)` して ctx 経由で受け取る形にした。
   ・THREE.ExternalTexture は廃止。生の WebGLTexture を
     renderer 内部プロパティへ直接差し込み、Three.js のアップロード
     経路を完全にバイパスして毎フレーム再バインドする方式にした。
============================================================ */
import * as THREE from 'three';
import { applyDepthUniformsToPlacedObjects } from './shaders.js';

export function createDepthState() {
  return {
    enabled: false,
    notified: false,
    depthTextureWrapper: null, // 生WebGLTextureを差し込むためのTHREE.Textureラッパー(使い回す)
    uvMatrix: null,
    rawValueToMeters: 0.001,
    isFloatFormat: false,
    // getDepthInformation が例外ではなく "取得失敗を返し続ける" だけの
    // 場合があるため、連続失敗回数で見切りをつける。
    failCount: 0,
  };
}

/* Three.js の自動アップロード経路(texture.version による差分検出)を
   完全にバイパスし、WebGLTexture をそのまま renderer 内部プロパティに
   差し込んで毎フレーム再バインドさせるだけにする。
   THREE.ExternalTexture が内部的にやっていることと等価だが、
   クラス経由ではなく直接操作することで Chrome150 側の描画パスの
   差異による不具合を避ける。 */
function patchRawTextureInto(renderer, wrapperTexture, glTexture) {
  const props = renderer.properties.get(wrapperTexture);
  props.__webglTexture = glTexture;
  props.__webglInit = true;
  wrapperTexture.needsUpdate = false; // three側の再アップロードを常に抑止
}

function ensureWrapperTexture(depthState) {
  if (depthState.depthTextureWrapper) return depthState.depthTextureWrapper;
  const tex = new THREE.Texture();
  tex.magFilter = THREE.LinearFilter;
  tex.minFilter = THREE.LinearFilter;
  tex.wrapS = THREE.ClampToEdgeWrapping;
  tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.generateMipmaps = false;
  tex.flipY = false;
  depthState.depthTextureWrapper = tex;
  return tex;
}

/**
 * @param {XRSession} session
 * @param {THREE.WebGLRenderer} renderer
 * @param {XRWebGLBinding} binding  ar.js でセッション開始時に自前生成したもの
 * @param {XRFrame} frame
 * @param {XRReferenceSpace} refSpace
 * @param {object} depthState  createDepthState() の戻り値
 * @param {THREE.Group[]} placedObjects
 */
export function updateDepthOcclusion(session, renderer, binding, frame, refSpace, depthState, placedObjects) {
  if (!session?.enabledFeatures?.includes('depth-sensing')) return false;
  if (session.depthUsage !== 'gpu-optimized') return false;
  if (!binding?.getDepthInformation) return false;
  if (depthState.failCount > 30) return false; // 継続的に失敗する環境では諦める

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

    const wrapperTex = ensureWrapperTexture(depthState);
    // 毎フレーム直接差し込む(端末によっては同じ参照でも中身が
    // 更新されているケースがあるため、参照比較でスキップしない)。
    patchRawTextureInto(renderer, wrapperTex, depthInfo.texture);

    if (!depthState.uvMatrix) depthState.uvMatrix = new THREE.Matrix4();
    depthState.uvMatrix.fromArray(depthInfo.normDepthBufferFromNormView.matrix);
    depthState.rawValueToMeters = depthInfo.rawValueToMeters || 0.001;

    applyDepthUniformsToPlacedObjects(
      placedObjects,
      wrapperTex,
      depthState.uvMatrix,
      depthState.rawValueToMeters,
      depthState.isFloatFormat
    );
    depthState.failCount = 0;
    return true;
  }
  return false;
}
