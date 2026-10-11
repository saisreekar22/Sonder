// @ts-check
// DetectorWorker — on-device inference off the main thread (Issue 03, PRD §7).
// Main thread captures and transfers a bitmap; this module runs MediaPipe
// detection in the worker and posts boxes back. Two testable seams:
//   - createDetectorWorkerHandler: pure message handler (no `self` inside)
//   - createWorkerInference: main-thread client adapting a Worker to the
//     pipeline's runInference(frame) => Promise<Detection[]> contract.
// The worker bootstrap below binds the real EfficientDet-Lite0 baseline
// (via ./mediapipe-tasks.js) lazily on first frame; until the model is
// ready frames resolve to [] so the app runs degraded, never stalled.

import { loadObjectDetector, mapObjectDetectorResult } from './mediapipe-tasks.js';

/**
 * @typedef {object} WorkerHandlerDeps
 * @property {(frame: any) => Promise<any[]>} detect
 * @property {(message: any, transfer?: any[]) => void} postMessage
 * @property {() => number} [now]
 */

/**
 * Pure worker-side handler; the real worker file wires `self` to it.
 * @param {WorkerHandlerDeps} deps
 */
export function createDetectorWorkerHandler({
  detect,
  postMessage,
  now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now()),
}) {
  /**
   * @param {{ id: number, captureAt: number, frame: any }} msg
   */
  async function onMessage(msg) {
    const start = now();
    try {
      const detections = (await detect(msg.frame)) ?? [];
      postMessage({
        id: msg.id,
        captureAt: msg.captureAt,
        detections,
        inferenceMs: now() - start,
      });
    } catch (err) {
      postMessage({
        id: msg.id,
        captureAt: msg.captureAt,
        detections: [],
        inferenceMs: now() - start,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return { onMessage };
}

/**
 * @typedef {object} WorkerClientDeps
 * @property {() => { postMessage: (msg: any, transfer?: any[]) => void, terminate?: () => void }} [createWorker]
 * @property {string} [workerUrl]
 * @property {() => number} [now]
 * @property {(frame: any) => any} [transfer]
 */

/**
 * Main-thread adapter: runInference over a real Worker, matched by id.
 * Falls back to a direct-call path when Worker construction fails so the
 * app still runs (single-threaded) on browsers without worker support.
 * @param {WorkerClientDeps & { fallbackDetect?: ((frame: any) => Promise<any[]>) | null }} deps
 */
export function createWorkerInference({
  createWorker,
  workerUrl = './src/detector-worker.js',
  now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now()),
  transfer = (frame) => frame,
  fallbackDetect = null,
} = {}) {
  /** @type {Map<number, { resolve: (v: any) => void, reject: (e: any) => void }>} */
  const pending = new Map();
  let nextId = 1;
  /** @type {any} */
  let worker = null;
  /** Meta of the last worker reply (model readiness / error), kept beside
   * the Detection array so the pipeline's runInference contract stays pure. */
  let lastMeta = { modelReady: false, error: null };

  if (typeof createWorker === 'function') {
    worker = createWorker();
  } else if (typeof Worker !== 'undefined') {
    try {
      worker = new Worker(workerUrl, { type: 'module' });
    } catch {
      worker = null;
    }
  }
  if (worker) {
    worker._onmessage = (/** @type {any} */ e) => handleMessage(e && e.data ? e.data : e);
    if (typeof worker.addEventListener === 'function') {
      worker.addEventListener('message', (/** @type {any} */ e) => handleMessage(e && e.data ? e.data : e));
    } else {
      worker.onmessage = (/** @type {any} */ e) => handleMessage(e && e.data ? e.data : e);
    }
  }

  /** @param {any} msg */
  function handleMessage(msg) {
    if (!msg || typeof msg.id !== 'number' || !pending.has(msg.id)) return;
    const { resolve } = /** @type {any} */ (pending.get(msg.id));
    pending.delete(msg.id);
    lastMeta = {
      modelReady: msg.modelReady === true,
      error: typeof msg.error === 'string' ? msg.error : null,
    };
    resolve(msg.detections ?? []);
  }

  /**
   * @param {any} frame
   * @returns {Promise<any[]>}
   */
  async function runInference(frame) {
    void now;
    if (!worker) {
      if (fallbackDetect) return fallbackDetect(frame);
      return [];
    }
    const id = nextId++;
    const payload = transfer(frame);
    const done = new Promise((resolve, reject) => {
      pending.set(id, { resolve: /** @type {any} */ (resolve), reject });
    });
    try {
      worker.postMessage({ id, captureAt: Date.now(), frame: payload });
    } catch (err) {
      pending.delete(id);
      if (fallbackDetect) return fallbackDetect(frame);
      throw err;
    }
    return /** @type {Promise<any[]>} */ (done);
  }

  function terminate() {
    pending.clear();
    if (worker && typeof worker.terminate === 'function') worker.terminate();
    worker = null;
  }

  /** Meta of the latest worker reply for status display (never Cues). */
  function getLastMeta() {
    return { ...lastMeta };
  }

  return { runInference, terminate, getLastMeta };
}

// Real worker bootstrap: only runs inside a worker scope. The model load
// (vision bundle + artifact) stays off the critical path until the first
// frame arrives; a rejected load (e.g. first visit offline) resolves every
// frame to [] with the error attached and retries on the next frame.
if (typeof self !== 'undefined' && typeof (/** @type {any} */ (self).postMessage) === 'function') {
  const scope = /** @type {any} */ (self);
  const WorkerScope = /** @type {any} */ (globalThis).WorkerGlobalScope;
  const isWorkerScope = typeof scope.importScripts === 'function' || typeof WorkerScope !== 'undefined';
  if (isWorkerScope && !scope.__echopathDetectorBound) {
    scope.__echopathDetectorBound = true;
    /** @type {Promise<any> | null} */
    let detectorPromise = null;
    /** True once the model has answered at least one frame. Sent with
     * every reply so the main thread can show "loading model…" vs live. */
    let modelReady = false;
    const clock = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());

    function getDetector() {
      if (!detectorPromise) {
        detectorPromise = loadObjectDetector().catch((err) => {
          detectorPromise = null; // retry on the next frame
          throw err;
        });
      }
      return detectorPromise;
    }

    scope.onmessage = (/** @type {any} */ event) => {
      const msg = event && event.data ? event.data : event;
      if (!msg || typeof msg.id !== 'number') return;
      const startedAt = clock();
      const reply = (/** @type {any} */ extra) => scope.postMessage({
        id: msg.id,
        captureAt: msg.captureAt,
        detections: [],
        inferenceMs: clock() - startedAt,
        modelReady,
        ...extra,
      });
      getDetector().then(
        (detector) => {
          modelReady = true;
          let raw;
          try {
            raw = detector.detect(msg.frame);
          } catch (err) {
            reply({ error: err instanceof Error ? err.message : String(err) });
            return;
          }
          const frame = msg.frame;
          const frameWidth = Number(frame?.width ?? frame?.videoWidth ?? 0);
          const frameHeight = Number(frame?.height ?? frame?.videoHeight ?? 0);
          try {
            const detections = mapObjectDetectorResult(raw, { frameWidth, frameHeight });
            reply({ detections });
          } catch (err) {
            reply({ error: err instanceof Error ? err.message : String(err) });
          } finally {
            try {
              if (frame && typeof frame.close === 'function') frame.close();
            } catch {
              // Bitmap release is best-effort.
            }
          }
        },
        (err) => {
          reply({ error: err instanceof Error ? err.message : String(err) });
        },
      );
    };
  }
}
