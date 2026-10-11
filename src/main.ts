import './style.css';
import { Session, type FrameReport } from './app/session';
import { AudioEngine } from './audio/engine';
import { CameraError, CameraSource, FileSource, listCameras, shouldMirror, WakeLock, type FrameSource } from './camera/source';
import { DEFAULT_SETTINGS, isWorn, loadSettings, saveSettings, type Activity, type Mount, type Settings } from './core/settings';
import { DetectionClient } from './detect/client';
import { MODELS } from './detect/detector';
import { MotionSensor } from './sensors/motion';
import { Announcer } from './speech/announcer';
import { clearOverlay, drawOverlay } from './ui/overlay';
import { drawRadar } from './ui/radar';
import { HeartRateMonitor, RunTracker } from './track/devices';
import { formatDuration, formatPace } from './track/run';
import { TrackSession, type TrackReport } from './track/trackSession';
import { drawLaneGauge, drawLaneOverlay } from './ui/laneGauge';

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const BASE = new URL(import.meta.env.BASE_URL, location.href).href;

let settings: Settings = loadSettings();
const audio = new AudioEngine();
const announcer = new Announcer({ polite: $('sr-polite'), assertive: $('sr-assertive') }, (d) => audio.duck(d));
const detector = new DetectionClient(BASE);
const motion = new MotionSensor();
const session = new Session(settings, audio, announcer, detector, motion);
const hr = new HeartRateMonitor();
const runTracker = new RunTracker(motion, hr);
// Track mode's "runner ahead" detector: fast model on the CPU, so the GPU stays free for 60 fps lane guidance.
const trackDetector = new DetectionClient(BASE, false);
const track = new TrackSession(audio, announcer, trackDetector, runTracker, () => settings);
const tvideo = $<HTMLVideoElement>('tvideo');
const wakeLock = new WakeLock();
const video = $<HTMLVideoElement>('video');
const overlay = $<HTMLCanvasElement>('overlay');
const radar = $<HTMLCanvasElement>('radar');
const dialog = $<HTMLDialogElement>('settings');
const form = $<HTMLFormElement>('settings-form');
let testVideo: File | null = null;
let modelLoading: Promise<void> | null = null;
let lastReport: FrameReport | null = null;

// ---------------------------------------------------------------------------
// TTS narration helper — shows a visual toast and speaks via announcer
// ---------------------------------------------------------------------------
const ttsToast = $('tts-toast');
const ttsToastText = $('tts-toast-text');
let ttsToastTimer: number | undefined;

/**
 * Show what is being spoken in a visual overlay (helps sighted helpers see
 * what the app is saying to a blind user).
 */
function showTtsToast(text: string): void {
  ttsToastText.textContent = text;
  ttsToast.classList.add('visible');
  clearTimeout(ttsToastTimer);
  // Keep toast visible a bit longer than the spoken words (~90 ms per char + 2 s buffer)
  ttsToastTimer = window.setTimeout(() => ttsToast.classList.remove('visible'), 2000 + text.length * 70);
}

/** Speak text and show it in the toast simultaneously. */
function narrate(text: string, opts: { interrupt?: boolean; system?: boolean } = {}): void {
  showTtsToast(text);
  announcer.say(text, { interrupt: opts.interrupt ?? false, system: opts.system ?? true });
}

/** Welcome screen narration — explains the app and what to do. */
function speakWelcome(): void {
  const activity = settings.activity === 'track' ? 'track run' : 'walk';
  narrate(
    `Welcome to EchoPath. This app turns your camera into ears — people and obstacles become sounds from their direction. ` +
    `You have selected ${activity} mode. ` +
    `Double-tap anywhere on the screen to start, or press the Start Walking button.`,
    { interrupt: true }
  );
}

// ---------------------------------------------------------------------------
// Screens
// ---------------------------------------------------------------------------
type ScreenId = 'welcome' | 'disclaimer' | 'sound' | 'headphones' | 'status' | 'running' | 'track';
let current: ScreenId = 'welcome';

function show(id: ScreenId): void {
  current = id;
  document.querySelectorAll<HTMLElement>('.screen').forEach((s) => s.removeAttribute('data-active'));
  const el = $(`screen-${id}`);
  el.setAttribute('data-active', '');
  // Move focus to the heading so screen readers announce the new screen.
  el.querySelector<HTMLElement>('h1')?.focus();
  // Show / hide the welcome double-tap zone
  const tapZone = $('welcome-tap-zone');
  tapZone.style.display = id === 'welcome' ? '' : 'none';
  if (id === 'running') {
    $('pause-target').focus();
    requestAnimationFrame(radarLoop);
  }
  if (id === 'track') $('track-target').focus();
  if (id === 'sound') void refreshSound();
  if (id === 'welcome') {
    void refreshChecks();
    // Auto-narrate the welcome screen after a short delay so the page settles
    setTimeout(() => speakWelcome(), 800);
  }
  if (id === 'disclaimer') {
    setTimeout(() => narrate(
      'Safety notice. ' + ($('disclaimer-text').innerText.replace(/\n+/g, ' ')),
      { interrupt: true }
    ), 400);
  }
  if (id === 'sound') {
    setTimeout(() => narrate(
      'Sound check screen. Use the buttons to test left and right ear sounds. Press Done when finished.',
      { interrupt: true }
    ), 400);
  }
  if (id === 'status') {
    setTimeout(() => {
      const t = $('status-title').textContent ?? '';
      const tx = $('status-text').textContent ?? '';
      if (t || tx) narrate(`${t}. ${tx}`, { interrupt: true });
    }, 300);
  }
}

function status(title: string, text: string, opts: { retry?: boolean; busy?: boolean } = {}): void {
  $('status-title').textContent = title;
  $('status-text').textContent = text;
  $('btn-retry').hidden = !opts.retry;
  $('status-spinner').hidden = !opts.busy;
  show('status');
}

type CheckState = 'ok' | 'warn' | 'bad' | 'idle';
function setCheck(name: string, state: CheckState, text: string): void {
  document.querySelectorAll<HTMLElement>(`[data-check="${name}"]`).forEach((li) => {
    li.dataset.state = state;
    li.querySelector('.val')!.textContent = text;
  });
}

// ---------------------------------------------------------------------------
// Home: where is the phone? + ready check
// ---------------------------------------------------------------------------
const MOUNT_HINT: Record<Mount, string> = {
  chest:
    'Clip the phone to a lanyard or chest strap with the back camera facing forward. While walking, press and hold the screen to pause.',
  waist:
    'Clip the phone to your belt with the back camera facing forward, tilted slightly up. While walking, press and hold the screen to pause.',
  hand: 'Hold the phone at chest height, back camera pointing ahead. Double-tap the screen to pause.',
  table: 'Prop the phone or laptop up facing the room, for demos. Double-tap the screen to pause.',
};

function renderActivity(): void {
  document.querySelectorAll<HTMLButtonElement>('[data-activity]').forEach((b) => {
    const on = b.dataset.activity === settings.activity;
    b.setAttribute('aria-checked', String(on));
    b.tabIndex = on ? 0 : -1;
  });
  const isTrack = settings.activity === 'track';
  $('track-card').hidden = !isTrack;
  $('mount-card').hidden = isTrack;
  $('btn-start').textContent = isTrack ? 'Start run' : 'Start walking';
}

