import { describe, it, expect } from "vitest";
import { ICON_URLS, ICON_NAMES } from "../src/map/icon-urls.js";
import { AIR_KINDS, SEA_KINDS } from "../shared/craft.js";

describe("icon registry", () => {
  it("has exactly one icon per craft kind (14)", () => {
    expect(ICON_NAMES).toHaveLength(14);
    const allKinds = [...AIR_KINDS, ...SEA_KINDS];
    for (const k of allKinds) {
      expect(ICON_NAMES, `missing icon for ${k}`).toContain(k);
      expect(typeof ICON_URLS[k], `url for ${k}`).toBe("string");
      expect(ICON_URLS[k].length).toBeGreaterThan(0);
    }
  });
});
