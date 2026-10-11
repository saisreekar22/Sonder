import type { AudioMode, SoundStyle } from '../core/types';
import type { CueSource } from '../cues/policy';
import { zonePan } from '../perception/zones';
import { spreadAzimuth } from '../perception/geometry';
import { makeImpulse, type SceneObject } from '../perception/sceneMemory';
import { PgSoundPack, type GuideSignal } from './pgSounds';
import {
  createBuzz,
  earcon,
  guidePulse,
  loomPulse,
  makeNoise,
  personPulse,
  staticPulse,
  vehiclePulse,
  type EarconName,
} from './synth';

/** Hard ceiling on master gain to protect hearing. The volume slider scales below it. */
export const SAFE_MAX_GAIN = 0.6;
/** ~ -12 dB while speech is playing. */
export const DUCK_GAIN = 10 ** (-12 / 20);
const LOOKAHEAD_S = 0.1;
const TICK_MS = 25;
const SMOOTH_S = 0.05;

type Panner = PannerNode | StereoPannerNode;

/** Extra left/right level difference added on top of HRTF (0..1). */
const ILD_BOOST = 0.6;

export { spreadAzimuth } from '../perception/geometry';

interface Voice {
  src: CueSource;
  out: GainNode;
  panner: Panner;
  /** Spatial mode extras: extra interaural level difference, and distance darkening. */
  boost?: StereoPannerNode;
  air?: BiquadFilterNode;
  /** Send into the shared room reverb (externalisation). */
  send?: GainNode;
  nextPulse: number;
  buzz?: ReturnType<typeof createBuzz>;
  gateOpen: boolean;
}

/**
 * Owns the Web Audio graph:
 *   voices -> cueBus (ducked during speech) -> master (<= SAFE_MAX_GAIN) -> limiter -> out
 *   earcons -> master
 * One voice per cue source, pulsing on a lookahead scheduler so timing stays
 * tight even when the main thread is busy.
 */
export class AudioEngine {
  ctx: AudioContext | null = null;
  mode: AudioMode = 'spatial';
  style: SoundStyle = 'classic';
  /** Spatial-mode direction widening (see Settings.spatialSpread). */
  spread = 2.2;
  private master!: GainNode;
  private cueBus!: GainNode;
  private noise!: AudioBuffer;
  private voices = new Map<string, Voice>();
  /** Persistent spatial chains for lane pings (left and right), built per context. */
  private pingChains: { ctx: AudioContext; left: AudioNode; right: AudioNode } | null = null;
  /** Shared room reverb input: makes sounds feel out in the world, not inside your head. */
  private reverbIn!: GainNode;
  /** Continuous 360-degree scene ("8D" surround) voices. */
  private sceneBus!: GainNode;
  private presences = new Map<string, Presence>();
  /** 0..1 loudness of the surround scene relative to cues. */
  sceneLevel = 0.5;
  private laneTone: { ctx: AudioContext; a: OscillatorNode; b: OscillatorNode; bGain: GainNode; level: GainNode; pan: StereoPannerNode } | null = null;
  private metro: { timer: number; next: number; period: number } | null = null;
  private glide: GlideVoice | null = null;
  private cane: CaneVoice | null = null;
  private pg: PgSoundPack | null = null;
  private pgCtx: AudioContext | null = null;
  private beacon: BeaconVoice | null = null;
  /**
   * Audio buffer size. 'interactive' = lowest delay; 'balanced'/'playback' =
   * bigger buffers, which stops crackle and dropouts on many Bluetooth links.
   */
  latencyMode: AudioContextLatencyCategory = 'interactive';
  /** Keep Bluetooth headphones awake with an inaudible signal (stops clipped first cues). */
  keepAlive = true;
  /**
   * The keep-alive only plays while guidance is actually running on Bluetooth
   * headphones - never on menus, pause or wired output (it can be heard as a
   * faint hiss on some headphones at high volume).
   */
  private keepAliveWanted = false;
  private keepAliveNode: AudioBufferSourceNode | null = null;
  private timer: number | undefined;
  private volume = 0.8;
  private sinkId = '';
  private mediaStreamDest: MediaStreamAudioDestinationNode | null = null;
  private mediaEl: HTMLAudioElement | null = null;

  /** Must be called from a user gesture (iOS starts audio only after a tap). */
  async unlock(): Promise<void> {
    if (!this.ctx) {
      const nav = navigator as Navigator & { audioSession?: { type: string } };
      // iOS 16.4+: play even when the ring/silent switch is on silent.
      if (nav.audioSession) nav.audioSession.type = 'playback';
      const ctx = new AudioContext({ latencyHint: this.latencyMode });
      this.ctx = ctx;
      const limiter = ctx.createDynamicsCompressor();
      limiter.threshold.value = -8;
      limiter.knee.value = 0;
      limiter.ratio.value = 20;
      limiter.attack.value = 0.002;
      limiter.release.value = 0.12;
      const canCtxSink = typeof AudioContext !== 'undefined' && 'setSinkId' in AudioContext.prototype;
      limiter.connect(ctx.destination);

      // If AudioContext does not support setSinkId, use HTMLMediaElement bridge fallback
      if (!canCtxSink) {
        try {
          if ('createMediaStreamDestination' in ctx) {
            this.mediaStreamDest = ctx.createMediaStreamDestination();
            limiter.connect(this.mediaStreamDest);
            if (!this.mediaEl) {
              const el = document.createElement('audio');
              el.autoplay = true;
              el.setAttribute('playsinline', 'true');
              el.muted = false;
              el.style.display = 'none';
              document.body.appendChild(el);
              this.mediaEl = el;
            }
            this.mediaEl.srcObject = this.mediaStreamDest.stream;
            this.mediaEl.play().catch(() => {});
          }
        } catch (err) {
          console.warn('Bluetooth audio bridge setup error:', err);
        }
      }

      this.master = ctx.createGain();
      this.master.connect(limiter);
      this.cueBus = ctx.createGain();
      this.cueBus.connect(this.master);
      this.noise = makeNoise(ctx);
      // Room: a short, wide, darkening reverb shared by every spatial sound.
      const conv = ctx.createConvolver();
      const [L, R] = makeImpulse(ctx.sampleRate, 1.1);
      const ir = ctx.createBuffer(2, L.length, ctx.sampleRate);
      ir.copyToChannel(L as Float32Array<ArrayBuffer>, 0);
      ir.copyToChannel(R as Float32Array<ArrayBuffer>, 1);
      conv.buffer = ir;
      this.reverbIn = ctx.createGain();
      const ret = ctx.createGain();
      ret.gain.value = 0.55;
      this.reverbIn.connect(conv).connect(ret).connect(this.master);
      this.sceneBus = ctx.createGain();
      this.sceneBus.connect(this.master);
      this.presences.clear();
      this.startKeepAlive();
      this.setVolume(this.volume);

      // If a sink was previously saved, route to it; otherwise auto-detect Bluetooth earphones
      if (this.sinkId) {
        await this.setOutput(this.sinkId).catch(() => {});
      } else {
        await this.autoSelectBluetooth().catch(() => {});
      }

      // A silent buffer fully unlocks output on older iOS.
      const b = ctx.createBufferSource();
      b.buffer = ctx.createBuffer(1, 1, 22050);
      b.connect(ctx.destination);
      b.start();
    }
    if (this.ctx.state !== 'running') await this.ctx.resume();
    if (this.mediaEl && this.mediaEl.paused) this.mediaEl.play().catch(() => {});
    if (this.timer === undefined) this.timer = window.setInterval(() => this.schedule(), TICK_MS);
  }

