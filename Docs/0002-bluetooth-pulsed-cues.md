# ADR-0002: Bluetooth audio with pulsed cues; HRTF and continuous sweeps cut

## Status
Accepted, Oct 10, 2026.

## Context
The PRD's 250 ms capture-to-sound budget is measured with wired earbuds, but the demo has no wired headphones available — Bluetooth is mandatory. Bluetooth A2DP adds 100–200 ms of codec latency. Separately, the MVP's headline spatial-audio feature (HRTF via `PannerNode`) was unverified on target devices and added synthesis complexity with no time to validate.

## Decision
1. **Accept Bluetooth latency** as a known limitation. All cues are **short pulses**; continuous frequency/pan sweeps are banned from the sound palette, because a sweep smears across codec delay while a pulse merely arrives late.
2. **Cut HRTF / spatial audio from the MVP.** Stereo pan (left = −1, center = 0, right = +1) is the only rendering mode.
3. The 250 ms budget remains defined on wired measurement; Bluetooth performance is validated qualitatively in the demo by using a slow-walking teammate (~1 m/s → 10–20 cm positional error, imperceptible in the demo).

## Consequences
- Demo choreography must use a slow-walking teammate; no running or fast passes.
- The US-3.5 headphone check now doubles as a Bluetooth-stereo validation (some headsets collapse to mono).
- HRTF can return in V2 behind the settings toggle already specced for Sam (mode switch), without pipeline changes.
- If a future venue provides wired earbuds, nothing in the audio engine changes — pulses render identically on both paths.
