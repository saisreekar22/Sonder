import { describe, it, expect, vi } from 'vitest';
import { createDetectorWorkerHandler, createWorkerInference } from '../src/detector-worker.js';

describe('DetectorWorker — inference off the main thread (Issue 03)', () => {
  it('runs detect() and posts boxes with inference timing', async () => {
    const postMessage = vi.fn();
    const detect = vi.fn().mockResolvedValue([
      { x: 0.1, y: 0.1, width: 0.2, height: 0.3, category: 'person', score: 0.9 },
    ]);
    const handler = createDetectorWorkerHandler({ detect, postMessage, now: () => 100 });
    await handler.onMessage({ id: 7, captureAt: 50, frame: { width: 10, height: 10 } });
    expect(detect).toHaveBeenCalledTimes(1);
    expect(postMessage).toHaveBeenCalledTimes(1);
    const msg = postMessage.mock.calls[0][0];
    expect(msg.id).toBe(7);
    expect(msg.captureAt).toBe(50);
    expect(msg.detections).toHaveLength(1);
    expect(typeof msg.inferenceMs).toBe('number');
  });

  it('posts an error result instead of throwing when detect() fails', async () => {
    const postMessage = vi.fn();
    const detect = vi.fn().mockRejectedValue(new Error('model blew up'));
    const handler = createDetectorWorkerHandler({ detect, postMessage, now: () => 0 });
    await handler.onMessage({ id: 1, captureAt: 0, frame: {} });
    expect(postMessage).toHaveBeenCalledTimes(1);
    expect(postMessage.mock.calls[0][0].detections).toEqual([]);
    expect(postMessage.mock.calls[0][0].error).toBeDefined();
  });

  it('worker client resolves inference by message id', async () => {
    const fakeWorker = { postMessage: vi.fn(), _onmessage: null };
    const client = createWorkerInference({
      createWorker: () => fakeWorker,
      now: () => 0,
      transfer: (frame) => frame,
    });
    const pending = client.runInference({ width: 4, height: 4 });
    const sent = fakeWorker.postMessage.mock.calls[0][0];
    fakeWorker._onmessage({ data: { id: sent.id, detections: [], inferenceMs: 5 } });
    await expect(pending).resolves.toEqual([]);
    client.terminate();
  });

  it('worker client exposes last reply meta (model readiness / error)', async () => {
    const fakeWorker = { postMessage: vi.fn(), _onmessage: null };
    const client = createWorkerInference({ createWorker: () => fakeWorker });
    expect(client.getLastMeta()).toMatchObject({ modelReady: false, error: null });
    const pending = client.runInference({ width: 4, height: 4 });
    const sent = fakeWorker.postMessage.mock.calls[0][0];
    fakeWorker._onmessage({ data: { id: sent.id, detections: [], modelReady: true } });
    await pending;
    expect(client.getLastMeta()).toMatchObject({ modelReady: true, error: null });
    const pending2 = client.runInference({ width: 4, height: 4 });
    const sent2 = fakeWorker.postMessage.mock.calls[1][0];
    fakeWorker._onmessage({ data: { id: sent2.id, detections: [], error: 'offline' } });
    await pending2;
    expect(client.getLastMeta()).toMatchObject({ modelReady: false, error: 'offline' });
    client.terminate();
  });
});
