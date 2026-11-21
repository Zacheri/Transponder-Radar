import { describe, it, expect } from "vitest";
import { buildFeatureCollection } from "../src/data/features.js";
import { buildIconFilter } from "../src/data/filter.js";
import type { Craft, CraftKind } from "../shared/craft.js";
import { KINDS, KIND_FALLBACK_ICON, colorKey } from "../shared/craft.js";

function air(over: Partial<Craft> = {}): Craft {
  return {
    id: "ac4963", domain: "air", kind: "commercial", lat: 40.6, lon: -73.7,
    speed: 486, heading: 90, callsign: "DAL539", altitude: 33000, updatedAt: 0, stale: false, ...over,
  };
}
function sea(over: Partial<Craft> = {}): Craft {
  return {
    id: "368207620", domain: "sea", kind: "cargo", lat: 51.5, lon: -0.1,
    speed: 12.5, heading: 90, shipName: "EXAMPLE", updatedAt: 0, stale: false, ...over,
  };
}

describe("buildFeatureCollection", () => {
  it("emits [lon, lat] points with label + sublabel", () => {
    const fc = buildFeatureCollection([air(), sea()]);
    expect(fc.type).toBe("FeatureCollection");
    expect(fc.features).toHaveLength(2);
    const [a, s] = fc.features;
    expect(a.geometry.coordinates).toEqual([-73.7, 40.6]);
    expect(a.properties.label).toBe("DAL539");
    expect(a.properties.kind).toBe("commercial");
    expect(a.properties.sublabel).toContain("kn");
    expect(a.properties.sublabel).toContain("ft");
    expect(s.geometry.coordinates).toEqual([-0.1, 51.5]);
    expect(s.properties.label).toBe("EXAMPLE");
    expect(s.properties.sublabel).not.toContain("ft"); // sea has no altitude
  });

  it("falls back to id when no callsign/shipName", () => {
    const fc = buildFeatureCollection([air({ callsign: undefined }), sea({ shipName: undefined })]);
    expect(fc.features[0].properties.label).toBe("ac4963");
    expect(fc.features[1].properties.label).toBe("368207620");
  });
});

describe("buildIconFilter", () => {
  it("includes the user kind list and a zoom-based tiny-craft clause", () => {
    const f: any = buildIconFilter(new Set(["commercial", "cargo"]));
    expect(f[0]).toBe("all");
    // user kind membership
    expect(JSON.stringify(f[1])).toContain("commercial");
    expect(JSON.stringify(f[1])).toContain("cargo");
    // zoom clause present
    expect(JSON.stringify(f[2])).toContain("zoom");
  });
});

describe("icon property", () => {
  it("uses the server-set icon when present", () => {
    const fc = buildFeatureCollection([air({ icon: "widebody" }), sea({ icon: "passenger" })]);
    expect(fc.features[0].properties.icon).toBe("widebody");
    expect(fc.features[1].properties.icon).toBe("passenger");
  });

  it("falls back per kind when icon is absent (air → family, sea → kind)", () => {
    const fc = buildFeatureCollection([air(), air({ kind: "business" }), sea({ kind: "sailing" })]);
    expect(fc.features[0].properties.icon).toBe(KIND_FALLBACK_ICON.commercial); // "narrowbody"
    expect(fc.features[1].properties.icon).toBe(KIND_FALLBACK_ICON.business); // "bizjet"
    expect(fc.features[2].properties.icon).toBe("sailing");
  });
});

describe("icon property with iconRegistered (pack loader)", () => {
  it("pack icon registered → passes through", () => {
    const fc = buildFeatureCollection([air({ icon: "rk:C130" })], { iconRegistered: new Set(["rk:C130"]) });
    expect(fc.features[0].properties.icon).toBe("rk:C130");
  });

  it("pack icon not registered → family fallback (Review Focus #4)", () => {
    const fc = buildFeatureCollection([air({ icon: "rk:C130", kind: "military" })], { iconRegistered: new Set() });
    expect(fc.features[0].properties.icon).toBe("fighter");
  });

  it("opt omitted → pack names pass through (back-compat)", () => {
    const fc = buildFeatureCollection([air({ icon: "pw:B737" })]);
    expect(fc.features[0].properties.icon).toBe("pw:B737");
  });

  it("non-pack icons and sea craft unaffected by the opt", () => {
    const fc = buildFeatureCollection(
      [air({ icon: "narrowbody" }), air({ kind: "business", icon: undefined }), sea({ icon: "cargo" })],
      { iconRegistered: new Set() },
    );
    expect(fc.features[0].properties.icon).toBe("narrowbody"); // family name passes
    expect(fc.features[1].properties.icon).toBe("bizjet"); // air kind fallback
    expect(fc.features[2].properties.icon).toBe("cargo"); // sea kind passes
  });
});

describe("icon property with colorFor (per-category color picker)", () => {
  const colorFor = (kind: CraftKind): string => KINDS[kind].color;

  it("keys every icon name by the kind's color (air + sea)", () => {
    const fc = buildFeatureCollection([air(), sea({ kind: "cargo" })], { colorFor });
    expect(fc.features[0].properties.icon).toBe(colorKey("narrowbody", "#ffd500"));
    expect(fc.features[1].properties.icon).toBe(colorKey("cargo", "#ffb74d"));
  });

  it("server-set pack icons are keyed too; registered set is checked by key", () => {
    const key = colorKey("rk:C130", "#ef5350");
    const ok = buildFeatureCollection([air({ icon: "rk:C130", kind: "military" })], { iconRegistered: new Set([key]), colorFor });
    expect(ok.features[0].properties.icon).toBe(key);
    const miss = buildFeatureCollection([air({ icon: "rk:C130", kind: "military" })], { iconRegistered: new Set(), colorFor });
    expect(miss.features[0].properties.icon).toBe(colorKey("fighter", "#ef5350")); // family fallback, keyed
  });

  it("a user override changes the key without changing the base", () => {
    const custom = (k: CraftKind): string => (k === "commercial" ? "#00ff00" : KINDS[k].color);
    const fc = buildFeatureCollection([air({ icon: "widebody" })], { colorFor: custom });
    expect(fc.features[0].properties.icon).toBe(colorKey("widebody", "#00ff00"));
  });
});
