// Flight-context layers: the selected aircraft's past trail (solid, colored
// per craft kind through the feature `color` property), the predicted path
// (dashed teal) and the destination label. Pure defs + data builders live
// here so style-validation tests can check them without a live map.
//
// Insertion order is runtime, not part of the defs: addTrackLayers inserts
// each layer BELOW `craft-icons` (falling back to `craft-labels`, then to
// plain append) so craft symbols and labels always paint on top of tracks.
//
// Coordinates are written into GeoJSON verbatim. Unwrapped longitudes
// (|lon| > 180, as produced by shared/geo greatCircle across the dateline)
// must pass through untouched — normalizing them would reintroduce dateline
// wraps and draw the path across the whole world.

import type maplibregl from "maplibre-gl";
import type { LayerSpecification } from "@maplibre/maplibre-gl-style-spec";
import { CRAFT_TEXT_FONT } from "./layers.js";
import type { LonLat } from "../../shared/geo.js";

export const TRACK_SOURCES = ["flight-trail", "flight-predicted", "flight-dest"] as const;

const TRAIL = "flight-trail";
const PREDICTED = "flight-predicted";
const DEST = "flight-dest";

export function trackLayerDefs(): LayerSpecification[] {
  return [
    {
      id: TRAIL,
      type: "line",
      source: TRAIL,
      paint: {
        "line-color": ["get", "color"],
        "line-width": 2,
        "line-opacity": 0.9,
      },
    },
    {
      id: PREDICTED,
      type: "line",
      source: PREDICTED,
      paint: {
        "line-color": "#80cbc4",
        "line-width": 2,
        "line-dasharray": [2, 2],
      },
    },
    {
      id: DEST,
      type: "symbol",
      source: DEST,
      layout: {
        "text-field": ["get", "name"],
        "text-font": [...CRAFT_TEXT_FONT],
        "text-size": 11,
        "text-offset": [0, 1],
      },
      paint: {
        "text-color": "#e0e0e0",
        "text-halo-color": "#000000",
        "text-halo-width": 1,
      },
    },
  ];
}

export function addTrackLayers(map: maplibregl.Map): void {
  if (map.getLayer(TRAIL)) return;
  for (const id of TRACK_SOURCES) {
    if (!map.getSource(id)) {
      map.addSource(id, { type: "geojson", data: emptyFc() });
    }
  }
  const below = (["craft-icons", "craft-labels"] as const).find((id) => map.getLayer(id));
  for (const layer of trackLayerDefs()) map.addLayer(layer, below);
}

type LineFeature = {
  type: "Feature";
  geometry: { type: "LineString"; coordinates: [number, number][] };
  properties: Record<string, string>;
};
type PointFeature = {
  type: "Feature";
  geometry: { type: "Point"; coordinates: [number, number] };
  properties: Record<string, string>;
};
type TrackFC = {
  type: "FeatureCollection";
  features: (LineFeature | PointFeature)[];
};

const emptyFc = (): TrackFC => ({ type: "FeatureCollection", features: [] });

// < 2 points cannot form a line; the layer would draw nothing anyway.
function lineFc(points: readonly LonLat[], properties: Record<string, string>): TrackFC {
  if (points.length < 2) return emptyFc();
  const coords = points.map((p) => [p.lon, p.lat] as [number, number]);
  return { type: "FeatureCollection", features: [{ type: "Feature", geometry: { type: "LineString", coordinates: coords }, properties }] };
}

function setData(map: maplibregl.Map, id: string, data: TrackFC): void {
  const src = map.getSource(id) as maplibregl.GeoJSONSource | undefined;
  src?.setData(data as any);
}

export function setTrailData(map: maplibregl.Map, path: readonly LonLat[], color: string): void {
  setData(map, TRAIL, lineFc(path, { color }));
}

export function clearTrailData(map: maplibregl.Map): void {
  setData(map, TRAIL, emptyFc());
}

export function setPredictedData(map: maplibregl.Map, coords: readonly LonLat[] | null): void {
  setData(map, PREDICTED, coords ? lineFc(coords, {}) : emptyFc());
}

export function clearPredicted(map: maplibregl.Map): void {
  setData(map, PREDICTED, emptyFc());
}

export function setDestMarker(map: maplibregl.Map, dest: (LonLat & { name: string }) | null): void {
  const fc: TrackFC = dest
    ? {
        type: "FeatureCollection",
        features: [
          {
            type: "Feature",
            geometry: { type: "Point", coordinates: [dest.lon, dest.lat] },
            properties: { name: dest.name },
          },
        ],
      }
    : emptyFc();
  setData(map, DEST, fc);
}

export function clearDestMarker(map: maplibregl.Map): void {
  setData(map, DEST, emptyFc());
}
