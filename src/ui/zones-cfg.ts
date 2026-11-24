import { AIR_KINDS } from "../../shared/craft.js";
import type { CraftKind } from "../../shared/craft.js";

// Persisted hot-zone boost config (spec R3): the checked air kinds + boost
// interval, stored under radar.zonesCfg. Pure parse/serialize over the raw
// string so the logic is unit-testable in Node; defaults live in main, and
// the parser returns null on anything malformed.

export interface ZonesCfg {
  kinds: CraftKind[];
  boostMs: number;
}

export const ZONES_CFG_KEY = "radar.zonesCfg";

// Slider bounds and default (spec R3); the slider rewrites its own value
// through this clamp so an out-of-range stored value self-heals on change.
export const ZONES_BOOST_MIN_MS = 10000;
export const ZONES_BOOST_MAX_MS = 120000;
export const ZONES_BOOST_DEFAULT_MS = 30000;

export function clampZonesBoost(ms: number): number {
  if (!Number.isFinite(ms)) return ZONES_BOOST_DEFAULT_MS;
  return Math.min(ZONES_BOOST_MAX_MS, Math.max(ZONES_BOOST_MIN_MS, ms));
}

export function parseZonesCfg(raw: string | null): ZonesCfg | null {
  if (raw === null || raw === "") return null;
  let obj: unknown;
  try {
    obj = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof obj !== "object" || obj === null || Array.isArray(obj)) return null;
  const o = obj as Record<string, unknown>;
  if (
    !Array.isArray(o.kinds) ||
    !o.kinds.every((k) => typeof k === "string" && (AIR_KINDS as readonly string[]).includes(k))
  ) {
    return null;
  }
  if (typeof o.boostMs !== "number" || !Number.isFinite(o.boostMs)) return null;
  return { kinds: [...new Set(o.kinds as CraftKind[])], boostMs: o.boostMs };
}

export function serializeZonesCfg(cfg: ZonesCfg): string {
  return JSON.stringify({ kinds: cfg.kinds, boostMs: cfg.boostMs });
}
