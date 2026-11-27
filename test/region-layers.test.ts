import { afterEach, describe, expect, it, vi } from "vitest";
import { validateStyleMin } from "@maplibre/maplibre-gl-style-spec";
import {
  REGIONS_PREVIEW_SOURCE,
  REGIONS_SOURCE,
  REGION_FILL,
  addRegionLayers,
  createRegionDrawer,
  regionDefs,
  regionPreviewDefs,
  setRegionData,
  setRegionPreview,
} from "../src/map/regions.js";
import { cartoStyle } from "../src/map/basemap.js";
import type { Region } from "../src/data/regions.js";

// Pure-def + data-builder + FSM-stub coverage like hotzone.test.ts; real
// rendering and pointer behavior are browser-verified (no WebGL in node).

const def = (id: string) => [...regionDefs(), ...regionPreviewDefs()].find((l) => l.id === id) as any;

describe("region layer defs", () => {
  it("main pair: fill then outline, both on regions-src, per-feature color", () => {
    const defs = regionDefs();
    expect(defs.map((l) => l.id)).toEqual([REGION_FILL, "region-outline"]);
    for (const l of defs) expect((l as { source?: unknown }).source).toBe(REGIONS_SOURCE);
    expect(defs.map((l) => l.type)).toEqual(["fill", "line"]);
    expect(def(REGION_FILL).paint["fill-color"]).toEqual(["get", "color"]);
    expect(def(REGION_FILL).paint["fill-opacity"]).toBe(0.12);
    expect(def("region-outline").paint["line-color"]).toEqual(["get", "color"]);
    expect(def("region-outline").paint["line-width"]).toBe(1.5);
  });

  it("preview pair: own source, thinner dashed look", () => {
    const defs = regionPreviewDefs();
    expect(defs.map((l) => l.id)).toEqual(["region-preview-fill", "region-preview-outline"]);
    for (const l of defs) expect((l as { source?: unknown }).source).toBe(REGIONS_PREVIEW_SOURCE);
    expect(def("region-preview-fill").paint["fill-opacity"]).toBeLessThan(0.12);
    expect(def("region-preview-outline").paint["line-dasharray"]).toEqual([3, 2]);
    expect(def("region-preview-outline").paint["line-width"]).toBeLessThan(1.5);
  });
});

const geojsonSource = { type: "geojson", data: { type: "FeatureCollection", features: [] } };
const withBounds = (layers: any[]) => layers.map((l) => ({ minzoom: 0, maxzoom: 22, ...l }));
const regionSources = { [REGIONS_SOURCE]: geojsonSource, [REGIONS_PREVIEW_SOURCE]: geojsonSource };

describe("region layers style validation (both basemaps)", () => {
  it("validates on the Carto raster basemap", () => {
    const carto = cartoStyle("test-key") as any;
    const style = {
      ...carto,
      sources: { ...carto.sources, ...regionSources },
      layers: withBounds([...(carto.layers ?? []), ...regionDefs(), ...regionPreviewDefs()]),
    };
    expect(validateStyleMin(style as never)).toEqual([]);
  });

  it("validates on a glyphs-bearing OpenFreeMap-shaped vector style", () => {
    const style = {
      version: 8,
      glyphs: "https://tiles.openfreemap.org/fonts/{fontstack}/{range}.pbf",
      sources: {
        basemap: { type: "raster", tiles: ["https://tiles.example/{z}/{x}/{y}.png"] },
        ...regionSources,
      },
      layers: withBounds([
        { id: "basemap", type: "raster", source: "basemap" },
        ...regionDefs(),
        ...regionPreviewDefs(),
      ]),
    };
    expect(validateStyleMin(style as never)).toEqual([]);
  });
});

function fakeMap(existingLayers: string[]) {
  const layers = new Set(existingLayers);
  const added: Array<{ id: string; before?: string }> = [];
  const setDatas: Record<string, unknown[]> = {};
  const sources = new Map<string, { setData: (d: unknown) => void }>();
  const map = {
    getLayer: (id: string) => (layers.has(id) ? { id } : undefined),
    getSource: (id: string) => sources.get(id),
    addSource: (id: string) => {
      setDatas[id] = [];
      sources.set(id, { setData: (d) => setDatas[id].push(d) });
    },
    addLayer: (layer: { id: string }, before?: string) => {
      layers.add(layer.id);
      added.push({ id: layer.id, before });
    },
    // Queue-on-missing-source path (writeOrQueue) arms a style.load flush.
    on: () => {},
    once: () => {},
    off: () => {},
  };
  return { map: map as never, added, setDatas, sources };
}

