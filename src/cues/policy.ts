import type { DistanceBand, Zone } from '../core/types';
import { CATEGORY_PRIORITY } from '../perception/classes';
import { bandOf, bandRank, closeness, pulseRateHz } from '../perception/geometry';
import { centerOverlap } from '../perception/zones';
import { growthRate, type Track } from '../perception/tracker';
import { chooseGuide, type PathModel } from '../perception/freespace';
import type { LgmdOutput } from '../perception/lgmd';

/** 'looming' = something unrecognised rushing at you from one side (LGMD pathway). */
export type CueKind = 'person' | 'vehicle' | 'static' | 'blocked' | 'guide' | 'looming';

/** Extra perception the policy can use when available. */
export interface PolicyEnv {
  /** Legacy: center looming flag (forces the blocked path). */
  loomingCenter?: boolean;
  /** Walkable-path model: the guide tone only points where the path continues. */
  path?: PathModel | null;
  /** Locust-inspired looming pathway (class-agnostic, per sector). */
  lgmd?: LgmdOutput | null;
  /**
   * Where the depth AI measured the unrecognised thing in your path
   * (metres: x + right, z forward). Lets the side choice step AWAY from a
   * pole or bench the object detector has no name for.
   */
  depthObstacle?: { x: number; z: number } | null;
  /** The wearer is walking (motion sensor). Enables "walking your way" for people ahead. */
  walking?: boolean;
}

/** Closing speed below this (m/s) = someone ahead walking the same way as you. */
const PACING_CLOSING_MS = 0.6;
/** ...unless they're this close: then it's a blockage again. */
const PACING_MIN_M = 1.2;

/** Lateral clearance needed to pass someone: about body width plus a margin (metres). */
const PASS_CLEARANCE_M = 0.6;

/** One sound source the audio engine should be playing right now. */
export interface CueSource {
  /** Stable key: `t<id>` for tracked objects, or 'blocked' / 'guide'. */
  key: string;
  kind: CueKind;
  trackId?: number;
  label?: string;
  zone: Zone;
  /** Radians, negative = left. */
  azimuth: number;
  /** Radians above (+) / below (-) eye level, when known. */
  elevation?: number;
  distance: number;
  band: DistanceBand;
  /** Pulses per second. */
  rateHz: number;
  /** Sound without gaps (blocked path inside 1 m). */
  continuous: boolean;
  /** 0..1 urgency: drives gain and pitch. */
  urgency: number;
  /** Vehicle within 3 m: add a second tone. */
  secondTone: boolean;
  /** True on the update this source (re)started: used for latency measurement and logs. */
  triggered: boolean;
}

export interface PolicyConfig {
  centerWidth: number;
  blockDistance: number;
  maxSources: number;
  /** How talkative cues are (default 'detailed' = every qualifying event). */
  density?: CueDensity;
  /** Focal length as a fraction of frame width (converts metres to image width at a distance). */
  focalNorm?: number;
}

export type CueDensity = 'calm' | 'normal' | 'detailed';

/**
 * Cue budgets. "calm" is for everyday walking: a short burst per object,
 * a long gap before repeating, nothing beyond ~4.5 m, and side obstacles
 * only when very close. Safety cues (blocked path, very-near approaching
 * objects) are never suppressed.
 */
export const DENSITY: Record<
  CueDensity,
  { burstMs: number; minRecueMs: number; maxDistance: number; sideStaticMax: number; recueOnZoneChange: boolean; quietSides: boolean }
> = {
  // Calm: nothing sounds unless it is in your path within 3.5 m, or coming at you.
  calm: { burstMs: 800, minRecueMs: 5000, maxDistance: 3.5, sideStaticMax: 0, recueOnZoneChange: false, quietSides: true },
  normal: { burstMs: 1100, minRecueMs: 2500, maxDistance: 6, sideStaticMax: 3, recueOnZoneChange: true, quietSides: false },
  detailed: { burstMs: 1400, minRecueMs: 0, maxDistance: Infinity, sideStaticMax: Infinity, recueOnZoneChange: true, quietSides: false },
};

interface TrackCueState {
  activeUntil: number;
  band: DistanceBand;
  zone: Zone;
  distance: number;
  lastCueAt: number;
}

/** How long a cue keeps pulsing after it is triggered (detailed density). */
export const CUE_WINDOW_MS = 1400;
const BLOCK_RELEASE_MS = 500;
const BLOCK_CENTER_OVERLAP = 0.3;
const CONTINUOUS_M = 1;

