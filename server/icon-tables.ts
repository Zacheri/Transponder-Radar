// Icon resolution tables for resolveAirIcon (server/icons.ts). Moved here
// (Task 5, icon pack) from server/icons.ts so the vendored-pack curation can
// live beside its consumer's resolution rule; both tables gain an optional
// `pack` name per entry (pw:/rk:/pd: — see shared/craft.ts PACK_NAME_PREFIXES).
//
// Resolution rule (in icons.ts): entry.pack present in the caller's pack set
// → emit entry.pack; else emit entry.family (identical to pre-pack behavior).

export interface MilitaryRule {
  re: RegExp; // tested against the uppercased callsign
  anchor: "word" | "prefix"; // word: \b on the leading edge (and trailing for base-only); prefix: leading \b only
  pack?: string; // pack name emitted when present in the caller's pack set (Task 5 curates military; Task 6 adds civil)
  family: string; // MapLibre air-family image name (fallback)
}

export interface CivilRule {
  mfr?: string[]; // normalized (uppercased) MFR must contain at least one of these substrings
  re: RegExp; // tested against the normalized model (uppercase, no spaces/hyphens)
  pack?: string; // Task 6 adds pack names (data-driven vs ACFTREF); none yet
  family: string;
}

// ── Military callsign table (spec §3.1; order significant; one entry per token) ──
// Callsigns are uppercased before matching. Word tokens are anchored \b at the
// leading edge and anchor the base with a \w* suffix (letter-suffix variants:
// UH60A, C130J, KC46A — the parked minor from the 2026-10-11 review). Three
// tokens stay base-only (strict \b…\b) where a digit suffix is a DIFFERENT
// aircraft: C17 (C172 = Cessna 172, pinned test), C5 (C550 = Citation V,
// pinned test), P1 (P180 = Piaggio P-180, which carries its own pack art).
// The prefix tokens E3/P3/U2 (valid prefixes of real variants: E-3G, P-3C,
// U-28) keep the leading boundary only — hence anchor "prefix". No table hit
// → fighter fallback.
//
// Pack curation (Task 5) is designator-driven: every covered gapTargets
// designator (server/iconpack-sources.json, checked against
// data/icons/index.json) gets its pack name on the matching token entry; new
// entries were added where the token table had none (K35E, S61, UH1, NH90,
// MI24, B52, KC2, C141, V22, P1, P8, E8, SB39). Uncovered designators (B2,
// F14, F117, E4, AH64) and non-designator tokens (KCTC, CH53, C21, VC25, C40,
// EP3, TACAMO, AWACS, GRIFIN, REAPER, MQ9) stay family-only.

