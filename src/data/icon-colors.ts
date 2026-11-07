import { KINDS, type CraftKind } from "../../shared/craft.js";

// Per-category map icon colors (phase 2 of the iconpack gap curation). The
// user's overrides live in localStorage under radar.iconColors; anything
// absent falls back to the kind's default (KINDS[kind].color). The state is
// a plain object and every function is pure over it (storage injected) so
// the logic is unit-testable in Node.

export type IconColorState = Partial<Record<CraftKind, string>>;

export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

const KEY = "radar.iconColors";
const HEX_RE = /^#[0-9a-f]{6}$/i;

export function loadIconColors(storage: StorageLike): IconColorState {
  let raw: string | null;
  try {
    raw = storage.getItem(KEY);
  } catch {
    return {};
  }
  if (raw === null || raw === "") return {};
  try {
    const obj: unknown = JSON.parse(raw);
    if (typeof obj !== "object" || obj === null || Array.isArray(obj)) return {};
    const out: IconColorState = {};
    for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
      if (Object.hasOwn(KINDS, k) && typeof v === "string" && HEX_RE.test(v)) {
        out[k as CraftKind] = v.toLowerCase();
      }
    }
    return out;
  } catch {
    return {};
  }
}

export function saveIconColors(state: IconColorState, storage: StorageLike): void {
  try {
    if (Object.keys(state).length === 0) storage.removeItem(KEY);
    else storage.setItem(KEY, JSON.stringify(state));
  } catch {
    // storage unavailable
  }
}

export function effectiveColor(kind: CraftKind, state: IconColorState): string {
  return state[kind] ?? KINDS[kind].color;
}

/** Returns a NEW state (the input is not mutated). hex null = clear the override. */
export function setKindColor(state: IconColorState, kind: CraftKind, hex: string | null): IconColorState {
  if (!Object.hasOwn(KINDS, kind)) throw new Error(`unknown kind: ${String(kind)}`);
  if (hex !== null && !HEX_RE.test(hex)) throw new Error(`bad color: ${String(hex)}`);
  const next: IconColorState = { ...state };
  if (hex === null) delete next[kind];
  else next[kind] = hex.toLowerCase();
  return next;
}
