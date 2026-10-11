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
import { runSummary, type RunSnapshot } from './run';

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
}

const LANE_W = 160;
const ROI_TOP = 0.45;
const WATCHDOG_MS = 1000;
const LOST_REPEAT_MS = 2500;
const AHEAD_REPEAT_MS = 6000;
const HR_REPEAT_MS = 60000;
/** "Runner ahead" checks at most ~3 per second; lane guidance runs every frame. */
const AHEAD_EVERY_MS = 300;

/**
 * Track mode (lane guidance for runners, KineticSpatial): every camera frame
 * -> lane lines -> predicted lane position -> side-coded spatial ping +
 * vibration, silent while centred. Alongside: live run metrics with spoken
 * splits, heart-rate alerts, and "runner ahead" warnings from the object
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
  private lastHrWarn = -Infinity;
  private lastFail = -Infinity;
  private lastStatsAt = 0;
  private run: RunSnapshot | null = null;

  constructor(
    private readonly audio: AudioEngine,
    private readonly announcer: Announcer,
    private readonly detector: DetectionClient,
    readonly runTracker: RunTracker,
    private readonly settings: () => Settings,
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
    this.runTracker.start();
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
  }

  resume(): void {
    if (this.state !== 'paused') return;
    this.state = 'running';
    this.runTracker.resume();
    this.lastFrame = performance.now();
    this.loop();
  }

  stop(): void {
    this.state = 'idle';
    this.loopToken++;
    clearInterval(this.watchdog);
    this.runTracker.stop();
    this.source?.stop();
    this.source = null;
  }

  /** Spoken on demand: current stats. */
  describe(): string {
    const s = this.settings();
    return runSummary(this.runTracker.snapshot(s.runStepLength, s.lapMeters));
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
    const m = measureLane(px, LANE_W, h, { roiTop: ROI_TOP, expectedWidthPx: this.lane.widthPx });
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
    const lost = this.lane.lost(now);
    const predicted = this.lane.predicted(speed);
    const ev = this.feedback.update(predicted, lost, now, { deadband: s.trackDeadband, cueSide: s.trackCueSide });
    if (ev.ping) this.audio.lanePing(ev.pan, ev.intensity);
    if (ev.vibrate && s.trackHaptics) navigator.vibrate?.(ev.vibrate);
    if (ev.recovered) this.audio.earcon('recovered');
    if (lost && now - this.lastLostCue > LOST_REPEAT_MS) {
      this.lastLostCue = now;
      this.audio.earcon('lineLost');
      if (!this.lostToldTilt) {
        this.lostToldTilt = true;
        this.announcer.say('Lane lines not found. Point the phone forward and slightly down at the track.');
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
    });
  }

  private speakStats(r: RunSnapshot, s: Settings): void {
    const lead = this.runTracker.schedule.due(r, s.trackAnnounce, s.trackAnnounceMinutes);
    if (lead !== null && r.distanceM > 0) this.announcer.say(runSummary(r, lead), { system: false, priority: 1 });
    const hr = r.heartRate;
    const now = performance.now();
    if (s.maxHeartRate > 0 && hr && hr > s.maxHeartRate && now - this.lastHrWarn > HR_REPEAT_MS) {
      this.lastHrWarn = now;
      this.audio.earcon('attention');
      this.announcer.say(`Heart rate high, ${hr}.`, { system: false, priority: 0 });
    }
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
      const ahead = tracks.filter((tr) => tr.confirmed && tr.zone === 'center' && tr.distance < 5).sort((a, b) => a.distance - b.distance)[0];
      this.runnerAhead = ahead ?? null;
      if (ahead && t - this.lastAhead > AHEAD_REPEAT_MS) {
        this.lastAhead = t;
        const steerPan = ahead.box.x < 0.5 ? 1 : -1;
        this.audio.lanePing(steerPan, 0.9);
        if (s.trackHaptics && typeof navigator !== 'undefined' && navigator.vibrate) {
          navigator.vibrate(steerPan > 0 ? [60, 40, 60] : [120]);
        }
      }
    } catch {
      /* detector busy/reloading: lane guidance carries on regardless */
    } finally {
      this.detecting = false;
    }
  }
}
