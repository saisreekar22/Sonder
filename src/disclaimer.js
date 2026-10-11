// @ts-check
// Disclaimer — first-run spoken supplementary-aid notice (Issue 02).
// System-boundary seam: storage + speech are injected so tests stay at the
// public needsConfirm()/getMessage()/confirm()/speakCurrent() interface.
// Vocabulary per CONTEXT.md: supplementary aid, "nothing detected" (never
// "path clear"), no "obstacle" category label.

/** localStorage key marking the full disclaimer confirmed once per device. */
export const DISCLAIMER_KEY = 'echopath.disclaimer.confirmed.v1';

/** Full first-run spoken disclaimer. Must name the miss classes. */
export const DISCLAIMER_FULL =
  'EchoPath is a supplementary aid only. It can miss glass, stairs, drop-offs, ' +
  'low light hazards, and head-height hazards. Silence means nothing detected, never safe. ' +
  'Press Confirm to continue.';

/** Shortened revisit version (~2 seconds spoken). Keeps the safety core. */
export const DISCLAIMER_SHORT =
  'EchoPath is a supplementary aid. Nothing detected, never safe.';

/**
 * @typedef {object} DisclaimerDeps
 * @property {{ getItem: (key: string) => string | null, setItem: (key: string, value: string) => void }} storage
 * @property {(message: string) => void} speak
 */

/**
 * @param {DisclaimerDeps} deps
 */
export function createDisclaimerController({ storage, speak }) {
  function needsConfirm() {
    return storage.getItem(DISCLAIMER_KEY) !== '1';
  }

  function getMessage() {
    return needsConfirm() ? DISCLAIMER_FULL : DISCLAIMER_SHORT;
  }

  function confirm() {
    storage.setItem(DISCLAIMER_KEY, '1');
  }

  function speakCurrent() {
    speak(getMessage());
  }

  return { needsConfirm, getMessage, confirm, speakCurrent };
}
