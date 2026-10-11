import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createDebugOverlay, formatDebugReadout } from '../src/debug-overlay.js';

function fake2d() {
  return {
    clearRect: vi.fn(),
    strokeRect: vi.fn(),
    fillText: vi.fn(),
    beginPath: vi.fn(),
    moveTo: vi.fn(),
    lineTo: vi.fn(),
    stroke: vi.fn(),
    setLineDash: vi.fn(),
  };
}

function setup() {
  const ctx = fake2d();
  const canvas = {
    hidden: true,
    width: 640,
    height: 480,
    getContext: vi.fn().mockReturnValue(ctx),
    setAttribute: vi.fn(),
  };
  const readout = { hidden: true, textContent: '' };
  const overlay = createDebugOverlay({ canvas, readout });
  return { ctx, canvas, readout, overlay };
}

describe('DebugOverlay — sighted-only tuning view, off by default (Issue 03)', () => {
  it('is off by default and never the sole carrier of information', () => {
    const { overlay, canvas } = setup();
    expect(overlay.isVisible()).toBe(false);
    expect(canvas.hidden).toBe(true);
    // Sighted-only: hidden from assistive tech so audio Cues stay canonical.
    expect(canvas['ariaHidden']).toBe(true);
  });

  it('shows Detection boxes with Zone thirds when enabled', () => {
    const { overlay, ctx } = setup();
    overlay.setVisible(true);
    overlay.render({
      detections: [{ x: 0.1, y: 0.1, width: 0.2, height: 0.3, category: 'person', score: 0.9, zone: 'left', band: 'near' }],
      fps: 15,
      latencyMs: 120,
    });
    expect(ctx.strokeRect).toHaveBeenCalled();
    expect(ctx.fillText).toHaveBeenCalled();
    // Zone thirds: two vertical dividers across the frame.
    expect(ctx.moveTo).toHaveBeenCalled();
    expect(ctx.lineTo).toHaveBeenCalled();
  });

  it('renders FPS and latency readout as text for tuning', () => {
    const { overlay, readout } = setup();
    overlay.setVisible(true);
    overlay.render({ detections: [], fps: 17.2, latencyMs: 83, inferenceMs: 60 });
    expect(readout.textContent).toContain('17');
    expect(readout.textContent).toContain('83');
    expect(formatDebugReadout({ fps: 15, latencyMs: 100, count: 2 })).toContain('15');
  });

  it('hiding the overlay clears the canvas and readout', () => {
    const { overlay, ctx, canvas, readout } = setup();
    overlay.setVisible(true);
    overlay.render({ detections: [], fps: 15, latencyMs: 100 });
    overlay.setVisible(false);
    expect(canvas.hidden).toBe(true);
    expect(readout.hidden).toBe(true);
    expect(ctx.clearRect).toHaveBeenCalled();
  });

  it('renders distance bands on Detection labels when present', () => {
    const { overlay, ctx } = setup();
    overlay.setVisible(true);
    overlay.render({
      detections: [{ x: 0.4, y: 0.2, width: 0.2, height: 0.4, category: 'person', score: 0.8, zone: 'center', band: 'very near' }],
      fps: 15,
      latencyMs: 100,
    });
    const labels = ctx.fillText.mock.calls.map((c) => String(c[0]));
    expect(labels.some((l) => l.includes('very near'))).toBe(true);
  });

  it('shows the model status in the readout and canvas when provided', () => {
    const { overlay, ctx, readout } = setup();
    overlay.setVisible(true);
    overlay.render({ detections: [], fps: null, latencyMs: null, status: 'loading model…' });
    expect(readout.textContent).toContain('loading model…');
    const lines = ctx.fillText.mock.calls.map((c) => String(c[0]));
    expect(lines.some((l) => l.includes('loading model…'))).toBe(true);
    expect(formatDebugReadout({ fps: null, latencyMs: null, count: 0 })).not.toContain('loading');
  });
});
