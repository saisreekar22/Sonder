import type { AudioEngine } from '../audio/engine';
import type { FrameSource } from '../camera/source';
import type { Settings } from '../core/settings';
import type { DetectionClient } from '../detect/client';
import { focalPx } from '../perception/geometry';
import { Tracker, type Track } from '../perception/tracker';
import { filterDetections } from '../perception/zones';
import { FpsMeter, Rolling } from '../perf/metrics';
import type { Announcer } from '../speech/announcer';
import type { RunTracker } from './devices';
import { LaneFeedback, type DriftLevel } from './feedback';
import { LaneTracker, measureLane, type LaneMeasurement } from './lane';
import { formatPace, runSummary, type RunSnapshot } from './run';
import { LapTimer, PaceCoach, StopGuard } from './coach';
import { controlFrom, GuidelineMap, groundPoint, Kalman1D, type CameraModel, type Control, type CurveFit } from './world';
import { effectiveFov } from '../perception/geometry';
import type { MotionSensor } from '../sensors/motion';
import { SceneMemory } from '../perception/sceneMemory';
import { applyShaping } from '../audio/pgSounds';

export interface TrackReport {
  lane: LaneMeasurement;
  offset: number;
  predicted: number;
  heading: number;
  level: DriftLevel;
  lost: boolean;
  run: RunSnapshot;
  fps: number;
  laneMs: number;
  runnerAhead: Track | null;
  /** A bend coming up, if the lines ahead curve. */
  bend: 'left' | 'right' | null;
  /** STOP signalled (line lost while moving, or out of the lane). */
  stopped: boolean;
  /** World-space model (metres), when enough of the line is visible. */
  world: WorldState | null;
  /** People currently tracked (runners, pedestrians), for the live view. */
  people: Track[];
  /** What the guide tone is saying: steer (-1..1, + right) and how strongly (0 = silent). */
  guide: { steer: number; magnitude: number };
}

export interface WorldState {
  /** The line/lane centre you should follow, in your frame (metres). */
  centre: CurveFit;
  control: Control;
  /** Smoothed lateral offset from the centre, metres (+ = you are right of it). */
  lateral: number;
  cam: CameraModel;
  /** Recent ground keypoints, for the mini-map. */
  points: { x: number; z: number }[];
}

/** Half a standard lane (World Athletics: 1.22 m lanes). */
const HALF_LANE_M = 0.61;
/** If the camera's tilt is unknown, assume a chest mount angled ~20 deg down. */
const DEFAULT_PITCH = 0.35;
/** Speak only for a big drift that lasts. */
const BIG_DRIFT_HOLD_MS = 1200;
const BIG_DRIFT_REPEAT_MS = 6000;

const LANE_W = 160;
const ROI_TOP = 0.45;
const WATCHDOG_MS = 1000;
const LOST_REPEAT_MS = 2500;
const AHEAD_REPEAT_MS = 6000;
/** "Runner ahead" checks at most ~3 per second; lane guidance runs every frame. */
const AHEAD_EVERY_MS = 300;

/**
 * Track mode (lane guidance for runners, KineticSpatial): every camera frame
 * -> lane lines -> predicted lane position -> side-coded spatial ping +
 * vibration, silent while centred. Alongside: live run metrics with spoken
 * splits and "runner ahead" warnings from the object
 * detector running in its worker whenever it is free.
 */
export class TrackSession {
  state: 'idle' | 'running' | 'paused' = 'idle';
  onFrame: ((r: TrackReport) => void) | null = null;
  /** Flip left/right (camera facing the user, e.g. a laptop webcam test). */
  mirror = false;
  readonly laneMs = new Rolling(60);

