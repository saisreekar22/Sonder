// @ts-check
// MediaPipe Tasks backend — the on-device EfficientDet-Lite0 baseline
// behind the swappable detect(frame) contract (Issue 03).
// The vision bundle + wasm load from a pinned CDN at runtime (canonical
// MediaPipe pattern); the model artifact is self-hosted at
// DEFAULT_MODEL_ASSET_URL so the service worker precaches it for offline
// use (Issue 08). Inference runs inside the detector worker; this module
// holds the pure mapping plus the loader seam so tests stay at
// mapObjectDetectorResult()/loadObjectDetector() with a fake importer.
// Domain terms: Detection (one frame, no identity), mover, static object.

import { SCORE_THRESHOLD, DEFAULT_MODEL_ASSET_URL } from './detector.js';

/** Pinned tasks-vision release; bump in one place (bundle + wasm stay in sync). */
export const TASKS_VISION_VERSION = '1.1.0';

/** Max Detections per frame forwarded to the tracker (it Cues at most 3). */
export const MAX_RESULTS = 10;

/**
 * CDN URLs derived from the pinned version.
 * @returns {{ bundleUrl: string, wasmBaseUrl: string }}
 */
export function tasksVisionUrls() {
  const base = `https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@${TASKS_VISION_VERSION}`;
  return { bundleUrl: `${base}/vision_bundle.mjs`, wasmBaseUrl: `${base}/wasm` };
}

/**
 * @typedef {object} MapOptions
 * @property {number} frameWidth - pixels, for normalizing the box
 * @property {number} frameHeight - pixels, for normalizing the box
 * @property {number} [scoreThreshold]
 */

/**
 * Map one tasks-vision ObjectDetector result to the shared Detection shape
 * (normalized 0–1 boxes). Drops sub-threshold scores and entries with no
 * usable top category or box; passes other classes through untouched.
 * @param {{ detections?: any[] } | null | undefined} result
 * @param {MapOptions} options
 * @returns {import('./detector.js').Detection[]}
 */
export function mapObjectDetectorResult(result, { frameWidth, frameHeight, scoreThreshold = SCORE_THRESHOLD }) {
  const list = result?.detections;
  if (!Array.isArray(list)) return [];
  const W = Number(frameWidth);
  const H = Number(frameHeight);
  if (!Number.isFinite(W) || W <= 0 || !Number.isFinite(H) || H <= 0) return [];
  /** @type {import('./detector.js').Detection[]} */
  const out = [];
  for (const item of list) {
    const top = item?.categories?.[0];
    const score = Number(top?.score);
    const name = top?.categoryName;
    const box = item?.boundingBox;
    if (typeof name !== 'string' || name.length === 0) continue;
    if (!Number.isFinite(score) || score < scoreThreshold) continue;
    if (!box) continue;
    const x = Number(box.originX) / W;
    const y = Number(box.originY) / H;
    const width = Number(box.width) / W;
    const height = Number(box.height) / H;
    if (![x, y, width, height].every((v) => Number.isFinite(v))) continue;
    if (width <= 0 || height <= 0) continue;
    out.push({ x, y, width, height, category: name, score });
  }
  return out;
}

/**
 * @typedef {object} LoadOptions
 * @property {string} [modelAssetPath]
 * @property {string} [wasmBaseUrl]
 * @property {number} [scoreThreshold]
 * @property {number} [maxResults]
 * @property {() => Promise<any>} [importVision] - seam: defaults to a
 *   dynamic import of the pinned CDN bundle (workers accept full URLs)
 */

/**
 * Load the ObjectDetector, trying the GPU delegate first for interactive
 * frame rates and falling back to CPU (some devices lack worker WebGL).
 * Rejects when the bundle cannot be imported (e.g. first visit offline);
 * callers degrade to empty Detections in that case.
 * @param {LoadOptions} [options]
 * @returns {Promise<{ detect: (frame: any) => any, close: () => any }>}
 */
export async function loadObjectDetector({
  modelAssetPath = DEFAULT_MODEL_ASSET_URL,
  wasmBaseUrl = tasksVisionUrls().wasmBaseUrl,
  scoreThreshold = SCORE_THRESHOLD,
  maxResults = MAX_RESULTS,
  importVision = undefined,
} = {}) {
  const { bundleUrl } = tasksVisionUrls();
  const vision = await (importVision
    ? importVision()
    : /** @type {Promise<any>} */ (import(/* @vite-ignore */ bundleUrl)));
  const fileset = await vision.FilesetResolver.forVisionTasks(wasmBaseUrl);
  const baseOptions = { modelAssetPath };
  const makeOptions = (/** @type {string} */ delegate) => ({
    baseOptions: { ...baseOptions, delegate },
    scoreThreshold,
    maxResults,
    runningMode: 'IMAGE',
  });
  try {
    return await vision.ObjectDetector.createFromOptions(fileset, makeOptions('GPU'));
  } catch {
    return await vision.ObjectDetector.createFromOptions(fileset, makeOptions('CPU'));
  }
}
