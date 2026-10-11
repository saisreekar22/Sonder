import type { AudioEngine } from '../audio/engine';
import type { FrameSource } from '../camera/source';
import { isWorn, sensitivityParams, type Settings } from '../core/settings';
import type { Detection, FrameSize } from '../core/types';
import { CuePolicy, type PolicyOutput } from '../cues/policy';
import type { DetectionClient } from '../detect/client';
import { applyEgoMotion, describeScene } from '../perception/egomotion';
import { focalPx } from '../perception/geometry';
import { frameQuality, LoomingDetector, toGray, type FrameQuality } from '../perception/imageStats';
import { Tracker, type Track } from '../perception/tracker';
import { filterDetections } from '../perception/zones';
import { QualityGovernor, qualityLadder } from '../perf/governor';
import { Metrics } from '../perf/metrics';
import type { Announcer } from '../speech/announcer';
import { WarningPolicy } from '../speech/warnings';
import type { MotionSensor, MotionSnapshot } from '../sensors/motion';

export interface FrameReport {
  frame: FrameSize;
  detections: Detection[];
  tracks: readonly Track[];
  policy: PolicyOutput;
  looming: boolean;
  quality: FrameQuality;
  motion: MotionSnapshot | null;
  stats: ReturnType<Metrics['snapshot']> & { backend: string; where: string; inputWidth: number; model: string };
}

export interface CueLogEntry {
  t: number;
  type: 'cue' | 'speech' | 'system';
  kind?: string;
  label?: string;
  zone?: string;
  distance?: number;
  ttc?: number;
  text?: string;
  latencyMs?: number;
}

const WATCHDOG_MS = 1000;
const FAIL_REPEAT_MS = 4000;
const QUALITY_HOLD_MS = 2000;
const QUALITY_REPEAT_MS = 20000;
const THUMB_W = 64;
const HEARTBEAT_MS = 6000;
const TILT_HOLD_MS = 3000;
const TILT_REPEAT_MS = 30000;
/** Acceptable camera elevation for a body mount (degrees). */
const TILT_DOWN_LIMIT = -35;
const TILT_UP_LIMIT = 30;

/**
 * One walking session: frames flow camera -> detector (worker) -> tracker ->
 * cue policy -> audio engine, plus the spoken-warning branch (V2).
 * Fails loudly: camera loss, stalls and detector errors all play the warning
 * earcon within about a second instead of going silent.
 */
export class Session {
  state: 'idle' | 'running' | 'paused' = 'idle';
  onFrame: ((r: FrameReport) => void) | null = null;
  readonly log: CueLogEntry[] = [];
  readonly metrics = new Metrics();
  /**
   * Flip left/right. True when the camera faces the listener (laptop webcam):
   * what is on the camera's left is on the listener's right.
   */
  mirror = false;

  private source: FrameSource | null = null;
  private tracker = new Tracker();
  private policy = new CuePolicy();
  private warnings = new WarningPolicy();
  private looming = new LoomingDetector();
  private governor: QualityGovernor;
  private grab: OffscreenCanvas | HTMLCanvasElement;
  private thumb: HTMLCanvasElement;
  private startedAt = 0;
  private lastFrameDone = 0;
  private lastFail = -Infinity;
  private consecutiveErrors = 0;
  private watchdog: number | undefined;
  private frameCount = 0;
  private loadingModel = false;
  private quality: FrameQuality = 'ok';
  private badSince: number | null = null;
  private lastQualityWarn = -Infinity;
  private loopToken = 0;
  private lastSoundAt = 0;
  private lastTracks: readonly Track[] = [];
  private tiltBadSince: number | null = null;
  private lastTiltWarn = -Infinity;
  private walkingAnnounced = false;
  private lastVibrateAt = 0;

  constructor(
    private settings: Settings,
    private readonly audio: AudioEngine,
    private readonly announcer: Announcer,
    private readonly detector: DetectionClient,
    private readonly motion: MotionSensor | null = null,
  ) {
    this.governor = new QualityGovernor(qualityLadder(settings.model));
    this.grab = typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(640, 360) : document.createElement('canvas');
    this.thumb = document.createElement('canvas');
  }

  get currentSource(): FrameSource | null {
    return this.source;
  }

  async ensureModel(): Promise<void> {
    const want = this.governor.level.model;
    if (this.detector.model === want) return;
    this.loadingModel = true;
    try {
      await this.detector.load(want);
    } finally {
      this.loadingModel = false;
    }
  }

