import type maplibregl from "maplibre-gl";
import type { FeatureCollection } from "../data/features.js";

export const CRAFT_SOURCE_ID = "craft";

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

  map.addLayer({
    id: "craft-icons",
    type: "symbol",
    source: CRAFT_SOURCE_ID,
    filter,
    layout: {
      "icon-image": ["get", "kind"],
      "icon-size": ["interpolate", ["linear"], ["zoom"], 0, 0.5, 9, 1.1],
      "icon-allow-overlap": true,
      "icon-ignore-placement": true,
    },
    paint: {
      "icon-opacity": ["case", ["get", "stale"], 0.3, 1],
    },
  });

  map.addLayer({
    id: "craft-labels",
    type: "symbol",
    source: CRAFT_SOURCE_ID,
    filter,
    layout: {
      "text-field": ["get", "label"],
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
  });

  map.addLayer({
    id: "craft-sublabels",
    type: "symbol",
    source: CRAFT_SOURCE_ID,
    filter,
    layout: {
      "text-field": ["get", "sublabel"],
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
  });
}
