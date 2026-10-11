// @ts-check
// Distance bands — coarse range labels only (Issue 04, CONTEXT.md).
// Bands (very near < 2 m, near 2–6 m, far > 6 m) are estimated from
// apparent height via d ≈ f·H/h with a per-class real-height table and a
// device focal-length lookup seam. Meters are an internal estimate only:
// Detections/Tracks carry the band label, never a meter value for the user.

/** Coarse distance-band vocabulary. Bands are never reported as meters. */
export const DISTANCE_BANDS = {
  VERY_NEAR: 'very near',
  NEAR: 'near',
  FAR: 'far',
};

/** Upper bound of the very-near band in meters. */
export const VERY_NEAR_MAX_M = 2;

/** Upper bound of the near band in meters. */
export const NEAR_MAX_M = 6;

/** Per-class real-world heights in meters (movers + static objects). */
export const CLASS_HEIGHTS_M = {
  person: 1.7,
  bicycle: 1.2,
  car: 1.5,
  motorcycle: 1.2,
  bus: 2.8,
  truck: 2.8,
  chair: 0.9,
  bench: 0.7,
  'potted plant': 0.6,
  'stop sign': 2.0,
};

/** Fallback real height for unknown classes. */
export const DEFAULT_REAL_HEIGHT_M = 1.0;

/**
 * @typedef {object} DistanceOptions
 * @property {number} [frameHeightPx]
 * @property {number} [focalLengthPx] - device lookup override; when omitted
 *   the focal length is derived from frame height at an assumed ~60° VFOV
 * @property {Record<string, number>} [classHeights]
 */

/**
 * Device focal-length lookup seam. Pass an explicit focalLengthPx from a
 * device/camera calibration table when available; otherwise derive a
 * pinhole estimate f = (H/2) / tan(vfov/2) at ~60° vertical FOV.
 * @param {number} frameHeightPx
 * @param {{ focalLengthPx?: number }} [options]
 * @returns {number}
 */
export function getFocalLengthPx(frameHeightPx, options = {}) {
  const override = /** @type {any} */ (options).focalLengthPx;
  if (Number.isFinite(override) && override > 0) {
    return Number(override);
  }
  const H = Number(frameHeightPx) > 0 ? Number(frameHeightPx) : 480;
  return (H / 2) / Math.tan((60 * Math.PI) / 360);
}

/**
 * Pinhole estimate d ≈ f·H/h.
 * @param {{ boxHeightFraction: number, frameHeightPx: number, realHeightM: number, focalLengthPx: number }} args
 * @returns {number} estimated meters (Infinity when the box has no height)
 */
export function estimateDistanceMeters({ boxHeightFraction, frameHeightPx, realHeightM, focalLengthPx }) {
  const hPx = Number(boxHeightFraction) * Number(frameHeightPx);
  if (!Number.isFinite(hPx) || hPx <= 0) return Infinity;
  return (Number(focalLengthPx) * Number(realHeightM)) / hPx;
}

/**
 * Coarse band for an estimated distance. Meters never leave this module
 * as user-facing output; callers keep only the returned label.
 * @param {number} distanceMeters
 * @returns {string}
 */
export function bandForDistanceMeters(distanceMeters) {
  const d = Number(distanceMeters);
  if (!Number.isFinite(d)) return DISTANCE_BANDS.FAR;
  if (d < VERY_NEAR_MAX_M) return DISTANCE_BANDS.VERY_NEAR;
  if (d <= NEAR_MAX_M) return DISTANCE_BANDS.NEAR;
  return DISTANCE_BANDS.FAR;
}

/**
 * Estimate the coarse band for one Detection from its apparent height.
 * @param {{ height: number, category?: string }} detection
 * @param {DistanceOptions} [options]
 * @returns {{ band: string }}
 */
export function estimateBandForDetection(detection, options = {}) {
  const frameHeightPx = options.frameHeightPx ?? 480;
  const table = /** @type {Record<string, number>} */ (options.classHeights ?? CLASS_HEIGHTS_M);
  const realHeightM = table[String(detection.category)] ?? DEFAULT_REAL_HEIGHT_M;
  const focalLengthPx = getFocalLengthPx(frameHeightPx, options);
  const distanceMeters = estimateDistanceMeters({
    boxHeightFraction: Number(detection.height),
    frameHeightPx,
    realHeightM,
    focalLengthPx,
  });
  return { band: bandForDistanceMeters(distanceMeters) };
}

/**
 * Annotate Detections with their distance band (non-mutating, band only).
 * @param {any[]} detections
 * @param {DistanceOptions} [options]
 * @returns {any[]}
 */
export function annotateDetectionsWithBands(detections, options = {}) {
  if (!Array.isArray(detections)) return [];
  return detections.map((d) => ({ ...d, band: estimateBandForDetection(d, options).band }));
}
