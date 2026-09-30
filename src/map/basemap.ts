import type maplibregl from "maplibre-gl";

export const OPENFREEMAP_STYLE_URL = "https://tiles.openfreemap.org/styles/dark";

export function cartoStyle(apiKey: string): maplibregl.StyleSpecification {
  const key = apiKey ? `?key=${apiKey}` : "";
  const tiles = ["a", "b", "c", "d"].map(
    (s) => `https://${s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}.png${key}`,
  );
  return {
    version: 8,
    sources: {
      carto: {
        type: "raster",
        tiles,
        tileSize: 256,
        attribution: "© OpenStreetMap contributors © CARTO",
      },
    },
    layers: [{ id: "carto", type: "raster", source: "carto" }],
  };
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

// Carto serves the "API KEY REQUIRED" placeholder as a normal 200 image/png, so
// HTTP status can't tell a valid key from a missing/revoked one. But the
// placeholder is the same image at every coordinate, whereas real tiles differ.
// Fetching two tiles at different zoom levels and comparing bytes therefore
// detects a working key.
export async function probeCarto(
  apiKey: string,
  fetchImpl: typeof fetch = fetch,
): Promise<boolean> {
  if (!apiKey) return false;
  try {
    const [resA, resB] = await Promise.all([
      fetchImpl("https://a.basemaps.cartocdn.com/dark_all/0/0/0.png?key=" + apiKey),
      fetchImpl("https://a.basemaps.cartocdn.com/dark_all/5/17/11.png?key=" + apiKey),
    ]);
    if (!resA.ok || !resB.ok) return false;
    const a = new Uint8Array(await resA.arrayBuffer());
    const b = new Uint8Array(await resB.arrayBuffer());
    return !bytesEqual(a, b);
  } catch {
    return false;
  }
}
