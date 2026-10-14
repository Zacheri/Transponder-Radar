import { describe, it, expect } from "vitest";
import { KIND_FALLBACK_ICON, PACK_NAME_PREFIXES, isPackIconName } from "../shared/craft.js";

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
