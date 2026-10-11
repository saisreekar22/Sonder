import { describe, it, expect } from 'vitest';
import {
  IOU_THRESHOLD,
  MAX_MISSED_FRAMES,
  MAX_CUE_SOURCES,
  HEIGHT_GROWTH_CUE_RATIO,
  computeIoU,
  createTracker,
  selectCueSources,
} from '../src/tracker.js';

function det(over = {}) {
  return {
    x: 0.4, y: 0.2, width: 0.2, height: 0.3,
    category: 'person', score: 0.9,
    ...over,
  };
}

describe('Tracker — stable Track IDs, Cue gating, max 3 sources (Issue 04)', () => {
  it('exposes the IoU / lifetime / Cue-gating budgets', () => {
    expect(IOU_THRESHOLD).toBeGreaterThan(0);
    expect(MAX_MISSED_FRAMES).toBeGreaterThan(0);
    expect(MAX_CUE_SOURCES).toBe(3);
    expect(HEIGHT_GROWTH_CUE_RATIO).toBeCloseTo(1.3, 5);
  });

  it('computes custom IoU for normalized boxes', () => {
    const a = { x: 0, y: 0, width: 0.5, height: 0.5 };
    expect(computeIoU(a, a)).toBeCloseTo(1, 5);
    const b = { x: 0.5, y: 0.5, width: 0.5, height: 0.5 };
    expect(computeIoU(a, b)).toBe(0);
    const c = { x: 0.25, y: 0, width: 0.5, height: 0.5 };
    const iou = computeIoU(a, c);
    expect(iou).toBeGreaterThan(0.3);
    expect(iou).toBeLessThan(1);
  });

  it('assigns a stable Track ID across small frame-to-frame motion', () => {
    const t = createTracker();
    const first = t.update([det({ x: 0.4 })]);
    const second = t.update([det({ x: 0.42 })]);
    expect(first).toHaveLength(1);
    expect(second).toHaveLength(1);
    expect(second[0].id).toBe(first[0].id);
  });

  it('uses constant-velocity prediction to coast through one missed frame', () => {
    const t = createTracker({ maxMissedFrames: 3 });
    const a = t.update([det({ x: 0.2, width: 0.2 })]); // cx 0.3
    const id = a[0].id;
    t.update([det({ x: 0.25, width: 0.2 })]); // moving right
    const coasted = t.update([]); // one blank frame
    expect(coasted.map((r) => r.id)).toContain(id);
  });

  it('drops Tracks after maxMissedFrames blank frames', () => {
    const tr = createTracker({ maxMissedFrames: 2 });
    tr.update([det()]);
    tr.update([]);
    tr.update([]);
    expect(tr.update([])).toHaveLength(0);
  });

  it('Cues on first Zone entry, then only on Zone change or >30% height growth', () => {
    const tr = createTracker();
    const left = det({ x: 0.05, width: 0.15, height: 0.3 }); // cx 0.125 -> left
    let tracks = tr.update([left]);
    expect(tracks[0].shouldCue).toBe(true);

    // Same Zone, same size: no re-cue.
    tracks = tr.update([det({ x: 0.05, width: 0.15, height: 0.3 })]);
    expect(tracks[0].shouldCue).toBe(false);

    // Same Zone, 10% growth: still quiet.
    tracks = tr.update([det({ x: 0.05, width: 0.15, height: 0.33 })]);
    expect(tracks[0].shouldCue).toBe(false);

    // Same Zone, 40% growth over last cued height: re-cue.
    tracks = tr.update([det({ x: 0.05, width: 0.15, height: 0.42 })]);
    expect(tracks[0].shouldCue).toBe(true);

    // Zone change left -> center: re-cue even without growth.
    // Overlapping steps (IoU > threshold) so identity is kept.
    tracks = tr.update([det({ x: 0.1, width: 0.2, height: 0.42 })]);
    expect(tracks).toHaveLength(1);
    tracks = tr.update([det({ x: 0.18, width: 0.2, height: 0.42 })]);
    expect(tracks).toHaveLength(1);
    tracks = tr.update([det({ x: 0.26, width: 0.2, height: 0.42 })]);
    expect(tracks).toHaveLength(1);
    expect(tracks[0].zone).toBe('center');
    expect(tracks[0].shouldCue).toBe(true);
  });

  it('caps simultaneous Cue sources at three by closeness priority', () => {
    const tr = createTracker();
    const ds = [
      det({ x: 0.05, width: 0.1, height: 0.8, category: 'person', score: 0.9 }),
      det({ x: 0.25, width: 0.1, height: 0.8, category: 'car', score: 0.9 }),
      det({ x: 0.45, width: 0.1, height: 0.8, category: 'bus', score: 0.9 }),
      det({ x: 0.65, width: 0.1, height: 0.8, category: 'chair', score: 0.9 }),
      det({ x: 0.85, width: 0.1, height: 0.8, category: 'person', score: 0.9 }),
    ];
    const tracks = tr.update(ds);
    expect(tracks.filter((r) => r.shouldCue).length).toBe(5);
    const cues = selectCueSources(tracks);
    expect(cues).toHaveLength(3);
  });

  it('annotates Tracks with Zone and distance band, never meters', () => {
    const tr = createTracker({ frameHeightPx: 480 });
    const tracks = tr.update([det({ x: 0.4, width: 0.2, height: 0.4 })]);
    expect(['left', 'center', 'right']).toContain(tracks[0].zone);
    expect(['very near', 'near', 'far']).toContain(tracks[0].band);
    expect(tracks[0].distanceMeters).toBeUndefined();
  });

  it('end to end: a person walking left to right keeps one identity, re-cues on Zone change, vanishes below the size gate', () => {
    const tr = createTracker({ frameHeightPx: 480 });
    // Walk the box center from left edge to right edge in small
    // overlapping steps (IoU > threshold) so identity is kept.
    const xs = [0.02, 0.07, 0.12, 0.17, 0.22, 0.27, 0.32, 0.37, 0.42, 0.47, 0.52, 0.57, 0.62, 0.67];
    let id = null;
    const cueZones = [];
    for (const x of xs) {
      const tracks = tr.update([det({ x, width: 0.15, height: 0.35 })]);
      expect(tracks).toHaveLength(1);
      if (id === null) id = tracks[0].id;
      else expect(tracks[0].id).toBe(id);
      if (tracks[0].shouldCue) cueZones.push(tracks[0].zone);
    }
    // Entered left, crossed the Corridor, exited right: at least 3 cue events.
    expect(cueZones).toContain('left');
    expect(cueZones).toContain('center');
    expect(cueZones).toContain('right');

    // Receding to a speck below the size gate: filtered, then the Track coasts out.
    let live = tr.update([det({ x: 0.72, width: 0.05, height: 0.05 })]);
    expect(live).toHaveLength(1); // coasting on velocity, not re-seeded
    expect(live[0].id).toBe(id);
    for (let i = 0; i < MAX_MISSED_FRAMES; i++) live = tr.update([]);
    expect(live).toHaveLength(0);
  });
});
