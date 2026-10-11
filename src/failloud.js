// @ts-check
// FailLoud — spoken Alerts with one automatic restart per tripwire (Issue 02).
// Three tripwires, each firing a spoken Alert within 1 second of detection:
//   1. stream ended / video error → immediate restart attempt
//   2. page hidden → Alert at once, restart deferred until visible again
//      (a restart while backgrounded cannot succeed and would waste the
//      single attempt)
//   3. FPS watchdog: no new frame within FRAME_TIMEOUT_MS → restart attempt
// Seam: speak + restart are injected; time is passed in via onFrame()/check()
// so tests stay at the public monitor interface with no timers inside.
// (Polling and exact-timeout scheduling live in main.js.)

/** Spoken Alert when the camera stream drops. */
export const STREAM_LOST_MESSAGE = 'Camera lost. Trying to restart.';

/** Spoken Alert when the page is backgrounded. */
export const PAGE_HIDDEN_MESSAGE = 'EchoPath paused because the page is hidden. Return to EchoPath to resume.';

/** Spoken Alert when no new frame arrives within the watchdog budget. */
export const FRAME_STALLED_MESSAGE = 'No new camera frames. Trying to restart.';

/** Watchdog budget: stall when nowMs - lastFrameAt >= this. */
export const FRAME_TIMEOUT_MS = 1000;

/**
 * @typedef {object} FailLoudDeps
 * @property {(message: string) => void} speak
 * @property {() => void | Promise<void>} restart
 */

/**
 * @param {FailLoudDeps} deps
 */
export function createFailLoudMonitor({ speak, restart }) {
  /** @type {number | null} */
  let lastFrameAt = null;
  let streamAlerted = false;
  let hiddenAlerted = false;
  let stallAlerted = false;
  let restartPendingWhileHidden = false;

  async function tryRestart() {
    try {
      await restart();
    } catch {
      // Restart failure is already announced via speak(); never throw outward.
    }
  }

  async function fireStreamLost() {
    if (streamAlerted) return;
    streamAlerted = true;
    speak(STREAM_LOST_MESSAGE);
    await tryRestart();
  }

  async function onTrackEnded() {
    await fireStreamLost();
  }

  async function onVideoError() {
    await fireStreamLost();
  }

  async function onHidden() {
    if (hiddenAlerted) return;
    hiddenAlerted = true;
    restartPendingWhileHidden = true;
    speak(PAGE_HIDDEN_MESSAGE);
  }

  async function onVisible() {
    hiddenAlerted = false;
    stallAlerted = false;
    if (restartPendingWhileHidden) {
      restartPendingWhileHidden = false;
      await tryRestart();
    }
  }

  /**
   * @param {number} nowMs
   */
  function onFrame(nowMs) {
    lastFrameAt = nowMs;
    stallAlerted = false;
    streamAlerted = false;
  }

  /**
   * Watchdog poll: call on an interval AND via an exact timeout scheduled
   * for lastFrameAt + FRAME_TIMEOUT_MS, so the Alert fires within 1 second
   * of the stall instead of waiting for the next poll tick.
   * @param {number} nowMs
   */
  async function check(nowMs) {
    if (lastFrameAt === null) return;
    if (stallAlerted) return;
    if (nowMs - lastFrameAt >= FRAME_TIMEOUT_MS) {
      stallAlerted = true;
      speak(FRAME_STALLED_MESSAGE);
      await tryRestart();
    }
  }

  function onRecovered() {
    streamAlerted = false;
    hiddenAlerted = false;
    stallAlerted = false;
    restartPendingWhileHidden = false;
  }

  return { onTrackEnded, onVideoError, onHidden, onVisible, onFrame, check, onRecovered };
}
