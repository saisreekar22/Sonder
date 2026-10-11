# ADR-0001: Android + Chrome only for the hackathon MVP

## Status
Accepted, Oct 10, 2026.

## Context
The original PRD targeted both Chrome/Android and Safari/iOS. Cross-platform support carried three severe, hackathon-killing risks: (1) iOS Safari's historically inconsistent WebGPU and camera behavior, (2) audio autoplay restrictions requiring platform-specific workarounds, and (3) Screen Wake Lock support gaps that would break the hands-free US-1.3 requirement on iOS with no fallback.

## Decision
MVP targets **Android + Chrome only**. iOS Safari is explicitly out of scope and listed as a non-goal. No platform-abstraction layer is built.

## Consequences
- Wake Lock, camera backgrounding behavior, and audio autoplay are fully supported — US-1.3 becomes straightforward.
- The judging demo runs on one known device; the "2 test phones" metric becomes "demo phone + one older Android."
- If iOS is ever added, the codebase will need a compatibility audit (camera, wake lock, audio unlock) — recorded here so future contributors know it was a deliberate cut, not an oversight.
