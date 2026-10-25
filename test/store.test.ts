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
    const drain = () => {
      const a = s.drainDirty("air");
      const b = s.drainDirty("sea");
      return { upsert: [...a.upsert, ...b.upsert], remove: [...a.remove, ...b.remove] };
    };
    let d = drain();
    expect(d.upsert.map((c) => c.id)).toEqual(["b1"]);
    expect(d.remove).toEqual(["a1"]);
    d = drain();
    expect(d.upsert).toEqual([]);
    expect(d.remove).toEqual([]);
  });

  it("drainDirty('air') drains only air upserts and removes", () => {
    const s = new CraftStore();
    const airId = "a1";
    const seaId = "b1";
    const removedAirId = "a2";
    s.upsert(air(airId, 1000), 1000);
    s.upsert(sea(seaId, 1000), 1000);
    s.upsert(air(removedAirId, 1000), 1000);
    s.remove(removedAirId);
    const airDrain = s.drainDirty("air");
    expect(airDrain.upsert.map((c) => c.id)).toEqual([airId]);
    expect(airDrain.remove).toEqual([removedAirId]);
    const seaDrain = s.drainDirty("sea");
    expect(seaDrain.upsert.map((c) => c.id)).toEqual([seaId]);
    expect(seaDrain.remove).toEqual([]);
    expect(s.drainDirty("air")).toEqual({ upsert: [], remove: [] });
  });

  it("sweep/pruneAir removals are drained under the right domain", () => {
    const s = new CraftStore();
    s.upsert(air("a1", 0), 0); // 601s old at sweep → removed by sweep
    s.upsert(air("a2", 500000), 500000); // fresh enough to survive sweep; pruned after grace
    s.upsert(sea("b1", 471000), 471000); // 130s old at sweep → marked stale
    s.drainDirty("air"); // clear the initial dirty upserts
    s.drainDirty("sea");
    const removed = s.sweep(601000, 120000, 600000);
    expect(removed).toEqual(["a1"]);
    expect(s.get("b1")!.stale).toBe(true);
    expect(s.pruneAir(new Set<string>(), 602000, 30000)).toEqual(["a2"]);
    const airDrain = s.drainDirty("air");
    expect(airDrain.remove).toEqual(["a1", "a2"]);
    expect(airDrain.upsert).toEqual([]);
    const seaDrain = s.drainDirty("sea");
    expect(seaDrain.upsert.map((c) => c.id)).toEqual(["b1"]);
    expect(seaDrain.upsert[0].stale).toBe(true);
    expect(seaDrain.remove).toEqual([]);
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
