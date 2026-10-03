import type maplibregl from "maplibre-gl";
import type { LayerSpecification } from "@maplibre/maplibre-gl-style-spec";
import type { FeatureCollection } from "../data/features.js";

export const CRAFT_SOURCE_ID = "craft";

// "Noto Sans Regular" is served by both glyph sources: demotiles.maplibre.org
// (used by the Carto raster style) and OpenFreeMap (the vector fallback).
export const CRAFT_TEXT_FONT = ["Noto Sans Regular"] as const;

export function craftLayerDefs(filter: any): LayerSpecification[] {
  const common = { source: CRAFT_SOURCE_ID, filter, type: "symbol" as const };
  return [
    {
      ...common,
      id: "craft-icons",
      layout: {
        "icon-image": ["get", "kind"],
        "icon-size": ["interpolate", ["linear"], ["zoom"], 0, 0.5, 9, 1.1],
        "icon-allow-overlap": true,
        "icon-ignore-placement": true,
        "icon-rotate": ["get", "heading"],
        "icon-rotation-alignment": "map",
      },
      paint: {
        "icon-opacity": ["case", ["get", "stale"], 0.3, 1],
      },
    },
    {
      ...common,
      id: "craft-labels",
      layout: {
        "text-field": ["get", "label"],
        "text-font": [...CRAFT_TEXT_FONT],
        "text-size": 11,
        "text-offset": [0, 1.3],
        "text-allow-overlap": false,
        "text-ignore-placement": false,
      },
      paint: {
        "text-color": "#e6e9f0",
        "text-halo-color": "#000000",
        "text-halo-width": 1,
        "text-opacity": ["interpolate", ["linear"], ["zoom"], 4, 0, 6, 1],
      },
    },
    {
      ...common,
      id: "craft-sublabels",
      layout: {
        "text-field": ["get", "sublabel"],
        "text-font": [...CRAFT_TEXT_FONT],
        "text-size": 10,
        "text-offset": [0, 2.4],
        "text-allow-overlap": false,
        "text-ignore-placement": true,
      },
      paint: {
        "text-color": "#90caf9",
        "text-halo-color": "#000000",
        "text-halo-width": 1,
        "text-opacity": ["interpolate", ["linear"], ["zoom"], 8, 0, 10, 1],
      },
    },
  ];
}

export function addCraftSource(map: maplibregl.Map): void {
  if (map.getSource(CRAFT_SOURCE_ID)) return;
  map.addSource(CRAFT_SOURCE_ID, {
    type: "geojson",
    data: { type: "FeatureCollection", features: [] },
  });
}

export function setCraftData(map: maplibregl.Map, data: FeatureCollection): void {
  const src = map.getSource(CRAFT_SOURCE_ID) as maplibregl.GeoJSONSource | undefined;
  src?.setData(data as any);
}

export function addCraftLayers(map: maplibregl.Map, filter: any): void {
  if (map.getLayer("craft-icons")) return;
  for (const layer of craftLayerDefs(filter)) map.addLayer(layer);
}
