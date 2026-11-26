import { describe, expect, it } from "vitest";
import {
  boxesOverlap,
  planZones,
  surplusCredits,
  zoneIntervalFor,
  type HotZone,
  type ZoneMember,
  type ZonesState,
} from "../server/hotzones.js";
import type { AirKind } from "../shared/craft.js";

const T0 = Date.parse("2026-11-22T12:00:00.000Z"); // 43200 s to UTC midnight
const NOON = T0;
const AT_23 = Date.parse("2026-11-22T23:00:00.000Z"); // 3600 s to midnight
const AT_2359 = Date.parse("2026-11-22T23:59:59.000Z"); // 1 s to midnight
const MIN = 60_000;

const m = (id: string, kind: AirKind, lat: number, lon: number): ZoneMember => ({
  id,
  kind,
  lat,
  lon,
});

const plan = (members: ZoneMember[], nowMs: number = T0, prev: ZonesState | null = null) =>
  planZones(members, nowMs, prev);
const zone = (members: ZoneMember[], nowMs: number = T0, prev: ZonesState | null = null) =>
  plan(members, nowMs, prev).zones[0] ?? null;

// Two non-overlapping pairs used across the two-zone tests (distinct kinds
// and sizes make every assertion unambiguous about which zone is which).
const PAIR_A = () => [m("a1", "general", 40.0, -74.0), m("a2", "general", 40.4, -73.6)];
const TRIO_B = () => [
  m("b1", "military", -40.0, 10.0),
  m("b2", "military", -40.2, 10.2),
  m("b3", "military", -40.4, 10.4),
];