$('activity-group').addEventListener('click', (e) => {
  const a = (e.target as HTMLElement).closest<HTMLElement>('[data-activity]')?.dataset.activity as Activity | undefined;
  if (!a) return;
  update({ activity: a });
  void refreshChecks();
  announcer.showText(a === 'track' ? 'Track run selected.' : 'Walk selected.');
});
$('activity-group').addEventListener('keydown', (e) => {
  if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(e.key)) return;
  e.preventDefault();
  const a: Activity = settings.activity === 'walk' ? 'track' : 'walk';
  update({ activity: a });
  document.querySelector<HTMLButtonElement>(`[data-activity="${a}"]`)?.focus();
});

$('btn-hr').addEventListener('click', async () => {
  if (!HeartRateMonitor.supported) {
    announcer.say('This browser cannot connect to Bluetooth heart-rate monitors. Use Chrome on Android or a computer.');
    return;
  }
  try {
    await hr.connect();
    announcer.say(`Connected to ${hr.name}.`);
  } catch (e) {
    if ((e as Error).name !== 'NotFoundError') announcer.say('Could not connect to the heart-rate monitor.');
  }
  void refreshChecks();
});
hr.onChange = () => void refreshChecks();

function renderMount(): void {
  document.querySelectorAll<HTMLButtonElement>('[data-mount]').forEach((b) => {
    const on = b.dataset.mount === settings.mount;
    b.setAttribute('aria-checked', String(on));
    b.tabIndex = on ? 0 : -1;
  });
  $('mount-hint').textContent = MOUNT_HINT[settings.mount];
}

$('mount-group').addEventListener('click', (e) => {
  const m = (e.target as HTMLElement).closest<HTMLElement>('[data-mount]')?.dataset.mount as Mount | undefined;
  if (!m) return;
  update({ mount: m });
  announcer.showText(MOUNT_HINT[m]);
});
// Arrow keys move between radio options (standard radiogroup behaviour).
$('mount-group').addEventListener('keydown', (e) => {
  const order: Mount[] = ['chest', 'waist', 'hand', 'table'];
  const i = order.indexOf(settings.mount);
  const d = e.key === 'ArrowRight' || e.key === 'ArrowDown' ? 1 : e.key === 'ArrowLeft' || e.key === 'ArrowUp' ? -1 : 0;
  if (!d) return;
  e.preventDefault();
  const m = order[(i + d + order.length) % order.length];
  update({ mount: m });
  document.querySelector<HTMLButtonElement>(`[data-mount="${m}"]`)?.focus();
});

async function refreshChecks(): Promise<void> {
  renderMount();
  renderActivity();
  // Track-mode checks
  try {
    const p = await navigator.permissions?.query({ name: 'geolocation' as PermissionName });
    if (p) setCheck('gps', p.state === 'denied' ? 'bad' : p.state === 'granted' ? 'ok' : 'idle', p.state === 'granted' ? 'Allowed' : p.state === 'denied' ? 'Blocked: step count used instead' : 'Asks when you start');
  } catch {
    /* unknown */
  }
  if (!HeartRateMonitor.supported) setCheck('hr', 'idle', 'Not supported in this browser');
  else setCheck('hr', hr.connected ? 'ok' : 'idle', hr.connected ? `${hr.name}${hr.current ? `, ${hr.current} bpm` : ''}` : 'Not connected (optional)');
  setCheck('haptics', 'vibrate' in navigator ? 'ok' : 'warn', 'vibrate' in navigator ? 'Supported' : 'Not on this phone: sound only');
  // Sound
  if (audio.ctx) {
    const ch = audio.outputChannels;
    setCheck('sound', ch >= 2 ? 'ok' : 'bad', ch >= 2 ? 'Stereo, ready' : 'Mono: directions will not work');
  } else {
    setCheck('sound', 'idle', 'Open Sound check to test');
  }
  // Camera permission (where the browser can tell us without asking)
  try {
    const p = await navigator.permissions?.query({ name: 'camera' as PermissionName });
    if (p) setCheck('camera', p.state === 'granted' ? 'ok' : p.state === 'denied' ? 'bad' : 'idle', p.state === 'granted' ? 'Allowed' : p.state === 'denied' ? 'Blocked: allow it in site settings' : 'Asks when you start');
  } catch {
    /* not supported (Safari/Firefox): leave as is */
  }
  // Model
  if (detector.model) setCheck('model', 'ok', `Ready on this device (${detector.backend})`);
  // Motion
  if (settings.mount === 'table') setCheck('motion', 'idle', 'Off for table demos');
  else if (motion.available) setCheck('motion', 'ok', 'On');
  else setCheck('motion', 'idle', 'Starts with EchoPath');
  // Battery
  await refreshBattery();
}

// ---------------------------------------------------------------------------
// Start flow: Start -> (first run: safety notice -> headphone check) -> camera -> running
// ---------------------------------------------------------------------------

/** Shared start handler: invoked by btn-start or the full-screen double-tap zone. */
async function handleStartTap(): Promise<void> {
  if (settings.activity === 'track' || settings.mount !== 'table') void motion.start().then(() => refreshChecks());
  await audio.unlock().catch(() => {});
  const bt = await audio.autoSelectBluetooth().catch(() => null);
  if (bt && !settings.audioOutputId) {
    update({ audioOutputId: bt.deviceId });
  }
  announcer.unlock();
  void preloadModel().catch(() => {});
  if (!settings.disclaimerAccepted) {
    show('disclaimer');
    readDisclaimer();
    return;
  }
  await continueStart();
}

$('btn-start').addEventListener('click', () => void handleStartTap());

// ------- Double-tap anywhere on the welcome screen to start --------
{
  let lastTap = 0;
  $('welcome-tap-zone').addEventListener('pointerup', () => {
    const now = performance.now();
    if (now - lastTap < 400) {
      lastTap = 0;
      navigator.vibrate?.(30);
      void handleStartTap();
    } else {
      lastTap = now;
    }
  });
  // First single tap: speak a hint in case the user doesn't know what to do
  $('welcome-tap-zone').addEventListener('click', () => {
    const now = performance.now();
    if (now - lastTap > 500) {
      narrate('Tap again quickly to start, or press the Start Walking button.');
    }
  });
}

function readDisclaimer(): void {
  announcer.say($('disclaimer-text').innerText.replace(/\n+/g, ' '), { interrupt: true });
}

$('btn-reread').addEventListener('click', readDisclaimer);
$('btn-accept').addEventListener('click', async () => {
  announcer.cancel();
  update({ disclaimerAccepted: true });
  await continueStart();
});

async function continueStart(): Promise<void> {
  if (audio.outputChannels === 1) {
    // Spatial sound is physically impossible on a mono output: say so up front.
    audio.earcon('warning');
    announcer.say(MONO_HELP_SPOKEN, { interrupt: true });
  }
  if (!settings.headphoneCheckDone) await headphoneCheck();
  if (settings.activity === 'track') await startTrack();
  else await startRunning();
}

function preloadModel(): Promise<void> {
  if (!modelLoading || detector.model !== settings.model) {
    modelLoading = session.ensureModel().catch((e) => {
      modelLoading = null;
      throw e;
    });
  }
  return modelLoading;
}

