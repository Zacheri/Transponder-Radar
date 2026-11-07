import { describe, it, expect } from "vitest";
import { KINDS, KIND_FALLBACK_ICON, PACK_NAME_PREFIXES, colorKey, isPackIconName, parseColorKey } from "../shared/craft.js";

describe("kind default colors (color-picker defaults, ruled 2026-11-06)", () => {
  it("commercial yellow, general gray, business/military unchanged, sea = current fills", () => {
    expect(KINDS.commercial.color).toBe("#ffd500");
    expect(KINDS.business.color).toBe("#81d4fa");
    expect(KINDS.military.color).toBe("#ef5350");
    expect(KINDS.general.color).toBe("#90a4ae");
    expect(KINDS.cargo.color).toBe("#ffb74d");
    expect(KINDS.tanker.color).toBe("#ff8a65");
    expect(KINDS.passenger.color).toBe("#4dd0e1");
    expect(KINDS.military_vessel.color).toBe("#e57373");
    expect(KINDS.fishing.color).toBe("#aed581");
    expect(KINDS.sailing.color).toBe("#ba68c8");
    expect(KINDS.pleasure.color).toBe("#f06292");
    expect(KINDS.tug_work.color).toBe("#fff176");
    expect(KINDS.service.color).toBe("#a1887f");
    expect(KINDS.other.color).toBe("#b0bec5");
  });
});

describe("colorKey / parseColorKey", () => {
  it("round-trips a color-keyed name", () => {
    for (const [name, hex] of [
      ["narrowbody", "#ffd500"],
      ["rk:C130", "#ef5350"],
      ["pd:CH47", "#ef5350"],
    ] as const) {
      const key = colorKey(name, hex);
      expect(key).toBe(`${name}@${hex}`);
      expect(parseColorKey(key)).toEqual({ name, hex });
    }
  });

  it("splits on the LAST @ (names may contain @)", () => {
    expect(parseColorKey("a@b@#ff0000")).toEqual({ name: "a@b", hex: "#ff0000" });
  });

  it("plain names have no color", () => {
    expect(parseColorKey("narrowbody")).toEqual({ name: "narrowbody", hex: null });
    expect(parseColorKey("rk:C130")).toEqual({ name: "rk:C130", hex: null });
  });

  it("rejects bad hex", () => {
    for (const bad of ["narrowbody@", "narrowbody@#fff", "narrowbody@#ffgg00", "@#ff0000"]) {
      expect(() => parseColorKey(bad), bad).toThrow();
    }
  });
});

describe("KIND_FALLBACK_ICON", () => {
  it("maps each air kind to its approved fallback family", () => {
    expect(KIND_FALLBACK_ICON).toEqual({
      commercial: "narrowbody",
      business: "bizjet",
      military: "fighter",
      general: "piston",
    });
  });
});

describe("isPackIconName", () => {
  it("matches exactly the documented prefixes", () => {
    for (const p of PACK_NAME_PREFIXES) expect(isPackIconName(p + "X")).toBe(true);
    expect(isPackIconName("pw")).toBe(false);
    expect(isPackIconName("narrowbody")).toBe(false);
    expect(isPackIconName("cargo")).toBe(false);
    expect(isPackIconName("")).toBe(false);
  });
});
