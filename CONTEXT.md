# EchoPath — CONTEXT.md

Glossary of the EchoPath domain model. This file contains terminology only — no implementation details, no specs. Terms are enforced in PRDs, ADRs, code comments, and UI copy.

## Core pipeline terms

- **Detection** — one frame's raw model output: a bounding box, a class, a confidence score. Detections have no identity and no lifetime.
- **Track** — a cross-frame identity assigned by the tracker to a sequence of Detections believed to be the same physical object. Tracks carry zone, distance band, and cue history.
- **Cue** — any audio event emitted for a Track (a blip, a hum, a tock, a guide tone). Cues are pulsed, never continuous sweeps.
- **Alert** — a high-priority Cue: the emergency both-ears buzz (< 2 m center obstruction) and the fail-loud system earcons. Alerts interrupt or override ordinary Cues.
- **Warning** — specifically *spoken* output (speechSynthesis). V2-only; nothing spoken in the MVP except the first-run disclaimer and fail-loud messages.

## Object categories

- **Mover** — a Track whose class is capable of self-locomotion: person, bicycle, car, motorcycle, bus, truck. Movers are the MVP's primary concern because they approach the user.
- **Static object** — a Track whose class is fixed: chair, bench, potted plant, stop sign, and similar. Static objects Cue when near but never trigger guidance on their own.
- The word **"obstacle"** is banned as a category label. It survives only in the safety disclaimer, meaning "anything the user could collide with."

## Spatial terms

- **Zone** — one of three frame-width thirds (left / center / right), assigned by a Detection's box center-x. Zones map to pan: left = −1, center = 0, right = +1.
- **Corridor** — the center zone: the region directly ahead that the user is presumed to walk through.
- **Size gate** — the minimum box height (8% of frame height) below which Detections are ignored as too far to matter.
- **Distance band** — a coarse range label for a Track: *very near* (< 2 m), *near* (2–6 m), *far* (> 6 m). Bands are estimates from `d ≈ f·H/h`; they are never reported to the user as meters.

## Guidance terms

- **Blocked path** — the state in which any near-band or closer Track sits in the corridor. Fires the guidance logic (PRD §5).
- **Guide tone** — the rising Cue hard-panned to the freer ear while the path is blocked. Replaces (not accompanies) the center buzz except in the emergency case.
- **Freer side** — the left or right zone with the lower weighted obstruction score (very near = 3, near = 2). Switches only on a ≥ 2-point margin after ≥ 1.5 s hysteresis.
- **Emergency** — a center-zone Track in the very-near band; adds the both-ears buzz on top of the guide tone.

## System terms

- **Fail-loud** — the guarantee that any camera, model, or audio failure produces a spoken Alert within 1 second. Tripwires: stream ended, page hidden, FPS watchdog.
- **Earcon** — a short synthesized sound carrying system meaning (start, pause, step-down, camera lost). Earcons are Alerts.
- **Debug overlay** — the sighted-only visualization of boxes, zones, bands, FPS, and latency. Off by default; never the sole carrier of information.

## Banned / replaced terms

| Banned | Replacement | Why |
|---|---|---|
| "obstacle" (as a category) | mover / static object | overloaded: sometimes meant any detection, sometimes statics only |
| "alert" (for ordinary cues) | cue | alert is reserved for high-priority events |
| "warning" (for beeps) | cue / alert | warning is reserved for speech (V2) |
| "spatial audio" / "HRTF" | stereo pan | HRTF cut from MVP (ADR-0002) |
| "path clear" (as a claim) | "nothing detected" | silence must never imply safety |
