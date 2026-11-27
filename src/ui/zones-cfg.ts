import { AIR_KINDS } from "../../shared/craft.js";
import type { CraftKind } from "../../shared/craft.js";

// Persisted hot-zone boost config (spec R3, v2 per spec 2026-11-27 §D): the
// checked air kinds + boost interval + auto-zone tuning, stored under
// radar.zonesCfg. Pure parse/serialize over the raw string so the logic is
// unit-testable in Node; defaults live in main, and the parser returns null
// on anything malformed.

/** Auto hot-zone tuning: createMin = members needed to form a zone (2–10);
 * standdownAt = number of boosted sections that must be up before auto zones
 * stand down (0 = never — sections and auto coexist). */
export interface ZonesAuto {
  enabled: boolean;
  createMin: number;
  standdownAt: 0 | 1 | 2;
}

export interface ZonesCfg {
  kinds: CraftKind[];
  boostMs: number;
  auto: ZonesAuto;
}

export const ZONES_CFG_KEY = "radar.zonesCfg";

// Slider bounds and default (spec R3); the slider rewrites its own value
// through this clamp so an out-of-range stored value self-heals on change.
export const ZONES_BOOST_MIN_MS = 10000;
export const ZONES_BOOST_MAX_MS = 120000;
export const ZONES_BOOST_DEFAULT_MS = 30000;

// Auto tuning bounds (spec §D); v1 storage (no auto block) upgrades to these.
export const AUTO_CREATE_MIN = 2;
export const AUTO_CREATE_MAX = 10;

export const DEFAULT_ZONES_AUTO: ZonesAuto = {
  enabled: true,
  createMin: AUTO_CREATE_MIN,
  standdownAt: 0,
};

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
  // Mixed strictness (T3 ruling): shape-corrupt auto (non-object, non-boolean
  // enabled, non-numeric createMin/standdownAt) drops the whole config, like
  // the top-level fields; numeric-but-out-of-set values self-heal — createMin
  // rounds and clamps to 2–10, standdownAt outside {0,1,2} falls back to 0.
  let auto: ZonesAuto = { ...DEFAULT_ZONES_AUTO };
  if (o.auto != null) {
    if (typeof o.auto !== "object" || Array.isArray(o.auto)) return null;
    const a = o.auto as Record<string, unknown>;
    if (a.enabled !== undefined && typeof a.enabled !== "boolean") return null;
    if (a.createMin !== undefined && (typeof a.createMin !== "number" || !Number.isFinite(a.createMin))) return null;
    if (a.standdownAt !== undefined && (typeof a.standdownAt !== "number" || !Number.isFinite(a.standdownAt))) return null;
    const createMin = a.createMin as number | undefined;
    const standdownAt = a.standdownAt as number | undefined;
    auto = {
      enabled: a.enabled !== false,
      createMin:
        createMin === undefined
          ? AUTO_CREATE_MIN
          : Math.min(AUTO_CREATE_MAX, Math.max(AUTO_CREATE_MIN, Math.round(createMin))),
      standdownAt: standdownAt === 0 || standdownAt === 1 || standdownAt === 2 ? standdownAt : 0,
    };
  }
  return { kinds: [...new Set(o.kinds as CraftKind[])], boostMs: o.boostMs, auto };
}

export function serializeZonesCfg(cfg: ZonesCfg): string {
  return JSON.stringify({ kinds: cfg.kinds, boostMs: cfg.boostMs, auto: cfg.auto });
}
