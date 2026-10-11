import { describe, expect, it } from 'vitest';
import type { Category, Zone } from '../core/types';
import { bandOf } from '../perception/geometry';
import type { Track } from '../perception/tracker';
import { CUE_WINDOW_MS, CuePolicy } from './policy';
import { COLS, ROWS, type PathModel } from '../perception/freespace';
import type { LgmdOutput } from '../perception/lgmd';

const cfg = { centerWidth: 0.34, blockDistance: 2, maxSources: 3 };

function track(id: number, opts: { zone?: Zone; distance?: number; category?: Category; label?: string; x?: number } = {}): Track {
  const zone = opts.zone ?? 'left';
  const x = opts.x ?? (zone === 'left' ? 0.1 : zone === 'right' ? 0.8 : 0.42);
  const d = opts.distance ?? 4;
  return {
    id,
    label: opts.label ?? 'person',
    category: opts.category ?? 'person',
    score: 0.9,
    box: { x, y: 0.2, w: 0.16, h: 0.5 },
    hits: 5,
    firstSeen: 0,
    lastSeen: 0,
    confirmed: true,
    zone,
    azimuth: zone === 'left' ? -0.4 : zone === 'right' ? 0.4 : 0,
    distance: d,
    band: bandOf(d),
    ttc: Infinity,
    approaching: false,
    history: [],
  };
}

describe('cue policy', () => {
  it('cues an object on first entry, then goes quiet after the cue window', () => {
    const p = new CuePolicy();
    const t = track(1);
    const a = p.update([t], 0, cfg);
    expect(a.sources).toHaveLength(1);
    expect(a.sources[0].triggered).toBe(true);
    expect(a.sources[0].kind).toBe('person');
    const b = p.update([t], 100, cfg);
    expect(b.sources[0].triggered).toBe(false);
    expect(p.update([t], CUE_WINDOW_MS + 50, cfg).sources).toHaveLength(0);
  });

  it('re-cues when markedly closer or on a zone change, not otherwise', () => {
    const p = new CuePolicy();
    p.update([track(1, { distance: 4.5 })], 0, cfg);
    expect(p.update([track(1, { distance: 4.3 })], 2000, cfg).sources).toHaveLength(0);
    const closer = p.update([track(1, { distance: 2.5 })], 2100, cfg);
    expect(closer.sources[0]?.triggered).toBe(true);
    expect(p.update([track(1, { distance: 2.5 })], 4000, cfg).sources).toHaveLength(0);
    const moved = p.update([track(1, { distance: 2.5, zone: 'right' })], 4100, cfg);
    expect(moved.sources[0]?.triggered).toBe(true);
  });

  it('unconfirmed (single-frame) detections never cue', () => {
    const p = new CuePolicy();
    expect(p.update([{ ...track(1), confirmed: false }], 0, cfg).sources).toHaveLength(0);
  });

  it('caps at three sources, prioritising vehicles over people over static', () => {
    const p = new CuePolicy();
    const out = p.update(
      [
        track(1, { category: 'static', label: 'chair', distance: 3, zone: 'left' }),
        track(2, { category: 'person', distance: 4, zone: 'right' }),
        track(3, { category: 'vehicle', label: 'car', distance: 4.5, zone: 'left' }),
        track(4, { category: 'person', distance: 3.5, zone: 'left' }),
      ],
      0,
      cfg,
    );
    expect(out.sources.map((s) => s.kind)).toEqual(['vehicle', 'person', 'person']);
  });

  it('close center obstacle: blocked buzz plus guide toward the freer side', () => {
    const p = new CuePolicy();
    const out = p.update(
      [
        track(1, { category: 'static', label: 'chair', zone: 'center', distance: 1.4 }),
        track(2, { category: 'person', zone: 'left', distance: 2 }),
      ],
      0,
      cfg,
    );
    expect(out.blocked).toBe(true);
    expect(out.guideSide).toBe('right');
    expect(out.sources[0].kind).toBe('blocked');
    expect(out.sources[0].zone).toBe('right');
    expect(out.sources[1]).toMatchObject({ kind: 'guide', zone: 'right' });
    // The blocking chair itself is not cued twice.
    expect(out.sources.filter((s) => s.trackId === 1)).toHaveLength(0);
  });

  it('steers left when the right side has an obstacle', () => {
    const p = new CuePolicy();
    const out = p.update(
      [
        track(1, { category: 'static', label: 'chair', zone: 'center', distance: 1.4 }),
        track(2, { category: 'person', zone: 'right', distance: 2 }),
      ],
      0,
      cfg,
    );
    expect(out.blocked).toBe(true);
    expect(out.guideSide).toBe('left');
    expect(out.sources[0].zone).toBe('left');
    expect(out.sources[1]).toMatchObject({ kind: 'guide', zone: 'left' });
  });

  it('blocked buzz becomes continuous inside 1 m and releases once the path clears', () => {
    const p = new CuePolicy();
    const near = p.update([track(1, { category: 'static', label: 'chair', zone: 'center', distance: 0.8 })], 0, cfg);
    expect(near.sources[0]).toMatchObject({ kind: 'blocked', continuous: true });
    expect(p.update([], 200, cfg).blocked).toBe(true); // brief dropout is bridged
    const cleared = p.update([], 1000, cfg);
    expect(cleared.blocked).toBe(false);
    expect(cleared.guideSide).toBeNull();
  });

  it('vehicles within 3 m add a second tone', () => {
    const p = new CuePolicy();
    const [s] = p.update([track(1, { category: 'vehicle', label: 'bicycle', distance: 2.5, zone: 'left' })], 0, cfg).sources;
    expect(s.secondTone).toBe(true);
  });

  it('looming surface alone triggers the blocked path', () => {
    const p = new CuePolicy();
    const out = p.update([], 0, cfg, true);
    expect(out.blocked).toBe(true);
    expect(out.sources[0].kind).toBe('blocked');
  });
});

