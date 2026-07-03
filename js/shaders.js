/* ============================================================
   shaders.js
   GPU DEPTH OCCLUSION — カスタムシェーダー (Pixel 7a / ARCore 向け)
   W3C WebXR Depth Sensing: normDepthBufferFromNormView + luminance-alpha
============================================================ */
import * as THREE from 'three';

const occlusionPatchedMaterials = new WeakSet();

export function patchMaterialForOcclusion(material) {
  if (occlusionPatchedMaterials.has(material)) return;
  occlusionPatchedMaterials.add(material);

  material.onBeforeCompile = (shader) => {
    shader.uniforms.uDepthTexture = { value: null };
    shader.uniforms.uUvTransform = { value: new THREE.Matrix4() };
    shader.uniforms.uRawValueToMeters = { value: 0.001 };
    shader.uniforms.uDepthIsFloat = { value: 0.0 };

    shader.fragmentShader = `
      uniform sampler2D uDepthTexture;
      uniform mat4 uUvTransform;
      uniform float uRawValueToMeters;
      uniform float uDepthIsFloat;
      ${shader.fragmentShader}
    `;

    /* vViewPosition は MeshStandardMaterial 標準 varying — ビュー空間深度比較に使用 */
    shader.fragmentShader = shader.fragmentShader.replace(
      '#include <dithering_fragment>',
      `
      #include <dithering_fragment>
      {
        vec2 normViewXY = vViewPosition.xy / vViewPosition.z;
        vec2 depthUV = (uUvTransform * vec4(normViewXY, 0.0, 1.0)).xy;
        float envDepthM;
        if (uDepthIsFloat > 0.5) {
          envDepthM = texture2D(uDepthTexture, depthUV).r * uRawValueToMeters;
        } else {
          vec2 packed = texture2D(uDepthTexture, depthUV).ra;
          envDepthM = dot(packed, vec2(255.0, 256.0 * 255.0)) * uRawValueToMeters;
        }
        float fragDepthM = -vViewPosition.z;
        if (envDepthM > 0.01 && fragDepthM > envDepthM + 0.015) {
          discard;
        }
      }
      `
    );

    material.userData.shaderRef = shader;
  };
  material.needsUpdate = true;
}

export function patchOcclusionOnGroup(group) {
  group.traverse((node) => {
    if (!node.isMesh || !node.material) return;
    const mats = Array.isArray(node.material) ? node.material : [node.material];
    mats.forEach(patchMaterialForOcclusion);
  });
}

export function applyDepthUniformsToPlacedObjects(placedObjects, depthTexture, uvMatrix, rawValueToMeters, isFloatFormat) {
  placedObjects.forEach((group) => {
    group.traverse((node) => {
      if (!node.isMesh || !node.material) return;
      const mats = Array.isArray(node.material) ? node.material : [node.material];
      mats.forEach((mat) => {
        patchMaterialForOcclusion(mat);
        const shader = mat.userData.shaderRef;
        if (shader) {
          shader.uniforms.uDepthTexture.value = depthTexture;
          shader.uniforms.uUvTransform.value.copy(uvMatrix);
          shader.uniforms.uRawValueToMeters.value = rawValueToMeters;
          shader.uniforms.uDepthIsFloat.value = isFloatFormat ? 1.0 : 0.0;
        }
      });
    });
  });
}
