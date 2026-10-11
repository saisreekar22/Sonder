# EchoPath PRD: Real-Time Audio Navigation for the Visually Impaired
**v2.0 — post-grill, Oct 10, 2026 · @Reya Attri**

## 1. Problem statement
People who are blind or have low vision have no free, hands-free way to hear what is ahead of them, and from which side, in real time.

**The gap today**
- A white cane finds ground-level obstacles within about a cane's length, but gives no early warning about approaching people or cyclists.
- Guide dogs are life-changing but costly and in short supply.
- Wearable and smart-cane hardware costs hundreds of dollars and needs a separate device to carry and charge.
- Phone apps that describe scenes (Seeing AI, Be My Eyes) are on-demand: point, tap, wait — and many rely on the cloud.

**Why it is solvable now**
- Mobile Chrome on Android exposes the camera (`getUserMedia`), on-device inference (MediaPipe Tasks Vision, WASM), and stereo panning (Web Audio) with no install.
- Small open detectors (EfficientDet-Lite0, RTMDet-tiny) run at interactive frame rates on a recent phone, entirely on device.

**Problem in one sentence:** turn the phone a user already owns, plus the earphones they already wear, into a continuous, low-latency, private "sense of what is around me" that says which way to step through sound alone.

> Vision-impairment prevalence figures (WHO estimates run past 2 billion) must be verified and cited before the pitch.

## 2. Vision, goals, non-goals

**Vision:** EchoPath is a mobile web app (Android + Chrome) that turns the phone camera into a pair of ears: moving hazards become directional sounds in the user's headphones, processed entirely on device.

**MVP goals (hackathon)**
1. Open in Chrome on Android with no install; camera starts in two taps; installable as a PWA; repeat visits load from cache in under 3 seconds.
2. Detect people (primary) plus common COCO classes from live video at 15 FPS or better on a mid-range Android phone.
3. Convert each detection into a left/right/center audio cue within 250 ms of frame capture (wired measurement; see §7 latency note).
4. Run all inference locally; zero network requests during inference; model cached by service worker; works in airplane mode after first load.
5. **Direction-of-travel guidance:** when the path ahead is blocked, a tone in the freer ear tells the user which way to step.
6. Demo a person walking across the room: judges hear the cue pan between ears, then hear the guide tone pick a side when the person stands in the path.

**V2 goals (post-hackathon)**
- Spoken warnings ("person approaching, left, about three seconds") — requires time-to-contact, cut from MVP.
- Low-light / blur detection and warning.
- Looming-surface cue (walls, glass) via optical flow.
- Head-height hazard coverage via upward-tilted mount or second camera angle.

**Non-goals (locked)**
- Replacing a white cane or guide dog. EchoPath is a supplementary aid and must say so, aloud, on first run.
- Turn-by-turn route navigation or GPS.
- Reading text, signs, or faces.
- Native iOS/Android apps. **iOS is out of scope for MVP** (see ADR-0001).
- Spatial audio / HRTF rendering (see ADR-0002).
- Accuracy-metric machinery (recall, false-alert counts) — replaced by an on-screen debug readout for tuning.

## 3. Personas

| Persona | Who they are | What they need from EchoPath |
|---|---|---|
| **Maya (primary)** | Blind or low-vision commuter who uses a cane and a smartphone daily | Early warning of approaching people, without taking a hand off the cane; a clear "step this way" cue when the path is blocked |
| **Sam (secondary)** | O&M instructor who teaches clients new routes | A free tool she can demo and tune (sensitivity, corridor width) to each person |

*Dev, the distracted pedestrian, was cut: his use case (phone in a bag) contradicts the camera-forward mounting every other persona requires.*

**Real-use mounting:** phone strapped to waist, chest, or in a shirt pocket — camera facing forward. **Demo mounting:** held in hand, camera facing forward. A pants pocket is explicitly unsupported (camera faces fabric).

## 4. User stories by feature

### F1. Mobile web app with live camera (MVP)
- **US-1.1** As Maya, I want to open EchoPath from a link in Chrome so that I can start without installing anything.
  - AC: Works in current Chrome on Android; installable as PWA; repeat visits load from cache in under 3 seconds; total payload (app + model) measured and recorded — if over ~10 MB, demo phone is side-loaded via USB.
- **US-1.2** As Maya, I want one large Start button and clear spoken guidance for the camera permission prompt so that I can begin without sighted help.
  - AC: Rear camera default; every control has an accessible label TalkBack reads; if permission is denied, a spoken message explains how to retry.
- **US-1.3** As Maya, I want the app to stay active while the phone is strapped to my waist or chest so that I can walk hands-free.
  - AC: Screen Wake Lock requested on start (fully supported in Chrome/Android — no iOS fallback needed); audible warning if the camera stream drops or the page is backgrounded.
