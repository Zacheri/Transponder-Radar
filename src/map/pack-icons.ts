import type maplibregl from "maplibre-gl";
import { isPackIconName } from "../../shared/craft.js";
import { hexToRgb, lineSvgToFill, recolorPixels } from "../../shared/pack-transforms.js";

// Client-side loader for the vendored aircraft icon pack (Task 8). The
// server serves raw pack files under /icons/*; this module fetches them on
// demand (lazy — only names that actually appear on the map), rasterizes
// each into a fixed 96×96 ImageData, and registers it with the map
// (addImage pixelRatio 2 → displayed at 48 logical px). Colors come from
// the /icons/list entries (ruling P7 — the server computes them from the
// resolver tables); the loader never computes a color itself.
//
// Browser-only by design (DOM canvas / <img> decode / fetch) — verification
// is the Task 7 catalog page + the user's browser; no unit tests per repo
// convention.

const SIZE = 96;

interface ListEntry {
  style: "filled" | "line" | "gapfill";
  color: string;
  cropTopRatio?: number;
}

export interface PackIconLoader {
  /**
   * Register the given pack names with the map. Resolves to the set of
   * successfully registered names (incl. ones already registered);
   * non-pack names (family/sea icons) are ignored. Never rejects —
   * per-name failures (404 / decode / empty raster) are tracked via
   * failed() and retried on the next ensure().
   */
  ensure(names: Iterable<string>): Promise<ReadonlySet<string>>;
  /** Pack names that have failed at least once and are not yet registered. */
  failed(): ReadonlySet<string>;
}

export function createPackIconLoader(
  map: maplibregl.Map,
  opts: { fetchImpl?: typeof fetch } = {},
): PackIconLoader {
  const doFetch = opts.fetchImpl ?? fetch;
  const cached = new Map<string, ImageData>();
  const inFlight = new Map<string, Promise<boolean>>();
  const failed = new Set<string>();
  let listPromise: Promise<Map<string, ListEntry>> | null = null;
  let styleReloadRegistered = false;

  // GET /icons/list — one cached fetch per loader (style / color /
  // cropTopRatio per name). A rejected promise is discarded so a transient
  // failure (pack still downloading, server restarting) can be retried.
  const list = (): Promise<Map<string, ListEntry>> => {
    if (listPromise === null) {
      listPromise = doFetch("/icons/list")
        .then((r) => {
          if (!r.ok) throw new Error(`/icons/list: HTTP ${r.status}`);
          return r.json() as Promise<{
            entries: { name: string; style: string; color: string; cropTopRatio?: number }[];
          }>;
        })
        .then((body) => new Map(body.entries.map((e) => [e.name, e as ListEntry])))
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
   * Rasterize a pd gap-fill scan: draw the top-view crop
   * [0, 0, w, h·cropTopRatio] into the fixed canvas, then paper→silhouette —
   * the scans are white paper + dark ink (OPAQUE; two of the four are even
   * JPEGs), so: alpha = lum < 128 ? 255 : 0 (ink kept, paper gone) and every
   * surviving pixel is tinted `color` directly (the ink is dark, so
   * recolorPixels' near-white rule would not reach it).
   */
  async function rasterizeGapfill(url: string, cropTopRatio: number, color: string): Promise<ImageData | null> {
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
      const ratio = cropTopRatio > 0 && cropTopRatio <= 1 ? cropTopRatio : 1;
      const data = drawFitted(img, 0, 0, w, Math.max(1, Math.round(h * ratio)));
      if (!data) return null;
      const px = data.data;
      for (let i = 0; i + 3 < px.length; i += 4) {
        const lum = 0.2126 * px[i] + 0.7152 * px[i + 1] + 0.0722 * px[i + 2];
        px[i + 3] = lum < 128 ? 255 : 0;
      }
      const [cr, cg, cb] = hexToRgb(color);
      for (let i = 0; i + 3 < px.length; i += 4) {
        if (px[i + 3] > 0) {
          px[i] = cr;
          px[i + 1] = cg;
          px[i + 2] = cb;
        }
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

  // One fetch+transform+register per name at a time (in-flight dedupe):
  // concurrent ensure() calls for the same name share the promise.
  const ensureOne = (name: string): Promise<boolean> => {
    const existing = inFlight.get(name);
    if (existing) return existing;
    const p = (async () => {
      try {
        const e = (await list()).get(name);
        if (!e) throw new Error(`not in /icons/list: ${name}`);
        let data: ImageData | null;
        if (e.style === "gapfill") {
          data = await rasterizeGapfill(iconUrl(name), e.cropTopRatio ?? 1, e.color);
        } else {
          const r = await doFetch(iconUrl(name));
          if (!r.ok) throw new Error(`GET ${name}: HTTP ${r.status}`);
          const text = await r.text();
          // line (rk): clean-fill transform first (single colored layer);
          // filled (pw): raw svg, body is fill:#ffffff. Both end up colored
          // by the same recolorPixels pass on the raster.
          data = await rasterizeSvg(e.style === "line" ? lineSvgToFill(text, e.color) : text);
          if (data) recolorPixels(data.data, hexToRgb(e.color));
        }
        if (!data || !hasOpaque(data.data)) throw new Error("empty raster");
        cached.set(name, data);
        map.addImage(name, data, { pixelRatio: 2 });
        failed.delete(name);
        return true;
      } catch {
        failed.add(name);
        return false;
      } finally {
        inFlight.delete(name);
      }
    })();
    inFlight.set(name, p);
    return p;
  };

  // A basemap switch (Carto probe → OpenFreeMap fallback) rebuilds the style
  // and drops custom images — re-add everything cached, once.
  const registerStyleReload = (): void => {
    if (styleReloadRegistered) return;
    styleReloadRegistered = true;
    map.on("style.load", () => {
      for (const [name, data] of cached) {
        if (map.hasImage(name)) continue;
        try {
          map.addImage(name, data, { pixelRatio: 2 });
        } catch {
          /* map in teardown — ignore */
        }
      }
    });
  };

  const ensure = async (names: Iterable<string>): Promise<ReadonlySet<string>> => {
    const ok = new Set<string>();
    const pending: Promise<void>[] = [];
    for (const name of names) {
      if (!isPackIconName(name)) continue; // family/sea icons register via icons.ts
      if (map.hasImage(name)) {
        ok.add(name);
        continue;
      }
      pending.push(
        ensureOne(name).then((s) => {
          if (s) ok.add(name);
        }),
      );
    }
    await Promise.all(pending);
    if (ok.size > 0) registerStyleReload();
    return ok;
  };

  return { ensure, failed: () => failed };
}
