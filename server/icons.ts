import type { AirKind } from "../shared/craft.js";
import { KIND_FALLBACK_ICON } from "../shared/craft.js";
import { CIVIL_RULES, MILITARY_RULES } from "./icon-tables.js";

export const AIR_FAMILY_ICONS = [
  "narrowbody",
  "widebody",
  "turboprop",
  "bizjet",
  "bizheli",
  "piston",
  "heli",
  "fighter",
  "attack",
  "transport",
  "tanker_air",
  "isr",
  "milheli",
] as const;
export type AirFamilyIcon = (typeof AIR_FAMILY_ICONS)[number];

export interface ResolveAirIconArgs {
  kind: AirKind; // typed to the air union — sea kinds cannot be passed
  callsign?: string | null;
  faaModel?: string | null; // FaaRecord.model, e.g. "737-8DR"
  faaMfr?: string | null; // FaaRecord.mfr, e.g. "BOEING"
  pack?: ReadonlySet<string>; // pack icon names (IconPack.names()); undefined/empty ≡ family-only behavior
}

/** Uppercase, strip spaces and hyphens (737-8DR → 7378DR, FALCON XP → FALCONXP). */
export function normalizeModel(v: string | null | undefined): string {
  return (v ?? "").toUpperCase().replace(/[\s-]/g, "");
}

const normMfr = (v: string | null | undefined): string => (v ?? "").toUpperCase();

/**
 * A table entry → MapLibre image name: the entry's pack name when the
 * caller's pack set contains it, else the entry's family (identical to
 * pre-pack behavior when pack is undefined/empty or the name is not in it).
 */
function resolveRule(rule: { pack?: string; family: string }, pack?: ReadonlySet<string>): string {
  if (rule.pack !== undefined && pack !== undefined && pack.has(rule.pack)) return rule.pack;
  return rule.family;
}

// The military callsign table and the ordered FAA model table live in
// server/icon-tables.ts (MILITARY_RULES / CIVIL_RULES) — moved there in the
// icon-pack work so pack-name curation sits with the table data.

function militaryIcon(callsign: string | null | undefined, pack?: ReadonlySet<string>): string {
  const cs = (callsign ?? "").toUpperCase();
  for (const r of MILITARY_RULES) if (r.re.test(cs)) return resolveRule(r, pack);
  return "fighter";
}

/**
 * Resolve the MapLibre icon image name for an aircraft.
 * Order: military kind → callsign table; civil → FAA model table; then
 * kind fallback. Returns a family name (or a pack name when `pack` is given
 * and the matched entry's pack name is in the set).
 */
export function resolveAirIcon(args: ResolveAirIconArgs): string {
  const { kind, callsign, faaModel, faaMfr, pack } = args;
  if (kind === "military") return militaryIcon(callsign, pack);
  const model = normalizeModel(faaModel);
  if (model !== "") {
    const mfr = normMfr(faaMfr);
    for (const r of CIVIL_RULES) {
      if ((r.mfr === undefined || r.mfr.some((f) => mfr.includes(f))) && r.re.test(model)) {
        return resolveRule(r, pack);
      }
    }
  }
  return KIND_FALLBACK_ICON[kind];
}