describe("planZones — clustering", () => {
  it("returns no zones and a JSON-able state for empty input", () => {
    const { zones, state } = plan([]);
    expect(zones).toEqual([]);
    expect(JSON.parse(JSON.stringify(state))).toEqual(state);
  });

  it("creates a zone at >=2 members in one cell (centroid +/- covering extents)", () => {
    const z = zone(PAIR_A());
    expect(z).not.toBeNull();
    expect(z!.count).toBe(2);
    expect(z!.center.lat).toBeCloseTo(40.2, 6);
    expect(z!.center.lon).toBeCloseTo(-73.8, 6);
    expect(z!.halfW).toBeCloseTo(0.2, 6);
    expect(z!.halfH).toBeCloseTo(0.2, 6);
    expect(z!.dominantKind).toBe("general");
  });

  it("does not create a zone from a single member", () => {
    expect(zone([m("a", "general", 40.0, -74.0)])).toBeNull();
  });

  it("picks the densest cluster even when the sparser one comes first", () => {
    const members = [
      m("b1", "general", 50.0, 50.0),
      m("b2", "general", 50.2, 50.2),
      m("a1", "military", 10.0, 10.0),
      m("a2", "military", 10.5, 10.5),
      m("a3", "military", 11.9, 11.9),
    ];
    const z = zone(members)!;
    expect(z.count).toBe(3);
    expect(z.center.lat).toBeCloseTo(10.8, 6);
    expect(z.center.lon).toBeCloseTo(10.8, 6);
    expect(z.dominantKind).toBe("military");
  });

  it("breaks densest-cell ties by later input order (deterministic)", () => {
    const a = [m("a1", "general", 10.0, 10.0), m("a2", "general", 10.2, 10.2)];
    const b = [m("b1", "business", 50.0, 50.0), m("b2", "business", 50.2, 50.2)];
    const forwards = plan([...a, ...b]).zones[0];
    const backwards = plan([...b, ...a]).zones[0];
    // The cluster first seen LATER in the input wins the tie either way.
    expect(forwards.center.lat).toBeCloseTo(50.1, 6);
    expect(backwards.center.lat).toBeCloseTo(10.1, 6);
  });

  it("excludes members outside the 3x3 cell neighborhood from cluster and box", () => {
    const z = zone([
      m("a", "general", 40.0, -74.0),
      m("b", "general", 40.1, -73.9),
      m("far", "general", 44.0, -70.0), // 2 cells away on both axes
    ])!;
    expect(z.count).toBe(2);
    expect(z.halfH).toBeLessThanOrEqual(1);
    expect(z.halfW).toBeLessThanOrEqual(1);
  });

  it("includes diagonal-neighbor cell members in the cluster", () => {
    const z = zone([m("a", "general", 40.0, 10.0), m("b", "general", 42.0, 12.0)])!;
    expect(z.count).toBe(2);
    expect(z.center.lat).toBeCloseTo(41.0, 6);
    expect(z.center.lon).toBeCloseTo(11.0, 6);
  });

  it("caps halfW/halfH at 2.5 degrees (R1: box <= 25 sq deg)", () => {
    const z = zone([
      m("s", "general", 40.1, 10.0),
      m("c1", "general", 42.0, 10.0),
      m("c2", "general", 42.1, 10.0),
      m("n", "general", 45.9, 10.0),
    ])!;
    expect(z.count).toBe(4); // cap trims box coverage, never the count
    expect(z.halfH).toBeCloseTo(2.5, 9);
    expect(z.center.lat + z.halfH).toBeLessThan(45.9); // north member dropped from the box
  });

  it("clamps the east edge to +180 without losing cluster members", () => {
    const z = zone([
      m("a", "general", 40.0, 179.9),
      m("b", "general", 40.0, 180.0),
      m("c", "general", 40.0, 180.0),
      m("d", "general", 40.0, 179.5),
    ])!;
    expect(z.count).toBe(4);
    expect(z.center.lon + z.halfW).toBeCloseTo(180, 9);
    expect(z.center.lon).toBeLessThan(179.9); // shifted west by the clamp
  });

  it("clamps the west edge to -180 without losing cluster members", () => {
    const z = zone([
      m("a", "general", 40.0, -179.9),
      m("b", "general", 40.0, -180.0),
      m("c", "general", 40.0, -180.0),
      m("d", "general", 40.0, -179.5),
    ])!;
    expect(z.count).toBe(4);
    expect(z.center.lon - z.halfW).toBeCloseTo(-180, 9);
  });

  it("clamps the north edge to +90 without losing cluster members", () => {
    const z = zone([
      m("a", "general", 89.9, 10.0),
      m("b", "general", 90.0, 10.0),
      m("c", "general", 90.0, 10.0),
      m("d", "general", 89.5, 10.0),
    ])!;
    expect(z.count).toBe(4);
    expect(z.center.lat + z.halfH).toBeCloseTo(90, 9);
    expect(z.center.lat).toBeLessThan(89.9); // shifted south by the clamp
  });

  it("clamps the south edge to -90 without losing cluster members", () => {
    const z = zone([
      m("a", "general", -89.9, 10.0),
      m("b", "general", -90.0, 10.0),
      m("c", "general", -90.0, 10.0),
      m("d", "general", -89.5, 10.0),
    ])!;
    expect(z.count).toBe(4);
    expect(z.center.lat - z.halfH).toBeCloseTo(-90, 9);
  });

  it("leaves polar boxes that already fit inside +/-90 untouched", () => {
    const z = zone([m("a", "general", 85.0, 10.0), m("b", "general", 85.4, 10.0)])!;
    expect(z.center.lat).toBeCloseTo(85.2, 6);
    expect(z.halfH).toBeCloseTo(0.2, 6);
  });

  it("never clusters across the dateline (grid does not wrap)", () => {
    const { zones } = plan([
      m("e", "general", 40.0, 179.9),
      m("w1", "general", 40.0, -179.9),
      m("w2", "general", 40.0, -179.8),
    ]);
    expect(zones).toHaveLength(1); // the lone east craft cannot form a zone
    expect(zones[0].count).toBe(2); // the -180 pair, not a 3-member wrap
    expect(zones[0].center.lon).toBeLessThan(-179);
  });

  it("dominant kind: plurality wins, ties go to the later input order", () => {
    const plurality = zone([
      m("a", "general", 40.0, 10.0),
      m("b", "military", 40.1, 10.0),
      m("c", "military", 40.2, 10.0),
    ])!;
    expect(plurality.dominantKind).toBe("military");
    const tie = zone([m("a", "commercial", 40.0, 10.0), m("b", "military", 40.1, 10.0)])!;
    expect(tie.dominantKind).toBe("military"); // later input wins the tie
  });
});