describe('calm cue density (everyday walking)', () => {
  const calm = { ...cfg, density: 'calm' as const };

  it('silent unless something is in your path within 3.5 m, or coming at you', () => {
    const p = new CuePolicy();
    expect(p.update([track(1, { zone: 'center', distance: 4.5 })], 0, calm).sources).toHaveLength(0);
    const sideChair = track(2, { category: 'static', label: 'chair', zone: 'left', distance: 2.5 });
    expect(p.update([sideChair], 0, calm).sources).toHaveLength(0);
    // Someone beside you who is NOT coming at you: silent.
    expect(p.update([track(3, { zone: 'left', distance: 2.5 })], 0, calm).sources).toHaveLength(0);
    // ...but they sound once they approach
    const coming = { ...track(3, { zone: 'left', distance: 2.4 }), ttc: 2.5, approaching: true };
    expect(p.update([coming], 100, calm).sources[0]?.triggered).toBe(true);
    // ...and the person ahead cues once they come within range
    expect(p.update([track(1, { zone: 'center', distance: 3 })], 200, calm).sources.some((s) => s.trackId === 1 && s.triggered)).toBe(true);
  });

  it('a person walking across does not re-cue on every zone change', () => {
    const p = new CuePolicy();
    p.update([track(1, { distance: 4, zone: 'left' })], 0, calm);
    const crossed = p.update([track(1, { distance: 4, zone: 'center' })], 1500, calm);
    expect(crossed.sources.some((s) => s.triggered)).toBe(false);
  });

  it('getting closer re-cues only after the minimum gap, but becoming very near is urgent', () => {
    const p = new CuePolicy();
    const c = { zone: 'center' as const };
    p.update([track(1, { ...c, distance: 3.4 })], 0, calm);
    expect(p.update([track(1, { ...c, distance: 2.5 })], 2000, calm).sources.some((s) => s.triggered)).toBe(false);
    expect(p.update([track(1, { ...c, distance: 2.2 })], 5100, calm).sources.some((s) => s.trackId === 1 && s.triggered)).toBe(true);
    // Very near in your path: the blocked-path sound takes over.
    expect(p.update([track(1, { ...c, distance: 1.2 })], 6400, calm).blocked).toBe(true);
  });
});

/** Path model with walkable columns [c0, c1] for the whole ground region. */
function pathModel(c0: number, c1: number): PathModel {
  const path = new Uint8Array(ROWS * COLS);
  const freeHeight = new Float32Array(COLS);
  for (let c = c0; c <= c1; c++) {
    freeHeight[c] = 1;
    for (let r = 0; r < ROWS; r++) path[r * COLS + c] = 1;
  }
  return { path, freeHeight, confidence: 1 };
}

function lgmd(zone: 'left' | 'center' | 'right' | null): LgmdOutput {
  const s = { k: 0, z: 0, spike: false, looming: false };
  return { sectors: { left: s, center: s, right: s }, ffi: false, looming: zone, strength: zone ? 0.8 : 0 };
}

