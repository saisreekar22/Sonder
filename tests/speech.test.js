import { describe, it, expect, vi } from 'vitest';
import { speakMessage, isSpeechSupported } from '../src/speech.js';

describe('speech adapter — spoken retry + support check', () => {
  it('reports unsupported when speechSynthesis is absent', () => {
    expect(isSpeechSupported({})).toBe(false);
  });

  it('speaks the exact message passed (TalkBack-independent speechSynthesis path)', () => {
    const speak = vi.fn();
    const Utter = vi.fn(function (text) {
      // @ts-expect-error — fake utterance
      this.text = text;
    });
    const scope = { speechSynthesis: { speak, cancel: vi.fn() }, SpeechSynthesisUtterance: Utter };
    speakMessage(scope, 'hello retry');
    expect(speak).toHaveBeenCalledTimes(1);
    expect(Utter).toHaveBeenCalledWith('hello retry');
  });
});
