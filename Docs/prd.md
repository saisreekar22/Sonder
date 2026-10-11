EchoPath PRD: Real-Time Audio Navigation for the Visually Impaired
Oct 10, 2026 · @Reya Attri

Problem statement
People who are blind, have low vision, or are walking while distracted have no free, hands-free way to hear what is ahead of them, and from which side, in real time.

The gap today

A white cane finds ground-level obstacles within about a cane's length, but misses head-height hazards (signs, branches, open cabinet doors) and gives no early warning about approaching people or cyclists.
Guide dogs are life-changing but costly and in short supply.
Wearable and smart-cane hardware that does obstacle detection typically costs hundreds of dollars and needs a separate device to carry and charge.
Phone apps that describe scenes (for example Seeing AI or Be My Eyes) are on-demand: the user must point, tap and wait, and many rely on the cloud, so they add latency and fail without signal.
Why it is solvable now

Mobile browsers expose the camera (getUserMedia), GPU/WASM inference (WebGPU, WebAssembly) and a head-related spatial audio engine (Web Audio PannerNode with HRTF) with no install.
Small open detectors (for example YOLO-family nano models, MobileNet-SSD, or RT-DETR variants) run at interactive frame rates on a recent phone, entirely on device.
Problem in one sentence: how might we turn the phone a user already owns, plus the earphones they already wear, into a continuous, low-latency, private "sense of what is around me" that tells them where things are through sound alone?

Note: vision-impairment prevalence figures (WHO estimates run past 2 billion people with some impairment) should be verified and cited before the pitch.

Vision, goals and non-goals
Vision: EchoPath is a mobile web app that turns the phone camera into a pair of ears: obstacles and people become directional sounds in the user's headphones, processed entirely on device.

Goals (hackathon MVP)

Open in a mobile browser with no install and start the camera in two taps.
Detect obstacles and people from live video at 15 FPS or better on a mid-range phone.
Convert each detection into a left/right/center audio cue within 250 ms of the frame being captured.
Run all inference locally; no video ever leaves the device.
Demo a spatial-audio mode where a sound appears to come from the object's direction and gets louder or faster as it nears.
Goals (V2)

Spoken warnings such as "person approaching, left, about three seconds".
Time-to-contact estimation from object growth between frames.
Non-goals

Replacing a white cane or guide dog. EchoPath is a supplementary aid and must say so.
Turn-by-turn route navigation or GPS.
Reading text, signs or faces (out of scope for the hackathon).
Native iOS/Android apps.
Personas
Persona

Who they are

What they need from EchoPath

Maya, the independent walker

Blind or low-vision commuter who uses a cane and a smartphone daily

Early warning of head-height obstacles and people approaching, without taking a hand off the cane

Dev, the busy pedestrian

Sighted but distracted (hands full, low light, headphones on)

Quiet, glanceless alerts for things about to cross his path

Sam, the O&M trainer

Orientation and mobility instructor who teaches clients new routes

A free tool she can demo to clients and tune (sensitivity, sound style) to each person

Maya is the primary persona. Every MVP decision is judged against her.

User stories by feature
Each story lists acceptance criteria (AC). Targets are starting points to tune on real devices. MVP = hackathon build; V2 = after the hackathon.

F1. Mobile web app with live camera (MVP)
US-1.1 As Maya, I want to open EchoPath from a link in my phone browser so that I can start without installing anything.

AC: Works in current Chrome on Android and Safari on iOS; installable as a PWA; repeat visits load from cache in under 3 seconds.
US-1.2 As Maya, I want one large Start button and clear spoken guidance for the camera permission prompt so that I can begin without sighted help.

AC: Rear camera is the default; every control has an accessible label that VoiceOver and TalkBack read; if permission is denied, a spoken message explains how to retry.
US-1.3 As Maya, I want the app to stay active while the phone hangs on a lanyard or sits in a chest pocket so that I can walk hands-free.

AC: Screen Wake Lock is requested on start; the app warns audibly if the camera stream drops or the page is backgrounded (browsers pause camera access in the background).
US-1.4 As Maya, I want to pause everything instantly so that I can take a call or step into a quiet space.

