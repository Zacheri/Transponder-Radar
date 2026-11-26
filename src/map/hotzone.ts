// Hot-zone highlight: one plain rect per live zone (densest-cluster boxes,
// R4 broadcast copies) under the craft icons, each filled in its own
// dominant kind's color at 18% with a 1 px same-color outline (companion
// line layer — fill-outline-color cannot take a feature expression). Pure
// defs + data builder, trackLayers.ts style.

import type maplibregl from "maplibre-gl";
import type { LayerSpecification } from "@maplibre/maplibre-gl-style-spec";
import type { LonLat } from "../../shared/geo.js";

export const HOTZONE_SOURCE = "hotzone";
export const HOTZONE_LAYER = "hotzone-fill";
const OUTLINE = "hotzone-outline";

export function hotzoneDefs(): LayerSpecification[] {
  return [
    {
      id: HOTZONE_LAYER,
      type: "fill",
      source: HOTZONE_SOURCE,
      paint: {
        "fill-color": ["get", "color"],
        "fill-opacity": 0.18,
      },
    },
    {
      id: OUTLINE,
      type: "line",
      source: HOTZONE_SOURCE,
      paint: {
        "line-color": ["get", "color"],
        "line-width": 1,
      },
    },
  ];
}

export function addHotzoneLayer(map: maplibregl.Map): void {
  if (map.getLayer(HOTZONE_LAYER)) return;
  if (!map.getSource(HOTZONE_SOURCE)) {
    map.addSource(HOTZONE_SOURCE, { type: "geojson", data: emptyFc() });
  }
  const below = (["craft-icons", "craft-labels"] as const).find((id) => map.getLayer(id));
  for (const layer of hotzoneDefs()) map.addLayer(layer, below);
}

type ZoneRect = { center: LonLat; halfW: number; halfH: number; count: number; color: string };

type HotzoneFC = {
  type: "FeatureCollection";
  features: {
    type: "Feature";
    geometry: { type: "Polygon"; coordinates: [number, number][][] };
    properties: Record<string, string | number>;
  }[];
};

const emptyFc = (): HotzoneFC => ({ type: "FeatureCollection", features: [] });

// Server zones clamp lat to ±90 / lon to ±180 at construction (R1), so the
// rings need no client-side clamp. One closed ring per zone (<= 2, dominant-
// kind color per feature); an empty list clears the source.
export function setHotzones(map: maplibregl.Map, zones: ZoneRect[]): void {
  const src = map.getSource(HOTZONE_SOURCE) as maplibregl.GeoJSONSource | undefined;
  if (!src) return;
  const fc: HotzoneFC = {
    type: "FeatureCollection",
    features: zones.map((zone) => {
      const w = zone.center.lon - zone.halfW;
      const e = zone.center.lon + zone.halfW;
      const s = zone.center.lat - zone.halfH;
      const n = zone.center.lat + zone.halfH;
      return {
        type: "Feature",
        geometry: {
          type: "Polygon",
          coordinates: [
            [
              [w, s],
              [e, s],
              [e, n],
              [w, n],
              [w, s],
            ],
          ],
        },
        properties: { color: zone.color, count: zone.count },
      };
    }),
  };
  src.setData(fc as any);
}
