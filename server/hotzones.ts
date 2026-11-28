// Hot-zone engine + credit scheduler (design 2026-11-22 §A/§B, wave-10
// two-zone extension, section boost 2026-11-27 §B). Pure: no I/O, no state
// outside the ZonesState value the poller carries in its closure. All
// functions are deterministic; `nowMs` is always injected.

import { AIR_KINDS, type AirKind } from "../shared/craft.js";
import { statesCallCost } from "../shared/credits.js";
import type { LonLat } from "../shared/geo.js";

export interface ZoneMember {
  id: string;
  kind: AirKind;
  lat: number;
  lon: number;
}

export interface HotZone {
  center: LonLat;
  halfW: number;
  halfH: number;
  count: number;
  dominantKind: AirKind;
}

// One hysteresis slot: the broadcast-geometry copy of a zone plus its own
// last-members-seen clock. Plain JSON-able object.
export interface ZoneState {
  box: HotZone | null;
  lastMembersAt: number;
}

// Up to MAX_ZONES slots with stable identity across ticks (a live zone keeps
// its slot while another zone appears, holds or expires beside it).
export interface ZonesState {
  slots: ZoneState[];
}

export const MAX_ZONES = 2;

const CELL_DEG = 2;
const MAX_HALF_DEG = 2.5; // R1: zone box stays in the 1-credit <=25 sq° tier
const MEMBER_TTL_MS = 5 * 60_000; // R4: expire 5 min after the last member
const COPY_DRIFT_DEG = 0.5; // R4: broadcast copy moves only past this drift

const cellOf = (v: number): number => Math.floor(v / CELL_DEG);
const cellKey = (latCell: number, lonCell: number): string => `${latCell}:${lonCell}`;

// Strict rectangle intersection on zone boxes (edge-touching is not overlap).
export function boxesOverlap(a: HotZone, b: HotZone): boolean {
  return (
    a.center.lon - a.halfW < b.center.lon + b.halfW &&
    b.center.lon - b.halfW < a.center.lon + a.halfW &&
    a.center.lat - a.halfH < b.center.lat + b.halfH &&
    b.center.lat - b.halfH < a.center.lat + a.halfH
  );
}

function geometryFor(cluster: ZoneMember[]): HotZone {
  let lat = 0;
  let lon = 0;
  for (const m of cluster) {
    lat += m.lat;
    lon += m.lon;
  }
  const center = { lat: lat / cluster.length, lon: lon / cluster.length };
  let halfW = 0;
  let halfH = 0;
  for (const m of cluster) {
    halfW = Math.max(halfW, Math.abs(m.lon - center.lon));
    halfH = Math.max(halfH, Math.abs(m.lat - center.lat));
  }
  halfW = Math.min(halfW, MAX_HALF_DEG);
  halfH = Math.min(halfH, MAX_HALF_DEG);
  // Clamp by shifting the box inward on each axis; seam members outside the
  // edge stay in the count (box membership follows the grid neighborhood,
  // not the rect).
  center.lon = Math.min(180 - halfW, Math.max(-180 + halfW, center.lon));
  center.lat = Math.min(90 - halfH, Math.max(-90 + halfH, center.lat));
  // Kind ties go to the kind whose first member appears later in the input
  // (first-appearance map order + >=); distinct from the densest-cell rule.
  const kindCounts = new Map<AirKind, number>();
  for (const m of cluster) kindCounts.set(m.kind, (kindCounts.get(m.kind) ?? 0) + 1);
  let dominantKind: AirKind = "general";
  let kindMax = 0;
  for (const [kind, n] of kindCounts) {
    if (n >= kindMax) {
      kindMax = n;
      dominantKind = kind;
    }
  }
  return { center, halfW, halfH, count: cluster.length, dominantKind };
}