  /**
   * Distance calibration: with one person standing `metres` away straight
   * ahead, solve for the camera's field of view from their box height
   * (f = d * h_px / 1.7 m). Returns the new field of view, or null.
   */
  calibrateFov(metres: number): number | null {
    const p = this.lastTracks
      .filter((t) => t.confirmed && t.label === 'person' && t.box.y > 0.01 && t.box.y + t.box.h < 0.99)
      .sort((a, b) => b.box.h - a.box.h)[0];
    const v = this.source?.video;
    if (!p || !v || !v.videoWidth) return null;
    const hPx = p.box.h * v.videoHeight;
    const f = (metres * hPx) / 1.7;
    const long = Math.max(v.videoWidth, v.videoHeight);
    const fov = (2 * Math.atan(long / 2 / f) * 180) / Math.PI;
    return fov > 30 && fov < 120 ? Math.round(fov) : null;
  }

  /** "What's around me?" — spoken on demand (gesture, button, or headphone button). */
  describe(): string {
    return describeScene(this.lastTracks);
  }

  async start(source: FrameSource): Promise<void> {
    this.attach(source);
    this.lastSoundAt = performance.now();
    this.lastTracks = [];
    this.tracker.reset();
    this.policy.reset();
    this.warnings.reset();
    this.looming.reset();
    this.startedAt = performance.now();
    this.lastFrameDone = performance.now();
    this.state = 'running';
    this.logSystem('start');
    clearInterval(this.watchdog);
    this.watchdog = window.setInterval(() => this.checkHealth(), 250);
    this.loop();
  }

  /** Swap to another camera without stopping the session. */
  setSource(source: FrameSource): void {
    this.source?.stop();
    this.attach(source);
    this.tracker.reset();
    this.policy.reset();
    this.looming.reset();
    this.lastFrameDone = performance.now();
  }

  private attach(source: FrameSource): void {
    this.source = source;
    source.onLost = (why) => this.fail(`Camera ${why === 'muted' ? 'paused' : 'stopped'}. Detection is off.`);
  }

  stop(): void {
    this.state = 'idle';
    this.loopToken++;
    clearInterval(this.watchdog);
    this.audio.silence();
    this.source?.stop();
    this.source = null;
    this.logSystem('stop');
  }

  pause(): void {
    if (this.state !== 'running') return;
    this.state = 'paused';
    this.loopToken++;
    this.audio.silence();
    this.announcer.cancel();
    this.logSystem('pause');
  }

  resume(): void {
    if (this.state !== 'paused') return;
    this.state = 'running';
    this.tracker.reset();
    this.policy.reset();
    this.lastFrameDone = performance.now();
    this.logSystem('resume');
    this.loop();
  }

  applySettings(s: Settings): void {
    const modelChanged = s.model !== this.settings.model;
    this.settings = s;
    if (modelChanged) {
      this.governor.reset(qualityLadder(s.model));
      void this.ensureModel().catch((e) => this.fail(`Could not load the detection model. ${e}`));
    }
    if (!s.looming) this.looming.reset();
  }

  /** Fail loudly: warning earcon + spoken reason, rate-limited. */
  fail(message: string): void {
    const now = performance.now();
    if (now - this.lastFail < FAIL_REPEAT_MS) return;
    this.lastFail = now;
    this.audio.silence();
    this.audio.earcon('warning');
    this.announcer.say(message, { interrupt: true });
    this.logSystem(message);
  }

  private logSystem(text: string): void {
    this.log.push({ t: Math.round(performance.now() - this.startedAt), type: 'system', text });
  }

  private checkHealth(): void {
    if (this.state !== 'running' || document.hidden) return;
    const now = performance.now();
    if (this.loadingModel) {
      this.lastFrameDone = now;
      return;
    }
    if (now - this.lastFrameDone > WATCHDOG_MS) this.fail('Detection has stopped responding.');
    if (this.audio.ctx && this.audio.ctx.state !== 'running') void this.audio.ctx.resume().catch(() => {});
  }

  private loop(): void {
    const token = ++this.loopToken;
    const next = () => {
      if (token !== this.loopToken || this.state !== 'running') return;
      // Prefer waiting for a fresh video frame, but don't depend on it: the
      // callback is tied to page rendering and can be throttled.
      let fired = false;
      const go = () => {
        if (fired) return;
        fired = true;
        void step();
      };
      const v = this.source?.video;
      if (v && 'requestVideoFrameCallback' in v) v.requestVideoFrameCallback(go);
      setTimeout(go, 25);
    };
    const step = async () => {
      if (token !== this.loopToken || this.state !== 'running') return;
      try {
        await this.processFrame();
        this.consecutiveErrors = 0;
      } catch (e) {
        this.consecutiveErrors++;
        console.warn('[EchoPath] frame failed', e);
        if (this.consecutiveErrors >= 3) this.fail('Detection error. Trying again.');
      }
      next();
    };
    next();
  }

