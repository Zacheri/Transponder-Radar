import { describe, expect, it } from "vitest";
import {
  planZone,
  surplusCredits,
  zoneIntervalFor,
  type ZoneMember,
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

describe("planZone — clustering", () => {
  it("returns null zone and JSON-able state for empty input", () => {
    const { zone, state } = planZone([], T0, null);
    expect(zone).toBeNull();
    expect(JSON.parse(JSON.stringify(state))).toEqual(state);
  });

  it("creates a zone at >=2 members in one cell (centroid +/- covering extents)", () => {
    const { zone } = planZone([m("a", "general", 40.0, -74.0), m("b", "general", 40.4, -73.6)], T0, null);
    expect(zone).not.toBeNull();
    expect(zone!.count).toBe(2);
    expect(zone!.center.lat).toBeCloseTo(40.2, 6);
    expect(zone!.center.lon).toBeCloseTo(-73.8, 6);
    expect(zone!.halfW).toBeCloseTo(0.2, 6);
    expect(zone!.halfH).toBeCloseTo(0.2, 6);
    expect(zone!.dominantKind).toBe("general");
  });

  it("does not create a zone from a single member", () => {
    const { zone } = planZone([m("a", "general", 40.0, -74.0)], T0, null);
    expect(zone).toBeNull();
  });

  it("picks the densest cluster even when the sparser one comes first", () => {
    const members = [
      m("b1", "general", 50.0, 50.0),
      m("b2", "general", 50.2, 50.2),
      m("a1", "military", 10.0, 10.0),
      m("a2", "military", 10.5, 10.5),
      m("a3", "military", 11.9, 11.9),
    ];
    const { zone } = planZone(members, T0, null);
    expect(zone!.count).toBe(3);
    expect(zone!.center.lat).toBeCloseTo(10.8, 6);
    expect(zone!.center.lon).toBeCloseTo(10.8, 6);
    expect(zone!.dominantKind).toBe("military");
  });

  it("breaks densest-cell ties by later input order (deterministic)", () => {
    const a = [m("a1", "general", 10.0, 10.0), m("a2", "general", 10.2, 10.2)];
    const b = [m("b1", "business", 50.0, 50.0), m("b2", "business", 50.2, 50.2)];
    const forwards = planZone([...a, ...b], T0, null).zone!;
    const backwards = planZone([...b, ...a], T0, null).zone!;
    // The cluster first seen LATER in the input wins the tie either way.
    expect(forwards.center.lat).toBeCloseTo(50.1, 6);
    expect(backwards.center.lat).toBeCloseTo(10.1, 6);
  });

  it("excludes members outside the 3x3 cell neighborhood from cluster and box", () => {
    const { zone } = planZone(
      [
        m("a", "general", 40.0, -74.0),
        m("b", "general", 40.1, -73.9),
        m("far", "general", 44.0, -70.0), // 2 cells away on both axes
      ],
      T0,
      null,
    );
    expect(zone!.count).toBe(2);
    expect(zone!.halfH).toBeLessThanOrEqual(1);
    expect(zone!.halfW).toBeLessThanOrEqual(1);
  });

  it("includes diagonal-neighbor cell members in the cluster", () => {
    const { zone } = planZone([m("a", "general", 40.0, 10.0), m("b", "general", 42.0, 12.0)], T0, null);
    expect(zone!.count).toBe(2);
    expect(zone!.center.lat).toBeCloseTo(41.0, 6);
    expect(zone!.center.lon).toBeCloseTo(11.0, 6);
  });

  it("caps halfW/halfH at 2.5 degrees (R1: box <= 25 sq deg)", () => {
    const { zone } = planZone(
      [
        m("s", "general", 40.1, 10.0),
        m("c1", "general", 42.0, 10.0),
        m("c2", "general", 42.1, 10.0),
        m("n", "general", 45.9, 10.0),
      ],
      T0,
      null,
    );
    expect(zone!.count).toBe(4); // cap trims box coverage, never the count
    expect(zone!.halfH).toBeCloseTo(2.5, 9);
    expect(zone!.center.lat + zone!.halfH).toBeLessThan(45.9); // north member dropped from the box
  });

  it("clamps the east edge to +180 without losing cluster members", () => {
    const { zone } = planZone(
      [
        m("a", "general", 40.0, 179.9),
        m("b", "general", 40.0, 180.0),
        m("c", "general", 40.0, 180.0),
        m("d", "general", 40.0, 179.5),
      ],
      T0,
      null,
    );
    expect(zone!.count).toBe(4);
    expect(zone!.center.lon + zone!.halfW).toBeCloseTo(180, 9);
    expect(zone!.center.lon).toBeLessThan(179.9); // shifted west by the clamp
  });

  it("clamps the west edge to -180 without losing cluster members", () => {
    const { zone } = planZone(
      [
        m("a", "general", 40.0, -179.9),
        m("b", "general", 40.0, -180.0),
        m("c", "general", 40.0, -180.0),
        m("d", "general", 40.0, -179.5),
      ],
      T0,
      null,
    );
    expect(zone!.count).toBe(4);
    expect(zone!.center.lon - zone!.halfW).toBeCloseTo(-180, 9);
  });

  it("never clusters across the dateline (grid does not wrap)", () => {
    const { zone } = planZone(
      [m("e", "general", 40.0, 179.9), m("w1", "general", 40.0, -179.9), m("w2", "general", 40.0, -179.8)],
      T0,
      null,
    );
    expect(zone!.count).toBe(2); // the -180 pair, not a 3-member wrap
    expect(zone!.center.lon).toBeLessThan(-179);
  });

  it("dominant kind: plurality wins, ties go to the later input order", () => {
    const plurality = planZone(
      [
        m("a", "general", 40.0, 10.0),
        m("b", "military", 40.1, 10.0),
        m("c", "military", 40.2, 10.0),
      ],
      T0,
      null,
    ).zone!;
    expect(plurality.dominantKind).toBe("military");
    const tie = planZone([m("a", "commercial", 40.0, 10.0), m("b", "military", 40.1, 10.0)], T0, null).zone!;
    expect(tie.dominantKind).toBe("military"); // later input wins the tie
  });
});

describe("planZone — hysteresis", () => {
  const create = () =>
    planZone([m("a", "general", 40.0, -74.0), m("b", "general", 40.0, -73.9)], T0, null);

  it("sustains on a single member, refreshing lastMembersAt", () => {
    const { state } = create();
    const next = planZone([m("a", "general", 40.0, -74.0)], T0 + MIN, state);
    expect(next.zone).not.toBeNull();
    expect(next.zone!.count).toBe(1);
    expect(next.state.lastMembersAt).toBe(T0 + MIN);
  });

  it("holds a zero-member zone through the grace window, unchanged", () => {
    const first = create();
    const next = planZone([], T0 + MIN, first.state);
    expect(next.zone).toEqual(first.zone); // stale copy: geometry AND count
    expect(next.state.lastMembersAt).toBe(T0); // zero members never refresh
  });

  it("expires only past lastMembersAt + 5 minutes", () => {
    const { state } = create();
    const atEdge = planZone([], T0 + 5 * MIN, state);
    expect(atEdge.zone).not.toBeNull();
    const past = planZone([], T0 + 5 * MIN + 1, state);
    expect(past.zone).toBeNull();
    expect(past.state.box).toBeNull();
  });

  it("single-member sightings refresh the clock and postpone expiry", () => {
    const { state } = create();
    const mid = planZone([m("a", "general", 40.0, -74.0)], T0 + 4 * MIN, state);
    const stillAlive = planZone([], T0 + 8 * MIN, mid.state); // 4 min since refresh
    expect(stillAlive.zone).not.toBeNull();
    const dead = planZone([], T0 + 9 * MIN + 1, mid.state); // 5 min + 1 ms
    expect(dead.zone).toBeNull();
  });

  it("re-creates a fresh zone after expiry (create rule reapplies)", () => {
    const { state } = create();
    const expired = planZone([], T0 + 6 * MIN, state);
    expect(expired.zone).toBeNull();
    const single = planZone([m("a", "general", 40.0, -74.0)], T0 + 7 * MIN, expired.state);
    expect(single.zone).toBeNull(); // 1 member cannot recreate a zone
    const pair = planZone([m("a", "general", 10.0, 10.0), m("b", "general", 10.1, 10.1)], T0 + 8 * MIN, single.state);
    expect(pair.zone).not.toBeNull();
    expect(pair.zone!.count).toBe(2);
  });
});

describe("planZone — broadcast-copy hysteresis", () => {
  const initial = () => planZone([m("a", "general", 40.0, -74.0), m("b", "general", 40.0, -73.9)], T0, null);

  it("keeps the prev geometry under 0.5 deg drift on both axes, with fresh count and kind", () => {
    const { state, zone } = initial();
    const moved = planZone([m("c", "military", 40.4, -73.9)], T0 + MIN, state);
    expect(moved.zone!.center).toEqual(zone!.center); // geometry copied verbatim
    expect(moved.zone!.halfW).toBe(zone!.halfW);
    expect(moved.zone!.count).toBe(1); // count is fresh
    expect(moved.zone!.dominantKind).toBe("military"); // kind is fresh
  });

  it("moves the box when drift exceeds 0.5 deg on either axis", () => {
    const { state } = initial();
    const latDrift = planZone([m("c", "general", 40.6, -73.9)], T0 + MIN, state);
    expect(latDrift.zone!.center.lat).toBeCloseTo(40.6, 6);
    expect(latDrift.zone!.halfH).toBeCloseTo(0, 9);
    const { state: s2 } = initial();
    const lonDrift = planZone([m("c", "general", 40.0, -73.2)], T0 + MIN, s2);
    expect(lonDrift.zone!.center.lon).toBeCloseTo(-73.2, 6);
  });

  it("keeps the copied geometry when drift is 0.5 deg on one axis and small on the other", () => {
    const { state, zone } = initial();
    const edge = planZone([m("c", "general", 40.5, -73.9)], T0 + MIN, state); // exactly 0.5 lat
    expect(edge.zone!.center).toEqual(zone!.center);
  });
});

describe("planZone — purity", () => {
  it("never mutates prev state", () => {
    const first = planZone([m("a", "general", 40.0, -74.0), m("b", "general", 40.0, -73.9)], T0, null);
    const before = JSON.parse(JSON.stringify(first.state));
    planZone([m("c", "military", 40.6, -73.8), m("d", "military", 40.7, -73.7)], T0 + MIN, first.state);
    expect(first.state).toEqual(before);
  });

  it("is deterministic: same inputs give deep-equal outputs", () => {
    const members = [m("a", "general", 40.0, -74.0), m("b", "military", 40.4, -73.6)];
    const one = planZone(members, T0, null);
    const two = planZone(members, T0, null);
    expect(two).toEqual(one);
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