- **US-1.4** As Maya, I want to pause everything instantly so that I can take a call or step into a quiet space.
  - AC: Full-screen double-tap target toggles pause; a distinct earcon confirms paused and resumed.

### F2. Real-time detection (MVP)
- **US-2.1** As Maya, I want people and common obstacles detected from live video so that I know what is around me.
  - AC: Detects person (primary demo class) plus whatever COCO classes the chosen model outputs reliably (bicycle, car, chair, bench, potted plant, stop sign, etc. — final list locked to model capability, see §6); sustained 15 FPS on a mid-range Android phone.
- **US-2.2** As Maya, I want to hear only about things in my walking path so that I am not overwhelmed.
  - AC: Frame split into left / center / right thirds by box center-x; corridor = center third; ignore boxes below 8% of frame height (~far); corridor width and min-size are on-screen sliders (for Sam to tune live).
- **US-2.3** As Maya, I want repeated cues for the same object limited so that I can still hear traffic and conversation.
  - AC: Custom IoU + constant-velocity tracker assigns IDs across frames; a given Track cues on first entry to a zone, then again only on zone change or box-height growth >30%; maximum three simultaneous cue sources.

### F3. Directional audio cues + move guidance (MVP)
- **US-3.1** As Maya, I want a cue in my left ear for something on my left, my right ear for the right, and both ears for straight ahead.
  - AC: Zone-to-pan mapping left = −1, center = 0, right = +1; verified with the US-3.5 headphone check.
- **US-3.2** As Maya, I want a guidance cue toward the freer side when my path is blocked so that I know which way to step.
  - AC: Firing condition and hysteresis per the **Guidance Logic** in §5; guide tone is hard-panned to the freer ear; stops when the path clears (750 ms with no near-band track in center zone).
- **US-3.3** As Maya, I want different sounds for people, vehicles, and static objects so that I can tell them apart without thinking.
  - AC: Sound palette per §8; each category distinguishable in a 5-person listening test (person blip, vehicle hum, static tock built first; blocked-buzz reuses vehicle timbre at harsher settings).
- **US-3.4** As Maya, I want cues to get faster as things get closer so that urgency is obvious.
  - AC: Pulse rate scales with distance band: far ≈ 1 Hz, near ≈ 3 Hz, very near ≈ 6 Hz.
- **US-3.5** As a first-time user, I want a quick headphone check so that I know stereo cues will work.
  - AC: Setup plays a tone in the left ear, then the right, and asks the user to confirm; warns if both sides don't sound equal (mono audio, some Bluetooth headsets). **This check now also validates Bluetooth stereo**, which some headsets mangle.

### F4. Fast on-device inference (MVP)
- **US-4.1** As Maya, I want everything to work with no signal and no video uploaded so that I stay private and reliable.
  - AC: After first load, works in airplane mode; zero network requests during inference (verifiable in dev tools); model cached by service worker.
- **US-4.2** As Maya, I want responses to feel instant so that a cue matches what is in front of me now.
  - AC: Capture-to-sound p95 ≤ 250 ms **measured with wired earbuds**; Bluetooth adds 100–200 ms codec delay, accepted as a known limitation (ADR-0002); median inference < 50 ms target on a recent phone.
- **US-4.3** As Maya, I want the app to keep working when my phone gets hot or slow so that it does not stall mid-walk.
  - AC: If FPS < 12 for 3 s: step input width 1280 → 960 → 640, then model lite → nano; one spoken earcon on first step-down; step back up only after 10 s stable above 15 FPS.
- **US-4.4** As a developer, I want the detector behind a swappable interface so that I can compare models quickly.
  - AC: Single `detect(frame)` contract returns boxes, classes, scores; MediaPipe EfficientDet-Lite0 is day-one baseline; RTMDet-tiny (ONNX) swappable behind the same flag.

### F5. Settings (MVP, replaces the old "spatial audio" feature)
- **US-5.1** As Sam, I want to switch sensitivity, corridor width, cue-sound style, and master volume so that I can match each client.
  - AC: Settings persist locally (localStorage / IndexedDB), reachable by TalkBack, applied live without restart.

**Cut from MVP:** F5 spatial audio (HRTF), F6 spoken warnings, US-2.4 looming-surface cue, low-light check.

## 5. Guidance logic (the core decision — US-3.2)

Runs every frame on tracked output, before any sound is emitted:

