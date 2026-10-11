// @ts-check
// Earcons — short pulsed system confirms (Issue 01).
// Per ADR-0002 every cue is pulsed, never a continuous sweep: two short
// oscillator notes with a fixed gap. Paused descends, resumed ascends, so the
// user can tell them apart by ear alone.

/**
 * @typedef {object} EarconNote
 * @property {number} frequency - Hz
 * @property {number} duration - seconds per note
 * @property {number} gap - seconds of silence before this note (first note: 0)
 */

/**
 * @typedef {object} EarconSpec
 * @property {EarconNote[]} notes
 */

/** Paused confirm: high → low (660 → 440 Hz). */
export const PAUSED_EARCON = {
  notes: [
    { frequency: 660, duration: 0.12, gap: 0 },
    { frequency: 440, duration: 0.18, gap: 0.14 },
  ],
};

/** Resumed confirm: low → high (440 → 660 Hz). */
export const RESUMED_EARCON = {
  notes: [
    { frequency: 440, duration: 0.12, gap: 0 },
    { frequency: 660, duration: 0.18, gap: 0.14 },
  ],
};

/**
 * Schedule an earcon on a real or fake AudioContext.
 * Pulsed synthesis only: gentle sine blips with fast decay envelopes.
 *
 * @param {AudioContext} ctx
 * @param {EarconSpec} spec
 */
export function playEarcon(ctx, spec) {
  let t = ctx.currentTime;
  for (const note of spec.notes) {
    t += note.gap;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.frequency.value = note.frequency;
    osc.type = 'sine';
    gain.gain.setValueAtTime(0.5, t);
    gain.gain.exponentialRampToValueAtTime(0.001, t + note.duration);
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start(t);
    osc.stop(t + note.duration + 0.02);
    t += note.duration;
  }
}

/** @param {AudioContext} ctx */
export function playPausedEarcon(ctx) {
  playEarcon(ctx, PAUSED_EARCON);
}

/** @param {AudioContext} ctx */
export function playResumedEarcon(ctx) {
  playEarcon(ctx, RESUMED_EARCON);
}
