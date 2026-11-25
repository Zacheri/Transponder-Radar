import { describe, it, expect } from "vitest";
import {
  TILE_HALF,
  clampCenter,
  boxesFor,
  boxEdges,
  composeTiles,
} from "../server/ais-tiles.js";
import {
  AIS_TILE_SOURCE,
  AIS_TILE_LAYER,
  aisTileDefs,
  addAisTileLayers,
  setAisTileBoxes,
} from "../src/map/aisTiles.js";

describe("clampCenter", () => {
  it("passes through in-range centers", () => {
    expect(clampCenter({ lat: 12.5, lon: -70.25 })).toEqual({ lat: 12.5, lon: -70.25 });
  });

  it("clamps lat so lat±10 stays in [-90, 90]", () => {
    expect(clampCenter({ lat: 89, lon: 0 }).lat).toBe(80);
    expect(clampCenter({ lat: -95, lon: 0 }).lat).toBe(-80);
    expect(clampCenter({ lat: 80, lon: 0 }).lat).toBe(80);
    expect(clampCenter({ lat: -80, lon: 0 }).lat).toBe(-80);
  });

  it("clamps lon so lon±10 stays in [-180, 180]", () => {
    expect(clampCenter({ lat: 0, lon: 175 }).lon).toBe(170);
    expect(clampCenter({ lat: 0, lon: -185 }).lon).toBe(-170);
    expect(clampCenter({ lat: 0, lon: 170 }).lon).toBe(170);
    expect(clampCenter({ lat: 0, lon: -170 }).lon).toBe(-170);
  });
});

describe("boxesFor", () => {
  it("emits [[minLat,minLon],[maxLat,maxLon]] around the center", () => {
    expect(boxesFor({ lat: 0, lon: 0 })).toEqual([
      [-TILE_HALF, -TILE_HALF],
      [TILE_HALF, TILE_HALF],
    ]);
    expect(boxesFor({ lat: 40, lon: -74 })).toEqual([
      [30, -84],
      [50, -64],
    ]);
  });

  it("clamps before boxing so bounds stay valid at the edges", () => {
    expect(boxesFor({ lat: 89, lon: 175 })).toEqual([
      [70, 160],
      [90, 180],
    ]);
    expect(boxesFor({ lat: -95, lon: -185 })).toEqual([
      [-90, -180],
      [-70, -160],
    ]);
  });
});

describe("composeTiles", () => {
  const home = { lat: 40, lon: -74 };
  const follow = { lat: 10, lon: 100 };

  it("returns [home, follow] when both are distinct", () => {
    expect(composeTiles(home, follow)).toEqual([home, follow]);
  });

  it("drops nulls in any position", () => {
    expect(composeTiles(home, null)).toEqual([home]);
    expect(composeTiles(null, follow)).toEqual([follow]);
    expect(composeTiles(null, null)).toEqual([]);
  });

  it("dedups follow when equal to home within 1e-9", () => {
    expect(composeTiles(home, home)).toEqual([home]);
    expect(composeTiles(home, { lat: home.lat + 5e-10, lon: home.lon })).toEqual([home]);
    expect(composeTiles(home, { lat: home.lat, lon: home.lon + 5e-10 })).toEqual([home]);
  });

  it("keeps tiles that differ by more than 1e-9", () => {
    const near = { lat: home.lat + 1e-6, lon: home.lon };
    expect(composeTiles(home, near)).toEqual([home, near]);
    const justOut = { lat: home.lat + 1e-8, lon: home.lon };
    expect(composeTiles(home, justOut)).toEqual([home, justOut]);
  });

  it("caps at 2 tiles", () => {
    expect(composeTiles(home, follow).length).toBeLessThanOrEqual(2);
  });

  it("clamps centers, so clamped duplicates collapse to one tile", () => {
    expect(composeTiles({ lat: 89, lon: 0 }, { lat: 85, lon: 0 })).toEqual([
      { lat: 80, lon: 0 },
    ]);
  });
});