  get running(): boolean {
    return this.ctx?.state === 'running';
  }

  /**
   * Channels the current output device can play. 1 means mono: a Bluetooth
   * headset in "hands-free" call mode, or OS mono audio. Spatial cues are
   * impossible until that is fixed.
   */
  get outputChannels(): number {
    return this.ctx?.destination.maxChannelCount ?? 0;
  }

  /** The device id currently selected for output ('' = system default). */
  get outputId(): string {
    return this.sinkId;
  }

  /**
   * Tear down and recreate the audio graph. Browsers can keep playing to the
   * device that was default when audio started (e.g. laptop speakers) after
   * Bluetooth headphones connect; a fresh context binds to the new default.
   */
  async rebuild(): Promise<void> {
    const old = this.ctx;
    for (const [key, v] of this.voices) this.release(key, v);
    this.voices.clear();
    for (const [k, p] of this.presences) this.releasePresence(k, p);
    this.keepAliveNode = null;
    this.ctx = null;
    if (this.mediaEl) {
      this.mediaEl.pause();
      this.mediaEl.srcObject = null;
      this.mediaEl.remove();
      this.mediaEl = null;
    }
    if (old) await old.close().catch(() => {});
    await this.unlock();
  }

  /** Output path latency in ms (device buffer + hardware), when the browser reports it. */
  get outputLatencyMs(): number {
    if (!this.ctx) return 0;
    return ((this.ctx.outputLatency || 0) + (this.ctx.baseLatency || 0)) * 1000;
  }

  /** Whether the browser can route audio to a chosen device (Chrome/Edge 110+). */
  static get canChooseOutput(): boolean {
    return (
      (typeof AudioContext !== 'undefined' && 'setSinkId' in AudioContext.prototype) ||
      (typeof HTMLMediaElement !== 'undefined' && 'setSinkId' in HTMLMediaElement.prototype) ||
      (typeof navigator !== 'undefined' && 'mediaDevices' in navigator && 'selectAudioOutput' in (navigator.mediaDevices as unknown as Record<string, unknown>))
    );
  }

  /**
   * Send all sound to a specific output, e.g. Bluetooth headphones.
   * '' = system default. Elsewhere, audio follows the OS's current output.
   */
  async setOutput(deviceId: string): Promise<void> {
    this.sinkId = deviceId;
    const ctx = this.ctx as (AudioContext & { setSinkId?: (id: string) => Promise<void> }) | null;
    if (ctx?.setSinkId) await ctx.setSinkId(deviceId).catch(console.warn);
    if (this.mediaEl && 'setSinkId' in this.mediaEl) {
      await (this.mediaEl as unknown as { setSinkId(id: string): Promise<void> }).setSinkId(deviceId).catch(console.warn);
    }
  }

  /**
   * Scan for connected Bluetooth earphones or headphones and route audio to them.
   * Returns null if no explicitly labeled Bluetooth device is detected.
   * Never forces output to an internal speaker.
   */
  async autoSelectBluetooth(): Promise<{ deviceId: string; label: string } | null> {
    if (typeof navigator === 'undefined' || !navigator.mediaDevices?.enumerateDevices) return null;
    try {
      const devices = await navigator.mediaDevices.enumerateDevices().catch(() => []);
      const outs = devices.filter((d) => d.kind === 'audiooutput' && d.deviceId !== 'default' && d.deviceId !== 'communications');
      if (outs.length === 0) return null;

      const btRegex = /bluetooth|earphone|headphone|airpod|bud|headset|wireless|shokz|beats|bose|sony|jbl|wh-|wf-|galaxy/i;
      const bt = outs.find((d) => d.label && btRegex.test(d.label));
      if (bt) {
        await this.setOutput(bt.deviceId);
        return { deviceId: bt.deviceId, label: bt.label };
      }
    } catch (e) {
      console.warn('Auto-select Bluetooth output error:', e);
    }
    return null;
  }

  /**
   * Allow explicit user selection of Bluetooth or external headphones.
   * Uses navigator.mediaDevices.selectAudioOutput() if available, else checks labeled devices.
   */
  async selectBluetoothOutput(): Promise<{ deviceId: string; label: string } | null> {
    if (typeof navigator !== 'undefined' && navigator.mediaDevices && 'selectAudioOutput' in navigator.mediaDevices) {
      try {
        const picker = navigator.mediaDevices as unknown as { selectAudioOutput(): Promise<MediaDeviceInfo> };
        const dev = await picker.selectAudioOutput();
        if (dev && dev.deviceId) {
          await this.setOutput(dev.deviceId);
          return { deviceId: dev.deviceId, label: dev.label || 'Selected Headphones' };
        }
      } catch (e) {
        console.warn('selectAudioOutput cancelled or error:', e);
        return null;
      }
    }
    return this.autoSelectBluetooth();
  }

  /**
   * Enumerate available audio outputs with Bluetooth detection metadata.
   */
  async getAudioOutputs(): Promise<Array<{ deviceId: string; label: string; isBluetooth: boolean; isDefault: boolean }>> {
    if (typeof navigator === 'undefined' || !navigator.mediaDevices?.enumerateDevices) return [];
    try {
      const devices = await navigator.mediaDevices.enumerateDevices().catch(() => []);
      const outs = devices.filter((d) => d.kind === 'audiooutput');
      const btRegex = /bluetooth|earphone|headphone|airpod|bud|headset|wireless|shokz|beats|bose|sony|jbl|wh-|wf-|galaxy/i;
      return outs.map((d, i) => {
        const isDefault = d.deviceId === 'default' || d.deviceId === '';
        const isBt = btRegex.test(d.label);
        const cleanLabel = d.label ? d.label.replace(/^Default - /, '') : (isDefault ? 'System default' : `Output ${i + 1}`);
        return {
          deviceId: d.deviceId,
          label: cleanLabel,
          isBluetooth: isBt,
          isDefault,
        };
      });
    } catch {
      return [];
    }
  }

  /**
   * Play a pleasant stereo chime to verify sound output is routed to headphones.
   */
  async testSound(): Promise<void> {
    await this.unlock();
    if (!this.ctx) return;
    const ctx = this.ctx;
    const t = ctx.currentTime + 0.05;

    // Left chime
    const o1 = ctx.createOscillator();
    const g1 = ctx.createGain();
    const pan1 = ctx.createStereoPanner();
    o1.type = 'sine';
    o1.frequency.setValueAtTime(587.33, t);
    o1.frequency.exponentialRampToValueAtTime(880, t + 0.15);
    g1.gain.setValueAtTime(0, t);
    g1.gain.linearRampToValueAtTime(0.5, t + 0.03);
    g1.gain.exponentialRampToValueAtTime(0.001, t + 0.35);
    pan1.pan.setValueAtTime(-0.6, t);
    o1.connect(g1).connect(pan1).connect(this.master);
    o1.start(t);
    o1.stop(t + 0.38);

    // Right chime
    const t2 = t + 0.18;
    const o2 = ctx.createOscillator();
    const g2 = ctx.createGain();
    const pan2 = ctx.createStereoPanner();
    o2.type = 'sine';
    o2.frequency.setValueAtTime(880, t2);
    o2.frequency.exponentialRampToValueAtTime(1174.66, t2 + 0.18);
    g2.gain.setValueAtTime(0, t2);
    g2.gain.linearRampToValueAtTime(0.6, t2 + 0.03);
    g2.gain.exponentialRampToValueAtTime(0.001, t2 + 0.45);
    pan2.pan.setValueAtTime(0.6, t2);
    o2.connect(g2).connect(pan2).connect(this.master);
    o2.start(t2);
    o2.stop(t2 + 0.48);

    return new Promise((resolve) => setTimeout(resolve, 700));
  }

