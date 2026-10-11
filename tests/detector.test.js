import { describe, it, expect, vi } from 'vitest';
import {
  createDetector,
  createEfficientDetLite0Detector,
  DETECTOR_MODELS,
  DEFAULT_MODEL_ID,
  SCORE_THRESHOLD,
  MOVER_CLASSES,
  STATIC_OBJECT_CLASSES,
} from '../src/detector.js';

function fakeBackend(detections = []) {
  return {
    load: vi.fn().mockResolvedValue(undefined),
    detect: vi.fn().mockResolvedValue(detections),
    close: vi.fn().mockResolvedValue(undefined),
  };
}

describe('Detector — single swappable detect(frame) contract (Issue 03)', () => {
  it('exposes the EfficientDet-Lite0 baseline behind the model flag', () => {
    expect(DETECTOR_MODELS.EFFICIENTDET_LITE0).toBeDefined();
    expect(DETECTOR_MODELS.RTMDET_TINY).toBeDefined();
    expect(DEFAULT_MODEL_ID).toBe(DETECTOR_MODELS.EFFICIENTDET_LITE0);
  });

  it('detect(frame) returns boxes, classes, and scores', async () => {
    const raw = [
      { x: 0.1, y: 0.2, width: 0.3, height: 0.4, category: 'person', score: 0.9 },
    ];
    const backend = fakeBackend(raw);
    const detector = createDetector({ modelId: DEFAULT_MODEL_ID, backend });
    const out = await detector.detect({ width: 640, height: 480 });
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ x: 0.1, y: 0.2, width: 0.3, height: 0.4 });
    expect(typeof out[0].category).toBe('string');
    expect(typeof out[0].score).toBe('number');
  });

  it('detects person as the primary class and passes through mover/static classes', async () => {
    expect(MOVER_CLASSES).toContain('person');
    expect(STATIC_OBJECT_CLASSES.length).toBeGreaterThan(0);
    const backend = fakeBackend([
      { x: 0, y: 0, width: 0.2, height: 0.3, category: 'person', score: 0.8 },
      { x: 0.5, y: 0.5, width: 0.2, height: 0.2, category: 'chair', score: 0.7 },
    ]);
    const detector = createDetector({ modelId: DEFAULT_MODEL_ID, backend });
    const out = await detector.detect({ width: 320, height: 240 });
    expect(out.map((d) => d.category)).toEqual(['person', 'chair']);
  });

  it('filters Detections below the score threshold', async () => {
    const backend = fakeBackend([
      { x: 0, y: 0, width: 0.2, height: 0.2, category: 'person', score: 0.9 },
      { x: 0, y: 0, width: 0.2, height: 0.2, category: 'car', score: 0.05 },
    ]);
    const detector = createDetector({ modelId: DEFAULT_MODEL_ID, backend });
    const out = await detector.detect({ width: 320, height: 240 });
    expect(out).toHaveLength(1);
    expect(out[0].category).toBe('person');
    expect(SCORE_THRESHOLD).toBeGreaterThan(0);
  });

  it('EfficientDet-Lite0 factory builds the same contract behind the same flag', async () => {
    const backend = fakeBackend([
      { x: 0, y: 0, width: 0.1, height: 0.1, category: 'person', score: 0.6 },
    ]);
    const detector = createEfficientDetLite0Detector({ backend });
    expect(detector.modelId).toBe(DETECTOR_MODELS.EFFICIENTDET_LITE0);
    const out = await detector.detect({ width: 128, height: 128 });
    expect(out).toHaveLength(1);
    expect(backend.detect).toHaveBeenCalledTimes(1);
  });

  it('close() releases the backend', async () => {
    const backend = fakeBackend([]);
    const detector = createDetector({ modelId: DEFAULT_MODEL_ID, backend });
    await detector.close();
    expect(backend.close).toHaveBeenCalledTimes(1);
  });
});
