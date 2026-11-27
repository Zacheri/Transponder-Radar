import { clampZonesBoost, type ZonesCfg } from "../ui/zones-cfg.js";
import { isValidBox, type Region } from "./regions.js";
import type { ZonesConfigV2Wire, ZonesSectionWire } from "./ws.js";

// zones.config v2 assembly (spec 2026-11-27 §E): the single pure source of
// the wire config — auto knobs pass through verbatim, sections come from the
// user's boosted ADS-B regions. main.ts calls it on every change and on
// every socket open.

// Wire cap (spec §D): more boosted sections than this cannot be funded from
// the surplus anyway.
export const ZONES_MAX_SECTIONS = 6;

export function buildZonesConfig(regions: Region[], cfg: ZonesCfg): ZonesConfigV2Wire {
  const sections: ZonesSectionWire[] = [];
  for (const r of regions) {
    if (sections.length >= ZONES_MAX_SECTIONS) break;
    // AIS is a push feed — there is no poll to fund, so AIS sections never
    // reach the wire (the server would poll them pointlessly otherwise).
    if (r.kind !== "adsb" || !r.boost?.enabled || !isValidBox(r.b)) continue;
    sections.push({
      id: r.id,
      kinds: r.boost.kinds,
      boostMs: clampZonesBoost(r.boost.boostMs),
      b: r.b,
    });
  }
  return { kinds: cfg.kinds, boostMs: cfg.boostMs, auto: cfg.auto, sections };
}