const adsb = (id = "a"): Region => ({ id, kind: "adsb", b: [[10, 20], [30, 40]] });
const ais = (id = "b"): Region => ({ id, kind: "ais", b: [[-5, -6], [5, 6]] });

describe("addRegionLayers", () => {
  it("adds both sources and inserts all four layers below craft-icons, preview last", () => {
    const { map, added, sources } = fakeMap(["craft-icons", "craft-labels"]);
    addRegionLayers(map);
    expect(added).toEqual([
      { id: REGION_FILL, before: "craft-icons" },
      { id: "region-outline", before: "craft-icons" },
      { id: "region-preview-fill", before: "craft-icons" },
      { id: "region-preview-outline", before: "craft-icons" },
    ]);
    expect([...sources.keys()].sort()).toEqual([REGIONS_PREVIEW_SOURCE, REGIONS_SOURCE]);
  });

  it("uses an explicit beforeId, else craft-labels, else plain append", () => {
    const a = fakeMap(["craft-icons"]);
    addRegionLayers(a.map, "ais-tile-outline");
    expect(a.added.every((l) => l.before === "ais-tile-outline")).toBe(true);
    const b = fakeMap(["craft-labels"]);
    addRegionLayers(b.map);
    expect(b.added.every((l) => l.before === "craft-labels")).toBe(true);
    const c = fakeMap([]);
    addRegionLayers(c.map);
    expect(c.added.every((l) => l.before === undefined)).toBe(true);
  });

  it("is idempotent", () => {
    const { map, added, sources } = fakeMap(["craft-icons"]);
    addRegionLayers(map);
    addRegionLayers(map);
    expect(added).toHaveLength(4);
    expect(sources.size).toBe(2);
  });
});

describe("setRegionData", () => {
  const writes = (setDatas: Record<string, unknown[]>) => setDatas[REGIONS_SOURCE] as any[];

  it("0 regions writes an empty FeatureCollection", () => {
    const { map, setDatas } = fakeMap(["craft-icons"]);
    addRegionLayers(map);
    setRegionData(map, []);
    expect(writes(setDatas)[0]).toEqual({ type: "FeatureCollection", features: [] });
  });

  it("1 region: closed ring with the kind's color", () => {
    const { map, setDatas } = fakeMap(["craft-icons"]);
    addRegionLayers(map);
    setRegionData(map, [adsb()]);
    const fc = writes(setDatas)[0];
    expect(fc.features).toHaveLength(1);
    expect(fc.features[0].geometry.coordinates).toEqual([
      [
        [20, 10],
        [40, 10],
        [40, 30],
        [20, 30],
        [20, 10],
      ],
    ]);
    expect(fc.features[0].properties).toEqual({ color: "#4fc3f7" });
  });

  it("2 regions: one feature each, per-kind colors", () => {
    const { map, setDatas } = fakeMap(["craft-icons"]);
    addRegionLayers(map);
    setRegionData(map, [adsb(), ais()]);
    const fc = writes(setDatas)[0];
    expect(fc.features.map((f: any) => f.properties.color)).toEqual(["#4fc3f7", "#4db6ac"]);
    expect(fc.features[1].geometry.coordinates[0][0]).toEqual([-6, -5]);
  });

  it("is safe before the source exists", () => {
    const { map } = fakeMap([]);
    expect(() => setRegionData(map, [adsb()])).not.toThrow();
  });
});

