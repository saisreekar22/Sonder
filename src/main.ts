import './style.css';
import { Session, type FrameReport } from './app/session';
import { AudioEngine, classifyOutput } from './audio/engine';
import { DepthClient } from './depth/client';
import { CameraError, CameraSource, listCameras, shouldMirror, WakeLock, type FrameSource } from './camera/source';
import { DEFAULT_SETTINGS, isWorn, loadSettings, saveSettings, type Activity, type Mount, type Settings } from './core/settings';
import { DetectionClient } from './detect/client';
import { MODELS } from './detect/detector';
import { MotionSensor } from './sensors/motion';
import { Announcer } from './speech/announcer';
import { clearOverlay, drawOverlay } from './ui/overlay';
import { drawRadar } from './ui/radar';
import { RunTracker } from './track/devices';
import { formatDuration, formatPace } from './track/run';
import { TrackSession, type TrackReport } from './track/trackSession';
import { drawLaneGauge, drawLaneOverlay } from './ui/laneGauge';
import { TrackSimulator } from './sim/simulator';
import { WalkSimulator } from './sim/walkSim';
import { Listener } from './voice/listener';
import { matchIntent, type Intent } from './voice/intents';
import { VoiceMenu, type MenuStep } from './voice/menu';

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const BASE = new URL(import.meta.env.BASE_URL, location.href).href;

let settings: Settings = loadSettings();
const audio = new AudioEngine();
const announcer = new Announcer({ polite: $('sr-polite'), assertive: $('sr-assertive') }, (d) => audio.duck(d));
const detector = new DetectionClient(BASE);
const motion = new MotionSensor();
const session = new Session(settings, audio, announcer, detector, motion);
const runTracker = new RunTracker(motion);
// Track mode's "runner ahead" detector: fast model on the CPU, so the GPU stays free for 60 fps lane guidance.
const trackDetector = new DetectionClient(BASE, false);
/** Settings in effect for track mode (simulator overrides applied). */
const eff = (): Settings => (simOverrides ? { ...settings, ...simOverrides } : settings);
/** While simulating, the course settings follow the simulated course. */
let simOverrides: Partial<Settings> | null = null;
let sim: TrackSimulator | null = null;
let wsim: WalkSimulator | null = null;
const track = new TrackSession(audio, announcer, trackDetector, runTracker, () => (simOverrides ? { ...settings, ...simOverrides } : settings), motion);
const tvideo = $<HTMLVideoElement>('tvideo');
const wakeLock = new WakeLock();
/** Depth AI for the virtual cane and echolocation (GPU when available). */
const depthClient = new DepthClient(BASE, true);
session.depthClient = depthClient;
const video = $<HTMLVideoElement>('video');
const overlay = $<HTMLCanvasElement>('overlay');
const radar = $<HTMLCanvasElement>('radar');
const dialog = $<HTMLDialogElement>('settings');
const form = $<HTMLFormElement>('settings-form');
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
type ScreenId = 'voice' | 'welcome' | 'disclaimer' | 'sound' | 'headphones' | 'status' | 'running' | 'track';
let current: ScreenId = 'welcome';

