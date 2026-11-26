import type { LonLat } from "../../shared/geo.js";

// User-drawn highlight regions (spec 2026-11-26 §B): client-only, persisted
// under radar.regions. Everything here is pure over the localStorage string.
// v1 rects are plain min/max — NO antimeridian wrap (same ruling as the
// boost grid): a box never straddles ±180, longitudes are stored verbatim.

export type RegionKind = "adsb" | "ais";

/** [[minLat,minLon],[maxLat,maxLon]] — the server AIS-box wire shape. */
export type RegionBox = [[number, number], [number, number]];

export interface Region {
  id: string;
  kind: RegionKind;
  b: RegionBox;
}

export const REGION_KINDS: readonly RegionKind[] = ["adsb", "ais"];

export const REGION_COLORS: Record<RegionKind, string> = {
  adsb: "#4fc3f7",
  ais: "#4db6ac",
};

// A box under this wide in either degree is rejected (~111 m). The drawer's
// pixel gate is the real UX guard; this only keeps junk out of storage.
export const MIN_DEG = 0.001;

export function regionLabel(kind: RegionKind): string {
  return kind === "adsb" ? "ADS-B area" : "AIS area";
}

/** Corner span in degrees (row caption): lon = E–W, lat = N–S. */
export function sizeDeg(region: Region): { lon: number; lat: number } {
  const [[minLat, minLon], [maxLat, maxLon]] = region.b;
  return { lon: maxLon - minLon, lat: maxLat - minLat };
}

/** Two corners → normalized box, any drag direction. No validation here. */
export function normalizeBox(a: LonLat, b: LonLat): RegionBox {
  return [
    [Math.min(a.lat, b.lat), Math.min(a.lon, b.lon)],
    [Math.max(a.lat, b.lat), Math.max(a.lon, b.lon)],
  ];
}

const isPoint = (v: unknown): v is [number, number] =>
  Array.isArray(v) && v.length === 2 && v.every((n) => typeof n === "number" && Number.isFinite(n));

const isBox = (v: unknown): v is RegionBox =>
  Array.isArray(v) && v.length === 2 && (v as unknown[]).every(isPoint);

const isSane = (b: RegionBox): boolean => {
  const [[minLat, minLon], [maxLat, maxLon]] = b;
  return Math.abs(minLat) <= 90 && Math.abs(maxLat) <= 90 && minLat <= maxLat && minLon <= maxLon;
};

const isKind = (v: unknown): v is RegionKind =>
  typeof v === "string" && REGION_KINDS.includes(v as RegionKind);

/** Total garbage (bad JSON, non-array, empty string, null) → []; bad entries drop. */
export function parseRegions(raw: string | null): Region[] {
  if (raw === null || raw === "") return [];
  let obj: unknown;
  try {
    obj = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(obj)) return [];
  const out: Region[] = [];
  for (const entry of obj) {
    if (typeof entry !== "object" || entry === null) continue;
    const { id, kind, b } = entry as Partial<Region>;
    if (typeof id !== "string" || id === "" || !isKind(kind) || !isBox(b) || !isSane(b)) continue;
    out.push({ id, kind, b });
  }
  return out;
}

export function serializeRegions(list: Region[]): string {
  return JSON.stringify(list);
}

const newId = (): string => `r${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;

/**
 * Two dragged corners (any direction) → appended region. Returns the input
 * list unchanged with region: null on out-of-bounds lat, non-finite coords,
 * or a degenerate (< MIN_DEG per side) box. nextId is injectable for tests.
 */
export function addRegion(
  list: Region[],
  kind: RegionKind,
  a: LonLat,
  b: LonLat,
  nextId: () => string = newId,
): { list: Region[]; region: Region | null } {
  if (![a.lat, a.lon, b.lat, b.lon].every((n) => Number.isFinite(n))) return { list, region: null };
  if (Math.abs(a.lat) > 90 || Math.abs(b.lat) > 90) return { list, region: null };
  const box = normalizeBox(a, b);
  const [[minLat, minLon], [maxLat, maxLon]] = box;
  if (maxLat - minLat < MIN_DEG || maxLon - minLon < MIN_DEG) return { list, region: null };
  const region: Region = { id: nextId(), kind, b: box };
  return { list: [...list, region], region };
}

export function removeRegion(list: Region[], id: string): Region[] {
  return list.filter((r) => r.id !== id);
}
