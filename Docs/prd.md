# KINETICSPATIAL
## Product Requirements Document (PRD)

**Version:** 1.0  
**Date:** October 10, 2026  
**Team:** PonderSonder  
**Product type:** Accessible sports-training and spatial-navigation platform  
**Primary platform:** Progressive Web Application (PWA)  
**Primary audience:** Blind and low-vision runners  
**Development stage:** Hackathon MVP → Supervised research prototype → Validated product  
**Status:** Proposed requirements, not yet implemented

---

# 1. PRODUCT OVERVIEW

## 1.1 Product Summary

KineticSpatial is an AI-powered spatial running companion designed to help blind and visually impaired athletes understand their surroundings, prepare for unfamiliar routes, receive meaningful directional feedback, and independently review their performance.

The system combines computer vision, spatial tracking, predictive movement analysis, binaural audio, optional haptic feedback, and interactive racecourse simulations.

Unlike navigation tools that primarily focus on guiding someone through their immediate surroundings, KineticSpatial connects the entire athletic experience.

**Before the run:** Athletes learn the course through CourseDNA and practice navigating it using RaceTwin.

**During the run:** KineticGuide aims to detect paths, estimate spatial movement, identify potential obstacles, and provide contextual feedback during appropriately supervised training.

**After the run:** Race Memory allows athletes to replay their movements through sound, understand deviations, and prepare for future attempts.

All three modes share the same spatial representation, training history, and athlete preferences.

## 1.2 Product Vision

Create an accessible running platform that transforms routes and physical movement into information athletes can independently understand and learn from.

Our long-term goal is to make spatial information more accessible in endurance sports without requiring expensive proprietary equipment.

The system should eventually support ordinary running routes, organized marathons, and race preparation for multisport events.

## 1.3 Problem Statement

Blind and visually impaired runners may depend on sighted guides, familiar paths, verbal directions, or specialized assistance during training and competition.

Existing computer-vision research has demonstrated that smartphones can help detect running paths and provide directional feedback.

However, there is an additional challenge: athletes may still lack an accessible way to study an unfamiliar racecourse, rehearse complex sections, understand their past route decisions, and connect that knowledge to their subsequent training.

Traditional visual maps, GPS traces, and performance charts are not independently accessible to everyone.

KineticSpatial aims to bring these experiences together through sound, simulation, and athlete-controlled feedback.

## 1.4 The Product's Main Differentiator

Our proposed innovation is **Spatial Memory Transfer**, supported by CourseDNA, RaceTwin, RealityMatch, and Race Memory.

The athlete learns a route before running, encounters a consistent representation of that route during supported training, and revisits the same route afterward.

This connection is the central product contribution.

Camera-based path tracking, spatial audio, and obstacle detection are important foundation technologies, but they are not new inventions by themselves.

## 1.5 Product Goals

- Make real racecourses accessible through interactive sound.
- Allow athletes to practice route decisions before arriving at the venue.
- Develop a modular spatial guidance architecture capable of incorporating camera and sensor information.
- Explore obstacle-awareness and path-tracking technology through controlled research demonstrations.
- Connect previously learned route information with later movement data.
- Allow athletes to independently replay and compare training sessions.
- Design the application to be usable through screen readers and audio-first controls.
- Evaluate whether interactive route rehearsal improves course understanding.
- Support athlete independence without removing established safety assistance.

## 1.6 Non-Goals for the MVP

The first release will not:

- Replace a sighted running guide.
- Guarantee collision avoidance.
- Certify any outdoor path as safe.
- Provide unrestricted autonomous running at sprint speed.
- Guarantee recognition of every pedestrian or vehicle.
- Replace a commercial navigation application.
- Deliver reliable underwater navigation or swimming-turn control.
- Offer live wheelchair collision avoidance.
- Depend on VR headsets or custom tactile hardware.
- Claim safety-critical latency or reliability without validation.

---

# 2. COMPETITIVE CONTEXT

## 2.1 Google's Project Guideline

Google's original open-source Project Guideline demonstrates:

- Camera-based marked-line segmentation.
- Path geometry reconstruction.
- Visual-inertial motion tracking.
- Look-ahead path guidance.
- Monocular depth-based obstacle mapping.
- Directional and spatial audio.
- Tracking-loss warnings.
- Native Android integration.
- Simulation tools.

The source repository and published architecture can be studied and, where licensing permits, incorporated into later development.

## 2.2 Google's Running Guide Agent, May 2026

Google's newer experimental system extends into:

- Unmarked-path interpretation.
- On-device environmental understanding.
- Offline path perception.
- Urgent navigation feedback.
- Scene reasoning using Gemma.
- Route and workout planning.
- AI coaching.
- Break management.
- Experimental intelligent-eyewear integration.

KineticSpatial must not represent these capabilities as gaps that Google has never addressed.

## 2.3 Our Proposed Differentiation

| Existing capability | Our proposed development |
|---|---|
| Understand the immediate path | Understand and rehearse an entire racecourse |
| Directional running instructions | Interactive course-learning experiences |
| Obstacle and navigation alerts | Connect environmental observations with a previously learned route |
| AI running coach | Athlete-controlled course rehearsal and spatial feedback |
| Running session assistance | Before, during, and after training continuity |
| Visual route maps | Audio-native course exploration |
| GPS history | Independently navigable spatial performance replay |
| General simulation environment | Simulations of actual event routes and unexpected decisions |

This distinction is an opportunity to develop and validate, not proof of worldwide novelty.

---

# 3. TARGET USERS AND PERSONAS

## 3.1 Primary Users

**Blind runners**

Athletes who cannot depend on visual maps or environmental landmarks.

**Low-vision runners**

Athletes who may benefit from audio guidance, accessible route preparation, and adjustable information density.

**Beginning adaptive runners**

Individuals learning spatial cues, unfamiliar running routes, and structured running skills.

