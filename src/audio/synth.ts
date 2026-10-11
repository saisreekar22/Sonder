import type { SoundStyle } from '../core/types';

/**
 * Synthesized cue timbres (no audio files). Each function schedules one
 * pulse starting at ctx time `t` into `dest`. `urgency` 0..1 raises pitch.
 */
export interface PulseParams {
  urgency: number;
  style: SoundStyle;
  secondTone?: boolean;
  /** Seconds between pulses: long sounds are shortened to fit. */
  period: number;
}

function env(ctx: BaseAudioContext, dest: AudioNode, t: number, peak: number, attack: number, decay: number): GainNode {
  const g = ctx.createGain();
  g.gain.setValueAtTime(0, t);
  g.gain.linearRampToValueAtTime(peak, t + attack);
  g.gain.exponentialRampToValueAtTime(0.0001, t + attack + decay);
  g.connect(dest);
  return g;
}

function osc(ctx: BaseAudioContext, type: OscillatorType, freq: number, dest: AudioNode, t: number, dur: number) {
  const o = ctx.createOscillator();
  o.type = type;
  o.frequency.setValueAtTime(freq, t);
  o.connect(dest);
  o.start(t);
  o.stop(t + dur + 0.02);
  return o;
}

/** Person: soft two-note marimba blip. Faster and higher as they near. */
export function personPulse(ctx: BaseAudioContext, dest: AudioNode, t: number, p: PulseParams): void {
  const pitch = 1 + 0.5 * p.urgency;
  const soft = p.style === 'soft';
  const [f1, f2] = soft ? [440 * pitch, 587 * pitch] : [660 * pitch, 880 * pitch];
  const gap = Math.min(0.085, p.period * 0.35);
  for (const [i, f] of [f1, f2].entries()) {
    const start = t + i * gap;
    const decay = Math.min(0.22, p.period * 0.6);
    osc(ctx, 'sine', f, env(ctx, dest, start, 0.5, soft ? 0.02 : 0.012, decay), start, decay);
    // Marimba "bar" overtone at 4x, decaying faster.
    if (!soft) osc(ctx, 'sine', f * 4, env(ctx, dest, start, 0.08, 0.01, 0.05), start, 0.06);
  }
}

/** Vehicle / cyclist: low pulsing hum with a rising sweep; second tone inside 3 m. */
export function vehiclePulse(ctx: BaseAudioContext, dest: AudioNode, t: number, p: PulseParams): void {
  const pitch = 1 + 0.5 * p.urgency;
  const dur = Math.min(0.45, Math.max(0.12, p.period * 0.6));
  const f = 85 * pitch;
  const lp = ctx.createBiquadFilter();
  lp.type = 'lowpass';
  lp.frequency.value = 500 + 900 * p.urgency;
  const g = ctx.createGain();
  g.gain.setValueAtTime(0, t);
  g.gain.linearRampToValueAtTime(0.55, t + 0.04);
  g.gain.setValueAtTime(0.55, t + dur - 0.06);
  g.gain.linearRampToValueAtTime(0, t + dur);
  lp.connect(g).connect(dest);
  const tones: [OscillatorType, number, number][] = [[p.style === 'soft' ? 'triangle' : 'sawtooth', f, 1]];
  if (p.secondTone) tones.push(['square', f * 1.5, 0.35]);
  for (const [type, freq, level] of tones) {
    const lg = ctx.createGain();
    lg.gain.value = level;
    lg.connect(lp);
    const o = osc(ctx, type, freq, lg, t, dur);
    o.frequency.linearRampToValueAtTime(freq * 1.45, t + dur);
  }
}

/** Static obstacle: short dry wooden "tock". */
export function staticPulse(ctx: BaseAudioContext, dest: AudioNode, t: number, p: PulseParams, noise: AudioBuffer): void {
  const pitch = 1 + 0.4 * p.urgency;
  const soft = p.style === 'soft';
  const body = env(ctx, dest, t, 0.6, 0.008, 0.08);
  const o = osc(ctx, 'sine', (soft ? 500 : 720) * pitch, body, t, 0.08);
  o.frequency.exponentialRampToValueAtTime((soft ? 330 : 430) * pitch, t + 0.04);
  if (soft) return;
  const n = ctx.createBufferSource();
  n.buffer = noise;
  const bp = ctx.createBiquadFilter();
  bp.type = 'bandpass';
  bp.frequency.value = 1900;
  bp.Q.value = 3;
  n.connect(bp).connect(env(ctx, dest, t, 0.3, 0.004, 0.025));
  n.start(t);
  n.stop(t + 0.04);
}

/**
 * Looming (unrecognised object rushing at you): a rising noise "whoosh",
 * unlike any object timbre, so it means "something is coming, I don't know what".
 */
export function loomPulse(ctx: BaseAudioContext, dest: AudioNode, t: number, p: PulseParams, noise: AudioBuffer): void {
  const dur = Math.min(0.32, p.period * 0.8);
  const n = ctx.createBufferSource();
  n.buffer = noise;
  n.loop = true;
  const bp = ctx.createBiquadFilter();
  bp.type = 'bandpass';
  bp.Q.value = 2.5;
  bp.frequency.setValueAtTime(500, t);
  bp.frequency.exponentialRampToValueAtTime(3500, t + dur);
  const g = ctx.createGain();
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(0.8 + 0.4 * p.urgency, t + dur * 0.85);
  g.gain.linearRampToValueAtTime(0, t + dur);
  n.connect(bp).connect(g).connect(dest);
  n.start(t);
  n.stop(t + dur + 0.02);
}