```
WEIGHT: very near = 3, near = 2        (far tracks cue normally, never block)
score(side) = Σ weights of near/very-near Tracks in that side's zone

BLOCKED = any near/very-near Track in the CENTER zone

if BLOCKED:
    freer = side with the LOWER score
    # hysteresis — don't flip-flop between ears:
    switch sides only if the other side beats freer by ≥ 2 points
                       AND ≥ 1.5 s since last switch
    tie or near-tie → keep current side
    emit guide tone, hard-panned to freer ear
    pulse rate: 3 Hz if the blocking track is near, 6 Hz if very near
    if the center track is very near (< 2 m) → ADD both-ears emergency buzz
else:
    stop guide tone; emit normal category cues only

CLEAR: no near-band Track in center zone for 750 ms → path clear
```

Edge cases covered: both sides obstructed → guide points to the *less* dead side, buzz fires if the center object is very near; a far static object cues normally and never blocks; a person crossing left-to-right re-cues on zone change and the guide follows them without ear-flipping (margin rule).

## 6. Detection scope

- **Model:** MediaPipe Tasks Vision Object Detector (EfficientDet-Lite0, int8) as day-one baseline; `detect(frame)` interface allows swap to RTMDet-tiny (ONNX, Apache-2.0) if time allows.
- **Classes:** exactly what the model outputs and the demo needs — **person is the star**; vehicles (bicycle, car, motorcycle, bus, truck) and statics (chair, bench, potted plant, stop sign) as available. No phantom classes (no "pole," no generic "sign").
- **Zones:** frame-width thirds, assigned by box center-x. Corridor = center third.
- **Size gate:** ignore boxes < 8% of frame height (~10 m for a person).
- **Distance bands (coarse, never meters):**
  - very near < 2 m, near 2–6 m, far > 6 m
  - `d ≈ f·H/h`, H = 1.7 m for person, hardcoded per-class table otherwise; f from a device lookup (demo phone first); bands are wide enough to absorb f error.
- **Tracker:** custom ~100-line IoU + constant-velocity tracker. Re-cue gates: first corridor entry, zone change, box-height growth > 30%. Max 3 simultaneous cue sources.

## 7. Technical architecture

```
Camera (getUserMedia, rear)
  → main thread: capture → createImageBitmap → post to Worker
  → Worker: MediaPipe detector → boxes {x,y,w,h,class,score}
  → main thread: Tracker → zone/corridor filter → guidance logic (§5)
  → cue engine → Web Audio (stereo pan) → headphones
Backpressure: drop frames older than 200 ms.
Debug overlay (off by default): boxes, zones, band, FPS, latency readout.
```

**Latency budget (capture → sound, wired):**

| Stage | Target |
|---|---|
| Capture + resize | 30 ms |
| Inference | 80 ms |
| Tracking + cue logic | 10 ms |
| Audio scheduling | 60 ms |
| Headroom | 70 ms |
| **Total p95** | **250 ms** |

*Bluetooth adds 100–200 ms codec delay on top — accepted, mitigated by pulsed (non-sweeping) cues and a slow-walking demo teammate (~1 m/s → 10–20 cm positional error).*

**Offline model hosting:** the web app is hosted normally; on first load the service worker precaches the model artifact so all subsequent runs (including airplane mode) are fully local. No install step, no app-store model bundling.

## 8. Sound design

All synthesized in Web Audio (no audio files). All cues are **short pulses** — never continuous sweeps — so Bluetooth codec delay smears nothing.

| Category | Classes | Cue | Pan | Urgency |
|---|---|---|---|---|
| Mover — person | person | Soft two-note blip | Track zone | Faster repeats, higher pitch |
| Mover — vehicle | bicycle, car, bus, truck, motorcycle | Low pulsing hum | Track zone | Louder, faster pulse |
| Static object | chair, bench, potted plant, stop sign | Short dry "tock" | Track zone | Faster repeats |
| Blocked path | center zone obstructed (near/very near) | Guide tone (rising) | **Hard-panned to freer ear** | 3 Hz near → 6 Hz very near |
| Emergency | center track very near (< 2 m) | Harsh buzz | Both ears | Continuous |
| System | start, pause, low FPS, camera lost | Distinct earcons | Center | — |

**Mixing:** all sources → single `DynamicsCompressorNode` (threshold −6 dB, ratio 20, attack 0.003, release 0.25) → master `GainNode` capped at 0.8 (user volume scales 0–0.8 only). Fixed safe maximum protects hearing.

**Priority when sources compete:** emergency buzz > blocked-path guide > vehicles > people > statics; max three simultaneous sources.

**Open-ear recommendation:** onboarding recommends open-ear or transparency-mode headphones so ambient sound (traffic, speech) remains audible.

## 9. Safety, accessibility, privacy

