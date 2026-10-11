import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const root = process.cwd();

function readJson(path) {
  return JSON.parse(readFileSync(join(root, path), 'utf8'));
}

describe('PWA shell contract — installable, cached, accessible (Issue 01)', () => {
  it('manifest is installable: name, short_name, start_url, standalone, icons 192 + 512', () => {
    const m = readJson('manifest.webmanifest');
    expect(m.name).toBeTruthy();
    expect(m.short_name).toBeTruthy();
    expect(m.start_url).toBeTruthy();
    expect(m.display).toBe('standalone');
    const sizes = (m.icons || []).map((i) => i.sizes);
    expect(sizes).toContain('192x192');
    expect(sizes).toContain('512x512');
  });

  it('service worker precaches the app shell (offline repeat visit)', () => {
    const sw = readFileSync(join(root, 'sw.js'), 'utf8');
    for (const asset of ['./', './index.html', './styles.css', './manifest.webmanifest']) {
      expect(sw).toContain(asset);
    }
  });

  it('index.html has one large Start button, live video, and labelled controls', () => {
    const html = readFileSync(join(root, 'index.html'), 'utf8');
    expect(html).toContain('id="start-button"');
    expect(html).toContain('aria-label');
    expect(html).toContain('id="camera-view"');
    // Full-screen double-tap target for pause.
    expect(html).toContain('id="pause-target"');
    // Every button carries an accessible label TalkBack can read.
    const buttons = [...html.matchAll(/<button[^>]*>/g)].map((m) => m[0]);
    expect(buttons.length).toBeGreaterThanOrEqual(1);
    for (const b of buttons) expect(b).toMatch(/aria-label="/);
  });

  it('icon assets referenced by the manifest exist on disk', () => {
    const m = readJson('manifest.webmanifest');
    for (const icon of m.icons) {
      expect(existsSync(join(root, icon.src))).toBe(true);
    }
  });
});
