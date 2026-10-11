import type { DistanceBand, Zone } from '../core/types';
import { CATEGORY_PRIORITY } from '../perception/classes';
import { bandOf, bandRank, closeness, pulseRateHz } from '../perception/geometry';
import { centerOverlap } from '../perception/zones';
import type { Track } from '../perception/tracker';

export type CueKind = 'person' | 'vehicle' | 'static' | 'blocked' | 'guide';

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
  { burstMs: number; minRecueMs: number; maxDistance: number; sideStaticMax: number; recueOnZoneChange: boolean }
> = {
  calm: { burstMs: 900, minRecueMs: 4000, maxDistance: 4.5, sideStaticMax: 1.8, recueOnZoneChange: false },
  normal: { burstMs: 1100, minRecueMs: 2500, maxDistance: 6, sideStaticMax: 3, recueOnZoneChange: true },
  detailed: { burstMs: 1400, minRecueMs: 0, maxDistance: Infinity, sideStaticMax: Infinity, recueOnZoneChange: true },
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
export class CuePolicy {
  private state = new Map<number, TrackCueState>();
  private lastBlockedSeen = -Infinity;
  private blockedActive = false;
  private guide: 'left' | 'right' | null = null;

  reset(): void {
    this.state.clear();
    this.blockedActive = false;
    this.guide = null;
  }

  update(tracks: readonly Track[], now: number, cfg: PolicyConfig, loomingCenter = false): PolicyOutput {
    const live = tracks.filter((t) => t.confirmed);
    const liveIds = new Set(live.map((t) => t.id));
    for (const id of this.state.keys()) if (!liveIds.has(id)) this.state.delete(id);

    // --- Blocked path -------------------------------------------------------
    const blockers = live
      .filter((t) => centerOverlap(t.box, cfg.centerWidth) >= BLOCK_CENTER_OVERLAP)
      .sort((a, b) => a.distance - b.distance);
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
    }

    const sources: CueSource[] = [];
    const blockerId = this.blockedActive && nearest ? nearest.id : undefined;

    if (this.blockedActive) {
      const side = this.freerSide(live, blockerId);
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
      const sideStatic = t.category === 'static' && t.zone !== 'center' && t.distance > budget.sideStaticMax;
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
        const urgent = t.band === 'veryNear' && st.band !== 'veryNear' && sinceCue >= 1200;
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

    for (const c of candidates) {
      if (sources.length >= cfg.maxSources) break;
      sources.push(c);
    }
    return { sources: sources.slice(0, cfg.maxSources), blocked: this.blockedActive, guideSide: this.guide };
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
