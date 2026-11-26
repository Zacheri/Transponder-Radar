import type { StorageLike } from "./icon-colors.js";
import {
  addRegion,
  parseRegions,
  removeRegion,
  serializeRegions,
  type Region,
  type RegionBox,
  type RegionKind,
} from "./regions.js";

// Map-section reducer (spec 2026-11-26 §B, T3): the radar.regions state
// transitions + persistence in one place, storage injected so main.ts stays
// wiring-only (icon-colors posture: nothing here ever throws — an
// unavailable storage degrades to memory-only state).

const KEY = "radar.regions";

/** Boot read: corrupt/absent/throwing storage all yield []. */
export function bootRegions(storage: StorageLike): Region[] {
  let raw: string | null;
  try {
    raw = storage.getItem(KEY);
  } catch {
    return [];
  }
  return parseRegions(raw);
}

function persist(list: Region[], storage: StorageLike): void {
  try {
    storage.setItem(KEY, serializeRegions(list));
  } catch {
    // storage unavailable
  }
}

/**
 * Commit a drawer rect (already normalized by the draw FSM). Rejections
 * (off-globe lat, non-finite, degenerate box) return the input list SAME
 * reference with region: null and write nothing.
 */
export function commitRegion(
  state: Region[],
  kind: RegionKind,
  rect: RegionBox,
  storage: StorageLike,
): { list: Region[]; region: Region | null } {
  const a = { lat: rect[0][0], lon: rect[0][1] };
  const b = { lat: rect[1][0], lon: rect[1][1] };
  const res = addRegion(state, kind, a, b);
  if (res.region) persist(res.list, storage);
  return res;
}

/** Remove by id; an unknown id returns the input list and writes nothing. */
export function dropRegion(state: Region[], id: string, storage: StorageLike): Region[] {
  const list = removeRegion(state, id);
  if (list.length === state.length) return state;
  persist(list, storage);
  return list;
}
