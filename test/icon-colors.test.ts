import { describe, it, expect } from "vitest";
import { effectiveColor, loadIconColors, saveIconColors, setKindColor, type IconColorState, type StorageLike } from "../src/data/icon-colors.js";

function stubStorage(initial: Record<string, string> = {}): StorageLike & { map: Map<string, string> } {
  const map = new Map(Object.entries(initial));
  return {
    map,
    getItem: (k) => map.get(k) ?? null,
    setItem: (k, v) => void map.set(k, v),
    removeItem: (k) => void map.delete(k),
  };
}

describe("loadIconColors", () => {
  it("loads a well-formed state", () => {
    const s = stubStorage({ "radar.iconColors": JSON.stringify({ commercial: "#FFD500", cargo: "#00ff00" }) });
    expect(loadIconColors(s)).toEqual({ commercial: "#ffd500", cargo: "#00ff00" }); // normalized to lowercase
  });

  it("drops unknown kinds and bad hex values", () => {
    const s = stubStorage({
      "radar.iconColors": JSON.stringify({ commercial: "#112233", bogus: "#112233", tanker: "red", fishing: "#112" }),
    });
    expect(loadIconColors(s)).toEqual({ commercial: "#112233" });
  });

  it("returns {} on missing / invalid storage", () => {
    expect(loadIconColors(stubStorage())).toEqual({});
    expect(loadIconColors(stubStorage({ "radar.iconColors": "not json" }))).toEqual({});
    expect(loadIconColors(stubStorage({ "radar.iconColors": JSON.stringify([1, 2]) }))).toEqual({});
  });
});

describe("saveIconColors", () => {
  it("round-trips through storage", () => {
    const s = stubStorage();
    saveIconColors({ commercial: "#ffd500" }, s);
    expect(s.map.get("radar.iconColors")).toBe(JSON.stringify({ commercial: "#ffd500" }));
  });

  it("an empty state removes the key (back to all defaults)", () => {
    const s = stubStorage({ "radar.iconColors": "{}" });
    saveIconColors({}, s);
    expect(s.map.has("radar.iconColors")).toBe(false);
  });
});

describe("effectiveColor", () => {
  it("override wins, default otherwise", () => {
    const state: IconColorState = { commercial: "#00ff00" };
    expect(effectiveColor("commercial", state)).toBe("#00ff00");
    expect(effectiveColor("military", state)).toBe("#ef5350"); // KINDS default
    expect(effectiveColor("general", {})).toBe("#90a4ae");
  });
});

describe("setKindColor", () => {
  it("sets and clears (null) an override without mutating the input", () => {
    const state: IconColorState = {};
    const a = setKindColor(state, "cargo", "#123abc");
    expect(a).toEqual({ cargo: "#123abc" });
    expect(state).toEqual({}); // input untouched
    const b = setKindColor(a, "cargo", null);
    expect(b).toEqual({});
    const c = setKindColor(state, "tug_work", "#FF00AA");
    expect(c).toEqual({ tug_work: "#ff00aa" }); // lowercased
  });

  it("rejects unknown kinds and bad hex", () => {
    expect(() => setKindColor({}, "bogus" as never, "#112233")).toThrow();
    expect(() => setKindColor({}, "cargo", "red")).toThrow();
    expect(() => setKindColor({}, "cargo", "#12345")).toThrow();
  });
});
