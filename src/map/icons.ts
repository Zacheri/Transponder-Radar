import type maplibregl from "maplibre-gl";
import { ICON_URLS } from "./icon-urls.js";

const PIXEL_RATIO = 2;

// maplibre-gl's loadImage() cannot decode SVG (it wraps the bytes in an
// image/png blob for createImageBitmap). Rasterize through the browser's
// native <img> SVG decoder and hand MapLibre the ImageData instead.
async function rasterizeSvg(url: string): Promise<ImageData> {
  const img = new Image();
  img.src = url;
  await img.decode();
  const canvas = document.createElement("canvas");
  canvas.width = img.naturalWidth * PIXEL_RATIO;
  canvas.height = img.naturalHeight * PIXEL_RATIO;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("2d context unavailable");
  ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
  return ctx.getImageData(0, 0, canvas.width, canvas.height);
}

export function registerIcons(map: maplibregl.Map): Promise<void> {
  return Promise.all(
    Object.entries(ICON_URLS).map(async ([name, url]) => {
      if (map.hasImage(name)) return;
      const data = await rasterizeSvg(url);
      map.addImage(name, data, { pixelRatio: PIXEL_RATIO });
    }),
  ).then(() => undefined);
}