describe("planZones — two zones", () => {
  it("returns two disjoint clusters ordered densest first, whatever the input order", () => {
    const { zones } = plan([...PAIR_A(), ...TRIO_B()]);
    expect(zones).toHaveLength(2);
    expect(zones[0].count).toBe(3); // the trio, although it came second
    expect(zones[0].dominantKind).toBe("military");
    expect(zones[1].count).toBe(2);
    expect(boxesOverlap(zones[0], zones[1])).toBe(false);
  });

  it("skips the candidate that overlaps the first and takes the next-densest", () => {
    // Two dense cells two rows apart: the cell-22 cluster covers {42.0, 42.1,
    // 44.0, 44.1, 44.2}; the cell-21 cluster is the SAME member set (cell 20
    // is empty), so its box overlaps and it is skipped — the far pair wins.
    const members = [
      m("c1", "general", -40.0, 10.0),
      m("c2", "general", -40.2, 10.0),
      m("n1", "military", 42.0, 10.0),
      m("n2", "military", 42.1, 10.0),
      m("d1", "military", 44.0, 10.0),
      m("d2", "military", 44.1, 10.0),
      m("d3", "military", 44.2, 10.0),
    ];
    const { zones } = plan(members);
    expect(zones).toHaveLength(2);
    expect(zones[0].count).toBe(5);
    expect(zones[1].count).toBe(2); // the far pair, not the overlapping cluster
    expect(zones[1].center.lat).toBeCloseTo(-40.1, 6);
  });

  it("single cluster yields exactly one zone even with the second slot free", () => {
    const { zones } = plan([...TRIO_B(), m("stray", "general", 60.0, 60.0)]);
    expect(zones).toHaveLength(1); // a 1-member cluster never forms a zone
    expect(zones[0].count).toBe(3);
  });

  it("expiry is per-slot: one zone expires while the other keeps its clock", () => {
    const first = plan([...PAIR_A(), ...TRIO_B()]);
    expect(first.zones).toHaveLength(2);
    // A (slot 1) vanishes; B keeps ticking. A holds its stale copy verbatim.
    const held = plan(TRIO_B(), T0 + MIN, first.state);
    expect(held.zones).toHaveLength(2);
    expect(held.zones[1].count).toBe(2); // held copy: stale geometry AND count
    expect(held.zones[1].center).toEqual(first.zones[1].center);
    // B's live copy is fresh on its own slot, unmoved (drift 0 keeps geometry).
    expect(held.zones[0].center).toEqual(first.zones[0].center);
    // Past A's own 5-min clock: only A expires; B is untouched.
    const expired = plan(TRIO_B(), T0 + 5 * MIN + 1, first.state);
    expect(expired.zones).toHaveLength(1);
    expect(expired.zones[0].count).toBe(3);
  });

  it("a second zone joins a live first zone without moving or resetting it", () => {
    const first = plan(TRIO_B());
    const both = plan([...TRIO_B(), ...PAIR_A()], T0 + MIN, first.state);
    expect(both.zones).toHaveLength(2);
    expect(both.zones[0].center).toEqual(first.zones[0].center); // slot kept, copy kept
    expect(both.zones[0].count).toBe(3); // fresh count rides the kept geometry
    expect(both.zones[1].count).toBe(2);
  });
});