async function startRunning(): Promise<void> {
  const usingFile = testVideo !== null;
  status('Starting', usingFile ? 'Loading the test video.' : 'Your browser will ask to use the camera. Choose Allow.', {
    busy: true,
  });
  if (!usingFile) announcer.say('Your browser will ask to use the camera. Choose Allow.');
  const source: FrameSource = usingFile ? new FileSource(video, testVideo!) : new CameraSource(video, settings.cameraId);
  try {
    await source.start();
  } catch (e) {
    if (e instanceof CameraError && e.reason === 'notfound' && settings.cameraId) {
      update({ cameraId: '' }); // the chosen camera was unplugged: fall back to automatic
      return startRunning();
    }
    const err = e instanceof CameraError ? e : new CameraError(String(e), 'other');
    const msg = cameraHelp(err);
    status('Camera unavailable', msg, { retry: true });
    audio.earcon('warning');
    announcer.say(msg, { interrupt: true });
    return;
  }

  try {
    status('Starting', 'Loading the detection model.', { busy: true });
    await preloadModel();
  } catch (e) {
    source.stop();
    const msg = 'The detection model could not load. Check your connection for the first visit, then try again.';
    console.error(e);
    status('Model failed to load', msg, { retry: true });
    audio.earcon('warning');
    announcer.say(msg, { interrupt: true });
    return;
  }

  await wakeLock.acquire();
  setPaused(false);
  applyMountUi();
  show('running');
  await session.start(source);
  updateMirror();
  startMediaSession();
  audio.earcon('start');
  narrate(`EchoPath is running. ${gestureText(false)}`, { interrupt: true });
}

/** Flip left/right when the camera looks at the listener (see shouldMirror). */
function updateMirror(): void {
  const src = session.currentSource;
  const mirror = src ? shouldMirror(src.kind, src.facing, settings.cameraFacing) : false;
  session.mirror = mirror;
  video.style.transform = mirror ? 'scaleX(-1)' : '';
}

async function switchCamera(deviceId: string): Promise<void> {
  if (session.state === 'idle' || testVideo) return;
  const src = new CameraSource(video, deviceId);
  try {
    session.currentSource?.stop();
    await src.start();
    session.setSource(src);
    updateMirror();
    announcer.say(`Camera changed.`);
  } catch (e) {
    session.fail(e instanceof CameraError ? cameraHelp(e) : 'That camera could not start.');
  }
}

function cameraHelp(e: CameraError): string {
  switch (e.reason) {
    case 'denied':
      return 'Camera permission was denied. Open your browser settings for this site, allow the camera, then tap Try again.';
    case 'insecure':
      return 'The camera only works when this page is opened over https. Open the secure link and try again.';
    case 'notfound':
      return 'No camera was found on this device.';
    case 'busy':
      return 'Another app is using the camera. Close it, then tap Try again.';
    case 'unsupported':
      return 'This browser cannot use the camera. Try current Chrome on Android or Safari on iPhone.';
    default:
      return `The camera could not start. ${e.message}`;
  }
}

$('btn-retry').addEventListener('click', () => void (settings.activity === 'track' ? startTrack() : startRunning()));
$('btn-status-back').addEventListener('click', () => show('welcome'));

// ---------------------------------------------------------------------------
// Sound check: where sound is going, stereo or mono, direction test, palette
// ---------------------------------------------------------------------------
const MONO_HELP_SPOKEN =
  'Your headphones are playing in mono, so left and right cannot be heard. On a computer, choose the headphones entry marked stereo, not the headset or hands free entry, and close any call or meeting app using the headset microphone.';

async function outputLabel(): Promise<string> {
  try {
    const devs = await navigator.mediaDevices.enumerateDevices();
    const outs = devs.filter((d) => d.kind === 'audiooutput');
    const id = audio.outputId || 'default';
    const hit = outs.find((d) => d.deviceId === id) ?? outs.find((d) => d.deviceId === 'default');
    const label = hit?.label.replace(/^Default - /, '');
    return label || 'System default output';
  } catch {
    return 'System default output';
  }
}

async function refreshSound(): Promise<void> {
  await audio.unlock().catch(() => {});
  const label = await outputLabel();
  const ch = audio.outputChannels;
  const delay = audio.outputLatencyMs;
  const handsFree = /hands-?free|headset|communication/i.test(label);
  setCheck('out-device', handsFree ? 'warn' : 'ok', label);
  setCheck('out-stereo', ch >= 2 ? 'ok' : 'bad', ch >= 2 ? `Yes (${ch} channels)` : 'No, mono');
  setCheck(
    'out-delay',
    delay > 120 ? 'warn' : 'ok',
    delay > 0 ? `about ${Math.round(delay)} ms${delay > 120 ? ' (Bluetooth: cues arrive a bit late)' : ''}` : 'Not reported',
  );
  const problem = $('out-problem');
  if (ch < 2 || handsFree) {
    problem.hidden = false;
    problem.innerHTML =
      '<strong>Left and right will not work on this output.</strong> ' +
      (handsFree
        ? 'This is the headset (hands-free) mode of your Bluetooth headphones, which is mono. '
        : 'The output is mono. ') +
      'On Windows: open Sound settings and choose the entry for your headphones marked <em>Headphones</em> or <em>Stereo</em>, not <em>Headset</em> or <em>Hands-Free</em>. Close calls or meeting apps using the headset microphone. Also check that Mono audio is off in accessibility settings. Then press Reconnect sound.';
  } else {
    problem.hidden = true;
  }
  void refreshChecks();
}

$('btn-sound').addEventListener('click', async () => {
  await audio.unlock().catch(() => {});
  show('sound');
});
$('btn-sound-back').addEventListener('click', () => show(session.state === 'idle' ? 'welcome' : 'running'));

$('btn-select-bt')?.addEventListener('click', async () => {
  await audio.unlock().catch(() => {});
  const res = await audio.selectBluetoothOutput();
  if (res) {
    update({ audioOutputId: res.deviceId });
    await refreshSound();
    audio.earcon('ok');
    announcer.say(`Connected to ${res.label}. Audio is routing to your earphones.`);
  } else {
    await refreshSound();
    announcer.say('No Bluetooth earphones selected. Please ensure they are paired in your device settings.');
  }
});

$('btn-reconnect').addEventListener('click', async () => {
  await audio.rebuild();
  const bt = await audio.autoSelectBluetooth().catch(() => null);
  if (bt) {
    update({ audioOutputId: bt.deviceId });
  } else if (settings.audioOutputId) {
    await audio.setOutput(settings.audioOutputId).catch(() => {});
  }
  await refreshSound();
  audio.earcon('ok');
  announcer.say(`Sound reconnected. Output: ${await outputLabel()}. Try the direction test.`);
});

document.querySelector('#screen-sound .row3')!.addEventListener('click', async (e) => {
  const tone = (e.target as HTMLElement).closest<HTMLElement>('[data-tone]')?.dataset.tone;
  if (!tone) return;
  await audio.unlock().catch(() => {});
  if (tone === 'sweep') {
    announcer.showText('The sound moves from your left, to ahead, to your right, and back.');
    await audio.spatialTest(4);
  } else {
    await audio.testTone(tone as 'left' | 'right');
  }
});

document.querySelector('#screen-sound .palette')!.addEventListener('click', async (e) => {
  const kind = (e.target as HTMLElement).closest<HTMLElement>('[data-preview]')?.dataset.preview;
  if (!kind) return;
  await audio.unlock().catch(() => {});
  if (kind === 'tick') {
    for (let i = 0; i < 3; i++) setTimeout(() => audio.earcon('tick'), i * 700);
    return;
  }
  const side = kind === 'guide' ? 'right' : 'center';
  await audio.preview(kind as 'person', side, kind === 'vehicle' ? 0.8 : 0.4);
});

$('btn-hp-guided').addEventListener('click', async () => {
  await headphoneCheck();
  show('sound');
});

// ---------------------------------------------------------------------------
// Guided headphone check (US-3.5)
// ---------------------------------------------------------------------------
let hpResolve: ((ok: boolean) => void) | null = null;
let hpSide: 'left' | 'right' = 'left';
const hpAnswers: Record<'left' | 'right', string> = { left: '', right: '' };