  setVolume(v: number): void {
    this.volume = Math.min(1, Math.max(0, v));
    if (this.ctx) this.master.gain.setTargetAtTime(this.volume * SAFE_MAX_GAIN, this.ctx.currentTime, 0.02);
  }

  setMode(mode: AudioMode): void {
    if (mode === this.mode) return;
    this.mode = mode;
    this.silence(); // voices rebuild with the new panner type on the next update
  }

  duck(on: boolean): void {
    if (!this.ctx) return;
    this.cueBus.gain.setTargetAtTime(on ? DUCK_GAIN : 1, this.ctx.currentTime, 0.04);
    this.sceneBus.gain.setTargetAtTime(on ? DUCK_GAIN : 1, this.ctx.currentTime, 0.04);
  }

  /**
   * "8D" surround scene: every nearby thing gets its own soft, CONTINUOUS
   * sound that moves with it in real time, all the way round you (remembered
   * objects keep moving behind you). Not beeps: a quiet ambient picture
   * under the cues. Pass [] to turn it off.
   */
  updateScene(objs: SceneObject[]): void {
    const ctx = this.ctx;
    if (!ctx || ctx.state !== 'running') return;
    const keep = new Set(objs.map((o) => o.key));
    for (const [k, p] of this.presences) if (!keep.has(k)) this.releasePresence(k, p);
    const t = ctx.currentTime;
    for (const o of objs) {
      let p = this.presences.get(o.key);
      if (!p || p.kind !== o.kind) {
        if (p) this.releasePresence(o.key, p);
        p = createPresence(ctx, o.kind, this.noise, this.sceneBus, this.reverbIn);
        this.presences.set(o.key, p);
      }
      const behind = Math.abs(o.azimuth) > Math.PI / 2;
      const x = Math.sin(o.azimuth) * Math.cos(o.elevation);
      const y = Math.sin(o.elevation);
      const z = -Math.cos(o.azimuth) * Math.cos(o.elevation);
      const tc = 0.08; // smooth, real-time motion without zipper noise
      if (p.panner.positionX) {
        p.panner.positionX.setTargetAtTime(x, t, tc);
        p.panner.positionY.setTargetAtTime(y, t, tc);
        p.panner.positionZ.setTargetAtTime(z, t, tc);
      }
      p.boost.pan.setTargetAtTime(Math.sin(o.azimuth) * ILD_BOOST, t, tc);
      // Behind you sounds duller (a natural front/back cue); far sounds duller too.
      p.air.frequency.setTargetAtTime((2500 + 12000 * o.presence) * (behind ? 0.55 : 1), t, tc);
      p.level.gain.setTargetAtTime(this.sceneLevel * 0.32 * o.presence, t, 0.12);
      p.send.gain.setTargetAtTime(0.12 + 0.4 * (1 - o.presence), t, 0.12);
    }
  }

  private releasePresence(key: string, p: Presence): void {
    this.presences.delete(key);
    const t = this.ctx!.currentTime;
    p.level.gain.cancelScheduledValues(t);
    p.level.gain.setTargetAtTime(0, t, 0.15);
    for (const s of p.sources) s.stop(t + 1);
    setTimeout(() => p.nodes.forEach((n) => n.disconnect()), 1200);
  }

  /** System sound; `pan` (-1..1) places it to one side (e.g. a fallback warning). */
  earcon(name: EarconName, pan = 0): number {
    if (!this.ctx) return 0;
    let dest: AudioNode = this.master;
    if (pan !== 0) {
      const p = this.ctx.createStereoPanner();
      p.pan.value = pan;
      p.connect(this.master);
      dest = p;
    }
    return earcon(this.ctx, dest, name, this.ctx.currentTime + 0.01);
  }

  /**
   * Track mode: an instant lane ping from one side (pan -1 left, +1 right).
   * A broadband click (localises far better than a pure tone) plus a short
   * tone that rises with intensity, through HRTF + level boost at +/-70 deg.
   * Scheduled at "now" for the lowest possible latency.
   */
  lanePing(pan: number, intensity: number, edgeWarning = false): void {
    const ctx = this.ctx;
    if (!ctx || ctx.state !== 'running') return;
    const dest = this.pingChain(pan < 0 ? 'left' : 'right');
    const t = ctx.currentTime;
    if (edgeWarning) {
      // The guide-line system: a distinct high-pitched warning near the edge.
      const w = ctx.createOscillator();
      w.type = 'square';
      w.frequency.value = 2800;
      const wg = ctx.createGain();
      wg.gain.setValueAtTime(0.3, t);
      wg.gain.exponentialRampToValueAtTime(0.0001, t + 0.07);
      w.connect(wg).connect(dest);
      w.start(t);
      w.stop(t + 0.08);
      return;
    }
    const level = 0.35 + 0.65 * intensity;
    const n = ctx.createBufferSource();
    n.buffer = this.noise;
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = 3200;
    bp.Q.value = 0.8;
    const ng = ctx.createGain();
    ng.gain.setValueAtTime(0.9 * level, t);
    ng.gain.exponentialRampToValueAtTime(0.0001, t + 0.025);
    n.connect(bp).connect(ng).connect(dest);
    n.start(t);
    n.stop(t + 0.03);
    const o = ctx.createOscillator();
    o.frequency.value = 1300 + 900 * intensity;
    const og = ctx.createGain();
    og.gain.setValueAtTime(0.5 * level, t);
    og.gain.exponentialRampToValueAtTime(0.0001, t + 0.06);
    o.connect(og).connect(dest);
    o.start(t);
    o.stop(t + 0.07);
  }