// Paint-race regression (user report 2026-11-27): a full setStyle swap (the
// globe/flat toggle, the fallback-boot rebuild) removes the sources until the
// next style.load — a paint landing in that window must replay, not drop.
// The stub models the swap: sources exist only while the style is live;
// reload() mirrors the real ordering (setupStyleLayers re-adds first — it
// registers as a style.load listener before any queue can arm — then the
// style.load dispatch runs the queued flush).
function swapMap() {
  const styleListeners: Array<() => void> = [];
  const writes: Record<string, unknown[]> = {};
  const sources = new Map<string, { setData: (d: unknown) => void }>();
  const map = {
    getLayer: (id: string) => (sources.size > 0 && id === REGION_FILL ? { id } : undefined),
    getSource: (id: string) => sources.get(id),
    addSource: (id: string) => {
      if (!writes[id]) writes[id] = [];
      sources.set(id, {
        setData: (d: unknown) => {
          writes[id].push(d);
        },
      });
    },
    addLayer: () => {},
    on: () => {},
    once: (_t: string, fn: () => void) => {
      styleListeners.push(fn);
    },
    off: () => {},
  };
  return {
    map: map as never,
    writes,
    /** Boot setup: the style is live and this module's layers are on. */
    live: () => addRegionLayers(map as never),
    /** A setStyle swap starts: every source (and layer) is gone. */
    swap: () => sources.clear(),
    /** The swap completes: setupStyleLayers re-adds, then style.load dispatches. */
    reload: () => {
      addRegionLayers(map as never);
      const fns = styleListeners.splice(0, styleListeners.length);
      for (const fn of fns) fn();
    },
  };
}

const previewFc = (setDatas: unknown[]) => setDatas[setDatas.length - 1] as { features: unknown[] };

describe("region paints during a style swap", () => {
  it("a commit dropped mid-swap paints when the style returns (no reload)", () => {
    const m = swapMap();
    m.live();
    setRegionData(m.map, [adsb()]);
    expect(m.writes[REGIONS_SOURCE]).toHaveLength(1);
    m.swap();
    setRegionData(m.map, [adsb(), ais()]); // the commit lands mid-rebuild
    expect(m.writes[REGIONS_SOURCE]).toHaveLength(1); // queued, not written
    m.reload();
    const after = m.writes[REGIONS_SOURCE];
    expect(after).toHaveLength(2);
    expect((after[1] as { features: unknown[] }).features).toHaveLength(2);
  });

  it("multiple commits dropped in one window replay only the latest, once", () => {
    const m = swapMap();
    m.live();
    m.swap();
    setRegionData(m.map, [adsb()]);
    setRegionData(m.map, [adsb(), ais()]);
    m.reload();
    const after = m.writes[REGIONS_SOURCE];
    expect(after).toHaveLength(1);
    expect((after[0] as { features: unknown[] }).features).toHaveLength(2);
  });

  it("the preview queues through the same window, latest-wins (rect then clear)", () => {
    const m = swapMap();
    m.live();
    m.swap();
    setRegionPreview(m.map, [[1, 2], [3, 4]], "#4fc3f7");
    setRegionPreview(m.map, null, "#4fc3f7");
    m.reload();
    const writes = m.writes[REGIONS_PREVIEW_SOURCE];
    expect(writes).toHaveLength(1);
    expect(previewFc(writes).features).toHaveLength(0);
  });

  it("addRegionLayers itself flushes (covers the load event firing past style.load)", () => {
    const m = swapMap();
    m.live();
    m.swap();
    setRegionData(m.map, [ais()]);
    addRegionLayers(m.map); // re-add WITHOUT dispatching style.load
    const after = m.writes[REGIONS_SOURCE];
    expect(after).toHaveLength(1); // the queued replay, written by the re-add
    expect((after[0] as { features: unknown[] }).features).toHaveLength(1);
  });

  it("a paint with the source present writes straight through and never re-paints", () => {
    const m = swapMap();
    m.live();
    setRegionData(m.map, [adsb()]);
    expect(m.writes[REGIONS_SOURCE]).toHaveLength(1);
    m.swap();
    m.reload();
    expect(m.writes[REGIONS_SOURCE]).toHaveLength(1); // no phantom replay
  });
});

// --- draw FSM ------------------------------------------------------------

interface Stub {
  map: any;
  emit: (type: string, e: unknown) => void;
  listenerCount: (type: string) => number;
  setDatas: unknown[];
  container: { style: { cursor: string } };
  canvas: { style: { cursor: string } };
  pan: { enabled: boolean; log: string[] };
  rotate: { enabled: boolean; log: string[] };
}

