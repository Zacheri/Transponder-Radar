import { describe, it, expect } from "vitest";
import { validateStyleMin } from "@maplibre/maplibre-gl-style-spec";
import type maplibregl from "maplibre-gl";
import {
  TRACK_SOURCES,
  trackLayerDefs,
  setTrailData,
  clearTrailData,
  setPredictedData,
  clearPredicted,
  setDestMarker,
  clearDestMarker,
} from "../src/map/trackLayers.js";
import { CRAFT_SOURCE_ID, CRAFT_TEXT_FONT, craftLayerDefs } from "../src/map/layers.js";
import { buildIconFilter } from "../src/data/filter.js";

// Pure-def + data-builder coverage only: layer registration and line
// rendering need a live map (no WebGL in node) and are browser-verified.

const def = (id: string) => trackLayerDefs().find((l) => l.id === id) as any;

const emptyFcSource = () => ({ type: "geojson", data: { type: "FeatureCollection", features: [] } });

describe("trackLayerDefs", () => {
  it("defines the three track layers in TRACK_SOURCES order, source id === layer id", () => {
    const defs = trackLayerDefs();
    expect(defs.map((l) => l.id)).toEqual([...TRACK_SOURCES]);
    for (const l of defs) expect((l as { source?: unknown }).source).toBe(l.id);
    expect(defs.map((l) => l.type)).toEqual(["line", "line", "symbol"]);
  });

  it("flight-trail paints a solid line in the feature color", () => {
    const paint = def("flight-trail").paint;
    expect(paint["line-color"]).toEqual(["get", "color"]);
    expect(paint["line-width"]).toBe(2);
    expect(paint["line-opacity"]).toBe(0.9);
  });

  it("flight-predicted paints a dashed teal line", () => {
    const paint = def("flight-predicted").paint;
    expect(paint["line-color"]).toBe("#80cbc4");
    expect(paint["line-dasharray"]).toEqual([2, 2]);
    expect(paint["line-width"]).toBe(2);
  });

  it("flight-dest labels the feature name with the shared text font", () => {
    const layer = def("flight-dest");
    expect(layer.layout["text-field"]).toEqual(["get", "name"]);
    expect(layer.layout["text-font"]).toEqual([...CRAFT_TEXT_FONT]);
    expect(layer.layout["text-offset"]).toEqual([0, 1]);
    expect(layer.paint["text-color"]).toBe("#e0e0e0");
  });
});

describe("track layers style validation", () => {
  const trackSources = Object.fromEntries(TRACK_SOURCES.map((id) => [id, emptyFcSource()]));

  it("track sources + layers validate on a glyphs-bearing style", () => {
    const style = {
      version: 8,
      glyphs: "https://tiles.openfreemap.org/fonts/{fontstack}/{range}.pbf",
      sources: {
        basemap: { type: "raster", tiles: ["https://tiles.example/{z}/{x}/{y}.png"] },
        ...trackSources,
      },
      layers: [
        { id: "basemap", type: "raster", source: "basemap" },
        ...trackLayerDefs(),
      ],
    };
    expect(validateStyleMin(style as any)).toEqual([]);
  });

  it("track layers validate alongside the craft layers", () => {
    const style = {
      version: 8,
      glyphs: "https://tiles.openfreemap.org/fonts/{fontstack}/{range}.pbf",
      sources: {
        basemap: { type: "raster", tiles: ["https://tiles.example/{z}/{x}/{y}.png"] },
        [CRAFT_SOURCE_ID]: emptyFcSource(),
        ...trackSources,
      },
      layers: [
        { id: "basemap", type: "raster", source: "basemap" },
        ...trackLayerDefs(),
        ...craftLayerDefs(buildIconFilter(new Set())),
      ],
    };
    expect(validateStyleMin(style as any)).toEqual([]);
  });
});

// The setters only touch getSource(id).setData; a stub captures the writes.
function mockMap() {
  const written: Record<string, any> = {};
  const map = {
    getSource: (id: string) => ({ setData: (d: any) => (written[id] = d) }),
  } as unknown as maplibregl.Map;
  return { map, written };
}

describe("setTrailData / clearTrailData", () => {
  it("writes a single LineString feature carrying the color property", () => {
    const { map, written } = mockMap();
    setTrailData(map, [{ lat: 1, lon: 2 }, { lat: 3, lon: 4 }], "#4fc3f7");
    const fc = written["flight-trail"];
    expect(fc.features).toHaveLength(1);
    expect(fc.features[0].properties).toEqual({ color: "#4fc3f7" });
    expect(fc.features[0].geometry.coordinates).toEqual([[2, 1], [4, 3]]);
  });

  it("passes unwrapped longitudes (|lon| > 180) through untouched", () => {
    const { map, written } = mockMap();
    setTrailData(map, [{ lat: 52, lon: 185 }, { lat: 55, lon: 190 }], "#fff");
    expect(written["flight-trail"].features[0].geometry.coordinates).toEqual([[185, 52], [190, 55]]);
  });

  it("fewer than two points or clearing writes an empty collection", () => {
    const { map, written } = mockMap();
    setTrailData(map, [{ lat: 1, lon: 2 }], "#fff");
    expect(written["flight-trail"].features).toEqual([]);
    setTrailData(map, [], "#fff");
    expect(written["flight-trail"].features).toEqual([]);
    clearTrailData(map);
    expect(written["flight-trail"]).toEqual({ type: "FeatureCollection", features: [] });
  });
});

describe("setPredictedData / clearPredicted", () => {
  it("writes a LineString, unwrapped longitudes untouched; null or clearing empties it", () => {
    const { map, written } = mockMap();
    setPredictedData(map, [{ lat: 52, lon: 185 }, { lat: 55, lon: 190 }]);
    const fc = written["flight-predicted"];
    expect(fc.features[0].geometry.type).toBe("LineString");
    expect(fc.features[0].geometry.coordinates).toEqual([[185, 52], [190, 55]]);
    setPredictedData(map, null);
    expect(written["flight-predicted"].features).toEqual([]);
    clearPredicted(map);
    expect(written["flight-predicted"].features).toEqual([]);
  });
});

describe("setDestMarker / clearDestMarker", () => {
  it("writes a labeled point; null or clearing empties it", () => {
    const { map, written } = mockMap();
    setDestMarker(map, { name: "HND", lat: 35.55, lon: 139.78 });
    const fc = written["flight-dest"];
    expect(fc.features).toHaveLength(1);
    expect(fc.features[0].geometry).toEqual({ type: "Point", coordinates: [139.78, 35.55] });
    expect(fc.features[0].properties).toEqual({ name: "HND" });
    setDestMarker(map, null);
    expect(written["flight-dest"].features).toEqual([]);
    clearDestMarker(map);
    expect(written["flight-dest"].features).toEqual([]);
  });
});