**Safety**
- First-run disclaimer, **spoken** via `speechSynthesis`, confirmed once per device (stored flag): EchoPath is a supplementary aid, not a replacement for a cane, guide dog, or sighted assistance; it can miss obstacles (glass, stairs, drop-offs, low light); **silence means "nothing detected," never "safe."** One full-screen "I understand" double-tap button; 2-second shortened version on revisit.
- **Fail loudly:** any of these trips a spoken warning earcon within 1 s and one automatic restart attempt:
  1. `MediaStreamTrack.onended` or `video` error
  2. `visibilitychange` / `pagehide` (camera pauses in background)
  3. FPS watchdog: no new frame in 1 s
- Near head-height obstacles (signs, branches, open cabinets) are **not covered** by the MVP and must be named in the disclaimer and the pitch.
- Demo in a controlled, well-lit space; no blind/low-vision user testing is possible before the hackathon — blindfolded teammates stand in, and this is stated honestly in the pitch.

**Accessibility**
- Fully operable with TalkBack; large touch targets; no information by visuals alone; high-contrast debug overlay for sighted teammates/judges (off by default).

**Privacy**
- All processing in the browser; frames never stored or sent; no account; no camera/location analytics; camera indicator visible while active; the app states plainly that nothing is recorded.

## 10. Demo plan (a slice of the 3-minute pitch)

1. Open link on the demo phone, tap Start (TalkBack on), pass the Bluetooth stereo check.
2. Teammate walks slowly across the room left → right; judges hear the cue pan between ears (one earbud handed to a judge).
3. Teammate stops in the center path: guide tone picks a freer side; step closer → pulse quickens; inside ~2 m → both-ears buzz.
4. Airplane mode on: still works — zero network requests.
5. (Backup) full demo video recorded in advance in case of venue Wi-Fi/lighting failure.

## 11. Risks and mitigations

| Risk | Mitigation |
|---|---|
| Bluetooth audio delay (100–200 ms) | Accepted (ADR-0002); pulsed cues only; slow-walking demo teammate; wired measurement for the 250 ms budget |
| Missed detections (glass, stairs, low light) | Mandatory spoken disclaimer; fail-loud earcons; never say "path clear"; controlled-space demo |
| Alert fatigue | Tracker rate limits, corridor + size gate, sensitivity slider, 3-source cap |
| Distance estimates wrong for unusual sizes (children, seated people) | Coarse bands only (far/near/very near), never meters |
| Heat / battery drain | Adaptive resolution + model ladder (§US-4.3), pause control |
| Model licence obligations | Apache-2.0 models only (MediaPipe, RTMDet); no AGPL |

## 12. Resolved decisions (summary of the grilling session)

| # | Decision | Answer |
|---|---|---|
| Q1 | Demo platform | Android + Chrome only; iOS out of scope (ADR-0001) |
| Q2 | Demo audio | Bluetooth, accepted delay; pulsed cues (ADR-0002) |
| Q3 | V2 voice | Cut from hackathon |
| Q4 | User testing | Blindfolded teammates only; no accuracy-metric machinery |
| Q5 | Demo scope | Small slice of the 3-min pitch; backup video recorded |
| Q6 | Dev persona | Cut |
| Q7 | Honest scope | MVP wedge = early warning of *moving* hazards + step guidance; head-height gap disclosed |
| Q8 | Class list | Locked to model output; person is the demo star |
| Q9 | Zone/corridor | Frame thirds by center-x; corridor = center third; 8% size gate; live sliders |
| Q10 | Distance | Coarse bands (<2 / 2–6 / >6 m); f from device lookup; no auto-calibration |
| Q11 | Tracker | Custom IoU + constant-velocity, ~100 lines |
| Q12 | Looming-surface cue | Cut; noted as investigated/deferred |
| Q13 | Blocked-path cue conflict | Guide tone *replaces* center buzz; buzz reserved for <2 m emergency |
| Q14 | HRTF | Cut from MVP (ADR-0002) |
| Q15 | Sound palette | 3 core cues + earcons first; listening test on those |
| Q16 | Limiter | Single compressor, master gain capped at 0.8 |
| Q17 | Pipeline | Main: capture → bitmap → worker; worker: inference; main: track+cue+audio; drop >200 ms frames |
| Q18 | Adaptive ladder | 1280→960→640 then lite→nano; 10 s stability to step up |
| Q19 | Offline model | Service worker precache; measure payload Day 1; side-load if venue Wi-Fi is bad |
| Q20 | Disclaimer | Once per device, spoken, one big confirm button |
| Q21 | Fail-loud tripwires | track.onended / visibilitychange / FPS watchdog; Wake Lock (Android fully supported) |
| Q22 | Low-light check | Deferred to V2 |
| Q23–25 | Metrics | Cut; keep on-screen FPS + latency readout for tuning |
| Q26–28 | Terminology | Detection / Track / Cue / Alert / static object / mover; "blocked path" defined in §5 |
| Q29 | Mounting | Waist/chest strap or shirt pocket (camera forward) in use; hand-held at demo; pants pocket unsupported |
