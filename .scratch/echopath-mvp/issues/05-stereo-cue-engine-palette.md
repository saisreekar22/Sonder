# 05: Stereo pan cue engine with category palette and urgency

**What to build:** Every near-enough Track is heard as a short pulsed Cue in the correct ear with a per-category sound and a pulse rate that quickens with closeness, mixed through a hearing-safe limiter so competing sources stay intelligible and ambient sound remains audible.

**Blocked by:** 04 (Zones, tracker identity, and distance bands).

**Status:** ready-for-agent

- [ ] Zone-to-pan mapping left −1, center 0, right +1, verified with the headphone check; all Cues are short pulses, never continuous sweeps
- [ ] Category palette: person blip, vehicle hum, static-object tock, each mutually distinguishable in a small listening test
- [ ] Pulse rate scales with distance band: far ≈ 1 Hz, near ≈ 3 Hz, very near ≈ 6 Hz
- [ ] Mixing through a single compressor with master gain capped at a fixed safe maximum; priority emergency buzz, then guide tone, then vehicles, people, statics; max three simultaneous sources
- [ ] Verifiable end to end: with eyes closed, a left / center / right passer is locatable by ear and closeness is obvious from pulse rate