function headphoneCheck(): Promise<boolean> {
  $('hp-question').hidden = true;
  $('hp-begin').hidden = false;
  $('hp-instructions').textContent = 'Put on your headphones. You will hear a tone in one ear, then in the other.';
  show('headphones');
  announcer.say('Headphone check. Put on your headphones, then tap Play the first tone.');
  return new Promise((r) => (hpResolve = r));
}

async function playSide(side: 'left' | 'right'): Promise<void> {
  hpSide = side;
  $('hp-begin').hidden = true;
  $('hp-question').hidden = true;
  await audio.unlock().catch(() => {});
  await audio.testTone(side);
  $('hp-question').hidden = false;
  $('hp-prompt').textContent = 'Where did you hear the tone?';
  ($('hp-question').querySelector('button') as HTMLButtonElement).focus();
  announcer.say('Where did you hear the tone?');
}

$('hp-begin').addEventListener('click', () => void playSide('left'));
$('hp-replay').addEventListener('click', () => void playSide(hpSide));
$('hp-question').addEventListener('click', (e) => {
  const heard = (e.target as HTMLElement).closest<HTMLElement>('[data-heard]')?.dataset.heard;
  if (!heard) return;
  hpAnswers[hpSide] = heard;
  if (hpSide === 'left') {
    void playSide('right');
    return;
  }
  finishHeadphoneCheck();
});
$('hp-skip').addEventListener('click', () => {
  announcer.cancel();
  hpResolve?.(true);
  hpResolve = null;
});

function finishHeadphoneCheck(): void {
  const { left, right } = hpAnswers;
  let msg: string;
  if (left === 'left' && right === 'right') {
    msg = 'Stereo works. Left and right cues will be clear.';
    update({ headphoneCheckDone: true });
    audio.earcon('ok');
  } else if (left === 'both' || right === 'both') {
    msg =
      'You heard the tones equally in both ears. You may be using the phone speaker, a headset in hands-free mode, or mono audio. Direction cues will not work until stereo works. Open Sound check for help.';
    audio.earcon('warning');
  } else if (left === 'right' && right === 'left') {
    msg = 'Left and right seem swapped. Check that your earbuds are in the correct ears.';
    audio.earcon('warning');
  } else {
    msg = 'The tones were not heard on the expected sides. Check your headphones and try again from Sound check.';
    audio.earcon('warning');
  }
  $('hp-instructions').textContent = msg;
  announcer.say(msg, { interrupt: true });
  $('hp-question').hidden = true;
  const r = hpResolve;
  hpResolve = null;
  // Give the message time to be read before moving on.
  setTimeout(() => {
    if (r) r(true);
    else show(session.state === 'idle' ? 'welcome' : 'running');
  }, 2500);
}

// ---------------------------------------------------------------------------
// Running: gestures, controls, radar and status chips
// ---------------------------------------------------------------------------
const pauseTarget = $('pause-target');
const HOLD_MS = 700;

function gestureText(paused: boolean): string {
  const worn = isWorn(settings.mount);
  if (paused) return worn ? 'Press and hold anywhere to resume.' : 'Double-tap to resume.';
  return worn
    ? 'Press and hold anywhere to pause. Double-tap to hear what is around you.'
    : 'Double-tap to pause. Press and hold to hear what is around you.';
}

function applyMountUi(): void {
  $('screen-running').classList.toggle('worn', isWorn(settings.mount));
  $('gesture-hint').textContent = gestureText(session.state === 'paused');
}

/** Worn: hold = pause, double-tap = describe. Hand/table: double-tap = pause, hold = describe. */
function onHold(): void {
  if (isWorn(settings.mount)) togglePause();
  else describe();
}
function onDoubleTap(): void {
  if (isWorn(settings.mount)) describe();
  else togglePause();
}

/**
 * Full-screen gestures that survive being worn: press-and-hold (0.7 s) and
 * double-tap. A click with no pointer gesture (VoiceOver/TalkBack activation
 * or keyboard) counts as a deliberate pause toggle.
 */
function attachGestures(el: HTMLElement, onHoldFn: () => void, onDoubleFn: () => void, onActivate: () => void): void {
  let lastTap = 0, lastPointer = 0, held = false;
  let timer: number | undefined;
  el.addEventListener('pointerdown', (e) => {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    held = false;
    clearTimeout(timer);
    timer = window.setTimeout(() => {
      held = true;
      navigator.vibrate?.(40);
      onHoldFn();
    }, HOLD_MS);
  });
  const cancel = () => clearTimeout(timer);
  el.addEventListener('pointercancel', cancel);
  el.addEventListener('pointerleave', cancel);
  el.addEventListener('pointerup', () => {
    clearTimeout(timer);
    lastPointer = performance.now();
    if (held) return;
    if (lastPointer - lastTap < 400) {
      lastTap = 0;
      onDoubleFn();
    } else {
      lastTap = lastPointer;
    }
  });
  el.addEventListener('contextmenu', (e) => e.preventDefault());
  el.addEventListener('click', () => {
    if (performance.now() - lastPointer > 600) onActivate();
  });
}

attachGestures(pauseTarget, () => onHold(), () => onDoubleTap(), () => togglePause());

$('btn-pause').addEventListener('click', () => togglePause());
$('btn-describe').addEventListener('click', () => describe());

function describe(): void {
  if (session.state === 'idle') return;
  const text = session.describe();
  if (announcer.supported) announcer.say(text, { interrupt: true, system: false, priority: 0 });
  else announcer.showText(text, true);
}

function togglePause(): void {
  if (session.state === 'running') {
    session.pause();
    setPaused(true);
    audio.earcon('pause');
    announcer.say(`Paused. ${gestureText(true)}`);
  } else if (session.state === 'paused') {
    session.resume();
    setPaused(false);
    audio.earcon('resume');
    announcer.say('Resumed.');
  }
}

function setPaused(p: boolean): void {
  $('screen-running').classList.toggle('paused', p);
  $('btn-pause').textContent = p ? 'Resume' : 'Pause';
  $('pause-label').textContent = p ? `EchoPath is paused. ${gestureText(true)}` : `EchoPath is running. ${gestureText(false)}`;
  $('gesture-hint').textContent = gestureText(p);
  setChip('chip-state', p ? 'warn' : 'ok', p ? 'Paused' : 'Running');
  if ('mediaSession' in navigator) navigator.mediaSession.playbackState = p ? 'paused' : 'playing';
  if (p) clearOverlay(overlay);
}

$('btn-stop').addEventListener('click', () => {
  session.stop();
  wakeLock.release();
  stopMediaSession();
  clearOverlay(overlay);
  lastReport = null;
  audio.earcon('stop');
  announcer.say('EchoPath stopped.');
  show('welcome');
});

function setChip(id: string, state: CheckState, text: string): void {
  const el = $(id);
  el.dataset.state = state;
  el.querySelector('.txt')!.textContent = text;
}

let lastChipUpdate = 0;
session.onFrame = (r) => {
  lastReport = r;
  if (settings.debugOverlay) drawOverlay(overlay, video, r, settings.centerWidth, settings.corridorWidth);
  const now = performance.now();
  if (now - lastChipUpdate > 300) {
    lastChipUpdate = now;
    updateChips(r);
  }
  if (dialog.open) renderStats(r.stats);
};

