// @ts-check
// Zones — frame-width thirds, Corridor, and size gate (Issue 04, CONTEXT.md).
// A Detection has no identity; the Zone is derived per frame from its box
// center-x. The Corridor is the center Zone (the walking path ahead).
// Detections below the size gate (8% of frame height) are ignored as too
// far to matter. Corridor width and min-size are live slider settings owned
// by the debug overlay / main thread and injected here as options, so this
// module stays pure and testable at zoneForDetection()/filterBySizeGate().

/** Zone vocabulary: left / center / right frame thirds. */
export const ZONES = {
  LEFT: 'left',
  CENTER: 'center',
  RIGHT: 'right',
};

/** Default Corridor width: the center third of the frame. */
export const DEFAULT_CORRIDOR_WIDTH = 1 / 3;

/** Default size gate: minimum box height as a fraction of frame height. */
export const DEFAULT_MIN_HEIGHT_FRACTION = 0.08;

/** Live on-screen slider range for the Corridor width (fraction of frame). */
export const CORRIDOR_WIDTH_SLIDER = {
  min: 0.2,
  max: 0.6,
  step: 0.01,
  default: DEFAULT_CORRIDOR_WIDTH,
};

/** Live on-screen slider range for the min-size gate (fraction of height). */
export const MIN_SIZE_SLIDER = {
  min: 0.02,
  max: 0.2,
  step: 0.005,
  default: DEFAULT_MIN_HEIGHT_FRACTION,
};

/**
 * @typedef {object} ZoneOptions
 * @property {number} [corridorWidth] - Corridor width as frame fraction
 * @property {number} [minHeightFraction] - size-gate threshold
 */

/**
 * Corridor bounds as normalized x fractions, centered on the frame.
 * @param {number} [corridorWidth]
 * @returns {{ left: number, right: number }}
 */
export function getCorridorBounds(corridorWidth = DEFAULT_CORRIDOR_WIDTH) {
  const w = Number(corridorWidth);
  const width = Number.isFinite(w)
    ? Math.min(0.9, Math.max(0.05, w))
    : DEFAULT_CORRIDOR_WIDTH;
  return { left: 0.5 - width / 2, right: 0.5 + width / 2 };
}

/**
 * Zone for a normalized center-x. Boundary values belong to the Corridor
 * (fail toward center so edge cases stay in the walking path).
 * @param {number} cx - normalized box center-x
 * @param {ZoneOptions} [options]
 * @returns {string}
 */
export function zoneForCenterX(cx, options = {}) {
  const { left, right } = getCorridorBounds(options.corridorWidth);
  const x = Number(cx);
  if (!Number.isFinite(x)) return ZONES.CENTER;
  if (x < left) return ZONES.LEFT;
  if (x > right) return ZONES.RIGHT;
  return ZONES.CENTER;
}

/**
 * Zone for a Detection box via its center-x (x + width / 2).
 * @param {{ x: number, width: number }} detection
 * @param {ZoneOptions} [options]
 * @returns {string}
 */
export function zoneForDetection(detection, options = {}) {
  const cx = Number(detection.x) + Number(detection.width) / 2;
  return zoneForCenterX(cx, options);
}

/**
 * Whether a Detection falls below the size gate (too far to matter).
 * @param {{ height: number }} detection
 * @param {ZoneOptions} [options]
 * @returns {boolean}
 */
export function isBelowSizeGate(detection, options = {}) {
  const min = options.minHeightFraction ?? DEFAULT_MIN_HEIGHT_FRACTION;
  const h = Number(detection.height);
  if (!Number.isFinite(h)) return true;
  return h < Number(min);
}

/**
 * Drop sub-gate Detections before tracking.
 * @param {any[]} detections
 * @param {ZoneOptions} [options]
 * @returns {any[]}
 */
export function filterBySizeGate(detections, options = {}) {
  if (!Array.isArray(detections)) return [];
  return detections.filter((d) => d && !isBelowSizeGate(d, options));
}

/**
 * Whether a Zone (or zoned Detection/Track) is in the Corridor.
 * @param {string | { zone: string }} zoneOrCarrier
 * @returns {boolean}
 */
export function isInCorridor(zoneOrCarrier) {
  const zone = typeof zoneOrCarrier === 'string' ? zoneOrCarrier : zoneOrCarrier?.zone;
  return zone === ZONES.CENTER;
}

/**
 * Annotate Detections with their Zone (non-mutating).
 * @param {any[]} detections
 * @param {ZoneOptions} [options]
 * @returns {any[]}
 */
export function annotateDetectionsWithZones(detections, options = {}) {
  if (!Array.isArray(detections)) return [];
  return detections.map((d) => ({ ...d, zone: zoneForDetection(d, options) }));
}
