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
  'icons/icon-192.png',
  'icons/icon-512.png',
];

// Filled in by Issue 03 (detector) / Issue 08 (offline precache).
/** @type {string[]} */
const MODEL_FILES = [];

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
  note: 'Issue 01: app shell only — model artifact not yet bundled (Issue 03). Budget target ~10 MB (PRD US-1.1).',
  appEntries,
  modelEntries,
};

console.log(JSON.stringify(report, null, 2));
writeFileSync(join(root, 'PAYLOAD.json'), JSON.stringify(report, null, 2) + '\n');