AC: A full-screen double-tap target toggles pause; a distinct sound confirms paused and resumed.
F2. Real-time obstacle and people detection (MVP)
US-2.1 As Maya, I want people and common obstacles detected from live video so that I know what is around me.

AC: Detects at least person, bicycle, car, motorcycle, bus, truck, chair, bench, potted plant, stop sign and similar COCO classes; sustained 15 FPS or more on a mid-range phone.
US-2.2 As Maya, I want to hear only about things in my walking path so that I am not overwhelmed.

AC: The frame is split into left, center and right zones; detections whose box is below a minimum size (far away) or outside the path corridor are ignored; thresholds are adjustable.
US-2.3 As Maya, I want repeated cues for the same object to be limited so that I can still hear traffic and conversation around me.

AC: A lightweight tracker assigns IDs across frames; a given object cues on first entry, then again only if it gets markedly closer or changes zone; maximum of three simultaneous cue sources.
US-2.4 (stretch) As Maya, I want walls and glass doors flagged even though they are not a detectable class so that I do not walk into them.

AC: A "large looming surface" cue triggers when the scene expands quickly across the center zone (optical-flow or monocular-depth fallback).
F3. Directional audio cues in each ear (MVP)
Browsers cannot vibrate earphones, so "vibration in each ear" is delivered as a short, buzzy pulsed tone panned hard to one side. (The Vibration API only buzzes the phone, and is unsupported in iOS Safari.)

US-3.1 As Maya, I want a cue in my left ear for something on my left, my right ear for the right, and both ears for straight ahead so that I know which side to avoid.

AC: Zone-to-pan mapping is left = -1, center = 0, right = +1; verified with a headphone test.
US-3.2 As Maya, I want a guidance cue toward the clearer side when my path is blocked so that I know which way to step.

AC: When the center zone has a close obstacle, a soft repeating tone plays in the ear of the freer side ("go right" = right ear); stops once the path clears.
US-3.3 As Maya, I want different sounds for people, vehicles and static obstacles so that I can tell them apart without thinking.

AC: Sound palette follows the mapping table in the next section; each category is distinguishable in a 5-person listening test.
US-3.4 As Maya, I want cues to get faster as things get closer so that urgency is obvious.

AC: Pulse rate scales with estimated distance (for example 1 Hz beyond 5 m up to 6 Hz inside 1 m).
US-3.5 As a first-time user, I want a quick headphone check so that I know stereo cues will work.

AC: Setup plays a tone in the left ear, then the right, and asks the user to confirm; if they hear both sides equally, it warns that speakers or mono audio may be in use.
F4. Fast on-device inference (MVP)
US-4.1 As Maya, I want everything to work with no signal and no video uploaded so that I stay private and reliable.

AC: After first load, the app works in airplane mode; zero network requests during inference (verifiable in dev tools); model files cached by a service worker.
US-4.2 As Maya, I want responses to feel instant so that a cue matches what is in front of me now.

AC: Capture-to-sound latency at p95 is 250 ms or less; median inference under 50 ms on a recent phone with WebGPU, with a WASM fallback.
US-4.3 As Maya, I want the app to keep working when my phone gets hot or slow so that it does not stall mid-walk.

AC: If FPS falls below 12 for 3 seconds, the app steps down input resolution, then model size, and tells the user once; it steps back up when stable.
US-4.4 As a developer, I want the detector behind a swappable interface so that I can compare models quickly.

AC: A single detect(frame) contract returns boxes, classes and scores; at least two models (for example RTMDet-tiny and YOLO nano, both exported to ONNX) can be selected by a flag.
F5. Spatial audio simulation (MVP)
US-5.1 As Maya, I want an object's sound to seem to come from its actual direction so that I can point toward it by ear.

AC: Each tracked object drives a Web Audio PannerNode (HRTF); azimuth is computed from the box center and the camera's horizontal field of view (assumed about 65 degrees until calibrated).
US-5.2 As Maya, I want distance to be audible so that I can judge how soon I must react.

AC: Distance is estimated from box height and a typical real-world height per class (a person is about 1.7 m); gain, pitch and pulse rate all change with distance.
US-5.3 As Maya, I want a moving object's sound to sweep across my ears so that I can follow someone passing in front of me.