**Competitive athletes**

Runners preparing for marathons, races, or unfamiliar endurance-event courses.

## 3.2 Secondary Users

**Sighted running guides**

Help annotate routes, review training, and maintain established assistance.

**Adaptive-sports coaches**

Use recorded sessions to support training discussions.

**Accessibility researchers**

Evaluate spatial-audio feedback, route recognition, and accessible training experiences.

**Event organizers**

Potentially provide structured, accessible racecourse information.

## 3.3 Core User Needs

Athletes should be able to:

- Understand a course without looking at a map.
- Learn the sequence of important turns.
- Recognize route features through sound.
- Practice route decisions.
- Understand when route information is uncertain.
- Receive appropriate contextual guidance in tested environments.
- Review sessions without needing to interpret a graph.
- Control their own training data.
- Work with a guide without making the guide the only source of spatial information.

---

# 4. PRIMARY USER JOURNEYS

## Journey A: Preparing for a Race

1. The athlete opens KineticSpatial.
2. They choose an existing route or upload a GPX file.
3. The app identifies major course features.
4. CourseDNA provides an accessible audio overview.
5. The athlete explores individual route sections.
6. RaceTwin starts an interactive simulation.
7. The athlete practices choosing directions.
8. What-If Training introduces unexpected situations.
9. The athlete reviews their results.
10. The course is saved for future training.

**Desired outcome:** The athlete can independently explore and practice the route's known structure.

## Journey B: Supported Running Guidance

1. The athlete selects a route or supported training mode.
2. The application checks device capabilities.
3. The athlete confirms the supervision arrangement.
4. Camera and sensor processing begins.
5. The system estimates visible path geometry and movement.
6. Relevant directional cues are generated.
7. Candidate obstacles and uncertainty states take priority.
8. The athlete can pause or stop the session.
9. Events are recorded when recording is enabled.

**Desired outcome:** The system demonstrates contextual guidance and uncertainty handling in appropriately controlled conditions.

## Journey C: Understanding a Completed Run

1. The athlete selects a completed session.
2. Race Memory loads the planned and recorded routes.
3. They hear an audio summary.
4. They navigate between important events.
5. They replay an unexpected deviation.
6. They compare it with the intended route.
7. They optionally hear a simulated alternative decision.
8. They save the section for another practice attempt.

**Desired outcome:** The athlete can understand meaningful differences without seeing a visual GPS trace.

## Journey D: Working With a Guide

1. A guide opens a shared course.
2. They add important route annotations.
3. The athlete reviews the annotations through accessible controls.
4. The athlete accepts, edits, or removes notes.
5. Relevant information becomes available during route rehearsal.
6. The athlete chooses whether to share selected training results.

**Desired outcome:** Course knowledge becomes accessible without reducing athlete control.

---

# 5. PRODUCT SCOPE AND RELEASE LEVELS

Every feature will have one development classification.

**P0 — Hackathon MVP:** Required for the core end-to-end experience.

**P1 — Hackathon Stretch:** Valuable if time and technical stability permit.

**P2 — Post-Hackathon Pilot:** Needs additional development, user testing, or hardware integration.

**R — Research:** Safety-critical or technically uncertain capability requiring a separate validation program.

A working P0 product is more important than an incomplete implementation of all features.

---

# 6. COMPLETE FUNCTIONAL REQUIREMENTS

## 6.1 Accessibility and Setup

### FR-01: Accessible Athlete Onboarding
**Priority: P0**

**Requirement:** Users must be able to operate the main application without viewing the screen.

**Implementation:**
- Semantic React components.
- Keyboard navigation.
- Screen-reader labels.
- Accessible forms.
- Optional spoken instructions.
- Saved preferences.

**Acceptance criteria:** A keyboard and screen-reader user can select a course, begin a simulation, pause, and access replay without visual assistance.

### FR-02: Device and Session Readiness
**Priority: P0**

**Requirement:** The application must identify available device features and avoid presenting unavailable capabilities as operational.

**Implementation:**
- Browser capability detection.
- Camera permission checks.
- Audio initialization.
- Optional geolocation and motion permissions.
- Vibration feature detection.
- Visible and spoken error states.

**Acceptance criteria:** Missing permissions or unsupported features produce understandable messages and appropriate fallbacks.

---

## 6.2 Computer Vision and Environmental Sensing

### FR-03: Camera-Based Path Detection
**Priority: P1**

**Requirement:** The system should identify a marked running path from controlled prerecorded camera footage.

**Implementation:**
- Video frame extraction.
- Color segmentation or trained segmentation model.
- Path-mask generation.
- Centerline estimation.
- Confidence reporting.

**Acceptance criteria:** The prototype displays the detected path, produces route-direction estimates, and reports tracking failures on a labeled test video.

### FR-04: Unmarked-Path Recognition
**Priority: R**

**Requirement:** Future versions should investigate semantic recognition of ordinary running paths without painted guidelines.

**Implementation:**
- Semantic segmentation.
- Path-versus-road classification.
- Outdoor-scene understanding.
- Scene-confidence evaluation.

**Acceptance criteria:** A future research benchmark demonstrates defined performance across multiple environment types before any supervised field pilot.

### FR-05: Obstacle Detection
**Priority: P1 for recorded footage; R for live reliance**

**Requirement:** The system should identify candidate obstacles and determine whether they may intersect the estimated training corridor.

**Implementation:**
- Object detection.
- Candidate segmentation.
- Relative position estimation.
- Path-intersection analysis.
- Alert generation.

**Acceptance criteria:** The recorded-video demonstration includes annotated positive and negative cases, with measured false alarms and misses.

### FR-06: Moving Obstacle Tracking
**Priority: R**

**Requirement:** Future versions should track nearby moving objects across frames.