describe("planZones — hysteresis", () => {
  const create = () => plan([m("a", "general", 40.0, -74.0), m("b", "general", 40.0, -73.9)]);

  it("sustains on a single member, refreshing lastMembersAt", () => {
    const { state } = create();
    const next = plan([m("a", "general", 40.0, -74.0)], T0 + MIN, state);
    expect(next.zones[0]).not.toBeNull();
    expect(next.zones[0].count).toBe(1);
    expect(next.state.slots[0].lastMembersAt).toBe(T0 + MIN);
  });

  it("holds a zero-member zone through the grace window, unchanged", () => {
    const first = create();
    const next = plan([], T0 + MIN, first.state);
    expect(next.zones[0]).toEqual(first.zones[0]); // stale copy: geometry AND count
    expect(next.state.slots[0].lastMembersAt).toBe(T0); // zero members never refresh
  });

  it("expires only past lastMembersAt + 5 minutes", () => {
    const { state } = create();
    const atEdge = plan([], T0 + 5 * MIN, state);
    expect(atEdge.zones).toHaveLength(1);
    const past = plan([], T0 + 5 * MIN + 1, state);
    expect(past.zones).toHaveLength(0);
    expect(past.state.slots[0].box).toBeNull();
  });

  it("single-member sightings refresh the clock and postpone expiry", () => {
    const { state } = create();
    const mid = plan([m("a", "general", 40.0, -74.0)], T0 + 4 * MIN, state);
    const stillAlive = plan([], T0 + 8 * MIN, mid.state); // 4 min since refresh
    expect(stillAlive.zones).toHaveLength(1);
    const dead = plan([], T0 + 9 * MIN + 1, mid.state); // 5 min + 1 ms
    expect(dead.zones).toHaveLength(0);
  });

  it("re-creates a fresh zone after expiry (create rule reapplies)", () => {
    const { state } = create();
    const expired = plan([], T0 + 6 * MIN, state);
    expect(expired.zones).toHaveLength(0);
    const single = plan([m("a", "general", 40.0, -74.0)], T0 + 7 * MIN, expired.state);
    expect(single.zones).toHaveLength(0); // 1 member cannot recreate a zone
    const pair = plan([m("a", "general", 10.0, 10.0), m("b", "general", 10.1, 10.1)], T0 + 8 * MIN, single.state);
    expect(pair.zones).toHaveLength(1);
    expect(pair.zones[0].count).toBe(2);
  });
});

describe("planZones — broadcast-copy hysteresis", () => {
  const initial = () => plan([m("a", "general", 40.0, -74.0), m("b", "general", 40.0, -73.9)]);

  it("keeps the prev geometry under 0.5 deg drift on both axes, with fresh count and kind", () => {
    const { state, zones } = initial();
    const moved = plan([m("c", "military", 40.4, -73.9)], T0 + MIN, state);
    expect(moved.zones[0].center).toEqual(zones[0].center); // geometry copied verbatim
    expect(moved.zones[0].halfW).toBe(zones[0].halfW);
    expect(moved.zones[0].count).toBe(1); // count is fresh
    expect(moved.zones[0].dominantKind).toBe("military"); // kind is fresh
  });

  it("moves the box when drift exceeds 0.5 deg on either axis", () => {
    const { state } = initial();
    const latDrift = plan([m("c", "general", 40.6, -73.9)], T0 + MIN, state);
    expect(latDrift.zones[0].center.lat).toBeCloseTo(40.6, 6);
    expect(latDrift.zones[0].halfH).toBeCloseTo(0, 9);
    const { state: s2 } = initial();
    const lonDrift = plan([m("c", "general", 40.0, -73.2)], T0 + MIN, s2);
    expect(lonDrift.zones[0].center.lon).toBeCloseTo(-73.2, 6);
  });

  it("keeps the copied geometry when drift is 0.5 deg on one axis and small on the other", () => {
    const { state, zones } = initial();
    const edge = plan([m("c", "general", 40.5, -73.9)], T0 + MIN, state); // exactly 0.5 lat
    expect(edge.zones[0].center).toEqual(zones[0].center);
  });
});

