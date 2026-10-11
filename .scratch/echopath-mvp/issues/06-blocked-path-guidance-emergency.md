# 06: Blocked-path guide tone with freer-side hysteresis and emergency buzz

**What to build:** When a near-band or closer Track sits in the Corridor, the ordinary center Cue is replaced by a rising guide tone hard-panned to the freer ear telling the user which way to step, with an added both-ears emergency buzz only when the center Track is very near.

**Blocked by:** 05 (Stereo pan cue engine with category palette and urgency).

**Status:** ready-for-agent

- [ ] Firing condition: blocked path while any near or very-near Track is in the Corridor; guide tone hard-panned to the freer side, scored very near 3 and near 2; far Tracks Cue normally and never block
- [ ] Hysteresis: switches ears only on a 2-point or greater margin after 1.5 seconds or more; ties keep the current side so the tone never flip-flops
- [ ] Guide tone replaces (not accompanies) the center Cue except in the emergency case; pulse rate 3 Hz for near, 6 Hz for very near; stops when the path is free for 750 ms with no near-band Track in the Corridor
- [ ] Emergency: a center-zone very-near Track adds the both-ears buzz on top of the guide tone
- [ ] Verifiable end to end: a teammate standing in the path steers the tone to the freer ear, stepping inside 2 m adds the buzz, stepping away silences the tone
