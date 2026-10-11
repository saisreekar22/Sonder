import { describe, it, expect, vi } from 'vitest';
import {
  TASKS_VISION_VERSION,
  tasksVisionUrls,
  mapObjectDetectorResult,
  loadObjectDetector,
} from '../src/mediapipe-tasks.js';
import { SCORE_THRESHOLD } from '../src/detector.js';

function mpDetection(over = {}) {
  return {
    categories: [{ categoryName: 'person', score: 0.88 }],
    boundingBox: { originX: 64, originY: 48, width: 128, height: 192 },
    ...over,
  };
}

describe('MediaPipe tasks — result mapping + loader seams (Issue 03 baseline)', () => {
  it('pins the tasks-vision version and derives CDN URLs from it', () => {
    expect(TASKS_VISION_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
    const urls = tasksVisionUrls();
    expect(urls.bundleUrl).toContain(TASKS_VISION_VERSION);
    expect(urls.wasmBaseUrl).toContain(TASKS_VISION_VERSION);
  });

  it('maps pixel boxes to normalized Detections with class + score', () => {
    const out = mapObjectDetectorResult(
      { detections: [mpDetection()] },
      { frameWidth: 640, frameHeight: 480 },
    );
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      x: 0.1, y: 0.1, width: 0.2, height: 0.4,
      category: 'person', score: 0.88,
    });
  });

  it('drops results below the score threshold', () => {
    const out = mapObjectDetectorResult(
      {
        detections: [
          mpDetection({ categories: [{ categoryName: 'person', score: 0.9 }] }),
          mpDetection({ categories: [{ categoryName: 'car', score: 0.05 }] }),
        ],
      },
      { frameWidth: 640, frameHeight: 480, scoreThreshold: SCORE_THRESHOLD },
    );
    expect(out).toHaveLength(1);
    expect(out[0].category).toBe('person');
  });

  it('skips detections with no usable category or box', () => {
    const out = mapObjectDetectorResult(
      {
        detections: [
          { categories: [], boundingBox: { originX: 0, originY: 0, width: 10, height: 10 } },
          { categories: [{ categoryName: 'chair', score: 0.8 }] },
          null,
        ],
      },
      { frameWidth: 640, frameHeight: 480 },
    );
    expect(out).toHaveLength(0);
  });

  it('passes through non-person mover and static-object classes', () => {
    const out = mapObjectDetectorResult(
      {
        detections: [
          mpDetection({ categories: [{ categoryName: 'car', score: 0.7 }] }),
          mpDetection({ categories: [{ categoryName: 'chair', score: 0.75 }] }),
        ],
      },
      { frameWidth: 640, frameHeight: 480 },
    );
    expect(out.map((d) => d.category)).toEqual(['car', 'chair']);
  });

  it('loads with the GPU delegate and falls back to CPU when GPU init fails', async () => {
    const calls = [];
    const fakeDetector = { detect: vi.fn(), close: vi.fn() };
    const fakeModule = {
      FilesetResolver: { forVisionTasks: vi.fn().mockResolvedValue({}) },
      ObjectDetector: {
        createFromOptions: vi.fn().mockImplementation(async (_wasm, opts) => {
          calls.push(opts?.baseOptions?.delegate);
          if (opts?.baseOptions?.delegate === 'GPU') throw new Error('no WebGL');
          return fakeDetector;
        }),
      },
    };
    const detector = await loadObjectDetector({
      modelAssetPath: './models/efficientdet-lite0.tflite',
      importVision: async () => fakeModule,
    });
    expect(detector).toBe(fakeDetector);
    expect(calls).toEqual(['GPU', 'CPU']);
  });

  it('surfaces loader failure when the vision bundle cannot be imported', async () => {
    await expect(
      loadObjectDetector({ importVision: async () => { throw new Error('offline'); } }),
    ).rejects.toThrow();
  });
});