  /**
   * Continuous-tone feedback style: a quiet steady tone means "on the line".
   * As you drift, it moves to the side of the line you're nearing, gets
   * louder, and a second detuned tone makes it increasingly dissonant.
   * Call every frame; active=false fades it out.
   */
  setLaneTone(active: boolean, pan: number, drift: number): void {
    const ctx = this.ctx;
    if (!ctx || ctx.state !== 'running') return;
    if (!this.laneTone || this.laneTone.ctx !== ctx) {
      if (!active) return;
      const a = ctx.createOscillator();
      const b = ctx.createOscillator();
      a.frequency.value = 440;
      b.frequency.value = 440;
      const bGain = ctx.createGain();
      bGain.gain.value = 0;
      const level = ctx.createGain();
      level.gain.value = 0;
      const p = ctx.createStereoPanner();
      a.connect(level);
      b.connect(bGain).connect(level);
      level.connect(p).connect(this.master);
      a.start();
      b.start();
      this.laneTone = { ctx, a, b, bGain, level, pan: p };
    }
    const lt = this.laneTone;
    const t = ctx.currentTime;
    const d = Math.min(1, Math.max(0, drift));
    lt.level.gain.setTargetAtTime(active ? 0.05 + 0.25 * d : 0, t, 0.03);
    lt.pan.pan.setTargetAtTime(active ? Math.max(-1, Math.min(1, pan * Math.min(1, d * 2.5))) : 0, t, 0.03);
    lt.b.frequency.setTargetAtTime(440 * (1 + 0.07 * d), t, 0.03);
    lt.bGain.gain.setTargetAtTime(active ? d : 0, t, 0.03);
  }

  /**
   * Smooth guidance tone (default track feedback): one continuous voice whose
   * pitch glides LOW -> HIGH as the needed correction grows, pulsing with a
   * soft sinusoidal swell (no clicks) that speeds up gradually. It sits in 3D
   * on the side to steer toward, and fades to silence when you're on line.
   * Near the edge a gentle high warning fades in, in the OTHER ear.
   * Call every frame; everything glides, nothing jumps.
   */
  setGuideTone(g: { active: boolean; steer: number; magnitude: number; edge: number }): void {
    const ctx = this.ctx;
    if (!ctx || ctx.state !== 'running') return;
    if (!this.glide || this.glide.ctx !== ctx) {
      if (!g.active) return;
      this.glide = createGlide(ctx, this.master, this.reverbIn);
    }
    const v = this.glide;
    const t = ctx.currentTime;
    const m = Math.max(0, Math.min(1, g.magnitude));
    const side = g.steer >= 0 ? 1 : -1;
    const on = g.active && m > 0.001;
    // Pitch: 300 Hz (tiny correction) gliding up to ~950 Hz (big correction).
    v.osc.frequency.setTargetAtTime(300 * Math.pow(2, 1.65 * m), t, 0.12);
    v.osc2.frequency.setTargetAtTime(600 * Math.pow(2, 1.65 * m), t, 0.12);
    // Pulse rate: a slow swell (1.2 Hz) up to a quicker one (5 Hz), smoothly.
    v.lfo.frequency.setTargetAtTime(1.2 + 3.8 * m, t, 0.25);
    v.level.gain.setTargetAtTime(on ? 0.12 + 0.3 * m : 0, t, on ? 0.12 : 0.3);
    // Direction: further round to the side for bigger corrections.
    const az = side * ((20 + 55 * m) * Math.PI) / 180;
    if (v.panner.positionX) {
      v.panner.positionX.setTargetAtTime(Math.sin(az), t, 0.1);
      v.panner.positionZ.setTargetAtTime(-Math.cos(az), t, 0.1);
    }
    v.boost.pan.setTargetAtTime(Math.sin(az) * 0.7, t, 0.1);
    // Edge warning: opposite ear (the side of the edge you're reaching).
    v.edgePan.pan.setTargetAtTime(-side, t, 0.1);
    v.edgeLevel.gain.setTargetAtTime(g.active ? 0.18 * Math.max(0, Math.min(1, g.edge)) : 0, t, 0.15);
  }

  /**
   * Bluetooth headphones (and Windows' Bluetooth stack) power down the audio
   * link after a moment of digital silence; the next cue then arrives late or
   * clipped. A continuous, inaudible (about -75 dB) noise bed keeps the link
   * awake. Bypasses the master volume so it never becomes audible.
   */
  private startKeepAlive(): void {
    const ctx = this.ctx;
    if (!ctx || !this.keepAlive || !this.keepAliveWanted || this.keepAliveNode) return;
    const n = ctx.createBufferSource();
    n.buffer = this.noise;
    n.loop = true;
    const g = ctx.createGain();
    g.gain.value = 0.00007; // about -83 dB
    n.connect(g).connect(ctx.destination);
    n.start();
    this.keepAliveNode = n;
  }

  /** Guidance running on Bluetooth (true) or not (false): starts / stops the keep-alive. */
  setKeepAliveWanted(on: boolean): void {
    this.keepAliveWanted = on;
    this.setKeepAlive(this.keepAlive);
  }

  setKeepAlive(on: boolean): void {
    this.keepAlive = on;
    if (!on || !this.keepAliveWanted) {
      this.keepAliveNode?.stop();
      this.keepAliveNode = null;
    } else this.startKeepAlive();
  }

  /** Change buffer size (needs a fresh audio context). */
  async setLatencyMode(mode: AudioContextLatencyCategory): Promise<void> {
    if (mode === this.latencyMode) return;
    this.latencyMode = mode;
    if (this.ctx) {
      this.keepAliveNode = null;
      await this.rebuild();
    }
  }

  /**
   * Virtual white cane (depth-based, any obstacle): a smooth sonar tone for
   * the nearest thing in your path. Closer = higher and faster swells
   * (500 Hz / 1 Hz at 3.5 m up to 1100 Hz / 7 Hz at 0.5 m), placed at the
   * obstacle's direction. Head-height hazards - which a real cane misses -
   * add a bright shimmer above. Silent when the path is open.
   */
  setCane(c: { active: boolean; distance: number; azimuth: number; head: boolean }): void {
    const ctx = this.ctx;
    if (!ctx || ctx.state !== 'running') return;
    if (!this.cane || this.cane.ctx !== ctx) {
      if (!c.active) return;
      this.cane = createCane(ctx, this.cueBus, this.reverbIn);
    }
    const v = this.cane;
    const t = ctx.currentTime;
    const k = Math.max(0, Math.min(1, (3.5 - c.distance) / 3));
    v.osc.frequency.setTargetAtTime(500 + 600 * k, t, 0.1);
    v.lfo.frequency.setTargetAtTime(1 + 6 * k, t, 0.15);
    v.level.gain.setTargetAtTime(c.active ? 0.1 + 0.32 * k : 0, t, c.active ? 0.08 : 0.25);
    v.head.gain.setTargetAtTime(c.active && c.head ? 0.12 + 0.15 * k : 0, t, 0.1);
    const az = spreadAzimuth(c.azimuth, this.spread);
    if (v.panner.positionX) {
      v.panner.positionX.setTargetAtTime(Math.sin(az), t, 0.08);
      v.panner.positionY.setTargetAtTime(c.head ? 0.45 : 0, t, 0.08);
      v.panner.positionZ.setTargetAtTime(-Math.cos(az), t, 0.08);
    }
    v.boost.pan.setTargetAtTime(Math.sin(az) * ILD_BOOST, t, 0.08);
  }

