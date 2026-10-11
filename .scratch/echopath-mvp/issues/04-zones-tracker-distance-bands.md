# 04: Zones, tracker identity, and distance bands

**What to build:** Raw per-frame Detections become stable cross-frame Tracks with a Zone, a Corridor decision, and a coarse distance band, so the user only hears about things in the walking path and a repeated Cue for the same Track is rate-limited.

**Blocked by:** 03 (On-device detector behind swappable interface with debug overlay).

**Status:** ready-for-agent

- [ ] Frame split into left/center/right Zone thirds by box center-x; Corridor is the center third; boxes below the 8% frame-height size gate are ignored; Corridor width and min-size are live on-screen sliders
- [ ] Custom IoU plus constant-velocity tracker assigns stable Track IDs across frames; a Track Cues on first Zone entry, then only on Zone change or box-height growth over 30%; maximum three simultaneous Cue sources
- [ ] Coarse distance bands only (very near under 2 m, near 2–6 m, far over 6 m), estimated from apparent height with a per-class table and device focal-length lookup; never reported as meters
- [ ] Verifiable end to end: a person walking left to right keeps one identity, re-cues on Zone change, and vanishes below the size gate at distance
