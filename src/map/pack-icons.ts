import type maplibregl from "maplibre-gl";
import { isPackIconName, parseColorKey } from "../../shared/craft.js";
import { createRasterCache, type RasterCache } from "./raster-cache.js";
import {
  hexToRgb,
  lineSvgToFill,
  recolorPixels,
  rotFitSize,
  type CropRect,
  type GapfillRot,
} from "../../shared/pack-transforms.js";

// Client-side loader for the vendored aircraft icon pack. The
// server serves raw pack files under /icons/*; this module fetches them on
// demand (lazy — only names that actually appear on the map), rasterizes
// each into a fixed 96×96 ImageData, and registers it with the map
// (addImage pixelRatio 2 → displayed at 48 logical px).
//
// Color picker (phase 2): registrations are COLOR-KEYED (`base@hex`) — the
// raster bakes color in, so one image name per (art, color) pair. The
// fetch+transform result is cached per BASE as a pre-color raster (white
// silhouette + alpha); each color-key registration tints a copy:
// gapfill → every alpha pixel to the hex; line/filled → recolorPixels
// (near-white body → exact hex, painted detail kept).
//
// Pre-color rasters also persist in IndexedDB (raster-cache.ts, keyed by
// the /icons/list version), so a reload skips fetch + decode for icons seen
// before; memory still wins, and every cache failure degrades to today's
// network path.
//
// Browser-only by design (DOM canvas / <img> decode / fetch) — verification
// is the catalog page + the user's browser; no unit tests per repo
// convention.

const SIZE = 96;

interface ListEntry {
  style: "filled" | "line" | "gapfill";
  crop?: CropRect; // gapfill only: the region of the file that is the top view
  rot?: GapfillRot; // gapfill only: clockwise rotation applied after the crop
  th?: number; // gapfill only: binarize threshold override (default 128)
}

export interface PackIconLoader {
  /**
   * Register the given COLOR-KEYED pack names (`base@hex`) with the map.
   * Resolves to the set of successfully registered keys (incl. ones already
   * registered); non-pack names (family/sea icons) are ignored. Never
   * rejects — per-name failures (404 / decode / empty raster) are tracked
   * via failed() (base names) and retried on the next ensure().
   */
  ensure(names: Iterable<string>): Promise<ReadonlySet<string>>;
  /** Pack base names that have failed at least once and are not yet registered. */
  failed(): ReadonlySet<string>;
}