  /**
   * Synthetic echolocation: a soft tongue-click from you, then an echo from
   * each surface around you - delayed by its distance (time-stretched x6 so
   * the gaps are easy to hear: 1 m = 35 ms, 3 m = 105 ms), from its
   * direction, fainter and duller when further or smaller. Like an expert
   * human echolocator, you hear the shape of the space.
   */
  echolocate(echoes: { azimuth: number; range: number; strength: number }[]): void {
    const ctx = this.ctx;
    if (!ctx || ctx.state !== 'running') return;
    const t0 = ctx.currentTime + 0.02;
    const click = (dest: AudioNode, t: number, gain: number, bright: number) => {
      const n = ctx.createBufferSource();
      n.buffer = this.noise;
      const hp = ctx.createBiquadFilter();
      hp.type = 'bandpass';
      hp.frequency.value = bright;
      hp.Q.value = 1.2;
      const g = ctx.createGain();
      g.gain.setValueAtTime(0, t);
      g.gain.linearRampToValueAtTime(gain, t + 0.002);
      g.gain.exponentialRampToValueAtTime(0.0001, t + 0.018);
      n.connect(hp).connect(g).connect(dest);
      n.start(t);
      n.stop(t + 0.03);
    };
    click(this.cueBus, t0, 0.35, 3500); // your own click, centred
    for (const e of echoes.slice(0, 10)) {
      const az = spreadAzimuth(e.azimuth, this.spread);
      const p = ctx.createPanner();
      p.panningModel = 'HRTF';
      p.distanceModel = 'linear';
      p.rolloffFactor = 0;
      if (p.positionX) {
        p.positionX.value = Math.sin(az);
        p.positionZ.value = -Math.cos(az);
      }
      const boost = ctx.createStereoPanner();
      boost.pan.value = Math.sin(az) * ILD_BOOST;
      p.connect(boost).connect(this.cueBus);
      const delay = Math.min(0.32, ((2 * e.range) / 343) * 6);
      const gain = Math.min(0.5, (0.12 + 0.6 * e.strength) / Math.max(0.6, e.range) ** 0.8);
      click(p, t0 + 0.03 + delay, gain, Math.max(900, 3200 / (1 + e.range / 3)));
      setTimeout(() => {
        p.disconnect();
        boost.disconnect();
      }, 800);
    }
  }

  /** Load the guide-line system's sound pack for this audio context. */
  async loadPgSounds(base: string): Promise<boolean> {
    const ctx = this.ctx;
    if (!ctx) return false;
    if (this.pg && this.pgCtx === ctx) return this.pg.loaded;
    this.pg = new PgSoundPack(base);
    this.pgCtx = ctx;
    return this.pg.load(ctx, this.cueBus);
  }

  get pgReady(): boolean {
    return !!this.pg?.loaded && this.pgCtx === this.ctx;
  }

  /** Drive the guide-line sounds (+ ear vibration) from a control signal. */
  pgUpdate(s: GuideSignal, rumble: number): void {
    if (this.ctx && this.pgReady) this.pg!.update(this.ctx, s, rumble);
  }

  pgPlay(k: 'stop' | 'ready'): boolean {
    return !!this.ctx && this.pgReady && this.pg!.play(this.ctx, k);
  }

  /**
   * 360-degree guide beacon while running: a soft, bell-like shimmer placed
   * at the point on the line you should run toward (it swings round you as
   * the track bends). Spatialised with HRTF and room sound, so it feels like
   * a place out in front of you, not a beep in your ear.
   */
  setBeacon(b: { active: boolean; azimuth: number; distance: number }): void {
    const ctx = this.ctx;
    if (!ctx || ctx.state !== 'running') return;
    if (!this.beacon || this.beacon.ctx !== ctx) {
      if (!b.active) return;
      this.beacon = createBeacon(ctx, this.sceneBus, this.reverbIn);
    }
    const v = this.beacon;
    const t = ctx.currentTime;
    v.level.gain.setTargetAtTime(b.active ? 0.09 * this.sceneLevel * 2 : 0, t, 0.2);
    const az = Math.max(-Math.PI, Math.min(Math.PI, b.azimuth));
    if (v.panner.positionX) {
      v.panner.positionX.setTargetAtTime(Math.sin(az), t, 0.1);
      v.panner.positionZ.setTargetAtTime(-Math.cos(az), t, 0.1);
    }
    v.boost.pan.setTargetAtTime(Math.sin(az) * 0.5, t, 0.1);
    v.air.frequency.setTargetAtTime(9000 / (1 + b.distance / 8), t, 0.2);
  }

  /**
   * Ground hazard (rock, kerb, leaves): a soft, low double "tock" placed DOWN
   * at the hazard's direction, so it sounds like it is on the ground ahead.
   */
  groundCue(azimuth: number): void {
    const ctx = this.ctx;
    if (!ctx || ctx.state !== 'running') return;
    const p = ctx.createPanner();
    p.panningModel = 'HRTF';
    p.distanceModel = 'linear';
    p.rolloffFactor = 0;
    const az = spreadAzimuth(azimuth, this.spread);
    if (p.positionX) {
      p.positionX.value = Math.sin(az) * 0.8;
      p.positionY.value = -0.6;
      p.positionZ.value = -Math.cos(az) * 0.8;
    }
    p.connect(this.cueBus);
    const t = ctx.currentTime + 0.01;
    for (const [dt, f] of [
      [0, 330],
      [0.16, 262],
    ]) {
      const o = ctx.createOscillator();
      o.frequency.setValueAtTime(f, t + dt);
      o.frequency.exponentialRampToValueAtTime(f * 0.7, t + dt + 0.08);
      const g = ctx.createGain();
      g.gain.setValueAtTime(0, t + dt);
      g.gain.linearRampToValueAtTime(0.45, t + dt + 0.008);
      g.gain.exponentialRampToValueAtTime(0.0001, t + dt + 0.12);
      o.connect(g).connect(p);
      o.start(t + dt);
      o.stop(t + dt + 0.14);
    }
    setTimeout(() => p.disconnect(), 600);
  }

  /** Cadence metronome: a soft centred click at the target steps per minute (0 = off). */
  setMetronome(spm: number): void {
    const ctx = this.ctx;
    if (this.metro) {
      clearInterval(this.metro.timer);
      this.metro = null;
    }
    if (!ctx || !spm) return;
    const period = 60 / spm;
    const m = { timer: 0, next: ctx.currentTime + 0.1, period };
    m.timer = window.setInterval(() => {
      const c = this.ctx;
      if (!c || c.state !== 'running') return;
      while (m.next < c.currentTime + 0.12) {
        const o = c.createOscillator();
        o.frequency.value = 1900;
        const g = c.createGain();
        g.gain.setValueAtTime(0.12, m.next);
        g.gain.exponentialRampToValueAtTime(0.0001, m.next + 0.03);
        o.connect(g).connect(this.master);
        o.start(m.next);
        o.stop(m.next + 0.04);
        m.next += m.period;
      }
      if (m.next < c.currentTime) m.next = c.currentTime + 0.05;
    }, 25);
    this.metro = m;
  }

  private pingChain(side: 'left' | 'right'): AudioNode {
    const ctx = this.ctx!;
    if (!this.pingChains || this.pingChains.ctx !== ctx) {
      const make = (sign: number) => {
        const az = sign * ((70 * Math.PI) / 180);
        const p = ctx.createPanner();
        p.panningModel = 'HRTF';
        p.distanceModel = 'linear';
        p.rolloffFactor = 0;
        if (p.positionX) {
          p.positionX.value = Math.sin(az);
          p.positionZ.value = -Math.cos(az);
        }
        const boost = ctx.createStereoPanner();
        boost.pan.value = sign * 0.75;
        const input = ctx.createGain();
        input.connect(p).connect(boost).connect(this.master);
        return input;
      };
      this.pingChains = { ctx, left: make(-1), right: make(1) };
    }
    return this.pingChains[side];
  }

