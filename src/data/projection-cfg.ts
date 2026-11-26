import type { StorageLike } from "./icon-colors.js";

// Globe/flat projection choice, persisted under radar.projection
// ("globe" | "mercator"). Motion-cfg posture: a throwing or unreadable
// storage yields the default (globe); only a stored "mercator" means flat;
// save always writes the value (no removeItem-on-default).

const KEY = "radar.projection";

export type ProjectionKind = "globe" | "mercator";

export function loadProjection(storage: StorageLike): ProjectionKind {
  let raw: string | null;
  try {
    raw = storage.getItem(KEY);
  } catch {
    return "globe";
  }
  return raw === "mercator" ? "mercator" : "globe";
}

export function saveProjection(kind: ProjectionKind, storage: StorageLike): void {
  try {
    storage.setItem(KEY, kind);
  } catch {
    // storage unavailable
  }
}