AC: Panner position updates every frame with smoothing; no audible clicks or zipper noise.
US-5.4 As Sam, I want to switch between full spatial (HRTF) and simple stereo pan so that I can match what each client finds clearer.

AC: Settings include mode, master volume, sensitivity and cue-sound style, saved on device.
F6. Spoken approach warnings (V2)
US-6.1 As Maya, I want a short spoken warning when something is approaching so that I know what it is and roughly how long I have.

AC: Example: "Person, left, about three seconds." Spoken only when estimated time-to-contact is under 4 seconds and confidence is high.
US-6.2 As Maya, I want time-to-contact estimated from how fast an object grows in view so that warnings reflect real approach speed.

AC: Time-to-contact is box height divided by its rate of growth, smoothed over 5 or more frames; stationary objects while I am walking are handled by comparing against my own motion (stretch).
US-6.3 As Maya, I want speech to take priority over beeps without being cut off so that I can understand it.

AC: Beeps duck by about 12 dB during speech; at most one utterance every 2 seconds; the most urgent warning goes first; speech uses on-device text-to-speech (speechSynthesis) with pre-recorded clips as fallback.
US-6.4 As Maya, I want to choose how chatty the voice is so that I am not nagged.

AC: Verbosity options: off, urgent only, all approaching objects.
Sound design and requirements
Every category gets its own timbre so the user can tell what it is before any speech is added. Sounds are synthesized in the browser (no audio files needed for the MVP).

Category

Example classes

Cue sound

Direction

Gets more urgent by

Person

person

Soft two-note marimba blip

Spatialized to the person's azimuth

Faster repeats, higher pitch

Vehicle or cyclist

car, bus, truck, bicycle, motorcycle

Low pulsing hum with a rising sweep

Spatialized

Louder, faster pulse, adds a second tone inside 3 m

Static obstacle

chair, bench, pole, plant, sign

Short dry wooden "tock"

Spatialized

Faster repeats

Blocked path

center zone obstructed and close

Harsh buzz in both ears

Center

Continuous inside 1 m

Go-this-way guide

freer side of the frame

Gentle rising tone

Hard-panned to that ear

Stops when the path clears

System

start, pause, low FPS, camera lost

Distinct short earcons

Center

Not applicable

Cross-cutting requirements

Priority order when sources compete: blocked path, then vehicles, then people, then static obstacles; at most three sources sound at once.
All cues are mixed through one limiter so the output never clips or spikes in volume.
A fixed safe maximum gain protects hearing; the master volume cannot exceed it.
Cues must leave room for ambient sound: support open-ear and transparency-mode headphones, and recommend them in onboarding.
Settings (volume, sensitivity, mode, verbosity) persist locally and are reachable by screen reader.
Technical architecture
architecture · 8 stages, 1 V2 branch

architecture · 8 stages, 1 V2 branch

Frames flow from the camera through a worker-hosted detector into a tracker that turns boxes into zones, distances and time-to-contact. The cue engine then drives spatial audio in the MVP and spoken warnings in V2.

Model options (verify licences before shipping)

Option

Runtime

Licence

Notes

RTMDet-tiny (OpenMMLab)

ONNX Runtime Web

Apache-2.0

Your named pick; export through MMDeploy to ONNX

YOLOX-nano or tiny

ONNX Runtime Web

Apache-2.0

Very small; simple post-processing

MediaPipe Object Detector (EfficientDet-Lite or SSD-MobileNet)

MediaPipe Tasks Vision

Apache-2.0

Fastest setup in a browser; good day-one baseline

Ultralytics YOLO nano

ONNX Runtime Web or TF.js

AGPL-3.0

Easy tooling, but AGPL obligations apply if you distribute it

Recommended path: get an end-to-end loop working on the MediaPipe baseline first, then swap in RTMDet-tiny behind the same detect(frame) interface if time allows.

Geometry from the box alone. With focal length in pixels f, box height h, box center x in a frame of width w, and a typical real-world height H per class, direction, distance and time-to-contact are:

\theta = \arctan\!\left(\frac{x - w/2}{f}\right) \qquad d \approx \frac{f \cdot H}{h} \qquad \tau \approx \frac{h}{dh/dt}

Estimates are rough by design: they only need to rank "far, near, very near" and "approaching or not". Calibrate f per device if possible.

Latency budget (starting targets, capture to sound)

Stage

Target

Capture and resize

30 ms

Inference

80 ms

Tracking and cue logic

10 ms

Audio scheduling and output (wired headphones)

60 ms

Headroom

70 ms

Total (p95)

250 ms

Safety, accessibility and privacy
A missed detection could mean a fall or collision, so the product must be honest about what it cannot do.

Safety

First-run disclaimer, read aloud and confirmed: EchoPath is a supplementary aid, not a replacement for a cane, guide dog or sighted assistance, and it can miss obstacles (glass, stairs, drop-offs, low light).
Fail loudly: if the camera, model or audio stops, play a clear warning earcon within 1 second rather than going silent.
Low-light check: if the frame is too dark or blurry for reliable detection, tell the user.
Never imply certainty: the MVP does not say "path clear"; silence means "nothing detected", not "safe".
Test with blind and low-vision users and an O&M professional before any real-world release; for the hackathon, demo in a controlled space.
Accessibility

Fully operable with VoiceOver and TalkBack; large touch targets; no information conveyed by visuals alone.
High-contrast visual debug overlay (bounding boxes, zones) for sighted teammates and judges, off by default.
Privacy

All video processing stays in the browser; frames are never stored or sent anywhere.
No account, no analytics that include camera or location data.
Camera indicator remains visible in the browser while active; the app states plainly that nothing is recorded.
Success metrics and demo plan
Metric

Target

How to measure

Frame rate

15 FPS or more sustained for 5 minutes

On-screen FPS counter on 2 test phones

Capture-to-sound latency (p95)

250 ms or less

Timestamp at frame capture vs. audio scheduled

Person detection recall in the path corridor

90% or more on a self-recorded test walk

Label a 5-minute walk video, compare detections

False alerts per minute

3 or fewer

Same test walk, count cues with nothing present

Direction accuracy

90% of cues judged on the correct side

Blindfolded teammates identify left, center, right

Network requests during inference

0

Dev-tools network tab in airplane mode

Setup time for a new user

Under 60 seconds to first cue

Timed with a first-time tester

Demo script (3 minutes)

Open the link on a phone, tap Start with the screen reader on, pass the headphone check.
A teammate walks across the room from left to right; the judges hear the sound pan between ears (put one headphone on a judge).
Place a chair ahead: the blocked-path buzz plays and the guide tone points to the clear side.
Switch to airplane mode and show it still works.
If V2 voice is ready: a teammate walks toward the phone and it announces "Person, center, about three seconds".
Roadmap, risks and open questions
roadmap · 3 phases, 2 gates

roadmap · 3 phases, 2 gates

The MVP exists to win the demo. V2 voice work waits until real users have tested the core cues.

Risks and mitigations

Risk

Mitigation

Bluetooth headphones add audio delay (often 100 ms or more), so cues lag the scene

Use wired or low-latency earbuds for the demo; measure and report end-to-end latency

iOS Safari limits: WebGPU support varies, audio starts only after a tap, camera pauses in the background

WASM fallback, start audio on the Start tap, keep the screen awake, warn if backgrounded

Missed detections (glass, stairs, low light)

Mandatory disclaimer, fail-loud earcons, never say "path clear", test in a controlled space

Alert fatigue from too many cues

Tracker-based rate limits, path corridor, sensitivity setting, three-source cap

Distance estimates wrong for unusual sizes (children, seated people)

Use coarse bands (far, near, very near) rather than exact meters

Heat and battery drain from continuous inference

Adaptive resolution and model size, pause control

Model licence obligations (AGPL)

Prefer Apache-2.0 models; check licences before distributing

Open questions

☐ Which phones will you demo on? This decides WebGPU versus WASM as the default.
☐ Wired or Bluetooth headphones for the demo?
☐ Can you reach a blind or low-vision tester or an O&M trainer before judging?
☐ Team size and time left: is V2 voice a stretch goal or cut from the hackathon?