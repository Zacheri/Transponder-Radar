import { describe, it, expect } from "vitest";
import { ICON_URLS, ICON_NAMES } from "../src/map/icon-urls.js";
import { SEA_KINDS, KINDS, KIND_FALLBACK_ICON } from "../shared/craft.js";
import { AIR_FAMILY_ICONS } from "../server/icons.js";

describe("icon registry", () => {
  it("has exactly one icon per air family (13) + sea kind (10) = 23", () => {
    expect(ICON_NAMES).toHaveLength(23);
    for (const name of [...AIR_FAMILY_ICONS, ...SEA_KINDS]) {
      expect(ICON_NAMES, `missing icon for ${name}`).toContain(name);
      expect(typeof ICON_URLS[name], `url for ${name}`).toBe("string");
      expect(ICON_URLS[name].length, `url for ${name}`).toBeGreaterThan(0);
    }
  });

  it("no image-name collision between air families and sea kinds", () => {
    const sea = new Set<string>(SEA_KINDS);
    for (const fam of AIR_FAMILY_ICONS) {
      expect(sea.has(fam), `${fam} collides with a sea kind`).toBe(false);
    }
  });

  it("every KIND_FALLBACK_ICON value is a registered image", () => {
    for (const v of Object.values(KIND_FALLBACK_ICON)) {
      expect(ICON_NAMES, `fallback ${v} not registered`).toContain(v);
    }
  });

  it("every KINDS[k].icon is a registered image (air entries use fallback families)", () => {
    for (const k of Object.keys(KINDS) as (keyof typeof KINDS)[]) {
      expect(ICON_NAMES, `KINDS[${k}].icon not registered`).toContain(KINDS[k].icon);
    }
  });

  it("old air-kind icon names are gone", () => {
    for (const old of ["commercial", "business", "military", "general"]) {
      expect(ICON_NAMES).not.toContain(old);
    }
  });
});
