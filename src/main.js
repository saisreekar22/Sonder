// @ts-check
// main — Issue 01 wiring: Start button → rear camera → live video,
// full-screen double-tap pause with distinct earcons, spoken retry on denial.

import { createCameraController, DENIED_MESSAGE } from './camera.js';
import { createPauseController } from './pause.js';
import { playPausedEarcon, playResumedEarcon } from './earcons.js';
import { speakMessage } from './speech.js';

const els = () => ({
  start: /** @type {HTMLButtonElement} */ (document.getElementById('start-button')),
  video: /** @type {HTMLVideoElement} */ (document.getElementById('camera-view')),
  status: /** @type {HTMLElement} */ (document.getElementById('status')),
  pauseTarget: /** @type {HTMLButtonElement} */ (document.getElementById('pause-target')),
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

export function initApp(doc = document, nav = navigator) {
  const { start, video, status, pauseTarget } = els();
  /** @type {AudioContext | null} */
  let audioCtx = null;

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

  const pauser = createPauseController({
    onPaused: () => {
      const stream = camera.getStream();
      if (stream) setMediaTracksEnabled(stream, false);
      video.pause();
      if (audioCtx && audioCtx.state === 'running') void audioCtx.suspend();
      playPausedEarcon(getAudio());
      setStatus(status, 'Paused. Double-tap to resume.');
    },
    onResumed: () => {
      const stream = camera.getStream();
      if (stream) setMediaTracksEnabled(stream, true);
      void video.play().catch(() => {});
      playResumedEarcon(getAudio());
      setStatus(status, 'Live camera. Double-tap anywhere to pause.');
    },
  });

  pauseTarget.addEventListener('click', () => pauser.handleTap(performance.now()));
  pauseTarget.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      pauser.toggle();
    }
  });

  start.addEventListener('click', async () => {
    start.disabled = true;
    setStatus(status, 'Starting camera…');
    try {
      getAudio(); // unlock audio inside the user gesture
      const stream = await camera.start();
      const videoEl = /** @type {HTMLVideoElement} */ (
        doc.getElementById('camera-view')
      );
      videoEl.srcObject = stream;
      await videoEl.play();
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

  return { camera, pauser };
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