  private source: FrameSource | null = null;
  private lane = new LaneTracker();
  private feedback = new LaneFeedback();
  private tracker = new Tracker();
  private fps = new FpsMeter();
  private canvas = document.createElement('canvas');
  private grab: OffscreenCanvas | HTMLCanvasElement =
    typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(320, 240) : document.createElement('canvas');
  private loopToken = 0;
  private watchdog: number | undefined;
  private lastFrame = 0;
  private lastLostCue = -Infinity;
  private lostToldTilt = false;
  private detecting = false;
  private lastAhead = -Infinity;
  private lastAheadCheck = -Infinity;
  private runnerAhead: Track | null = null;
  private lastFail = -Infinity;
  private lastStatsAt = 0;
  private run: RunSnapshot | null = null;
  private stopGuard = new StopGuard();
  private laps = new LapTimer();
  private pace = new PaceCoach();
  private lastBend: 'left' | 'right' | null = null;
  private lastBendSaid = -Infinity;
  private maps = { left: new GuidelineMap(), right: new GuidelineMap(), line: new GuidelineMap() };
  private kLat = new Kalman1D(0.15, 0.004);
  private lastWorldT = 0;
  private lastYaw = 0;
  private lastFit = -Infinity;
  /** Last time the camera actually saw line paint (not just the remembered map). */
  private lastLineSeen = -Infinity;
  private lastAheadSeen = -Infinity;
  private bigSince: number | null = null;
  /** Lanes crossed since the start (+ = to the right): guidance holds YOUR lane. */
  private laneShift = 0;
  private scene = new SceneMemory();
  private lastRawLat: number | null = null;
  private lastBigSaid = -Infinity;

  constructor(
    private readonly audio: AudioEngine,
    private readonly announcer: Announcer,
    private readonly detector: DetectionClient,
    readonly runTracker: RunTracker,
    private readonly settings: () => Settings,
    private readonly motion: MotionSensor | null = null,
  ) {}

  get currentSource(): FrameSource | null {
    return this.source;
  }

  start(source: FrameSource): void {
    this.source = source;
    source.onLost = (why) => this.fail(`Camera ${why === 'muted' ? 'paused' : 'stopped'}. Lane guidance is off.`);
    this.lane.reset();
    this.feedback.reset();
    this.tracker.reset();
    this.fps.clear();
    this.lostToldTilt = false;
    this.stopGuard.reset();
    this.laps.reset();
    this.pace.reset();
    this.lastBend = null;
    this.maps.left.reset();
    this.maps.right.reset();
    this.maps.line.reset();
    this.kLat.reset();
    this.lastWorldT = 0;
    this.lastYaw = this.motion?.yaw ?? 0;
    this.bigSince = null;
    this.laneShift = 0;
    this.lastRawLat = null;
    this.scene.reset();
    this.runTracker.start();
    this.audio.setMetronome(this.settings().metronomeSpm);
    this.state = 'running';
    this.lastFrame = performance.now();
    clearInterval(this.watchdog);
    this.watchdog = window.setInterval(() => {
      if (this.state === 'running' && !document.hidden && performance.now() - this.lastFrame > WATCHDOG_MS)
        this.fail('Lane guidance has stopped responding.');
    }, 250);
    this.loop();
  }

  pause(): void {
    if (this.state !== 'running') return;
    this.state = 'paused';
    this.loopToken++;
    this.runTracker.pause();
    this.audio.setMetronome(0);
    this.audio.setLaneTone(false, 0, 0);
    this.audio.setGuideTone({ active: false, steer: 0, magnitude: 0, edge: 0 });
    this.audio.pgUpdate({ steerDeg: 0, lateralM: 0, turnAheadDeg: 0, obstacle: false, active: false }, 0);
    this.audio.setBeacon({ active: false, azimuth: 0, distance: 5 });
    this.audio.updateScene([]);
  }

  resume(): void {
    if (this.state !== 'paused') return;
    this.state = 'running';
    this.runTracker.resume();
    this.audio.setMetronome(this.settings().metronomeSpm);
    this.lastFrame = performance.now();
    this.loop();
  }

