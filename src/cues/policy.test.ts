import { describe, expect, it } from 'vitest';
import type { Category, Zone } from '../core/types';
import { bandOf } from '../perception/geometry';
import type { Track } from '../perception/tracker';
import { CUE_WINDOW_MS, CuePolicy } from './policy';

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

  it('ignores objects beyond 4.5 m and static things beside the path', () => {
    const p = new CuePolicy();
    expect(p.update([track(1, { distance: 5.5 })], 0, calm).sources).toHaveLength(0);
    const sideChair = track(2, { category: 'static', label: 'chair', zone: 'left', distance: 2.5 });
    expect(p.update([sideChair], 0, calm).sources).toHaveLength(0);
    // ...but the same person cues once they come within range
    expect(p.update([track(1, { distance: 4 })], 100, calm).sources[0]?.triggered).toBe(true);
  });

  it('a person walking across does not re-cue on every zone change', () => {
    const p = new CuePolicy();
    p.update([track(1, { distance: 4, zone: 'left' })], 0, calm);
    const crossed = p.update([track(1, { distance: 4, zone: 'center' })], 1500, calm);
    expect(crossed.sources.some((s) => s.triggered)).toBe(false);
  });

  it('getting closer re-cues only after the minimum gap, but becoming very near is urgent', () => {
    const p = new CuePolicy();
    p.update([track(1, { distance: 4.2 })], 0, calm);
    expect(p.update([track(1, { distance: 2.5 })], 2000, calm).sources.some((s) => s.triggered)).toBe(false);
    expect(p.update([track(1, { distance: 2.4 })], 4100, calm).sources[0]?.triggered).toBe(true);
    expect(p.update([track(1, { distance: 1.2 })], 5400, calm).sources[0]?.triggered).toBe(true);
  });
});
