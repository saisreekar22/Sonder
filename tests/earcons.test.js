import { describe, it, expect, vi } from 'vitest';
import {
  PAUSED_EARCON,
  RESUMED_EARCON,
  playEarcon,
  playPausedEarcon,
  playResumedEarcon,
} from '../src/earcons.js';

// Fake AudioContext: records scheduled oscillator notes without real audio.
function fakeAudioContext() {
  const ctx = {
    currentTime: 0,
    createOscillator: vi.fn(() => ({
      frequency: { value: 0 },
      connect: vi.fn(),
      start: vi.fn(),
      stop: vi.fn(),
    })),
    createGain: vi.fn(() => ({
      gain: { value: 0, setValueAtTime: vi.fn(), exponentialRampToValueAtTime: vi.fn() },
      connect: vi.fn(),
    })),
    destination: {},
  };
  return ctx;
}

describe('Earcons — distinct paused vs resumed confirms (Issue 01)', () => {
  it('paused and resumed earcons are two-note pulses', () => {
    expect(PAUSED_EARCON.notes).toHaveLength(2);
    expect(RESUMED_EARCON.notes).toHaveLength(2);
  });

  it('paused descends while resumed ascends, so they are distinguishable by ear alone', () => {
    const [p1, p2] = PAUSED_EARCON.notes;
    const [r1, r2] = RESUMED_EARCON.notes;
    expect(p1.frequency).toBeGreaterThan(p2.frequency);
    expect(r1.frequency).toBeLessThan(r2.frequency);
    // Independent literal check: specs must differ, not just mirror each other.
    expect(PAUSED_EARCON.notes).not.toEqual(RESUMED_EARCON.notes);
  });

  it('paused earcon uses known literal frequencies (independent source of truth)', () => {
    expect(PAUSED_EARCON.notes[0].frequency).toBe(660);
    expect(PAUSED_EARCON.notes[1].frequency).toBe(440);
    expect(RESUMED_EARCON.notes[0].frequency).toBe(440);
    expect(RESUMED_EARCON.notes[1].frequency).toBe(660);
  });

  it('playEarcon schedules one oscillator per note', () => {
    const ctx = fakeAudioContext();
    // @ts-expect-error — fake context for scheduling count
    playEarcon(ctx, PAUSED_EARCON);
    expect(ctx.createOscillator).toHaveBeenCalledTimes(2);
  });

  it('playPausedEarcon / playResumedEarcon schedule their own specs', () => {
    const ctxA = fakeAudioContext();
    const ctxB = fakeAudioContext();
    // @ts-expect-error — fake context
    playPausedEarcon(ctxA);
    // @ts-expect-error — fake context
    playResumedEarcon(ctxB);
    expect(ctxA.createOscillator).toHaveBeenCalledTimes(2);
    expect(ctxB.createOscillator).toHaveBeenCalledTimes(2);
  });
});
