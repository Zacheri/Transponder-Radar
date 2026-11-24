import { describe, it, expect } from "vitest";
import { loadMotion, saveMotion } from "../src/data/motion-cfg.js";
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

describe("loadMotion", () => {
  it("defaults to on when absent or corrupt (only '0' is off)", () => {
    expect(loadMotion(stubStorage())).toBe(true);
    for (const raw of ["", "1", "true", "yes", "banana"]) {
      expect(loadMotion(stubStorage({ "radar.motion": raw }))).toBe(true);
    }
    expect(loadMotion(stubStorage({ "radar.motion": "0" }))).toBe(false);
  });

  it("a throwing getItem yields the default, not an exception", () => {
    expect(loadMotion(throwingStorage())).toBe(true);
  });
});

describe("saveMotion", () => {
  it("stores '1'/'0' and round-trips through loadMotion", () => {
    const s = stubStorage();
    saveMotion(false, s);
    expect(s.map.get("radar.motion")).toBe("0");
    expect(loadMotion(s)).toBe(false);
    saveMotion(true, s);
    expect(s.map.get("radar.motion")).toBe("1");
    expect(loadMotion(s)).toBe(true);
  });

  it("always stores, including the default true (posture pin: no removeItem-on-default)", () => {
    const s = stubStorage();
    saveMotion(true, s);
    expect(s.map.has("radar.motion")).toBe(true);
  });

  it("a throwing setItem is swallowed", () => {
    expect(() => saveMotion(true, throwingStorage())).not.toThrow();
  });
});
