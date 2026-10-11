import { describe, it, expect, vi } from 'vitest';
import {
  createFailLoudMonitor,
  STREAM_LOST_MESSAGE,
  PAGE_HIDDEN_MESSAGE,
  FRAME_STALLED_MESSAGE,
  FRAME_TIMEOUT_MS,
} from '../src/failloud.js';

function setup() {
  const speak = vi.fn();
  const restart = vi.fn().mockResolvedValue(undefined);
  const m = createFailLoudMonitor({ speak, restart });
  return { m, speak, restart };
}

describe('FailLoud — spoken Alert within 1s + one restart per tripwire (Issue 02)', () => {
  it('exports the three tripwire messages and a 1s watchdog budget', () => {
    expect(FRAME_TIMEOUT_MS).toBe(1000);
    for (const msg of [STREAM_LOST_MESSAGE, PAGE_HIDDEN_MESSAGE, FRAME_STALLED_MESSAGE]) {
      expect(typeof msg).toBe('string');
      expect(msg.length).toBeGreaterThan(0);
    }
  });

  it('stream-ended tripwire speaks and attempts one restart', async () => {
    const { m, speak, restart } = setup();
    await m.onTrackEnded();
    expect(speak).toHaveBeenCalledTimes(1);
    expect(speak).toHaveBeenCalledWith(STREAM_LOST_MESSAGE);
    expect(restart).toHaveBeenCalledTimes(1);
  });

  it('video-error tripwire speaks and attempts one restart', async () => {
    const { m, speak, restart } = setup();
    await m.onVideoError();
    expect(speak).toHaveBeenCalledWith(STREAM_LOST_MESSAGE);
    expect(restart).toHaveBeenCalledTimes(1);
  });

  it('page-hidden tripwire speaks promptly and defers the restart until visible', async () => {
    const { m, speak, restart } = setup();
    await m.onHidden();
    expect(speak).toHaveBeenCalledWith(PAGE_HIDDEN_MESSAGE);
    expect(restart).not.toHaveBeenCalled();
    await m.onVisible();
    expect(restart).toHaveBeenCalledTimes(1);
  });

  it('recovery before returning visible cancels the deferred restart', async () => {
    const { m, restart } = setup();
    await m.onHidden();
    m.onRecovered();
    await m.onVisible();
    expect(restart).not.toHaveBeenCalled();
  });

  it('fps watchdog fires when no frame arrives within 1 second', async () => {
    const { m, speak, restart } = setup();
    m.onFrame(0);
    await m.check(999);
    expect(speak).not.toHaveBeenCalled();
    await m.check(1000);
    expect(speak).toHaveBeenCalledWith(FRAME_STALLED_MESSAGE);
    expect(restart).toHaveBeenCalledTimes(1);
  });

  it('each tripwire restarts at most once until reset by recovery', async () => {
    const { m, speak, restart } = setup();
    await m.onTrackEnded();
    await m.onTrackEnded();
    expect(restart).toHaveBeenCalledTimes(1);
    expect(speak).toHaveBeenCalledTimes(1);
    m.onRecovered();
    await m.onTrackEnded();
    expect(restart).toHaveBeenCalledTimes(2);
  });

  it('frames after a stall reset the watchdog so a new stall can fire', async () => {
    const { m, speak, restart } = setup();
    m.onFrame(0);
    await m.check(1000);
    expect(restart).toHaveBeenCalledTimes(1);
    m.onFrame(1500);
    await m.check(2000);
    expect(speak).toHaveBeenCalledTimes(1);
    await m.check(2500);
    expect(speak).toHaveBeenCalledTimes(2);
    expect(restart).toHaveBeenCalledTimes(2);
  });

  it('restart failure does not throw out of the monitor', async () => {
    const speak = vi.fn();
    const restart = vi.fn().mockRejectedValue(new Error('no camera'));
    const m = createFailLoudMonitor({ speak, restart });
    await expect(m.onTrackEnded()).resolves.toBeUndefined();
    expect(speak).toHaveBeenCalledTimes(1);
  });
});
