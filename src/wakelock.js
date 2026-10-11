// @ts-check
// WakeLock — screen wake-lock adapter (Issue 02).
// Seam: the requestLock function is injected (defaults to
// navigator.wakeLock.request) so tests pass a fake without touching
// browser internals. Failures are silent no-ops reported via onError;
// audible Alerts for backgrounding belong to the fail-loud monitor.

/**
 * @typedef {{ release: () => Promise<void>, addEventListener?: (type: string, listener: () => void) => void }} WakeLockSentinel
 */

/**
 * @typedef {object} WakeLockDeps
 * @property {(type: 'screen') => Promise<WakeLockSentinel>} requestLock
 * @property {(err: unknown) => void} [onError]
 */

/**
 * @param {WakeLockDeps} deps
 */
export function createWakeLockController({ requestLock, onError = () => {} }) {
  /** @type {WakeLockSentinel | null} */
  let sentinel = null;

  async function request() {
    try {
      sentinel = await requestLock('screen');
      if (sentinel && typeof sentinel.addEventListener === 'function') {
        sentinel.addEventListener('release', () => {
          sentinel = null;
        });
      }
    } catch (err) {
      sentinel = null;
      onError(err);
    }
  }

  async function release() {
    if (sentinel) {
      const held = sentinel;
      sentinel = null;
      try {
        await held.release();
      } catch (err) {
        onError(err);
      }
    }
  }

  function isHeld() {
    return sentinel !== null;
  }

  return { request, release, isHeld };
}

/**
 * Default requestLock bound to the real navigator when available.
 * @param {'screen'} type
 * @returns {Promise<WakeLockSentinel>}
 */
export function requestBrowserWakeLock(type) {
  const nav = /** @type {any} */ (globalThis.navigator);
  return nav.wakeLock.request(type);
}
