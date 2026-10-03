import { describe, it, expect } from "vitest";
import { validateStyleMin } from "@maplibre/maplibre-gl-style-spec";
import { cartoStyle } from "../src/map/basemap.js";
import { CRAFT_SOURCE_ID, craftLayerDefs } from "../src/map/layers.js";
import { buildIconFilter } from "../src/data/filter.js";
import { AIR_KINDS, SEA_KINDS } from "../shared/craft.js";

// validateStyleMin is the same validator MapLibre's Map#addLayer runs in the
// browser. These tests catch invalid expressions/filters/properties that
// plain structural tests miss (e.g. the legacy "not" keyword, or text layers
// on a style without a glyphs source).

const withBounds = (layers: any[]) =>
  layers.map((l) => ({ minzoom: 0, maxzoom: 22, ...l }));

const craftSource = { type: "geojson", data: { type: "FeatureCollection", features: [] } };

const ALL_KINDS = new Set([...AIR_KINDS, ...SEA_KINDS]);

describe("full style validation (Carto raster basemap)", () => {
  it("basemap + craft source + craft layers validate with zero errors", () => {
    const carto = cartoStyle("test-key") as any;
    const style = {
      ...carto,
      sources: { ...carto.sources, [CRAFT_SOURCE_ID]: craftSource },
      layers: withBounds([...(carto.layers ?? []), ...craftLayerDefs(buildIconFilter(ALL_KINDS))]),
    };
    expect(validateStyleMin(style as any)).toEqual([]);
  });
});

describe("full style validation (vector basemap with glyphs, OpenFreeMap-shaped)", () => {
  it("craft layers validate on a glyphs-bearing vector style", () => {
    const style = {
      version: 8,
      // Shape of the real OpenFreeMap style (URL asserted in basemap.test.ts).
      glyphs: "https://tiles.openfreemap.org/fonts/{fontstack}/{range}.pbf",
      sources: {
        basemap: { type: "raster", tiles: ["https://tiles.example/{z}/{x}/{y}.png"] },
        [CRAFT_SOURCE_ID]: craftSource,
      },
      layers: withBounds([
        { id: "basemap", type: "raster", source: "basemap" },
        ...craftLayerDefs(buildIconFilter(ALL_KINDS)),
      ]),
    };
    expect(validateStyleMin(style as any)).toEqual([]);
  });
});

describe("full style validation (filter variants)", () => {
  it("empty visible-set filter validates", () => {
    const carto = cartoStyle("test-key") as any;
    const style = {
      ...carto,
      sources: { ...carto.sources, [CRAFT_SOURCE_ID]: craftSource },
      layers: withBounds(craftLayerDefs(buildIconFilter(new Set()))),
    };
    expect(validateStyleMin(style as any)).toEqual([]);
  });
});
