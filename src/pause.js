// @ts-check
// PauseController — full-screen double-tap pause toggle (Issue 01).
// A Track-free seam: pure state machine over tap timestamps, no DOM inside.

/** Max gap between two taps to count as a double-tap. */
export const DOUBLE_TAP_MS = 300;

/**
 * @typedef {object} PauseCallbacks
 * @property {() => void} onPaused
 * @property {() => void} onResumed
 */

/**
 * Create a pause controller. Double-tap (two handleTap calls within
 * DOUBLE_TAP_MS) toggles paused state; toggle() does the same
 * programmatically (keyboard / single-button fallback for TalkBack users).
 *
 * @param {PauseCallbacks} callbacks
 */
export function createPauseController({ onPaused, onResumed }) {
  let paused = false;
  /** @type {number | null} */
  let lastTap = null;

  function toggle() {
    paused = !paused;
    if (paused) onPaused();
    else onResumed();
  }

  /**
   * @param {number} nowMs - tap timestamp in ms (performance.now() / Date.now())
   */
  function handleTap(nowMs) {
    if (lastTap !== null && nowMs - lastTap <= DOUBLE_TAP_MS) {
      lastTap = null;
      toggle();
      return;
    }
    lastTap = nowMs;
  }

  function isPaused() {
    return paused;
  }

  return { toggle, handleTap, isPaused };
}
