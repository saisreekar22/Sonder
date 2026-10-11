// @ts-check
// Detector — single swappable detect(frame) contract (Issue 03).
// Day-one baseline is on-device EfficientDet-Lite0; a future model swap
// (e.g. RTMDet-tiny) reuses the same flag and the same Detection shape.
// Seam: the inference backend is injected ({ load, detect, close }) so tests
// stay at the public detect()/close() interface without loading MediaPipe.
// Domain terms: Detection (one frame, no identity), mover, static object.

/** Swappable model flag: every model ships behind one of these ids. */
export const DETECTOR_MODELS = {
  EFFICIENTDET_LITE0: 'efficientdet-lite0',
  RTMDET_TINY: 'rtmdet-tiny',
};

/** Day-one baseline model. */
export const DEFAULT_MODEL_ID = DETECTOR_MODELS.EFFICIENTDET_LITE0;

/** Minimum score below which Detections are dropped. */
export const SCORE_THRESHOLD = 0.3;

/** Default artifact URL precached by the service worker (Issue 08 owns hosting). */
export const DEFAULT_MODEL_ASSET_URL = './models/efficientdet-lite0.tflite';

/** Mover classes: Tracks capable of self-locomotion (PRD §6). */
export const MOVER_CLASSES = ['person', 'bicycle', 'car', 'motorcycle', 'bus', 'truck'];

/** Static-object classes: fixed Tracks that Cue when near (PRD §6). */
export const STATIC_OBJECT_CLASSES = ['chair', 'bench', 'potted plant', 'stop sign'];

/**
 * @typedef {object} Detection
 * @property {number} x - left edge, normalized 0–1
 * @property {number} y - top edge, normalized 0–1
 * @property {number} width - normalized 0–1
 * @property {number} height - normalized 0–1
 * @property {string} category - class label (e.g. 'person')
 * @property {number} score - confidence 0–1
 * @property {string} [zone] - frame third, annotated downstream (Issue 04)
 * @property {string} [band] - distance band, annotated downstream (Issue 04)
 */

/**
 * @typedef {object} DetectorBackend
 * @property {() => Promise<void>} load
 * @property {(frame: any) => Promise<Detection[]>} detect
 * @property {() => Promise<void>} [close]
 */

/**
 * @typedef {object} DetectorOptions
 * @property {string} [modelId]
 * @property {DetectorBackend} backend
 * @property {number} [scoreThreshold]
 */

/**
 * Create a detector behind the swappable model flag.
 * @param {DetectorOptions} options
 */
export function createDetector({ modelId = DEFAULT_MODEL_ID, backend, scoreThreshold = SCORE_THRESHOLD }) {
  if (!backend || typeof backend.detect !== 'function') {
    throw new TypeError('createDetector requires a backend with detect(frame).');
  }
  let loaded = false;

  async function ensureLoaded() {
    if (loaded) return;
    if (typeof backend.load === 'function') await backend.load();
    loaded = true;
  }

  /**
   * Run one frame through the on-device model.
   * @param {any} frame - bitmap / canvas / video frame source
   * @returns {Promise<Detection[]>}
   */
  async function detect(frame) {
    if (!frame) throw new TypeError('detect(frame) requires a frame.');
    await ensureLoaded();
    const raw = await backend.detect(frame);
    if (!Array.isArray(raw)) return [];
    /** @type {Detection[]} */
    const out = [];
    for (const d of raw) {
      if (!d || typeof d !== 'object') continue;
      const score = Number(/** @type {any} */ (d).score);
      if (!Number.isFinite(score) || score < scoreThreshold) continue;
      out.push({
        x: Number(/** @type {any} */ (d).x),
        y: Number(/** @type {any} */ (d).y),
        width: Number(/** @type {any} */ (d).width),
        height: Number(/** @type {any} */ (d).height),
        category: String(/** @type {any} */ (d).category ?? /** @type {any} */ (d).class ?? 'unknown'),
        score,
      });
    }
    return out;
  }

  async function close() {
    if (typeof backend.close === 'function') await backend.close();
    loaded = false;
  }

  return { modelId, detect, close };
}

/**
 * Day-one baseline: on-device EfficientDet-Lite0 behind the shared flag.
 * The MediaPipe loader is injected so the module never imports it directly;
 * pass the real loader in production, a fake in tests.
 * @param {{ backend: DetectorBackend, modelAssetUrl?: string }} options
 */
export function createEfficientDetLite0Detector({ backend, modelAssetUrl = DEFAULT_MODEL_ASSET_URL }) {
  void modelAssetUrl;
  return createDetector({ modelId: DETECTOR_MODELS.EFFICIENTDET_LITE0, backend });
}
