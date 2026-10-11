# 08: Offline operation, adaptive degradation, and demo readiness

**What to build:** EchoPath runs fully local in airplane mode after first load, feels instant on wired measurement, degrades gracefully instead of stalling when the phone gets hot or slow, and the full pitch demo passes on Bluetooth with a backup recording in hand.

**Blocked by:** 06 (Blocked-path guide tone with freer-side hysteresis and emergency buzz); 07 (Settings persistence and stereo headphone check).

**Status:** ready-for-agent

- [ ] After first load works in airplane mode with zero network requests during inference; model precached by the service worker
- [ ] Capture-to-sound p95 at or under 250 ms measured with wired earbuds; median inference under 50 ms target on a recent phone; Bluetooth delay accepted as a known limitation with pulsed Cues and a slow-walking demo partner
- [ ] Adaptive ladder when FPS sits below 12 for 3 seconds: input width steps down 1280 to 960 to 640, then model lite to nano; one spoken earcon on first step-down; steps back up only after 10 seconds stable above 15 FPS
- [ ] Demo readiness: Start with TalkBack, Bluetooth stereo check, teammate crosses slowly with the Cue panning ear to ear, stops in the path for the guide tone, steps closer to quicken the pulse and trigger the buzz inside 2 m, airplane mode still runs, backup video recorded in advance
- [ ] Verifiable end to end: full demo script passes in a controlled well-lit space with network toggled off