function updateChips(r: FrameReport): void {
  const ch = audio.outputChannels;
  const delay = audio.outputLatencyMs;
  setChip(
    'chip-audio',
    ch < 2 ? 'bad' : delay > 120 ? 'warn' : 'ok',
    ch < 2 ? 'Mono: no direction' : `${settings.mode === 'spatial' ? 'Spatial' : 'Stereo'}${delay > 120 ? ' · Bluetooth delay' : ''}`,
  );
  const m = r.motion;
  if (!m) setChip('chip-motion', 'idle', settings.mount === 'table' ? 'Table mode' : 'No motion sensor');
  else setChip('chip-motion', m.walking ? 'ok' : 'idle', m.walking ? `Walking ${m.speed.toFixed(1)} m/s` : 'Standing');
  const fps = r.stats.fps;
  setChip('chip-perf', fps >= 12 ? 'ok' : fps >= 6 ? 'warn' : 'bad', `${fps.toFixed(0)} fps`);
  const banner = $('banner');
  const msg = r.policy.blocked
    ? `Path blocked${r.policy.guideSide ? `: step ${r.policy.guideSide}` : ''}`
    : r.quality === 'dark'
      ? 'Too dark to see well'
      : r.quality === 'blurry'
        ? 'Camera view blurry or covered'
        : '';
  banner.hidden = !msg;
  banner.textContent = msg;
}

function radarLoop(now: number): void {
  if (current !== 'running') return;
  drawRadar(radar, session.state === 'idle' ? null : lastReport, settings.fovDeg, now);
  requestAnimationFrame(radarLoop);
}

function renderStats(st: FrameReport['stats']): void {
  const f = (n: number) => (Number.isFinite(n) ? n.toFixed(0) : '–');
  $('stats').textContent =
    `${st.fps.toFixed(1)} frames per second, inference ${f(st.inferenceP50)} ms\n` +
    `Capture to sound p95: ${f(st.latencyP95)} ms (median ${f(st.latencyP50)} ms)\n` +
    `${MODELS[st.model as keyof typeof MODELS]?.title ?? st.model}, ${st.inputWidth}px, ${st.backend} in ${st.where}\n` +
    `Audio output: ${audio.outputChannels} channel(s), delay ${f(audio.outputLatencyMs)} ms${session.mirror ? ', camera mirrored' : ''}`;
}

// ---------------------------------------------------------------------------
// Track run: lane guidance + live run stats (KineticSpatial)
// ---------------------------------------------------------------------------
async function startTrack(): Promise<void> {
  const usingFile = testVideo !== null;
  status('Starting track mode', usingFile ? 'Loading the test video.' : 'Your browser will ask for the camera and your location. Choose Allow for both.', { busy: true });
  if (!usingFile) announcer.say('Your browser will ask for the camera and your location. Choose Allow for both.');
  const source: FrameSource = usingFile ? new FileSource(tvideo, testVideo!) : new CameraSource(tvideo, settings.cameraId, 60);
  try {
    await source.start();
  } catch (e) {
    const err = e instanceof CameraError ? e : new CameraError(String(e), 'other');
    const msg = cameraHelp(err);
    status('Camera unavailable', msg, { retry: true });
    audio.earcon('warning');
    announcer.say(msg, { interrupt: true });
    return;
  }
  // The object model only powers "runner ahead"; lane guidance never waits for it.
  if (settings.trackObstacles && trackDetector.model !== 'efficientdet_lite0')
    void trackDetector.load('efficientdet_lite0').catch(() => {});
  await wakeLock.acquire();
  setTrackPaused(false);
  $('screen-track').classList.add('worn');
  show('track');
  // Running: the camera faces the way you run. Only mirror if explicitly set to face you.
  track.mirror = source.kind === 'camera' && settings.cameraFacing === 'toward';
  tvideo.style.transform = track.mirror ? 'scaleX(-1)' : '';
  track.start(source);
  startMediaSession();
  audio.earcon('start');
  announcer.say(
    'Track mode. Silence means you are centred in your lane. A ping from one side means you are drifting toward that line. Press and hold to pause, double-tap for your stats.',
  );
}

function setTrackPaused(p: boolean): void {
  $('screen-track').classList.toggle('paused', p);
  $('btn-tpause').textContent = p ? 'Resume' : 'Pause';
  $('track-hint').textContent = p ? 'Press and hold anywhere to resume.' : 'Press and hold anywhere to pause. Double-tap to hear your stats.';
  $('track-label').textContent = p ? 'Track guidance paused. Activate to resume.' : 'Track guidance running. Activate to pause.';
  setChip('tchip-state', p ? 'warn' : 'ok', p ? 'Paused' : 'Running');
  if ('mediaSession' in navigator) navigator.mediaSession.playbackState = p ? 'paused' : 'playing';
}

function toggleTrackPause(): void {
  if (track.state === 'running') {
    track.pause();
    setTrackPaused(true);
    audio.earcon('pause');
    announcer.say('Paused. Press and hold to resume.');
  } else if (track.state === 'paused') {
    track.resume();
    setTrackPaused(false);
    audio.earcon('resume');
    announcer.say('Resumed.');
  }
}

function sayStats(): void {
  if (track.state === 'idle') return;
  announcer.say(track.describe(), { interrupt: true, system: false, priority: 0 });
}

function stopTrack(): void {
  track.stop();
  wakeLock.release();
  stopMediaSession();
  audio.earcon('stop');
  announcer.say(`Run finished. ${track.describe()}`);
  show('welcome');
}

attachGestures($('track-target'), () => toggleTrackPause(), () => sayStats(), () => toggleTrackPause());
$('btn-tpause').addEventListener('click', () => toggleTrackPause());
$('btn-tstats').addEventListener('click', () => sayStats());
$('btn-tstop').addEventListener('click', () => stopTrack());
$('btn-tsettings').addEventListener('click', () => openSettings());

let lastTrackUi = 0;
track.onFrame = (r: TrackReport) => {
  drawLaneGauge($<HTMLCanvasElement>('lane-gauge'), r);
  if (settings.debugOverlay) drawLaneOverlay($<HTMLCanvasElement>('toverlay'), tvideo, r);
  const now = performance.now();
  if (now - lastTrackUi < 250) return;
  lastTrackUi = now;
  const run = r.run;
  $('m-time').textContent = formatDuration(run.elapsedS);
  $('m-dist').textContent = run.distanceM >= 1000 ? `${(run.distanceM / 1000).toFixed(2)} km` : `${Math.round(run.distanceM)} m`;
  $('m-pace').textContent = formatPace(run.paceS);
  $('m-cad').textContent = run.cadence ? String(Math.round(run.cadence)) : '–';
  $('m-hr').textContent = run.heartRate ? String(run.heartRate) : '–';
  $('m-laps').textContent = String(run.laps);
  setChip('tchip-lane', r.lost ? 'bad' : r.level === 'centred' ? 'ok' : 'warn', r.lost ? 'No lane lines' : r.level === 'centred' ? 'In lane' : 'Drifting');
  const gps = runTracker.gpsState;
  setChip('tchip-gps', gps === 'ok' ? 'ok' : gps === 'waiting' ? 'warn' : 'idle', gps === 'ok' ? 'GPS' : gps === 'waiting' ? 'GPS searching' : 'Step distance');
  setChip('tchip-hr', run.heartRate ? 'ok' : 'idle', run.heartRate ? `${run.heartRate} bpm` : 'No HR');
  setChip('tchip-perf', r.fps >= 24 ? 'ok' : r.fps >= 12 ? 'warn' : 'bad', `${r.fps.toFixed(0)} fps`);
};

// ---------------------------------------------------------------------------
// Headphone buttons (Media Session): play/pause toggles, next = describe
// ---------------------------------------------------------------------------
let mediaEl: HTMLAudioElement | null = null;