export const MILITARY_RULES: MilitaryRule[] = [
  // ── tanker_air ─────────────────────────────────────────────────────────
  { re: /\bKC135\w*\b/, anchor: "word", pack: "rk:R135", family: "tanker_air" }, // KC-135 → RC-135 art (same C-135 airframe family)
  { re: /\bKC10\w*\b/, anchor: "word", pack: "pd:KC10", family: "tanker_air" },
  { re: /\bKC46\w*\b/, anchor: "word", pack: "rk:KC46", family: "tanker_air" },
  { re: /\bKCTC\w*\b/, anchor: "word", family: "tanker_air" }, // training-tanker callsign; not a gapTarget
  { re: /\bK35E\w*\b/, anchor: "word", pack: "rk:K35E", family: "tanker_air" }, // gapTarget K35E (KC-135E); KC135\w* already covers "KC135E" callsigns
  // ── milheli ────────────────────────────────────────────────────────────
  { re: /\bCH47\w*\b/, anchor: "word", pack: "pd:CH47", family: "milheli" },
  { re: /\bCH53\w*\b/, anchor: "word", family: "milheli" }, // not a gapTarget
  { re: /\bUH60\w*\b/, anchor: "word", pack: "rk:H60", family: "milheli" },
  { re: /\bUH6\w*\b/, anchor: "word", pack: "rk:H60", family: "milheli" },
  { re: /\bMH60\w*\b/, anchor: "word", pack: "rk:H60", family: "milheli" },
  { re: /\bSH60\w*\b/, anchor: "word", pack: "rk:H60", family: "milheli" },
  { re: /\bH60\w*\b/, anchor: "word", pack: "rk:H60", family: "milheli" },
  { re: /\bAH64\w*\b/, anchor: "word", family: "milheli" }, // gapTarget with no pack art (B2/F14/F117/E4/AH64 stay family-only)
  { re: /\bBLACKHAWK\w*\b/, anchor: "word", pack: "rk:H60", family: "milheli" }, // UH-60 Black Hawk callsign — the H60 art depicts exactly this
  { re: /\bS61\w*\b/, anchor: "word", pack: "rk:S61", family: "milheli" },
  { re: /\bUH1\w*\b/, anchor: "word", pack: "rk:UH1", family: "milheli" },
  { re: /\bNH90\w*\b/, anchor: "word", pack: "rk:NH90", family: "milheli" },
  { re: /\bMI24\w*\b/, anchor: "word", pack: "rk:MI24", family: "milheli" },
  // ── attack ─────────────────────────────────────────────────────────────
  { re: /\bA10\w*\b/, anchor: "word", pack: "rk:A10", family: "attack" },
  // B-52: no bomber family exists in the 13 air families; a strategic bomber is
  // closer to attack (combat role) than to the fighter fallback.
  { re: /\bB52\w*\b/, anchor: "word", pack: "rk:B52", family: "attack" },
  // ── transport ──────────────────────────────────────────────────────────
  { re: /\bC130\w*\b/, anchor: "word", pack: "rk:C130", family: "transport" },
  { re: /\bC17\b/, anchor: "word", pack: "rk:C17", family: "transport" }, // strict: C172 (Cessna 172) must not match
  { re: /\bC5\b/, anchor: "word", pack: "pd:C5", family: "transport" }, // strict: C550 (Citation V) must not match
  { re: /\bC21\w*\b/, anchor: "word", family: "transport" }, // not a gapTarget
  // Token widened from A400M to the A400 base + suffix (plan: A400\w*);
  // pw:A400 also exists — rk: used per the plan's curation value.
  { re: /\bA400\w*\b/, anchor: "word", pack: "rk:A400", family: "transport" },
  { re: /\bVC25\w*\b/, anchor: "word", family: "transport" }, // not a gapTarget
  { re: /\bC40\w*\b/, anchor: "word", family: "transport" }, // not a gapTarget
  { re: /\bKC2\w*\b/, anchor: "word", pack: "rk:KC2", family: "transport" }, // Kawasaki C-2
  { re: /\bC141\w*\b/, anchor: "word", pack: "pd:C141", family: "transport" },
  // The pack has no bare rk:V22 — only "V22 fast"/"V22 slow" rotor variants;
  // "fast" (in-flight depiction) fits the live map.
  { re: /\bV22\w*\b/, anchor: "word", pack: "rk:V22 fast", family: "transport" },
  // ── isr (word tokens) ──────────────────────────────────────────────────
  { re: /\bRC135\w*\b/, anchor: "word", pack: "rk:R135", family: "isr" },
  { re: /\bEP3\w*\b/, anchor: "word", family: "isr" }, // not a gapTarget
  { re: /\bTACAMO\w*\b/, anchor: "word", family: "isr" }, // not a gapTarget
  { re: /\bAWACS\w*\b/, anchor: "word", family: "isr" }, // not a gapTarget
  { re: /\bGRIFIN\w*\b/, anchor: "word", family: "isr" }, // not a gapTarget
  { re: /\bREAPER\w*\b/, anchor: "word", family: "isr" }, // not a gapTarget
  // No MQ-9 art exists in the pack → family-only. (The plan's "MQ9|Q4"
  // shorthand resolves designator-driven: Q4 is a gapTarget, MQ9 is not.)
  { re: /\bMQ9\w*\b/, anchor: "word", family: "isr" },
  { re: /\bRQ4\w*\b/, anchor: "word", pack: "rk:Q4", family: "isr" }, // gapTarget Q4 (Global Hawk)
  { re: /\bP1\b/, anchor: "word", pack: "rk:P1", family: "isr" }, // strict: P1\w* would swallow P180 (Piaggio P-180 — different aircraft, own art)
  { re: /\bP8\w*\b/, anchor: "word", pack: "rk:P8", family: "isr" },
  { re: /\bE8\w*\b/, anchor: "word", pack: "rk:E8", family: "isr" },
  // ── isr (prefix tokens — leading boundary only) ────────────────────────
  // pd:E3 is NOT in the current index (only pd:C5/KC10/C141/CH47 are); the
  // table points at it anyway — emission is gated on pack.has, so production
  // stays family-only until a real pd:E3 is curated in.
  { re: /\bE3/, anchor: "prefix", pack: "pd:E3", family: "isr" },
  { re: /\bP3/, anchor: "prefix", pack: "rk:P3", family: "isr" },
  { re: /\bU2/, anchor: "prefix", pack: "rk:U2", family: "isr" },
  // ── fighter ────────────────────────────────────────────────────────────
  { re: /\bF15\w*\b/, anchor: "word", pack: "rk:F15", family: "fighter" },
  // pw:F16 (filled art) also exists; rk: used per the plan's curation value —
  // keeps the military curation uniformly rk:/pd: (pw: preference applies to
  // the civil table in Task 6, where rk lacks the type).
  { re: /\bF16\w*\b/, anchor: "word", pack: "rk:F16", family: "fighter" },
  // No bare rk:F18 in the pack — only F18H (F/A-18B legacy Hornet) and
  // F18S (F/A-18E Super Hornet); the Super Hornet is the current standard model.
  { re: /\bF18\w*\b/, anchor: "word", pack: "rk:F18S", family: "fighter" },
  { re: /\bF22\w*\b/, anchor: "word", pack: "rk:F22", family: "fighter" },
  { re: /\bF35\w*\b/, anchor: "word", pack: "rk:F35", family: "fighter" },
  { re: /\bSB39\w*\b/, anchor: "word", pack: "rk:SB39", family: "fighter" }, // Gripen
];

