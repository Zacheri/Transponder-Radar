// AIS fill tile outlines (spec 2026-11-25-traffic-monitor R7a): dashed blue
// rectangles for the server-composed aiscast boxes (home + follow) so the
// user can see where ship coverage actually applies. Single line layer — no
// fill, the boxes must not shade the map — inserted above the hotzone layers
// and below craft-icons (added after them with the same before-id, so it
// lands on top of hotzone). The color is a kind-independent hex literal
// (plan-sanctioned). Pure defs + data builder, hotzone.ts style.

import type maplibregl from "maplibre-gl";
import type { LayerSpecification } from "@maplibre/maplibre-gl-style-spec";

export const AIS_TILE_SOURCE = "ais-tile-src";
export const AIS_TILE_LAYER = "ais-tile-outline";

// Wire shape of a status box: [[minLat,minLon],[maxLat,maxLon]] (server
// ais-tiles.ts clamps to ±90/±180, so the ring needs no client-side clamp).
export type AisBox = [[number, number], [number, number]];

export function aisTileDefs(): LayerSpecification[] {
  return [
    {
      id: AIS_TILE_LAYER,
      type: "line",
      source: AIS_TILE_SOURCE,
      paint: {
        "line-color": "#4fc3f7",
        "line-dasharray": [4, 3],
        "line-width": 1.5,
      },
    },
  ];
}

export function addAisTileLayers(map: maplibregl.Map): void {
  if (map.getLayer(AIS_TILE_LAYER)) return;
  if (!map.getSource(AIS_TILE_SOURCE)) {
    map.addSource(AIS_TILE_SOURCE, { type: "geojson", data: emptyFc() });
  }
  const below = (["craft-icons", "craft-labels"] as const).find((id) => map.getLayer(id));
  for (const layer of aisTileDefs()) map.addLayer(layer, below);
}

type TileFC = {
  type: "FeatureCollection";
  features: {
    type: "Feature";
    geometry: { type: "Polygon"; coordinates: [number, number][][] };
    properties: null;
  }[];
};

const emptyFc = (): TileFC => ({ type: "FeatureCollection", features: [] });

const ring = (box: AisBox): TileFC["features"][number] => {
  const [[minLat, minLon], [maxLat, maxLon]] = box;
  return {
    type: "Feature",
    geometry: {
      type: "Polygon",
      coordinates: [
        [
          [minLon, minLat],
          [maxLon, minLat],
          [maxLon, maxLat],
          [minLon, maxLat],
          [minLon, minLat],
        ],
      ],
    },
    properties: null,
  };
};

// null / [] → empty FC: the server sends `boxes: []` whenever the fill feed
// is disabled, so a disabled state clears straight through onStatus with no
// client-side heuristics.
export function setAisTileBoxes(map: maplibregl.Map, boxes: AisBox[] | null): void {
  const src = map.getSource(AIS_TILE_SOURCE) as maplibregl.GeoJSONSource | undefined;
  if (!src) return;
  const fc: TileFC = { type: "FeatureCollection", features: (boxes ?? []).map(ring) };
  src.setData(fc as never);
}