  private async processFrame(): Promise<void> {
    const video = this.source?.video;
    if (!video || video.videoWidth === 0 || this.loadingModel) return;
    const s = this.settings;
    const level = this.governor.level;
    if (this.detector.model !== level.model) {
      await this.ensureModel();
      return;
    }

    // --- Capture & resize -----------------------------------------------------
    const captureT = performance.now();
    const vw = video.videoWidth, vh = video.videoHeight;
    const scale = Math.min(1, level.inputWidth / Math.max(vw, vh));
    const w = Math.round(vw * scale), h = Math.round(vh * scale);
    if (this.grab.width !== w || this.grab.height !== h) {
      this.grab.width = w;
      this.grab.height = h;
    }
    const g = this.grab.getContext('2d') as CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;
    g.drawImage(video, 0, 0, w, h);
    const bitmap =
      this.grab instanceof HTMLCanvasElement ? await createImageBitmap(this.grab) : this.grab.transferToImageBitmap();

    // Thumbnail for light/blur and looming checks (cheap: 64 px wide).
    this.frameCount++;
    let looming = false;
    if (s.looming || this.frameCount % 10 === 0) {
      const tw = THUMB_W, th = Math.max(1, Math.round((THUMB_W * vh) / vw));
      this.thumb.width = tw;
      this.thumb.height = th;
      const tc = this.thumb.getContext('2d', { willReadFrequently: true })!;
      tc.drawImage(video, 0, 0, tw, th);
      const gray = toGray(tc.getImageData(0, 0, tw, th).data, tw, th);
      if (this.frameCount % 10 === 0) this.updateQuality(frameQuality(gray), captureT);
      if (s.looming) looming = this.looming.update(gray, captureT);
    }

    // --- Inference (worker) ---------------------------------------------------
    const out = await this.detector.detect(bitmap, captureT);
    if (this.state !== 'running') return;
    const inferenceMs = out.inferenceMs;
    const detections = this.mirror
      ? out.detections.map((d) => ({ ...d, box: { ...d.box, x: 1 - d.box.x - d.box.w } }))
      : out.detections;

    // --- Tracking & cue logic -------------------------------------------------
    const frame = { width: vw, height: vh };
    const sens = sensitivityParams(s.sensitivity);
    const kept = filterDetections(detections, {
      corridorWidth: s.corridorWidth,
      centerWidth: s.centerWidth,
      minScore: sens.minScore,
      minHeight: sens.minHeight,
    });
    const tracks = this.tracker.update(kept, captureT, {
      frame,
      focal: focalPx(frame, s.fovDeg),
      corridorWidth: s.corridorWidth,
      centerWidth: s.centerWidth,
    });
    const motion = this.motion?.available ? this.motion.snapshot() : null;
    if (motion) {
      applyEgoMotion(tracks, motion.walking, motion.speed);
      this.checkTilt(motion.elevation, captureT);
    }
    this.lastTracks = tracks;
    const policy = this.policy.update(
      tracks,
      captureT,
      { centerWidth: s.centerWidth, blockDistance: s.blockDistance, maxSources: 3, density: s.cueDensity },
      looming,
    );

    // --- Audio ----------------------------------------------------------------
    const started = this.audio.update(policy.sources);
    const now = performance.now();
    // Heartbeat: a barely-audible tick when nothing has sounded for a while,
    // so the wearer can tell "nothing detected" from "app stopped".
    if (policy.sources.length > 0) this.lastSoundAt = now;
    else if (s.heartbeat && now - this.lastSoundAt > HEARTBEAT_MS) {
      this.audio.earcon('tick');
      this.lastSoundAt = now;
    }
    const ctxNow = this.audio.ctx?.currentTime ?? 0;
    for (const src of policy.sources) {
      if (!src.triggered) continue;
      const at = started.get(src.key);
      const latencyMs =
        at !== undefined ? now - captureT + Math.max(0, at - ctxNow) * 1000 + this.audio.outputLatencyMs : undefined;
      if (latencyMs !== undefined) this.metrics.captureToSoundMs.push(latencyMs);
      this.log.push({
        t: Math.round(captureT - this.startedAt),
        type: 'cue',
        kind: src.kind,
        label: src.label,
        zone: src.zone,
        distance: Number(src.distance.toFixed(2)),
        latencyMs: latencyMs !== undefined ? Math.round(latencyMs) : undefined,
      });
    }

    // --- Directional haptics & audio cues for blind runner obstacle guidance ---
    if (policy.blocked && policy.guideSide) {
      if (now - this.lastVibrateAt > 500) {
        this.lastVibrateAt = now;
        if (typeof navigator !== 'undefined' && navigator.vibrate) {
          // Double buzz for right, long buzz for left
          navigator.vibrate(policy.guideSide === 'right' ? [60, 40, 60] : [120]);
        }
      }
    }

    // --- Spoken warnings silenced for runner guidance ---
    // The user explicitly requested removing the voice saying object detected
    // because the model was detecting every small object and producing constant noise.
    // Guidance is provided via directional buzz (in the ear to move towards) and vibration.

    // --- Metrics & adaptation -------------------------------------------------
    this.lastFrameDone = now;
    this.metrics.fps.tick(now);
    this.metrics.inferenceMs.push(inferenceMs);
    this.metrics.pipelineMs.push(now - captureT);
    const fps = this.metrics.fps.fps(now);
    // Accurate model too slow on this device? Go straight to the fast one
    // rather than stepping down resolution first (Lite2's input size is fixed).
    if (
      level.model === 'efficientdet_lite2' &&
      this.metrics.inferenceMs.count >= 15 &&
      this.metrics.inferenceMs.percentile(50) > 90
    ) {
      this.governor.jumpTo('efficientdet_lite0');
      this.metrics.inferenceMs.clear();
      this.logSystem('accurate model too slow here: switched to the fast model');
    }
    if (fps > 0 && now - this.startedAt > 4000) {
      const ev = this.governor.update(fps, now);
      if (ev?.kind === 'down') {
        this.logSystem(`quality down: ${ev.level.model} @ ${ev.level.inputWidth}px`);
        if (ev.firstDown) {
          this.audio.earcon('lowFps');
          this.announcer.say('Phone is running slowly. Reducing detail to keep up.');
        }
      } else if (ev?.kind === 'up') {
        this.logSystem(`quality up: ${ev.level.model} @ ${ev.level.inputWidth}px`);
      }
    }

    this.onFrame?.({
      frame,
      detections: kept,
      tracks,
      policy,
      looming,
      quality: this.quality,
      motion,
      stats: {
        ...this.metrics.snapshot(now),
        backend: this.detector.backend,
        where: this.detector.where,
        inputWidth: level.inputWidth,
        model: level.model,
      },
    });
  }

