// @ts-check
// DebugOverlay — sighted-only tuning view (Issue 03, PRD §7).
// Off by default; shows Detection boxes, Zone thirds, distance bands, FPS,
// and latency. Never the sole carrier of information: the canvas is
// aria-hidden and all audio Cues fire regardless of overlay visibility.
// Seam: canvas + readout element are injected; tests stay at
// setVisible()/render() with a fake 2d context.

/**
 * @param {{ fps: number|null, latencyMs: number|null, inferenceMs?: number|null, count: number }} stats
 */
export function formatDebugReadout({ fps, latencyMs, inferenceMs = null, count }) {
  const fpsText = fps === null || fps === undefined ? '—' : String(Math.round(fps));
  const latText = latencyMs === null || latencyMs === undefined ? '—' : `${Math.round(latencyMs)} ms`;
  const infText = inferenceMs === null || inferenceMs === undefined ? '' : ` · infer ${Math.round(inferenceMs)} ms`;
  return `FPS ${fpsText} · latency ${latText}${infText} · ${count} detected · nothing detected means no information, never safe`;
}

/**
 * @typedef {object} DebugOverlayDeps
 * @property {any} canvas - overlay canvas stacked over the video
 * @property {any} [readout] - text element with the FPS/latency readout
 */

/**
 * @param {DebugOverlayDeps} deps
 */
export function createDebugOverlay({ canvas, readout = null }) {
  let visible = false;

  if (canvas) {
    canvas.hidden = true;
    // Sighted-only: keep assistive tech on the audio Cues, never the canvas.
    canvas['ariaHidden'] = true;
    if (typeof canvas.setAttribute === 'function') {
      canvas.setAttribute('aria-hidden', 'true');
    }
  }
  if (readout) readout.hidden = true;

  /** @param {any} next */
  function setVisible(next) {
    visible = Boolean(next);
    if (canvas) canvas.hidden = !visible;
    if (readout) readout.hidden = !visible;
    if (!visible) clear();
  }

  function isVisible() {
    return visible;
  }

  function clear() {
    try {
      const ctx = canvas ? canvas.getContext('2d') : null;
      if (ctx && canvas) ctx.clearRect(0, 0, canvas.width, canvas.height);
    } catch {
      // Canvas without a context (tests) — nothing to clear.
    }
  }

  /**
   * Draw boxes + Zone thirds + FPS/latency. Zone/band labels render when
   * the Detection carries them (annotated by the Issue 04 tracker).
   * Tracks render with their stable ID (#id) when present so identity
   * can be tuned sighted-only. corridorWidth mirrors the live Corridor
   * slider and moves the divider lines.
   * @param {{ detections?: any[], fps?: number|null, latencyMs?: number|null, inferenceMs?: number|null, corridorWidth?: number }} frame
   */
  function render({ detections = [], fps = null, latencyMs = null, inferenceMs = null, corridorWidth = 1 / 3 } = {}) {
    if (!visible || !canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const W = canvas.width || 640;
    const H = canvas.height || 480;
    ctx.clearRect(0, 0, W, H);

    // Zone thirds: left / center (Corridor) / right dividers.
    // Width follows the live Corridor slider, centered on the frame.
    const cw = Number.isFinite(corridorWidth) ? corridorWidth : 1 / 3;
    const leftFrac = 0.5 - cw / 2;
    const rightFrac = 0.5 + cw / 2;
    ctx.beginPath();
    for (const frac of [leftFrac, rightFrac]) {
      ctx.moveTo(W * frac, 0);
      ctx.lineTo(W * frac, H);
    }
    ctx.stroke();

    for (const d of detections) {
      const x = Number(d.x) * W;
      const y = Number(d.y) * H;
      const w = Number(d.width) * W;
      const h = Number(d.height) * H;
      ctx.strokeRect(x, y, w, h);
      const id = d.id !== undefined && d.id !== null ? ` #${d.id}` : '';
      const zone = d.zone ? ` ${d.zone}` : '';
      const band = d.band ? ` ${d.band}` : '';
      ctx.fillText(`${d.category ?? 'unknown'}${id}${zone}${band} ${Math.round(Number(d.score ?? 0) * 100)}%`, x + 4, y + 14);
    }

    ctx.fillText(`FPS ${fps ?? '—'} · ${latencyMs ?? '—'} ms`, 8, H - 12);

    if (readout) {
      readout.textContent = formatDebugReadout({
        fps,
        latencyMs,
        inferenceMs,
        count: detections.length,
      });
    }
  }

  return { setVisible, isVisible, render };
}