**Implementation:**
- Object association.
- Optical flow.
- Camera-motion compensation.
- Relative trajectory estimation.
- Uncertainty modeling.

**Acceptance criteria:** Object identity and motion estimates are evaluated against recorded reference trajectories.

### FR-07: Spatial Position Tracking
**Priority: P1 in simulation; R for live accuracy**

**Requirement:** The system must represent estimated heading, movement, progress, and lateral deviation relative to the intended path.

**Implementation:**
- Virtual coordinates for MVP.
- Camera geometry.
- Motion sensors.
- GPS when available.
- Later visual-inertial fusion.

**Acceptance criteria:** Simulated route-relative measurements match known ground truth; live claims require separate accuracy testing.

### FR-08: 3D Environmental Mapping
**Priority: R**

**Requirement:** Future versions should maintain a local spatial representation of visible paths and candidate hazards.

**Implementation:**
- Camera calibration.
- Depth estimation.
- Ground-plane projection.
- Local path-map construction.
- Confidence decay and stale-data removal.

**Acceptance criteria:** An offline benchmark demonstrates spatial-estimation accuracy and proper behavior when observations become unreliable.

### FR-09: Path Centerline and Boundary Estimation
**Priority: P1**

**Requirement:** Given a detected path region, the system should estimate its centerline, curvature, and visible corridor geometry.

**Implementation:**
- Path-mask processing.
- Centerline extraction.
- Curve fitting.
- Boundary estimation.

**Acceptance criteria:** Centerline estimates can be compared with annotated reference paths and include uncertainty indicators.

---

## 6.3 Spatial Audio and Haptic Feedback

### FR-10: Binaural Spatial Audio Engine
**Priority: P0**

**Requirement:** The system must generate distinct, interpretable directional audio cues.

**Implementation:**
- Web Audio API.
- PannerNode.
- Audio source scheduling.
- Adjustable intensity.
- Headphone-based playback.

**Acceptance criteria:** Left, right, and centered cues can be played, tested, and mapped consistently to route events.

### FR-11: Optional Haptic Feedback
**Priority: P0 where supported**

**Requirement:** Supported devices should provide vibration patterns for selected events.

**Implementation:**
- Navigator Vibration API.
- Pattern definitions.
- Support detection.
- Audio fallback.

**Acceptance criteria:** Vibration events are generated on supported test devices; unsupported devices continue functioning without vibration.

### FR-12: Soundprint Calibration
**Priority: P0**

**Requirement:** Users should be able to test directional cue recognition and save their preferred audio settings.

**Implementation:**
- Short listening exercises.
- Response recording.
- Accuracy calculations.
- Preference storage.

**Acceptance criteria:** A completed calibration updates the sound settings used by a later simulation.

---

## 6.4 Movement Prediction and Feedback Management

### FR-13: Predictive Drift Estimation
**Priority: P1**

**Requirement:** In simulation, the engine must estimate possible route deviation over a short future interval.

**Implementation:**
- Current position.
- Estimated velocity.
- Heading.
- Known corridor geometry.
- Kinematic prediction.

**Acceptance criteria:** Predicted deviations are reproducible and measurable against the simulation's actual future positions.

### FR-14: Time-to-Edge Estimation
**Priority: P1**

**Requirement:** The simulation should estimate when a moving virtual athlete may cross a corridor boundary.

**Implementation:** Distance-to-boundary divided by estimated lateral speed where mathematically valid, with explicit handling of uncertain or stationary cases.

**Acceptance criteria:** The estimate is not displayed when required inputs are invalid or unreliable.

### FR-15: Cadence and Stride Awareness
**Priority: P1**

**Requirement:** The system should support optional rhythm-based coaching experiments.

**Implementation:**
- Sensor data or simulated step events.
- Peak detection.
- Cadence calculation.
- Optional cue timing.

**Acceptance criteria:** Estimated cadence can be compared with known reference data in a controlled test.

### FR-16: Cue Priority and Safety State Manager
**Priority: P0**

**Requirement:** Important alerts must take priority over nonessential audio.

**Implementation:**
- Central event queue.
- Event urgency.
- Confidence thresholds.
- Cue interruption.
- Cooldown periods.
- Explicit STOP and UNCERTAIN states.

**Acceptance criteria:** Simultaneous events produce the correct priority order, and nonessential coaching cannot override an urgent state.

---

## 6.5 CourseDNA and Race Preparation

### FR-17: GPX Course Import and Route Compiler
**Priority: P0**

**Requirement:** Users must be able to upload a valid GPX route and convert it into a structured course.

**Implementation:**
- GPX parsing.
- Coordinate validation.
- Distance calculation.
- Bearing calculation.
- Turn extraction.
- Segment assignment.

**Acceptance criteria:** A sample route produces a valid course with reproducible distance, segments, and major turns.

### FR-18: CourseDNA Audio Route Exploration
**Priority: P0**

**Requirement:** Users must be able to explore known route features without looking at a map.

**Implementation:**
- Audio motifs for route events.
- Segment-based playback.
- Turn spatialization.
- Checkpoint sounds.
- Repeat and skip controls.

**Acceptance criteria:** A user can access each major route segment through audio-first controls.

### FR-19: RaceTwin Interactive Simulator
**Priority: P0**

**Requirement:** Users must be able to practice a course in a virtual environment using accessible directional controls.

**Implementation:**
- Virtual athlete.
- Position and velocity updates.
- Path matching.
- Route deviation measurement.
- Decision tracking.

**Acceptance criteria:** The athlete can start, complete, and save a simulated route while receiving audio feedback.

### FR-20: Spatial Memory Transfer
**Priority: P0 in simulation; P2 for live integration**

**Requirement:** The same route segment identifiers and meanings must persist through rehearsal, simulation, and replay.

**Implementation:**
- Stable segment IDs.
- Shared course metadata.
- Reusable audio motifs.
- Session-to-segment linking.