// ── FAA model table (spec §3.2; ordered; helis before fixed-wing) ───────────
// mfr (when present) = the normalized MFR must contain at least one of the
// listed substrings. Real-data quirks encoded here: Cessna numbers carry no
// C prefix (172S, 208B); F28F is Fokker jet OR Enstrom 28F heli (mfr decides);
// FALCON/HAWKER are name-style models; military helis often carry the operator
// as MFR (match by model only).
// Moved verbatim from server/icons.ts (icon → family rename); pack names are
// added by Task 6 (data-driven curation vs ACFTREF).

export const CIVIL_RULES: CivilRule[] = [
  // helis — bizheli
  { mfr: ["ROBINSON"], re: /^R66/, family: "bizheli" },
  { mfr: ["BELL"], re: /^B(407|429|52|76)/, family: "bizheli" },
  { mfr: ["AGUSTA"], re: /^AW(139|169)/, family: "bizheli" },
  { mfr: ["SIKORSKY"], re: /^S(76|92|202|300)/, family: "bizheli" },
  // helis — light
  { mfr: ["ROBINSON"], re: /^R(22|44)/, family: "heli" },
  { mfr: ["BELL"], re: /^B206/, family: "heli" },
  { mfr: ["AIRBUS"], re: /^(EC120|EC130|H125|H135|H145)/, family: "heli" },
  { re: /^K120(?!0)/, family: "heli" }, // K120 — not K1200 (Kiwi)
  { mfr: ["ENSTROM"], re: /^F?28/, family: "heli" }, // 28F, 280FX (coded F28F/280FX)
  // helis — defensive (civil-kind records of military types; MFR often = operator)
  { re: /^(CH47|CH53|UH60|MH60|SH60|AH64)/, family: "milheli" },
  // bizjet
  { mfr: ["GULFSTREAM"], re: /^G(150|280|550|650)/, family: "bizjet" },
  { mfr: ["CESSNA"], re: /^C[56]\d\d/, family: "bizjet" }, // C500…C680
  { re: /^CJ\d/, family: "bizjet" }, // CJ1/CJ2/CJ3 Starlet (person MFRs exist)
  { mfr: ["BOMBARDIER", "CANADAIR"], re: /^CL6/, family: "bizjet" },
  { mfr: ["DASSAULT"], re: /^(FALCON|F50|F500|F5XR|F7X|F70|F10|MD31[123])/, family: "bizjet" },
  { mfr: ["LEARJET", "TEXTRON"], re: /^(L420|LJ\d|L100|L200|L3\d{3})/, family: "bizjet" },
  { mfr: ["PIPER"], re: /^P(28|35)([A-Z]|$)/, family: "bizjet" },
  {
    mfr: ["HAWKER BEECHCRAFT", "HAWKER SIDDELEY", "RAYTHEON", "TEXTRON"],
    re: /^HAWKER[0-9A-Z]/,
    family: "bizjet",
  },
  {
    mfr: ["HAWKER BEECHCRAFT", "HAWKER SIDDELEY", "RAYTHEON", "TEXTRON"],
    re: /^HAWK[0-9]/,
    family: "bizjet",
  },
  // widebody
  { mfr: ["BOEING"], re: /^(747|767|777|787)/, family: "widebody" },
  { mfr: ["AIRBUS"], re: /^A3[3-8]/, family: "widebody" },
  { mfr: ["MCDONNELL"], re: /^MD1[01]/, family: "widebody" },
  { re: /^(IL96|TU204|AN124)/, family: "widebody" },
  // narrowbody
  { mfr: ["BOEING"], re: /^(737|757|717|B717)/, family: "narrowbody" },
  { mfr: ["AIRBUS"], re: /^A3(1[89]|2[01])/, family: "narrowbody" },
  { mfr: ["EMBRAER"], re: /^(E[12]\d\d|EMB\d)/, family: "narrowbody" },
  { mfr: ["BOMBARDIER"], re: /^CRJ/, family: "narrowbody" },
  { mfr: ["MCDONNELL"], re: /^MD(8\d|9\d)/, family: "narrowbody" },
  { mfr: ["DOUGLAS", "BOEING"], re: /^DC9/, family: "narrowbody" },
  { mfr: ["BRITISH AEROSPACE", "BAE"], re: /^146/, family: "narrowbody" },
  { mfr: ["FOKKER"], re: /^(F100|F70|F28)/, family: "narrowbody" },
  { re: /^F70([A-Z]|$)/, family: "bizjet" }, // F70 without FOKKER mfr defaults to Falcon (spec trap)
  { mfr: ["SAAB"], re: /^(SAAB)?340/, family: "narrowbody" },
  // turboprop
  { re: /^ATR/, family: "turboprop" }, // ATR42/72 — real MFRs vary (ATR, AEROSPATIALE…)
  { re: /^(DHC6|DHC8|TWINOTTER|DASH)/, family: "turboprop" }, // VIKING/DEHAVILLAND…
  { mfr: ["CESSNA"], re: /^(208|CARAVAN)/, family: "turboprop" },
  { mfr: ["PILATUS"], re: /^PC12/, family: "turboprop" },
  { mfr: ["SAAB", "SIPA"], re: /^(SAAB)?2000/, family: "turboprop" },
  { mfr: ["SAAB", "SIPA"], re: /^S200$/, family: "turboprop" },
  { mfr: ["BEECH", "TEXTRON"], re: /^B(200|300|350|360)/, family: "turboprop" }, // King Air
  { mfr: ["FOKKER", "FAIRCHILD"], re: /^F27/, family: "turboprop" },
  { re: /^(D228|YAK40)/, family: "turboprop" },
  // piston / light
  { mfr: ["CESSNA"], re: /^[1-7]\d\d(?!\d)/, family: "piston" }, // 172S, 182T, 206… (208 → turboprop above)
  { mfr: ["BEECH"], re: /^B(25|35|55|58|99)([A-Z]|$)/, family: "piston" }, // B350 → King Air above
  { mfr: ["PIPER"], re: /^PA\d/, family: "piston" },
  { mfr: ["DIAMOND"], re: /^DA\d/, family: "piston" },
  { re: /^SR2[02]/, family: "piston" },
  { re: /^L410/, family: "piston" },
  { re: /^L(18|36)/, family: "piston" },
  { mfr: ["SCHLEICHER"], re: /^(ASK|ARCUS|DUO|SECOR)/, family: "piston" },
  { mfr: ["RANS"], re: /^S\d/, family: "piston" }, // ultralights (S7, S20…)
  { mfr: ["QUICKSILVER"], re: /^Q200/, family: "piston" },
];