function silentWav(seconds = 2, rate = 8000): string {
  const n = seconds * rate;
  const buf = new ArrayBuffer(44 + n);
  const v = new DataView(buf);
  const w = (o: number, s: string) => [...s].forEach((c, i) => v.setUint8(o + i, c.charCodeAt(0)));
  w(0, 'RIFF');
  v.setUint32(4, 36 + n, true);
  w(8, 'WAVEfmt ');
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true);
  v.setUint16(22, 1, true);
  v.setUint32(24, rate, true);
  v.setUint32(28, rate, true);
  v.setUint16(32, 1, true);
  v.setUint16(34, 8, true);
  w(36, 'data');
  v.setUint32(40, n, true);
  new Uint8Array(buf, 44).fill(128); // 8-bit silence
  return URL.createObjectURL(new Blob([buf], { type: 'audio/wav' }));
}

/**
 * Best-effort: a silent looping media element makes the browser treat
 * EchoPath as "playing", so Bluetooth headphone buttons reach us.
 */
function startMediaSession(): void {
  if (!('mediaSession' in navigator)) return;
  try {
    mediaEl ??= Object.assign(new Audio(silentWav()), { loop: true });
    void mediaEl.play().catch(() => {});
    navigator.mediaSession.metadata = new MediaMetadata({ title: 'EchoPath', artist: 'Audio navigation' });
    navigator.mediaSession.setActionHandler('play', () => (track.state === 'paused' ? toggleTrackPause() : session.state === 'paused' && togglePause()));
    navigator.mediaSession.setActionHandler('pause', () => (track.state === 'running' ? toggleTrackPause() : session.state === 'running' && togglePause()));
    navigator.mediaSession.setActionHandler('nexttrack', () => (track.state !== 'idle' ? sayStats() : describe()));
    navigator.mediaSession.setActionHandler('previoustrack', () => (track.state !== 'idle' ? sayStats() : describe()));
    navigator.mediaSession.playbackState = 'playing';
  } catch {
    /* handlers unsupported */
  }
}

function stopMediaSession(): void {
  mediaEl?.pause();
  if ('mediaSession' in navigator) navigator.mediaSession.playbackState = 'none';
}

// ---------------------------------------------------------------------------
// Battery: a dead phone mid-walk means silent guidance, so warn early
// ---------------------------------------------------------------------------
type BatteryLike = { level: number; charging: boolean; addEventListener(t: string, f: () => void): void };
let battery: BatteryLike | null = null;
const batteryWarned = new Set<number>();

async function refreshBattery(): Promise<void> {
  const nav = navigator as Navigator & { getBattery?: () => Promise<BatteryLike> };
  if (!battery && nav.getBattery) {
    battery = await nav.getBattery().catch(() => null);
    battery?.addEventListener('levelchange', onBattery);
    battery?.addEventListener('chargingchange', onBattery);
  }
  onBattery();
}

