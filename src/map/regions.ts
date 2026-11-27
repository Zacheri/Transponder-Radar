// User-region polygons (spec 2026-11-26 §B): per-feature colored fill +
// outline from one GeoJSON source, plus a separate preview source for the
// in-progress drag rect. Inserted below craft-icons (after the hotzone and
// ais-tile outlines — added after them with the same before-id chain).
// Layers are non-interactive: no click handlers are registered, so craft
// clicks are never stolen. Pure defs + data builder + an injectable draw FSM.

import type maplibregl from "maplibre-gl";
import type { LayerSpecification } from "@maplibre/maplibre-gl-style-spec";
import type { LonLat } from "../../shared/geo.js";
import { normalizeBox, REGION_COLORS, type Region, type RegionBox, type RegionKind } from "../data/regions.js";

export const REGIONS_SOURCE = "regions-src";
export const REGION_FILL = "region-fill";
const REGION_OUTLINE = "region-outline";
export const REGIONS_PREVIEW_SOURCE = "regions-preview-src";
const PREVIEW_FILL = "region-preview-fill";
const PREVIEW_OUTLINE = "region-preview-outline";

// A mouseup closer than this to the anchor is treated as a cancel-click.
export const MIN_PX = 8;

export function regionDefs(): LayerSpecification[] {
  return [
    {
      id: REGION_FILL,
      type: "fill",
      source: REGIONS_SOURCE,
      paint: {
        "fill-color": ["get", "color"],
        "fill-opacity": 0.12,
      },
    },
    {
      id: REGION_OUTLINE,
      type: "line",
      source: REGIONS_SOURCE,
      paint: {
        "line-color": ["get", "color"],
        "line-width": 1.5,
      },
    },
  ];
}

export function regionPreviewDefs(): LayerSpecification[] {
  return [
    {
      id: PREVIEW_FILL,
      type: "fill",
      source: REGIONS_PREVIEW_SOURCE,
      paint: {
        "fill-color": ["get", "color"],
        "fill-opacity": 0.08,
      },
    },
    {
      id: PREVIEW_OUTLINE,
      type: "line",
      source: REGIONS_PREVIEW_SOURCE,
      paint: {
        "line-color": ["get", "color"],
        "line-dasharray": [3, 2],
        "line-width": 1,
      },
    },
  ];
}

/**
 * Idempotent. beforeId overrides the lookup; by default both layer pairs go
 * directly below craft-icons (craft-labels fallback, then plain append),
 * added after hotzone/aisTiles so regions land on top of those outlines.
 */
export function addRegionLayers(map: maplibregl.Map, beforeId?: string): void {
  if (map.getLayer(REGION_FILL)) return;
  const before = beforeId ?? (["craft-icons", "craft-labels"] as const).find((id) => map.getLayer(id));
  for (const source of [REGIONS_SOURCE, REGIONS_PREVIEW_SOURCE]) {
    if (!map.getSource(source)) {
      map.addSource(source, { type: "geojson", data: emptyFc() });
    }
  }
  for (const layer of [...regionDefs(), ...regionPreviewDefs()]) map.addLayer(layer, before);
  flushPending(map);
}

type RegionFC = {
  type: "FeatureCollection";
  features: {
    type: "Feature";
    geometry: { type: "Polygon"; coordinates: [number, number][][] };
    properties: Record<string, string>;
  }[];
};

const emptyFc = (): RegionFC => ({ type: "FeatureCollection", features: [] });

const ring = (b: RegionBox): [number, number][] => {
  const [[minLat, minLon], [maxLat, maxLon]] = b;
  return [
    [minLon, minLat],
    [maxLon, minLat],
    [maxLon, maxLat],
    [minLon, maxLat],
    [minLon, minLat],
  ];
};

const feature = (b: RegionBox, color: string): RegionFC["features"][number] => ({
  type: "Feature",
  geometry: { type: "Polygon", coordinates: [ring(b)] },
  properties: { color },
});

export function setRegionData(map: maplibregl.Map, regions: Region[]): void {
  const fc: RegionFC = {
    type: "FeatureCollection",
    features: regions.map((r) => feature(r.b, REGION_COLORS[r.kind])),
  };
  writeOrQueue(map, REGIONS_SOURCE, fc);
}

/** The in-progress drag rect; null clears. color = REGION_COLORS[armed kind]. */
export function setRegionPreview(map: maplibregl.Map, rect: RegionBox | null, color: string): void {
  const fc: RegionFC = rect ? { type: "FeatureCollection", features: [feature(rect, color)] } : emptyFc();
  writeOrQueue(map, REGIONS_PREVIEW_SOURCE, fc);
}

