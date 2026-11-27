import maplibregl from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import { OPENFREEMAP_STYLE_URL, cartoStyle, probeCarto } from "./basemap.js";
import { applyStoredProjection, createMapControls } from "./controls.js";
import { loadProjection } from "../data/projection-cfg.js";

export async function createMap(container: HTMLElement): Promise<maplibregl.Map> {
  const apiKey: string = import.meta.env.VITE_CARTO_API_KEY ?? "";
  const inline = await probeCarto(apiKey);
  // MapOptions still has no `projection` in 5.24.1, but an inline style
  // object does — and unlike 4.7.1, which silently ignored it, v5
  // honors it: the Carto basemap is built locally, so carrying the
  // stored projection on it at creation boots on the right projection
  // with zero reload. The OpenFreeMap fallback is a URL the map fetches
  // itself (it carries no projection of its own, verified 2026-11-27);
  // applyStoredProjection then applies the stored wish with one
  // in-place setProjection after the first load.
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
