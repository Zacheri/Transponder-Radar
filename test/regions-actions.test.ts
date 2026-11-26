import { describe, expect, it } from "vitest";
import { bootRegions, commitRegion, dropRegion } from "../src/data/regions-actions.js";
import { serializeRegions, type Region, type RegionBox } from "../src/data/regions.js";

// radar.regions is the spec-level contract (spec 2026-11-26 §B), so the
// storage fake is asserted through the literal key.

const KEY = "radar.regions";

function fakeStorage(initial: Record<string, string> = {}) {
  const data = new Map(Object.entries(initial));
  return {
    data,
    getItem: (k: string) => data.get(k) ?? null,
    setItem: (k: string, v: string): void => {
      data.set(k, v);
    },
    removeItem: (k: string): void => {
      data.delete(k);
    },
  };
}

const thrower = {
  getItem: (): string => {
    throw new Error("storage blocked");
  },
  setItem: (): void => {
    throw new Error("storage blocked");
  },
  removeItem: (): void => {},
};

const RECT: RegionBox = [
  [10, 100],
  [17, 112],
];

describe("bootRegions", () => {
  it("reads back a persisted list", () => {
    const list: Region[] = [{ id: "a", kind: "adsb", b: RECT }];
    expect(bootRegions(fakeStorage({ [KEY]: serializeRegions(list) }))).toEqual(list);
  });

  it("absent, corrupt and throwing storage all yield []", () => {
    expect(bootRegions(fakeStorage())).toEqual([]);
    expect(bootRegions(fakeStorage({ [KEY]: "]oops[" }))).toEqual([]);
    expect(bootRegions(thrower)).toEqual([]);
  });
});

describe("commitRegion", () => {
  it("appends, persists the new list, and reports the region", () => {
    const st = fakeStorage();
    const res = commitRegion([], "ais", RECT, st);
    expect(res.region).not.toBeNull();
    expect(res.region?.kind).toBe("ais");
    expect(res.region?.b).toEqual(RECT);
    expect(res.list).toHaveLength(1);
    expect(JSON.parse(st.data.get(KEY) ?? "[]")).toEqual(res.list);
  });

  it("keeps existing regions, new one appended", () => {
    const st = fakeStorage();
    const first = commitRegion([], "adsb", RECT, st).list;
    const res = commitRegion(first, "ais", [
      [0, 0],
      [1, 1],
    ], st);
    expect(res.list.map((r) => r.kind)).toEqual(["adsb", "ais"]);
  });

  it("a rejected rect returns the SAME list and writes nothing", () => {
    const st = fakeStorage();
    const state: Region[] = [{ id: "a", kind: "adsb", b: RECT }];
    const rejects: RegionBox[] = [
      [
        [80, 0],
        [95, 5],
      ], // off-globe lat
      [
        [0, 0],
        [0, 0],
      ], // degenerate
      [
        [NaN, 0],
        [1, 1],
      ], // non-finite
    ];
    for (const rect of rejects) {
      const res = commitRegion(state, "adsb", rect, st);
      expect(res.region).toBeNull();
      expect(res.list).toBe(state);
    }
    expect(st.data.has(KEY)).toBe(false);
  });

  it("a throwing storage still commits to memory", () => {
    const res = commitRegion([], "adsb", RECT, thrower);
    expect(res.list).toHaveLength(1);
    expect(res.region).not.toBeNull();
  });
});

describe("dropRegion", () => {
  const state: Region[] = [
    { id: "a", kind: "adsb", b: RECT },
    { id: "b", kind: "ais", b: [[0, 0], [2, 2]] },
  ];

  it("removes the id and persists the remainder", () => {
    const st = fakeStorage();
    const next = dropRegion(state, "a", st);
    expect(next.map((r) => r.id)).toEqual(["b"]);
    expect(JSON.parse(st.data.get(KEY) ?? "[]")).toEqual(next);
  });

  it("an unknown id changes nothing and writes nothing", () => {
    const st = fakeStorage();
    expect(dropRegion(state, "zzz", st).map((r) => r.id)).toEqual(["a", "b"]);
    expect(st.data.has(KEY)).toBe(false);
  });

  it("a throwing storage still returns the reduced list", () => {
    expect(dropRegion(state, "b", thrower).map((r) => r.id)).toEqual(["a"]);
  });
});
