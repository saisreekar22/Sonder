# 07: Settings persistence and stereo headphone check

**What to build:** A first-time user passes a left-then-right headphone check (which also catches Bluetooth mono collapse) and a tuner can adjust sensitivity, Corridor width, Cue style, and master volume live, with everything persisted locally across visits.

**Blocked by:** 05 (Stereo pan cue engine with category palette and urgency).

**Status:** ready-for-agent

- [ ] Setup plays a tone in the left ear then the right and asks for confirmation; warns when both sides do not sound equal (mono audio, some Bluetooth headsets)
- [ ] Settings cover sensitivity, Corridor width, Cue-sound style, and master volume; persist locally, reachable by TalkBack, applied live without restart
- [ ] Onboarding recommends open-ear or transparency-mode headphones so traffic and speech stay audible
- [ ] Verifiable end to end: fresh run passes the ear check, a settings change takes effect mid-session, relaunch keeps the settings