**Acceptance criteria:** Selecting one course segment reveals corresponding events across CourseDNA, RaceTwin, and Race Memory.

### FR-21: What-If Training
**Priority: P0**

**Requirement:** Users must be able to practice alternative course situations.

**Required scenarios:**
- Missed turn.
- Changed route.
- Simulated GPS loss.

**Implementation:**
- Deterministic scenario configuration.
- Injected route events.
- Decision recording.
- Scenario replay.

**Acceptance criteria:** All three scenarios run consistently and record the user's decisions and outcomes.

### FR-22: GuideBridge Route Annotations
**Priority: P1**

**Requirement:** A coach or guide should be able to annotate a course and make those notes accessible to the athlete.

**Implementation:**
- Segment-linked notes.
- Annotation categories.
- Audio-readable descriptions.
- Sharing controls.

**Acceptance criteria:** An annotation appears at its intended course segment and can be reviewed with a screen reader.

### FR-23: Race Strategy and Multisport Course Preparation
**Priority: P2**

**Requirement:** Future versions should represent organized race features and multisport transitions.

**Implementation:**
- Checkpoints.
- Elevation sections.
- Hydration locations.
- Event annotations.
- Swim/bike/run stage metadata.

**Acceptance criteria:** A supported example event can be explored as an ordered, accessible course itinerary.

### FR-24: Progressive Training and Cue Fading
**Priority: P1**

**Requirement:** Athletes should be able to reduce optional coaching hints during practice.

**Implementation:**
- Training difficulty options.
- Cue-density settings.
- User-controlled assistance.

**Acceptance criteria:** Changing the assistance level affects nonessential hints while preserving required simulation stop and uncertainty cues.

---

## 6.6 Live Route Integration and Post-Run Analysis

### FR-25: RealityMatch Route Agreement
**Priority: P1 for recorded data; R for live navigation**

**Requirement:** The system should compare recorded location and path observations with a planned route.

**Implementation:**
- GPS trace ingestion.
- Candidate segment matching.
- Heading checks.
- Observation confidence.
- Conflict detection.

**Acceptance criteria:** Known location disagreements generate uncertainty events instead of fabricated directions.

### FR-26: FutureStep Predictive Guidance
**Priority: P1**

**Requirement:** The engine should combine future route geometry with movement prediction to generate anticipatory cues in simulation.

**Implementation:**
- Look-ahead route geometry.
- Virtual heading.
- Estimated future position.
- Cue scheduling.

**Acceptance criteria:** A controlled simulation can compare FutureStep against an ordinary reactive-guidance baseline.

### FR-27: Adaptive Running Coach
**Priority: P2**

**Requirement:** The system should support optional running progress and coaching information.

**Implementation:**
- Pace and cadence data.
- Training goals.
- Milestone events.
- Rest reminders.
- Lower-priority spoken output.

**Acceptance criteria:** Coaching cues can be enabled, disabled, and interrupted by higher-priority guidance states.

### FR-28: Race Memory Spatial Replay
**Priority: P0**

**Requirement:** Users must be able to review a completed simulation through a navigable audio timeline.

**Implementation:**
- Session-event recording.
- Route reconstruction.
- Planned-versus-actual comparison.
- Segment navigation.
- Adjustable playback speed.

**Acceptance criteria:** A saved simulation can be replayed accurately and its deviations accessed without visual navigation.

### FR-29: Counterfactual Comparison, Progress and Coach Review
**Priority: P0 for comparisons; P2 for collaborative sharing**

**Requirement:** The application should compare a simulated decision with a defined alternative and summarize performance.

**Implementation:**
- Alternative scenario playback.
- Correct decision counts.
- Missed-turn metrics.
- Route deviation calculations.
- Accessible results.
- Future consent-based coach sharing.

**Acceptance criteria:** The same recorded simulation produces consistent metrics and reproducible alternative outcomes.

---

# 7. DETAILED MVP REQUIREMENTS

## 7.1 The Main Deliverable

The MVP must demonstrate a complete and understandable sequence:

**Upload a real route → Hear its structure → Practice following it → Encounter an unexpected situation → Replay and understand the result.**

The entire flow must remain usable without viewing a visual route map.

## 7.2 Route Import Requirements

The system must:

- Accept valid GPX files.
- Detect invalid files.
- Preserve route-point order.
- Reject unusable coordinate data.
- Calculate route distance.
- Identify significant direction changes.
- Group nearby changes into meaningful segments.
- Create stable segment identifiers.
- Store the processed course locally.

A route file must not be assumed to contain information about temporary construction, pedestrian traffic, surface condition, or every hazard.

## 7.3 CourseDNA Requirements

After route processing, users must be able to:

- Hear the course overview.
- Start full-course audio playback.
- Navigate to the next segment.
- Return to the previous segment.
- Repeat a section.
- Hear the direction of a turn.
- Access known checkpoints.
- Change playback speed.
- Pause playback.

The sound mapping must be consistent across sessions.

## 7.4 RaceTwin Requirements

The simulator must:

- Load a processed course.
- Represent a virtual athlete on the route.
- Accept accessible steering inputs.
- Advance virtual movement.
- Calculate deviation from the intended course.
- Generate appropriate navigation events.
- Record decisions and timestamps.
- Support pause and restart.
- Save completed attempts.

The visual simulation is a secondary observer interface; sound and accessible controls are the primary user interface.

## 7.5 What-If Requirements

Each scenario must define:

- The starting course segment.
- What changes.
- What information the user receives.
- Which choices are available.
- How the simulation processes those choices.
- What events are recorded.
- How the outcome is explained.

The simulator must clearly distinguish between normal route information and deliberately altered training scenarios.

## 7.6 Race Memory Requirements

A saved session must support:

- Audio session summary.
- Segment selection.
- Important event navigation.
- Playback controls.
- Planned-versus-actual route comparison.
- Wrong-turn reconstruction.
- Alternative simulated decisions.
- Accessible performance metrics.

The athlete must be able to understand an important deviation without viewing a line graph.

---

# 8. SYSTEM ARCHITECTURE

## 8.1 Core Design Principle

All features will use one shared spatial-event architecture.

Input systems produce estimates or events.

A common spatial layer interprets them.

A centralized feedback manager decides what information should be presented.

Session recording captures the relevant data for replay.

## 8.2 High-Level Architecture

**Inputs**
- GPX routes.
- Athlete interactions.
- Camera frames.
- GPS observations.
- Motion sensor readings.
- Guide annotations.

↓

**Core Processing**
- Route compiler.
- Camera perception.
- Spatial tracking.
- Route matching.
- Prediction engine.
- Scenario simulator.
- Confidence evaluation.

↓

**Spatial Event Engine**
- Route directions.
- Turns.
- Checkpoints.
- Deviations.
- Candidate obstacles.
- Tracking failures.
- Coaching events.

↓

**Output Manager**
- Binaural spatial audio.
- Short speech.
- Optional vibration.
- Accessible interface updates.

↓

**Session Recorder**
- Positions.
- Decisions.
- Events.
- Route segment references.
- User responses.

↓

**Race Memory**
- Spatial replay.
- Comparison.
- Learning metrics.

## 8.3 Technology Stack

| Component | Recommended technology |
|---|---|
| Frontend | React, Next.js, TypeScript |
| Styling | Tailwind CSS |
| Spatial simulation | Canvas or SVG |
| GPX parsing | JavaScript GPX parser |
| Geospatial geometry | Turf.js |
| Audio rendering | Web Audio API |
| Audio spatialization | PannerNode |
| Speech | Accessible browser speech or recorded prompts |
| Haptics | Navigator Vibration API |
| Camera input | getUserMedia |
| Controlled image analysis | OpenCV.js |
| Trained perception models | ONNX Runtime Web or appropriate MediaPipe-compatible tools |
| Device motion | DeviceMotion API |
| GPS | Geolocation API |
| Local storage | IndexedDB |
| Offline resources | Service workers |
| Analysis | Python, NumPy, OpenCV |
| Future native implementation | Android, Kotlin/C++, ARCore |

Not every browser will support every capability.

The architecture must allow unsupported modules to be disabled without breaking the route-learning experience.

## 8.4 Recommended Code Modules

**Route Engine**
- GPX parsing.
- Distance calculations.
- Turn extraction.
- Route segmentation.
- Course validation.

**Spatial Engine**
- Route-relative coordinate systems.
- Geometry.
- Movement estimates.
- Spatial events.

**Simulation Engine**
- Virtual athlete.
- Controls.
- Scenario logic.
- Position updates.

**Perception Engine**
- Video processing.
- Path detection.
- Obstacle candidates.
- Tracking confidence.

**Prediction Engine**
- Drift estimation.
- Time-to-edge.
- Route look-ahead.

**Feedback Engine**
- Spatial audio.
- Sound motifs.
- Haptics.
- Priorities.

**Memory Engine**
- Session recording.
- Replay.
- Comparison.
- Progress metrics.

**Accessibility Engine**
- Voice-first navigation.
- Screen-reader controls.
- Preferences.
- Fallbacks.

---

# 9. DATA REQUIREMENTS

## 9.1 Course Object

Each course must store:

- Course ID.
- Name.
- Source.
- Coordinate sequence.
- Total distance.
- Optional elevation data.
- Route segments.
- Known checkpoints.
- Guide annotations.
- Creation date.
- Version.

## 9.2 Route Segment Object

Each segment must store:

- Segment ID.
- Course ID.
- Start and end positions.
- Start and end distance.
- Direction.
- Curvature.
- Audio motif.
- Optional description.
- Related landmarks.

## 9.3 Athlete Profile

Store only information needed for the product:

- Profile identifier.
- Audio preferences.
- Accessibility settings.
- Saved courses.
- Calibration results.
- Training history permissions.

## 9.4 Spatial Observation

For simulated or research data:

- Timestamp.
- Source type.
- Position or relative position.
- Heading.
- Confidence.
- Relevant course segment.
- Optional uncertainty estimate.

## 9.5 Hazard Candidate

For controlled research demonstrations:

- Timestamp.
- Detection category.
- Estimated image location.
- Approximate route relationship.
- Confidence.
- Last observed time.
- Alert status.

## 9.6 Feedback Event

Each feedback event contains:

- Event ID.
- Event type.
- Event priority.
- Relevant direction.
- Associated segment.
- Confidence.
- Source.
- Timestamp.
- Duration or expiration.
- Whether it was actually delivered.

## 9.7 Training Session

Each session contains:

- Session ID.
- Course ID.
- Training mode.
- Start and end times.
- Position records.
- Cue records.
- Decisions.
- Scenario changes.
- Checkpoint events.
- Outcome metrics.

## 9.8 Privacy Requirements

- Store locally by default for the first release.
- Require consent for camera recording.
- Do not upload footage automatically.
- Give users control over session deletion.
- Avoid collecting unnecessary personal information.
- Require explicit permission before sharing training history.
- Do not expose private routes through public links by default.

---

# 10. UX AND AUDIO DESIGN REQUIREMENTS

## 10.1 User Interface Principles

The application must be audio-first rather than visual-first.

Visual maps can support sighted observers, developers, and low-vision users, but the core tasks must not require vision.

## 10.2 Required Screens

1. Welcome and Athlete Profile.
2. Device Readiness.
3. Course Library.
4. CourseDNA Explorer.
5. Soundprint Studio.
6. RaceTwin Simulator.
7. What-If Training.
8. KineticGuide Research Preview.
9. Race Memory.
10. Progress and GuideBridge.

