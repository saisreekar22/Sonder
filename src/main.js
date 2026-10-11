// @ts-check
// main — Issue 01 + 02 wiring: Start button → rear camera → live video,
// full-screen double-tap pause with distinct earcons, spoken retry on denial,
// plus first-run disclaimer gate, screen Wake Lock, and fail-loud Alerts.

import { createCameraController, DENIED_MESSAGE } from './camera.js';
import { createPauseController } from './pause.js';
import { playPausedEarcon, playResumedEarcon } from './earcons.js';
import { speakMessage } from './speech.js';
import { createDisclaimerController } from './disclaimer.js';
import { createWakeLockController, requestBrowserWakeLock } from './wakelock.js';
import { createFailLoudMonitor, FRAME_TIMEOUT_MS } from './failloud.js';
import { createDetectionPipeline } from './pipeline.js';
import { createWorkerInference } from './detector-worker.js';
import { createDebugOverlay } from './debug-overlay.js';
import { createTracker, selectCueSources } from './tracker.js';
import { DEFAULT_CORRIDOR_WIDTH, DEFAULT_MIN_HEIGHT_FRACTION } from './zones.js';

const els = () => ({
  start: /** @type {HTMLButtonElement} */ (document.getElementById('start-button')),
  video: /** @type {HTMLVideoElement} */ (document.getElementById('camera-view')),
  status: /** @type {HTMLElement} */ (document.getElementById('status')),
  pauseTarget: /** @type {HTMLButtonElement} */ (document.getElementById('pause-target')),
  disclaimerOverlay:
    /** @type {HTMLElement} */ (document.getElementById('disclaimer-overlay')),
  disclaimerText:
    /** @type {HTMLElement} */ (document.getElementById('disclaimer-text')),
  disclaimerConfirm:
    /** @type {HTMLButtonElement} */ (document.getElementById('disclaimer-confirm')),
  debugCanvas: /** @type {HTMLCanvasElement} */ (document.getElementById('debug-overlay')),
  debugReadout: /** @type {HTMLElement} */ (document.getElementById('debug-readout')),
  debugToggle:
    /** @type {HTMLButtonElement} */ (document.getElementById('debug-toggle')),
  debugSettings:
    /** @type {HTMLElement} */ (document.getElementById('debug-settings')),
  corridorWidth:
    /** @type {HTMLInputElement} */ (document.getElementById('corridor-width')),
  minSize:
    /** @type {HTMLInputElement} */ (document.getElementById('min-size')),
});

/** Mirror a message into the TalkBack live region (no speech).
 * @param {HTMLElement} statusEl
 * @param {string} message
 */
function setStatus(statusEl, message) {
  statusEl.textContent = message;
}

/** Speak via speechSynthesis AND mirror into the TalkBack live region.
 * @param {HTMLElement} statusEl
 * @param {string} message
 */
function announce(statusEl, message) {
  setStatus(statusEl, message);
  speakMessage(globalThis, message);
}

/**
 * Enable/disable every MediaStreamTrack (named to avoid the domain Track term).
 * @param {MediaStream} stream
 * @param {boolean} enabled
 */
function setMediaTracksEnabled(stream, enabled) {
  for (const mediaTrack of stream.getTracks()) mediaTrack.enabled = enabled;
}

/**
 * localStorage bound to the seam the disclaimer controller expects.
 * Falls back to an in-memory shim when storage is unavailable.
 */
function getDisclaimerStorage() {
  try {
    const ls = globalThis.localStorage;
    if (ls && typeof ls.getItem === 'function') return ls;
  } catch {
    // fall through to shim
  }
  /** @type {Record<string, string>} */
  const mem = {};
  return {
    getItem: (/** @type {string} */ k) => (k in mem ? mem[k] : null),
    setItem: (/** @type {string} */ k, /** @type {string} */ v) => {
      mem[k] = String(v);
    },
  };
}

