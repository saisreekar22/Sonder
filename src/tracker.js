// @ts-check
// Tracker — Detections become stable cross-frame Tracks (Issue 04).
// Custom IoU matching plus a constant-velocity motion model assigns a
// stable Track ID across frames. Each Track carries its Zone, distance
// band, and Cue history: a Track Cues on first Zone entry, then only on
// Zone change or box-height growth over 30%. At most MAX_CUE_SOURCES
// Tracks Cue at once (closeness priority via selectCueSources).
// Domain terms: Detection (no identity), Track (identity + Zone + band +
// Cue history), Cue (rate-limited audio event), Corridor (center Zone),
// size gate (sub-gate Detections never seed Tracks).

import {
  zoneForDetection,
  filterBySizeGate,
  ZONES,
  DEFAULT_CORRIDOR_WIDTH,
  DEFAULT_MIN_HEIGHT_FRACTION,
} from './zones.js';
import {
  estimateBandForDetection,
  DISTANCE_BANDS,
} from './distance.js';

/** Minimum IoU (predicted Track vs Detection) for a same-object match. */
export const IOU_THRESHOLD = 0.3;

/** Blank frames a Track coasts on velocity before it is dropped. */
export const MAX_MISSED_FRAMES = 5;

/** Maximum simultaneous Cue sources. */
export const MAX_CUE_SOURCES = 3;

/** Box-height growth ratio over the last cued height that re-fires a Cue. */
export const HEIGHT_GROWTH_CUE_RATIO = 1.3;

/** Band weight for Cue-source priority (very near = 3, near = 2, far = 1). */
const BAND_WEIGHT = {
  [DISTANCE_BANDS.VERY_NEAR]: 3,
  [DISTANCE_BANDS.NEAR]: 2,
  [DISTANCE_BANDS.FAR]: 1,
};

/**
 * @typedef {object} TrackerOptions
 * @property {number} [iouThreshold]
 * @property {number} [maxMissedFrames]
 * @property {number} [maxCueSources]
 * @property {number} [frameHeightPx] - needed for the distance-band estimate
 * @property {number} [focalLengthPx] - device focal-length lookup override
 * @property {number} [corridorWidth] - live Corridor slider value
 * @property {number} [minHeightFraction] - live min-size slider value
 */

/**
 * Intersection-over-union for normalized { x, y, width, height } boxes.
 * @param {{ x: number, y: number, width: number, height: number }} a
 * @param {{ x: number, y: number, width: number, height: number }} b
 * @returns {number}
 */
export function computeIoU(a, b) {
  const ax2 = Number(a.x) + Number(a.width);
  const ay2 = Number(a.y) + Number(a.height);
  const bx2 = Number(b.x) + Number(b.width);
  const by2 = Number(b.y) + Number(b.height);
  const ix0 = Math.max(Number(a.x), Number(b.x));
  const iy0 = Math.max(Number(a.y), Number(b.y));
  const ix1 = Math.min(ax2, bx2);
  const iy1 = Math.min(ay2, by2);
  const iw = Math.max(0, ix1 - ix0);
  const ih = Math.max(0, iy1 - iy0);
  const inter = iw * ih;
  if (inter <= 0) return 0;
  const areaA = Math.max(0, Number(a.width)) * Math.max(0, Number(a.height));
  const areaB = Math.max(0, Number(b.width)) * Math.max(0, Number(b.height));
  const union = areaA + areaB - inter;
  if (!Number.isFinite(union) || union <= 0) return 0;
  return inter / union;
}

/** @param {{ x: number, width: number }} box */
function centerXOf(box) {
  return Number(box.x) + Number(box.width) / 2;
}

/** @param {{ y: number, height: number }} box */
function centerYOf(box) {
  return Number(box.y) + Number(box.height) / 2;
}

/**
 * Rank Cue candidates: closer bands first, Corridor ties broken toward
 * center, then higher score, then larger apparent height.
 * @param {any[]} tracks
 * @param {number} [max]
 * @returns {any[]}
 */
export function selectCueSources(tracks, max = MAX_CUE_SOURCES) {
  if (!Array.isArray(tracks)) return [];
  return tracks
    .filter((t) => t && t.shouldCue)
    .sort((a, b) => {
      const wb = (BAND_WEIGHT[b.band] ?? 0) - (BAND_WEIGHT[a.band] ?? 0);
      if (wb !== 0) return wb;
      const center = (/** @type {string} */ zone) => (zone === ZONES.CENTER ? 1 : 0);
      const cb = center(b.zone) - center(a.zone);
      if (cb !== 0) return cb;
      const sb = Number(b.score ?? 0) - Number(a.score ?? 0);
      if (sb !== 0) return sb;
      return Number(b.height ?? 0) - Number(a.height ?? 0);
    })
    .slice(0, max);
}

/**
 * Create an IoU + constant-velocity tracker.
 * Seam: zone/distance options are injected per update() call so the live
 * on-screen sliders flow through without globals; tests stay at update().
 * @param {TrackerOptions} [options]
 */