function show(id: ScreenId): void {
  current = id;
  updateKeepAlive();
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
  if (settings.activity === 'walk' && (settings.depthCane || settings.echoEverySec > 0))
    void depthClient.load().catch((e) => console.warn('[EchoPath] depth unavailable:', e));
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

async function startRunning(simSource?: FrameSource): Promise<void> {
  status('Starting', simSource ? 'Starting the simulator.' : 'Your browser will ask to use the camera. Choose Allow.', {
    busy: true,
  });
  if (!simSource) announcer.say('Your browser will ask to use the camera. Choose Allow.');
  const source: FrameSource = simSource ?? new CameraSource(video, settings.cameraId, 30, settings.wideAngle);
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
  if (classifyOutput(await outputLabel()) === 'speakers')
    announcer.say('Sound is playing through the laptop speakers, not headphones. Connect your headphones for direction.');
  setPaused(false);
  applyMountUi();
  show('running');
  await session.start(source);
  updateKeepAlive();
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
  if (session.state === 'idle') return;
  const src = new CameraSource(video, deviceId, 30, settings.wideAngle);
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

/** Bigger audio buffers on Bluetooth stop crackle and dropouts (Settings -> Audio buffer). */
async function applyLatencyMode(kind: ReturnType<typeof classifyOutput>): Promise<void> {
  const mode =
    settings.latencyMode === 'auto' ? (kind === 'bt-stereo' || kind === 'bt-handsfree' ? 'balanced' : 'interactive') : settings.latencyMode;
  await audio.setLatencyMode(mode).catch(() => {});
}

async function refreshSound(): Promise<void> {
  await audio.unlock().catch(() => {});
  const label = await outputLabel();
  const ch = audio.outputChannels;
  const delay = audio.outputLatencyMs;
  const kind = classifyOutput(label);
  const handsFree = kind === 'bt-handsfree';
  const speakers = kind === 'speakers';
  setCheck('out-device', handsFree || speakers ? 'bad' : 'ok', label + (speakers ? ' (laptop speakers, not headphones)' : ''));
  await applyLatencyMode(kind);
  setCheck('out-stereo', ch >= 2 ? 'ok' : 'bad', ch >= 2 ? `Yes (${ch} channels)` : 'No, mono');
  setCheck(
    'out-delay',
    delay > 120 ? 'warn' : 'ok',
    delay > 0 ? `about ${Math.round(delay)} ms${delay > 120 ? ' (Bluetooth: cues arrive a bit late)' : ''}` : 'Not reported',
  );
  const problem = $('out-problem');
  if (speakers) {
    problem.hidden = false;
    problem.innerHTML =
      '<strong>Sound is going to the laptop speakers.</strong> Your Bluetooth headphones are not connected for audio. Open the fix steps below, connect them, then press Reconnect sound.';
  } else if (ch < 2 || handsFree) {
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
    announcer.showText('The sound circles all the way around you: ahead, right, behind, left.');
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

/** Bluetooth keep-alive: only while guidance runs, only on Bluetooth output. */
function updateKeepAlive(): void {
  const guiding = (current === 'running' && session.state === 'running') || (current === 'track' && track.state === 'running');
  if (!guiding) return audio.setKeepAliveWanted(false);
  void outputLabel().then((l) => {
    const k = classifyOutput(l);
    audio.setKeepAliveWanted(k === 'bt-stereo' || k === 'bt-handsfree');
  });
}

function setPaused(p: boolean): void {
  setTimeout(updateKeepAlive, 0);
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
  stopWalkSimulator();
  hideLiveWalkView();
  wakeLock.release();
  stopMediaSession();
  clearOverlay(overlay);
  lastReport = null;
  audio.earcon('stop');
  announcer.say('EchoPath stopped.');
  returnHome();
});

// Live views take the camera's real shape (portrait phone or landscape webcam/photo).
for (const v of [video, tvideo])
  v.addEventListener('resize', () => {
    const p = v.parentElement;
    if (p?.classList.contains('sim-view') && v.videoWidth) p.style.setProperty('--ar', String(v.videoWidth / v.videoHeight));
  });
let lastWsimText = 0;
session.onScanDone = (lines) => {
  scanLines = lines;
};
$('btn-scan').addEventListener('click', () => {
  if (session.state !== 'running') return;
  scanLines = [];
  session.startScan();
});

/** Practice / demo: the real WALK pipeline on a simulated park path with poles, bins and people. */
async function startWalkSimulator(): Promise<void> {
  await audio.unlock().catch(() => {});
  announcer.unlock();
  motion.stop(); // the simulator provides motion
  wsim = new WalkSimulator(motion);
  simOverrides = { mount: 'chest', cameraFacing: 'same', fovDeg: 65, depthCane: true };
  session.applySettings(eff());
  void depthClient.load().catch((e) => console.warn('[EchoPath] depth unavailable:', e));
  $('wsim-view').prepend(wsim.canvas);
  $('wsim-panel').hidden = false;
  $('screen-running').classList.add('simulating');
  await startRunning(wsim.source());
  if (wsim) wsim.frozen = session.state !== 'running';
  announcer.showText('Walk simulator running. The autopilot walker is blind: it only stops or steps aside when EchoPath tells it to.');
}

function stopWalkSimulator(): void {
  if (!wsim) return;
  wsim.stop();
  wsim.canvas.remove();
  wsim = null;
  simOverrides = null;
  session.applySettings(settings);
  $('wsim-panel').hidden = true;
  $('screen-running').classList.remove('simulating');
  if (settings.mount !== 'table') void motion.start();
}

type Scene = 'live-walk' | 'live-line' | 'live-lane' | 'walk' | 'stadium' | 'road';

/**
 * Live track modes with the real camera, shown large like the live scan: a
 * single painted line (any colour: white, yellow or blue) or track lanes.
 */
let liveTrack: 'line' | 'lane' | null = null;

async function startLiveTrack(kind: 'line' | 'lane'): Promise<void> {
  await audio.unlock().catch(() => {});
  announcer.unlock();
  liveTrack = kind;
  simOverrides = kind === 'line' ? { trackCourse: 'line', lineColor: 'any', trackCountdown: false } : { trackCourse: 'lanes', trackCountdown: false };
  $('sim-panel').classList.add('real');
  await startTrack(undefined, true);
  if (track.state === 'idle') {
    // Camera didn't open: undo the live settings.
    liveTrack = null;
    simOverrides = null;
    $('sim-panel').classList.remove('real');
    return;
  }
  announcer.showText(
    kind === 'line'
      ? 'Live: point the camera at the painted line a few steps ahead, then walk or run along it.'
      : 'Live: point the camera down your lane, a few steps ahead.',
  );
}

/** Live walk view: the real camera, large, with what EchoPath sees drawn on it. */
let liveWalk = false;
let scanLines: string[] = [];

function showLiveWalkView(): void {
  liveWalk = true;
  $('wsim-view').prepend(video);
  $('wsim-panel').classList.add('live', 'real');
  $('wsim-panel').hidden = false;
}

function hideLiveWalkView(): void {
  if (!liveWalk) return;
  liveWalk = false;
  $('pip').prepend(video);
  $('wsim-view').style.removeProperty('--ar');
  $('wsim-panel').classList.remove('live', 'real');
  $('wsim-panel').hidden = true;
  $('wsim-truth').classList.remove('scan');
}

/** Live walking in the real world: camera on, scan around you, then guidance. */
async function startLiveWalk(): Promise<void> {
  await audio.unlock().catch(() => {});
  announcer.unlock();
  void depthClient.load().catch((e) => console.warn('[EchoPath] depth unavailable:', e));
  showLiveWalkView();
  await startRunning();
  if (session.state !== 'running') return hideLiveWalkView();
  scanLines = [];
  session.startScan();
}

/** One dropdown: the live modes and the simulations. */
async function startScene(scene: Scene): Promise<void> {
  if (scene === 'live-walk') return startLiveWalk();
  if (scene === 'live-line') return startLiveTrack('line');
  if (scene === 'live-lane') return startLiveTrack('lane');
  if (scene === 'walk') return startWalkSimulator();
  return startSimulator(scene);
}

$('btn-practice').addEventListener('click', () => void startScene($<HTMLSelectElement>('practice-scene').value as Scene));
$<HTMLSelectElement>('wsim-scene').addEventListener('change', (e) => {
  const v = (e.target as HTMLSelectElement).value as Scene;
  if (v === 'walk' || !wsim) return;
  $('btn-stop').click();
  void startSimulator(v as 'stadium' | 'road');
});

for (const [id, key] of [
  ['wsim-left', 'left'],
  ['wsim-right', 'right'],
] as const) {
  const el = $(id);
  const set = (v: boolean) => () => wsim && (wsim.input[key] = v);
  el.addEventListener('pointerdown', set(true));
  el.addEventListener('pointerup', set(false));
  el.addEventListener('pointerleave', set(false));
  el.addEventListener('pointercancel', set(false));
}
$('wsim-auto').addEventListener('click', (e) => {
  if (!wsim) return;
  wsim.autopilot = !wsim.autopilot;
  const b = e.currentTarget as HTMLButtonElement;
  b.setAttribute('aria-pressed', String(wsim.autopilot));
  b.textContent = `Autopilot: ${wsim.autopilot ? 'on' : 'off'}`;
});

function setChip(id: string, state: CheckState, text: string): void {
  const el = $(id);
  el.dataset.state = state;
  el.querySelector('.txt')!.textContent = text;
}

let lastChipUpdate = 0;
session.onFrame = (r) => {
  lastReport = r;
  if (liveWalk) {
    drawOverlay($<HTMLCanvasElement>('wsim-overlay'), video, r, settings.centerWidth, settings.corridorWidth);
    if (performance.now() - lastWsimText > 300) {
      lastWsimText = performance.now();
      const now = r.policy.blocked
        ? r.policy.noWayAround || !r.policy.guideSide ? 'STOP' : `step ${r.policy.guideSide}`
        : r.depth?.center && r.depth.center.z < 2.5 ? `obstacle ${r.depth.center.z.toFixed(1)} m` : 'clear';
      const leaves = r.ground && r.ground.corridor > 0.15 ? ' · leaves on the path' : r.ground && r.ground.left + r.ground.right > 0.2 ? ' · leaves at the edge' : '';
      const el = $('wsim-truth');
      el.classList.toggle('scan', !!r.scan || scanLines.length > 0);
      el.textContent = r.scan
        ? `Scanning ${Math.round(r.scan.progress * 100)}%${r.scan.sweptDeg > 5 ? ` · turned ${Math.round(r.scan.sweptDeg)}°` : ''}\nTurn slowly left, then right, then face forward.`
        : `${scanLines.length ? scanLines.join('\n') + '\n' : ''}Now: ${now}${leaves} · ${r.stats.fps.toFixed(0)} fps`;
    }
  }
  if (wsim) {
    wsim.guidance = { blocked: r.policy.blocked, side: r.policy.guideSide, noWay: r.policy.noWayAround, pass: r.policy.pacing?.side ?? null, caneM: r.depth?.center && r.depth.center.z < 2.5 ? r.depth.center.z : null };
    drawOverlay($<HTMLCanvasElement>('wsim-overlay'), wsim.video, r, settings.centerWidth, settings.corridorWidth);
    if (performance.now() - lastWsimText > 300) {
      lastWsimText = performance.now();
      const t = wsim.aheadTruth(), sc = wsim.score;
      const heard = r.policy.blocked
        ? r.policy.noWayAround || !r.policy.guideSide ? 'STOP' : `step ${r.policy.guideSide}`
        : r.depth?.center && r.depth.center.z < 2.5 ? `cane: ${r.depth.center.z.toFixed(1)} m` : 'clear';
      const bump = wsim.lastBump && performance.now() - wsim.lastBump.at < 2500 ? ` · BUMPED: ${wsim.lastBump.what}` : '';
      $('wsim-truth').textContent =
        `Truth: ${t ? `${t.what} ${t.distance.toFixed(1)} m${Math.abs(t.side) > 0.15 ? (t.side > 0 ? ' right' : ' left') : ' ahead'}` : 'path clear'} · EchoPath: ${heard}${bump}
` +
        `${Math.round(sc.metres)} m · in the way ${sc.inWay}, avoided ${sc.cleared} · bumps ${sc.bumps} (head ${sc.headBumps}) · helped ${sc.assists}`;
    }
  }
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
  const msg = r.scan
    ? `Scanning ${Math.round(r.scan.progress * 100)}%: turn slowly`
    : r.policy.blocked
    ? r.policy.noWayAround
      ? 'Path blocked: no clear way around'
      : `Path blocked${r.policy.guideSide ? `: step ${r.policy.guideSide}${r.policy.guideFrom === 'path' ? ' (stays on path)' : ''}` : ''}`
    : r.policy.pacing
      ? `Person ahead walking your way${r.policy.pacing.side ? `: pass ${r.policy.pacing.side}` : ''}`
    : r.policy.unexplainedLooming
      ? `Something approaching from the ${r.policy.unexplainedLooming}`
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
const SIM_OVERRIDES: Record<'stadium' | 'road', Partial<Settings>> = {
  stadium: { trackCourse: 'lanes', lineColor: 'white', mountHeight: 1.3, cameraFacing: 'same' },
  road: { trackCourse: 'line', lineColor: 'yellow', mountHeight: 1.3, cameraFacing: 'same' },
};

/** Practice / demo: the real track pipeline driven by the built-in simulator. */
async function startSimulator(pick?: 'stadium' | 'road'): Promise<void> {
  await audio.unlock().catch(() => {});
  announcer.unlock();
  const course = pick ?? (settings.trackCourse === 'lanes' ? 'stadium' : 'road');
  motion.stop(); // the simulator provides motion; ignore the real phone's sensors meanwhile
  sim = new TrackSimulator(course, motion);
  simOverrides = SIM_OVERRIDES[course];
  $<HTMLSelectElement>('sim-course').value = course;
  $('sim-view').prepend(sim.canvas);
  $('sim-panel').hidden = false;
  $('screen-track').classList.add('simulating');
  await startTrack(sim.source());
  announcer.showText('Simulator running. The autopilot runner only hears EchoPath. Use Left and Right, or the arrow keys, to drift on purpose.');
}

function stopSimulator(): void {
  if (!sim) return;
  sim.stop();
  sim.canvas.remove();
  sim = null;
  simOverrides = null;
  $('sim-panel').hidden = true;
  $('screen-track').classList.remove('simulating');
  if (settings.mount !== 'table') void motion.start();
}

for (const [id, key] of [
  ['sim-left', 'left'],
  ['sim-right', 'right'],
] as const) {
  const el = $(id);
  const set = (v: boolean) => () => sim && (sim.input[key] = v);
  el.addEventListener('pointerdown', set(true));
  el.addEventListener('pointerup', set(false));
  el.addEventListener('pointerleave', set(false));
  el.addEventListener('pointercancel', set(false));
}
document.addEventListener('keydown', (e) => {
  if (!sim) return;
  if (e.key === 'ArrowLeft') sim.input.left = true;
  if (e.key === 'ArrowRight') sim.input.right = true;
});
document.addEventListener('keyup', (e) => {
  if (!sim) return;
  if (e.key === 'ArrowLeft') sim.input.left = false;
  if (e.key === 'ArrowRight') sim.input.right = false;
});
$('sim-auto').addEventListener('click', (e) => {
  if (!sim) return;
  sim.autopilot = !sim.autopilot;
  const b = e.currentTarget as HTMLButtonElement;
  b.setAttribute('aria-pressed', String(sim.autopilot));
  b.textContent = `Autopilot: ${sim.autopilot ? 'on' : 'off'}`;
});
$<HTMLSelectElement>('sim-course').addEventListener('change', (e) => {
  if (!sim) return;
  if ((e.target as HTMLSelectElement).value === 'walk') {
    stopTrack();
    void startWalkSimulator();
    return;
  }
  const c = (e.target as HTMLSelectElement).value as 'stadium' | 'road';
  sim.setCourse(c);
  simOverrides = SIM_OVERRIDES[c];
  announcer.say(c === 'road' ? 'Road with a yellow guide line.' : 'Four hundred metre track, lane three.');
});
$('sim-demo').addEventListener('click', (e) => {
  if (!sim) return;
  const on = !sim.demoOn;
  sim.setDemo(on);
  sim.onDemoDone = () => {
    $('sim-demo').setAttribute('aria-pressed', 'false');
    $('sim-truth').classList.remove('scan');
    simScore.length = 0; // accuracy from here on: normal running on the line
    announcer.say('All cases done. Back to normal running on the line.', { interrupt: true });
    announcer.showText('All cases done. Back to normal running: the readout shows how closely EchoPath holds the line.');
  };
  (e.currentTarget as HTMLElement).setAttribute('aria-pressed', String(on));
  // The demo shows the runner-ahead cases: make sure that detector is on.
  if (on && !trackDetector.model) void trackDetector.load('efficientdet_lite0').catch(() => {});
  announcer.say(on ? 'Demo of every case. Each one is described on screen.' : 'Demo off.', { interrupt: true });
});
$('sim-slower').addEventListener('click', () => sim && (sim.runner.speed = Math.max(1.5, sim.runner.speed - 0.5)));
$('sim-faster').addEventListener('click', () => sim && (sim.runner.speed = Math.min(7, sim.runner.speed + 0.5)));

/** Truth vs estimate, for the simulator readout. */
const simScore: { t: number; truth: number; est: number | null }[] = [];

async function startTrack(simSource?: FrameSource, realWorld = false): Promise<void> {
  status('Starting track mode', simSource ? 'Starting the simulator.' : 'Your browser will ask for the camera and your location. Choose Allow for both.', { busy: true });
  if (!simSource) announcer.say('Your browser will ask for the camera and your location. Choose Allow for both.');
  const source: FrameSource = simSource ?? new CameraSource(tvideo, settings.cameraId, 60);
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
  // The guide-line system's sound pack (falls back to the glide tone if it can't decode).
  if (settings.trackStyle === 'pg') await audio.loadPgSounds(BASE).catch(() => false);
  // The object model only powers "runner ahead"; lane guidance never waits for it.
  if (settings.trackObstacles && trackDetector.model !== 'efficientdet_lite0')
    void trackDetector.load('efficientdet_lite0').catch(() => {});
  await wakeLock.acquire();
  setTrackPaused(false);
  $('screen-track').classList.add('worn');
  show('track');
  // Running: the camera faces the way you run. Only mirror if explicitly set to face you.
  track.mirror = !simSource && source.kind === 'camera' && settings.cameraFacing === 'toward';
  // Live view: the real camera, large, with what EchoPath sees drawn on it.
  if ((!simSource && settings.debugOverlay) || realWorld) {
    $('sim-view').prepend(tvideo);
    if (tvideo.videoWidth) $('sim-view').style.setProperty('--ar', String(tvideo.videoWidth / tvideo.videoHeight));
    $('sim-panel').classList.add('live');
    $('sim-panel').hidden = false;
  }
  tvideo.style.transform = track.mirror ? 'scaleX(-1)' : '';
  startMediaSession();
  const intro =
    settings.trackStyle === 'tone'
      ? 'A quiet steady tone means you are on line. If it moves to one side and gets harsher, you are drifting toward that line.'
      : settings.trackStyle === 'guideline'
        ? 'Silence means you are on line. Beeps in one ear tell you to steer that way. A high warning means you are at the edge. Stop means stop.'
        : 'Silence means you are centred. A ping from one side means you are drifting toward that line. Stop means stop.';
  if (settings.trackCountdown) {
    announcer.say(`Track mode. ${intro} Ready.`, { interrupt: true });
    await new Promise((r) => setTimeout(r, Math.min(9000, 1200 + intro.length * 55)));
    for (const n of ['3', '2', '1']) {
      audio.earcon('ok');
      announcer.say(n, { system: false, priority: 0, interrupt: true });
      await new Promise((r) => setTimeout(r, 1000));
    }
    announcer.say('Go.', { system: false, priority: 0, interrupt: true });
    audio.earcon('start');
    track.start(source);
    updateKeepAlive();
    if (sim) sim.frozen = false;
  } else {
    track.start(source);
    updateKeepAlive();
    if (sim) sim.frozen = false;
    audio.earcon('start');
    announcer.say(`Track mode. ${intro} Press and hold to pause, double-tap for your stats.`);
  }
}

function setTrackPaused(p: boolean): void {
  setTimeout(updateKeepAlive, 0);
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
    if (sim) sim.frozen = true;
    setTrackPaused(true);
    audio.earcon('pause');
    announcer.say('Paused. Press and hold to resume.');
  } else if (track.state === 'paused') {
    track.resume();
    if (sim) sim.frozen = false;
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
  stopSimulator();
  if (liveTrack) {
    liveTrack = null;
    simOverrides = null;
    $('sim-panel').classList.remove('real');
  }
  const demoBtn = $('sim-demo');
  demoBtn.setAttribute('aria-pressed', 'false');
  $('sim-truth').classList.remove('scan');
  if ($('sim-panel').classList.contains('live')) {
    $('tpip').prepend(tvideo);
    $('sim-view').style.removeProperty('--ar');
    $('sim-panel').classList.remove('live');
    $('sim-panel').hidden = true;
  }
  wakeLock.release();
  stopMediaSession();
  audio.earcon('stop');
  announcer.say(track.finish(), { interrupt: true });
  returnHome();
}

attachGestures($('track-target'), () => toggleTrackPause(), () => sayStats(), () => toggleTrackPause());
$('btn-tpause').addEventListener('click', () => toggleTrackPause());
$('btn-tstats').addEventListener('click', () => sayStats());
$('btn-tstop').addEventListener('click', () => stopTrack());
$('btn-tsettings').addEventListener('click', () => openSettings());

let lastTrackUi = 0;
let lastLiveText = 0;
track.onFrame = (r: TrackReport) => {
  const eff = simOverrides ? { ...settings, ...simOverrides } : settings;
  drawLaneGauge($<HTMLCanvasElement>('lane-gauge'), r, 0.61, eff.trackCourse);
  if (sim) {
    sim.guidance = r.guide;
    sim.halted = r.stopped;
    sim.ahead = r.runnerAhead
      ? { distance: r.runnerAhead.distance, side: r.runnerAhead.box.x + r.runnerAhead.box.w / 2 < 0.5 ? 'right' : 'left' }
      : null;
    drawLaneOverlay($<HTMLCanvasElement>('sim-overlay'), sim.canvas, r, sim.camera());
    simScore.push({ t: performance.now(), truth: sim.lateral, est: r.world ? r.world.lateral : null });
    while (simScore.length && performance.now() - simScore[0].t > 60000) simScore.shift();
  } else if ($('sim-panel').classList.contains('live')) {
    drawLaneOverlay($<HTMLCanvasElement>('sim-overlay'), tvideo, r);
    if (liveTrack && performance.now() - lastLiveText > 300) {
      lastLiveText = performance.now();
      const n = r.lane.keypoints.left.length + r.lane.keypoints.right.length;
      const el = $('sim-truth');
      el.classList.add('scan');
      el.textContent =
        `${liveTrack === 'line' ? 'Line' : 'Lane'}: ${r.lost ? 'looking for it…' : `found (${n} points)`}\n` +
        (r.stopped ? 'EchoPath: STOP\n' : r.world ? `You: ${Math.abs(r.world.lateral).toFixed(2)} m ${r.world.lateral > 0 ? 'right' : 'left'} of the ${liveTrack} · ${r.guide.magnitude > 0.05 ? `steer ${r.guide.steer > 0 ? 'right' : 'left'}` : 'on line'}\n` : '') +
        (r.bend ? `Bend to the ${r.bend} ahead\n` : '') +
        (r.runnerAhead ? `Someone ahead, ${r.runnerAhead.distance.toFixed(0)} m\n` : '') +
        `Moving: ${r.run.speed.toFixed(1)} m/s · ${Math.round(r.run.distanceM)} m`;
    }
  } else if (settings.debugOverlay) {
    drawLaneOverlay($<HTMLCanvasElement>('toverlay'), tvideo, r);
  }
  const now = performance.now();
  if (now - lastTrackUi < 250) return;
  lastTrackUi = now;
  const run = r.run;
  $('m-time').textContent = formatDuration(run.elapsedS);
  $('m-dist').textContent = run.distanceM >= 1000 ? `${(run.distanceM / 1000).toFixed(2)} km` : `${Math.round(run.distanceM)} m`;
  $('m-pace').textContent = formatPace(run.paceS);
  $('m-cad').textContent = run.cadence ? String(Math.round(run.cadence)) : '–';
  $('m-laps').textContent = String(run.laps);
  setChip(
    'tchip-lane',
    r.stopped || r.lost ? 'bad' : r.level === 'centred' ? 'ok' : 'warn',
    r.stopped ? 'STOP' : r.lost ? 'No line' : r.level === 'centred' ? (r.bend ? `On line, bend ${r.bend}` : 'On line') : 'Drifting',
  );
  const gps = runTracker.gpsState;
  setChip('tchip-gps', gps === 'ok' ? 'ok' : gps === 'waiting' ? 'warn' : 'idle', gps === 'ok' ? 'GPS' : gps === 'waiting' ? 'GPS searching' : 'Step distance');
  setChip('tchip-perf', r.fps >= 24 ? 'ok' : r.fps >= 12 ? 'warn' : 'bad', `${r.fps.toFixed(0)} fps`);
  if (sim) {
    const withEst = simScore.filter((s) => s.est !== null);
    const rms = withEst.length ? Math.sqrt(withEst.reduce((a, s) => a + (s.truth - s.est!) ** 2, 0) / withEst.length) : NaN;
    const inLane = simScore.filter((s) => Math.abs(s.truth) < (eff.trackCourse === 'lanes' ? 0.61 : 0.5)).length / Math.max(1, simScore.length);
    const demo = sim.demoStatus();
    $('sim-truth').classList.toggle('scan', !!demo);
    if (demo) {
      const now =
        r.stopped
          ? 'STOP'
          : r.runnerAhead
            ? `someone ahead ${r.runnerAhead.distance.toFixed(0)} m`
            : r.guide.magnitude > 0.05
              ? `steering sound in the ${r.guide.steer > 0 ? 'right' : 'left'} ear`
              : 'silent (on line)';
      $('sim-truth').textContent =
        `Case ${demo.n} of ${demo.total}: ${demo.title}\n${demo.expect}\nEchoPath right now: ${now}${r.bend ? ` · bend ${r.bend} ahead` : ''} · you are ${Math.abs(sim.lateral).toFixed(2)} m ${sim.lateral > 0 ? 'right' : 'left'} of the line`;
      return;
    }
    $('sim-truth').textContent =
      `Truth: ${Math.abs(sim.lateral).toFixed(2)} m ${sim.lateral > 0 ? 'right' : 'left'} · EchoPath: ${r.world ? `${Math.abs(r.world.lateral).toFixed(2)} m ${r.world.lateral > 0 ? 'right' : 'left'}` : '–'}\n` +
      `Estimate error (RMS, last min): ${Number.isFinite(rms) ? rms.toFixed(2) + ' m' : '–'} · In lane: ${(inLane * 100).toFixed(0)}% · ${sim.runner.speed.toFixed(1)} m/s · ${Math.round(sim.runner.distance)} m`;
  }
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
    // Headphone "previous" button = push-to-talk.
    navigator.mediaSession.setActionHandler('previoustrack', () => void voiceCommand());
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
  setChecked('depthCane', settings.depthCane);
  setVal('echoEverySec', String(settings.echoEverySec));
  setVal('latencyMode', settings.latencyMode);
  setChecked('btKeepAlive', settings.btKeepAlive);
  setVal('soundScene', settings.soundScene);
  setVal('sceneLevel', String(Math.round(settings.sceneLevel * 100)));
  setVal('trackCourse', settings.trackCourse);
  setVal('lineColor', settings.lineColor);
  setVal('edgeSide', settings.edgeSide);
  setVal('trackStyle', settings.trackStyle);
  setVal('earVibration', String(Math.round(settings.earVibration * 100)));
  setChecked('runBeacon', settings.runBeacon);
  setVal('mountHeight', String(settings.mountHeight));
  setVal('edgeGap', String(settings.edgeGap));
  setVal('targetPace', settings.targetPaceS ? `${Math.floor(settings.targetPaceS / 60)}:${String(settings.targetPaceS % 60).padStart(2, '0')}` : '');
  setVal('metronomeSpm', String(settings.metronomeSpm));
  setChecked('trackCountdown', settings.trackCountdown);
  setVal('trackDeadband', String(Math.round(settings.trackDeadband * 100)));
  setChecked('trackHaptics', settings.trackHaptics);
  setVal('trackAnnounce', settings.trackAnnounce);
  setVal('trackAnnounceMinutes', String(settings.trackAnnounceMinutes));
  setVal('lapMeters', String(settings.lapMeters));
  setVal('runStepLength', String(settings.runStepLength));
  setChecked('trackObstacles', settings.trackObstacles);
  setChecked('wideAngle', settings.wideAngle);
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
    ['sceneLevel', '', ' percent'],
    ['earVibration', '', ' percent'],
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
    case 'metronomeSpm':
    case 'mountHeight':
    case 'edgeGap': {
      const n = Number(t.value);
      if (!Number.isFinite(n) || t.value === '') return;
      patch[t.name] = n;
      break;
    }
    case 'trackDeadband':
      patch.trackDeadband = Number(t.value) / 100;
      break;
    case 'sceneLevel':
      patch.sceneLevel = Number(t.value) / 100;
      break;
    case 'earVibration':
      patch.earVibration = Number(t.value) / 100;
      break;
    case 'echoEverySec':
      patch.echoEverySec = Number(t.value);
      if (patch.echoEverySec > 0) void depthClient.load().catch(() => {});
      break;
    case 'targetPace': {
      const m = /^\s*(\d{1,2}):(\d{2})\s*$/.exec(t.value);
      if (t.value.trim() === '') patch.targetPaceS = 0;
      else if (m) patch.targetPaceS = Number(m[1]) * 60 + Number(m[2]);
      else return; // wait until it's a complete mm:ss
      break;
    }
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
    case 'trackCountdown':
    case 'depthCane':
    case 'btKeepAlive':
    case 'runBeacon':
    case 'wideAngle':
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
  if (t.name === 'metronomeSpm' && track.state === 'running') audio.setMetronome(settings.metronomeSpm);
  if (t.name === 'depthCane' && settings.depthCane) void depthClient.load().catch(() => {});
  if (t.name === 'trackStyle' && settings.trackStyle === 'pg') void audio.loadPgSounds(BASE);
  if (t.name === 'latencyMode') void outputLabel().then((l) => applyLatencyMode(classifyOutput(l)));
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
  audio.sceneLevel = s.sceneLevel;
  audio.setKeepAlive(s.btKeepAlive);
  if (s.soundScene !== 'surround') audio.updateScene([]);
  announcer.voiceGuidance = s.voiceGuidance;
  session.applySettings(simOverrides ? { ...s, ...simOverrides } : s);
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
  btn.textContent = 'Listen: the sound circles all the way around you…';
  announcer.showText('Playing spatial test. The sound circles all the way around you: ahead, right, behind, left.');
  await audio.spatialTest();
  btn.disabled = false;
  btn.textContent = 'Test spatial sound (full circle)';
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

// ---------------------------------------------------------------------------
// Voice menu (eyes-free start): speaks, listens, and always works by taps
// ---------------------------------------------------------------------------
const listener = new Listener();
const voiceMenu = new VoiceMenu({
  announcer,
  audio,
  listener,
  getSettings: () => settings,
  update,
  startWalk: () => void $('btn-start').click(),
  startTrack: () => void $('btn-start').click(),
  startSimulator: () => void startSimulator(),
  startLiveWalk: () => void startLiveWalk(),
  startScene: (scene) => void startScene(scene as Scene),
  soundCheck: () => audio.spatialTest(4),
  render: renderVoice,
  close: () => {
    /* the started mode shows its own screen */
  },
});

function renderVoice(step: MenuStep, hi: number, heard: string): void {
  $('voice-title').textContent = step.title;
  $('voice-prompt').textContent = step.prompt;
  const ol = $('voice-options');
  ol.replaceChildren(
    ...step.options.map((o, i) => {
      const li = document.createElement('li');
      li.textContent = o.label;
      if (i === hi) li.dataset.hi = '';
      return li;
    }),
  );
  $('voice-heard').textContent = heard;
  $('voice-target-label').textContent = `Tap to choose: ${step.options[hi]?.label ?? ''}`;
}

/** Tap / hold / double-tap on the voice screen (single tap waits briefly to rule out a double). */
(() => {
  const el = $('voice-target');
  const HOLD = 600, DOUBLE = 350;
  let timer: number | undefined, tapTimer: number | undefined, held = false, taps = 0, lastPointer = 0;
  const first = async () => {
    // The very first tap unlocks audio and speech (browsers require a tap).
    await audio.unlock().catch(() => {});
    announcer.unlock();
    voiceMenu.begin();
  };
  const tap = () => (voiceMenu.active ? voiceMenu.tap() : void first());
  el.addEventListener('pointerdown', () => {
    held = false;
    clearTimeout(timer);
    timer = window.setTimeout(() => {
      held = true;
      navigator.vibrate?.(30);
      if (voiceMenu.active) voiceMenu.hold();
      else void first();
    }, HOLD);
  });
  const cancel = () => clearTimeout(timer);
  el.addEventListener('pointercancel', cancel);
  el.addEventListener('pointerleave', cancel);
  el.addEventListener('pointerup', () => {
    clearTimeout(timer);
    lastPointer = performance.now();
    if (held) return;
    taps++;
    clearTimeout(tapTimer);
    tapTimer = window.setTimeout(() => {
      const n = taps;
      taps = 0;
      if (n >= 2 && voiceMenu.active) voiceMenu.back();
      else tap();
    }, DOUBLE);
  });
  el.addEventListener('contextmenu', (e) => e.preventDefault());
  // Screen readers / keyboard: activation = choose.
  el.addEventListener('click', () => {
    if (performance.now() - lastPointer > 600) tap();
  });
  el.addEventListener('keydown', (e) => {
    if (!voiceMenu.active) return;
    if (e.key === 'ArrowDown' || e.key === 'ArrowRight') {
      e.preventDefault();
      voiceMenu.hold();
    } else if (e.key === 'Escape' || e.key === 'Backspace' || e.key === 'ArrowLeft') {
      e.preventDefault();
      voiceMenu.back();
    }
  });
})();

$('btn-visual-menu').addEventListener('click', () => {
  voiceMenu.active = false;
  listener.stop();
  announcer.cancel();
  update({ voiceMenu: false });
  show('welcome');
});
$('btn-voice-menu').addEventListener('click', async () => {
  update({ voiceMenu: true });
  show('voice');
  await audio.unlock().catch(() => {});
  announcer.unlock();
  voiceMenu.begin();
});

/** After stopping: back to the voice menu (eyes-free) or the visual home. */
// ---------------------------------------------------------------------------
// Push-to-talk voice commands while walking or running (button, headphone
// "previous track" button, or the V key). The microphone opens only for this.
// ---------------------------------------------------------------------------
let micWarned = false;
let commandBusy = false;

const WALK_CMDS: Intent[] = ['describe', 'scan', 'pause', 'resume', 'stop', 'louder', 'quieter', 'calmer', 'detailed', 'help'];
const RUN_CMDS: Intent[] = ['stats', 'describe', 'pause', 'resume', 'stop', 'louder', 'quieter', 'help'];
const CMD_WORDS: Partial<Record<Intent, string>> = {
  describe: "what's around me",
  scan: 'scan',
  stats: 'stats',
  pause: 'pause',
  resume: 'resume',
  stop: 'stop',
  louder: 'louder',
  quieter: 'quieter',
  calmer: 'calmer',
  detailed: 'more detail',
};

function caption(text: string): void {
  const el = track.state !== 'idle' ? $('tcmd-caption') : $('cmd-caption');
  el.hidden = !text;
  el.textContent = text;
}

async function voiceCommand(): Promise<void> {
  const running = track.state !== 'idle';
  if (commandBusy || (!running && session.state === 'idle')) return;
  if (!listener.supported) {
    announcer.say('Voice commands need Chrome or Edge, with the microphone allowed. Use the buttons or gestures instead.', { interrupt: true });
    return;
  }
  commandBusy = true;
  try {
    const cmds = running ? RUN_CMDS : WALK_CMDS;
    const list = cmds.filter((c) => CMD_WORDS[c]).map((c) => CMD_WORDS[c]).join(', ');
    announcer.say(micWarned ? 'Listening.' : 'Listening. Bluetooth headphones may sound like a phone call for a moment.', { interrupt: true });
    micWarned = true;
    await announcer.whenIdle();
    audio.earcon('tick');
    caption('Listening…');
    const heard = await listener.listen(5000, (t) => caption(`Hearing: "${t}"`));
    const m = heard ? matchIntent(heard.alternatives, cmds) : null;
    caption(heard ? `Heard: "${heard.alternatives[0]}"` : '');
    setTimeout(() => caption(''), 3000);
    if (!m) {
      announcer.say(heard ? `Sorry, I didn't catch that. You can say: ${list}.` : 'I did not hear anything.', { interrupt: true });
      return;
    }
    runCommand(m.intent, running, list);
  } finally {
    commandBusy = false;
  }
}

function runCommand(intent: Intent, running: boolean, list: string): void {
  const vol = (d: number) => {
    update({ volume: Math.max(0.1, Math.min(1, settings.volume + d)) });
    announcer.say(d > 0 ? 'Louder.' : 'Quieter.', { interrupt: true });
  };
  switch (intent) {
    case 'describe':
      return running ? sayStats() : describe();
    case 'stats':
      return sayStats();
    case 'scan':
      scanLines = [];
      return session.startScan();
    case 'pause':
      if (running ? track.state === 'running' : session.state === 'running') return running ? toggleTrackPause() : togglePause();
      return;
    case 'resume':
      if (running ? track.state === 'paused' : session.state === 'paused') return running ? toggleTrackPause() : togglePause();
      return;
    case 'stop':
      return running ? stopTrack() : $('btn-stop').click();
    case 'louder':
      return vol(0.15);
    case 'quieter':
      return vol(-0.15);
    case 'calmer':
      update({ cueDensity: 'calm' });
      return announcer.say('Calmer cues.', { interrupt: true });
    case 'detailed':
      update({ cueDensity: 'detailed' });
      return announcer.say('More detail.', { interrupt: true });
    case 'help':
      return announcer.say(`You can say: ${list}.`, { interrupt: true });
  }
}

$('btn-voice-cmd').addEventListener('click', () => void voiceCommand());
$('btn-tvoice-cmd').addEventListener('click', () => void voiceCommand());
document.addEventListener('keydown', (e) => {
  if ((e.key === 'v' || e.key === 'V') && !(e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement || e.target instanceof HTMLTextAreaElement))
    void voiceCommand();
});

function returnHome(): void {
  if (settings.voiceMenu) {
    show('voice');
    setTimeout(() => voiceMenu.begin(), 2500);
  } else show('welcome');
}

// Initial state (after every const above is initialised).
applySettings(settings);
if (settings.voiceMenu) show('voice');
void audio.setOutput(settings.audioOutputId); // remembered headphones; applied when audio starts
void refreshChecks();

// Dev/test hook (used by automated checks; harmless in production).
(window as unknown as { echopath: unknown }).echopath = { get sim() { return sim; }, get wsim() { return wsim; }, voiceMenu, session, track, audio, detector, motion, runTracker, get settings() { return settings; } };
