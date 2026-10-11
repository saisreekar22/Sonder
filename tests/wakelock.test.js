import { describe, it, expect, vi } from 'vitest';
import { createWakeLockController } from '../src/wakelock.js';

describe('WakeLock — hold the screen awake hands-free (Issue 02)', () => {
  it('requests a screen wake lock on request()', async () => {
    const release = vi.fn().mockResolvedValue(undefined);
    const requestLock = vi.fn().mockResolvedValue({ release });
    const c = createWakeLockController({ requestLock });
    await c.request();
    expect(requestLock).toHaveBeenCalledTimes(1);
    expect(requestLock).toHaveBeenCalledWith('screen');
    expect(c.isHeld()).toBe(true);
  });

  it('release() releases the held sentinel and clears held state', async () => {
    const release = vi.fn().mockResolvedValue(undefined);
    const requestLock = vi.fn().mockResolvedValue({ release });
    const c = createWakeLockController({ requestLock });
    await c.request();
    await c.release();
    expect(release).toHaveBeenCalledTimes(1);
    expect(c.isHeld()).toBe(false);
  });

  it('request failure leaves held false instead of throwing', async () => {
    const requestLock = vi.fn().mockRejectedValue(new DOMException('denied', 'NotAllowedError'));
    const onError = vi.fn();
    const c = createWakeLockController({ requestLock, onError });
    await c.request();
    expect(c.isHeld()).toBe(false);
    expect(onError).toHaveBeenCalledTimes(1);
  });

  it('sentinel release event clears held state', async () => {
    let releaseHandler = null;
    const sentinel = {
      release: vi.fn().mockResolvedValue(undefined),
      addEventListener: vi.fn((type, fn) => {
        if (type === 'release') releaseHandler = fn;
      }),
    };
    const c = createWakeLockController({ requestLock: vi.fn().mockResolvedValue(sentinel) });
    await c.request();
    expect(c.isHeld()).toBe(true);
    // @ts-expect-error — invoke captured listener
    releaseHandler();
    expect(c.isHeld()).toBe(false);
  });
});