  stop(): void {
    this.state = 'idle';
    this.loopToken++;
    clearInterval(this.watchdog);
    this.runTracker.stop();
    this.audio.setMetronome(0);
    this.audio.setLaneTone(false, 0, 0);
    this.audio.setGuideTone({ active: false, steer: 0, magnitude: 0, edge: 0 });
    this.audio.pgUpdate({ steerDeg: 0, lateralM: 0, turnAheadDeg: 0, obstacle: false, active: false }, 0);
    this.audio.setBeacon({ active: false, azimuth: 0, distance: 5 });
    this.audio.updateScene([]);
    this.source?.stop();
    this.source = null;
  }

  /** Spoken on demand: current stats. */
  describe(): string {
    const s = this.settings();
    return runSummary(this.runTracker.snapshot(s.runStepLength, s.lapMeters));
  }

  /** End-of-run summary, with best lap. */
  finish(): string {
    const s = this.settings();
    const best = this.laps.best;
    const bestLap = best ? ` Best lap ${formatPace(best).replace(':', ' minutes ')} seconds.` : '';
    return `Run finished. ${runSummary(this.runTracker.snapshot(s.runStepLength, s.lapMeters))}${bestLap}`;
  }

  fail(message: string): void {
    const now = performance.now();
    if (now - this.lastFail < 4000) return;
    this.lastFail = now;
    this.audio.earcon('warning');
    this.announcer.say(message, { interrupt: true });
  }

  private loop(): void {
    const token = ++this.loopToken;
    const next = () => {
      if (token !== this.loopToken || this.state !== 'running') return;
      let fired = false;
      const go = () => {
        if (fired) return;
        fired = true;
        this.step();
        next();
      };
      const v = this.source?.video;
      if (v && 'requestVideoFrameCallback' in v) v.requestVideoFrameCallback(go);
      setTimeout(go, 20);
    };
    next();
  }

