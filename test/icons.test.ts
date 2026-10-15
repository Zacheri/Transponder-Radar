import { describe, it, test, expect } from "vitest";
import { ICON_URLS, ICON_NAMES } from "../src/map/icon-urls.js";
import { SEA_KINDS, KINDS, KIND_FALLBACK_ICON } from "../shared/craft.js";
import { resolveAirIcon, AIR_FAMILY_ICONS } from "../server/icons.js";

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

  it("KINDS air icons equal their KIND_FALLBACK_ICON family", () => {
    for (const k of ["commercial", "business", "military", "general"] as const) {
      expect(KINDS[k].icon, `KINDS[${k}].icon`).toBe(KIND_FALLBACK_ICON[k]);
    }
  });

  it("old air-kind icon names are gone", () => {
    for (const old of ["commercial", "business", "military", "general"]) {
      expect(ICON_NAMES).not.toContain(old);
    }
  });
});

describe("resolver pack emission", () => {
  const pack = new Set(["rk:C130", "rk:H60", "pd:E3", "rk:R135"]);

  test("military token emits pack name when present", () => {
    expect(resolveAirIcon({ kind: "military", callsign: "C130", faaModel: null, faaMfr: null, pack })).toBe("rk:C130");
    expect(resolveAirIcon({ kind: "military", callsign: "UH60A", faaModel: null, faaMfr: null, pack })).toBe("rk:H60");
    expect(resolveAirIcon({ kind: "military", callsign: "E3", faaModel: null, faaMfr: null, pack })).toBe("pd:E3");
  });

  test("pack name absent from set → family fallback (today's behavior)", () => {
    expect(resolveAirIcon({ kind: "military", callsign: "C130", faaModel: null, faaMfr: null, pack: new Set() })).toBe("transport");
    expect(resolveAirIcon({ kind: "military", callsign: "C130", faaModel: null, faaMfr: null })).toBe("transport"); // no pack arg at all
  });

  // civil pack emission is curation-dependent → pinned in Task 6's tests

  test("military without callsign → family fallback (unchanged)", () => {
    expect(resolveAirIcon({ kind: "military", callsign: null, faaModel: null, faaMfr: null, pack })).toBe("fighter");
  });
});
