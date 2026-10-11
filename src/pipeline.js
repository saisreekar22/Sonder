// @ts-check
// DetectionPipeline — main-thread capture → worker inference with
// backpressure (Issue 03, PRD §7).
// Frames older than MAX_FRAME_AGE_MS are dropped instead of cueing stale
// positions. While inference is in flight only the latest frame is kept, so
// a slow model degrades to a lower effective FPS instead of a growing queue.
// Seam: runInference + now + onResult are injected; no Worker or timers
// inside, so tests stay at submit()/getStats().

/** Backpressure budget: drop frames older than this (PRD §7). */
export const MAX_FRAME_AGE_MS = 200;

/**
 * @typedef {object} PipelineStats
 * @property {number} framesSubmitted
 * @property {number} framesCompleted
 * @property {number} framesDropped
 * @property {number} fps - completions per second over the recent window
 * @property {number | null} lastLatencyMs - submit → result for the last kept frame
 * @property {number | null} lastInferenceMs
 */

/**
 * @typedef {object} PipelineDeps
 * @property {(frame: any) => Promise<any[]>} runInference - worker call, resolves with Detections
 * @property {() => number} [now]
 * @property {(result: { detections: any[], captureAt: number, latencyMs: number, inferenceMs: number }) => void} [onResult]
 * @property {(info: { captureAt: number, ageMs: number, reason: string }) => void} [onDrop]
 * @property {number} [maxAgeMs]
 */

/**
 * @param {PipelineDeps} deps
 */
export function createDetectionPipeline({
  runInference,
  now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now()),
  onResult = () => {},
  onDrop = () => {},
  maxAgeMs = MAX_FRAME_AGE_MS,
}) {
  let busy = false;
  /** @type {{ frame: any, captureAt: number } | null} */
  let pending = null;
  /** @type {number[]} completion timestamps for the FPS window */
  let completions = [];
  /** @type {PipelineStats} */
  const stats = {
    framesSubmitted: 0,
    framesCompleted: 0,
    framesDropped: 0,
    fps: 0,
    lastLatencyMs: null,
    lastInferenceMs: null,
  };

  /** @param {number} atMs */
  function noteCompletion(atMs) {
    completions.push(atMs);
    const cutoff = atMs - 2000;
    completions = completions.filter((t) => t >= cutoff);
    const spanS = completions.length > 1
      ? (completions[completions.length - 1] - completions[0]) / 1000
      : 0;
    stats.fps = spanS > 0 ? completions.length / spanS : completions.length;
  }

  /**
   * @param {any} frame
   * @param {number} captureAt
   */
  async function runOne(frame, captureAt) {
    const inferStart = now();
    let detections = [];
    try {
      detections = (await runInference(frame)) ?? [];
    } catch {
      detections = [];
    }
    const doneAt = now();
    const ageMs = doneAt - captureAt;
    if (ageMs > maxAgeMs) {
      stats.framesDropped += 1;
      onDrop({ captureAt, ageMs, reason: 'stale-result' });
    } else {
      stats.framesCompleted += 1;
      stats.lastLatencyMs = ageMs;
      stats.lastInferenceMs = doneAt - inferStart;
      noteCompletion(doneAt);
      onResult({ detections, captureAt, latencyMs: ageMs, inferenceMs: doneAt - inferStart });
    }
  }

  async function pump() {
    if (busy) return;
    const next = pending;
    pending = null;
    if (!next) return;
    busy = true;
    try {
      await runOne(next.frame, next.captureAt);
    } finally {
      busy = false;
      if (pending) void pump();
    }
  }

  /**
   * Submit a freshly captured frame. When inference is busy the submission
   * replaces any queued frame (latest wins); the replaced frame counts as
   * coalesced, not stale.
   * @param {any} frame
   */
  function submit(frame) {
    const captureAt = now();
    stats.framesSubmitted += 1;
    if (busy) {
      if (pending) stats.framesDropped += 1;
      pending = { frame, captureAt };
      return;
    }
    pending = { frame, captureAt };
    void pump();
  }

  /** @returns {PipelineStats} */
  function getStats() {
    return { ...stats };
  }

  return { submit, getStats };
}