/** Go-this-way guide: gentle rising tone. */
export function guidePulse(ctx: BaseAudioContext, dest: AudioNode, t: number): void {
  const g = ctx.createGain();
  g.gain.setValueAtTime(0, t);
  g.gain.linearRampToValueAtTime(0.4, t + 0.04);
  g.gain.setValueAtTime(0.4, t + 0.18);
  g.gain.linearRampToValueAtTime(0, t + 0.3);
  g.connect(dest);
  const o = osc(ctx, 'sine', 520, g, t, 0.3);
  o.frequency.exponentialRampToValueAtTime(800, t + 0.28);
}

/**
 * Blocked path: soft low hum. A sustained, mellow consonant source behind a
 * gate; the engine opens the gate in pulses, or holds it open inside 1 m.
 * Same { gate, stop } API as before, so callers are unchanged — only the
 * timbre is gentler (sine/triangle fifth, no distortion, lowpassed).
 */
export function createBuzz(ctx: BaseAudioContext, dest: AudioNode): { gate: GainNode; stop: (t: number) => void } {
  const gate = ctx.createGain();
  gate.gain.value = 0;
  const lp = ctx.createBiquadFilter();
  lp.type = 'lowpass';
  lp.frequency.value = 900;
  const level = ctx.createGain();
  level.gain.value = 0.5;
  lp.connect(level).connect(gate).connect(dest);
  const oscs = [
    ['sine', 196, 0.5],
    ['sine', 294, 0.35],
    ['triangle', 392, 0.18],
  ].map(([type, f, g]) => {
    const o = ctx.createOscillator();
    o.type = type as OscillatorType;
    o.frequency.value = f as number;
    const og = ctx.createGain();
    og.gain.value = g as number;
    o.connect(og).connect(lp);
    o.start();
    return o;
  });
  return {
    gate,
    stop: (t: number) => oscs.forEach((o) => o.stop(t)),
  };
}

export function makeNoise(ctx: BaseAudioContext): AudioBuffer {
  const buf = ctx.createBuffer(1, Math.floor(ctx.sampleRate * 0.1), ctx.sampleRate);
  const d = buf.getChannelData(0);
  for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
  return buf;
}

export type EarconName =
  | 'start'
  | 'stop'
  | 'pause'
  | 'resume'
  | 'ok'
  | 'warning'
  | 'lowFps'
  | 'attention'
  | 'approach'
  | 'tick'
  | 'recovered'
  | 'lineLost'
  | 'opened'
  | 'stopCue'
  | 'bend';

/** Distinct short system sounds, always centered. */
export function earcon(ctx: BaseAudioContext, dest: AudioNode, name: EarconName, t: number): number {
  const notes: Record<EarconName, [OscillatorType, number[], number, number]> = {
    // type, frequencies, spacing (s), peak
    start: ['sine', [523, 659, 784], 0.09, 0.5],
    stop: ['sine', [784, 659, 523], 0.09, 0.5],
    pause: ['triangle', [784, 523], 0.15, 0.55],
    resume: ['triangle', [523, 784], 0.15, 0.55],
    ok: ['sine', [880], 0.1, 0.45],
    attention: ['sine', [1200, 1200], 0.12, 0.4],
    lowFps: ['triangle', [220, 220, 220], 0.13, 0.25],
    warning: ['triangle', [988, 740, 988, 740], 0.13, 0.35],
    // Speech fallback for "something is approaching": three fast rising blips.
    approach: ['triangle', [660, 880, 1175], 0.07, 0.5],
    // Heartbeat: a barely-there tick meaning "still working".
    tick: ['sine', [1500], 0.05, 0.06],
    // Track mode: back in the centre of the lane (soft, quick, rising).
    recovered: ['sine', [880, 1175], 0.06, 0.25],
    // Track mode: lane lines not visible.
    lineLost: ['triangle', [330, 330], 0.16, 0.45],
    // The blockage is gone: you can move again (gentle, rising, open).
    opened: ['sine', [523, 659, 880], 0.11, 0.4],
    // Track: STOP (guide-line style): unmistakable, falling, repeated.
    stopCue: ['square', [880, 587, 392, 880, 587, 392], 0.11, 0.4],
    // Track: a bend is coming (soft two-note glide).
    bend: ['triangle', [587, 698], 0.09, 0.3],
  };
  const [type, freqs, gap, peak] = notes[name];
  freqs.forEach((f, i) => {
    const s = t + i * gap;
    const decay = name === 'warning' ? 0.11 : name === 'tick' ? 0.03 : 0.2;
    let out: AudioNode = env(ctx, dest, s, peak, 0.004, decay);
    if (type === 'square') {
      const lp = ctx.createBiquadFilter();
      lp.type = 'lowpass';
      lp.frequency.value = 3000;
      lp.connect(out);
      out = lp;
    }
    osc(ctx, type, f, out, s, decay);
  });
  return freqs.length * gap + 0.2;
}