  /** Play one example of a cue sound, for learning the sound palette. */
  preview(kind: CueSource['kind'], side: 'left' | 'center' | 'right' = 'center', urgency = 0.4): Promise<void> {
    if (!this.ctx) return Promise.resolve();
    const ctx = this.ctx;
    const pan = ctx.createStereoPanner();
    pan.pan.value = side === 'left' ? -1 : side === 'right' ? 1 : 0;
    pan.connect(this.master);
    const t0 = ctx.currentTime + 0.05;
    const period = 0.35;
    const p = { urgency, style: this.style, period, secondTone: urgency > 0.6 };
    for (let i = 0; i < 4; i++) {
      const t = t0 + i * period;
      if (kind === 'person') personPulse(ctx, pan, t, p);
      else if (kind === 'vehicle') vehiclePulse(ctx, pan, t, p);
      else if (kind === 'static') staticPulse(ctx, pan, t, p, this.noise);
      else if (kind === 'guide') guidePulse(ctx, pan, t);
      else if (kind === 'looming') loomPulse(ctx, pan, t, p, this.noise);
    }
    if (kind === 'blocked' || kind === 'guide') {
      const buzz = createBuzz(ctx, pan);
      for (let i = 0; i < 6; i++) {
        const t = t0 + i * 0.22;
        buzz.gate.gain.setValueAtTime(0, t);
        buzz.gate.gain.linearRampToValueAtTime(1, t + 0.006);
        buzz.gate.gain.setValueAtTime(1, t + 0.12);
        buzz.gate.gain.linearRampToValueAtTime(0, t + 0.13);
      }
      buzz.stop(t0 + 1.4);
    }
    return new Promise((r) => setTimeout(() => {
      pan.disconnect();
      r();
    }, 1600));
  }

  /** Headphone check: a tone hard-panned to one ear. Resolves when it ends. */
  testTone(side: 'left' | 'right'): Promise<void> {
    if (!this.ctx) return Promise.resolve();
    const ctx = this.ctx;
    const t = ctx.currentTime + 0.05;
    const pan = ctx.createStereoPanner();
    pan.pan.value = side === 'left' ? -1 : 1;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(0.5, t + 0.03);
    g.gain.setValueAtTime(0.5, t + 0.8);
    g.gain.linearRampToValueAtTime(0, t + 0.85);
    const o = ctx.createOscillator();
    o.frequency.value = 600;
    o.connect(g).connect(pan).connect(this.master);
    o.start(t);
    o.stop(t + 0.9);
    return new Promise((r) => {
      o.onended = () => r();
      setTimeout(r, 1500); // never hang if audio is suspended
    });
  }

  /**
   * Spatial check for headphones (wired or Bluetooth): a "person" cue travels
   * from your far left, through straight ahead, to your far right and back.
   * Uses the same HRTF path as live cues in spatial mode.
   */
  spatialTest(durationS = 5): Promise<void> {
    if (!this.ctx) return Promise.resolve();
    const ctx = this.ctx;
    const t0 = ctx.currentTime + 0.1;
    const p = ctx.createPanner();
    p.panningModel = 'HRTF';
    p.distanceModel = 'linear';
    p.rolloffFactor = 0;
    const out = ctx.createGain();
    out.gain.value = 0.8;
    const boost = ctx.createStereoPanner();
    out.connect(p).connect(boost).connect(this.master);
    const send = ctx.createGain();
    send.gain.value = 0.25;
    boost.connect(send).connect(this.reverbIn);
    const steps = 60;
    for (let i = 0; i <= steps; i++) {
      const f = i / steps;
      // A full circle around your head: ahead -> right -> behind -> left -> ahead.
      const az = 2 * Math.PI * f;
      const t = t0 + f * durationS;
      if (p.positionX) {
        const method = i === 0 ? 'setValueAtTime' : 'linearRampToValueAtTime';
        p.positionX[method](Math.sin(az), t);
        p.positionZ[method](-Math.cos(az), t);
      }
      boost.pan[i === 0 ? 'setValueAtTime' : 'linearRampToValueAtTime'](Math.sin(az) * ILD_BOOST, t);
    }
    for (let t = 0; t < durationS; t += 0.3) {
      personPulse(ctx, out, t0 + t, { urgency: 0.3, style: this.style, period: 0.3 });
    }
    return new Promise((r) =>
      setTimeout(() => {
        out.disconnect();
        p.disconnect();
        boost.disconnect();
        r();
      }, (durationS + 0.4) * 1000),
    );
  }

  /**
   * Sync voices to the current cue sources. Returns, for sources that were
   * just triggered, the audio-clock time their first sound is scheduled at.
   */
  update(sources: CueSource[]): Map<string, number> {
    const started = new Map<string, number>();
    if (!this.ctx) return started;
    const now = this.ctx.currentTime;
    const keep = new Set(sources.map((s) => s.key));
    for (const [key, v] of this.voices) if (!keep.has(key)) this.release(key, v);

    for (const s of sources) {
      let v = this.voices.get(s.key);
      if (!v) {
        v = this.createVoice(s);
        this.voices.set(s.key, v);
      }
      v.src = s;
      this.position(v, false);
      v.out.gain.setTargetAtTime(0.35 + 0.65 * s.urgency, now, SMOOTH_S);
      if (s.triggered && v.nextPulse > now + 0.03) v.nextPulse = now + 0.005;
      if (s.triggered) started.set(s.key, Math.max(v.nextPulse, now));
    }
    this.schedule();
    return started;
  }

  /** Stop every cue voice (pause, stop, mode change). Earcons are unaffected. */
  silence(): void {
    for (const [key, v] of this.voices) this.release(key, v);
    if (this.ctx) for (const [k, p] of this.presences) this.releasePresence(k, p);
  }

  private createVoice(s: CueSource): Voice {
    const ctx = this.ctx!;
    const out = ctx.createGain();
    out.gain.value = 0.35 + 0.65 * s.urgency;
    let panner: Panner;
    if (s.kind === 'blocked' || s.kind === 'guide' || this.mode === 'stereo') {
      panner = ctx.createStereoPanner();
    } else {
      const p = ctx.createPanner();
      p.panningModel = 'HRTF';
      p.distanceModel = 'linear';
      p.rolloffFactor = 0; // loudness is driven by our own distance estimate
      panner = p;
    }
    const v: Voice = { src: s, out, panner, nextPulse: ctx.currentTime + 0.005, gateOpen: false };
    if (panner instanceof PannerNode) {
      // out -> air (distance darkening) -> HRTF -> boost (stronger left/right) -> bus.
      // HRTF alone is subtle on many Bluetooth earbuds; the boost keeps the
      // 3D colour but makes the side unmistakable.
      v.air = ctx.createBiquadFilter();
      v.air.type = 'lowpass';
      v.boost = ctx.createStereoPanner();
      out.connect(v.air).connect(panner).connect(v.boost).connect(this.cueBus);
      v.send = ctx.createGain();
      v.send.gain.value = 0.15;
      v.boost.connect(v.send).connect(this.reverbIn);
    } else {
      out.connect(panner).connect(this.cueBus);
      v.send = ctx.createGain();
      v.send.gain.value = 0.06;
      panner.connect(v.send).connect(this.reverbIn);
    }
    if (s.kind === 'blocked' || s.kind === 'guide') v.buzz = createBuzz(ctx, out);
    this.position(v, true);
    return v;
  }