  /**
   * Body-mount tilt guidance: a chest or waist mount that droops toward the
   * floor (or points at the sky) misses obstacles. Warn after 3 s, then at
   * most every 30 s. Also announces once when walking is first detected.
   */
  private checkTilt(elevation: number, now: number): void {
    if (!isWorn(this.settings.mount) || !Number.isFinite(elevation)) return;
    const m = this.motion?.snapshot(now);
    if (m?.walking && !this.walkingAnnounced) {
      this.walkingAnnounced = true;
      this.logSystem('walking detected');
    }
    const bad = elevation < TILT_DOWN_LIMIT ? 'down' : elevation > TILT_UP_LIMIT ? 'up' : null;
    if (!bad) {
      this.tiltBadSince = null;
      return;
    }
    this.tiltBadSince ??= now;
    if (now - this.tiltBadSince >= TILT_HOLD_MS && now - this.lastTiltWarn > TILT_REPEAT_MS) {
      this.lastTiltWarn = now;
      this.audio.earcon('attention');
      this.announcer.say(
        bad === 'down'
          ? 'The camera is pointing at the ground. Tilt the phone up so it faces forward.'
          : 'The camera is pointing up. Tilt the phone down so it faces forward.',
      );
      this.logSystem(`camera tilted ${bad} (${Math.round(elevation)} degrees)`);
    }
  }

  /** Low-light / blur warning: tell the user when the camera can't see well. */
  private updateQuality(q: FrameQuality, now: number): void {
    this.quality = q;
    if (q === 'ok') {
      this.badSince = null;
      return;
    }
    this.badSince ??= now;
    if (now - this.badSince >= QUALITY_HOLD_MS && now - this.lastQualityWarn > QUALITY_REPEAT_MS) {
      this.lastQualityWarn = now;
      this.audio.earcon('attention');
      this.announcer.say(
        q === 'dark'
          ? 'It is too dark for reliable detection.'
          : 'The camera view is blurry or covered. Detection may miss things.',
      );
      this.logSystem(`frame quality: ${q}`);
    }
  }
}
