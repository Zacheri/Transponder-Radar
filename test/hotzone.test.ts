import { describe, it, expect } from "vitest";
import { validateStyleMin } from "@maplibre/maplibre-gl-style-spec";
import {
  HOTZONE_SOURCE,
  HOTZONE_LAYER,
  hotzoneDefs,
  addHotzoneLayer,
  setHotzone,
} from "../src/map/hotzone.js";

// Pure-def + data-builder coverage like track-layers.test.ts; the actual
// rect on the live map is browser-verified (no WebGL in node).

const def = (id: string) => hotzoneDefs().find((l) => l.id === id) as any;

describe("hotzoneDefs", () => {
  it("defines fill then outline, both on the shared source", () => {
    const defs = hotzoneDefs();
    expect(defs.map((l) => l.id)).toEqual([HOTZONE_LAYER, "hotzone-outline"]);
    for (const l of defs) expect((l as { source?: unknown }).source).toBe(HOTZONE_SOURCE);
    expect(defs.map((l) => l.type)).toEqual(["fill", "line"]);
  });

  it("fill paints the feature color at 18% opacity; outline strokes 1px in it", () => {
    expect(def(HOTZONE_LAYER).paint["fill-color"]).toEqual(["get", "color"]);
    expect(def(HOTZONE_LAYER).paint["fill-opacity"]).toBe(0.18);
    expect(def("hotzone-outline").paint["line-color"]).toEqual(["get", "color"]);
    expect(def("hotzone-outline").paint["line-width"]).toBe(1);
  });

  it("validates on a glyphs-bearing style (validateStyleMin)", () => {
    const style = {
      version: 8,
      glyphs: "https://tiles.openfreemap.org/fonts/{fontstack}/{range}.pbf",
      sources: {
        [HOTZONE_SOURCE]: { type: "geojson", data: { type: "FeatureCollection", features: [] } },
      },
      layers: [
        { id: "bg", type: "background", paint: { "background-color": "#000" }, minzoom: 0, maxzoom: 22 },
        ...hotzoneDefs().map((l) => ({ minzoom: 0, maxzoom: 22, ...l })),
      ],
    };
    expect(validateStyleMin(style as never)).toEqual([]);
  });
});

function fakeMap(existingLayers: string[]) {
  const layers = new Set(existingLayers);
  const setDatas: unknown[] = [];
  const added: Array<{ id: string; before?: string }> = [];
  const sources = new Map<string, { setData: (d: unknown) => void }>();
  const map = {
    getLayer: (id: string) => (layers.has(id) ? { id } : undefined),
    getSource: (id: string) => sources.get(id),
    addSource: (id: string, _spec: unknown) => {
      sources.set(id, { setData: (d) => setDatas.push(d) });
    },
    addLayer: (layer: { id: string }, before?: string) => {
      layers.add(layer.id);
      added.push({ id: layer.id, before });
    },
  };
  return { map: map as never, layers, setDatas, added, sources };
}

describe("addHotzoneLayer", () => {
  it("adds the source and inserts both layers below craft-icons", () => {
    const { map, added, sources } = fakeMap(["craft-icons", "craft-labels"]);
    addHotzoneLayer(map);
    expect(added).toEqual([
      { id: HOTZONE_LAYER, before: "craft-icons" },
      { id: "hotzone-outline", before: "craft-icons" },
    ]);
    expect(sources.has(HOTZONE_SOURCE)).toBe(true);
  });

  it("falls back to craft-labels, then to plain append", () => {
    const a = fakeMap(["craft-labels"]);
    addHotzoneLayer(a.map);
    expect(a.added.every((l) => l.before === "craft-labels")).toBe(true);
    const b = fakeMap([]);
    addHotzoneLayer(b.map);
    expect(b.added.every((l) => l.before === undefined)).toBe(true);
  });

  it("is idempotent", () => {
    const { map, added, sources } = fakeMap(["craft-icons"]);
    addHotzoneLayer(map);
    addHotzoneLayer(map);
    expect(added).toHaveLength(2);
    expect(sources.size).toBe(1);
  });
});

describe("setHotzone", () => {
  const zone = { center: { lon: -74, lat: 40 }, halfW: 2.5, halfH: 2, count: 7 };

  it("builds a closed 5-point ring from center ± half, with color and count", () => {
    const { map, setDatas } = fakeMap(["craft-icons"]);
    addHotzoneLayer(map);
    setHotzone(map, zone, "#ef5350");
    expect(setDatas).toHaveLength(1);
    const fc = setDatas[0] as {
      type: string;
      features: { geometry: { type: string; coordinates: [number, number][] }; properties: Record<string, unknown> }[];
    };
    expect(fc.type).toBe("FeatureCollection");
    expect(fc.features).toHaveLength(1);
    const f = fc.features[0];
    expect(f.geometry.type).toBe("Polygon");
    expect(f.geometry.coordinates).toEqual([
      [
        [-76.5, 38],
        [-71.5, 38],
        [-71.5, 42],
        [-76.5, 42],
        [-76.5, 38],
      ],
    ]);
    expect(f.properties.color).toBe("#ef5350");
    expect(f.properties.count).toBe(7);
  });

  it("null clears to an empty FeatureCollection", () => {
    const { map, setDatas } = fakeMap(["craft-icons"]);
    addHotzoneLayer(map);
    setHotzone(map, zone, "#ef5350");
    setHotzone(map, null, "");
    const fc = setDatas[setDatas.length - 1] as { features: unknown[] };
    expect(fc.features).toEqual([]);
  });

  it("is safe before the source exists (no map.load race)", () => {
    const { map } = fakeMap([]);
    expect(() => setHotzone(map, zone, "#fff")).not.toThrow();
  });
});