export function createPackIconLoader(
  map: maplibregl.Map,
  opts: { fetchImpl?: typeof fetch } = {},
): PackIconLoader {
  const doFetch = opts.fetchImpl ?? fetch;
  const cached = new Map<string, ImageData>(); // base → PRE-COLOR raster
  const registered = new Set<string>(); // color keys registered on the map
  const inFlight = new Map<string, Promise<boolean>>(); // key → promise
  const failed = new Set<string>(); // base names
  let listPromise: Promise<{ version: string; entries: Map<string, ListEntry> }> | null = null;
  let raster: RasterCache | null = null;
  let styleReloadRegistered = false;

  // GET /icons/list — one cached fetch per loader (version + style / color /
  // crop per name). A rejected promise is discarded so a transient failure
  // (pack still downloading, server restarting) can be retried. A missing
  // version (older server) reads as "" and disables the raster cache.
  const list = (): Promise<{ version: string; entries: Map<string, ListEntry> }> => {
    if (listPromise === null) {
      listPromise = doFetch("/icons/list")
        .then((r) => {
          if (!r.ok) throw new Error(`/icons/list: HTTP ${r.status}`);
          return r.json() as Promise<{
            version?: string;
            entries: { name: string; style: string; color: string; crop?: CropRect }[];
          }>;
        })
        .then((body) => ({
          version: typeof body.version === "string" ? body.version : "",
          entries: new Map(body.entries.map((e) => [e.name, e as ListEntry])),
        }))
        .catch((e) => {
          listPromise = null;
          throw e;
        });
    }
    return listPromise;
  };

  function newContext(): CanvasRenderingContext2D | null {
    const canvas = document.createElement("canvas");
    canvas.width = SIZE;
    canvas.height = SIZE;
    return canvas.getContext("2d");
  }

  /** Draw a decoded image into a fresh SIZE×SIZE canvas, centered, preserving aspect. */
  function drawFitted(img: HTMLImageElement, sx: number, sy: number, sw: number, sh: number): ImageData | null {
    const ctx = newContext();
    if (!ctx) return null;
    const scale = Math.min(SIZE / sw, SIZE / sh);
    ctx.drawImage(img, sx, sy, sw, sh, (SIZE - sw * scale) / 2, (SIZE - sh * scale) / 2, sw * scale, sh * scale);
    return ctx.getImageData(0, 0, SIZE, SIZE);
  }

  /**
   * Like drawFitted, but for gapfill crops: the (sw,sh) source region is
   * drawn centered, then rotated clockwise about the canvas center (the
   * on-screen extent follows rotFitSize). rot=undefined ≡ drawFitted.
   */
  function drawFittedRot(
    img: HTMLImageElement,
    sx: number,
    sy: number,
    sw: number,
    sh: number,
    rot: GapfillRot | undefined,
  ): ImageData | null {
    const ctx = newContext();
    if (!ctx) return null;
    const { ew, eh } = rotFitSize(rot, sw, sh);
    const scale = Math.min(SIZE / ew, SIZE / eh);
    ctx.translate(SIZE / 2, SIZE / 2);
    if (rot) ctx.rotate((rot * Math.PI) / 180);
    ctx.drawImage(img, sx, sy, sw, sh, (-sw * scale) / 2, (-sh * scale) / 2, sw * scale, sh * scale);
    return ctx.getImageData(0, 0, SIZE, SIZE);
  }

  /**
   * Decode an SVG string through the browser's <img> (MapLibre's loadImage
   * cannot decode SVG — see icons.ts) into the fixed canvas.
   */
  async function rasterizeSvg(svg: string): Promise<ImageData | null> {
    const url = URL.createObjectURL(new Blob([svg], { type: "image/svg+xml" }));
    try {
      const img = new Image();
      img.src = url;
      await img.decode();
      if (img.naturalWidth === 0 || img.naturalHeight === 0) return null;
      return drawFitted(img, 0, 0, img.naturalWidth, img.naturalHeight);
    } catch {
      return null;
    } finally {
      URL.revokeObjectURL(url);
    }
  }

  /**
   * Rasterize a pd gap-fill scan into a PRE-COLOR alpha mask: draw the
   * top-view crop rectangle (fractions of the file; no crop = the whole
   * image) into the fixed canvas, then paper→silhouette — the scans are
   * white paper + dark ink (OPAQUE; two of the originals are even JPEGs,
   * one a GIF), so alpha = lum < th ? 255 : 0 (ink kept, paper gone; th
   * defaults to 128, raised per-entry for dithered/gray scans). The
   * color-key registration tints the mask (every alpha pixel → hex).
   */
  async function rasterizeGapfill(
    url: string,
    crop: CropRect | undefined,
    rot: GapfillRot | undefined,
    th: number | undefined,
  ): Promise<ImageData | null> {
    const r = await doFetch(url);
    if (!r.ok) throw new Error(`GET ${url}: HTTP ${r.status}`);
    const img = new Image();
    const objUrl = URL.createObjectURL(await r.blob());
    try {
      img.src = objUrl;
      await img.decode();
      const w = img.naturalWidth;
      const h = img.naturalHeight;
      if (w === 0 || h === 0) return null;
      const sx = Math.max(0, Math.min(1, crop?.x ?? 0));
      const sy = Math.max(0, Math.min(1, crop?.y ?? 0));
      const sw = Math.max(0, Math.min(1 - sx, crop?.w ?? 1));
      const sh = Math.max(0, Math.min(1 - sy, crop?.h ?? 1));
      const data = drawFittedRot(
        img,
        sx * w,
        sy * h,
        Math.max(1, Math.round(sw * w)),
        Math.max(1, Math.round(sh * h)),
        rot,
      );
      if (!data) return null;
      const px = data.data;
      const cut = th ?? 128;
      for (let i = 0; i + 3 < px.length; i += 4) {
        const lum = 0.2126 * px[i] + 0.7152 * px[i + 1] + 0.0722 * px[i + 2];
        px[i + 3] = lum < cut ? 255 : 0;
      }
      return data;
    } finally {
      URL.revokeObjectURL(objUrl);
    }
  }

  function hasOpaque(data: Uint8ClampedArray): boolean {
    for (let i = 3; i < data.length; i += 4) {
      if (data[i] > 0) return true;
    }
    return false;
  }

  const iconUrl = (name: string): string => `/icons/${encodeURIComponent(name)}`;

  // Tint a PRE-COLOR raster copy for one color key: gapfill masks take a
  // full alpha pass (every alpha pixel → exact hex); line/filled take
  // recolorPixels (near-white body → exact hex, painted detail kept).
  function tintFor(base: string, style: ListEntry["style"], hex: string): ImageData {
    const pre = cached.get(base);
    if (!pre) throw new Error(`no pre-color raster for ${base}`);
    const data = new ImageData(new Uint8ClampedArray(pre.data), pre.width, pre.height);
    if (style === "gapfill") {
      const [cr, cg, cb] = hexToRgb(hex);
      const px = data.data;
      for (let i = 0; i + 3 < px.length; i += 4) {
        if (px[i + 3] > 0) {
          px[i] = cr;
          px[i + 1] = cg;
          px[i + 2] = cb;
        }
      }
    } else {
      recolorPixels(data.data, hexToRgb(hex));
    }
    return data;
  }

  // Fetch+transform once per BASE; register once per (base, color) key.
  // In-flight dedupe is per key (two colors of the same base may race).
  const ensureOne = (key: string): Promise<boolean> => {
    const existing = inFlight.get(key);
    if (existing) return existing;
    const { name, hex } = parseColorKey(key);
    const p = (async () => {
      try {
        if (hex === null) throw new Error(`not a color key: ${key}`);
        const listing = await list();
        const e = listing.entries.get(name);
        if (!e) throw new Error(`not in /icons/list: ${name}`);
        let pre = cached.get(name);
        if (pre === undefined) {
          const rc = (raster ??= createRasterCache(SIZE, listing.version));
          const hit = await rc.get(name);
          if (hit !== null && hasOpaque(hit.data)) {
            pre = hit;
          } else {
            pre = await fetchPrecolor(name, e);
            void rc.set(name, pre);
          }
          cached.set(name, pre);
        }
        styles.set(name, e.style);
        const data = tintFor(name, e.style, hex);
        // Guarded: a style.load re-add can register the same key between
        // the ensure() hasImage check and here (unconditional addImage
        // would throw "Image already exists" and mark a live icon failed).
        if (!map.hasImage(key)) map.addImage(key, data, { pixelRatio: 2 });
        registered.add(key);
        failed.delete(name);
        return true;
      } catch {
        failed.add(name);
        return false;
      } finally {
        inFlight.delete(key);
      }
    })();
    inFlight.set(key, p);
    return p;
  };

  async function fetchPrecolor(name: string, e: ListEntry): Promise<ImageData> {
    let data: ImageData | null;
    if (e.style === "gapfill") {
      data = await rasterizeGapfill(iconUrl(name), e.crop, e.rot, e.th);
    } else {
      const r = await doFetch(iconUrl(name));
      if (!r.ok) throw new Error(`GET ${name}: HTTP ${r.status}`);
      const text = await r.text();
      // Pre-color = white: line (rk) gets the clean-fill transform in white
      // (single layer); filled (pw, and pd filled silhouettes) raster raw —
      // the body is near-white. The color-key tint lands the exact hex.
      data = await rasterizeSvg(e.style === "line" ? lineSvgToFill(text, "#ffffff") : text);
    }
    if (!data || !hasOpaque(data.data)) throw new Error("empty raster");
    return data;
  }

  // A basemap switch (Carto probe → OpenFreeMap fallback) rebuilds the style
  // and drops custom images — re-add every registered key from the pre-color
  // cache (no network), once. A registered key's style is always known
  // (its pre-color fetch cached it).
  const styles = new Map<string, ListEntry["style"]>();
  const registerStyleReload = (): void => {
    if (styleReloadRegistered) return;
    styleReloadRegistered = true;
    map.on("style.load", () => {
      for (const key of [...registered]) {
        if (map.hasImage(key)) continue;
        const { name, hex } = parseColorKey(key);
        const style = styles.get(name);
        if (style === undefined || hex === null) {
          registered.delete(key);
          continue;
        }
        try {
          map.addImage(key, tintFor(name, style, hex), { pixelRatio: 2 });
        } catch {
          registered.delete(key); // map in teardown — ignore
        }
      }
    });
  };

  const ensure = async (keys: Iterable<string>): Promise<ReadonlySet<string>> => {
    const ok = new Set<string>();
    const pending: Promise<void>[] = [];
    for (const key of keys) {
      const { name, hex } = parseColorKey(key);
      // color keys only: family/sea icons register via icons.ts, and a bare
      // pack name has no color to register
      if (!isPackIconName(name) || hex === null) continue;
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
    if (ok.size > 0) registerStyleReload();
    return ok;
  };

  return { ensure, failed: () => failed };
}
