import type maplibregl from "maplibre-gl";
import { parseColorKey } from "../../shared/craft.js";
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

// map icons are pre-rasterized with color BAKED in, so a per-category color
// cannot repaint an existing registration: registrations are keyed by
// `base@hex` and tinted at registration. The family/sea silhouettes are one
// body fill + optional dark detail (e.g. the tanker's black portholes), so
// the tint repays every non-dark alpha pixel to the exact hex and keeps the
// dark detail (same lum<128 rule as the gapfill pass in pack-icons.ts).

const precolorCache = new Map<string, ImageData>(); // base → raster before tint

function tint(data: ImageData, hex: string): ImageData {
  const m = hex.match(/^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i);
  if (!m) throw new Error(`bad hex: ${hex}`);
  const tr = parseInt(m[1], 16);
  const tg = parseInt(m[2], 16);
  const tb = parseInt(m[3], 16);
  const out = new ImageData(new Uint8ClampedArray(data.data), data.width, data.height);
  const px = out.data;
  for (let i = 0; i + 3 < px.length; i += 4) {
    if (px[i + 3] === 0) continue;
    const lum = 0.2126 * px[i] + 0.7152 * px[i + 1] + 0.0722 * px[i + 2];
    if (lum < 128) continue; // dark detail stays
    px[i] = tr;
    px[i + 1] = tg;
    px[i + 2] = tb;
  }
  return out;
}

export interface KindIconRegistrar {
  /**
   * Register the given COLOR-KEYED family/sea names (`base@hex`). Pack
   * names (pw:/rk:/pd:) are ignored — they register via the pack loader.
   * Resolves to the set of successfully registered keys; never rejects
   * (per-key decode failures are swallowed, same as the pack loader).
   */
  ensure(keys: Iterable<string>): Promise<ReadonlySet<string>>;
}

export function createKindIconRegistrar(map: maplibregl.Map): KindIconRegistrar {
  const registered = new Set<string>();

  const ensureOne = (key: string): Promise<boolean> => {
    const { name, hex } = parseColorKey(key);
    if (hex === null || !Object.hasOwn(ICON_URLS, name)) return Promise.resolve(false);
    return (async () => {
      let pre = precolorCache.get(name);
      if (pre === undefined) {
        pre = await rasterizeSvg(ICON_URLS[name]);
        precolorCache.set(name, pre);
      }
      const data = tint(pre, hex);
      // Guarded: a style.load re-add can register the same key between the
      // hasImage check and here (unconditional addImage would throw "Image
      // already exists").
      if (!map.hasImage(key)) map.addImage(key, data, { pixelRatio: PIXEL_RATIO });
      registered.add(key);
      return true;
    })().catch(() => false);
  };

  const ensure = async (keys: Iterable<string>): Promise<ReadonlySet<string>> => {
    const ok = new Set<string>();
    const pending: Promise<void>[] = [];
    for (const key of keys) {
      if (map.hasImage(key)) {
        ok.add(key);
        continue;
      }
      pending.push(
        ensureOne(key).then((s) => {
          if (s) ok.add(key);
        }),
      );
    }
    await Promise.all(pending);
    return ok;
  };

  // A basemap switch (Carto probe → OpenFreeMap fallback) rebuilds the style
  // and drops custom images — re-add everything registered from the pre-color
  // cache (no network), once.
  map.on("style.load", () => {
    void ensure(new Set(registered)).then((ok) => {
      for (const k of [...registered]) if (!ok.has(k)) registered.delete(k);
    });
  });

  return { ensure };
}
