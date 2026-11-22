import { describe, it, expect } from "vitest";
import {
  TILE_HALF,
  clampCenter,
  boxesFor,
  composeTiles,
} from "../server/ais-tiles.js";

describe("clampCenter", () => {
  it("passes through in-range centers", () => {
    expect(clampCenter({ lat: 12.5, lon: -70.25 })).toEqual({ lat: 12.5, lon: -70.25 });
  });

  it("clamps lat so lat±10 stays in [-90, 90]", () => {
    expect(clampCenter({ lat: 89, lon: 0 }).lat).toBe(80);
    expect(clampCenter({ lat: -95, lon: 0 }).lat).toBe(-80);
    expect(clampCenter({ lat: 80, lon: 0 }).lat).toBe(80);
    expect(clampCenter({ lat: -80, lon: 0 }).lat).toBe(-80);
  });

  it("clamps lon so lon±10 stays in [-180, 180]", () => {
    expect(clampCenter({ lat: 0, lon: 175 }).lon).toBe(170);
    expect(clampCenter({ lat: 0, lon: -185 }).lon).toBe(-170);
    expect(clampCenter({ lat: 0, lon: 170 }).lon).toBe(170);
    expect(clampCenter({ lat: 0, lon: -170 }).lon).toBe(-170);
  });
});

describe("boxesFor", () => {
  it("emits [[minLat,minLon],[maxLat,maxLon]] around the center", () => {
    expect(boxesFor({ lat: 0, lon: 0 })).toEqual([
      [-TILE_HALF, -TILE_HALF],
      [TILE_HALF, TILE_HALF],
    ]);
    expect(boxesFor({ lat: 40, lon: -74 })).toEqual([
      [30, -84],
      [50, -64],
    ]);
  });

  it("clamps before boxing so bounds stay valid at the edges", () => {
    expect(boxesFor({ lat: 89, lon: 175 })).toEqual([
      [70, 160],
      [90, 180],
    ]);
    expect(boxesFor({ lat: -95, lon: -185 })).toEqual([
      [-90, -180],
      [-70, -160],
    ]);
  });
});

describe("composeTiles", () => {
  const home = { lat: 40, lon: -74 };
  const follow = { lat: 10, lon: 100 };

  it("returns [home, follow] when both are distinct", () => {
    expect(composeTiles(home, follow)).toEqual([home, follow]);
  });

  it("drops nulls in any position", () => {
    expect(composeTiles(home, null)).toEqual([home]);
    expect(composeTiles(null, follow)).toEqual([follow]);
    expect(composeTiles(null, null)).toEqual([]);
  });

  it("dedups follow when equal to home within 1e-9", () => {
    expect(composeTiles(home, home)).toEqual([home]);
    expect(composeTiles(home, { lat: home.lat + 5e-10, lon: home.lon })).toEqual([home]);
    expect(composeTiles(home, { lat: home.lat, lon: home.lon + 5e-10 })).toEqual([home]);
  });

  it("keeps tiles that differ by more than 1e-9", () => {
    const near = { lat: home.lat + 1e-6, lon: home.lon };
    expect(composeTiles(home, near)).toEqual([home, near]);
    const justOut = { lat: home.lat + 1e-8, lon: home.lon };
    expect(composeTiles(home, justOut)).toEqual([home, justOut]);
  });

  it("caps at 2 tiles", () => {
    expect(composeTiles(home, follow).length).toBeLessThanOrEqual(2);
  });

  it("clamps centers, so clamped duplicates collapse to one tile", () => {
    expect(composeTiles({ lat: 89, lon: 0 }, { lat: 85, lon: 0 })).toEqual([
      { lat: 80, lon: 0 },
    ]);
  });
});
