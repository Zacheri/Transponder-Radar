// Hot-zone engine + credit scheduler (design 2026-11-22 §A/§B). Pure: no
// I/O, no state outside the ZoneState value the poller carries in its
// closure. All functions are deterministic; `nowMs` is always injected.

import type { AirKind } from "../shared/craft.js";
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

// Broadcast-geometry copy of the live cluster + the hysteresis clock.
// Plain JSON-able object; the poller stores it as-is.
export interface ZoneState {
  box: HotZone | null;
  lastMembersAt: number;
}

const CELL_DEG = 2;
const MAX_HALF_DEG = 2.5; // R1: zone box stays in the 1-credit <=25 sq° tier
const MEMBER_TTL_MS = 5 * 60_000; // R4: expire 5 min after the last member
const COPY_DRIFT_DEG = 0.5; // R4: broadcast copy moves only past this drift

const cellOf = (v: number): number => Math.floor(v / CELL_DEG);
const cellKey = (latCell: number, lonCell: number): string => `${latCell}:${lonCell}`;

// Densest 3x3-cell neighborhood. Tie rule (determinism): when a cell's
// count reaches the running maximum, the LATER-in-input cell wins — ties are
// broken by later input order. The grid never wraps, so lon ±180 cells are
// never neighbors and a straddling pattern competes as two clusters.
function densestCluster(members: ZoneMember[]): ZoneMember[] {
  const counts = new Map<string, number>();
  let bestKey: string | null = null;
  let bestCell: [number, number] = [0, 0];
  let bestCount = 0;
  for (const m of members) {
    const cell: [number, number] = [cellOf(m.lat), cellOf(m.lon)];
    const key = cellKey(cell[0], cell[1]);
    const n = (counts.get(key) ?? 0) + 1;
    counts.set(key, n);
    if (n >= bestCount) {
      bestCount = n;
      bestKey = key;
      bestCell = cell;
    }
  }
  if (!bestKey) return [];
  const hood = new Set<string>();
  for (let dLat = -1; dLat <= 1; dLat++) {
    for (let dLon = -1; dLon <= 1; dLon++) {
      hood.add(cellKey(bestCell[0] + dLat, bestCell[1] + dLon));
    }
  }
  return members.filter((m) => hood.has(cellKey(cellOf(m.lat), cellOf(m.lon))));
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
  // Clamp by shifting the box inward; seam members outside the edge stay in
  // the count (box membership follows the grid neighborhood, not the rect).
  center.lon = Math.min(180 - halfW, Math.max(-180 + halfW, center.lon));
  // Kind ties go to the later input order (same rule as the densest cell).
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

// One hysteresis step (R4): create at >=2 cluster members, sustain (refresh
// the clock) at >=1, expire once no member has been seen for MEMBER_TTL_MS;
// during the grace window the zero-member zone holds its last broadcast copy
// verbatim. With a live box, keep prev geometry when the new centroid drifts
// <= COPY_DRIFT_DEG on BOTH axes — the kept copy still carries the fresh
// count and dominant kind; larger drift on either axis moves the box.
export function planZone(
  members: ZoneMember[],
  nowMs: number,
  prev: ZoneState | null,
): { zone: HotZone | null; state: ZoneState } {
  const cluster = densestCluster(members);
  let box = prev?.box ?? null;
  let lastMembersAt = prev?.lastMembersAt ?? 0;
  if (cluster.length === 0) {
    if (box && nowMs - lastMembersAt > MEMBER_TTL_MS) box = null;
  } else {
    lastMembersAt = nowMs;
    if (cluster.length >= 2 || box) {
      const fresh = geometryFor(cluster);
      if (
        box &&
        Math.abs(fresh.center.lat - box.center.lat) <= COPY_DRIFT_DEG &&
        Math.abs(fresh.center.lon - box.center.lon) <= COPY_DRIFT_DEG
      ) {
        box = { ...box, count: fresh.count, dominantKind: fresh.dominantKind };
      } else {
        box = fresh;
      }
    }
  }
  return { zone: box, state: { box, lastMembersAt } };
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
// alone would exceed the 120 s slider cap).
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