export interface PolicyOutput {
  sources: CueSource[];
  blocked: boolean;
  guideSide: 'left' | 'right' | null;
  /** Blocked, and the path model sees no walkable way around on either side. */
  noWayAround: boolean;
  /** What decided the guide side. */
  guideFrom: 'path' | 'clutter' | null;
  /** Sector where the looming pathway fired with no recognised object to explain it. */
  unexplainedLooming: Zone | null;
  /**
   * A person ahead walking the same way (slowly closing): not a blockage.
   * Follow them, or pass on `side`.
   */
  pacing: { trackId: number; distance: number; side: 'left' | 'right' | null } | null;
}

/**
 * Turns tracked objects into at most `maxSources` cue sources.
 *
 * - An object cues on first (confirmed) entry, then again only if it gets
 *   markedly closer or changes zone (US-2.3). Very-near approaching objects
 *   keep sounding so urgency stays obvious.
 * - A close obstacle in the center zone becomes the blocked-path buzz, with a
 *   guide tone toward the freer side (US-3.2).
 * - Priority: blocked > guide > vehicles > people > static.
 */
const passSide = (d: string): 'left' | 'right' | null => (d === 'left' || d === 'right' ? d : null);

export class CuePolicy {
  private state = new Map<number, TrackCueState>();
  private lastBlockedSeen = -Infinity;
  private blockedActive = false;
  private guide: 'left' | 'right' | null = null;
  private lastLoomZone: Zone | null = null;
  /** Path decisions must persist before they change what we say/play. */
  private pending: { d: string; n: number } = { d: '', n: 0 };
  private settled: 'left' | 'right' | 'none' | 'unknown' = 'unknown';

  reset(): void {
    this.settled = 'unknown';
    this.pending = { d: '', n: 0 };
    this.state.clear();
    this.blockedActive = false;
    this.guide = null;
  }