## 10.3 Audio Vocabulary

| Event | Initial audio design |
|---|---|
| Left route direction | Left-positioned sound |
| Right route direction | Right-positioned sound |
| Upcoming turn | Brief directional preview |
| Checkpoint | Short confirmation motif |
| Simulated wrong turn | Distinct deviation motif |
| Candidate hazard | Priority warning |
| Uncertain tracking | Explicit uncertainty cue |
| Stop state | Unmistakable stop instruction |
| Coaching milestone | Optional speech |
| Replay comparison | Consistent spatial reconstruction |

This is a proposed cue vocabulary, not a validated set of sounds.

It must be reviewed with blind and low-vision athletes.

## 10.4 Cue Priority Rules

Required priority:

1. Stop.
2. Urgent candidate hazard.
3. Tracking or route uncertainty.
4. Navigation.
5. Checkpoint.
6. Coaching.
7. Optional notifications.

Only the highest appropriate cue should dominate when events conflict.

## 10.5 Accessibility Standards

The product should target WCAG 2.2 AA where applicable, including:

- Keyboard access.
- Screen-reader labeling.
- Visible focus.
- Logical reading order.
- Clear instructions.
- Text alternatives.
- Sufficient contrast.
- Accessible error messages.
- Appropriately sized touch targets.
- Options to pause and repeat audio.
- No dependence on color alone.

The team should test with NVDA, VoiceOver, or another relevant screen reader.

---

# 11. NON-FUNCTIONAL REQUIREMENTS

## 11.1 Performance

**PWA:**
- Route processing should remain responsive on the target demo device.
- Audio rendering must not block the interface.
- Simulation updates should remain consistent.
- Session recording should not noticeably interrupt playback.
- Expensive geometry calculations should be cached or moved off the main thread when necessary.

**Proposed MVP engineering target:** The time from a generated simulator event to audio scheduling should be measured, with an initial target below 150 milliseconds on the chosen demo device. This is a development target, not a safety or human reaction-time guarantee.

**Computer vision:** Record actual inference latency on each tested device rather than promising 60 fps.

## 11.2 Reliability

- Invalid routes must fail gracefully.
- Missing GPS must not break CourseDNA.
- Missing vibration support must not break audio.
- A denied camera permission must not break RaceTwin.
- Browser refreshes must not corrupt saved courses.
- Replaying a saved deterministic simulation must reproduce its important events.

## 11.3 Offline Capability

At minimum, previously cached course rehearsal and virtual training should work without an internet connection.

Live maps, external event information, and cloud-based features may require connectivity.

## 11.4 Security

- Validate uploaded GPX content.
- Prevent scripts or unsafe content from executing through annotations.
- Restrict camera access to explicitly authorized sessions.
- Avoid unnecessary raw video retention.
- Protect shared training data.
- Provide session deletion.

## 11.5 Device Compatibility

Primary prototype target: Recent Chrome-based browsers on desktop and Android.

Secondary target: Safari and iOS for route exploration, simulation, audio, and replay.

Browser vibration may not be available on iOS; supported audio feedback must remain functional.

Native integration is a future possibility, not an MVP dependency.

---

# 12. SAFETY AND OPERATIONAL REQUIREMENTS

## 12.1 Safety Position

The first version is a training and research prototype.

The live perception components are not validated as a replacement for a guide, cane, trained mobility support, or other appropriate assistance.

Outdoor testing must retain suitable human supervision.

## 12.2 Required Operational States

**INITIALIZING:** Checking permissions and device capabilities.

**READY:** Supported training mode prepared.

**TRACKING:** Observations currently satisfy the tested mode's confidence criteria.

**UNCERTAIN:** Position or environmental interpretation is unreliable.

**HAZARD:** A candidate obstacle or urgent event has been identified.

**STOP:** Guidance is not reliable enough to continue the test safely.

**PAUSED:** The user has stopped or suspended the activity.

## 12.3 Failure Cases to Handle

- No camera permission.
- Camera disconnected.
- Heavy motion blur.
- Missing path marking.
- Ambiguous intersection.
- Obstacle partially hidden.
- Incorrect object detection.
- GPS jump.
- Route file mismatch.
- Motion permission denied.
- Headphones disconnected.
- Audio output muted.
- Browser backgrounded.
- Low battery or thermal throttling.
- Unsupported vibration.
- Stale spatial observations.

For safety-related uncertainty, the system must avoid confidently inventing a direction.

## 12.4 Restricted Claims

The product must not claim:

- Guaranteed safe independent running.
- Perfect obstacle recognition.
- Automatic collision avoidance.
- Instantaneous physical correction.
- Certified medical or mobility functionality.
- Worldwide first-of-its-kind status without additional prior-art review.

---

# 13. PRODUCT SUCCESS METRICS

## 13.1 Primary Success Metrics

**Route understanding**

Can participants identify major route turns after CourseDNA rehearsal?

**Decision accuracy**

How many correct route decisions are made in RaceTwin?

**Learning between attempts**

Does performance change over repeated simulations?

**Independent accessibility**

Can participants complete the core experience without visual assistance?

## 13.2 Secondary Metrics

- Spatial cue recognition accuracy.
- Response time to cues.
- Number of missed turns.
- Average simulated lateral path error.
- Recovery time after simulated mistakes.
- Number of cues delivered.
- Number of repeated or suppressed alerts.
- Perceived mental workload.
- User-reported clarity and confidence.
- Session completion and technical failure rates.

## 13.3 Computer-Vision Research Metrics

- Path segmentation quality.
- Centerline estimation error.
- Candidate obstacle precision and recall.
- False hazard warnings.
- Missed candidate obstacles.
- Processing latency.
- Tracking-loss frequency.
- Correct uncertainty responses.

## 13.4 Comparison Experiments

**Experiment 1: Spoken Directions vs. CourseDNA**

