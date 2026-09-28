import { describe, it, expect } from "vitest";
import { buildFeatureCollection } from "../src/data/features.js";
import { buildIconFilter } from "../src/data/filter.js";
import type { Craft } from "../shared/craft.js";

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
