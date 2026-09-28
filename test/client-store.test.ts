import { describe, it, expect } from "vitest";
import { ClientStore } from "../src/data/store.js";
import { parseRadarMessage } from "../src/data/ws.js";
import type { Craft } from "../shared/craft.js";

function air(id: string): Craft {
  return { id, domain: "air", kind: "commercial", lat: 0, lon: 0, speed: null, heading: null, updatedAt: 0, stale: false };
}

describe("ClientStore", () => {
  it("applies snapshot then updates", () => {
    const s = new ClientStore();
    s.applySnapshot([air("a1"), air("a2")]);
    expect(s.size).toBe(2);
    s.applyUpdate([air("a3")], ["a1"]);
    expect(s.size).toBe(2);
    expect(s.get("a1")).toBeUndefined();
    expect(s.get("a3")).toBeDefined();
  });

  it("notifies subscribers on change, not on no-op", () => {
    const s = new ClientStore();
    let calls = 0;
    s.subscribe(() => calls++);
    s.applyUpdate([], []); // no-op
    expect(calls).toBe(0);
    s.applyUpdate([air("a1")], []);
    expect(calls).toBe(1);
  });
});

describe("parseRadarMessage", () => {
  it("parses snapshot + update", () => {
    expect(parseRadarMessage(JSON.stringify({ type: "snapshot", craft: [air("a1")] }))).toMatchObject({ type: "snapshot" });
    expect(parseRadarMessage(JSON.stringify({ type: "update", upsert: [air("a1")], remove: [] }))).toMatchObject({ type: "update" });
  });
  it("returns null on bad input", () => {
    expect(parseRadarMessage("nope")).toBeNull();
    expect(parseRadarMessage(JSON.stringify({ type: "bogus" }))).toBeNull();
  });
  it("returns null on typed-but-malformed payloads", () => {
    expect(parseRadarMessage(JSON.stringify({ type: "snapshot", craft: {} }))).toBeNull();
    expect(parseRadarMessage(JSON.stringify({ type: "update", upsert: null, remove: [] }))).toBeNull();
    expect(parseRadarMessage(JSON.stringify({ type: "update", upsert: [air("a1")], remove: "a1" }))).toBeNull();
  });
});
