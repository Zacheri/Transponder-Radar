import maplibregl from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import { OPENFREEMAP_STYLE_URL, cartoStyle, probeCarto } from "./basemap.js";
import { applyStoredProjection, createMapControls } from "./controls.js";
import { loadProjection } from "../data/projection-cfg.js";

export async function createMap(container: HTMLElement): Promise<maplibregl.Map> {
  const apiKey: string = import.meta.env.VITE_CARTO_API_KEY ?? "";
  const inline = await probeCarto(apiKey);
  // MapOptions has no `projection` in 4.7.1, but a style object does: the
  // Carto basemap is built locally, so carry the stored projection on it at
  // creation — zero reload at boot. The OpenFreeMap fallback is a URL the
  // map fetches itself; for that path applyStoredProjection does the one
  // deferred full rebuild after the first load (projection-cfg default is
  // globe, so that path pays exactly one boot rebuild).
  const style = inline
    ? { ...cartoStyle(apiKey), projection: { type: loadProjection(localStorage) } }
    : OPENFREEMAP_STYLE_URL;
  const map = new maplibregl.Map({
    container,
    style,
    center: [10, 30],
    zoom: 1.5,
    attributionControl: false,
  });
  map.addControl(createMapControls(), "top-right");
  map.addControl(new maplibregl.AttributionControl({ compact: true }), "bottom-right");
  if (!inline) applyStoredProjection(map, localStorage);
  return map;
}
