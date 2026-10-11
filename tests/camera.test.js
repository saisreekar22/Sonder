import { describe, it, expect, vi } from 'vitest';
import { createCameraController, CAMERA_CONSTRAINTS, DENIED_MESSAGE } from '../src/camera.js';

function fakeStream() {
  const stop = vi.fn();
  return { getTracks: () => [{ stop, enabled: true }], _stop: stop };
}

describe('CameraController — rear camera by default, spoken retry on denial', () => {
  it('requests the rear camera (environment facingMode)', async () => {
    const stream = fakeStream();
    const getUserMedia = vi.fn().mockResolvedValue(stream);
    const speak = vi.fn();
    const cam = createCameraController({ getUserMedia, speak });
    await cam.start();
    expect(getUserMedia).toHaveBeenCalledTimes(1);
    const constraints = getUserMedia.mock.calls[0][0];
    expect(constraints.video.facingMode.ideal).toBe('environment');
    expect(cam.getStream()).toBe(stream);
  });

  it('exposes the default constraints used for the rear camera', () => {
    expect(CAMERA_CONSTRAINTS.video.facingMode.ideal).toBe('environment');
  });

  it('speaks a retry message when permission is denied', async () => {
    const err = new DOMException('Permission denied', 'NotAllowedError');
    const getUserMedia = vi.fn().mockRejectedValue(err);
    const speak = vi.fn();
    const cam = createCameraController({ getUserMedia, speak });
    await expect(cam.start()).rejects.toMatchObject({ name: 'NotAllowedError' });
    expect(speak).toHaveBeenCalledTimes(1);
    expect(speak.mock.calls[0][0]).toContain('Camera permission was denied');
  });

  it('denied message under test is the exported DENIED_MESSAGE', async () => {
    const err = new DOMException('denied', 'NotAllowedError');
    const getUserMedia = vi.fn().mockRejectedValue(err);
    const speak = vi.fn();
    const cam = createCameraController({ getUserMedia, speak });
    await expect(cam.start()).rejects.toBeDefined();
    expect(speak).toHaveBeenCalledWith(DENIED_MESSAGE);
    expect(DENIED_MESSAGE).toContain('Settings');
  });

  it('stop() releases all tracks and clears the stream', async () => {
    const stream = fakeStream();
    const getUserMedia = vi.fn().mockResolvedValue(stream);
    const cam = createCameraController({ getUserMedia, speak: vi.fn() });
    await cam.start();
    cam.stop();
    expect(stream._stop).toHaveBeenCalledTimes(1);
    expect(cam.getStream()).toBeNull();
  });
});
