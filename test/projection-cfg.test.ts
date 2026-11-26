import { describe, it, expect } from "vitest";
import { loadProjection, saveProjection } from "../src/data/projection-cfg.js";
import type { StorageLike } from "../src/data/icon-colors.js";

function stubStorage(initial: Record<string, string> = {}): StorageLike & { map: Map<string, string> } {
  const map = new Map(Object.entries(initial));
  return {
    map,
    getItem: (k) => map.get(k) ?? null,
    setItem: (k, v) => void map.set(k, v),
    removeItem: (k) => void map.delete(k),
  };
}

function throwingStorage(): StorageLike {
  const boom = () => {
    throw new Error("storage blocked");
  };
  return { getItem: boom, setItem: boom, removeItem: boom };
}

describe("loadProjection", () => {
  it("only a stored 'mercator' is flat; absent/corrupt default to globe", () => {
    expect(loadProjection(stubStorage())).toBe("globe");
    expect(loadProjection(stubStorage({ "radar.projection": "mercator" }))).toBe("mercator");
    for (const raw of ["", "globe", "GLOBE", "flat", "banana", "{}"]) {
      expect(loadProjection(stubStorage({ "radar.projection": raw }))).toBe("globe");
    }
  });
  it("a throwing storage yields the globe default", () => {
    expect(loadProjection(throwingStorage())).toBe("globe");
  });
});

describe("saveProjection", () => {
  it("round-trips both values under radar.projection", () => {
    const s = stubStorage();
    saveProjection("mercator", s);
    expect(s.map.get("radar.projection")).toBe("mercator");
    expect(loadProjection(s)).toBe("mercator");
    saveProjection("globe", s);
    expect(s.map.get("radar.projection")).toBe("globe");
    expect(loadProjection(s)).toBe("globe");
  });
  it("a throwing storage does not throw", () => {
    expect(() => saveProjection("globe", throwingStorage())).not.toThrow();
  });
});