  private step(): void {
    const video = this.source?.video;
    if (!video || !video.videoWidth) return;
    const s = this.settings();
    const now = performance.now();
    const t0 = now;

    // --- Lane lines (main thread, small frame) -----------------------------
    const h = Math.max(60, Math.round((LANE_W * video.videoHeight) / video.videoWidth));
    if (this.canvas.width !== LANE_W || this.canvas.height !== h) {
      this.canvas.width = LANE_W;
      this.canvas.height = h;
    }
    const ctx = this.canvas.getContext('2d', { willReadFrequently: true })!;
    if (this.mirror) {
      ctx.setTransform(-1, 0, 0, 1, LANE_W, 0);
    } else {
      ctx.setTransform(1, 0, 0, 1, 0, 0);
    }
    ctx.drawImage(video, 0, 0, LANE_W, h);
    const px = ctx.getImageData(0, 0, LANE_W, h).data;
    const m = measureLane(px, LANE_W, h, {
      roiTop: ROI_TOP,
      expectedWidthPx: this.lane.widthPx,
      mode: s.trackCourse,
      color: s.lineColor,
      edgeSide: s.edgeSide,
      expectedX: this.lane.lineX,
    });
    this.lane.update(m, now);
    const laneMs = performance.now() - t0;
    this.laneMs.push(laneMs);

    // --- Feedback ------------------------------------------------------------
    if (now - this.lastStatsAt > 500 || !this.run) {
      this.run = this.runTracker.snapshot(s.runStepLength, s.lapMeters);
      this.lastStatsAt = now;
      this.speakStats(this.run, s);
    }
    const speed = this.run.speed || 3;
    // World model first (metres, multi-frame, RANSAC); image model as fallback.
    const world = this.worldStep(m, s, now, h);
    const half = s.trackCourse === 'lanes' ? HALF_LANE_M : 0.5;
    if (m.keypoints.left.length + m.keypoints.right.length >= 3) this.lastLineSeen = now;
    // The remembered map carries you through a short gap, but no paint seen for
    // 1.5 s (worn away, covered) counts as lost: STOP if you are moving.
    // Only when the line SHOULD be in view: drifted 1 m off, a chest camera barely
    // sees it, and the remembered map (not STOP) guides you back.
    const shouldSee = !world || Math.abs(this.kLat.x) < 0.7;
    const lost = (world ? false : this.lane.lost(now) && now - this.lastFit > 600) || (shouldSee && now - this.lastLineSeen > 1500);
    const predicted = world
      ? // Look ahead 0.35 s, but never extrapolate more than 0.2 m (noise guard).
        ((this.kLat.x + Math.max(-0.2, Math.min(0.2, this.kLat.v * 0.35))) / half) * 0.5
      : this.lane.predicted(speed);
    // Guide-line sound mode and Guideline style both cue the side to turn toward.
    const cueSide = s.trackStyle === 'guideline' || s.trackStyle === 'pg' ? 'steer' : 'line';
    const ev = this.feedback.update(predicted, lost, now, { deadband: s.trackDeadband, cueSide });
    // STOP guard: line lost while moving, or out of the lane entirely.
    const moving = (this.run.speed ?? 0) > 1 || this.run.cadence > 100;
    const offsetNow = world ? (this.kLat.x / half) * 0.5 : this.lane.offset;
    // Lanes: STOP when you cross into the next lane. A single painted line: keep
    // guiding you back out to 1.5 m (as the open-source guide-line design does).
    const outLimit = s.trackCourse === 'lanes' ? 0.6 : (1.5 / half) * 0.5;
    const guard = this.stopGuard.update(lost, offsetNow, moving, now, outLimit);
    if (guard === 'stop') {
      if (!(s.trackStyle === 'pg' && this.audio.pgPlay('stop'))) this.audio.earcon('stopCue');
      navigator.vibrate?.([200, 100, 200, 100, 200]);
      this.announcer.say('Stop.', { interrupt: true, system: false, priority: 0 });
    } else if (guard === 'go') {
      this.audio.earcon('opened');
      this.announcer.say('Line found. Go.', { interrupt: true, system: false, priority: 0 });
    }
    const stopped = this.stopGuard.stopped;
    const deadband = s.trackDeadband;
    // The guide-line system's sensitivity shaping: small deviations stay very quiet.
    const magnitude = applyShaping(Math.max(0, Math.min(1, (Math.abs(predicted) - deadband) / (0.5 - deadband))));
    // The guide-line system sounds (+ ear vibration on the side to turn toward).
    if (s.trackStyle === 'pg' && this.audio.pgReady) {
      const steerRad = world ? world.control.steer : -predicted * 0.8;
      this.audio.pgUpdate(
        {
          steerDeg: (steerRad * 180) / Math.PI,
          lateralM: world ? world.lateral : (predicted / 0.5) * half,
          turnAheadDeg: world ? (world.control.turnAhead * 180) / Math.PI : 0,
          obstacle: !!this.runnerAhead && this.runnerAhead.distance < 3,
          active: !lost && !stopped,
        },
        s.earVibration,
      );
    }
    // If the sound pack can't be decoded here, the smooth glide tone stands in.
    const usePg = s.trackStyle === 'pg' && this.audio.pgReady;
    // The phone vibrates too (Android): one buzz = turn left, two = turn right.
    if (usePg && !stopped && ev.vibrate && s.trackHaptics) navigator.vibrate?.(ev.vibrate);
    // 360 awareness: guide beacon ahead + other runners all around (with memory behind you).
    if (s.runBeacon && world && !lost && !stopped) {
      this.audio.setBeacon({
        active: true,
        azimuth: Math.atan2(world.control.target.x, world.control.target.z),
        distance: world.control.target.z,
      });
    } else this.audio.setBeacon({ active: false, azimuth: 0, distance: 5 });
    if (s.soundScene === 'surround') {
      this.audio.updateScene(this.scene.update(this.tracker.all, now, this.motion?.yaw ?? 0, s.spatialSpread));
    }
    if (!stopped && !usePg && (s.trackStyle === 'glide' || s.trackStyle === 'pg')) {
      // Steer toward the line: from the look-ahead target when we have one.
      const steer = world ? world.control.steer : -predicted;
      this.audio.setGuideTone({
        active: !lost,
        steer: Math.abs(steer) > 1e-3 ? steer : -predicted,
        magnitude,
        edge: Math.max(0, (Math.abs(predicted) - 0.38) / 0.12),
      });
    } else {
      this.audio.setGuideTone({ active: false, steer: 0, magnitude: 0, edge: 0 });
    }
    // Speech only for a BIG drift that lasts: small steps never talk.
    const big = !lost && !stopped && Math.abs(predicted) > 0.42;
    if (big) {
      this.bigSince ??= now;
      if (now - this.bigSince > BIG_DRIFT_HOLD_MS && now - this.lastBigSaid > BIG_DRIFT_REPEAT_MS) {
        this.lastBigSaid = now;
        this.announcer.say(predicted > 0 ? 'Move left.' : 'Move right.', { system: false, priority: 0 });
      }
    } else {
      this.bigSince = null;
    }
    if (!stopped && s.trackStyle !== 'glide' && s.trackStyle !== 'pg') {
      if (s.trackStyle === 'tone') {
        const drift = Math.max(0, (Math.abs(predicted) - s.trackDeadband) / (0.45 - s.trackDeadband));
        this.audio.setLaneTone(!lost, predicted > 0 ? 1 : -1, drift);
      } else if (ev.ping) {
        this.audio.lanePing(ev.pan, ev.intensity, s.trackStyle === 'guideline' && ev.level === 'danger');
      }
      if (ev.vibrate && s.trackHaptics) navigator.vibrate?.(ev.vibrate);
      if (ev.recovered) this.audio.earcon('recovered');
    } else {
      this.audio.setLaneTone(false, 0, 0);
    }
    // Bends: say which way before you reach them (lean in early).
    // Bends/turns: from the world fit when available (angle over the next ~12 m).
    const bend =
      s.trackCourse === 'edge'
        ? null
        : world && world.centre.reach > 6
          ? Math.abs(world.control.turnAhead) > 0.3
            ? world.control.turnAhead > 0
              ? 'right'
              : 'left'
            : null
          : this.lane.bend();
    if (bend !== this.lastBend) {
      if (bend && now - this.lastBendSaid > 8000) {
        this.lastBendSaid = now;
        this.audio.earcon('bend', bend === 'left' ? -0.8 : 0.8);
        if (s.trackStyle !== 'pg') this.announcer.say(`Bend ${bend}.`, { system: false, priority: 1 });
      }
      this.lastBend = bend;
    }
    if (lost && !stopped && now - this.lastLostCue > LOST_REPEAT_MS) {
      this.lastLostCue = now;
      this.audio.earcon('lineLost');
      if (!this.lostToldTilt) {
        this.lostToldTilt = true;
        this.announcer.say(
          s.trackCourse === 'lanes'
            ? 'Lane lines not found. Point the phone forward and slightly down at the track.'
            : 'Line not found. Point the phone forward and slightly down at the line.',
        );
      }
    }

    // --- Runner ahead (object detector, whenever its worker is free) --------
    if (s.trackObstacles && !this.detecting && this.detector.model && now - this.lastAheadCheck >= AHEAD_EVERY_MS) {
      this.lastAheadCheck = now;
      void this.detectAhead(video, s);
    }

    this.lastFrame = performance.now();
    this.fps.tick(this.lastFrame);
    this.onFrame?.({
      lane: m,
      offset: this.lane.offset,
      predicted,
      heading: this.lane.heading,
      level: ev.level,
      lost,
      run: this.run,
      fps: this.fps.fps(this.lastFrame),
      laneMs,
      runnerAhead: this.runnerAhead,
      bend,
      stopped,
      world,
      people: this.tracker.all.filter((p) => p.confirmed),
      // Exactly what the steering sound says: the shaped turn toward the
      // look-ahead point (covers heading as well as sideways offset).
      guide: stopped || lost
        ? { steer: 0, magnitude: 0 }
        : world
          ? {
              steer: Math.sign(world.control.steer),
              magnitude: Math.abs(applyShaping(Math.max(-1, Math.min(1, world.control.steer / (Math.PI / 4))))),
            }
          : { steer: Math.sign(-predicted), magnitude },
    });
  }