  update(tracks: readonly Track[], now: number, cfg: PolicyConfig, envOrLooming: PolicyEnv | boolean = {}): PolicyOutput {
    const env: PolicyEnv = typeof envOrLooming === 'boolean' ? { loomingCenter: envOrLooming } : envOrLooming;
    const live = tracks.filter((t) => t.confirmed);
    // Looming pathway: a sector fires. If a tracked object there explains it,
    // that object's cue becomes urgent; if not, it's an unrecognised threat.
    const loomZone = env.lgmd?.looming ?? null;
    const explained = loomZone ? live.find((t) => t.zone === loomZone && t.distance < 6) : undefined;
    const unexplainedLooming = loomZone && !explained ? loomZone : null;
    const loomingCenter = !!env.loomingCenter || unexplainedLooming === 'center';
    const liveIds = new Set(live.map((t) => t.id));
    for (const id of this.state.keys()) if (!liveIds.has(id)) this.state.delete(id);

    // --- Blocked path -------------------------------------------------------
    // Someone ahead walking your way closes slowly: follow or pass, don't stop.
    // Needs positive evidence: at least ~0.8 s of size history showing a slow
    // closing speed. A person just seen (no history yet) is never assumed safe.
    const isPacing = (t: Track) => {
      if (!env.walking || t.category !== 'person' || !(t.distance >= PACING_MIN_M) || !Number.isFinite(t.distance)) return false;
      const hist = t.history;
      if (hist.length < 5 || hist[hist.length - 1].t - hist[0].t < 800) return false;
      const rate = growthRate(hist); // apparent size h = 1/distance, so closing speed = rate * d^2
      return rate !== null && Math.max(0, rate) * t.distance * t.distance < PACING_CLOSING_MS;
    };
    const inPath = live.filter((t) => centerOverlap(t.box, cfg.centerWidth) >= BLOCK_CENTER_OVERLAP);
    const blockers = inPath.filter((t) => !isPacing(t)).sort((a, b) => a.distance - b.distance);
    const pacer = inPath.filter(isPacing).sort((a, b) => a.distance - b.distance)[0];
    const nearest = blockers[0];
    const releaseDist = cfg.blockDistance * 1.15; // hysteresis
    const blockingNow =
      loomingCenter ||
      (nearest !== undefined && nearest.distance < (this.blockedActive ? releaseDist : cfg.blockDistance));
    let blockTriggered = false;
    if (blockingNow) {
      this.lastBlockedSeen = now;
      if (!this.blockedActive) {
        this.blockedActive = true;
        blockTriggered = true;
      }
    } else if (this.blockedActive && now - this.lastBlockedSeen > BLOCK_RELEASE_MS) {
      this.blockedActive = false;
      this.guide = null;
      this.settled = 'unknown';
      this.pending = { d: '', n: 0 };
    }
    let noWayAround = false;
    let guideFrom: PolicyOutput['guideFrom'] = null;

    const sources: CueSource[] = [];
    const blockerId = this.blockedActive && nearest ? nearest.id : undefined;

    if (this.blockedActive) {
      let side: 'left' | 'right' | null = null;
      // Path-aware guidance: step to the side where the PATH continues with
      // room to pass, not merely the side with fewer objects.
      // Hysteresis on the clearance: once a side is chosen it takes clearly
      // less room to give up on it, and clearly more to leave "no way around".
      const baseNeed = Math.min(0.5, Math.max(0.06, (PASS_CLEARANCE_M * (cfg.focalNorm ?? 0.78)) / Math.max(0.5, nearest?.distance ?? 1)));
      const need = baseNeed * (this.settled === 'left' || this.settled === 'right' ? 0.8 : this.settled === 'none' ? 1.15 : 1);
      // Only re-decide on a fresh sighting: while the blocker is merely
      // remembered (just vanished), keep the last decision.
      const fresh = nearest !== undefined && nearest.lastSeen >= now - 1;
      // No recognised blocker but depth measured one: an image box for it.
      const fn = cfg.focalNorm ?? 0.78;
      const dob = !nearest && env.depthObstacle && env.depthObstacle.z > 0.2 ? env.depthObstacle : null;
      const depthBox = dob
        ? (() => {
            const cx = 0.5 + (dob.x / dob.z) * fn, bw = Math.min(0.6, Math.max(0.08, (0.45 * fn) / dob.z));
            return { x: cx - bw / 2, y: 0.3, w: bw, h: 0.6 };
          })()
        : null;
      const decision =
        env.path && nearest && nearest.distance < releaseDist
          ? fresh
            ? chooseGuide(env.path, nearest.box, need, this.guide)
            : this.settled
          : env.path && depthBox
            ? chooseGuide(env.path, depthBox, need, this.guide)
            : 'unknown';
      // Debounce: a new decision must hold for a few frames (a half-formed box
      // while someone moves must not flip "step left" to "no way around").
      if (decision === this.pending.d) this.pending.n++;
      else this.pending = { d: decision, n: 1 };
      const needFrames = decision === 'none' ? 4 : 3;
      // A first side choice can apply at once; "no way around" must always persist.
      if ((this.settled === 'unknown' && decision !== 'none') || this.pending.n >= needFrames) this.settled = decision;
      const settled = this.settled;
      if (settled === 'left' || settled === 'right') {
        side = settled;
        guideFrom = 'path';
      } else if (settled === 'none') {
        noWayAround = true;
      } else if (depthBox) {
        // Step away from where depth says it is.
        side = depthBox.x + depthBox.w / 2 > 0.5 ? 'left' : 'right';
        guideFrom = 'clutter';
      } else {
        side = this.freerSide(live, blockerId);
        guideFrom = side ? 'clutter' : null;
      }
      const guideTriggered = side !== null && side !== this.guide;
      this.guide = side;

      const d = nearest && nearest.distance < releaseDist ? nearest.distance : loomingCenter ? 1.2 : cfg.blockDistance;

      // Directional buzz cue: guide the blind runner into the freer side
      const steerZone: Zone = side ?? 'center';
      const steerAzimuth = side === 'left' ? -Math.PI / 2 : side === 'right' ? Math.PI / 2 : 0;

      sources.push({
        key: 'blocked',
        kind: 'blocked',
        label: nearest?.label,
        zone: steerZone,
        azimuth: steerAzimuth,
        distance: d,
        band: bandOf(d),
        rateHz: pulseRateHz(d),
        continuous: d < CONTINUOUS_M,
        urgency: closeness(d),
        secondTone: false,
        triggered: blockTriggered,
      });
      if (side) {
        sources.push({
          key: 'guide',
          kind: 'guide',
          zone: side,
          azimuth: side === 'left' ? -Math.PI / 2 : Math.PI / 2,
          distance: d,
          band: bandOf(d),
          rateHz: 0.8,
          continuous: false,
          urgency: 0.4,
          secondTone: false,
          triggered: guideTriggered,
        });
      }
    }

    // --- Per-object cues ----------------------------------------------------
    const budget = DENSITY[cfg.density ?? 'detailed'];
    const candidates: CueSource[] = [];
    for (const t of live) {
      if (t.id === blockerId) continue; // already represented by the buzz
      // Gating: far objects, and static things beside the path, stay quiet.
      const inRange = t.distance <= budget.maxDistance;
      // Beside your path and not coming at you: heard in calm mode only if it approaches.
      const sideStatic =
        (t.category === 'static' && t.zone !== 'center' && t.distance > budget.sideStaticMax) ||
        (budget.quietSides && t.zone !== 'center' && !(t.approaching && t.ttc < 4) && explained?.id !== t.id);
      let st = this.state.get(t.id);
      if (!st && (!inRange || sideStatic)) continue;
      let triggered = false;
      if (!st) {
        st = { activeUntil: now + budget.burstMs, band: t.band, zone: t.zone, distance: t.distance, lastCueAt: now };
        this.state.set(t.id, st);
        triggered = true;
      } else {
        const closer = bandRank(t.band) > bandRank(st.band) || t.distance < st.distance * 0.7;
        const moved = budget.recueOnZoneChange && t.zone !== st.zone;
        const sinceCue = now - st.lastCueAt;
        // Becoming very near always re-cues quickly; everything else waits its turn.
        const urgent =
          (t.band === 'veryNear' && st.band !== 'veryNear' && sinceCue >= 1200) ||
          (explained?.id === t.id && sinceCue >= 1200); // the looming pathway confirms it's coming at you
        if (inRange && !sideStatic && (urgent || ((closer || moved) && sinceCue >= budget.minRecueMs))) {
          st.activeUntil = now + budget.burstMs;
          st.lastCueAt = now;
          triggered = true;
        } else if (t.band === 'veryNear' && t.approaching && t.category !== 'static') {
          st.activeUntil = Math.max(st.activeUntil, now + 400); // keep sounding while it closes in
        }
        // The reference is the last CUED position, so a held-back approach still re-cues later.
        if (triggered) {
          st.band = t.band;
          st.distance = t.distance;
        }
        st.zone = t.zone;
        // Moving away: remember the farther position so coming back re-cues.
        if (t.distance > st.distance * 1.3) {
          st.distance = t.distance;
          st.band = t.band;
        }
      }
      if (now > st.activeUntil) continue;
      candidates.push({
        key: `t${t.id}`,
        kind: t.category,
        trackId: t.id,
        label: t.label,
        zone: t.zone,
        azimuth: t.azimuth,
        elevation: t.elevation,
        distance: t.distance,
        band: t.band,
        rateHz: pulseRateHz(t.distance),
        continuous: false,
        urgency: closeness(t.distance),
        secondTone: t.category === 'vehicle' && t.distance < 3,
        triggered,
      });
    }
    candidates.sort(
      (a, b) =>
        CATEGORY_PRIORITY[a.kind as keyof typeof CATEGORY_PRIORITY] -
          CATEGORY_PRIORITY[b.kind as keyof typeof CATEGORY_PRIORITY] || a.distance - b.distance,
    );

    if (unexplainedLooming && unexplainedLooming !== 'center' && sources.length < cfg.maxSources) {
      const triggered = this.lastLoomZone !== unexplainedLooming;
      sources.push({
        key: 'looming',
        kind: 'looming',
        zone: unexplainedLooming,
        azimuth: unexplainedLooming === 'left' ? -0.45 : 0.45,
        distance: 2,
        band: 'near',
        rateHz: 2.5,
        continuous: false,
        urgency: 0.6 + 0.4 * (env.lgmd?.strength ?? 0),
        secondTone: false,
        triggered,
      });
    }
    this.lastLoomZone = unexplainedLooming;
    for (const c of candidates) {
      if (sources.length >= cfg.maxSources) break;
      sources.push(c);
    }
    return {
      sources: sources.slice(0, cfg.maxSources),
      blocked: this.blockedActive,
      guideSide: this.guide,
      noWayAround,
      guideFrom,
      unexplainedLooming,
      pacing:
        pacer && pacer.distance < cfg.blockDistance * 1.5
          ? {
              trackId: pacer.id,
              distance: pacer.distance,
              side: env.path ? passSide(chooseGuide(env.path, pacer.box, 0.12, null)) : this.freerSide(live, pacer.id),
            }
          : null,
    };
  }

  /** Side with less (and farther) clutter; null if both sides are crowded and close. */
  private freerSide(live: Track[], exclude?: number): 'left' | 'right' | null {
    const load = { left: 0, right: 0 };
    for (const t of live) {
      if (t.id === exclude || t.zone === 'center') continue;
      load[t.zone] += 0.2 + closeness(t.distance);
    }
    if (load.left > 0.9 && load.right > 0.9) return null;
    // Stick with the current side unless the other is clearly freer.
    if (this.guide && load[this.guide] <= load[this.guide === 'left' ? 'right' : 'left'] + 0.3) return this.guide;
    if (load.left === load.right) return this.guide ?? 'right';
    return load.left < load.right ? 'left' : 'right';
  }
}
