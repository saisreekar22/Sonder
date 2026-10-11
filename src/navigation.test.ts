import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import { matchIntent, parseIntent, type Intent } from './voice/intents';

describe('navigation and UI back buttons in index.html', () => {
  const htmlPath = resolve(__dirname, '../index.html');
  const html = readFileSync(htmlPath, 'utf-8');

  it('includes a back button in the voice menu header', () => {
    expect(html).toContain('id="btn-voice-back"');
    expect(html).toContain('aria-label="Go back to visual menu"');
  });

  it('includes back buttons on the disclaimer safety screen', () => {
    expect(html).toContain('id="btn-disclaimer-back"');
    expect(html).toContain('id="btn-disclaimer-return"');
    expect(html).toContain('aria-label="Go back"');
  });

  it('includes top back button on the sound check screen', () => {
    expect(html).toContain('id="btn-sound-back-top"');
    expect(html).toContain('id="btn-sound-back"');
  });

  it('includes back buttons on the guided headphone check screen', () => {
    expect(html).toContain('id="btn-hp-back"');
    expect(html).toContain('id="hp-return"');
  });

  it('includes top back button on the status screen', () => {
    expect(html).toContain('id="btn-status-back-top"');
    expect(html).toContain('id="btn-status-back"');
  });

  it('includes top back button on the running walk screen', () => {
    expect(html).toContain('id="btn-running-back"');
    expect(html).toContain('aria-label="Go back to home"');
  });

  it('includes top back button on the track running screen', () => {
    expect(html).toContain('id="btn-track-back"');
    expect(html).toContain('aria-label="Go back to home"');
  });

  it('includes top back button in the settings dialog header', () => {
    expect(html).toContain('id="btn-settings-back"');
    expect(html).toContain('aria-label="Close settings and go back"');
  });

  it('ensures all top back buttons use the consistent .btn-top-back class', () => {
    const topBackBtnIds = [
      'btn-voice-back',
      'btn-disclaimer-back',
      'btn-sound-back-top',
      'btn-hp-back',
      'btn-status-back-top',
      'btn-running-back',
      'btn-track-back',
      'btn-settings-back',
    ];
    for (const id of topBackBtnIds) {
      const match = new RegExp(`<button[^>]*id="${id}"[^>]*>`, 'i').exec(html);
      expect(match, `Button #${id} should exist`).not.toBeNull();
      expect(match![0]).toContain('class="btn-top-back"');
    }
  });
});

describe('voice navigation command intents', () => {
  it('parses "back" and "go back" as the back intent', () => {
    expect(parseIntent('back')).toBe('back');
    expect(parseIntent('go back')).toBe('back');
    expect(parseIntent('previous screen')).toBe('back');
    expect(parseIntent('return')).toBe('back');
  });

  it('matches back intent among allowed command lists', () => {
    const allowed: Intent[] = ['describe', 'scan', 'pause', 'resume', 'stop', 'back', 'help'];
    expect(matchIntent(['go back'], allowed)?.intent).toBe('back');
    expect(matchIntent(['back to home', 'go back'], allowed)?.intent).toBe('back');
  });
});