  /**
   * guide-line style world model: keypoints -> ground (metres) ->
   * per-line maps moved by your own motion -> RANSAC curve fit -> centre
   * line -> look-ahead control, with a Kalman-smoothed lateral offset.
   */
  private worldStep(m: LaneMeasurement, s: Settings, now: number, h: number): WorldState | null {
    const elev = this.motion?.available ? this.motion.snapshot().elevation : NaN;
    const pitch = Number.isFinite(elev) ? Math.min(1.3, Math.max(0.05, (-elev * Math.PI) / 180)) : DEFAULT_PITCH;
    const cam: CameraModel = {
      width: LANE_W,
      height: h,
      fovDeg: effectiveFov(s.fovDeg, this.source?.zoom),
      pitch,
      mountHeight: s.mountHeight,
    };
    const dt = this.lastWorldT ? Math.min(0.2, (now - this.lastWorldT) / 1000) : 0;
    this.lastWorldT = now;
    const yaw = this.motion?.yaw ?? 0;
    const turn = yaw - this.lastYaw;
    this.lastYaw = yaw;
    const forward = (this.run?.speed ?? 0) * dt;
    const toGround = (pts: { x: number; y: number }[]) =>
      pts
        .filter((_, i) => i % 2 === 0)
        .map((p) => groundPoint(p.x, p.y, cam))
        .filter((g): g is { x: number; z: number } => !!g && g.z < 18 && Math.abs(g.x) < 6);
    let centre: CurveFit | null = null;
    let points: { x: number; z: number }[] = [];
    if (s.trackCourse === 'lanes') {
      this.maps.left.update(toGround(m.keypoints.left), forward, turn, now);
      this.maps.right.update(toGround(m.keypoints.right), forward, turn, now);
      const fl = this.maps.left.fit(), fr = this.maps.right.fit();
      if (fl && fr && fr.c0 - fl.c0 > 0.6 && fr.c0 - fl.c0 < 2) {
        centre = { c0: (fl.c0 + fr.c0) / 2, c1: (fl.c1 + fr.c1) / 2, c2: (fl.c2 + fr.c2) / 2, inliers: fl.inliers + fr.inliers, reach: Math.min(fl.reach, fr.reach) };
      } else if (fl) centre = { ...fl, c0: fl.c0 + HALF_LANE_M };
      else if (fr) centre = { ...fr, c0: fr.c0 - HALF_LANE_M };
      points = [...this.maps.left.points(), ...this.maps.right.points()];
    } else {
      this.maps.line.update(toGround([...m.keypoints.left, ...m.keypoints.right]), forward, turn, now);
      const fit = this.maps.line.fit();
      if (fit) centre = s.trackCourse === 'edge' ? { ...fit, c0: fit.c0 + (s.edgeSide === 'left' ? s.edgeGap : -s.edgeGap) } : fit;
      points = [...this.maps.line.points()];
    }
    if (!centre) return null;
    this.lastFit = now;
    const control = controlFrom(centre, Math.max(2, this.run?.speed ?? 3));
    if (s.trackCourse === 'lanes') {
      // Crossing a lane line makes the measured offset jump by a lane width
      // (you now see the NEIGHBOUR lane's lines). Count crossings so the
      // guide keeps steering you back to your own lane instead.
      if (this.lastRawLat !== null) {
        const d = control.lateral - this.lastRawLat;
        if (d < -0.8) this.laneShift++;
        else if (d > 0.8) this.laneShift--;
      }
      this.lastRawLat = control.lateral;
      const shift = this.laneShift * 2 * HALF_LANE_M;
      control.lateral += shift;
      // Steer back toward your own lane's centre too.
      control.steer = Math.atan2(control.target.x - shift, control.target.z);
    }
    this.kLat.predict(dt);
    const lateral = this.kLat.update(control.lateral);
    return { centre, control, lateral, cam, points };
  }

