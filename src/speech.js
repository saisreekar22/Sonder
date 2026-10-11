// @ts-check
// speech adapter — thin wrapper over speechSynthesis (Issue 01).
// System boundary: the synthesis scope is injected so tests pass a fake.

/**
 * @param {any} scope - window-like object (defaults to globalThis)
 * @returns {boolean}
 */
export function isSpeechSupported(scope = globalThis) {
  return Boolean(scope && scope.speechSynthesis && scope.SpeechSynthesisUtterance);
}

/**
 * Speak a message aloud (denied-permission retry in Issue 01;
 * fail-loud Alerts in Issue 02).
 * Cancels any queued utterance first so urgent messages interrupt earlier ones.
 *
 * @param {any} scope
 * @param {string} message
 */
export function speakMessage(scope = globalThis, message) {
  if (!isSpeechSupported(scope)) return;
  scope.speechSynthesis.cancel();
  scope.speechSynthesis.speak(new scope.SpeechSynthesisUtterance(message));
}
