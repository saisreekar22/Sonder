import { describe, it, expect } from 'vitest';
import {
  DISTANCE_BANDS,
  VERY_NEAR_MAX_M,
  NEAR_MAX_M,
  CLASS_HEIGHTS_M,
  DEFAULT_REAL_HEIGHT_M,
  getFocalLengthPx,
  estimateDistanceMeters,
  bandForDistanceMeters,
  estimateBandForDetection,
  annotateDetectionsWithBands,
} from '../src/distance.js';

describe('Distance bands — coarse only, never meters (Issue 04)', () => {
  it('exposes the very near / near / far band vocabulary', () => {
    expect(DISTANCE_BANDS.VERY_NEAR).toBe('very near');
    expect(DISTANCE_BANDS.NEAR).toBe('near');
    expect(DISTANCE_BANDS.FAR).toBe('far');
    expect(VERY_NEAR_MAX_M).toBe(2);
    expect(NEAR_MAX_M).toBe(6);
  });

  it('ships a per-class real-height table keyed by mover and static-object classes', () => {
    for (const c of ['person', 'bicycle', 'car', 'motorcycle', 'bus', 'truck']) {
      expect(CLASS_HEIGHTS_M[c]).toBeGreaterThan(0);
    }
    for (const c of ['chair', 'bench', 'potted plant', 'stop sign']) {
      expect(CLASS_HEIGHTS_M[c]).toBeGreaterThan(0);
    }
    expect(DEFAULT_REAL_HEIGHT_M).toBeGreaterThan(0);
  });

  it('looks up focal length from frame height with an explicit override seam', () => {
    const f = getFocalLengthPx(480);
    expect(f).toBeGreaterThan(0);
    // Device lookup seam: an explicit focal length wins.
    expect(getFocalLengthPx(480, { focalLengthPx: 600 })).toBe(600);
  });

  it('estimates distance as d = f*H/h', () => {
    // f=400px, H=1.7m, h=200px on a 480px frame -> ~3.4m
    const d = estimateDistanceMeters({
      boxHeightFraction: 200 / 480,
      frameHeightPx: 480,
      realHeightM: 1.7,
      focalLengthPx: 400,
    });
    expect(d).toBeCloseTo(3.4, 1);
  });

  it('maps meters to coarse bands only', () => {
    expect(bandForDistanceMeters(1.5)).toBe('very near');
    expect(bandForDistanceMeters(1.99)).toBe('very near');
    expect(bandForDistanceMeters(2)).toBe('near');
    expect(bandForDistanceMeters(5.9)).toBe('near');
    expect(bandForDistanceMeters(6.01)).toBe('far');
    expect(bandForDistanceMeters(Infinity)).toBe('far');
  });

  it('estimates a band from apparent height: tall boxes are very near, short are far', () => {
    const near = estimateBandForDetection(
      { height: 0.8, category: 'person' },
      { frameHeightPx: 480 },
    );
    const far = estimateBandForDetection(
      { height: 0.05, category: 'person' },
      { frameHeightPx: 480 },
    );
    expect(near.band).toBe('very near');
    expect(far.band).toBe('far');
    // Band result never leaks meters to the caller contract beyond debug info.
    expect(['very near', 'near', 'far']).toContain(near.band);
  });

  it('annotates Detections with band labels only (never meters on the Detection)', () => {
    const out = annotateDetectionsWithBands(
      [{ x: 0.4, y: 0.2, width: 0.2, height: 0.4, category: 'person', score: 0.9 }],
      { frameHeightPx: 480 },
    );
    expect(['very near', 'near', 'far']).toContain(out[0].band);
    expect(out[0].distanceMeters).toBeUndefined();
  });
});