function onBattery(): void {
  if (!battery) {
    setCheck('battery', 'idle', 'Not reported by this browser');
    return;
  }
  const pct = Math.round(battery.level * 100);
  const state: CheckState = battery.charging || pct > 30 ? 'ok' : pct > 15 ? 'warn' : 'bad';
  const text = `${pct}%${battery.charging ? ', charging' : ''}`;
  setCheck('battery', state, text);
  const chip = $('chip-battery');
  chip.hidden = false;
  setChip('chip-battery', state, `Battery ${text}`);
  if ((session.state !== 'idle' || track.state !== 'idle') && !battery.charging) {
    for (const lvl of [20, 10]) {
      if (pct <= lvl && !batteryWarned.has(lvl)) {
        batteryWarned.add(lvl);
        audio.earcon('attention');
        announcer.say(`Battery is at ${pct} percent.`);
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Devices: Bluetooth headphones connecting / disconnecting
// ---------------------------------------------------------------------------
let deviceTimer: number | undefined;
navigator.mediaDevices?.addEventListener?.('devicechange', () => {
  clearTimeout(deviceTimer);
  // Let the OS finish switching its default output first.
  deviceTimer = window.setTimeout(async () => {
    if (audio.ctx) {
      const bt = await audio.autoSelectBluetooth().catch(() => null);
      if (bt) {
        update({ audioOutputId: bt.deviceId });
      } else if (settings.audioOutputId) {
        await audio.setOutput(settings.audioOutputId).catch(() => audio.setOutput(''));
      } else {
        await audio.rebuild().catch(() => {});
      }
    }
    if (dialog.open) void refreshDevices();
    if (current === 'sound') void refreshSound();
    void refreshChecks();
    if (session.state === 'idle' && track.state === 'idle') return;
    audio.earcon('attention');
    const mono = audio.outputChannels === 1;
    announcer.say(mono ? MONO_HELP_SPOKEN : `Sound output changed to ${await outputLabel()}.`);
  }, 800);
});

// Backgrounding pauses the camera in mobile browsers: warn, and recover on return (US-1.3).
document.addEventListener('visibilitychange', async () => {
  const active = session.state !== 'idle' ? session : track.state !== 'idle' ? track : null;
  if (!active) return;
  if (document.hidden) {
    audio.earcon('warning');
    announcer.say('EchoPath is in the background. Guidance is paused.', { interrupt: true });
    return;
  }
  await wakeLock.reacquire();
  await audio.unlock().catch(() => {});
  const src = active.currentSource;
  if (src instanceof CameraSource && !src.active) {
    try {
      await src.start();
    } catch {
      active.fail('The camera could not restart. Tap Stop, then Start.');
      return;
    }
  }
  if (active.state === 'running') announcer.say('EchoPath is back and running.');
});

// ---------------------------------------------------------------------------
// Settings (US-5.4): persisted on device, fully labelled for screen readers
// ---------------------------------------------------------------------------
function openSettings(): void {
  fillForm();
  void refreshDevices();
  dialog.showModal();
  $('settings-title').focus();
}
$('btn-settings-welcome').addEventListener('click', openSettings);
$('btn-settings-run').addEventListener('click', openSettings);

function fillForm(): void {
  form.querySelectorAll<HTMLInputElement>('input[name=mode]').forEach((r) => (r.checked = r.value === settings.mode));
  setVal('volume', String(Math.round(settings.volume * 100)));
  setVal('spatialSpread', String(settings.spatialSpread));
  setVal('soundStyle', settings.soundStyle);
  setVal('sensitivity', settings.sensitivity);
  setVal('blockDistance', String(settings.blockDistance));
  setVal('corridorWidth', String(Math.round(settings.corridorWidth * 100)));
  setVal('fovDeg', String(settings.fovDeg));
  setVal('model', settings.model);
  setVal('verbosity', settings.verbosity);
  setVal('cameraFacing', settings.cameraFacing);
  setVal('theme', settings.theme);
  setVal('mount', settings.mount);
  setChecked('looming', settings.looming);
  setChecked('voiceGuidance', settings.voiceGuidance);
  setChecked('debugOverlay', settings.debugOverlay);
  setChecked('heartbeat', settings.heartbeat);
  setVal('cueDensity', settings.cueDensity);
  setVal('trackCueSide', settings.trackCueSide);
  setVal('trackDeadband', String(Math.round(settings.trackDeadband * 100)));
  setChecked('trackHaptics', settings.trackHaptics);
  setVal('trackAnnounce', settings.trackAnnounce);
  setVal('trackAnnounceMinutes', String(settings.trackAnnounceMinutes));
  setVal('lapMeters', String(settings.lapMeters));
  setVal('runStepLength', String(settings.runStepLength));
  setVal('maxHeartRate', String(settings.maxHeartRate));
  setChecked('trackObstacles', settings.trackObstacles);
  syncOutputs();
}

function setVal(name: string, v: string) {
  (form.elements.namedItem(name) as HTMLInputElement | HTMLSelectElement).value = v;
}
function setChecked(name: string, v: boolean) {
  (form.elements.namedItem(name) as HTMLInputElement).checked = v;
}
function syncOutputs(): void {
  const input = (n: string) => form.elements.namedItem(n) as HTMLInputElement;
  const pairs: [string, string, string][] = [
    ['blockDistance', 'blockDistanceOut', ' metres'],
    ['corridorWidth', 'corridorOut', ' percent'],
    ['fovDeg', 'fovOut', ' degrees'],
    ['spatialSpread', 'spreadOut', ' times'],
    ['trackDeadband', 'deadbandOut', ' percent'],
    ['volume', '', ' percent'],
  ];
  for (const [name, out, unit] of pairs) {
    const el = input(name);
    if (out) (form.elements.namedItem(out) as HTMLOutputElement).value = el.value;
    el.setAttribute('aria-valuetext', el.value + unit); // screen readers say "2 metres", not "2"
  }
}

form.addEventListener('input', (e) => {
  const t = e.target as HTMLInputElement;
  if (!t.name) return;
  syncOutputs();
  const patch: Partial<Settings> = {};
  switch (t.name) {
    case 'mode':
      patch.mode = t.value as Settings['mode'];
      break;
    case 'volume':
      patch.volume = Number(t.value) / 100;
      break;
    case 'corridorWidth':
      patch.corridorWidth = Number(t.value) / 100;
      break;
    case 'blockDistance':
    case 'fovDeg':
    case 'spatialSpread':
    case 'trackAnnounceMinutes':
    case 'lapMeters':
    case 'runStepLength':
    case 'maxHeartRate': {
      const n = Number(t.value);
      if (!Number.isFinite(n) || t.value === '') return;
      patch[t.name] = n;
      break;
    }
    case 'trackDeadband':
      patch.trackDeadband = Number(t.value) / 100;
      break;
    case 'cameraId':
      patch.cameraId = t.value;
      void switchCamera(t.value);
      break;
    case 'audioOutputId':
      patch.audioOutputId = t.value;
      void audio
        .setOutput(t.value)
        .then(() => audio.earcon('ok'))
        .catch(() => announcer.say('Could not switch to that sound output.'));
      break;
    case 'looming':
    case 'voiceGuidance':
    case 'debugOverlay':
    case 'heartbeat':
    case 'trackHaptics':
    case 'trackObstacles':
      patch[t.name] = t.checked;
      if (t.name === 'debugOverlay' && !t.checked) clearOverlay(overlay);
      break;
    default:
      (patch as Record<string, string>)[t.name] = t.value;
  }
  update(patch);
  if (t.name === 'cameraFacing') updateMirror();
  if (t.name === 'volume') audio.earcon('ok'); // let the user hear the new level
  if (t.name === 'spatialSpread') void audio.spatialTest(2.5);
});

function update(patch: Partial<Settings>): void {
  settings = { ...settings, ...patch };
  saveSettings(settings);
  applySettings(settings);
}

function applySettings(s: Settings): void {
  audio.setVolume(s.volume);
  audio.setMode(s.mode);
  audio.style = s.soundStyle;
  audio.spread = s.spatialSpread;
  announcer.voiceGuidance = s.voiceGuidance;
  session.applySettings(s);
  if (s.theme === 'auto') delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = s.theme;
  $('pip').hidden = !s.debugOverlay;
  $('tpip').hidden = !s.debugOverlay;
  renderMount();
  renderActivity();
  applyMountUi();
}

$('btn-hp-check').addEventListener('click', async () => {
  dialog.close();
  await audio.unlock().catch(() => {});
  const wasRunning = session.state === 'running';
  if (wasRunning) {
    session.pause();
    setPaused(true);
  }
  await headphoneCheck();
  if (wasRunning) {
    session.resume();
    setPaused(false);
  }
  show(session.state === 'idle' ? 'welcome' : 'running');
});

$('btn-spatial-test').addEventListener('click', async (e) => {
  const btn = e.currentTarget as HTMLButtonElement;
  await audio.unlock().catch(() => {});
  if (settings.audioOutputId) await audio.setOutput(settings.audioOutputId).catch(() => {});
  btn.disabled = true;
  btn.textContent = 'Listen: the sound moves left, ahead, right and back…';
  announcer.showText('Playing spatial test. The sound moves from your left, to ahead, to your right, and back.');
  await audio.spatialTest();
  btn.disabled = false;
  btn.textContent = 'Test spatial sound (left, ahead, right)';
});

function showBtSettingsMsg(msg: string, type: 'ok' | 'bad' | 'idle' = 'idle'): void {
  const el = $('bt-settings-msg');
  if (!el) return;
  el.hidden = false;
  el.textContent = msg;
  el.dataset.type = type;
}

/** Fill the camera and sound-output pickers and update the Bluetooth card. */
async function refreshDevices(): Promise<void> {
  const camSel = $<HTMLSelectElement>('camera-select');
  const outSel = $<HTMLSelectElement>('output-select');
  const cams = await listCameras().catch(() => []);
  fillSelect(camSel, 'Automatic (rear camera on phones)', cams, settings.cameraId, 'Camera');

  const outs = await audio.getAudioOutputs().catch(() => []);
  const validOuts = outs.filter((d) => !d.isDefault && d.deviceId !== 'communications');

  if (AudioEngine.canChooseOutput) {
    outSel.disabled = false;
    outSel.replaceChildren(new Option('System default (Follows Bluetooth in OS)', ''));
    validOuts.forEach((d, i) => {
      const icon = d.isBluetooth ? '🎧 [Bluetooth] ' : '🔊 ';
      const opt = new Option(`${icon}${d.label || `Output ${i + 1}`}`, d.deviceId);
      outSel.add(opt);
    });
    outSel.value = validOuts.some((d) => d.deviceId === settings.audioOutputId) ? settings.audioOutputId : '';
  } else {
    outSel.disabled = true;
    outSel.replaceChildren(new Option('Follows your device (choose headphones in Bluetooth settings)', ''));
  }

  // Update Bluetooth status card in Settings
  const label = await outputLabel();
  const handsFree = /hands-?free|headset|communication/i.test(label);
  const isBt = /bluetooth|earphone|headphone|airpod|bud|headset|wireless|shokz|beats|bose|sony|jbl|wh-|wf-|galaxy/i.test(label);
  const ch = audio.outputChannels;
  const delay = audio.outputLatencyMs;

  const titleEl = $('bt-active-title');
  if (titleEl) titleEl.textContent = label;

  const descEl = $('bt-active-desc');
  if (descEl) {
    if (handsFree) {
      descEl.textContent = 'Headset hands-free mode (mono). Left and right cannot be heard. Choose "Stereo" in Windows sound settings.';
    } else if (isBt) {
      descEl.textContent = 'Connected to Bluetooth earphones (stereo 3D spatial cues active).';
    } else if (!settings.audioOutputId) {
      descEl.textContent = 'Audio follows your OS default output. When you connect Bluetooth headphones, sound routes automatically.';
    } else {
      descEl.textContent = 'Directly routed to the selected output.';
    }
  }

  const badgeEl = $('bt-status-badge');
  if (badgeEl) {
    badgeEl.className = 'bt-chip';
    if (handsFree) {
      badgeEl.classList.add('bt-chip-warn');
      badgeEl.textContent = 'Mono (Hands-Free)';
    } else if (isBt || settings.audioOutputId) {
      badgeEl.classList.add('bt-chip-ok');
      badgeEl.textContent = 'Connected';
    } else {
      badgeEl.classList.add('bt-chip-idle');
      badgeEl.textContent = 'Default';
    }
  }

  const iconEl = $('bt-status-icon');
  if (iconEl) {
    iconEl.textContent = isBt || settings.audioOutputId ? '🎧' : '🌐';
  }

  const chanEl = $('bt-meta-channels');
  if (chanEl) {
    chanEl.textContent = ch >= 2 ? `Stereo (${ch} channels)` : 'Mono: no 3D direction';
    chanEl.style.color = ch < 2 ? 'var(--bad)' : 'var(--fg)';
  }

  const delayEl = $('bt-meta-delay');
  if (delayEl) {
    delayEl.textContent = delay > 0 ? `Latency: ~${Math.round(delay)} ms${delay > 120 ? ' (Bluetooth delay)' : ''}` : 'Latency: not reported';
  }

  // Update HR status in Settings
  const hrEl = $('settings-hr-status');
  if (hrEl) {
    hrEl.textContent = hr.connected
      ? `Connected to ${hr.name} (${hr.current ? `${hr.current} BPM` : 'reading...'})`
      : 'Heart-rate monitor: not connected';
  }
}

function fillSelect(sel: HTMLSelectElement, auto: string, list: MediaDeviceInfo[], current: string, fallback: string): void {
  sel.replaceChildren(new Option(auto, ''));
  list.forEach((d, i) => sel.add(new Option(d.label || `${fallback} ${i + 1}`, d.deviceId)));
  sel.value = list.some((d) => d.deviceId === current) ? current : '';
}

// Bluetooth controls in Settings dialog
$('btn-settings-connect-bt')?.addEventListener('click', async () => {
  await audio.unlock().catch(() => {});
  showBtSettingsMsg('Opening device chooser…');
  const res = await audio.selectBluetoothOutput();
  if (res) {
    update({ audioOutputId: res.deviceId });
    await audio.setOutput(res.deviceId);
    await refreshDevices();
    await refreshSound();
    audio.earcon('ok');
    showBtSettingsMsg(`Connected to ${res.label}. Audio is routed to your earphones.`, 'ok');
    announcer.say(`Connected to ${res.label}.`);
  } else {
    await refreshDevices();
    await refreshSound();
    showBtSettingsMsg(
      'No device selected. Pair your Bluetooth headphones in your computer/phone settings, then select them from the list below or tap Detect again.',
      'bad',
    );
    announcer.say('No Bluetooth earphones selected.');
  }
});

$('btn-settings-refresh-bt')?.addEventListener('click', async () => {
  await audio.unlock().catch(() => {});
  const bt = await audio.autoSelectBluetooth().catch(() => null);
  if (bt && !settings.audioOutputId) {
    update({ audioOutputId: bt.deviceId });
  }
  await refreshDevices();
  await refreshSound();
  audio.earcon('ok');
  showBtSettingsMsg('Device list refreshed.', 'ok');
});

$('btn-settings-test-audio')?.addEventListener('click', async () => {
  await audio.unlock().catch(() => {});
  if (settings.audioOutputId) await audio.setOutput(settings.audioOutputId).catch(() => {});
  showBtSettingsMsg('Playing stereo test chimes (left then right)…');
  await audio.testSound();
  showBtSettingsMsg('Test chime played. If you did not hear it in your earphones, select them in the dropdown above.', 'ok');
});

$('btn-settings-hr')?.addEventListener('click', async () => {
  if (!HeartRateMonitor.supported) {
    announcer.say('Web Bluetooth is not supported in this browser. Use Chrome or Edge.');
    showBtSettingsMsg('Web Bluetooth not supported in this browser.', 'bad');
    return;
  }
  try {
    showBtSettingsMsg('Connecting to Bluetooth heart-rate monitor…');
    await hr.connect();
    showBtSettingsMsg(`Connected to ${hr.name}.`, 'ok');
    announcer.say(`Connected to ${hr.name}.`);
  } catch (e) {
    if ((e as Error).name !== 'NotFoundError') {
      showBtSettingsMsg('Could not connect to heart-rate monitor.', 'bad');
      announcer.say('Could not connect to heart-rate monitor.');
    } else {
      showBtSettingsMsg('Heart-rate pairing cancelled.', 'idle');
    }
  }
  void refreshDevices();
  void refreshChecks();
});

$('btn-calibrate').addEventListener('click', () => {
  const m = Number($<HTMLInputElement>('calib-m').value);
  if (session.state === 'idle') {
    announcer.say('Start walking mode first, with one person standing straight ahead.');
    return;
  }
  const fov = Number.isFinite(m) && m > 0 ? session.calibrateFov(m) : null;
  if (fov === null) {
    announcer.say('No single person clearly in view. Ask them to stand fully in frame, straight ahead, then try again.');
    return;
  }
  update({ fovDeg: fov });
  fillForm();
  audio.earcon('ok');
  announcer.say(`Calibrated. Field of view set to ${fov} degrees.`);
});

$('btn-disclaimer').addEventListener('click', () => {
  announcer.unlock();
  readDisclaimer();
});

$('btn-offline').addEventListener('click', async (e) => {
  const btn = e.currentTarget as HTMLButtonElement;
  btn.disabled = true;
  const files = [
    ...Object.values(MODELS).map((m) => m.file),
    'vendor/mediapipe/vision_wasm_nosimd_internal.wasm',
    'vendor/ort/ort-wasm-simd-threaded.jsep.wasm',
    'vendor/ort/ort-wasm-simd-threaded.jsep.mjs',
  ];
  try {
    for (const [i, f] of files.entries()) {
      btn.textContent = `Saving ${i + 1} of ${files.length}…`;
      // The service worker caches these on the way through (CacheFirst).
      const r = await fetch(new URL(f, BASE));
      await r.arrayBuffer();
    }
    btn.textContent = 'All models saved for offline use';
    announcer.say('All models saved for offline use.');
  } catch {
    btn.textContent = 'Saving failed. Tap to retry.';
    announcer.say('Saving models failed. Check your connection.');
  } finally {
    btn.disabled = false;
  }
});

$<HTMLInputElement>('file-video').addEventListener('change', (e) => {
  const f = (e.target as HTMLInputElement).files?.[0] ?? null;
  testVideo = f;
  announcer.say(f ? `Test video selected. Tap Start to use it instead of the camera.` : 'Using the camera.');
});

$('btn-log').addEventListener('click', () => {
  const blob = new Blob(
    [JSON.stringify({ app: 'EchoPath', exportedAt: new Date().toISOString(), settings, events: session.log }, null, 2)],
    { type: 'application/json' },
  );
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `echopath-log-${Date.now()}.json`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
});

$('btn-reset').addEventListener('click', () => {
  update({ ...DEFAULT_SETTINGS, disclaimerAccepted: settings.disclaimerAccepted, headphoneCheckDone: settings.headphoneCheckDone });
  fillForm();
  announcer.say('Settings reset.');
});

dialog.addEventListener('close', () => {
  (track.state !== 'idle' ? $('track-target') : session.state === 'idle' ? $('btn-start') : pauseTarget).focus();
});

// Initial state (after every const above is initialised).
applySettings(settings);
void audio.setOutput(settings.audioOutputId); // remembered headphones; applied when audio starts
void refreshChecks();

// Dev/test hook (used by automated checks; harmless in production).
(window as unknown as { echopath: unknown }).echopath = { session, track, audio, detector, motion, runTracker, get settings() { return settings; } };