Measure route recall and decision accuracy after both preparation methods.

**Experiment 2: Reactive Guidance vs. FutureStep**

Measure simulated route departures, false warnings, and response timing.

**Experiment 3: Fixed Sound Cues vs. Soundprint**

Measure directional-cue recognition and preference.

**Experiment 4: Verbal Summary vs. Race Memory**

Measure how accurately participants identify where and why a simulated route deviation occurred.

The results must be reported as measured, including negative or inconclusive outcomes.

---

# 14. RELEASE PLAN

## Release 1: Hackathon MVP

### Must ship

- Accessible application foundation.
- Athlete profile and preferences.
- Device and audio checks.
- GPX route importer.
- Route geometry and segmentation.
- CourseDNA route exploration.
- Binaural sound engine.
- Cue priority manager.
- RaceTwin interactive simulation.
- Missed-turn scenario.
- Changed-route scenario.
- GPS-uncertainty scenario.
- Spatial Memory Transfer between virtual modes.
- Race Memory.
- Planned-versus-actual route comparison.
- Basic Soundprint calibration.
- Accessible session metrics.

### Success definition

One user can complete an entire virtual course-learning cycle without needing to see the screen.

## Release 1.1: Hackathon Stretch

- Marked-path segmentation on prerecorded footage.
- Detected centerline visualization.
- Candidate obstacle detection.
- Research hazard alerts.
- Simulated predictive drift.
- Time-to-edge.
- GPS trace import.
- Basic RealityMatch.
- GuideBridge route notes.

### Success definition

A controlled camera recording can generate measured path and candidate-hazard events, while the application clearly shows failures and uncertainty.

## Release 2: Supervised Research Pilot

- More robust live path perception.
- Native Android exploration.
- Sensor fusion.
- Visual-inertial spatial tracking.
- Improved route matching.
- Environmental obstacle research.
- Outdoor supervised tests.
- User-informed cue redesign.
- Adaptive running coaching.

### Success definition

Clearly defined perception and feedback tasks meet pre-established research criteria in supervised testing.

## Release 3: Broader Adaptive Sports

- Triathlon course preparation.
- Swimming movement sonification.
- Goalball tactical simulations.
- Accessible wheelchair-sports replay.
- Extended coach collaboration.

Each sport requires its own task-specific design and validation.

---

# 15. DEVELOPMENT PLAN AND OWNERSHIP

## Workstream A: Course and Geospatial Engine

**Responsibilities:**
- GPX import.
- Distance calculations.
- Route bearings.
- Turn identification.
- Segmentation.
- Route event generation.

**Deliverable:** A structured, reusable course model.

## Workstream B: Audio and Accessibility

**Responsibilities:**
- Web Audio.
- PannerNode spatialization.
- Cue priority management.
- Soundprint.
- Screen-reader controls.
- Haptic fallback.

**Deliverable:** Consistent and accessible directional feedback.

## Workstream C: RaceTwin and What-If Simulation

**Responsibilities:**
- Virtual runner.
- Steering controls.
- Scenario engine.
- Movement calculations.
- Event logging.

**Deliverable:** A complete virtual course-practice experience.

## Workstream D: Race Memory and Evaluation

**Responsibilities:**
- Session data.
- Spatial replay.
- Route comparisons.
- Progress metrics.
- Testing and demo integration.

**Deliverable:** A meaningful post-session analysis experience.

## Optional Workstream E: Computer Vision

**Responsibilities:**
- Recorded-video ingestion.
- Path segmentation.
- Centerline extraction.
- Obstacle candidates.
- Benchmarking.
- Confidence visualization.

**Deliverable:** A clearly labeled research prototype demonstrating the original running-guidance direction.

---

# 16. DEFINITION OF DONE

A feature is complete only when:

1. It works on the selected test device.
2. It has clear user-facing feedback.
3. Important failures are handled.
4. It is accessible through the intended controls.
5. Its outputs are recorded or reproducible where relevant.
6. It has at least one documented test.
7. It does not claim capabilities beyond what was demonstrated.
8. It is integrated into the main athlete journey.

The following must be verified before the hackathon submission:

- GPX import succeeds for valid routes.
- Invalid routes produce accessible errors.
- Route segmentation is reproducible.
- Audio direction mapping is consistent.
- RaceTwin records user decisions.
- All three What-If scenarios work.
- Saved sessions replay correctly.
- Route comparisons calculate correctly.
- Unsupported vibration is handled.
- The core application works with keyboard navigation.
- Tracking uncertainty is not presented as a confirmed safe route.
- Research perception modules are visibly separated from validated functionality.

---

# 17. HACKATHON DEMONSTRATION REQUIREMENTS

The final demo should follow one athlete's experience rather than presenting disconnected features.

## Scene 1: Introduce the Problem

Explain that blind runners may need assistance not only with immediate navigation, but also with understanding and preparing for unfamiliar racecourses.

## Scene 2: Upload a Real Course

Import a GPX route.

Show how the route becomes structured segments.

## Scene 3: Hear the Course

Let a judge listen to CourseDNA through headphones.

Demonstrate a turn, checkpoint, and recognizable sequence of bends.

## Scene 4: Practice With RaceTwin

The judge navigates a virtual course using spatial audio.

The audience sees the route and virtual athlete.

## Scene 5: Introduce an Unexpected Event

Trigger a missed-turn or changed-route scenario.

The judge responds without viewing the course.

## Scene 6: Review Race Memory

Replay the simulated attempt.

Show how the athlete can independently recognize their mistake and compare an alternative.

## Scene 7: Demonstrate Camera Perception

If implemented, show recorded running-track footage.

Display the detected guideline, estimated centerline, and candidate obstacle.

Trigger a tracking-loss state to demonstrate honest uncertainty handling.

## Scene 8: Connect Everything

