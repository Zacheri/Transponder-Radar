import { describe, it, expect } from "vitest";
import { CraftStore } from "../server/store.js";
import type { Craft } from "../shared/craft.js";

function air(id: string, updatedAt: number): Craft {
  return { id, domain: "air", kind: "commercial", lat: 0, lon: 0, speed: null, heading: null, updatedAt, stale: false };
}
function sea(id: string, updatedAt: number): Craft {
  return { id, domain: "sea", kind: "cargo", lat: 0, lon: 0, speed: null, heading: null, updatedAt, stale: false };
}

describe("CraftStore", () => {
  it("upserts single + array, tracks size", () => {
    const s = new CraftStore();
    s.upsert(air("a1", 1000), 1000);
    s.upsert([sea("b1", 1000), air("a2", 1000)], 1000);
    expect(s.size).toBe(3);
    expect(s.get("a1")!.kind).toBe("commercial");
  });

  it("drainDirty returns upsert + remove, then empties", () => {
    const s = new CraftStore();
    s.upsert(air("a1", 1000), 1000);
    s.upsert(sea("b1", 1000), 1000);
    s.remove("a1");
    let d = s.drainDirty();
    expect(d.upsert.map((c) => c.id)).toEqual(["b1"]);
    expect(d.remove).toEqual(["a1"]);
    d = s.drainDirty();
    expect(d.upsert).toEqual([]);
    expect(d.remove).toEqual([]);
  });

  it("sweep marks stale, then removes", () => {
    const s = new CraftStore();
    s.upsert(air("a1", 0), 0);
    s.sweep(130000, 120000, 600000);
    expect(s.get("a1")!.stale).toBe(true);
    const removed = s.sweep(601000, 120000, 600000);
    expect(removed).toContain("a1");
    expect(s.size).toBe(0);
  });

  it("pruneAir removes air absent from snapshot after grace, keeps present", () => {
    const s = new CraftStore();
    s.upsert(air("a1", 0), 0);
    s.upsert(air("a2", 0), 0);
    expect(s.pruneAir(new Set(["a1"]), 1000, 30000)).toEqual([]); // grace not elapsed
    const removed = s.pruneAir(new Set(["a1"]), 31000, 30000);
    expect(removed).toContain("a2");
    expect(s.get("a1")).toBeDefined();
    expect(s.get("a2")).toBeUndefined();
  });

  it("pruneAir never touches sea craft", () => {
    const s = new CraftStore();
    s.upsert(sea("b1", 0), 0);
    expect(s.pruneAir(new Set(), 100000, 30000)).toEqual([]);
    expect(s.get("b1")).toBeDefined();
  });
});
