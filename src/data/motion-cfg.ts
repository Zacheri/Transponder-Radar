import type { StorageLike } from "./icon-colors.js";

// Smooth-motion toggle, persisted under radar.motion. Icon-colors posture:
// a throwing or unreadable storage yields the default (on); only a stored
// "0" means off; save always writes "1"/"0" (no removeItem-on-default).

const KEY = "radar.motion";

export function loadMotion(storage: StorageLike): boolean {
  let raw: string | null;
  try {
    raw = storage.getItem(KEY);
  } catch {
    return true;
  }
  return raw !== "0";
}

export function saveMotion(on: boolean, storage: StorageLike): void {
  try {
    storage.setItem(KEY, on ? "1" : "0");
  } catch {
    // storage unavailable
  }
}
