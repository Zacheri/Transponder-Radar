import { describe, it, expect, beforeEach } from "vitest";
import { SnapshotCache } from "../server/snapshot-cache.js";
import type { Craft } from "../shared/craft.js";

// Minimal valid Craft: only the required Craft fields. `note` marks each
// snapshot so identity/content comparisons are meaningful.
function craft(note: string): Craft {
  return {
    id: note,
    domain: "air",
    kind: "general",
    lat: 0,
    lon: 0,
    speed: null,
    heading: null,
    updatedAt: 0,
    stale: false,
  };
}

const CONTENT = (n: number) => [craft(`c${n}`)];

describe("SnapshotCache", () => {
  let cache: SnapshotCache;

  beforeEach(() => {
    cache = new SnapshotCache({ maxBytes: 1000 });
  });

  // 1. set then get returns the same array content; usedBytes() = sum of rawBytes.
  it("stores and returns snapshot content; usedBytes counts rawBytes", () => {
    cache.set(1, CONTENT(1), 30);
    cache.set(2, CONTENT(2), 20);

    expect(cache.get(1)).toEqual(CONTENT(1));
    expect(cache.get(2)).toEqual(CONTENT(2));
    expect(cache.usedBytes()).toBe(50);
  });

  // 2. LRU order: cap 80; set ts 1(30) 2(30) 3(30) → trim evicts ts 1.
  //    get(2) makes it MRU, then set(4, 30) evicts ts 3, keeps ts 2.
  it("evicts least-recently-used when over cap", () => {
    cache = new SnapshotCache({ maxBytes: 80 });
    cache.set(1, CONTENT(1), 30);
    cache.set(2, CONTENT(2), 30);
    cache.set(3, CONTENT(3), 30); // used 90 > 80 → trim evicts ts 1
    expect(cache.usedBytes()).toBe(60);

    expect(cache.get(1)).toBeUndefined();
    expect(cache.get(3)).toEqual(CONTENT(3));

    cache.get(2); // makes ts 2 MRU (order now 3, 2)
    cache.set(4, CONTENT(4), 30); // used 90 > 80 → trim evicts ts 3
    expect(cache.get(3)).toBeUndefined();
    expect(cache.get(2)).toEqual(CONTENT(2));
    expect(cache.get(4)).toEqual(CONTENT(4));
    expect(cache.usedBytes()).toBe(60);
  });

  // 3. drop(ts) removes the entry; usedBytes drops accordingly.
  it("drop removes an entry and reduces usedBytes", () => {
    cache.set(1, CONTENT(1), 30);
    cache.set(2, CONTENT(2), 30);
    cache.set(3, CONTENT(3), 30);
    expect(cache.usedBytes()).toBe(90);

    cache.drop(2);
    expect(cache.get(2)).toBeUndefined();
    expect(cache.get(1)).toEqual(CONTENT(1));
    expect(cache.get(3)).toEqual(CONTENT(3));
    expect(cache.usedBytes()).toBe(60);
  });

  // 4. resize(50) trims oldest-first to ≤ 50; resize(0) clears AND disables.
  it("resize trims oldest-first; resize(0) clears and disables", () => {
    cache.set(1, CONTENT(1), 30);
    cache.set(2, CONTENT(2), 30);
    cache.set(3, CONTENT(3), 30);
    cache.set(4, CONTENT(4), 30); // used 120

    cache.resize(50); // trim ts 1,2,3 → only ts 4 remains (30 ≤ 50)
    expect(cache.get(1)).toBeUndefined();
    expect(cache.get(2)).toBeUndefined();
    expect(cache.get(3)).toBeUndefined();
    expect(cache.get(4)).toEqual(CONTENT(4));
    expect(cache.usedBytes()).toBe(30);

    cache.resize(0); // clears everything
    expect(cache.get(4)).toBeUndefined();
    expect(cache.usedBytes()).toBe(0);

    cache.set(5, CONTENT(5), 30); // disabled → stores nothing
    expect(cache.get(5)).toBeUndefined();
    expect(cache.usedBytes()).toBe(0);
  });

  // 5. Re-set of an existing ts replaces content without double-counting size.
  it("re-set replaces content without double-counting size", () => {
    cache.set(1, CONTENT(1), 30);
    expect(cache.usedBytes()).toBe(30);

    cache.set(1, CONTENT(11), 40);
    expect(cache.get(1)).toEqual(CONTENT(11));
    expect(cache.usedBytes()).toBe(40);
  });
});
