import type maplibregl from "maplibre-gl";

export const OPENFREEMAP_STYLE_URL = "https://tiles.openfreemap.org/styles/dark";

export function cartoStyle(apiKey: string): maplibregl.StyleSpecification {
  const key = apiKey ? `?apiKey=${apiKey}` : "";
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

export async function probeCarto(
  apiKey: string,
  fetchImpl: typeof fetch = fetch,
): Promise<boolean> {
  if (!apiKey) return false;
  try {
    const res = await fetchImpl(
      `https://a.basemaps.cartocdn.com/dark_all/0/0/0.png?apiKey=${apiKey}`,
    );
    if (!res.ok) return false;
    return (res.headers.get("content-type") ?? "").startsWith("image/");
  } catch {
    return false;
  }
}