describe('path-aware guidance', () => {
  // Person standing on the right half of the path, 1.5 m ahead.
  const person = (seenAt = 0) => ({ ...track(1, { zone: 'center', distance: 1.5 }), lastSeen: seenAt, box: { x: 0.45, y: 0.3, w: 0.2, h: 0.6 } });

  it('guides to the side where the PATH continues, even if that side has a person further away', () => {
    const p = new CuePolicy();
    // Path covers columns 1..16 (left and middle); right of the blocker is grass.
    // A farther person on the left would have made the old rule pick RIGHT.
    const farLeft = track(2, { zone: 'left', distance: 4.5 });
    const out = p.update([person(), farLeft], 0, cfg, { path: pathModel(1, 16) });
    expect(out.guideSide).toBe('left');
    expect(out.guideFrom).toBe('path');
  });

  it('no walkable room on either side: no guide tone, flags "no way around"', () => {
    const p = new CuePolicy();
    const first = p.update([person(0)], 0, cfg, { path: pathModel(10, 16) });
    expect(first.noWayAround).toBe(false); // must persist before it is believed
    let out = first;
    for (let i = 1; i < 5; i++) out = p.update([person(i * 100)], i * 100, cfg, { path: pathModel(10, 16) });
    expect(out.blocked).toBe(true);
    expect(out.guideSide).toBeNull();
    expect(out.noWayAround).toBe(true);
    expect(out.sources.some((s) => s.kind === 'guide')).toBe(false);
  });

  it('a one-frame "no way around" (half-formed box) does not override "step left"', () => {
    const p = new CuePolicy();
    p.update([person(0)], 0, cfg, { path: pathModel(1, 16) }); // left
    const glitch = p.update([person(100)], 100, cfg, { path: pathModel(10, 16) }); // one bad frame
    expect(glitch.guideSide).toBe('left');
    expect(glitch.noWayAround).toBe(false);
    let out = glitch;
    for (let i = 2; i < 7; i++) out = p.update([person(i * 100)], i * 100, cfg, { path: pathModel(10, 16) });
    expect(out.noWayAround).toBe(true); // persists -> believed
  });

  it('without a trustworthy path model, falls back to the clutter rule', () => {
    const p = new CuePolicy();
    const m = { ...pathModel(2, 16), confidence: 0 };
    const out = p.update([person(), track(2, { zone: 'left', distance: 2 })], 0, cfg, { path: m });
    expect(out.guideFrom).toBe('clutter');
    expect(out.guideSide).toBe('right');
  });
});

describe('looming pathway fusion', () => {
  it('unexplained looming straight ahead = blocked path (unknown obstacle)', () => {
    const p = new CuePolicy();
    const out = p.update([], 0, cfg, { lgmd: lgmd('center') });
    expect(out.blocked).toBe(true);
    expect(out.unexplainedLooming).toBe('center');
  });

  it('unexplained looming on the left = a "whoosh" from the left', () => {
    const p = new CuePolicy();
    const out = p.update([], 0, cfg, { lgmd: lgmd('left') });
    expect(out.sources[0]).toMatchObject({ kind: 'looming', zone: 'left', triggered: true });
  });

  it('looming explained by a tracked object re-cues that object urgently instead', () => {
    const p = new CuePolicy();
    const calm = { ...cfg, density: 'calm' as const };
    p.update([track(1, { zone: 'right', distance: 3.5 })], 0, calm);
    const out = p.update([track(1, { zone: 'right', distance: 3.4 })], 1500, calm, { lgmd: lgmd('right') });
    expect(out.unexplainedLooming).toBeNull();
    expect(out.sources.find((s) => s.trackId === 1)?.triggered).toBe(true);
  });
});

describe('unrecognised obstacle measured by depth (a pole, a bench)', () => {
  it('steps away from where depth says it is', () => {
    const right = new CuePolicy().update([], 0, cfg, { loomingCenter: true, depthObstacle: { x: 0.3, z: 1.2 } });
    expect(right.blocked).toBe(true);
    expect(right.guideSide).toBe('left');
    const left = new CuePolicy().update([], 0, cfg, { loomingCenter: true, depthObstacle: { x: -0.25, z: 1.5 } });
    expect(left.guideSide).toBe('right');
  });
});

describe('someone ahead walking your way', () => {
  /** A person seen for 1 s, closing at the given speed (m/s) (size history h = 1/distance). */
  const ahead = (distance: number, closing: number, seenMs = 1000) => {
    const history = Array.from({ length: 8 }, (_, i) => {
      const t = (i / 7) * seenMs;
      return { t, h: 1 / (distance + closing * ((seenMs - t) / 1000)) };
    });
    const ttc = closing > 0 ? distance / closing : Infinity;
    return { ...track(7, { zone: 'center', distance }), history, ttc, approaching: ttc < 10 };
  };
  it('slowly closing while you walk: no STOP, follow or pass', () => {
    const o = new CuePolicy().update([ahead(1.8, 0.3)], 0, cfg, { walking: true });
    expect(o.blocked).toBe(false);
    expect(o.pacing?.trackId).toBe(7);
  });
  it('coming toward you fast is still a blockage', () => {
    const o = new CuePolicy().update([ahead(1.8, 2)], 0, cfg, { walking: true });
    expect(o.blocked).toBe(true);
    expect(o.pacing).toBeNull();
  });
  it('too close, or you are standing still: blockage as before', () => {
    expect(new CuePolicy().update([ahead(0.9, 0.3)], 0, cfg, { walking: true }).blocked).toBe(true);
    expect(new CuePolicy().update([ahead(1.8, 0.3)], 0, cfg, { walking: false }).blocked).toBe(true);
  });
  it('just seen (no size history yet): never assumed to be walking your way', () => {
    expect(new CuePolicy().update([ahead(1.8, 0.3, 200)], 0, cfg, { walking: true }).blocked).toBe(true);
  });
});
