import type { AirKind } from "../shared/craft.js";
import { KIND_FALLBACK_ICON } from "../shared/craft.js";

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
  callsign?: string;
  faaModel?: string | null; // FaaRecord.model, e.g. "737-8DR"
  faaMfr?: string | null; // FaaRecord.mfr, e.g. "BOEING"
}

/** Uppercase, strip spaces and hyphens (737-8DR → 7378DR, FALCON XP → FALCONXP). */
export function normalizeModel(v: string | null | undefined): string {
  return (v ?? "").toUpperCase().replace(/[\s-]/g, "");
}

const normMfr = (v: string | null | undefined): string => (v ?? "").toUpperCase();

// ── Military callsign table (spec §3.1; order significant) ─────────────────
// Callsigns are uppercased before matching. Tokens are word-anchored on BOTH
// ends (\b…\b) so C5 cannot match C550 and C17 cannot match C172; the prefix
// tokens E3/P3/U2 (valid prefixes of real variants: E-3G, P-3C, U-28) keep
// the leading boundary only — hence the separate rule. No table hit →
// fighter fallback.

interface MilRule {
  re: RegExp;
  icon: AirFamilyIcon;
}

const MIL_RULES: MilRule[] = [
  { re: /\b(KC135|KC10|KC46|KCTC)\b/, icon: "tanker_air" },
  { re: /\b(CH47|CH53|UH60|UH6|MH60|SH60|H60|AH64|BLACKHAWK)\b/, icon: "milheli" },
  { re: /\bA10\b/, icon: "attack" },
  { re: /\b(C130|C17|C5|C21|A400M|VC25|C40)\b/, icon: "transport" },
  { re: /\b(RC135|EP3|TACAMO|AWACS|GRIFIN|REAPER|MQ9|RQ4)\b/, icon: "isr" },
  { re: /\b(E3|P3|U2)/, icon: "isr" }, // prefix tokens (E-3G, P-3C, U-28) — no trailing boundary
  { re: /\b(F15|F16|F18|F22|F35)\b/, icon: "fighter" },
];

function militaryIcon(callsign: string | undefined): AirFamilyIcon {
  const cs = (callsign ?? "").toUpperCase();
  for (const r of MIL_RULES) if (r.re.test(cs)) return r.icon;
  return "fighter";
}

// ── FAA model table (spec §3.2; ordered; helis before fixed-wing) ───────────
// mfr (when present) = the normalized MFR must contain at least one of the
// listed substrings. Real-data quirks encoded here: Cessna numbers carry no
// C prefix (172S, 208B); F28F is Fokker jet OR Enstrom 28F heli (mfr decides);
// FALCON/HAWKER are name-style models; military helis often carry the operator
// as MFR (match by model only).

interface FaaRule {
  mfr?: string[];
  re: RegExp;
  icon: AirFamilyIcon;
}