export function createTracker(options = {}) {
  const defaults = {
    iouThreshold: options.iouThreshold ?? IOU_THRESHOLD,
    maxMissedFrames: options.maxMissedFrames ?? MAX_MISSED_FRAMES,
    maxCueSources: options.maxCueSources ?? MAX_CUE_SOURCES,
    frameHeightPx: options.frameHeightPx ?? 480,
    focalLengthPx: options.focalLengthPx,
    corridorWidth: options.corridorWidth ?? DEFAULT_CORRIDOR_WIDTH,
    minHeightFraction: options.minHeightFraction ?? DEFAULT_MIN_HEIGHT_FRACTION,
  };
  let nextId = 1;
  /** @type {any[]} */
  let tracks = [];

  function getTracks() {
    return tracks.map((t) => ({ ...t }));
  }

  function reset() {
    tracks = [];
    nextId = 1;
  }

  /**
   * Match one frame of Detections to live Tracks.
   * @param {any[]} detections - raw per-frame Detections (no identity)
   * @param {Partial<TrackerOptions>} [override]
   * @returns {any[]} live Tracks after this frame
   */
  function update(detections, override = {}) {
    const cfg = { ...defaults, ...override };
    const zoneOpts = { corridorWidth: cfg.corridorWidth };
    const gateOpts = { minHeightFraction: cfg.minHeightFraction };
    const distOpts = { frameHeightPx: cfg.frameHeightPx, focalLengthPx: cfg.focalLengthPx };

    const gated = filterBySizeGate(Array.isArray(detections) ? detections : [], gateOpts);
    /** @type {any[]} annotated Detections with Zone + band (band only, never meters) */
    const annotated = gated.map((d) => ({
      ...d,
      zone: zoneForDetection(d, zoneOpts),
      band: estimateBandForDetection(d, distOpts).band,
    }));

    // Predict current positions with the constant-velocity model.
    const predicted = tracks.map((t) => ({
      track: t,
      box: {
        x: Number(t.x) + Number(t.vx ?? 0),
        y: Number(t.y) + Number(t.vy ?? 0),
        width: Number(t.width),
        height: Number(t.height),
      },
    }));

    // Greedy IoU assignment, best pair first.
    /** @type {{ ti: number, di: number, iou: number }[]} */
    const pairs = [];
    for (let ti = 0; ti < predicted.length; ti++) {
      for (let di = 0; di < annotated.length; di++) {
        pairs.push({ ti, di, iou: computeIoU(predicted[ti].box, annotated[di]) });
      }
    }
    pairs.sort((a, b) => b.iou - a.iou);
    const trackTaken = new Array(tracks.length).fill(false);
    const detTaken = new Array(annotated.length).fill(false);
    /** @type {Map<number, number>} trackIndex -> detectionIndex */
    const match = new Map();
    for (const { ti, di, iou } of pairs) {
      if (iou < cfg.iouThreshold) continue;
      if (trackTaken[ti] || detTaken[di]) continue;
      trackTaken[ti] = true;
      detTaken[di] = true;
      match.set(ti, di);
    }

    /** @type {any[]} */
    const next = [];

    // Matched Tracks: refresh box, velocity, Zone/band, and Cue gating.
    for (let ti = 0; ti < tracks.length; ti++) {
      const t = tracks[ti];
      if (!match.has(ti)) continue;
      const d = annotated[/** @type {number} */ (match.get(ti))];
      const prevCx = centerXOf(t);
      const prevCy = centerYOf(t);
      const newCx = centerXOf(d);
      const newCy = centerYOf(d);
      const zone = d.zone;
      const band = d.band;
      const height = Number(d.height);
      const zoneChanged = zone !== t.lastCuedZone;
      const grown = height >= Number(t.lastCuedHeight) * HEIGHT_GROWTH_CUE_RATIO;
      const shouldCue = zoneChanged || grown;
      next.push({
        ...t,
        category: d.category ?? t.category,
        score: d.score ?? t.score,
        x: Number(d.x),
        y: Number(d.y),
        width: Number(d.width),
        height,
        vx: newCx - prevCx,
        vy: newCy - prevCy,
        zone,
        band,
        missedFrames: 0,
        ageFrames: (t.ageFrames ?? 1) + 1,
        lastCuedZone: shouldCue ? zone : t.lastCuedZone,
        lastCuedHeight: shouldCue ? height : t.lastCuedHeight,
        shouldCue,
      });
    }

    // New Tracks cue on first Zone entry.
    for (let di = 0; di < annotated.length; di++) {
      if (detTaken[di]) continue;
      const d = annotated[di];
      next.push({
        id: nextId++,
        category: d.category,
        score: d.score,
        x: Number(d.x),
        y: Number(d.y),
        width: Number(d.width),
        height: Number(d.height),
        vx: 0,
        vy: 0,
        zone: d.zone,
        band: d.band,
        missedFrames: 0,
        ageFrames: 1,
        lastCuedZone: d.zone,
        lastCuedHeight: Number(d.height),
        shouldCue: true,
      });
    }

    // Unmatched Tracks coast on velocity and go quiet until re-matched.
    for (let ti = 0; ti < tracks.length; ti++) {
      if (match.has(ti)) continue;
      const t = tracks[ti];
      const missedFrames = (t.missedFrames ?? 0) + 1;
      if (missedFrames > cfg.maxMissedFrames) continue;
      next.push({
        ...t,
        x: Number(t.x) + Number(t.vx ?? 0),
        y: Number(t.y) + Number(t.vy ?? 0),
        missedFrames,
        shouldCue: false,
      });
    }

    // Deterministic order: lowest Track ID first.
    next.sort((a, b) => a.id - b.id);
    tracks = next;
    return getTracks();
  }

  return { update, getTracks, reset };
}