describe("boxEdges", () => {
  it("is the [[minLat,minLon],[maxLat,maxLon]] wire shape of a boxesFor box", () => {
    expect(boxEdges(boxesFor({ lat: 35, lon: 139 }))).toEqual([[25, 129], [45, 149]]);
  });

  it("normalizes flipped corners and copies (no shared refs)", () => {
    const box = [[45, 149], [25, 129]] as [[number, number], [number, number]];
    const edges = boxEdges(box);
    expect(edges).toEqual([[25, 129], [45, 149]]);
    expect(edges[0]).not.toBe(box[0]);
  });
});

// Client outline layer (spec 2026-11-25-traffic-monitor R7a): pure defs +
// data-builder coverage like hotzone.test.ts; the live rectangles are
// browser-verified (no WebGL in node).

const tileDef = (id: string) => aisTileDefs().find((l) => l.id === id) as any;

describe("aisTileDefs", () => {
  it("is one dashed #4fc3f7 line layer on the shared source (no fill)", () => {
    const defs = aisTileDefs();
    expect(defs.map((l) => l.id)).toEqual([AIS_TILE_LAYER]);
    expect(defs.map((l) => l.type)).toEqual(["line"]);
    expect((defs[0] as { source?: unknown }).source).toBe(AIS_TILE_SOURCE);
    const p = tileDef(AIS_TILE_LAYER).paint;
    expect(p["line-color"]).toBe("#4fc3f7"); // kind-independent by design
    expect(p["line-dasharray"]).toEqual([4, 3]);
    expect(p["line-width"]).toBe(1.5);
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

describe("addAisTileLayers", () => {
  it("adds the source and inserts the outline below craft-icons; idempotent", () => {
    const { map, added, sources } = fakeMap(["craft-icons", "craft-labels", "hotzone-outline"]);
    addAisTileLayers(map);
    expect(added).toEqual([{ id: AIS_TILE_LAYER, before: "craft-icons" }]);
    expect(sources.has(AIS_TILE_SOURCE)).toBe(true);
    addAisTileLayers(map);
    expect(added).toHaveLength(1);
    expect(sources.size).toBe(1);
  });

  it("falls back to craft-labels, then to plain append", () => {
    const a = fakeMap(["craft-labels"]);
    addAisTileLayers(a.map);
    expect(a.added.every((l) => l.before === "craft-labels")).toBe(true);
    const b = fakeMap([]);
    addAisTileLayers(b.map);
    expect(b.added.every((l) => l.before === undefined)).toBe(true);
  });
});

describe("setAisTileBoxes", () => {
  it("emits one closed lon/lat 5-ring per box at the exact corners", () => {
    const { map, setDatas } = fakeMap(["craft-icons"]);
    addAisTileLayers(map);
    setAisTileBoxes(map, [
      [
        [30, -84],
        [50, -64],
      ],
      [
        [70, 160],
        [90, 180],
      ],
    ]);
    const fc = setDatas[setDatas.length - 1] as {
      type: string;
      features: { geometry: { type: string; coordinates: [number, number][][] } }[];
    };
    expect(fc.type).toBe("FeatureCollection");
    expect(fc.features).toHaveLength(2);
    expect(fc.features[0].geometry.type).toBe("Polygon");
    expect(fc.features[0].geometry.coordinates).toEqual([
      [
        [-84, 30],
        [-64, 30],
        [-64, 50],
        [-84, 50],
        [-84, 30],
      ],
    ]);
    expect(fc.features[1].geometry.coordinates[0]).toEqual([
      [160, 70],
      [180, 70],
      [180, 90],
      [160, 90],
      [160, 70],
    ]);
  });

  it("null and [] both clear (server sends boxes: [] when the fill is disabled)", () => {
    const { map, setDatas } = fakeMap(["craft-icons"]);
    addAisTileLayers(map);
    setAisTileBoxes(map, [[[0, 0], [1, 1]]]);
    setAisTileBoxes(map, null);
    expect((setDatas[setDatas.length - 1] as { features: unknown[] }).features).toEqual([]);
    setAisTileBoxes(map, [[[0, 0], [1, 1]]]);
    setAisTileBoxes(map, []);
    expect((setDatas[setDatas.length - 1] as { features: unknown[] }).features).toEqual([]);
  });

  it("is safe before the source exists (no map.load race)", () => {
    const { map } = fakeMap([]);
    expect(() => setAisTileBoxes(map, [[[0, 0], [1, 1]]])).not.toThrow();
  });
});
