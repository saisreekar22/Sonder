import { describe, it, expect } from 'vitest';
import {
  ZONES,
  DEFAULT_CORRIDOR_WIDTH,
  DEFAULT_MIN_HEIGHT_FRACTION,
  CORRIDOR_WIDTH_SLIDER,
  MIN_SIZE_SLIDER,
  getCorridorBounds,
  zoneForCenterX,
  zoneForDetection,
  isBelowSizeGate,
  filterBySizeGate,
  isInCorridor,
  annotateDetectionsWithZones,
} from '../src/zones.js';

describe('Zones — frame thirds, Corridor, size gate (Issue 04)', () => {
  it('exposes the left/center/right Zone vocabulary', () => {
    expect(ZONES.LEFT).toBe('left');
    expect(ZONES.CENTER).toBe('center');
    expect(ZONES.RIGHT).toBe('right');
  });

  it('defaults the Corridor to the center third with an 8% size gate', () => {
    expect(DEFAULT_CORRIDOR_WIDTH).toBeCloseTo(1 / 3, 5);
    expect(DEFAULT_MIN_HEIGHT_FRACTION).toBe(0.08);
  });

  it('splits the frame into thirds by box center-x', () => {
    expect(zoneForCenterX(0.1)).toBe('left');
    expect(zoneForCenterX(0.5)).toBe('center');
    expect(zoneForCenterX(0.9)).toBe('right');
  });

  it('assigns the boundary to the Corridor (fail toward center)', () => {
    const { left, right } = getCorridorBounds();
    expect(zoneForCenterX(left)).toBe('center');
    expect(zoneForCenterX(right)).toBe('center');
  });

  it('derives the Zone from a Detection box center-x', () => {
    expect(zoneForDetection({ x: 0.0, width: 0.2 })).toBe('left'); // cx 0.1
    expect(zoneForDetection({ x: 0.4, width: 0.2 })).toBe('center'); // cx 0.5
    expect(zoneForDetection({ x: 0.8, width: 0.2 })).toBe('right'); // cx 0.9
  });

  it('supports a live-adjustable Corridor width centered on the frame', () => {
    const wide = getCorridorBounds(0.6);
    expect(wide.left).toBeCloseTo(0.2, 5);
    expect(wide.right).toBeCloseTo(0.8, 5);
    expect(zoneForCenterX(0.25, { corridorWidth: 0.6 })).toBe('center');
    expect(zoneForCenterX(0.1, { corridorWidth: 0.6 })).toBe('left');
    expect(CORRIDOR_WIDTH_SLIDER.min).toBeLessThan(DEFAULT_CORRIDOR_WIDTH);
    expect(CORRIDOR_WIDTH_SLIDER.max).toBeGreaterThan(DEFAULT_CORRIDOR_WIDTH);
  });

  it('ignores boxes below the 8% frame-height size gate', () => {
    expect(isBelowSizeGate({ height: 0.07 })).toBe(true);
    expect(isBelowSizeGate({ height: 0.08 })).toBe(false);
    expect(isBelowSizeGate({ height: 0.3 })).toBe(false);
    // Invalid input never seeds a Track.
    expect(isBelowSizeGate({ height: NaN })).toBe(true);
  });

  it('supports a live-adjustable min-size gate', () => {
    expect(isBelowSizeGate({ height: 0.1 }, { minHeightFraction: 0.15 })).toBe(true);
    expect(isBelowSizeGate({ height: 0.1 }, { minHeightFraction: 0.05 })).toBe(false);
    expect(MIN_SIZE_SLIDER.default).toBe(DEFAULT_MIN_HEIGHT_FRACTION);
  });

  it('filters sub-gate Detections before tracking', () => {
    const ds = [
      { x: 0.4, y: 0.2, width: 0.2, height: 0.05, category: 'person', score: 0.9 },
      { x: 0.4, y: 0.2, width: 0.2, height: 0.3, category: 'person', score: 0.9 },
    ];
    expect(filterBySizeGate(ds)).toHaveLength(1);
  });

  it('treats the center Zone as the Corridor', () => {
    expect(isInCorridor({ zone: 'center' })).toBe(true);
    expect(isInCorridor({ zone: 'left' })).toBe(false);
    expect(isInCorridor('center')).toBe(true);
  });

  it('annotates Detections with their Zone without mutating input', () => {
    const input = [{ x: 0.1, y: 0.1, width: 0.2, height: 0.3, category: 'person', score: 0.9 }];
    const out = annotateDetectionsWithZones(input);
    expect(out[0].zone).toBe('left');
    expect(input[0].zone).toBeUndefined();
  });
});
