import type { AudioEngine } from '../audio/engine';
import type { FrameSource } from '../camera/source';
import { isWorn, sensitivityParams, type Settings } from '../core/settings';
import type { Detection, FrameSize } from '../core/types';
import { CuePolicy, type PolicyOutput } from '../cues/policy';
import type { DetectionClient } from '../detect/client';
import { applyEgoMotion, describeScene } from '../perception/egomotion';
import { effectiveFov, focalPx } from '../perception/geometry';
import { frameQuality, toGray, type FrameQuality } from '../perception/imageStats';
import { LgmdDetector, type LgmdOutput } from '../perception/lgmd';
import { pathDebris, PathEstimator, type PathModel } from '../perception/freespace';
import { classInfo } from '../perception/classes';
import { nextGuidance, type GuidanceKey } from '../cues/guidance';
import { zonePan } from '../perception/zones';
import { SceneMemory } from '../perception/sceneMemory';
import { TalkPolicy, type TalkKind } from '../speech/talkPolicy';
import { groundMap, type GroundMap } from '../perception/ground';
import { LiveScan } from '../perception/liveScan';
import type { DepthClient } from '../depth/client';
import { alignToGround, boxDistance, occupancy, type Alignment, type DepthMap, type Occupancy } from '../depth/metric';
import type { CameraModel } from '../track/world';
import { bandOf } from '../perception/geometry';
import { effectiveFov as effFov } from '../perception/geometry';
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
  /** Locust-inspired looming pathway output (per sector). */
  lgmd: LgmdOutput | null;
  /** Depth-based obstacle picture (virtual cane), when fresh. */
  depth: Occupancy | null;
  /** Walkable-path model (for drawing). */
  path: PathModel | null;
  /** Leaf-litter map of the ground (for drawing and the scan). */
  ground: GroundMap | null;
  /** Scan-around-you progress while scanning. */
  scan: { progress: number; sweptDeg: number } | null;
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
/** One small frame per camera frame feeds the looming, path and light checks. */
const THUMB_W = 80;
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
  private lgmd = new LgmdDetector();
  private scene = new SceneMemory();
  /** Depth AI (virtual cane + echolocation); set by the app when available. */
  depthClient: DepthClient | null = null;
  private depthCanvas: OffscreenCanvas | HTMLCanvasElement =
    typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(196, 252) : document.createElement('canvas');
  private depthState: { occ: Occupancy; at: number; dm: DepthMap; al: Alignment; cam: CameraModel } | null = null;
  private lastDepthAt = -Infinity;
  private lastEcho = 0;
  private lastHeadSaid = -Infinity;
  private depthQuality = 0;
  private hazardFrames = 0;
  private caneFrames = 0;
  private lastHazardCue = -Infinity;
  private lastHazardSaid = -Infinity;
  private pathEst = new PathEstimator();
  private groundCanvas = document.createElement('canvas');
  private groundState: GroundMap | null = null;
  private leafFrames = 0;
  private lastLeavesSaid = -Infinity;
  private lastPacingId = -1;
  /** "Scan around you" (Live View style); set onScanDone to receive the summary. */
  readonly scan = new LiveScan();
  onScanDone: ((lines: string[]) => void) | null = null;
  private lastGuideSaid: GuidanceKey = null;
  /** Decides what is worth saying (see speech/talkPolicy.ts). */
  private talk = new TalkPolicy();
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
    this.talk.reset();
    this.lgmd.reset();
    this.pathEst.reset();
    this.scene.reset();
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
    this.lgmd.reset();
    this.pathEst.reset();
    this.scene.reset();
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
    this.audio.setCane({ active: false, distance: 9, azimuth: 0, head: false });
    this.source?.stop();
    this.source = null;
    this.logSystem('stop');
  }

  pause(): void {
    if (this.state !== 'running') return;
    this.state = 'paused';
    this.loopToken++;
    this.audio.silence();
    this.audio.setCane({ active: false, distance: 9, azimuth: 0, head: false });
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
    if (!s.looming) this.lgmd.reset();
    this.pathEst.reset();
    this.scene.reset();
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

    // Small thumbnail (80 px wide), same left/right orientation as detections.
    this.frameCount++;
    const tw = THUMB_W, th = Math.max(1, Math.round((THUMB_W * vh) / vw));
    if (this.thumb.width !== tw || this.thumb.height !== th) {
      this.thumb.width = tw;
      this.thumb.height = th;
    }
    const tc = this.thumb.getContext('2d', { willReadFrequently: true })!;
    tc.setTransform(this.mirror ? -1 : 1, 0, 0, 1, this.mirror ? tw : 0, 0);
    tc.drawImage(video, 0, 0, tw, th);
    const thumbPx = tc.getImageData(0, 0, tw, th).data;
    // Ground hazards (leaf litter) need a little more detail: 160 px, every 3rd frame.
    if (this.frameCount % 3 === 0) {
      const gw = 160, gh = Math.max(1, Math.round((160 * vh) / vw));
      if (this.groundCanvas.width !== gw || this.groundCanvas.height !== gh) {
        this.groundCanvas.width = gw;
        this.groundCanvas.height = gh;
      }
      const gc = this.groundCanvas.getContext('2d', { willReadFrequently: true })!;
      gc.setTransform(this.mirror ? -1 : 1, 0, 0, 1, this.mirror ? gw : 0, 0);
      gc.drawImage(video, 0, 0, gw, gh);
      this.groundState = groundMap(gc.getImageData(0, 0, gw, gh).data, gw, gh);
    }
    const gray = toGray(thumbPx, tw, th);
    if (this.frameCount % 10 === 0) this.updateQuality(frameQuality(gray), captureT);
    // Locust-inspired looming pathway: harder to trigger while walking (the
    // whole scene expands as you move forward).
    let lgmd: LgmdOutput | null = null;
    if (s.looming) {
      const walking = this.motion?.available && this.motion.snapshot().walking;
      lgmd = this.lgmd.update(gray, walking ? 1.3 : 1);
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
      focal: focalPx(frame, effectiveFov(s.fovDeg, this.source?.zoom)),
      corridorWidth: s.corridorWidth,
      centerWidth: s.centerWidth,
    });
    // Depth AI (virtual cane): ~5 times a second, in its own worker.
    if ((s.depthCane || s.echoEverySec > 0) && this.depthClient?.ready && !this.depthClient.busy && captureT - this.lastDepthAt > 200) {
      this.lastDepthAt = captureT;
      void this.runDepth(video, s);
    }
    const depth = this.depthState && captureT - this.depthState.at < 700 ? this.depthState.occ : null;
    // Depth-measured distances for detected objects (fresh depth only): box
    // size assumes a standard height, depth doesn't. Partly visible objects
    // (cut off by the frame) use depth alone; others average the two.
    if (this.depthState && captureT - this.depthState.at < 400 && this.depthQuality >= 0.5) {
      const ds = this.depthState;
      for (const t of tracks) {
        if (!t.confirmed) continue;
        const dz = boxDistance(ds.dm, ds.cam, ds.al, t.box);
        if (dz === null || !(dz > 0.3 && dz < 15)) continue;
        const clipped = t.box.y < 0.02 || t.box.y + t.box.h > 0.98;
        t.distance = clipped ? dz : 0.5 * t.distance + 0.5 * dz;
        t.band = bandOf(t.distance);
      }
    }

    // Walkable path, with detected objects masked out of it.
    // Mask live detections AND tracked objects (a just-vanished detection must
    // not make its spot look like open path for the half-second it coasts).
    const path = this.pathEst.update(thumbPx, tw, th, [...detections.map((d) => d.box), ...tracks.map((t) => t.box)]);
    const motion = this.motion?.available ? this.motion.snapshot() : null;
    if (motion) {
      applyEgoMotion(tracks, motion.walking, motion.speed);
      this.checkTilt(motion.elevation, captureT);
    }
    this.lastTracks = tracks;
    const policy = this.policy.update(
      tracks,
      captureT,
      {
        centerWidth: s.centerWidth,
        blockDistance: s.blockDistance,
        maxSources: 3,
        density: s.cueDensity,
        focalNorm: focalPx(frame, effectiveFov(s.fovDeg, this.source?.zoom)) / frame.width,
      },
      // Depth fusion: something close and solid straight ahead that no
      // recognised object explains (a wall, a pole, an open door) blocks
      // the path too.
      {
        path,
        lgmd,
        depthObstacle: depth?.center && depth.center.z < s.blockDistance ? depth.center : null,
        walking: !!motion?.walking,
        loomingCenter:
          !!depth?.center &&
          depth.center.z < s.blockDistance &&
          !tracks.some((t) => t.confirmed && t.zone === 'center' && Math.abs(t.distance - depth.center!.z) < 1),
      },
    );
    this.updateCane(depth, s, captureT);
    // While scanning, the scan summary does the talking.
    if (this.scan.active) {
      const yaw = this.motion?.available ? this.motion.yaw : 0;
      const fovR = (effectiveFov(s.fovDeg, this.source?.zoom) * Math.PI) / 180;
      const hfov = 2 * Math.atan(Math.tan(fovR / 2) * (vw / Math.max(vw, vh)));
      this.scan.add({ yaw, hfov, path, tracks, ground: this.groundState, depth });
      if (this.scan.progress(captureT) >= 1) {
        const lines = this.scan.summary(yaw);
        this.announcer.say(`Scan complete. ${lines.join(' ')}`, { interrupt: true });
        this.logSystem('scan complete');
        this.onScanDone?.(lines);
      }
    } else {
      this.checkGround(depth, path, captureT);
      this.speakGuidance(policy, tracks, captureT);
      // Someone ahead walking your way: say it once per person, no STOP.
      const pace = policy.pacing;
      if (pace && pace.trackId !== this.lastPacingId && !policy.blocked) {
        this.lastPacingId = pace.trackId;
        this.sayIf('info', `Person ahead, walking your way.${pace.side ? ` Pass on the ${pace.side}.` : ''}`, captureT);
      }
    }
    const looming = policy.unexplainedLooming !== null;

    // --- Audio ----------------------------------------------------------------
    const started = this.audio.update(policy.sources);
    // "8D" surround: the whole scene, continuously, all the way round you.
    if (s.soundScene === 'surround') {
      const yaw = this.motion?.available ? this.motion.yaw : 0;
      this.audio.updateScene(this.scene.update(tracks, captureT, yaw, s.spatialSpread));
    }
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

    // --- Directional haptics for obstacle guidance ---
    if (policy.blocked && policy.guideSide) {
      if (now - this.lastVibrateAt > 500) {
        this.lastVibrateAt = now;
        if (typeof navigator !== 'undefined' && navigator.vibrate) {
          // Double buzz for right, long buzz for left
          navigator.vibrate(policy.guideSide === 'right' ? [60, 40, 60] : [120]);
        }
      }
    }

    // --- Spoken warnings (V2) ---------------------------------------------------
    // While blocked, the step-around guidance does the talking.
    if (s.verbosity !== 'off' && this.announcer.ready && !policy.blocked && !this.scan.active) {
      const [w0] = this.warnings.update(tracks, captureT, s.verbosity);
      if (w0) {
        const tr = tracks.find((t) => t.id === w0.trackId);
        if (!this.announcer.supported) {
          // No on-device voice: a distinct "approaching" sound from that side instead.
          this.audio.earcon('approach', tr ? zonePan(tr.zone) : 0);
          this.warnings.markSpoken(w0.trackId, captureT);
        } else if (this.sayIf('warn', w0.text, captureT, 1 + w0.ttc)) {
          this.lastSoundAt = now;
          this.warnings.markSpoken(w0.trackId, captureT);
        }
      }
    }

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
      lgmd,
      depth,
      path,
      ground: this.groundState,
      scan: this.scan.active ? { progress: this.scan.progress(captureT), sweptDeg: this.scan.sweptDeg } : null,
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

  /**
   * Spoken guidance around blockages (see cues/guidance.ts): stop, which way
   * to step, and, once it clears, how to move again. Rate-limited, except that
   * "you can move again" messages are never held back for long.
   */
  private speakGuidance(p: PolicyOutput, tracks: readonly Track[], now: number): void {
    const blocker = tracks
      .filter((t) => t.confirmed && t.zone === 'center')
      .sort((a, b) => a.distance - b.distance)[0];
    const what = blocker ? (classInfo(blocker.label)?.spoken ?? 'Something') : 'Something';
    const g = nextGuidance(this.lastGuideSaid, p, what);
    if (!g.text) {
      // Past it: a soft chime instead of words.
      if (g.resume) this.audio.earcon('opened');
      this.lastGuideSaid = g.key;
      return;
    }
    const kind: TalkKind = g.key === 'none' ? 'stop' : g.resume ? 'resume' : g.key?.startsWith('loom-') ? 'warn' : 'steer';
    if (this.settings.verbosity === 'off') {
      this.lastGuideSaid = g.key;
      return;
    }
    if (!this.sayIf(kind, g.text, now, 0)) {
      // A "way opened" that isn't worth words still gets its chime.
      if (kind === 'resume') {
        this.audio.earcon('opened');
        this.lastGuideSaid = g.key;
      }
      return; // otherwise try again next frame
    }
    this.lastGuideSaid = g.key;
    if (g.resume) this.audio.earcon('opened');
  }

  /** Speak through the talk policy; true if it was said. */
  private sayIf(kind: TalkKind, text: string, now: number, priority = 1): boolean {
    if (this.settings.verbosity === 'off' || !this.talk.allow(kind, text, now)) return false;
    this.announcer.say(text, { system: false, priority, interrupt: kind === 'stop' || kind === 'steer' || kind === 'resume' });
    this.log.push({ t: Math.round(now - this.startedAt), type: 'speech', text });
    return true;
  }

  /** Depth frame -> metric alignment (via the ground) -> occupancy. */
  private async runDepth(video: HTMLVideoElement, s: Settings): Promise<void> {
    const vw = video.videoWidth, vh = video.videoHeight;
    const sc = 252 / Math.max(vw, vh);
    const w = Math.round(vw * sc), h = Math.round(vh * sc);
    this.depthCanvas.width = w;
    this.depthCanvas.height = h;
    const g = this.depthCanvas.getContext('2d') as CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;
    g.setTransform(this.mirror ? -1 : 1, 0, 0, 1, this.mirror ? w : 0, 0);
    g.drawImage(video, 0, 0, w, h);
    const bmp =
      this.depthCanvas instanceof HTMLCanvasElement
        ? await createImageBitmap(this.depthCanvas)
        : this.depthCanvas.transferToImageBitmap();
    const dm = await this.depthClient!.estimate(bmp);
    if (!dm || this.state !== 'running') return;
    const elev = this.motion?.available ? this.motion.snapshot().elevation : NaN;
    const table = s.mount === 'table';
    const cam = {
      width: dm.width,
      height: dm.height,
      fovDeg: effFov(s.fovDeg, this.source?.zoom),
      pitch: Number.isFinite(elev) ? Math.min(1.3, Math.max(0.02, (-elev * Math.PI) / 180)) : table ? 0.05 : 0.35,
      mountHeight: table ? 0.75 : s.mount === 'waist' ? 1.0 : 1.3,
    };
    const al = alignToGround(dm, cam);
    this.depthQuality = al?.quality ?? 0;
    // No visible ground (e.g. a laptop webcam looking straight ahead): can't measure in metres.
    if (!al || al.quality < 0.35) {
      this.depthState = null;
      return;
    }
    this.depthState = { occ: occupancy(dm, cam, al), at: performance.now(), dm, al, cam };
  }

  /** Virtual cane tone, head-height warnings and echolocation clicks. */
  private updateCane(depth: Occupancy | null, s: Settings, now: number): void {
    const near = depth?.center ?? null;
    const head = depth?.head ?? null;
    const target = head && (!near || head.z <= near.z + 0.3) ? head : near;
    // Only once it persists (3 frames) and is within 2.5 m: no chatter from noise.
    this.caneFrames = target && target.z < 2.5 ? this.caneFrames + 1 : 0;
    if (s.depthCane && target && this.caneFrames >= 3) {
      this.audio.setCane({ active: true, distance: target.z, azimuth: Math.atan2(target.x, target.z), head: target === head });
      if (head && head.z < 2.5 && now - this.lastHeadSaid > 6000) {
        // Close: urgent. Further: a note.
        if (this.sayIf(head.z < 1.5 ? 'stop' : 'info', head.z < 1.5 ? 'Duck. Head height, ahead.' : 'Head height obstacle ahead.', now, 0)) this.lastHeadSaid = now;
      }
    } else {
      this.audio.setCane({ active: false, distance: 9, azimuth: 0, head: false });
    }
    if (s.echoEverySec > 0 && depth && now - this.lastEcho > s.echoEverySec * 1000) {
      this.lastEcho = now;
      this.audio.echolocate(depth.echoes);
    }
  }

  /**
   * Rocks, kerbs and steps (depth: low bumps in your path) and flat debris
   * like leaves or litter (path appearance). Must persist ~5 frames; a low
   * tock on the ground at its direction, and a short spoken note at most
   * every 12 s (through the speech limiter).
   */
  private checkGround(depth: Occupancy | null, path: PathModel, now: number): void {
    // Leaf litter on the path ahead: a short note when it first appears (persisting ~6 frames), then quiet.
    const g = this.groundState;
    this.leafFrames = g && g.corridor > 0.15 ? this.leafFrames + 1 : 0;
    if (this.leafFrames === 6 && now - this.lastLeavesSaid > 30000) {
      this.lastLeavesSaid = now;
      const x = g!.aheadX ?? 0.5;
      this.audio.groundCue((x - 0.5) * 1.1);
      this.sayIf('info', 'Leaves on the path. Could be slippery.', now);
    }
    const rock = depth?.low ?? null;
    const debris = rock ? null : pathDebris(path);
    if (!rock && !debris) {
      this.hazardFrames = 0;
      return;
    }
    if (++this.hazardFrames < 5) return;
    const az = rock ? Math.atan2(rock.x, rock.z) : (debris!.x - 0.5) * 1.1;
    if (now - this.lastHazardCue > 2500) {
      this.lastHazardCue = now;
      this.audio.groundCue(az);
    }
    // Only depth-measured bumps are worth words; flat look-alikes (shadows,
    // markings, manhole covers) get just the ground sound.
    if (rock && now - this.lastHazardSaid > 12000) {
      const side = Math.abs(az) < 0.15 ? 'ahead' : az < 0 ? 'ahead, left' : 'ahead, right';
      if (this.sayIf('info', `Step or rock ${side}.`, now)) this.lastHazardSaid = now;
    }
  }

  /** Start the "scan around you" step (about 9 seconds). */
  startScan(): void {
    this.scan.start(performance.now(), this.motion?.available ? this.motion.yaw : 0);
    this.announcer.say('Scanning. Hold the phone at chest height, camera facing out. Turn slowly to your left, then to your right, then face forward.', { interrupt: true });
    this.logSystem('scan started');
  }

  /** How well depth lined up with the ground last time (0..1); low = no metric depth. */
  get depthOk(): number {
    return this.depthQuality;
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
