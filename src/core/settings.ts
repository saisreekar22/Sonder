import type { AudioMode, ModelId, Sensitivity, SoundStyle, Verbosity } from './types';
import type { CueDensity } from '../cues/policy';

export interface Settings {
  /** Which half of the app: everyday walking, or lane guidance on a running track. */
  activity: Activity;
  mode: AudioMode;
  /** How often cues sound while walking. Calm is the everyday default. */
  cueDensity: CueDensity;
  /** 0..1 of the safe maximum gain. The safe ceiling itself cannot be raised. */
  volume: number;
  sensitivity: Sensitivity;
  soundStyle: SoundStyle;
  verbosity: Verbosity;
  /** Speak system guidance (start, pause, errors). Turn off if a screen reader already reads it. */
  voiceGuidance: boolean;
  model: ModelId;
  /** Camera field of view along the frame's long side, in degrees. */
  fovDeg: number;
  /** Fraction of frame width treated as the walking corridor. */
  corridorWidth: number;
  /** Fraction of frame width that counts as the center zone. */
  centerWidth: number;
  /** Center-zone obstacle closer than this (metres) means "blocked path". */
  blockDistance: number;
  /**
   * Locust-inspired looming detector: warns about anything rushing toward you,
   * even objects the detector can't name (poles, doors, branches).
   */
  looming: boolean;
  /** Use the ultra-wide camera zoom where the phone supports it (wider view). */
  wideAngle: boolean;
  debugOverlay: boolean;
  /** 'auto' follows the device's light/dark setting. */
  theme: 'auto' | 'light' | 'dark';
  /** Specific camera (deviceId), or '' for automatic (rear camera on phones). */
  cameraId: string;
  /**
   * Which way the camera points relative to the listener. 'toward' (a laptop
   * webcam facing you) mirrors left/right so cues match YOUR left and right.
   * 'auto' decides from the camera: rear/environment = same way, otherwise toward.
   */
  cameraFacing: 'auto' | 'same' | 'toward';
  /** Audio output device (e.g. Bluetooth headphones), or '' for system default. */
  audioOutputId: string;
  /**
   * Where the phone is worn. Chest/waist mounts use press-and-hold to pause
   * (so bumps and clothing can't toggle it) and turn on walking detection
   * and tilt guidance.
   */
  mount: Mount;
  /**
   * Widens directions in spatial mode. The camera only sees about +/-32 deg,
   * and real HRTF at 20-30 deg sounds almost centered on earbuds, so camera
   * angles are scaled up (2 = something at the frame edge sounds ~65 deg off
   * to that side). 1 = physically accurate.
   */
  spatialSpread: number;
  /** A very soft tick every few seconds so the wearer knows EchoPath is still working. */
  heartbeat: boolean;
  /**
   * 'surround': "8D" 360-degree scene - every nearby thing has its own soft,
   * continuous sound that moves around you in real time (cues play on top).
   * 'cues': only the event cues.
   */
  soundScene: 'surround' | 'cues';
  /** Loudness of the surround scene, 0..1. */
  sceneLevel: number;
  /**
   * Virtual white cane: depth AI (no LiDAR needed) finds ANY obstacle in your
   * path - walls, poles, doors, head-height branches - as a sonar tone.
   */
  depthCane: boolean;
  /** Synthetic echolocation click every N seconds (0 = off). */
  echoEverySec: number;
  /** Audio buffer: 'auto' picks larger buffers for Bluetooth to stop crackle. */
  latencyMode: 'auto' | 'interactive' | 'balanced' | 'playback';
  /** Keep Bluetooth headphones awake with an inaudible signal. */
  btKeepAlive: boolean;
  /** Start in the spoken, tap-anywhere voice menu (eyes-free). */
  voiceMenu: boolean;

  // ---- Track mode -------------------------------------------------------
  /**
   * Course: 'lanes' = two lane lines (running track), 'line' = run along one
   * painted guide line (guide-line style / a road race's racing line),
   * 'edge' = keep a kerb or edge line on one side (road races).
   */
  trackCourse: 'lanes' | 'line' | 'edge';
  /** Paint colour of the line(s) to follow. */
  lineColor: 'white' | 'yellow' | 'blue' | 'any';
  /** 'edge' course: which side the kerb/edge line stays on. */
  edgeSide: 'left' | 'right';
  /**
   * Drift feedback style:
   *  'rumble'    - clicks from the line you're drifting onto (like a rumble strip)
   *  'guideline' - guide-line style: beeps on the side to steer
   *                toward, faster with drift, high warning at the edge
   *  'tone'      - one continuous quiet tone; drifting moves it to the line's
   *                side and makes it louder and dissonant
   */
  trackStyle: 'pg' | 'glide' | 'rumble' | 'guideline' | 'tone';
  /** Strength of the "ear vibration" buzz on the side to turn toward (0 = off). */
  earVibration: number;
  /** 360 guide beacon at the point ahead to run toward. */
  runBeacon: boolean;
  /** Camera height above the ground (m): chest ~1.3, waist ~1.0. Used to measure the line in metres. */
  mountHeight: number;
  /** 'edge' course: how far to keep from the kerb/edge line (m). */
  edgeGap: number;
  /** Target pace, seconds per km (0 = no pace coaching). */
  targetPaceS: number;
  /** Cadence metronome, steps per minute (0 = off). */
  metronomeSpm: number;
  /** "3, 2, 1, go" before guidance starts. */
  trackCountdown: boolean;
  /** Phone vibration on drift (Android; iPhones have no web vibration). */
  trackHaptics: boolean;
  /** Spoken run stats: every lap, every kilometre, every N minutes, or never. */
  trackAnnounce: 'lap' | 'km' | 'time' | 'off';
  trackAnnounceMinutes: number;
  /** Track lap length in metres (standard outdoor track: 400). */
  lapMeters: number;
  /** Running step length in metres, used for distance when GPS is unavailable. */
  runStepLength: number;
  /** Also warn about runners/people directly ahead in the lane. */
  trackObstacles: boolean;
  /** Fraction of lane width you can drift from center before any cue. */
  trackDeadband: number;
  disclaimerAccepted: boolean;
  headphoneCheckDone: boolean;
  /** Bumped when defaults change in ways saved settings should pick up. */
  settingsVersion: number;
}