function drawerMap(opts?: { pan?: boolean; rotate?: boolean }): Stub {
  const handlers = new Map<string, Array<(e: any) => void>>();
  const setDatas: unknown[] = [];
  const container = { style: { cursor: "grab" } };
  // The craft-hover handlers write the CANVAS cursor, so the drawer must
  // too — the canvas starts unstyled (inheriting the container).
  const canvas = { style: { cursor: "" } };
  const handler = (start: boolean) => {
    const state = { enabled: start, log: [] as string[] };
    return {
      state,
      obj: {
        isEnabled: () => state.enabled,
        enable: () => {
          state.enabled = true;
          state.log.push("enable");
        },
        disable: () => {
          state.enabled = false;
          state.log.push("disable");
        },
      },
    };
  };
  const pan = handler(opts?.pan ?? true);
  const rotate = handler(opts?.rotate ?? true);
  const map: any = {
    on: (t: string, fn: (e: any) => void) => handlers.set(t, [...(handlers.get(t) ?? []), fn]),
    off: (t: string, fn: (e: any) => void) =>
      handlers.set(t, (handlers.get(t) ?? []).filter((f) => f !== fn)),
    getContainer: () => container,
    getCanvas: () => canvas,
    // px → degrees, linear and invertible for assertions.
    unproject: ([x, y]: [number, number]) => ({ lng: x / 10, lat: y / 10 }),
    getSource: (id: string) =>
      id === REGIONS_PREVIEW_SOURCE ? { setData: (d: unknown) => setDatas.push(d) } : undefined,
    dragPan: pan.obj,
    dragRotate: rotate.obj,
  };
  return {
    map,
    emit: (t, e) => {
      for (const fn of [...(handlers.get(t) ?? [])]) fn(e);
    },
    listenerCount: (t) => (handlers.get(t) ?? []).length,
    setDatas,
    container,
    canvas,
    pan: pan.state,
    rotate: rotate.state,
  };
}

interface DomStub {
  doc: { removals: string[] };
  win: { removals: string[] };
  fire: (where: "doc" | "win", type: string, e?: unknown) => void;
}

function stubDom(): DomStub {
  const make = () => {
    const listeners = new Map<string, any[]>();
    const bag = {
      removals: [] as string[],
      addEventListener: (t: string, fn: any) => listeners.set(t, [...(listeners.get(t) ?? []), fn]),
      removeEventListener: (t: string, fn: any) => {
        bag.removals.push(t);
        listeners.set(t, (listeners.get(t) ?? []).filter((f) => f !== fn));
      },
      fire: (t: string, e: unknown = {}) => {
        for (const fn of [...(listeners.get(t) ?? [])]) fn(e);
      },
    };
    return bag;
  };
  const doc = make();
  const win = make();
  vi.stubGlobal("document", doc);
  vi.stubGlobal("window", win);
  return {
    doc,
    win,
    fire: (where, type, e) => (where === "doc" ? doc : win).fire(type, e),
  } as DomStub;
}

afterEach(() => vi.unstubAllGlobals());

const noop = () => {};