describe("planZones — purity", () => {
  it("never mutates prev state", () => {
    const first = plan([m("a", "general", 40.0, -74.0), m("b", "general", 40.0, -73.9)]);
    const before = JSON.parse(JSON.stringify(first.state));
    plan([m("c", "military", 40.6, -73.8), m("d", "military", 40.7, -73.7)], T0 + MIN, first.state);
    expect(first.state).toEqual(before);
  });

  it("is deterministic: same inputs give deep-equal outputs", () => {
    const members = [m("a", "general", 40.0, -74.0), m("b", "military", 40.4, -73.6)];
    const one = plan(members);
    const two = plan(members);
    expect(two).toEqual(one);
  });
});

describe("boxesOverlap", () => {
  const box = (lat: number, lon: number, half = 1): HotZone => ({
    center: { lat, lon },
    halfW: half,
    halfH: half,
    count: 2,
    dominantKind: "general",
  });

  it("is strict: touching edges do not count as overlap", () => {
    expect(boxesOverlap(box(0, 0), box(0, 2))).toBe(false); // touching at lon 1
    expect(boxesOverlap(box(0, 0), box(0, 1.9))).toBe(true);
    expect(boxesOverlap(box(0, 0), box(2, 2))).toBe(false); // corner touch
    expect(boxesOverlap(box(0, 0), box(0, 0))).toBe(true);
  });
});

describe("surplusCredits", () => {
  it("returns 0 for null or NaN remaining (no header seen)", () => {
    expect(surplusCredits(null, NOON, 90000, 4)).toBe(0);
    expect(surplusCredits(NaN, NOON, 90000, 4)).toBe(0);
  });

  it("returns 0 at or below the reserve (43200 s left: 480 polls x 4 + 100 = 2020)", () => {
    expect(surplusCredits(2019, NOON, 90000, 4)).toBe(0);
    expect(surplusCredits(2020, NOON, 90000, 4)).toBe(0);
    expect(surplusCredits(2120, NOON, 90000, 4)).toBe(100);
  });

  it("tracks the live globePollMs and per-call cost", () => {
    // 900 s polls: ceil(43200000/900000) = 48 due polls -> 48*4 + 100 = 292
    expect(surplusCredits(2500, NOON, 900000, 4)).toBe(2208);
    // 1-credit cost at 90 s polls -> 480 + 100 = 580
    expect(surplusCredits(1000, NOON, 90000, 1)).toBe(420);
  });

  it("reserves at least one due poll at the midnight boundary", () => {
    // 23:59:59 -> 1 s left -> ceil(1000/90000) = 1 due poll -> 4 + 100 = 104
    expect(surplusCredits(204, AT_2359, 90000, 4)).toBe(100);
    expect(surplusCredits(104, AT_2359, 90000, 4)).toBe(0);
  });
});

describe("zoneIntervalFor", () => {
  it("pauses below 1 credit of surplus", () => {
    expect(zoneIntervalFor(30000, 0, NOON)).toBeNull();
    expect(zoneIntervalFor(30000, 0.5, NOON)).toBeNull();
    expect(zoneIntervalFor(30000, NaN, NOON)).toBeNull();
  });

  it("keeps the requested interval when surplus covers it", () => {
    // 43200 s left, surplus 4000 -> ceil(43200000/4000) = 10800 ms < 30000
    expect(zoneIntervalFor(30000, 4000, NOON)).toBe(30000);
  });

  it("stretches to fit the surplus (3600 s left, surplus 100 -> 36000 ms)", () => {
    expect(zoneIntervalFor(10000, 100, AT_23)).toBe(36000);
    expect(zoneIntervalFor(60000, 100, AT_23)).toBe(60000); // requested already slower
  });

  it("draws the stretch/pause line exactly at the 120000 ms floor", () => {
    expect(zoneIntervalFor(10000, 30, AT_23)).toBe(120000); // ceil(3600000/30) = 120000
    expect(zoneIntervalFor(10000, 29, AT_23)).toBeNull(); // ceil(3600000/29) = 124138
  });

  it("computes from UTC midnight regardless of the instant", () => {
    // 1 s left, surplus 1 -> stretched 1000 ms, requested wins
    expect(zoneIntervalFor(30000, 1, AT_2359)).toBe(30000);
  });
});