const FAA_RULES: FaaRule[] = [
  // helis — bizheli
  { mfr: ["ROBINSON"], re: /^R66/, icon: "bizheli" },
  { mfr: ["BELL"], re: /^B(407|429|52|76)/, icon: "bizheli" },
  { mfr: ["AGUSTA"], re: /^AW(139|169)/, icon: "bizheli" },
  { mfr: ["SIKORSKY"], re: /^S(76|92|202|300)/, icon: "bizheli" },
  // helis — light
  { mfr: ["ROBINSON"], re: /^R(22|44)/, icon: "heli" },
  { mfr: ["BELL"], re: /^B206/, icon: "heli" },
  { mfr: ["AIRBUS"], re: /^(EC120|EC130|H125|H135|H145)/, icon: "heli" },
  { re: /^K120(?!0)/, icon: "heli" }, // K120 — not K1200 (Kiwi)
  { mfr: ["ENSTROM"], re: /^F?28/, icon: "heli" }, // 28F, 280FX (coded F28F/280FX)
  // helis — defensive (civil-kind records of military types; MFR often = operator)
  { re: /^(CH47|CH53|UH60|MH60|SH60|AH64)/, icon: "milheli" },
  // bizjet
  { mfr: ["GULFSTREAM"], re: /^G(150|280|550|650)/, icon: "bizjet" },
  { mfr: ["CESSNA"], re: /^C[56]\d\d/, icon: "bizjet" }, // C500…C680
  { re: /^CJ\d/, icon: "bizjet" }, // CJ1/CJ2/CJ3 Starlet (person MFRs exist)
  { mfr: ["BOMBARDIER", "CANADAIR"], re: /^CL6/, icon: "bizjet" },
  { mfr: ["DASSAULT"], re: /^(FALCON|F50|F500|F5XR|F7X|F70|F10|MD31[123])/, icon: "bizjet" },
  { mfr: ["LEARJET", "TEXTRON"], re: /^(L420|LJ\d|L100|L200|L3\d{3})/, icon: "bizjet" },
  { mfr: ["PIPER"], re: /^P(28|35)([A-Z]|$)/, icon: "bizjet" },
  {
    mfr: ["HAWKER BEECHCRAFT", "HAWKER SIDDELEY", "RAYTHEON", "TEXTRON"],
    re: /^HAWKER[0-9A-Z]/,
    icon: "bizjet",
  },
  {
    mfr: ["HAWKER BEECHCRAFT", "HAWKER SIDDELEY", "RAYTHEON", "TEXTRON"],
    re: /^HAWK[0-9]/,
    icon: "bizjet",
  },
  // widebody
  { mfr: ["BOEING"], re: /^(747|767|777|787)/, icon: "widebody" },
  { mfr: ["AIRBUS"], re: /^A3[3-8]/, icon: "widebody" },
  { mfr: ["MCDONNELL"], re: /^MD1[01]/, icon: "widebody" },
  { re: /^(IL96|TU204|AN124)/, icon: "widebody" },
  // narrowbody
  { mfr: ["BOEING"], re: /^(737|757|717|B717)/, icon: "narrowbody" },
  { mfr: ["AIRBUS"], re: /^A3(1[89]|2[01])/, icon: "narrowbody" },
  { mfr: ["EMBRAER"], re: /^(E[12]\d\d|EMB\d)/, icon: "narrowbody" },
  { mfr: ["BOMBARDIER"], re: /^CRJ/, icon: "narrowbody" },
  { mfr: ["MCDONNELL"], re: /^MD(8\d|9\d)/, icon: "narrowbody" },
  { mfr: ["DOUGLAS", "BOEING"], re: /^DC9/, icon: "narrowbody" },
  { mfr: ["BRITISH AEROSPACE", "BAE"], re: /^146/, icon: "narrowbody" },
  { mfr: ["FOKKER"], re: /^(F100|F70|F28)/, icon: "narrowbody" },
  { re: /^F70([A-Z]|$)/, icon: "bizjet" }, // F70 without FOKKER mfr defaults to Falcon (spec trap)
  { mfr: ["SAAB"], re: /^(SAAB)?340/, icon: "narrowbody" },
  // turboprop
  { re: /^ATR/, icon: "turboprop" }, // ATR42/72 — real MFRs vary (ATR, AEROSPATIALE…)
  { re: /^(DHC6|DHC8|TWINOTTER|DASH)/, icon: "turboprop" }, // VIKING/DEHAVILLAND…
  { mfr: ["CESSNA"], re: /^(208|CARAVAN)/, icon: "turboprop" },
  { mfr: ["PILATUS"], re: /^PC12/, icon: "turboprop" },
  { mfr: ["SAAB", "SIPA"], re: /^(SAAB)?2000/, icon: "turboprop" },
  { mfr: ["SAAB", "SIPA"], re: /^S200$/, icon: "turboprop" },
  { mfr: ["BEECH", "TEXTRON"], re: /^B(200|300|350|360)/, icon: "turboprop" }, // King Air
  { mfr: ["FOKKER", "FAIRCHILD"], re: /^F27/, icon: "turboprop" },
  { re: /^(D228|YAK40)/, icon: "turboprop" },
  // piston / light
  { mfr: ["CESSNA"], re: /^[1-7]\d\d(?!\d)/, icon: "piston" }, // 172S, 182T, 206… (208 → turboprop above)
  { mfr: ["BEECH"], re: /^B(25|35|55|58|99)([A-Z]|$)/, icon: "piston" }, // B350 → King Air above
  { mfr: ["PIPER"], re: /^PA\d/, icon: "piston" },
  { mfr: ["DIAMOND"], re: /^DA\d/, icon: "piston" },
  { re: /^SR2[02]/, icon: "piston" },
  { re: /^L410/, icon: "piston" },
  { re: /^L(18|36)/, icon: "piston" },
  { mfr: ["SCHLEICHER"], re: /^(ASK|ARCUS|DUO|SECOR)/, icon: "piston" },
  { mfr: ["RANS"], re: /^S\d/, icon: "piston" }, // ultralights (S7, S20…)
  { mfr: ["QUICKSILVER"], re: /^Q200/, icon: "piston" },
];

/**
 * Resolve the MapLibre icon image name for an aircraft.
 * Order: military kind → callsign table; civil → FAA model table; then
 * kind fallback. Always returns a family name (never a kind name).
 */
export function resolveAirIcon(args: ResolveAirIconArgs): string {
  const { kind, callsign, faaModel, faaMfr } = args;
  if (kind === "military") return militaryIcon(callsign);
  const model = normalizeModel(faaModel);
  if (model !== "") {
    const mfr = normMfr(faaMfr);
    for (const r of FAA_RULES) {
      if ((r.mfr === undefined || r.mfr.some((f) => mfr.includes(f))) && r.re.test(model)) {
        return r.icon;
      }
    }
  }
  return KIND_FALLBACK_ICON[kind];
}