  private speakStats(r: RunSnapshot, s: Settings): void {
    // Lap splits (compared with the last lap) when announcing per lap.
    const lap = this.laps.update(r.laps, r.elapsedS);
    if (lap && s.trackAnnounce === 'lap') {
      const pace = Number.isFinite(r.paceS) && r.paceS < 1800 ? ` Pace ${formatPace(r.paceS).replace(':', ' ')}.` : '';
      this.announcer.say(lap + pace, { system: false, priority: 1 });
    } else if (s.trackAnnounce !== 'lap') {
      const lead = this.runTracker.schedule.due(r, s.trackAnnounce, s.trackAnnounceMinutes);
      if (lead !== null && r.distanceM > 0) this.announcer.say(runSummary(r, lead), { system: false, priority: 1 });
    }
    const coach = this.pace.update(r.paceS, s.targetPaceS, r.elapsedS);
    if (coach) this.announcer.say(coach, { system: false, priority: 2 });
  }

  private async detectAhead(video: HTMLVideoElement, s: Settings): Promise<void> {
    this.detecting = true;
    try {
      const vw = video.videoWidth, vh = video.videoHeight;
      const scale = Math.min(1, 320 / Math.max(vw, vh));
      const w = Math.round(vw * scale), h = Math.round(vh * scale);
      this.grab.width = w;
      this.grab.height = h;
      const g = this.grab.getContext('2d') as CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;
      g.drawImage(video, 0, 0, w, h);
      const bmp =
        this.grab instanceof HTMLCanvasElement ? await createImageBitmap(this.grab) : this.grab.transferToImageBitmap();
      const t = performance.now();
      const { detections } = await this.detector.detect(bmp, t);
      if (this.state !== 'running') return;
      const frame = { width: vw, height: vh };
      const dets = (this.mirror ? detections.map((d) => ({ ...d, box: { ...d.box, x: 1 - d.box.x - d.box.w } })) : detections)
        .filter((d) => d.label === 'person' || d.label === 'bicycle');
      const kept = filterDetections(dets, { corridorWidth: 0.5, centerWidth: 0.4, minScore: 0.5, minHeight: 0.15 });
      const tracks = this.tracker.update(kept, t, { frame, focal: focalPx(frame, s.fovDeg), corridorWidth: 0.5, centerWidth: 0.4 });
      const ahead = tracks.filter((tr) => tr.confirmed && tr.zone === 'center' && tr.distance < 8).sort((a, b) => a.distance - b.distance)[0];
      // Hold a sighting briefly across missed detector frames.
      if (ahead) this.lastAheadSeen = t;
      if (ahead || t - this.lastAheadSeen > 1200) this.runnerAhead = ahead ?? null;
      if (ahead && t - this.lastAhead > AHEAD_REPEAT_MS) {
        this.lastAhead = t;
        const steerPan = ahead.box.x < 0.5 ? 1 : -1;
        this.audio.lanePing(steerPan, 0.9);
        if (s.trackHaptics && typeof navigator !== 'undefined' && navigator.vibrate) {
          navigator.vibrate(steerPan > 0 ? [60, 40, 60] : [120]);
        }
        this.audio.earcon('approach', 0);
        // On roads you can pass: suggest the side with more room (not in track lanes).
        const cx = ahead.box.x + ahead.box.w / 2;
        const pass = s.trackCourse === 'lanes' ? '' : ` Pass on the ${cx < 0.5 ? 'right' : 'left'}.`;
        // A new person ahead always gets through (the limiter would drop it as a repeat).
        this.announcer.say(`Someone ahead, ${Math.max(1, Math.round(ahead.distance))} metres.${pass}`, { system: false, priority: 0, interrupt: true });
      }
    } catch {
      /* detector busy/reloading: lane guidance carries on regardless */
    } finally {
      this.detecting = false;
    }
  }
}
