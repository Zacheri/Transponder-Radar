import maplibregl from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import { OPENFREEMAP_STYLE_URL, cartoStyle, probeCarto } from "./basemap.js";

export async function createMap(container: HTMLElement): Promise<maplibregl.Map> {
  const apiKey: string = import.meta.env.VITE_CARTO_API_KEY ?? "";
  const style = (await probeCarto(apiKey)) ? cartoStyle(apiKey) : OPENFREEMAP_STYLE_URL;
  const map = new maplibregl.Map({
    container,
    style,
    center: [10, 30],
    zoom: 1.5,
    attributionControl: false,
  });
  map.addControl(new maplibregl.NavigationControl(), "top-right");
  map.addControl(new maplibregl.AttributionControl({ compact: true }), "bottom-right");
  return map;
}
