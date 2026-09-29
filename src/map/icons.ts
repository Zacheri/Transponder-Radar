import type maplibregl from "maplibre-gl";
import { ICON_URLS } from "./icon-urls.js";

export function registerIcons(map: maplibregl.Map): Promise<void> {
  return Promise.all(
    Object.entries(ICON_URLS).map(async ([name, url]) => {
      const { data } = await map.loadImage(url);
      if (!map.hasImage(name)) map.addImage(name, data);
    }),
  ).then(() => undefined);
}
