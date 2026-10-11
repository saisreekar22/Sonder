import { describe, it, expect, vi } from 'vitest';
import {
  DISCLAIMER_FULL,
  DISCLAIMER_SHORT,
  DISCLAIMER_KEY,
  createDisclaimerController,
} from '../src/disclaimer.js';

function fakeStorage(initial = {}) {
  const data = { ...initial };
  return {
    getItem: vi.fn((k) => (k in data ? data[k] : null)),
    setItem: vi.fn((k, v) => {
      data[k] = String(v);
    }),
    _data: data,
  };
}

describe('Disclaimer — first-run spoken supplementary-aid notice (Issue 02)', () => {
  it('full disclaimer states supplementary aid only and lists miss classes', () => {
    expect(DISCLAIMER_FULL).toMatch(/supplementary aid/i);
    for (const word of ['glass', 'stairs', 'drop-offs', 'low light', 'head-height']) {
      expect(DISCLAIMER_FULL.toLowerCase()).toContain(word);
    }
  });

  it('full disclaimer states silence means "nothing detected", never safe', () => {
    expect(DISCLAIMER_FULL).toMatch(/nothing detected/i);
    expect(DISCLAIMER_FULL).not.toMatch(/path clear/i);
    expect(DISCLAIMER_FULL).not.toMatch(/\bobstacle\b/i);
  });

  it('fresh device needs confirmation and speaks the full version', () => {
    const storage = fakeStorage();
    const speak = vi.fn();
    const d = createDisclaimerController({ storage, speak });
    expect(d.needsConfirm()).toBe(true);
    expect(d.getMessage()).toBe(DISCLAIMER_FULL);
    d.speakCurrent();
    expect(speak).toHaveBeenCalledTimes(1);
    expect(speak).toHaveBeenCalledWith(DISCLAIMER_FULL);
  });

  it('confirm() stores a flag so revisit skips the full version', () => {
    const storage = fakeStorage();
    const d = createDisclaimerController({ storage, speak: vi.fn() });
    d.confirm();
    expect(storage.setItem).toHaveBeenCalledWith(DISCLAIMER_KEY, '1');
    expect(d.needsConfirm()).toBe(false);
  });

  it('revisit speaks the shortened version', () => {
    const storage = fakeStorage({ [DISCLAIMER_KEY]: '1' });
    const speak = vi.fn();
    const d = createDisclaimerController({ storage, speak });
    expect(d.needsConfirm()).toBe(false);
    expect(d.getMessage()).toBe(DISCLAIMER_SHORT);
    expect(DISCLAIMER_SHORT).not.toBe(DISCLAIMER_FULL);
    expect(DISCLAIMER_SHORT.length).toBeLessThan(DISCLAIMER_FULL.length);
    d.speakCurrent();
    expect(speak).toHaveBeenCalledWith(DISCLAIMER_SHORT);
  });

  it('short version still states supplementary aid and nothing-detected wording', () => {
    expect(DISCLAIMER_SHORT).toMatch(/supplementary aid/i);
    expect(DISCLAIMER_SHORT).toMatch(/nothing detected/i);
  });
});
