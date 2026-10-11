# 01: App shell with live camera and pause

**What to build:** A user opens EchoPath from a link in Chrome on Android with no install, taps one large Start button, and sees the live rear-camera feed running as an installable PWA; a full-screen double-tap pauses and resumes everything with a distinct confirming earcon in each direction.

**Blocked by:** None (can start immediately).

**Status:** ready-for-agent

- [ ] Opens in current Chrome on Android with no install; installable as PWA; repeat visit loads from cache in under 3 seconds with app-plus-model payload measured and recorded
- [ ] One large Start button; rear camera by default; every control has an accessible label TalkBack reads; denied camera permission produces a spoken message explaining how to retry
- [ ] Full-screen double-tap target toggles pause; a distinct earcon confirms paused and a distinct earcon confirms resumed
- [ ] Verifiable end to end: cold open link, two taps to live camera, double-tap to pause and resume by ear alone