export function initApp(doc = document, nav = navigator) {
  const {
    start,
    video,
    status,
    pauseTarget,
    disclaimerOverlay,
    disclaimerText,
    disclaimerConfirm,
    debugCanvas,
    debugReadout,
    debugToggle,
    debugSettings,
    corridorWidth,
    minSize,
  } = els();
  /** @type {AudioContext | null} */
  let audioCtx = null;
  /** @type {number | null} */
  let watchdogTimer = null;
  /** @type {number | null} */
  let stallTimer = null;
  let lastVideoTime = -1;
  let running = false;

  const getAudio = () => {
    if (!audioCtx) {
      const AC = globalThis.AudioContext || /** @type {any} */ (globalThis).webkitAudioContext;
      audioCtx = new AC();
    }
    if (audioCtx.state === 'suspended') void audioCtx.resume();
    return audioCtx;
  };

  const camera = createCameraController({
    getUserMedia: (c) => nav.mediaDevices.getUserMedia(c),
    speak: (msg) => announce(status, msg),
  });

  const disclaimer = createDisclaimerController({
    storage: getDisclaimerStorage(),
    speak: (msg) => announce(status, msg),
  });

  const wakelock = createWakeLockController({
    requestLock: () => {
      const holder = /** @type {any} */ (nav);
      if (holder && holder.wakeLock && typeof holder.wakeLock.request === 'function') {
        return holder.wakeLock.request('screen');
      }
      return requestBrowserWakeLock('screen');
    },
  });

  // Issue 03: detector pipeline + sighted-only debug overlay.
  // Overlay is off by default (?debug=1 opts in); audio Cues never depend
  // on it. Detection runs in a worker; stale frames (>200 ms) are dropped.
  // Issue 04: raw Detections flow through the IoU + constant-velocity
  // tracker for stable Track IDs, Zones, distance bands, and rate-limited
  // Cue gating (max three simultaneous Cue sources for Issue 05).
  const debug = createDebugOverlay({ canvas: debugCanvas, readout: debugReadout });
  // Live on-screen sliders (Issue 04): single reader so the init
  // options, per-frame tracker update, and overlay render stay in sync.
  // Sighted-only tuning; audio Cues never depend on overlay visibility.
  function readSliderOpts() {
    return {
      corridorWidth: Number(corridorWidth?.value) || DEFAULT_CORRIDOR_WIDTH,
      minHeightFraction: Number(minSize?.value) || DEFAULT_MIN_HEIGHT_FRACTION,
    };
  }
  const tracker = createTracker(readSliderOpts());
  /** Latest Cue-ready Tracks for the Issue 05 cue engine. @type {any[]} */
  let cueSources = [];
  const getCueSources = () => [...cueSources];
  /** @type {any} */
  let workerClient = null;
  /** @type {any} */
  let pipeline = null;
  /** @type {number | null} */
  let detectRaf = null;

  function sizeDebugCanvas() {
    if (!debugCanvas || !debug.isVisible()) return;
    const w = video.videoWidth || debugCanvas.clientWidth || 640;
    const h = video.videoHeight || debugCanvas.clientHeight || 480;
    if (debugCanvas.width !== w) debugCanvas.width = w;
    if (debugCanvas.height !== h) debugCanvas.height = h;
  }

  function stopDetectionLoop() {
    if (detectRaf !== null && typeof cancelAnimationFrame === 'function') {
      cancelAnimationFrame(detectRaf);
      detectRaf = null;
    }
  }

  function tickDetectionLoop() {
    detectRaf = null;
    if (!running || !pipeline || pauserRef === null || pauserRef.isPaused()) return;
    const CIB = /** @type {any} */ (globalThis).createImageBitmap;
    if (typeof CIB === 'function' && video.readyState >= 2) {
      CIB(video)
        .then((/** @type {any} */ bmp) => pipeline.submit(bmp))
        .catch(() => {});
    }
    if (typeof requestAnimationFrame === 'function') {
      detectRaf = requestAnimationFrame(tickDetectionLoop);
    }
  }

  function startDetectionLoop() {
    if (pipeline || typeof document === 'undefined') return;
    try {
      workerClient = createWorkerInference({
        fallbackDetect: async () => [],
      });
      const localClient = workerClient;
      pipeline = createDetectionPipeline({
        runInference: (frame) => localClient.runInference(frame),
        onResult: ({ detections, latencyMs, inferenceMs }) => {
          const frameHeightPx = debugCanvas?.height || video.videoHeight || 480;
          const sliderOpts = readSliderOpts();
          const tracks = tracker.update(detections ?? [], {
            frameHeightPx,
            ...sliderOpts,
          });
          // Rate-limited Cue set for the Issue 05 cue engine (max three).
          cueSources = selectCueSources(tracks);
          if (!debug.isVisible()) return;
          sizeDebugCanvas();
          const stats = pipeline ? pipeline.getStats() : null;
          debug.render({
            detections: tracks,
            fps: stats ? stats.fps : null,
            latencyMs,
            inferenceMs,
            corridorWidth: sliderOpts.corridorWidth,
          });
        },
      });
      // ?debug=1 opts the sighted overlay in; default stays off.
      try {
        const params = new URLSearchParams(globalThis.location.search);
        if (params.get('debug') === '1') {
          debug.setVisible(true);
          if (debugSettings) debugSettings.hidden = false;
        }
      } catch {
        // Non-browser / test context: overlay stays off.
      }
      if (typeof requestAnimationFrame === 'function') {
        detectRaf = requestAnimationFrame(tickDetectionLoop);
      }
    } catch {
      pipeline = null;
    }
  }

  /** Assigned after the pauser exists so the loop can observe pause state. */
  /** @type {any} */
  let pauserRef = null;

  async function attachStreamToVideo(/** @type {MediaStream} */ stream) {
    video.srcObject = stream;
    await video.play();
  }

  /** Single acquisition path shared by Start and the fail-loud restart. */
  async function acquireLiveCamera() {
    const stream = await camera.start();
    await attachStreamToVideo(stream);
    watchStream(stream);
    running = true;
    return stream;
  }

  /** Exact watchdog timeout so the stall Alert fires within 1 second of the
   * last frame instead of waiting for the next poll tick. */
  function scheduleStallCheck() {
    if (stallTimer !== null) globalThis.clearTimeout(stallTimer);
    stallTimer = globalThis.setTimeout(() => {
      if (running && !pauser.isPaused()) void failLoud.check(performance.now());
    }, FRAME_TIMEOUT_MS);
  }

  function noteFrame(/** @type {number} */ nowMs) {
    failLoud.onFrame(nowMs);
    scheduleStallCheck();
  }

  async function restartLiveCamera() {
    try {
      camera.stop();
      await acquireLiveCamera();
      failLoud.onRecovered();
      noteFrame(performance.now());
      lastVideoTime = video.currentTime;
      setStatus(status, 'Live camera. Double-tap anywhere to pause.');
    } catch {
      setStatus(status, 'Camera failed to restart. Press Start to try again.');
    }
  }

  const failLoud = createFailLoudMonitor({
    speak: (msg) => announce(status, msg),
    restart: () => restartLiveCamera(),
  });

  /** Watch a stream for the ended/video-error tripwires, including
   * tracks added after acquisition. */
  function watchStream(/** @type {MediaStream} */ stream) {
    const watchMediaTrack = (/** @type {MediaStreamTrack} */ mediaTrack) => {
      mediaTrack.addEventListener('ended', () => {
        void failLoud.onTrackEnded();
      });
    };
    for (const mediaTrack of stream.getTracks()) watchMediaTrack(mediaTrack);
    if (typeof stream.addEventListener === 'function') {
      stream.addEventListener('addtrack', (/** @type {any} */ e) => {
        if (e && e.track) watchMediaTrack(e.track);
      });
    }
  }

  video.addEventListener('error', () => {
    void failLoud.onVideoError();
  });

  doc.addEventListener('visibilitychange', () => {
    if (doc.hidden) {
      void failLoud.onHidden();
    } else {
      void failLoud.onVisible();
      if (running && !pauser.isPaused()) void wakelock.request();
    }
  });

  function startWatchdog() {
    if (watchdogTimer !== null) return;
    lastVideoTime = video.currentTime;
    noteFrame(performance.now());
    watchdogTimer = globalThis.setInterval(() => {
      if (!running || pauser.isPaused()) return;
      const now = performance.now();
      if (video.currentTime !== lastVideoTime) {
        lastVideoTime = video.currentTime;
        noteFrame(now);
      } else {
        void failLoud.check(now);
      }
    }, 250);
  }

  const pauser = createPauseController({
    onPaused: () => {
      stopDetectionLoop();
      const stream = camera.getStream();
      if (stream) setMediaTracksEnabled(stream, false);
      video.pause();
      if (audioCtx && audioCtx.state === 'running') void audioCtx.suspend();
      void wakelock.release();
      playPausedEarcon(getAudio());
      setStatus(status, 'Paused. Double-tap to resume.');
    },
    onResumed: () => {
      const stream = camera.getStream();
      if (stream) setMediaTracksEnabled(stream, true);
      void video.play().catch(() => {});
      void wakelock.request();
      noteFrame(performance.now());
      playResumedEarcon(getAudio());
      setStatus(status, 'Live camera. Double-tap anywhere to pause.');
      if (pipeline && typeof requestAnimationFrame === 'function' && detectRaf === null) {
        detectRaf = requestAnimationFrame(tickDetectionLoop);
      }
    },
  });
  pauserRef = pauser;

  if (debugToggle) {
    debugToggle.addEventListener('click', () => {
      debug.setVisible(!debug.isVisible());
      if (debugSettings) debugSettings.hidden = !debug.isVisible();
      sizeDebugCanvas();
    });
  }

  pauseTarget.addEventListener('click', () => pauser.handleTap(performance.now()));
  pauseTarget.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      pauser.toggle();
    }
  });

  // Disclaimer gate: fresh devices confirm once; revisits hear the short version.
  disclaimerText.textContent = disclaimer.getMessage();
  if (disclaimer.needsConfirm()) {
    disclaimerOverlay.hidden = false;
    start.hidden = true;
    disclaimer.speakCurrent();
    disclaimerConfirm.addEventListener('click', () => {
      disclaimer.confirm();
      disclaimerOverlay.hidden = true;
      start.hidden = false;
      setStatus(status, 'Press Start, then allow the camera.');
      start.focus();
    });
  } else {
    disclaimerOverlay.hidden = true;
    disclaimer.speakCurrent();
  }

  start.addEventListener('click', async () => {
    start.disabled = true;
    setStatus(status, 'Starting camera…');
    try {
      getAudio(); // unlock audio inside the user gesture
      await acquireLiveCamera();
      await wakelock.request();
      failLoud.onRecovered();
      startWatchdog();
      startDetectionLoop();
      pauseTarget.hidden = false;
      start.hidden = true;
      setStatus(status, 'Live camera. Double-tap anywhere to pause.');
    } catch (err) {
      start.disabled = false;
      if (err && typeof err === 'object' && /** @type {any} */ (err).name !== 'NotAllowedError') {
        setStatus(status, 'Camera failed to start. Press Start to try again.');
      } else {
        // NotAllowedError already announced with DENIED_MESSAGE via speak().
        setStatus(status, DENIED_MESSAGE);
      }
    }
  });

  return { camera, pauser, disclaimer, wakelock, failLoud, debug, tracker, getCueSources };
}

const isNode = typeof /** @type {any} */ (globalThis)['process'] !== 'undefined';
if (typeof document !== 'undefined' && !isNode) {
  document.addEventListener('DOMContentLoaded', () => {
    initApp();
    if ('serviceWorker' in navigator) {
      window.addEventListener('load', () => {
        navigator.serviceWorker.register('./sw.js').catch(() => {});
      });
    }
  });
}