// Insurance for paints that land while this module's sources are absent
// (e.g. a commit before the first style.load): setData on a missing source
// would drop silently, so the latest payload per source is remembered here
// (latest-wins) and replayed
// when the style comes back — addRegionLayers flushes, and a one-shot
// style.load listener covers swaps that complete outside it.
type PaintQueue = Map<string, RegionFC>;
const pendingPaints = new WeakMap<maplibregl.Map, PaintQueue>();
const flushArmed = new WeakSet<maplibregl.Map>();

function writeOrQueue(map: maplibregl.Map, sourceId: string, fc: RegionFC): void {
  const src = map.getSource(sourceId) as maplibregl.GeoJSONSource | undefined;
  if (src) {
    src.setData(fc as never);
    return;
  }
  let q = pendingPaints.get(map);
  if (!q) {
    q = new Map();
    pendingPaints.set(map, q);
  }
  q.set(sourceId, fc);
  if (flushArmed.has(map)) return;
  flushArmed.add(map);
  map.once("style.load", () => flushPending(map));
}

function flushPending(map: maplibregl.Map): void {
  const q = pendingPaints.get(map);
  if (!q || q.size === 0) return;
  flushArmed.delete(map);
  const items = [...q.entries()];
  q.clear();
  for (const [sourceId, fc] of items) writeOrQueue(map, sourceId, fc);
}

export interface RegionDrawerOpts {
  kind: RegionKind;
  onCommit: (rect: RegionBox) => void;
  onCancel: () => void;
}

type Pixel = { x: number; y: number };

/**
 * Rectangle draw mode (spec §B): arms immediately (gestures off, crosshair),
 * mousedown anchors, mousemove previews, mouseup commits the normalized box
 * — under MIN_PX of drag it cancels instead. Escape or window blur cancels.
 * Every exit runs the same single teardown (gesture/cursor restore, preview
 * clear, listener removal) and fires at most one callback; unproject-based,
 * so it works on globe and mercator alike.
 */
export function createRegionDrawer(map: maplibregl.Map, opts: RegionDrawerOpts): { cancel(): void } {
  const container = map.getContainer();
  const gestures = { pan: map.dragPan.isEnabled(), rotate: map.dragRotate.isEnabled() };
  map.dragPan.disable();
  map.dragRotate.disable();
  // The crosshair goes on the CANVAS (craft-hover writes the canvas cursor,
  // which would win over the container); the container set covers the
  // non-canvas chrome and is harmless.
  const canvas = map.getCanvas();
  const prevCanvasCursor = canvas.style.cursor;
  const prevContainerCursor = container.style.cursor;
  canvas.style.cursor = "crosshair";
  container.style.cursor = "crosshair";

  let anchor: { at: Pixel; where: LonLat } | null = null;
  let done = false;

  const unproject = (p: Pixel): LonLat => {
    const ll = map.unproject([p.x, p.y]);
    return { lon: ll.lng, lat: ll.lat };
  };

  const onDown = (e: { point: Pixel }): void => {
    anchor = { at: e.point, where: unproject(e.point) };
  };

  const onMove = (e: { point: Pixel }): void => {
    if (!anchor) return;
    setRegionPreview(map, normalizeBox(anchor.where, unproject(e.point)), REGION_COLORS[opts.kind]);
  };

  const onUp = (e: { point: Pixel }): void => {
    if (!anchor) return;
    const { at, where } = anchor;
    const near = Math.hypot(e.point.x - at.x, e.point.y - at.y) < MIN_PX;
    finish(near ? null : normalizeBox(where, unproject(e.point)));
  };

  const onKey = (e: { key: string }): void => {
    if (e.key === "Escape") finish(null);
  };

  const onBlur = (): void => finish(null);

  function finish(rect: RegionBox | null): void {
    if (done) return;
    done = true;
    map.off("mousedown", onDown);
    map.off("mousemove", onMove);
    map.off("mouseup", onUp);
    document.removeEventListener("keydown", onKey);
    window.removeEventListener("blur", onBlur);
    if (gestures.pan) map.dragPan.enable();
    else map.dragPan.disable();
    if (gestures.rotate) map.dragRotate.enable();
    else map.dragRotate.disable();
    container.style.cursor = prevContainerCursor;
    canvas.style.cursor = prevCanvasCursor;
    setRegionPreview(map, null, REGION_COLORS[opts.kind]);
    if (rect) opts.onCommit(rect);
    else opts.onCancel();
  }

  map.on("mousedown", onDown);
  map.on("mousemove", onMove);
  map.on("mouseup", onUp);
  document.addEventListener("keydown", onKey);
  window.addEventListener("blur", onBlur);

  return { cancel: () => finish(null) };
}
