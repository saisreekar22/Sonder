import { describe, it, expect, vi } from 'vitest';
import { createPauseController, DOUBLE_TAP_MS } from '../src/pause.js';

describe('PauseController — full-screen double-tap pause toggle', () => {
  it('starts running, not paused', () => {
    const c = createPauseController({ onPaused: () => {}, onResumed: () => {} });
    expect(c.isPaused()).toBe(false);
  });

  it('two taps within the double-tap window pause everything', () => {
    const onPaused = vi.fn();
    const c = createPauseController({ onPaused, onResumed: () => {} });
    c.handleTap(1000);
    c.handleTap(1000 + DOUBLE_TAP_MS - 50);
    expect(c.isPaused()).toBe(true);
    expect(onPaused).toHaveBeenCalledTimes(1);
  });

  it('two taps further apart than the window do not toggle', () => {
    const onPaused = vi.fn();
    const c = createPauseController({ onPaused, onResumed: () => {} });
    c.handleTap(0);
    c.handleTap(DOUBLE_TAP_MS + 100);
    expect(c.isPaused()).toBe(false);
    expect(onPaused).not.toHaveBeenCalled();
  });

  it('a second double-tap resumes', () => {
    const onPaused = vi.fn();
    const onResumed = vi.fn();
    const c = createPauseController({ onPaused, onResumed });
    c.handleTap(0);
    c.handleTap(200); // → paused
    expect(c.isPaused()).toBe(true);
    c.handleTap(2000);
    c.handleTap(2200); // → resumed
    expect(c.isPaused()).toBe(false);
    expect(onResumed).toHaveBeenCalledTimes(1);
  });

  it('single taps never fire a callback by themselves', () => {
    const onPaused = vi.fn();
    const onResumed = vi.fn();
    const c = createPauseController({ onPaused, onResumed });
    c.handleTap(5000);
    expect(onPaused).not.toHaveBeenCalled();
    expect(onResumed).not.toHaveBeenCalled();
  });

  it('programmatic toggle() pauses and resumes with matching callbacks', () => {
    const onPaused = vi.fn();
    const onResumed = vi.fn();
    const c = createPauseController({ onPaused, onResumed });
    c.toggle();
    expect(c.isPaused()).toBe(true);
    expect(onPaused).toHaveBeenCalledTimes(1);
    c.toggle();
    expect(c.isPaused()).toBe(false);
    expect(onResumed).toHaveBeenCalledTimes(1);
  });
});