export const SETTINGS_VERSION = 8;

export type Mount = 'chest' | 'waist' | 'hand' | 'table';
export type Activity = 'walk' | 'track';

/** Worn on the body: hands-free walking. */
export const isWorn = (m: Mount) => m === 'chest' || m === 'waist';

export const DEFAULT_SETTINGS: Settings = {
  activity: 'walk',
  mode: 'spatial',
  cueDensity: 'calm',
  volume: 0.8,
  sensitivity: 'medium',
  soundStyle: 'classic',
  verbosity: 'off',
  voiceGuidance: true,
  // Most accurate model by default; drops to Lite0 automatically if the device is slow.
  model: 'efficientdet_lite2',
  fovDeg: 65,
  corridorWidth: 0.9,
  centerWidth: 0.34,
  blockDistance: 2,
  looming: true,
  wideAngle: true,
  debugOverlay: false,
  theme: 'auto',
  cameraId: '',
  cameraFacing: 'auto',
  audioOutputId: '',
  mount: 'chest',
  spatialSpread: 2.2,
  heartbeat: false,
  soundScene: 'cues',
  sceneLevel: 0.5,
  depthCane: true,
  echoEverySec: 0,
  latencyMode: 'auto',
  btKeepAlive: true,
  voiceMenu: true,
  trackCourse: 'lanes',
  lineColor: 'white',
  edgeSide: 'left',
  trackStyle: 'pg',
  earVibration: 0.5,
  runBeacon: false,
  mountHeight: 1.3,
  edgeGap: 0.6,
  targetPaceS: 0,
  metronomeSpm: 0,
  trackCountdown: true,
  trackHaptics: true,
  trackAnnounce: 'lap',
  trackAnnounceMinutes: 2,
  lapMeters: 400,
  runStepLength: 1.1,
  trackObstacles: true,
  trackDeadband: 0.12,
  disclaimerAccepted: false,
  headphoneCheckDone: false,
  settingsVersion: SETTINGS_VERSION,
};

/** Thresholds derived from the sensitivity setting. */
export function sensitivityParams(s: Sensitivity) {
  return {
    low: { minScore: 0.55, minHeight: 0.2 },
    medium: { minScore: 0.5, minHeight: 0.12 },
    high: { minScore: 0.35, minHeight: 0.07 },
  }[s];
}

const KEY = 'echopath.settings.v1';

export function loadSettings(): Settings {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) return migrate({ ...DEFAULT_SETTINGS, ...(JSON.parse(raw) as Partial<Settings>) }, JSON.parse(raw));
  } catch {
    /* storage blocked or corrupt: fall back to defaults */
  }
  return { ...DEFAULT_SETTINGS };
}

/**
 * v1 -> v2: calmer, more accurate defaults. Saved v1 settings had the old
 * defaults written into them (fast model, heartbeat on), so move those to
 * the new defaults unless the user had changed them.
 */
export function migrate(s: Settings, raw: Partial<Settings>): Settings {
  if ((raw.settingsVersion ?? 1) < 2) {
    if (raw.model === 'efficientdet_lite0') s.model = DEFAULT_SETTINGS.model;
    if (raw.heartbeat === true) s.heartbeat = DEFAULT_SETTINGS.heartbeat;
  }
  if ((raw.settingsVersion ?? 1) < 3) {
    // v3: the looming pathway is now the robust LGMD model, on by default.
    if (raw.looming === false) s.looming = DEFAULT_SETTINGS.looming;
  }
  if ((raw.settingsVersion ?? 1) < 4) {
    // v4: "cue side" became feedback styles; steer-side cues = Guideline style.
    if ((raw as { trackCueSide?: string }).trackCueSide === 'steer') s.trackStyle = 'guideline';
    delete (s as { trackCueSide?: string }).trackCueSide;
  }
  if ((raw.settingsVersion ?? 1) < 5) {
    // v5: smooth gliding tone is the new default (no abrupt beeps).
    if (!raw.trackStyle || raw.trackStyle === 'rumble') s.trackStyle = 'glide';
  }
  if ((raw.settingsVersion ?? 1) < 6) {
    // v6: the guide-line system's own sounds are the default.
    if (!raw.trackStyle || raw.trackStyle === 'glide' || raw.trackStyle === 'rumble') s.trackStyle = 'pg';
  }
  // v7: the purple guide-line option was removed; a saved purple becomes yellow.
  if ((s.lineColor as string) === 'purple') s.lineColor = 'yellow';
  // v8: calm by default - no constant sounds. Surround presences and the run
  // beacon play all the time, so they are off; cues are calm.
  if ((raw.settingsVersion ?? 1) < 8) {
    s.soundScene = 'cues';
    s.runBeacon = false;
    s.cueDensity = 'calm';
  }
  // v7: heart-rate features removed.
  delete (s as unknown as Record<string, unknown>).hrMax;
  delete (s as unknown as Record<string, unknown>).maxHeartRate;
  s.settingsVersion = SETTINGS_VERSION;
  return s;
}

export function saveSettings(s: Settings): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(s));
  } catch {
    /* private mode etc.: settings just won't persist */
  }
}