// Candidate boxes: one per occupied cell — the geometry of that cell's full
// 3x3-cell hood (the grid never wraps, so lon ±180 cells are never neighbors
// and a straddling pattern competes as two clusters). Rank = hood density
// (the "densest first" rule); ties fall to the denser cell, then the cell
// whose latest sighting comes later in the input (deterministic — wave 7's
// pinned rule when every cluster is one cell). Greedy selection keeps the
// densest candidate and skips any candidate whose box overlaps one already
// kept — the second zone is the densest remaining non-overlapping cluster.
// Candidates dedupe when two cells see the same OCCUPIED cells in their hoods
// (identical geometry — the ghost of a neighbor's cluster, never a zone).
function candidateBoxes(members: ZoneMember[]): HotZone[] {
  const cells = new Map<string, { latCell: number; lonCell: number; n: number; last: number }>();
  members.forEach((m, i) => {
    const key = cellKey(cellOf(m.lat), cellOf(m.lon));
    const e = cells.get(key);
    if (e) {
      e.n += 1;
      e.last = i;
    } else {
      cells.set(key, { latCell: cellOf(m.lat), lonCell: cellOf(m.lon), n: 1, last: i });
    }
  });
  const hoodCount = (latCell: number, lonCell: number): number => {
    let n = 0;
    for (let dLat = -1; dLat <= 1; dLat++) {
      for (let dLon = -1; dLon <= 1; dLon++) {
        n += cells.get(cellKey(latCell + dLat, lonCell + dLon))?.n ?? 0;
      }
    }
    return n;
  };
  const ranked = [...cells.values()].sort(
    (a, b) =>
      hoodCount(b.latCell, b.lonCell) - hoodCount(a.latCell, a.lonCell) ||
      b.n - a.n ||
      b.last - a.last,
  );
  const cands: HotZone[] = [];
  const seenHoods = new Set<string>();
  for (const cell of ranked) {
    // Past MAX_ZONES the surplus candidates are only alternate matches for
    // continuity; the plan's slot count caps what can ever go live.
    if (cands.length === MAX_ZONES * 2) break;
    // A cell's hood is fully determined by its OCCUPIED cells; when an
    // already-ranked cell shares the occupied set the cluster geometry is
    // identical, so that ghost candidate is deduped instead of kept.
    const cluster: ZoneMember[] = [];
    const occupied: string[] = [];
    for (let dLat = -1; dLat <= 1; dLat++) {
      for (let dLon = -1; dLon <= 1; dLon++) {
        const k = cellKey(cell.latCell + dLat, cell.lonCell + dLon);
        if (!cells.has(k)) continue;
        occupied.push(k);
        for (const m of members) if (cellKey(cellOf(m.lat), cellOf(m.lon)) === k) cluster.push(m);
      }
    }
    const hoodKey = occupied.join("|");
    if (seenHoods.has(hoodKey)) continue;
    seenHoods.add(hoodKey);
    const geom = geometryFor(cluster);
    if (cands.some((c) => boxesOverlap(c, geom))) continue;
    cands.push(geom);
  }
  return cands;
}

// Continuity radius for matching a candidate to an existing slot: a zone's
// broadcast box never exceeds 5 deg per side, so a cluster that grew out of
// (or drifted from) a live zone stays within one box-diagonal of it, while a
// genuinely new cluster elsewhere does not.
const MATCH_MAX_DEG = 5;

// One hysteresis step over the slots (R4 per zone). Candidates are matched to
// slots by nearest centroid within MATCH_MAX_DEG (continuity while a zone
// holds or drifts, whatever its density rank); unmatched candidates form only
// under the create rule (>= createMin members, default 2) and only in an empty
// slot; an unmatched slot holds its last broadcast copy verbatim until
// MEMBER_TTL_MS past its own lastMembersAt, then expires. With a live box,
// keep prev geometry when the new centroid drifts <= COPY_DRIFT_DEG on BOTH
// axes — the kept copy still carries the fresh count and dominant kind; larger
// drift on either axis moves the box.
export function planZones(
  members: ZoneMember[],
  nowMs: number,
  prev: ZonesState | null,
  opts?: { createMin?: number },
): { zones: HotZone[]; state: ZonesState } {
  const rawCreate = opts?.createMin ?? 2;
  const createMin = Math.min(10, Math.max(2, Number.isFinite(rawCreate) ? rawCreate : 2));
  const slots: ZoneState[] = [];
  for (let i = 0; i < MAX_ZONES; i++) {
    const s = prev?.slots[i];
    slots.push(s ? { ...s } : { box: null, lastMembersAt: 0 });
  }

  const cands = candidateBoxes(members);
  // Continuity match: nearest candidate centroid per occupied slot (greedy
  // by distance; deterministic tie-break slot then candidate). A slot keeps
  // its identity across ticks — hold, drift-move and expiry follow the zone,
  // not its density rank.
  const matched: (HotZone | null)[] = slots.map(() => null);
  const used = cands.map(() => false);
  const pairs: { si: number; ci: number; d: number }[] = [];
  slots.forEach((s, si) => {
    if (!s.box) return;
    cands.forEach((c, ci) => {
      const d = Math.hypot(s.box!.center.lat - c.center.lat, s.box!.center.lon - c.center.lon);
      if (d <= MATCH_MAX_DEG) pairs.push({ si, ci, d });
    });
  });
  pairs.sort((a, b) => a.d - b.d || a.si - b.si || a.ci - b.ci);
  for (const p of pairs) {
    if (matched[p.si] === null && !used[p.ci]) {
      matched[p.si] = cands[p.ci];
      used[p.ci] = true;
    }
  }
  const fresh: (HotZone | null)[] = slots.map(() => null);
  for (let ci = 0; ci < cands.length; ci++) {
    if (used[ci] || cands[ci].count < createMin) continue;
    const si = slots.findIndex((_, k) => slots[k].box === null && matched[k] === null && fresh[k] === null);
    if (si !== -1) fresh[si] = cands[ci];
  }

  const next: ZoneState[] = slots.map((prevSlot, si) => {
    const cand = matched[si] ?? fresh[si];
    if (cand) {
      let box = cand;
      if (
        prevSlot.box &&
        Math.abs(cand.center.lat - prevSlot.box.center.lat) <= COPY_DRIFT_DEG &&
        Math.abs(cand.center.lon - prevSlot.box.center.lon) <= COPY_DRIFT_DEG
      ) {
        box = { ...prevSlot.box, count: cand.count, dominantKind: cand.dominantKind };
      }
      return { box, lastMembersAt: nowMs };
    }
    if (prevSlot.box && nowMs - prevSlot.lastMembersAt <= MEMBER_TTL_MS) return { ...prevSlot };
    return { box: null, lastMembersAt: prevSlot.lastMembersAt };
  });

  return { zones: next.flatMap((s) => (s.box ? [s.box] : [])), state: { slots: next } };
}