  private position(v: Voice, immediate: boolean): void {
    const ctx = this.ctx!;
    const s = v.src;
    const t = ctx.currentTime;
    const set = (param: AudioParam, value: number) =>
      immediate ? param.setValueAtTime(value, t) : param.setTargetAtTime(value, t, SMOOTH_S);
    if (v.panner instanceof StereoPannerNode) {
      let pan = zonePan(s.zone);
      if (s.kind === 'guide') {
        pan = s.zone === 'left' ? -1 : s.zone === 'right' ? 1 : 0;
      } else if (s.kind === 'blocked') {
        // Directional steer buzz: if zone is left/right, hard-pan to that ear only so the opposite ear is silent!
        pan = s.zone === 'left' ? -1 : s.zone === 'right' ? 1 : 0;
      }
      set(v.panner.pan, pan);
      return;
    }
    // Unit circle around the listener; -z is straight ahead. Widen the
    // camera's narrow field of view so left/right is unmistakable.
    const az = spreadAzimuth(s.azimuth, this.spread);
    const el = s.elevation ?? 0;
    const x = Math.sin(az) * Math.cos(el);
    const y = Math.sin(el);
    const z = -Math.cos(az) * Math.cos(el);
    const p = v.panner;
    if (p.positionX) {
      set(p.positionX, x);
      set(p.positionY, y);
      set(p.positionZ, z);
    } else {
      (p as unknown as { setPosition(x: number, y: number, z: number): void }).setPosition(x, y, z);
    }
    // Far = more room sound (it seems further away), near = dry and close.
    if (v.send) set(v.send.gain, 0.08 + 0.35 * (1 - s.urgency));
    if (v.boost) set(v.boost.pan, Math.sin(az) * ILD_BOOST);
    // Air absorption: far sounds are duller, near ones bright (another distance cue).
    if (v.air) set(v.air.frequency, 3500 + 14000 * s.urgency);
  }

  private schedule(): void {
    const ctx = this.ctx;
    if (!ctx || ctx.state !== 'running') return;
    const now = ctx.currentTime;
    for (const v of this.voices.values()) {
      const s = v.src;
      if (v.buzz && s.continuous) {
        if (!v.gateOpen) {
          v.buzz.gate.gain.cancelScheduledValues(now);
          v.buzz.gate.gain.setTargetAtTime(1, now, 0.01);
          v.gateOpen = true;
        }
        v.nextPulse = now + 0.05;
        continue;
      }
      if (v.buzz && v.gateOpen) {
        v.buzz.gate.gain.cancelScheduledValues(now);
        v.buzz.gate.gain.setTargetAtTime(0, now, 0.01);
        v.gateOpen = false;
      }
      if (v.nextPulse < now) v.nextPulse = now + 0.005;
      const period = 1 / Math.max(0.2, s.rateHz);
      while (v.nextPulse < now + LOOKAHEAD_S) {
        this.pulse(v, v.nextPulse, period);
        v.nextPulse += period;
      }
    }
  }

  private pulse(v: Voice, t: number, period: number): void {
    const ctx = this.ctx!;
    const s = v.src;
    const p = { urgency: s.urgency, style: this.style, secondTone: s.secondTone, period };
    switch (s.kind) {
      case 'person':
        return personPulse(ctx, v.out, t, p);
      case 'vehicle':
        return vehiclePulse(ctx, v.out, t, p);
      case 'static':
        return staticPulse(ctx, v.out, t, p, this.noise);
      case 'guide':
        return guidePulse(ctx, v.out, t);
      case 'looming':
        return loomPulse(ctx, v.out, t, p, this.noise);
      case 'blocked': {
        const g = v.buzz!.gate.gain;
        const on = Math.min(0.14, period * 0.5);
        // Rounded on/off (20 ms ramps): a buzz, but not a harsh click.
        g.setValueAtTime(0, t);
        g.linearRampToValueAtTime(1, t + 0.02);
        g.setValueAtTime(1, t + on);
        g.linearRampToValueAtTime(0, t + on + 0.03);
        return;
      }
    }
  }

  private release(key: string, v: Voice): void {
    this.voices.delete(key);
    const ctx = this.ctx!;
    const t = ctx.currentTime;
    v.out.gain.cancelScheduledValues(t);
    v.out.gain.setTargetAtTime(0, t, 0.03);
    v.buzz?.stop(t + 0.3);
    setTimeout(() => {
      v.out.disconnect();
      v.panner.disconnect();
      v.boost?.disconnect();
      v.air?.disconnect();
      v.send?.disconnect();
    }, 600);
  }
}

interface Presence {
  kind: SceneObject['kind'];
  level: GainNode;
  air: BiquadFilterNode;
  panner: PannerNode;
  boost: StereoPannerNode;
  send: GainNode;
  sources: AudioScheduledSourceNode[];
  nodes: AudioNode[];
}

/**
 * Continuous textures, one per category, quiet and non-beeping:
 *   person  - soft breathy air with a faint singing tone (living, gently moving)
 *   vehicle - low engine hum with a slow wobble
 *   static  - a ringing wooden resonance, gently pulsing
 */
function createPresence(
  ctx: AudioContext,
  kind: SceneObject['kind'],
  noise: AudioBuffer,
  bus: AudioNode,
  reverb: AudioNode,
): Presence {
  const level = ctx.createGain();
  level.gain.value = 0;
  const air = ctx.createBiquadFilter();
  air.type = 'lowpass';
  const panner = ctx.createPanner();
  panner.panningModel = 'HRTF';
  panner.distanceModel = 'linear';
  panner.rolloffFactor = 0;
  const boost = ctx.createStereoPanner();
  const send = ctx.createGain();
  level.connect(air).connect(panner).connect(boost).connect(bus);
  boost.connect(send).connect(reverb);
  const sources: AudioScheduledSourceNode[] = [];
  const nodes: AudioNode[] = [level, air, panner, boost, send];
  const am = ctx.createGain();
  am.connect(level);
  nodes.push(am);
  const lfo = (rate: number, depth: number, target: AudioParam, base: number) => {
    target.value = base;
    const o = ctx.createOscillator();
    o.frequency.value = rate;
    const d = ctx.createGain();
    d.gain.value = depth;
    o.connect(d).connect(target);
    o.start();
    sources.push(o);
    nodes.push(o, d);
  };
  const noiseSrc = () => {
    const n = ctx.createBufferSource();
    n.buffer = noise;
    n.loop = true;
    n.start();
    sources.push(n);
    nodes.push(n);
    return n;
  };
  if (kind === 'person') {
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = 1100;
    bp.Q.value = 1.5;
    noiseSrc().connect(bp).connect(am);
    const tone = ctx.createOscillator();
    tone.frequency.value = 523;
    const tg = ctx.createGain();
    tg.gain.value = 0.12;
    tone.connect(tg).connect(am);
    tone.start();
    sources.push(tone);
    nodes.push(bp, tone, tg);
    lfo(0.6, 0.35, am.gain, 0.55);
    lfo(5, 4, tone.frequency, 523);
  } else if (kind === 'vehicle') {
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 380;
    for (const f of [65, 66.3]) {
      const o = ctx.createOscillator();
      o.type = 'sawtooth';
      o.frequency.value = f;
      o.connect(lp);
      o.start();
      sources.push(o);
      nodes.push(o);
    }
    lp.connect(am);
    nodes.push(lp);
    lfo(0.25, 0.25, am.gain, 0.7);
  } else {
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = 1800;
    bp.Q.value = 10;
    noiseSrc().connect(bp).connect(am);
    nodes.push(bp);
    lfo(1.1, 0.5, am.gain, 0.6);
  }
  return { kind, level, air, panner, boost, send, sources, nodes };
}

