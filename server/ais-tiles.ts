export type TileCenter = { lat: number; lon: number };
export type BoundingBoxes = [[number, number], [number, number]]; // [[minLat,minLon],[maxLat,maxLon]]

export const TILE_HALF = 10; // 20° boxes

export function clampCenter(c: TileCenter): TileCenter {
  return {
    lat: Math.min(90 - TILE_HALF, Math.max(-90 + TILE_HALF, c.lat)),
    lon: Math.min(180 - TILE_HALF, Math.max(-180 + TILE_HALF, c.lon)),
  };
}

export function boxesFor(center: TileCenter): BoundingBoxes {
  const c = clampCenter(center);
  return [
    [c.lat - TILE_HALF, c.lon - TILE_HALF],
    [c.lat + TILE_HALF, c.lon + TILE_HALF],
  ];
}

export function composeTiles(
  home: TileCenter | null,
  follow: TileCenter | null,
): TileCenter[] {
  const tiles: TileCenter[] = [];
  if (home) tiles.push(clampCenter(home));
  if (follow) {
    const f = clampCenter(follow);
    const dup = tiles.some(
      (t) => Math.abs(t.lat - f.lat) < 1e-9 && Math.abs(t.lon - f.lon) < 1e-9,
    );
    if (!dup) tiles.push(f);
  }
  return tiles;
}
