# 03: On-device detector behind swappable interface with debug overlay

**What to build:** Live video runs through an on-device detector in a worker behind a single swappable detection contract, sustaining interactive frame rates on a mid-range Android phone, with a sighted-only debug overlay showing boxes, Zones, distance bands, FPS, and latency for tuning.

**Blocked by:** 01 (App shell with live camera and pause).

**Status:** ready-for-agent

- [ ] Single swappable `detect(frame)` contract returning boxes, classes, and scores; day-one baseline is the on-device EfficientDet-Lite0 behind the same flag a future model swap would use
- [ ] Person detected as the primary class plus whatever common mover and static-object classes the model outputs reliably; sustained 15 FPS on a mid-range Android phone
- [ ] Pipeline captures on the main thread, transfers to the worker for inference, and drops frames older than 200 ms under backpressure
- [ ] Debug overlay off by default shows Detection boxes, Zones, distance bands, FPS, and latency readout; never the sole carrier of information
- [ ] Verifiable end to end: point at a person, see a live box with FPS and latency readouts holding at target rates
