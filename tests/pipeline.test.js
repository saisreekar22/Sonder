import { describe, it, expect, vi } from 'vitest';
import { createDetectionPipeline, MAX_FRAME_AGE_MS } from '../src/pipeline.js';

describe('DetectionPipeline — worker transfer with 200ms backpressure drop (Issue 03)', () => {
  it('exports the 200ms backpressure budget', () => {
    expect(MAX_FRAME_AGE_MS).toBe(200);
  });

  it('delivers fresh inference results to onResult', async () => {
    const now = { t: 0 };
    const runInference = vi.fn().mockResolvedValue([{ x: 0, y: 0, width: 0.2, height: 0.2, category: 'person', score: 0.9 }]);
    const onResult = vi.fn();
    const pipe = createDetectionPipeline({
      runInference,
      now: () => now.t,
      onResult,
    });
    pipe.submit({ id: 'a' });
    await vi.waitFor(() => expect(onResult).toHaveBeenCalledTimes(1));
    expect(runInference).toHaveBeenCalledTimes(1);
  });

  it('drops results for frames older than 200ms instead of emitting stale Cues', async () => {
    const now = { t: 0 };
    let release;
    const gate = new Promise((r) => { release = r; });
    const runInference = vi.fn().mockImplementation(() => gate.then(() => []));
    const onResult = vi.fn();
    const onDrop = vi.fn();
    const pipe = createDetectionPipeline({
      runInference,
      now: () => now.t,
      onResult,
      onDrop,
    });
    pipe.submit({ id: 'stale' });
    now.t = 500; // inference took longer than the budget
    release(undefined);
    await vi.waitFor(() => expect(onDrop).toHaveBeenCalledTimes(1));
    expect(onResult).not.toHaveBeenCalled();
  });

  it('keeps only the latest frame while inference is in flight (backpressure)', async () => {
    const now = { t: 0 };
    const seen = [];
    const runInference = vi.fn().mockImplementation(async (frame) => {
      seen.push(frame.id);
      return [];
    });
    const onResult = vi.fn();
    const pipe = createDetectionPipeline({
      runInference,
      now: () => now.t,
      onResult,
    });
    // Block the first call briefly, then burst-submit.
    let release;
    const gate = new Promise((r) => { release = r; });
    runInference.mockImplementationOnce(() => gate.then(() => []));
    pipe.submit({ id: 'first' });
    pipe.submit({ id: 'second' });
    pipe.submit({ id: 'third' });
    release(undefined);
    await vi.waitFor(() => expect(onResult).toHaveBeenCalled());
    // Third (latest) must be processed; the middle one coalesced away.
    await vi.waitFor(() => expect(seen).toContain('third'));
    expect(seen).not.toContain('second');
  });

  it('tracks FPS and latency stats for the debug overlay', async () => {
    const now = { t: 1000 };
    const runInference = vi.fn().mockResolvedValue([]);
    const pipe = createDetectionPipeline({
      runInference,
      now: () => now.t,
      onResult: () => {},
    });
    pipe.submit({ id: 'x' });
    await vi.waitFor(() => expect(runInference).toHaveBeenCalledTimes(1));
    now.t += 50;
    pipe.submit({ id: 'y' });
    await vi.waitFor(() => expect(runInference).toHaveBeenCalledTimes(2));
    const stats = pipe.getStats();
    expect(stats.framesCompleted).toBeGreaterThanOrEqual(1);
    expect(typeof stats.fps).toBe('number');
    expect(typeof stats.lastLatencyMs).toBe('number');
  });
});
