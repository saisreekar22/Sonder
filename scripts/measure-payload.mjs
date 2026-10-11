// @ts-check
// measure-payload — Issue 01 acceptance: app-plus-model payload measured + recorded.
// Model artifact lands in Issue 03/08; this script already includes a MODEL slot
// so the total stays honest as artifacts arrive.
import { statSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

const APP_FILES = [
  'index.html',
  'styles.css',
  'manifest.webmanifest',
  'sw.js',
  'src/main.js',
  'src/camera.js',
  'src/pause.js',
  'src/earcons.js',
  'src/speech.js',
  'src/detector.js',
  'src/detector-worker.js',
  'src/mediapipe-tasks.js',
  'src/pipeline.js',
  'src/debug-overlay.js',
  'src/zones.js',
  'src/tracker.js',
  'src/distance.js',
  'src/disclaimer.js',
  'src/failloud.js',
  'src/wakelock.js',
  'icons/icon-192.png',
  'icons/icon-512.png',
];

// Issue 03: on-device EfficientDet-Lite0 baseline (float32, ~13.8 MB — over
// the ~10 MB target on its own; the Issue 08 lite→nano ladder is the
// planned remedy). Tasks-vision bundle/wasm load from pinned CDN at runtime.
/** @type {string[]} */
const MODEL_FILES = ['models/efficientdet-lite0.tflite'];

/** @param {string} rel */
function sizeOf(rel) {
  try {
    return statSync(join(root, rel)).size;
  } catch {
    return 0;
  }
}

const appEntries = APP_FILES.map((f) => ({ file: f, bytes: sizeOf(f) }));
const modelEntries = MODEL_FILES.map((f) => ({ file: f, bytes: sizeOf(f) }));
const appBytes = appEntries.reduce((s, e) => s + e.bytes, 0);
const modelBytes = modelEntries.reduce((s, e) => s + e.bytes, 0);

const report = {
  measuredAt: new Date().toISOString(),
  appBytes,
  modelBytes,
  totalBytes: appBytes + modelBytes,
  totalKB: Math.round((appBytes + modelBytes) / 102.4) / 10,
  budgetKB: 10 * 1024,
  note: 'Issue 03: app + EfficientDet-Lite0 baseline bundled. Model (~13.8 MB float32) exceeds the ~10 MB target alone; Issue 08 lite→nano ladder is the planned remedy. tasks-vision bundle/wasm load from pinned CDN at runtime.',
  appEntries,
  modelEntries,
};

console.log(JSON.stringify(report, null, 2));
writeFileSync(join(root, 'PAYLOAD.json'), JSON.stringify(report, null, 2) + '\n');
