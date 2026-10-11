# 02: Spoken disclaimer, Wake Lock, and fail-loud Alerts

**What to build:** A first-time user hears the spoken supplementary-aid disclaimer and confirms once per device, the app holds the screen awake hands-free while strapped on, and any camera, model, or audio failure interrupts with a spoken Alert within 1 second plus one automatic restart attempt.

**Blocked by:** 01 (App shell with live camera and pause).

**Status:** ready-for-agent

- [ ] First-run disclaimer spoken aloud, confirmed once per device with a stored flag via one full-screen confirm target; shortened 2-second version on revisit; states supplementary aid only, can miss glass/stairs/drop-offs/low light and head-height hazards, and silence means "nothing detected," never safe
- [ ] Screen Wake Lock requested on start; audible Alert if the camera stream drops or the page is backgrounded
- [ ] All three fail-loud tripwires each fire a spoken Alert within 1 second plus one automatic restart attempt: stream ended/video error, page hidden, FPS watchdog with no new frame in 1 second
- [ ] Verifiable end to end: fresh device hears disclaimer, revisit hears short version, killing the stream or backgrounding the page speaks an Alert promptly