describe("createRegionDrawer", () => {
  it("arms: disables gestures and sets the crosshair cursor (canvas — craft hover writes the canvas)", () => {
    const s = drawerMap();
    stubDom();
    createRegionDrawer(s.map, { kind: "adsb", onCommit: noop, onCancel: noop });
    expect(s.pan.log).toEqual(["disable"]);
    expect(s.rotate.log).toEqual(["disable"]);
    expect(s.canvas.style.cursor).toBe("crosshair");
    expect(s.container.style.cursor).toBe("crosshair");
  });

  it("full drag commits the normalized rect once and tears down exactly", () => {
    const s = drawerMap();
    stubDom();
    const commits: unknown[] = [];
    const drawer = createRegionDrawer(s.map, { kind: "adsb", onCommit: (r) => commits.push(r), onCancel: noop });
    s.emit("mousedown", { point: { x: 200, y: 150 } });
    s.emit("mousemove", { point: { x: 150, y: 120 } });
    const preview = s.setDatas[s.setDatas.length - 1] as any;
    expect(preview.features[0].properties).toEqual({ color: "#4fc3f7" });
    s.emit("mouseup", { point: { x: 100, y: 100 } });
    // Reverse drag still yields the normalized box, and only one callback.
    expect(commits).toEqual([[[10, 10], [15, 20]]]);
    // Teardown: gestures back, cursor back, preview cleared, listeners gone.
    expect(s.pan.log).toEqual(["disable", "enable"]);
    expect(s.rotate.log).toEqual(["disable", "enable"]);
    expect(s.pan.enabled).toBe(true);
    expect(s.rotate.enabled).toBe(true);
    expect(s.container.style.cursor).toBe("grab");
    expect(s.canvas.style.cursor).toBe("");
    expect(s.setDatas[s.setDatas.length - 1]).toEqual({ type: "FeatureCollection", features: [] });
    expect(s.listenerCount("mousedown")).toBe(0);
    expect(s.listenerCount("mousemove")).toBe(0);
    expect(s.listenerCount("mouseup")).toBe(0);
    drawer.cancel();
    expect(commits).toHaveLength(1);
  });

  it("teardown removes the document/window listeners", () => {
    const dom = stubDom();
    const s = drawerMap();
    const drawer = createRegionDrawer(s.map, { kind: "adsb", onCommit: noop, onCancel: noop });
    drawer.cancel();
    expect(dom.doc.removals).toContain("keydown");
    expect(dom.win.removals).toContain("blur");
  });

  it("tiny drag (< MIN_PX) cancels instead of committing", () => {
    const s = drawerMap();
    stubDom();
    let committed = false;
    let cancelled = 0;
    createRegionDrawer(s.map, {
      kind: "adsb",
      onCommit: () => (committed = true),
      onCancel: () => (cancelled += 1),
    });
    s.emit("mousedown", { point: { x: 100, y: 100 } });
    s.emit("mousemove", { point: { x: 103, y: 103 } });
    s.emit("mouseup", { point: { x: 104, y: 104 } });
    expect(committed).toBe(false);
    expect(cancelled).toBe(1);
    expect(s.setDatas[s.setDatas.length - 1]).toEqual({ type: "FeatureCollection", features: [] });
  });

  it("Escape cancels; other keys do not", () => {
    const dom = stubDom();
    const s = drawerMap();
    let cancelled = 0;
    createRegionDrawer(s.map, { kind: "adsb", onCommit: noop, onCancel: () => (cancelled += 1) });
    s.emit("mousedown", { point: { x: 100, y: 100 } });
    dom.fire("doc", "keydown", { key: "a" });
    expect(cancelled).toBe(0);
    dom.fire("doc", "keydown", { key: "Escape" });
    expect(cancelled).toBe(1);
    expect(s.container.style.cursor).toBe("grab");
  });

  it("window blur cancels", () => {
    const dom = stubDom();
    const s = drawerMap();
    let cancelled = 0;
    createRegionDrawer(s.map, { kind: "adsb", onCommit: noop, onCancel: () => (cancelled += 1) });
    dom.fire("win", "blur");
    expect(cancelled).toBe(1);
    expect(s.pan.enabled).toBe(true);
  });

  it("restores prior gesture states exactly (pan was already off)", () => {
    const s = drawerMap({ pan: false, rotate: true });
    stubDom();
    const drawer = createRegionDrawer(s.map, { kind: "ais", onCommit: noop, onCancel: noop });
    drawer.cancel();
    expect(s.pan.enabled).toBe(false);
    expect(s.rotate.enabled).toBe(true);
  });

  it("no callbacks and no preview after teardown", () => {
    const dom = stubDom();
    const s = drawerMap();
    let fired = 0;
    createRegionDrawer(s.map, { kind: "adsb", onCommit: () => (fired += 1), onCancel: () => (fired += 1) });
    s.emit("mousemove", { point: { x: 150, y: 150 } });
    s.emit("mouseup", { point: { x: 300, y: 300 } });
    expect(fired).toBe(0);
    expect(s.setDatas).toEqual([]);
    s.emit("mousedown", { point: { x: 100, y: 100 } });
    s.emit("mouseup", { point: { x: 300, y: 300 } });
    expect(fired).toBe(1);
    const before = s.setDatas.length;
    dom.fire("doc", "keydown", { key: "Escape" });
    dom.fire("win", "blur");
    s.emit("mouseup", { point: { x: 500, y: 500 } });
    expect(fired).toBe(1);
    expect(s.setDatas).toHaveLength(before);
  });

  it("preview rides the armed kind's color (ais)", () => {
    const s = drawerMap();
    stubDom();
    createRegionDrawer(s.map, { kind: "ais", onCommit: noop, onCancel: noop });
    s.emit("mousedown", { point: { x: 100, y: 100 } });
    s.emit("mousemove", { point: { x: 200, y: 200 } });
    const preview = s.setDatas[s.setDatas.length - 1] as any;
    expect(preview.features[0].properties).toEqual({ color: "#4db6ac" });
  });
});