// Whole seconds until the next UTC midnight, in (0, 86400] (exactly
// midnight counts the full day ahead). UTC getters only — never local tz.
function secToUtcMidnight(nowMs: number): number {
  const d = new Date(nowMs);
  const elapsed =
    d.getUTCHours() * 3600 +
    d.getUTCMinutes() * 60 +
    d.getUTCSeconds() +
    d.getUTCMilliseconds() / 1000;
  return 86_400 - elapsed;
}

// R2: surplus = credits remaining - (globe polls still due before UTC
// midnight x their live per-call cost) - 100 headroom; never negative.
// No header seen (null/NaN/non-finite) -> 0, so boost stays off.
export function surplusCredits(
  remaining: number | null,
  nowMs: number,
  globePollMs: number,
  globeCost: number,
): number {
  if (remaining == null || !Number.isFinite(remaining)) return 0;
  const duePolls = Math.ceil((secToUtcMidnight(nowMs) * 1000) / globePollMs);
  const reserve = duePolls * globeCost + 100;
  if (!Number.isFinite(reserve)) return 0;
  return Math.max(0, remaining - reserve);
}

// Zone interval = requested, stretched so zone calls left before UTC
// midnight fit in the surplus; null = paused (no surplus, or the stretch
// alone would exceed the 120 s slider cap). The per-zone credit gate lives in
// the poller (each due zone spends 1 credit off this surplus, zone 1 first).
// Note: the stretch budgets the whole surplus for ONE zone's cadence — with
// two funded zones it burns ~2x, so the model is per-zone-conservative.
export function zoneIntervalFor(
  requestedMs: number,
  surplus: number,
  nowMs: number,
): number | null {
  if (!Number.isFinite(surplus) || surplus < 1) return null;
  const stretched = Math.ceil((secToUtcMidnight(nowMs) * 1000) / surplus);
  if (stretched > 120_000) return null;
  return Math.max(requestedMs, stretched);
}

// --- Section boost (design 2026-11-27 §B) -----------------------------------

// A user-drawn rectangle: [[minLat, minLon], [maxLat, maxLon]] (the client's
// RegionBox shape). Inclusive on every edge.
export type SectionBox = [[number, number], [number, number]];

export interface PollSection {
  id: string;
  kinds: AirKind[];
  boostMs: number;
  b: SectionBox;
  enabled: boolean;
}

// The bbox one /states call covers; HotZone is structurally one of these.
export interface ZoneBox {
  center: LonLat;
  halfW: number;
  halfH: number;
}

// A single box the poller issues one /states call for. cost is fixed by the
// credit law (area tier), never by contents.
export interface PolledZone {
  id: string;
  box: ZoneBox;
  cost: 1 | 2 | 3 | 4;
  // Section: the clamped user rate. Auto: null — zoneIntervalFor (surplus +
  // nowMs, unknown here) stretches it, and that stretch is auto-only.
  intervalMs: number | null;
  source: "section" | "auto";
  kind: AirKind;
  // Members behind the zone: auto = the zone's own count; section = the
  // activation count (matching kind members inside the rect). Zones overlap,
  // so the poller NEVER sums these — boost status `count` is a union of the
  // zones' box members, computed where the plan is built.
  count: number;
}