Show how the course segment used in preparation also appears in simulation and Race Memory.

Explain Spatial Memory Transfer.

**Closing message:**

"Most navigation systems focus on telling someone which way to go. KineticSpatial explores how athletes can understand a course before experiencing it, receive meaningful spatial information while training, and learn independently from every attempt."

---

# 18. RISKS AND MITIGATION

| Risk | Impact | Mitigation |
|---|---|---|
| Computer vision fails outdoors | Unsafe or misleading feedback | Research-only mode, supervised testing, tracking-confidence checks |
| Spatial audio is confusing | Poor user experience | Co-design, Soundprint, simple cue vocabulary |
| Too many alerts | Increased cognitive load | Priority manager, cooldowns, limited cues |
| Browser APIs unsupported | Missing features | Capability detection and fallback modes |
| GPX geometry is inaccurate | Wrong course interpretation | Route validation and source labeling |
| GPS is inaccurate | False route deviations | Confidence-aware route matching |
| User data exposes location history | Privacy risk | Local-first storage and explicit sharing |
| Feature scope becomes too large | Incomplete hackathon product | Strict P0/P1/R separation |
| Similarity to Google | Weak differentiation | Emphasize Spatial Memory Transfer and end-to-end course learning |
| Accessibility not tested | Product fails intended users | Screen-reader testing and direct athlete participation |
| Simulated success mistaken for real-world safety | Misleading claims | Clearly distinguish simulator, perception prototype, and validated field functionality |

---

# 19. DEPENDENCIES AND OPEN QUESTIONS

## Dependencies

- Representative GPX course files.
- Compatible web browsers.
- Spatial audio-capable headphones.
- Accessible interface testing.
- Recorded path footage for the vision prototype.
- Appropriate model weights and licenses.
- Development devices.
- Input from blind and low-vision athletes and running guides.

## Questions to Resolve Through Testing

**Audio design:** Which sound patterns are easiest for athletes to understand while remaining aware of their surroundings?

**Course representation:** How many route details should be communicated before the audio becomes overwhelming?

**Spatial Memory Transfer:** Does keeping route cues consistent across preparation and replay improve recognition?

**Simulation:** Do athletes find virtual steering decisions useful preparation for real training?

**Perception:** Which environments can the selected phone and model actually interpret reliably?

**Hardware:** Which browser and device combinations provide acceptable performance for each non-safety-critical function?

**Athletic relevance:** Which types of race preparation are most useful to blind and low-vision runners?

These questions should guide development rather than be treated as solved assumptions.

---

# 20. FUTURE PRODUCT EXPANSION

## 20.1 Marathon and Running Events

Support:
- Real course import.
- Route rehearsal.
- Spatial training.
- Guide annotations.
- Checkpoint information.
- Post-run replay.

## 20.2 Triathlon and Ironman Preparation

Support:
- Known swim-course layouts.
- Cycling route previews.
- Running route previews.
- Transition planning.
- Athlete-guide coordination.

The system must respect competition rules and retain required assistance.

## 20.3 Goalball Training

Build spatial-audio simulations of ball trajectories and defensive choices.

This would be a dedicated training tool, not an in-match acoustic radar.

## 20.4 Swimming and StrokeEcho

Use poolside video analysis to extract visible stroke and approach events.

Convert movement differences into audio for independent technical review.

## 20.5 Wheelchair Sports

Use recorded match data to explore positioning, opponent approaches, and tactical decisions through spatial replay.

Live collision detection is a separate high-risk research project.

---

# 21. PRODUCT ROADMAP SUMMARY

| Phase | Focus | Deliverable |
|---|---|---|
| Phase 1 | Route foundation | GPX parsing and CourseDNA structure |
| Phase 2 | Spatial audio | Directional audio and priority engine |
| Phase 3 | Interactive training | RaceTwin virtual runner |
| Phase 4 | Scenario learning | What-If Training |
| Phase 5 | Reflection | Race Memory and comparison |
| Phase 6 | Accessibility | Soundprint and screen-reader validation |
| Phase 7 | Computer vision | Marked-path research prototype |
| Phase 8 | Obstacle awareness | Controlled recorded-video detection |
| Phase 9 | Course integration | GPS RealityMatch |
| Phase 10 | Field research | Supervised sensor and navigation testing |
| Phase 11 | Sports expansion | Triathlon, swimming, and other modules |

---

# 22. FINAL PRODUCT DEFINITION

KineticSpatial is a mobile-first accessibility platform that connects real-time spatial guidance with accessible racecourse learning and performance reflection.

Its foundation includes camera-based path recognition, obstacle-awareness research, spatial tracking, predictive movement analysis, binaural audio, and optional haptic feedback.

Its proposed core innovation is the connection between **CourseDNA, RaceTwin, Spatial Memory Transfer, What-If Training, RealityMatch, and Race Memory**.

Athletes can prepare for a route before arriving, practice meaningful decisions in an accessible simulation, receive relevant environmental information during supported training, and independently revisit what happened afterward.

The platform is designed to give blind and visually impaired athletes greater control over their preparation and understanding, while treating safety, privacy, and human assistance as essential design requirements.

**KineticSpatial does not just ask, "How can we guide a runner?"**

**It asks, "How can we make the entire experience of learning, navigating, and understanding a racecourse accessible?"**

*Don't just follow the path. Know the course.*

---

## Product Decision

**Primary MVP:** CourseDNA + Spatial Audio + RaceTwin + What-If Training + Race Memory.

**Technical stretch:** Camera-based guideline tracking, obstacle candidate detection, predictive deviation, and RealityMatch using recorded or simulated data.

**Future validated product:** Real-world navigation, 3D mapping, pedestrian tracking, advanced coaching, and adaptive-sports expansion.

The team should prioritize a working, accessible, end-to-end product over a larger set of unfinished or unvalidated capabilities.