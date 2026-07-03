/* ============================================================
   ai.js
   SCENE ANALYSIS — 100% on-device, no API key, no network call
   TensorFlow.js (COCO-SSD) runs object detection locally in the
   browser. Detected object classes are mapped to AR object specs via
   a deterministic rule table (no cloud LLM involved).
============================================================ */

function clamp(v, min, max) { return Math.max(min, Math.min(max, v)); }

let cocoModel = null;

export function isModelLoaded() {
  return !!cocoModel;
}

export async function loadDetectionModel() {
  if (!window.tf || !window.cocoSsd) {
    throw new Error('TensorFlow.js / coco-ssd の読み込みに失敗しました(CDN到達不可、または広告ブロッカー等による遮断の可能性があります)');
  }
  // Prefer WebGL backend for speed; falls back automatically if unavailable.
  try {
    await tf.setBackend('webgl');
  } catch (e) {
    console.warn('[AI] WebGL backend unavailable, using default backend.', e);
  }
  await tf.ready();
  cocoModel = await cocoSsd.load({ base: 'lite_mobilenet_v2' });
  return cocoModel;
}

/* COCO-SSD's 80 class labels mapped to our AR object vocabulary.
   Each entry defines what kind of object to spawn, a color pair, a
   relative scale, and an idle animation — fully deterministic, no LLM. */
export const CLASS_TO_SPEC = {
  // 人・生物系 → creature
  person:        { object_type: 'creature',     primary: '#ff8a3d', secondary: '#3a1d0a', scale: 0.7, animation: 'idle_bob', label: '人' },
  cat:           { object_type: 'creature',     primary: '#ffd166', secondary: '#3a2d0a', scale: 0.45, animation: 'idle_bob', label: '猫' },
  dog:           { object_type: 'creature',     primary: '#e07a5f', secondary: '#3a1d0a', scale: 0.5, animation: 'idle_bob', label: '犬' },
  bird:          { object_type: 'creature',     primary: '#5fb3e0', secondary: '#0a2a3a', scale: 0.3, animation: 'idle_bob', label: '鳥' },

  // 家具系 → furniture
  chair:         { object_type: 'furniture',    primary: '#8d6e63', secondary: '#3e2723', scale: 0.6, animation: 'none', label: '椅子' },
  couch:         { object_type: 'furniture',    primary: '#7986cb', secondary: '#1a237e', scale: 0.9, animation: 'none', label: 'ソファ' },
  bed:           { object_type: 'furniture',    primary: '#9575cd', secondary: '#311b92', scale: 1.0, animation: 'none', label: 'ベッド' },
  'dining table':{ object_type: 'furniture',    primary: '#a1887f', secondary: '#3e2723', scale: 0.9, animation: 'none', label: 'テーブル' },

  // 植物
  'potted plant':{ object_type: 'plant',        primary: '#66bb6a', secondary: '#2e7d32', scale: 0.5, animation: 'idle_bob', label: '植物' },

  // light / lamp
  tv:            { object_type: 'lamp',         primary: '#4dd0e1', secondary: '#006064', scale: 0.7, animation: 'pulse', label: 'TV' },

  // 装飾・小物 → crystal / orb 系(本・カップ・花瓶など曖昧な小物の受け皿)
  book:          { object_type: 'crystal',      primary: '#ba68c8', secondary: '#4a148c', scale: 0.35, animation: 'none', label: '本' },
  vase:          { object_type: 'crystal',      primary: '#f06292', secondary: '#880e4f', scale: 0.4, animation: 'none', label: '花瓶' },
  cup:           { object_type: 'floating_orb', primary: '#fff176', secondary: '#f57f17', scale: 0.3, animation: 'idle_bob', label: 'カップ' },
  bottle:        { object_type: 'floating_orb', primary: '#4fc3f7', secondary: '#01579b', scale: 0.3, animation: 'idle_bob', label: 'ボトル' },
  laptop:        { object_type: 'abstract_shape', primary: '#80deea', secondary: '#006064', scale: 0.5, animation: 'spin', label: 'PC' },
  'cell phone':  { object_type: 'abstract_shape', primary: '#ffab91', secondary: '#bf360c', scale: 0.25, animation: 'spin', label: '携帯' },
};

/* Fallback for any detected class not covered above, or when nothing
   is detected at all in the frame. */
const DEFAULT_SPEC_POOL = [
  { object_type: 'floating_orb',   primary: '#00f0c0', secondary: '#0a2a26', scale: 0.45, animation: 'idle_bob', label: '謎の物体' },
  { object_type: 'abstract_shape', primary: '#7c4dff', secondary: '#1a0050', scale: 0.4,  animation: 'spin',     label: '未知の形状' },
  { object_type: 'crystal',        primary: '#ff4081', secondary: '#560027', scale: 0.4,  animation: 'none',    label: '結晶' },
];

function pickFallbackSpec() {
  return DEFAULT_SPEC_POOL[Math.floor(Math.random() * DEFAULT_SPEC_POOL.length)];
}

export function labelForType(t) {
  const map = {
    creature: '🐾 クリーチャー',
    plant: '🌿 植物',
    furniture: '🪑 家具',
    floating_orb: '🔮 浮遊オーブ',
    crystal: '💎 クリスタル',
    lamp: '💡 ランプ',
    abstract_shape: '✨ アブストラクト',
  };
  return map[t] || '🎨 オブジェクト';
}

export async function analyzeScene(canvasEl) {
  if (!cocoModel) {
    throw new Error('AIモデルがまだ読み込まれていません');
  }

  const predictions = await cocoModel.detect(canvasEl, 5, 0.45);

  let chosen = null;
  let detectedLabel = null;

  if (predictions && predictions.length > 0) {
    // Pick the highest-confidence detection that we have a mapping for;
    // otherwise just take the highest-confidence one overall.
    predictions.sort((a, b) => b.score - a.score);
    const withMapping = predictions.find(p => CLASS_TO_SPEC[p.class]);
    const top = withMapping || predictions[0];
    detectedLabel = top.class;
    chosen = CLASS_TO_SPEC[top.class] || null;
  }

  const base = chosen || pickFallbackSpec();
  const sceneLabel = chosen
    ? base.label
    : (detectedLabel ? `${detectedLabel}(未対応)` : '不明なシーン');

  // Light deterministic jitter so repeated scans of the same object don't
  // always produce byte-identical specs (kept subtle, not randomised LLM-style).
  const jitteredScale = clamp(base.scale * (0.9 + Math.random() * 0.2), 0.22, 1.6);

  const spec = {
    scene_label: sceneLabel,
    object_type: base.object_type,
    primary_color: base.primary,
    secondary_color: base.secondary,
    scale: jitteredScale,
    animation: base.animation,
    description: chosen
      ? `「${detectedLabel}」を検出 → ${labelForType(base.object_type)} を生成しました`
      : `未知の物体のため、ランダムな装飾オブジェクトを生成しました`,
  };

  return spec;
}
