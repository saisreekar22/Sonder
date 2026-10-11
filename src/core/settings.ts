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
  /** Stretch: flag fast-approaching surfaces (walls) by image expansion. */
  looming: boolean;
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

  // ---- Track mode -------------------------------------------------------
  /**
   * Which side the drift cue comes from. 'line' = from the line you are
   * drifting onto (like a rumble strip). 'steer' = from the side to move toward.
   */
  trackCueSide: 'line' | 'steer';
  /** Phone vibration on drift (Android; iPhones have no web vibration). */
  trackHaptics: boolean;
  /** Spoken run stats: every lap, every kilometre, every N minutes, or never. */
  trackAnnounce: 'lap' | 'km' | 'time' | 'off';
  trackAnnounceMinutes: number;
  /** Track lap length in metres (standard outdoor track: 400). */
  lapMeters: number;
  /** Running step length in metres, used for distance when GPS is unavailable. */
  runStepLength: number;
  /** Warn when heart rate goes above this (0 = off). */
  maxHeartRate: number;
  /** Also warn about runners/people directly ahead in the lane. */
  trackObstacles: boolean;
  /** Fraction of lane width you can drift from center before any cue. */
  trackDeadband: number;
  disclaimerAccepted: boolean;
  headphoneCheckDone: boolean;
  /** Bumped when defaults change in ways saved settings should pick up. */
  settingsVersion: number;
}

export const SETTINGS_VERSION = 2;

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
  looming: false,
  debugOverlay: false,
  theme: 'auto',
  cameraId: '',
  cameraFacing: 'auto',
  audioOutputId: '',
  mount: 'chest',
  spatialSpread: 2.2,
  heartbeat: false,
  trackCueSide: 'line',
  trackHaptics: true,
  trackAnnounce: 'lap',
  trackAnnounceMinutes: 2,
  lapMeters: 400,
  runStepLength: 1.1,
  maxHeartRate: 0,
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
