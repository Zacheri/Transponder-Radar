import { describe, it, expect } from "vitest";
import { OPENFREEMAP_STYLE_URL, cartoStyle, probeCarto } from "../src/map/basemap.js";

function fakeFetch(status: number, contentType = "image/png") {
  return (async () => ({
    ok: status >= 200 && status < 300,
    status,
    headers: {
      get: (name: string) =>
        name.toLowerCase() === "content-type" ? contentType : null,
    },
  })) as unknown as typeof fetch;
}

describe("probeCarto", () => {
  it("rejects an empty key without fetching", async () => {
    let called = 0;
    const fetchImpl = (async () => {
      called++;
      return { ok: true, headers: { get: () => "image/png" } };
    }) as unknown as typeof fetch;
    expect(await probeCarto("", fetchImpl)).toBe(false);
    expect(called).toBe(0);
  });

  it("accepts a 200 image response", async () => {
    expect(await probeCarto("key", fakeFetch(200))).toBe(true);
  });

  it("rejects a 403 (revoked key)", async () => {
    expect(await probeCarto("key", fakeFetch(403))).toBe(false);
  });

  it("rejects a 429 (rate limited)", async () => {
    expect(await probeCarto("key", fakeFetch(429))).toBe(false);
  });

  it("rejects a non-image content type", async () => {
    expect(await probeCarto("key", fakeFetch(200, "text/html"))).toBe(false);
  });

  it("rejects network failure", async () => {
    const fetchImpl = (async () => {
      throw new Error("offline");
    }) as unknown as typeof fetch;
    expect(await probeCarto("key", fetchImpl)).toBe(false);
  });
});

describe("cartoStyle", () => {
  it("builds a raster style with the key on all four subdomains", () => {
    const s = cartoStyle("abc");
    expect(s.version).toBe(8);
    const carto = s.sources?.carto;
    expect(carto?.type).toBe("raster");
    const tiles = (carto as any).tiles as string[];
    expect(tiles).toHaveLength(4);
    for (const t of tiles) expect(t.endsWith("?apiKey=abc")).toBe(true);
    expect(s.layers?.[0]).toEqual({ id: "carto", type: "raster", source: "carto" });
  });

  it("openfreemap fallback is a style URL", () => {
    expect(OPENFREEMAP_STYLE_URL).toBe("https://tiles.openfreemap.org/styles/dark");
  });
});
