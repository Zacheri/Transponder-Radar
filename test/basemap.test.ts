import { describe, it, expect } from "vitest";
import { OPENFREEMAP_STYLE_URL, cartoStyle, probeCarto } from "../src/map/basemap.js";

function tile(bytes: number[], ok = true) {
  return {
    ok,
    status: ok ? 200 : 403,
    headers: { get: () => "image/png" },
    arrayBuffer: async () => new Uint8Array(bytes).buffer,
  };
}

// Returns `first` on the first call, `second` on the second (probeCarto fetches two tiles).
function fetchReturning(first: unknown, second: unknown) {
  let call = 0;
  return (async () => (call++ === 0 ? first : second)) as unknown as typeof fetch;
}

describe("probeCarto", () => {
  it("rejects an empty key without fetching", async () => {
    let called = 0;
    const fetchImpl = (async () => {
      called++;
      return tile([1, 2, 3]);
    }) as unknown as typeof fetch;
    expect(await probeCarto("", fetchImpl)).toBe(false);
    expect(called).toBe(0);
  });

  it("rejects when both tiles are identical (the keyless placeholder)", async () => {
    const fetchImpl = (async () => tile([1, 2, 3, 4])) as unknown as typeof fetch;
    expect(await probeCarto("key", fetchImpl)).toBe(false);
  });

  it("accepts when the two tiles differ (real map)", async () => {
    const fetchImpl = fetchReturning(tile([1, 2, 3, 4]), tile([9, 9, 9]));
    expect(await probeCarto("key", fetchImpl)).toBe(true);
  });

  it("rejects when a tile request is not ok", async () => {
    const fetchImpl = fetchReturning(tile([1, 2, 3], false), tile([4, 5, 6]));
    expect(await probeCarto("key", fetchImpl)).toBe(false);
  });

  it("rejects on network failure", async () => {
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
    for (const t of tiles) expect(t.endsWith("?key=abc")).toBe(true);
    expect(s.layers?.[0]).toEqual({ id: "carto", type: "raster", source: "carto" });
  });

  it("openfreemap fallback is a style URL", () => {
    expect(OPENFREEMAP_STYLE_URL).toBe("https://tiles.openfreemap.org/styles/dark");
  });
});