interface GlideVoice {
  ctx: AudioContext;
  osc: OscillatorNode;
  osc2: OscillatorNode;
  lfo: OscillatorNode;
  level: GainNode;
  panner: PannerNode;
  boost: StereoPannerNode;
  edgeLevel: GainNode;
  edgePan: StereoPannerNode;
}

function createGlide(ctx: AudioContext, master: AudioNode, reverb: AudioNode): GlideVoice {
  const osc = ctx.createOscillator();
  const osc2 = ctx.createOscillator();
  const h2 = ctx.createGain();
  h2.gain.value = 0.18; // a soft octave for warmth
  // Smooth pulse: amplitude = 0.5 + 0.5*sin(lfo) -> swells, never clicks.
  const am = ctx.createGain();
  am.gain.value = 0.5;
  const lfo = ctx.createOscillator();
  lfo.frequency.value = 1.2;
  const depth = ctx.createGain();
  depth.gain.value = 0.5;
  lfo.connect(depth).connect(am.gain);
  const level = ctx.createGain();
  level.gain.value = 0;
  const panner = ctx.createPanner();
  panner.panningModel = 'HRTF';
  panner.distanceModel = 'linear';
  panner.rolloffFactor = 0;
  const boost = ctx.createStereoPanner();
  osc.connect(am);
  osc2.connect(h2).connect(am);
  am.connect(level).connect(panner).connect(boost).connect(master);
  const send = ctx.createGain();
  send.gain.value = 0.12;
  boost.connect(send).connect(reverb);
  // Edge warning: a soft high tone with a gentle tremolo.
  const edge = ctx.createOscillator();
  edge.frequency.value = 1760;
  const edgeAm = ctx.createGain();
  edgeAm.gain.value = 0.5;
  const edgeLfo = ctx.createOscillator();
  edgeLfo.frequency.value = 7;
  const edgeDepth = ctx.createGain();
  edgeDepth.gain.value = 0.5;
  edgeLfo.connect(edgeDepth).connect(edgeAm.gain);
  const edgeLevel = ctx.createGain();
  edgeLevel.gain.value = 0;
  const edgePan = ctx.createStereoPanner();
  edge.connect(edgeAm).connect(edgeLevel).connect(edgePan).connect(master);
  for (const o of [osc, osc2, lfo, edge, edgeLfo]) o.start();
  return { ctx, osc, osc2, lfo, level, panner, boost, edgeLevel, edgePan };
}

interface CaneVoice {
  ctx: AudioContext;
  osc: OscillatorNode;
  lfo: OscillatorNode;
  level: GainNode;
  head: GainNode;
  panner: PannerNode;
  boost: StereoPannerNode;
}

function createCane(ctx: AudioContext, bus: AudioNode, reverb: AudioNode): CaneVoice {
  const osc = ctx.createOscillator();
  osc.type = 'triangle';
  const am = ctx.createGain();
  am.gain.value = 0.5;
  const lfo = ctx.createOscillator();
  lfo.frequency.value = 1;
  const depth = ctx.createGain();
  depth.gain.value = 0.5;
  lfo.connect(depth).connect(am.gain);
  const level = ctx.createGain();
  level.gain.value = 0;
  const panner = ctx.createPanner();
  panner.panningModel = 'HRTF';
  panner.distanceModel = 'linear';
  panner.rolloffFactor = 0;
  const boost = ctx.createStereoPanner();
  osc.connect(am).connect(level).connect(panner).connect(boost).connect(bus);
  const send = ctx.createGain();
  send.gain.value = 0.1;
  boost.connect(send).connect(reverb);
  // Head-height shimmer: a bright, slightly detuned pair.
  const head = ctx.createGain();
  head.gain.value = 0;
  for (const f of [1568, 1580]) {
    const o = ctx.createOscillator();
    o.frequency.value = f;
    o.connect(head);
    o.start();
  }
  head.connect(am);
  osc.start();
  lfo.start();
  return { ctx, osc, lfo, level, head, panner, boost };
}

export type OutputKind = 'bt-stereo' | 'bt-handsfree' | 'headphones' | 'speakers' | 'unknown';

/**
 * What kind of output a device label is. Windows lists each Bluetooth
 * headset twice: "Headphones (X)" (stereo, A2DP) and "Headset (X Hands-Free)"
 * (mono, call mode - no spatial audio possible).
 */
export function classifyOutput(label: string): OutputKind {
  const l = label.toLowerCase();
  if (/hands-?free|headset|communications/.test(l)) return 'bt-handsfree';
  if (/bluetooth|airpods|buds|wh-|wf-|ult wear|bose|jabra|beats|soundcore/.test(l)) return 'bt-stereo';
  if (/headphone|earphone|earbud/.test(l)) return 'headphones';
  if (/speaker|realtek|internal|built-in|laptop/.test(l)) return 'speakers';
  return 'unknown';
}

interface BeaconVoice {
  ctx: AudioContext;
  level: GainNode;
  air: BiquadFilterNode;
  panner: PannerNode;
  boost: StereoPannerNode;
}

function createBeacon(ctx: AudioContext, bus: AudioNode, reverb: AudioNode): BeaconVoice {
  const level = ctx.createGain();
  level.gain.value = 0;
  const am = ctx.createGain();
  am.gain.value = 0.5;
  const lfo = ctx.createOscillator();
  lfo.frequency.value = 1.6;
  const depth = ctx.createGain();
  depth.gain.value = 0.5;
  lfo.connect(depth).connect(am.gain);
  for (const [f, g] of [
    [880, 0.5],
    [1320, 0.25],
    [1760, 0.12],
  ]) {
    const o = ctx.createOscillator();
    o.frequency.value = f;
    const og = ctx.createGain();
    og.gain.value = g;
    o.connect(og).connect(am);
    o.start();
  }
  lfo.start();
  const air = ctx.createBiquadFilter();
  air.type = 'lowpass';
  const panner = ctx.createPanner();
  panner.panningModel = 'HRTF';
  panner.distanceModel = 'linear';
  panner.rolloffFactor = 0;
  const boost = ctx.createStereoPanner();
  am.connect(level).connect(air).connect(panner).connect(boost).connect(bus);
  const send = ctx.createGain();
  send.gain.value = 0.3;
  boost.connect(send).connect(reverb);
  return { ctx, level, air, panner, boost };
}