export interface PollPlanInput {
  autoZones: HotZone[];
  sections: PollSection[];
  members: ZoneMember[];
  autoEnabled: boolean;
  // Boost-ENABLED wire sections (plain highlights never count) — poller-sourced.
  boostedSectionCount: number;
  standdownAt: 0 | 1 | 2;
}

const BOOST_MIN_MS = 10000;
const BOOST_MAX_MS = 120000; // slider cap; mirrors the poller's ZONE_BOOST_MAX_MS
const BOOST_DEFAULT_MS = 30000;

// Mirror of the poller's boostMs clamp (opensky.ts re-clamps harmlessly; kept
// local to avoid a hotzones -> opensky import cycle).
function clampBoostMs(ms: number): number {
  if (!Number.isFinite(ms)) return BOOST_DEFAULT_MS;
  return Math.min(BOOST_MAX_MS, Math.max(BOOST_MIN_MS, Math.round(ms)));
}

function inBox(m: ZoneMember, b: SectionBox): boolean {
  const [[minLat, minLon], [maxLat, maxLon]] = b;
  return m.lat >= minLat && m.lat <= maxLat && m.lon >= minLon && m.lon <= maxLon;
}

// Matching members: kind in section.kinds AND inside the (inclusive) rect.
// Empty kinds => no member ever matches (an unscoped boost is never implied).
function matchingMembers(section: { kinds: AirKind[]; b: SectionBox }, members: ZoneMember[]): ZoneMember[] {
  if (section.kinds.length === 0) return [];
  const kinds = new Set(section.kinds);
  return members.filter((m) => kinds.has(m.kind) && inBox(m, section.b));
}

// Activation gate: is this section worth polling right now? A skipped poll is
// the only credit loophole, so an idle section (no matching traffic) costs 0.
export function sectionActivity(
  section: { kinds: AirKind[]; b: SectionBox },
  members: ZoneMember[],
): { active: boolean; count: number } {
  const count = matchingMembers(section, members).length;
  return { active: count > 0, count };
}

// Plurality kind among matching members; ties fall to the first kind in
// AIR_KINDS order (scanning that order and replacing only on a strict win).
function dominantKindAmong(matching: ZoneMember[]): AirKind | null {
  const counts = new Map<AirKind, number>();
  for (const m of matching) counts.set(m.kind, (counts.get(m.kind) ?? 0) + 1);
  let best: AirKind | null = null;
  let bestCount = 0;
  for (const kind of AIR_KINDS as AirKind[]) {
    const n = counts.get(kind) ?? 0;
    if (n > bestCount) {
      best = kind;
      bestCount = n;
    }
  }
  return best;
}

// One plan tick: enabled + active sections (id-sorted) first, then auto zones
// gated by stand-down. Order is the funding order (budget is spent front to
// back), so sections starve later auto zones, never the globe. Auto zones are
// cost-1 by construction (their box stays <= 2.5 deg half-side).
export function buildPollPlan(input: PollPlanInput): PolledZone[] {
  const plan: PolledZone[] = [];

  const active = input.sections
    .filter((s) => s.enabled && sectionActivity(s, input.members).active)
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

  for (const s of active) {
    const [[minLat, minLon], [maxLat, maxLon]] = s.b;
    const wDeg = maxLon - minLon;
    const hDeg = maxLat - minLat;
    const matching = matchingMembers(s, input.members);
    plan.push({
      id: s.id,
      box: {
        center: { lat: (minLat + maxLat) / 2, lon: (minLon + maxLon) / 2 },
        halfW: wDeg / 2,
        halfH: hDeg / 2,
      },
      cost: statesCallCost(wDeg, hDeg),
      intervalMs: clampBoostMs(s.boostMs),
      source: "section",
      kind: dominantKindAmong(matching) ?? "general",
      count: matching.length,
    });
  }

  const standdownAllows =
    input.standdownAt === 0 || input.boostedSectionCount < input.standdownAt;
  if (input.autoEnabled && standdownAllows) {
    input.autoZones.forEach((z, i) => {
      plan.push({
        id: `auto:${i}`,
        box: { center: z.center, halfW: z.halfW, halfH: z.halfH },
        cost: 1,
        intervalMs: null,
        source: "auto",
        kind: z.dominantKind,
        count: z.count,
      });
    });
  }

  return plan;
}
