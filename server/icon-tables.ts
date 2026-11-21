// Icon resolution tables for resolveAirIcon (server/icons.ts). Moved here
// from server/icons.ts so the vendored-pack curation can
// live beside its consumer's resolution rule; both tables gain an optional
// `pack` name per entry (pw:/rk:/pd: — see shared/craft.ts PACK_NAME_PREFIXES).
//
// Resolution rule (in icons.ts): entry.pack present in the caller's pack set
// → emit entry.pack; else emit entry.family (identical to pre-pack behavior).

export interface MilitaryRule {
  re: RegExp; // tested against the uppercased callsign
  anchor: "word" | "prefix"; // word: \b on the leading edge (and trailing for base-only); prefix: leading \b only
  pack?: string; // pack name emitted when present in the caller's pack set
  family: string; // MapLibre air-family image name (fallback)
}

export interface CivilRule {
  mfr?: string[]; // normalized (uppercased) MFR must contain at least one of these substrings
  re: RegExp; // tested against the normalized model (uppercase, no spaces/hyphens)
  pack?: string; // pack name emitted when present in the caller's pack set (data-driven curation vs ACFTREF)
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
// Pack curation is designator-driven: every covered gapTargets
// designator (server/iconpack-sources.json, checked against
// data/icons/index.json) gets its pack name on the matching token entry; new
// entries were added where the token table had none (K35E, S61, UH1, NH90,
// MI24, B52, KC2, C141, V22, P1, P8, E8, SB39, B1, F5E, T38, TOR/TORNADO,
// HAWK, LYNX). The 2026-11-06 gap curation wired the remaining tokens to
// existing art (KCTC→RC-135, C21/C40→737-700, VC25→747-8, EP3→P-3,
// TACAMO→707 (E-6 airframe)). The 2026-11-18 crop audit vetoed the curated
// CH53/MQ9/C141 entries (no clean or usable art at icon size) — those tokens
// fall back to family, tracked in OmittedModels.md. Uncovered designators:
// B2, F14, F117, E4. GRIFIN stays family-only: the RQ-4 art is a different
// airframe than the MQ-4C Triton (OmittedModels.md).

export const MILITARY_RULES: MilitaryRule[] = [
  // ── tanker_air ─────────────────────────────────────────────────────────
  { re: /\bKC135\w*\b/, anchor: "word", pack: "rk:R135", family: "tanker_air" }, // KC-135 → RC-135 art (same C-135 airframe family)
  { re: /\bKC10\w*\b/, anchor: "word", pack: "pd:KC10", family: "tanker_air" },
  { re: /\bKC46\w*\b/, anchor: "word", pack: "rk:KC46", family: "tanker_air" },
  { re: /\bKCTC\w*\b/, anchor: "word", pack: "rk:R135", family: "tanker_air" }, // USN KC-135 variant — RC-135 art (same C-135 airframe)
  { re: /\bK35E\w*\b/, anchor: "word", pack: "rk:K35E", family: "tanker_air" }, // gapTarget K35E (KC-135E); KC135\w* already covers "KC135E" callsigns
  // ── milheli ────────────────────────────────────────────────────────────
  { re: /\bCH47\w*\b/, anchor: "word", pack: "pd:CH47", family: "milheli" },
  { re: /\bCH53\w*\b/, anchor: "word", family: "milheli" }, // vetoed: line art too thin at icon size (OmittedModels)
  { re: /\bUH60\w*\b/, anchor: "word", pack: "rk:H60", family: "milheli" },
  { re: /\bUH6\w*\b/, anchor: "word", pack: "rk:H60", family: "milheli" },
  { re: /\bMH60\w*\b/, anchor: "word", pack: "rk:H60", family: "milheli" },
  { re: /\bSH60\w*\b/, anchor: "word", pack: "rk:H60", family: "milheli" },
  { re: /\bH60\w*\b/, anchor: "word", pack: "rk:H60", family: "milheli" },
  { re: /\bAH64\w*\b/, anchor: "word", pack: "rk:H64", family: "milheli" }, // gapTarget AH64 — Apache art exists as rk:H64 (shared with the civil ^AH64 rule below)
  { re: /\bBLACKHAWK\w*\b/, anchor: "word", pack: "rk:H60", family: "milheli" }, // UH-60 Black Hawk callsign — the H60 art depicts exactly this
  { re: /\bS61\w*\b/, anchor: "word", pack: "rk:S61", family: "milheli" },
  { re: /\bUH1\w*\b/, anchor: "word", pack: "rk:UH1", family: "milheli" },
  { re: /\bNH90\w*\b/, anchor: "word", pack: "rk:NH90", family: "milheli" },
  { re: /\bMI24\w*\b/, anchor: "word", pack: "rk:MI24", family: "milheli" },
  { re: /\bLYNX\w*\b/, anchor: "word", pack: "rk:LYNX", family: "milheli" },
  // ── attack ─────────────────────────────────────────────────────────────
  { re: /\bA10\w*\b/, anchor: "word", pack: "rk:A10", family: "attack" },
  // B-52: no bomber family exists in the 13 air families; a strategic bomber is
  // closer to attack (combat role) than to the fighter fallback.
  { re: /\bB52\w*\b/, anchor: "word", pack: "rk:B52", family: "attack" },
  { re: /\bB1\w*\b/, anchor: "word", pack: "rk:B1 fast", family: "attack" },
  // ── transport ──────────────────────────────────────────────────────────
  { re: /\bC130\w*\b/, anchor: "word", pack: "rk:C130", family: "transport" },
  { re: /\bC17\b/, anchor: "word", pack: "rk:C17", family: "transport" }, // strict: C172 (Cessna 172) must not match
  { re: /\bC5\b/, anchor: "word", pack: "pd:C5", family: "transport" }, // strict: C550 (Citation V) must not match
  { re: /\bC21\w*\b/, anchor: "word", pack: "rk:B737", family: "transport" }, // C-21A = 737-700 derivative
  // Token widened from A400M to the A400 base + suffix (plan: A400\w*);
  // pw:A400 also exists — rk: used per the plan's curation value.
  { re: /\bA400\w*\b/, anchor: "word", pack: "rk:A400", family: "transport" },
  { re: /\bVC25\w*\b/, anchor: "word", pack: "rk:B748", family: "transport" }, // VC-25A = 747-8F airframe
  { re: /\bC40\w*\b/, anchor: "word", pack: "rk:B737", family: "transport" }, // C-40 = 737-based
  { re: /\bKC2\w*\b/, anchor: "word", pack: "rk:KC2", family: "transport" }, // Kawasaki C-2
  { re: /\bC141\w*\b/, anchor: "word", family: "transport" }, // vetoed: sheet top view is drawn diagonal (OmittedModels)
  // The pack has no bare rk:V22 — only "V22 fast"/"V22 slow" rotor variants;
  // "fast" (in-flight depiction) fits the live map.
  { re: /\bV22\w*\b/, anchor: "word", pack: "rk:V22 fast", family: "transport" },
  // ── isr (word tokens) ──────────────────────────────────────────────────
  { re: /\bRC135\w*\b/, anchor: "word", pack: "rk:R135", family: "isr" },
  { re: /\bEP3\w*\b/, anchor: "word", pack: "rk:P3", family: "isr" }, // EP-3E = P-3C airframe
  { re: /\bTACAMO\w*\b/, anchor: "word", pack: "rk:B703", family: "isr" }, // TACAMO = E-6 callsign (707-300 airframe; no free rotodome drawing)
  { re: /\bAWACS\w*\b/, anchor: "word", pack: "rk:E3TF", family: "isr" }, // E-3 — same art as the E3 token
  { re: /\bGRIFIN\w*\b/, anchor: "word", family: "isr" }, // MQ-4C Triton — RQ-4 art is a different airframe (OmittedModels)
  { re: /\bREAPER\w*\b/, anchor: "word", family: "isr" }, // vetoed: no clean top-view crop (OmittedModels)
  { re: /\bMQ9\w*\b/, anchor: "word", family: "isr" }, // vetoed: no clean top-view crop (OmittedModels)
  { re: /\bRQ4\w*\b/, anchor: "word", pack: "rk:Q4", family: "isr" }, // gapTarget Q4 (Global Hawk)
  { re: /\bP1\b/, anchor: "word", pack: "rk:P1", family: "isr" }, // strict: P1\w* would swallow P180 (Piaggio P-180 — different aircraft, own art)
  { re: /\bP8\w*\b/, anchor: "word", pack: "rk:P8", family: "isr" },
  { re: /\bE8\w*\b/, anchor: "word", pack: "rk:E8", family: "isr" },
  // ── isr (prefix tokens — leading boundary only) ────────────────────────
  // E-3 Sentry: the vendored rk pack carries the art (E3CF/E3TF engine
  // variants; TF33 = the classic standard engine). Visually verified:
  // 707 top view + rotodome.
  { re: /\bE3/, anchor: "prefix", pack: "rk:E3TF", family: "isr" },
  { re: /\bP3/, anchor: "prefix", pack: "rk:P3", family: "isr" },
  { re: /\bU2/, anchor: "prefix", pack: "rk:U2", family: "isr" },
  // ── fighter ────────────────────────────────────────────────────────────
  { re: /\bF15\w*\b/, anchor: "word", pack: "rk:F15", family: "fighter" },
  // pw:F16 (filled art) also exists; rk: keeps the military curation
  // uniformly rk:/pd: (the pw: preference applies to civil rules, where rk
  // lacks the type).
  { re: /\bF16\w*\b/, anchor: "word", pack: "rk:F16", family: "fighter" },
  // No bare rk:F18 in the pack — only F18H (F/A-18B legacy Hornet) and
  // F18S (F/A-18E Super Hornet); the Super Hornet is the current standard model.
  { re: /\bF18\w*\b/, anchor: "word", pack: "rk:F18S", family: "fighter" },
  { re: /\bF22\w*\b/, anchor: "word", pack: "rk:F22", family: "fighter" },
  { re: /\bF35\w*\b/, anchor: "word", pack: "rk:F35", family: "fighter" },
  { re: /\bSB39\w*\b/, anchor: "word", pack: "rk:SB39", family: "fighter" }, // Gripen
  { re: /\bF5E\w*\b/, anchor: "word", pack: "rk:F5", family: "fighter" },
  { re: /\bT38\w*\b/, anchor: "word", pack: "rk:T38", family: "fighter" },
  // Tornado: strict base token + TORNADO — a \w* suffix on TOR would swallow
  // unrelated callsigns (TORCH).
  { re: /\bTOR\b/, anchor: "word", pack: "rk:TOR fast", family: "fighter" },
  { re: /\bTORNADO\w*\b/, anchor: "word", pack: "rk:TOR fast", family: "fighter" },
  // Strict: HAWKER (Beech Hawker bizjet) is a different airframe.
  { re: /\bHAWK\b/, anchor: "word", pack: "rk:HAWK", family: "fighter" },
];

// ── FAA model table (spec §3.2; ordered; helis before fixed-wing) ───────────
// mfr (when present) = the normalized MFR must contain at least one of the
// listed substrings. Real-data quirks encoded here: Cessna numbers carry no
// C prefix (172S, 208B); F28F is Fokker jet OR Enstrom 28F heli (mfr decides);
// FALCON/HAWKER are name-style models; military helis often carry the operator
// as MFR (match by model only).
//
// Pack curation is data-driven vs data/faa/ACFTREF.txt: every rule
// below carrying a `pack` field was checked against real FAA MFR MDL CODE
// strings (normalizeModel: uppercase, spaces/hyphens stripped, dots/parens
// survive). pw: art is preferred where both pw: and rk: have the type; rk:
// where pw lacks it. Most-specific rules precede the pre-pack catch rules
// (marked "catch") that they refine; a rule whose pack type the pack lacks
// stays family-only. Curated 2026-11-06: 737-600 (pd:737C), MD-8x/9x
// (pd:MD8), ATR-72 (rk:AT75 — the 72-2xx pd scan was unusable), King Air
// 200/300 (pd:B200), C-295 (rk:C295). Standing no-art gap list (tracked in
// OmittedModels.md): 737 MAX
// 7, Challenger 600/604/605 (CL600-2B16), true DC-9 series, ATR-42, L-410,
// King Air 360 (no B360 code in the registry).

export const CIVIL_RULES: CivilRule[] = [
  // ── helis — bizheli ────────────────────────────────────────────────────
  { mfr: ["ROBINSON"], re: /^R66/, family: "bizheli" },
  // Bare "407"/"429" codes exist in the registry (984/175 ac) alongside the
  // B-prefixed forms; 52/76 keep the required B (bare "52" is too generic)
  { mfr: ["BELL"], re: /^B?(407|429)|^B(52|76)/, family: "bizheli" },
  { mfr: ["BELL"], re: /^525/, family: "heli" }, // 525 — a heli, not a fixed-wing
  // Agusta/Leonardo (AW- and bare-A-coded; "AGUSTA A109"-style model names occur)
  { mfr: ["AGUSTA", "LEONARDO"], re: /^A?GUSTA?A109/, pack: "pw:A109", family: "bizheli" },
  { mfr: ["AGUSTA", "LEONARDO"], re: /^A119|^AW119/, pack: "pw:A119", family: "bizheli" },
  { mfr: ["AGUSTA", "LEONARDO"], re: /^AB139|^AW139|^A139/, pack: "pw:A139", family: "bizheli" },
  { mfr: ["AGUSTA", "LEONARDO"], re: /^AW169|^A169/, pack: "pw:A169", family: "bizheli" },
  { mfr: ["BELL"], re: /^214/, pack: "pw:B214", family: "bizheli" },
  { mfr: ["BELL"], re: /^412/, pack: "pw:B412", family: "bizheli" },
  { mfr: ["SIKORSKY"], re: /^S(76|92|202|300)/, family: "bizheli" },
  // ── helis — light ──────────────────────────────────────────────────────
  { mfr: ["ROBINSON"], re: /^R44/, pack: "pw:R44", family: "heli" },
  { mfr: ["ROBINSON"], re: /^R22/, family: "heli" },
  { mfr: ["BELL"], re: /^206/, pack: "pw:B06", family: "heli" },
  { mfr: ["BELL"], re: /^B206/, family: "heli" }, // custom B-prefixed names (no FAA code)
  { mfr: ["BELL"], re: /^205|^212|^UH1/, pack: "rk:UH1", family: "heli" },
  { mfr: ["AIRBUS"], re: /^EC120|^H120/, pack: "rk:EC20", family: "heli" },
  { mfr: ["AIRBUS"], re: /^EC135|^H135/, pack: "rk:EC35", family: "heli" },
  { mfr: ["AIRBUS"], re: /^H145|^EC145/, pack: "pw:EC45", family: "heli" },
  { mfr: ["AIRBUS"], re: /^(EC130|H125)/, family: "heli" },
  { re: /^K120(?!0)/, family: "heli" }, // K120 — not K1200 (Kiwi)
  { mfr: ["ENSTROM"], re: /^F?28/, family: "heli" }, // 28F, 280FX (coded F28F/280FX)
  { re: /^BK117/, pack: "pw:EC45", family: "heli" }, // Kawasaki BK117 (EC135 line)
  { mfr: ["SIKORSKY"], re: /^S61/, pack: "rk:S61", family: "heli" },
  { mfr: ["SIKORSKY"], re: /^SH3|^HSS2/, pack: "rk:S61", family: "milheli" }, // Sea King (no dedicated art)
  { mfr: ["SIKORSKY"], re: /^S70/, pack: "rk:H60", family: "milheli" }, // S-70 (no dedicated art)
  {
    mfr: ["AEROSPATIALE", "EUROCOPTER", "AIRBUS HELICOPTERS"],
    re: /^SA365/,
    pack: "pw:AS65",
    family: "heli",
  }, // Dauphin
  // ── helis — defensive (civil-kind records of military types; MFR often = operator) ──
  { re: /^CH47/, pack: "pd:CH47", family: "milheli" },
  { re: /^(UH60|MH60|SH60)/, pack: "rk:H60", family: "milheli" },
  { re: /^AH64/, pack: "rk:H64", family: "milheli" },
  { re: /^CH53/, family: "milheli" }, // no CH-53 art
  // ── bizjet ─────────────────────────────────────────────────────────────
  // GVI = G-VI (Global Express, G650-line); (?!I) keeps GVII (G500/G600)
  // from prefix-matching the GVI rule
  { mfr: ["GULFSTREAM"], re: /^GIV/, pack: "pd:GIV", family: "bizjet" }, // G-IV/IV-SP (verified 52'8" span)
  { mfr: ["GULFSTREAM"], re: /^GVI(?!I)|^G650/, pack: "rk:GLF6", family: "bizjet" },
  // G280 codes carry IAI LTD mfr (Israel Aerospace, builder)
  { mfr: ["GULFSTREAM", "IAI"], re: /^G(150|280|550|650)/, family: "bizjet" },
  // Global Express family codes without dedicated art: roman-numeral and
  // parenthetical forms (G-IV, G-V, GV-SP(G550), GVII(G500/G600),
  // GVIII(G700)) plus G200/G450 — the generic Global silhouette. G650 has
  // its own art above; G280/G550 dedicated art is a curation target
  {
    mfr: ["GULFSTREAM", "IAI"],
    re: /^G(200|450)|^GIV$|^GV$|^GVII|^GVIII|^GVSP/,
    pack: "pw:GLEX",
    family: "bizjet",
  },
  // Cessna Citation — codes carry no C prefix; 525/550/560/750 were mis-bucketed
  // as piston by the CESSNA catch below, bizjet is correct
  { mfr: ["CESSNA", "TEXTRON"], re: /^525/, pack: "rk:C25B", family: "bizjet" },
  { mfr: ["CESSNA", "TEXTRON"], re: /^5[56]\d/, pack: "pw:C560", family: "bizjet" },
  { mfr: ["CESSNA", "TEXTRON"], re: /^750/, pack: "rk:C750", family: "bizjet" },
  { mfr: ["CESSNA", "TEXTRON"], re: /^(501|510|526|650|680)(?!\d)/, family: "bizjet" }, // Citation I/SP, Mustang, CJ type code, Excel, Sovereign
  { mfr: ["CESSNA"], re: /^C[56]\d\d/, family: "bizjet" }, // C500…C680 (C-prefixed names)
  { re: /^CJ\d/, family: "bizjet" }, // CJ1/CJ2/CJ3 Starlet (person MFRs exist)
  // Bombardier CL-600/BD-700 — regional narrowbody jets (family narrowbody per
  // the 13-family classification, not the legacy CL6 bizjet catch below; they
  // must precede ^CL6 or it swallows them)
  { mfr: ["BOMBARDIER", "CANADAIR"], re: /^CL6002A12/, pack: "rk:CRJ2", family: "narrowbody" },
  { mfr: ["BOMBARDIER", "CANADAIR"], re: /^CL6002B19/, pack: "rk:CRJ7", family: "narrowbody" },
  { mfr: ["BOMBARDIER", "CANADAIR"], re: /^CL6002C1/, pack: "rk:CRJ9", family: "narrowbody" },
  { mfr: ["BOMBARDIER", "CANADAIR"], re: /^CL6002[DE]/, pack: "rk:CRJX", family: "narrowbody" }, // CRJ-1000
  // BD-100 = the Global Express family (G-IV, G-V, GV-SP(G550),
  // GVII(G500/G600), GVIII(G700); G280 codes carry IAI mfr). pw:GLEX is a
  // generic Global silhouette — family-level art until the dedicated
  // per-generation art lands (G280/G550 curation).
  { mfr: ["BOMBARDIER"], re: /^BD100/, pack: "pw:GLEX", family: "narrowbody" },
  // BD-700 = Challenger 300/350 — the pre-wave rules pointed these at
  // Global Express art (rk:GL5T / pw:GLEX), the wrong airframe. Family
  // until Challenger art is curated (OmittedModels).
  { mfr: ["BOMBARDIER"], re: /^BD700/, family: "narrowbody" },
  { mfr: ["BOMBARDIER", "CANADAIR"], re: /^CL6/, family: "bizjet" }, // CL600-2B16 Challenger 600 — no art
  { mfr: ["DASSAULT"], re: /^FALCON7X|^F7X/, pack: "rk:FA7X", family: "bizjet" },
  { mfr: ["DASSAULT"], re: /^(FALCON|F50|F500|F5XR|F7X|F70|F10|MD31[123])/, family: "bizjet" },
  { mfr: ["LEARJET", "LEAR JET"], re: /^35/, pack: "rk:LJ35", family: "bizjet" }, // 35/35A codes
  { mfr: ["LEARJET", "TEXTRON"], re: /^(L420|LJ\d|L100|L200|L3\d{3})/, family: "bizjet" },
  // Learjet numeric codes (23/24/25/28/31/36/40/45/55/60/70/75/142, bare +
  // letter suffixes; (?!\d) keeps 601/604-style Bombardier strings out)
  { mfr: ["LEARJET", "LEAR JET", "BOMBARDIER"], re: /^(23|24|25|28|31|36|40|45|55|60|70|75|85|142|C21|LR25)(?!\d)/, family: "bizjet" },
  { mfr: ["PIPER"], re: /^P(28|35)([A-Z]|$)/, family: "bizjet" },
  { mfr: ["HAWKER", "BRITISH AEROSPACE"], re: /^(HAWKERHUNT|HUNTER)/, pack: "rk:HUNT", family: "bizjet" },
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
  { mfr: ["PIAGGIO"], re: /^P180/, pack: "rk:P180", family: "bizjet" },
  // ── widebody ───────────────────────────────────────────────────────────
  { mfr: ["BOEING"], re: /^7472/, pack: "rk:B742", family: "widebody" },
  { mfr: ["BOEING"], re: /^747SP/, pack: "rk:B74S", family: "widebody" },
  { mfr: ["BOEING"], re: /^7474/, pack: "rk:B744", family: "widebody" },
  { mfr: ["BOEING"], re: /^7478/, pack: "rk:B748", family: "widebody" },
  { mfr: ["BOEING"], re: /^7672/, pack: "rk:B762", family: "widebody" },
  { mfr: ["BOEING"], re: /^7673/, pack: "rk:B763", family: "widebody" },
  { mfr: ["BOEING"], re: /^7674/, pack: "rk:B764", family: "widebody" },
  { mfr: ["BOEING"], re: /^7772[A-Z0-9]*LR/, pack: "rk:B77L", family: "widebody" },
  { mfr: ["BOEING"], re: /^7773[A-Z0-9]*ER/, pack: "pw:B77W", family: "widebody" },
  { mfr: ["BOEING"], re: /^7773/, pack: "rk:B773", family: "widebody" },
  { mfr: ["BOEING"], re: /^7779/, pack: "rk:B779", family: "widebody" },
  { mfr: ["BOEING"], re: /^7878/, pack: "rk:B788", family: "widebody" },
  { mfr: ["BOEING"], re: /^7879/, pack: "pw:B789", family: "widebody" },
  { mfr: ["BOEING"], re: /^78710/, pack: "rk:B78X", family: "widebody" },
  { mfr: ["AIRBUS"], re: /^A300600ST/, pack: "rk:A3ST", family: "widebody" },
  { mfr: ["AIRBUS"], re: /^A300/, pack: "pw:A306", family: "widebody" },
  { mfr: ["AIRBUS"], re: /^A310/, pack: "pw:A310", family: "widebody" },
  { mfr: ["AIRBUS"], re: /^A3302/, pack: "pw:A332", family: "widebody" },
  { mfr: ["AIRBUS"], re: /^A3303/, pack: "pw:A333", family: "widebody" },
  { mfr: ["AIRBUS"], re: /^A3309/, pack: "pw:A339", family: "widebody" },
  { mfr: ["AIRBUS"], re: /^A3402/, pack: "pw:A342", family: "widebody" },
  { mfr: ["AIRBUS"], re: /^A3403/, pack: "pw:A343", family: "widebody" },
  { mfr: ["AIRBUS"], re: /^A3405/, pack: "pw:A345", family: "widebody" },
  { mfr: ["AIRBUS"], re: /^A3406/, pack: "pw:A346", family: "widebody" },
  { mfr: ["AIRBUS"], re: /^A3509/, pack: "pw:A359", family: "widebody" },
  { mfr: ["AIRBUS"], re: /^A3501/, pack: "pw:A35K", family: "widebody" },
  { mfr: ["AIRBUS"], re: /^A380/, pack: "pw:A388", family: "widebody" },
  { re: /^DC10|^MD10/, pack: "rk:DC10", family: "widebody" },
  { re: /^MD11/, pack: "rk:MD11", family: "widebody" },
  { re: /^IL7[68]/, pack: "rk:IL76", family: "widebody" },
  { re: /^377SGT/, pack: "rk:SGUP", family: "widebody" }, // Super Guppy
  { mfr: ["BOEING"], re: /^(747|767|777|787)/, family: "widebody" }, // catch
  { mfr: ["AIRBUS"], re: /^A3[3-8]/, family: "widebody" }, // catch
  { mfr: ["MCDONNELL"], re: /^MD1[01]/, family: "widebody" }, // catch (shadowed)
  { re: /^(IL96|TU204|AN124)/, family: "widebody" }, // catch
  // ── narrowbody ─────────────────────────────────────────────────────────
  // 737 block — MAX detection: FAA MAX codes carry an M in the suffix
  // (737-8JM, 737-7M2); classic codes do not. 737-8200 = MAX 200.
  { mfr: ["BOEING"], re: /^7373/, pack: "rk:B733", family: "narrowbody" },
  { mfr: ["BOEING"], re: /^7374/, pack: "rk:B734", family: "narrowbody" },
  { mfr: ["BOEING"], re: /^7375/, pack: "rk:B735", family: "narrowbody" },
  { mfr: ["BOEING"], re: /^7376/, pack: "pd:737C", family: "narrowbody" }, // 737-600 — Classic silhouette (737-300 art, same family)
  { mfr: ["BOEING"], re: /^7377[A-Z0-9]*M/, family: "narrowbody" }, // MAX 7: no art — guard before B737 (OmittedModels)
  { mfr: ["BOEING"], re: /^7377/, pack: "rk:B737", family: "narrowbody" },
  { mfr: ["BOEING"], re: /^7378200/, pack: "pw:B38M", family: "narrowbody" },
  { mfr: ["BOEING"], re: /^7378[A-Z0-9]*M/, pack: "pw:B38M", family: "narrowbody" },
  { mfr: ["BOEING"], re: /^7378/, pack: "pw:B738", family: "narrowbody" },
  { mfr: ["BOEING"], re: /^7379[A-Z0-9]*M/, pack: "rk:B39M", family: "narrowbody" },
  { mfr: ["BOEING"], re: /^7379/, pack: "rk:B739", family: "narrowbody" },
  { mfr: ["BOEING"], re: /^7572/, pack: "pw:B752", family: "narrowbody" },
  { mfr: ["BOEING"], re: /^7573/, pack: "rk:B753", family: "narrowbody" },
  { mfr: ["BOEING"], re: /^7073/, pack: "rk:B703", family: "narrowbody" },
  { mfr: ["BOEING"], re: /^717/, pack: "rk:B712", family: "narrowbody" },
  { mfr: ["BOEING"], re: /^7272/, pack: "rk:B722", family: "narrowbody" },
  // Airbus A220 + A320 family — neo codes = base + 3 digits + N [+X/Y] (A321-253NY)
  { mfr: ["AIRBUS"], re: /^A2201/, pack: "rk:BCS1", family: "narrowbody" },
  { mfr: ["AIRBUS"], re: /^A2203/, pack: "rk:BCS3", family: "narrowbody" },
  { mfr: ["AIRBUS"], re: /^A318/, pack: "pw:A318", family: "narrowbody" },
  { mfr: ["AIRBUS"], re: /^A319\d{3}N[A-Z]*/, pack: "pw:A19N", family: "narrowbody" },
  { mfr: ["AIRBUS"], re: /^A319/, pack: "pw:A319", family: "narrowbody" },
  { mfr: ["AIRBUS"], re: /^A320\d{3}N[A-Z]*/, pack: "pw:A20N", family: "narrowbody" },
  { mfr: ["AIRBUS"], re: /^A320/, pack: "pw:A320", family: "narrowbody" },
  { mfr: ["AIRBUS"], re: /^A321\d{3}N[A-Z]*/, pack: "pw:A21N", family: "narrowbody" },
  { mfr: ["AIRBUS"], re: /^A321/, pack: "pw:A321", family: "narrowbody" },
  // Embraer E-Jets (real codes: "ERJ 170-200", "EMB170ST", "E190"…)
  { mfr: ["EMBRAER"], re: /^ERJ17\d|^EMB17\d|^E17\d/, pack: "rk:E170", family: "narrowbody" },
  { mfr: ["EMBRAER"], re: /^ERJ190|^ERG190|^EMB190|^E19\d|^190\d/, pack: "pw:E190", family: "narrowbody" },
  { mfr: ["EMBRAER"], re: /^ERJ1[234]|^EMB1[234]/, pack: "rk:E35L", family: "narrowbody" },
  { mfr: ["EMBRAER"], re: /^EMB820/, pack: "pw:PA31", family: "piston" }, // EMB-820 = PA-31 Navajo
  { mfr: ["EMBRAER"], re: /^EMB-?50[05]/, family: "bizjet" }, // Phenom 100/300 — light jets, not E-Jets
  { re: /^RJ85/, pack: "rk:RJ85", family: "narrowbody" }, // Fokker 50
  { mfr: ["FOKKER"], re: /^F\.?28/, pack: "pw:F28", family: "narrowbody" },
  { mfr: ["SAAB"], re: /^SF340/, pack: "pw:SF34", family: "narrowbody" }, // SF340A/B codes
  { mfr: ["BOEING"], re: /^(737|757|717|B717)/, family: "narrowbody" }, // catch
  { mfr: ["AIRBUS"], re: /^A3(1[89]|2[01])/, family: "narrowbody" }, // catch (shadowed)
  { mfr: ["EMBRAER"], re: /^(E[12]\d\d|EMB\d)/, family: "narrowbody" }, // catch
  { mfr: ["BOMBARDIER"], re: /^CRJ/, family: "narrowbody" }, // catch (CRJ-100 style names)
  // MD-8x/9x: the registry codes are "DC-9-8x(MD-8x)" (MCDONNELL DOUGLAS /
  // DOUGLAS / BOEING) and "MD-90-30" (BOEING) — two rules cover both forms;
  // one art (the MD-8x top view) fits the whole family (the MD-90 shares the
  // airframe). True DC-9 series (DC-9-10/30) stays family-only (OmittedModels).
  { mfr: ["MCDONNELL", "DOUGLAS", "BOEING"], re: /^DC9[89]\d/, pack: "pd:MD8", family: "narrowbody" },
  { mfr: ["MCDONNELL", "DOUGLAS", "BOEING"], re: /^MD(8\d|9\d)/, pack: "pd:MD8", family: "narrowbody" },
  { mfr: ["DOUGLAS", "BOEING", "MCDONNELL"], re: /^DC9/, family: "narrowbody" }, // catch (true DC-9 — no top-view art)
  { mfr: ["BRITISH AEROSPACE", "BAE"], re: /^146/, family: "narrowbody" }, // catch
  { mfr: ["FOKKER"], re: /^(F100|F70|F28)/, family: "narrowbody" }, // catch
  { re: /^F70([A-Z]|$)/, family: "bizjet" }, // F70 without FOKKER mfr defaults to Falcon (spec trap)
  { mfr: ["SAAB"], re: /^(SAAB)?340/, pack: "pw:SF34", family: "narrowbody" },
  // ── turboprop ──────────────────────────────────────────────────────────
  { re: /^ATR425/, pack: "rk:AT45", family: "turboprop" },
  { re: /^ATR725/, pack: "rk:AT75", family: "turboprop" }, // 72-500: no FAA codes yet
  { re: /^ATR72/, pack: "rk:AT75", family: "turboprop" }, // 72-2xx/6xx — same 72 airframe family as the -500 art; mfr varies (ATR, AEROSPATIALE…), no constraint
  { mfr: ["AIRBUS"], re: /^C295/, pack: "rk:C295", family: "turboprop" },
  { re: /^DHC82/, pack: "pw:DH8B", family: "turboprop" },
  { re: /^DHC83/, pack: "rk:DH8C", family: "turboprop" },
  { re: /^DHC84/, pack: "pw:DH8D", family: "turboprop" },
  { re: /^DHC6/, pack: "pw:TWEN", family: "turboprop" },
  { mfr: ["CESSNA", "TEXTRON"], re: /^208B|^408/, pack: "rk:F406", family: "turboprop" }, // Caravan
  { mfr: ["CESSNA", "TEXTRON"], re: /^(208|CARAVAN)/, pack: "pw:C208", family: "turboprop" },
  { mfr: ["PILATUS"], re: /^PC6/, pack: "rk:PC6T", family: "turboprop" },
  { mfr: ["PILATUS"], re: /^PC9/, pack: "rk:PC9", family: "turboprop" },
  { mfr: ["PILATUS"], re: /^PC12/, pack: "pw:PC12", family: "turboprop" },
  { mfr: ["BEECH", "TEXTRON"], re: /^1900D/, pack: "pw:B190D", family: "turboprop" },
  { re: /^1900/, pack: "rk:B190", family: "turboprop" },
  { re: /^B?350/, pack: "pw:B350", family: "turboprop" }, // King Air 350 (not B35 Bonanza)
  { mfr: ["BEECH", "TEXTRON"], re: /^B(200|300)/, pack: "pd:B200", family: "turboprop" }, // King Air 200/300 (same airframe art; no B360 codes)
  { mfr: ["DORNIER"], re: /^228/, pack: "rk:D228", family: "turboprop" }, // 228-2xx codes
  { mfr: ["DORNIER"], re: /^DO228/, pack: "rk:D228", family: "turboprop" },
  { mfr: ["DORNIER"], re: /^328/, pack: "rk:D328", family: "turboprop" },
  { mfr: ["HAWKER", "BAE"], re: /^748|^HS\.?748/, pack: "pw:A748", family: "turboprop" },
  { re: /^AN24/, pack: "pw:AN24", family: "turboprop" },
  { re: /^AN26/, pack: "pw:AN26", family: "turboprop" },
  // An-12/28 — 1/0 US ACFTREF codes; the art exists in the pack, wire it
  { re: /^AN12/, pack: "pw:AN12", family: "turboprop" },
  { re: /^AN28/, pack: "pw:AN28", family: "turboprop" },
  { re: /^ATR/, family: "turboprop" }, // catch — real MFRs vary (ATR, AEROSPATIALE…)
  { re: /^(DHC6|DHC8|TWINOTTER|DASH)/, family: "turboprop" }, // catch — VIKING/DEHAVILLAND…
  { mfr: ["SAAB", "SIPA"], re: /^(SAAB)?2000/, family: "turboprop" },
  { mfr: ["SAAB", "SIPA"], re: /^S200$/, family: "turboprop" },
  { mfr: ["BEECH", "TEXTRON"], re: /^B(200|300|350|360)/, family: "turboprop" }, // King Air catch (no 200/300/360 art)
  { mfr: ["FOKKER", "FAIRCHILD"], re: /^F27/, family: "turboprop" },
  { re: /^(D228|YAK40)/, family: "turboprop" }, // catch (D-prefixed 228 names)
  // ── piston / light ─────────────────────────────────────────────────────
  // Cessna codes carry 0–2 letter prefixes (R172G, T206, P210N, F182H…);
  // the mfr guard is required — unguarded "206/210" matches BELL/AGUSTA
  // helis, the AIRBUS A210, and balloon model numbers
  { mfr: ["CESSNA", "TEXTRON"], re: /^[A-Z]{0,2}172/, pack: "pw:C172", family: "piston" },
  { mfr: ["CESSNA", "TEXTRON"], re: /^[A-Z]{0,2}182/, pack: "pw:C182", family: "piston" },
  { mfr: ["CESSNA", "TEXTRON"], re: /^[A-Z]{0,2}206/, pack: "pw:C206", family: "piston" },
  { mfr: ["CESSNA", "TEXTRON"], re: /^[A-Z]{0,2}210(?!\d)/, pack: "pw:C210", family: "piston" }, // 2105 = registry 205 mislabel, not a 210
  { mfr: ["CESSNA", "TEXTRON"], re: /^[A-Z]{0,2}150/, pack: "pd:C150", family: "piston" },
  { mfr: ["CESSNA", "TEXTRON"], re: /^[A-Z]{0,2}177/, family: "piston" }, // vetoed: banner text inside top view (OmittedModels)
  { mfr: ["CESSNA", "TEXTRON"], re: /^(L27|310)/, pack: "pd:C310", family: "piston" }, // L-27A = C-310 art
  { mfr: ["CESSNA", "TEXTRON"], re: /^(A37|C37)/, pack: "pd:A37", family: "piston" }, // A-37 = C-37 Airmaster airframe
  { mfr: ["CESSNA"], re: /^40[12]/, pack: "pw:C402", family: "piston" },
  { mfr: ["CESSNA"], re: /^441/, pack: "pw:C441", family: "piston" },
  { mfr: ["MOONEY"], re: /^M20/, pack: "pd:M20", family: "piston" },
  // Bonanza A36 — 445 ac are registered under RAYTHEON AIRCRAFT COMPANY
  // (Beech's parent); NORTH AMERICAN A36A is the vintage Navy 36 (excluded)
  { mfr: ["BEECH", "BEECHCRAFT", "RAYTHEON"], re: /^[AB]?36/, pack: "pw:BE36", family: "piston" },
  // Classic Bonanza 33/35 (V35A, S35, P35, F33A, 35-B33) and Baron 55/58
  // (95-B55, 58P) — family until their art is curated. (?!\d) keeps B350
  // (King Air) out of the 35 rule; 95B- prefixed codes are Barons too
  // E33 art serves the classic 33/35 V-tail family (same airframe)
  { mfr: ["BEECH", "BEECHCRAFT"], re: /^[A-Z]?35(?!\d)/, pack: "pd:B35", family: "piston" },
  { mfr: ["BEECH", "BEECHCRAFT"], re: /^[A-Z]?33(?!\d)/, pack: "pd:B35", family: "piston" },
  { mfr: ["BEECH", "BEECHCRAFT"], re: /^(95B|D)?5(5|8)/, pack: "pd:D55", family: "piston" }, // D55 = bare 55 code
  { mfr: ["BEECH", "BEECHCRAFT"], re: /^(19(?!\d)|23(?!\d)|C23|A23|A24R)/, pack: "pd:MUSK", family: "piston" }, // Musketeer/Sierra Maine (A24R art; (?!\d) keeps the 1900 out)
  { mfr: ["PIPER"], re: /^PA28/, pack: "pd:PA28", family: "piston" }, // 18.5k ac — was a dead ^P28 bizjet rule
  { mfr: ["PIPER"], re: /^PA24/, pack: "pd:PA24", family: "piston" }, // Comanche
  { mfr: ["PIPER"], re: /^PA22/, pack: "pd:PA22", family: "piston" }, // Colt/Pacer (2.9k ac)
  { mfr: ["PIPER"], re: /^PA30/, pack: "pd:PA30", family: "piston" }, // Twin Comanche
  { mfr: ["PIPER"], re: /^PA31/, pack: "pw:PA31", family: "piston" },
  { re: /^PA32/, pack: "pw:P32T", family: "piston" },
  { re: /^PA44/, pack: "pw:PA44", family: "piston" },
  { re: /^PA46/, pack: "rk:PA46", family: "piston" },
  { mfr: ["DIAMOND"], re: /^DA42/, pack: "rk:DA42", family: "piston" },
  { re: /^SR22/, pack: "pw:SR22", family: "piston" },
  { mfr: ["SCHLEICHER"], re: /^ASK21/, pack: "pw:ASK21", family: "piston" },
  { mfr: ["SCHEIBE"], re: /^SF25/, pack: "rk:SF25", family: "piston" },
  { mfr: ["STEARMAN", "BOEING"], re: /^(75(?!\d)|A75|N2S|PT17)/, pack: "rk:ST75", family: "piston" }, // incl. Kaydet/PT-17/N2S mfr "BOEING" (1k ac); (?!\d) keeps the 757 out
  { re: /^SONEX/, pack: "pw:SONX", family: "piston" },
  { re: /^(VANS)?RV9/, pack: "pw:RV9", family: "piston" },
  { mfr: ["EXTRA"], re: /^EA300/, pack: "rk:E300", family: "piston" },
  { mfr: ["PARTENAVIA"], re: /^P\.?68/, pack: "pw:P68", family: "piston" },
  { re: /^BN2/, pack: "rk:BN2P", family: "piston" }, // BN-2 Islander
  { mfr: ["ROCKWELL", "COMMANDER"], re: /^690|^840|^900/, pack: "pw:AC90", family: "piston" }, // Turbo Commander
  { mfr: ["BELLANCA", "CHAMPION", "CAMPION"], re: /^8[A-Z0-9]*/, pack: "pw:BL8", family: "piston" },
  { mfr: ["BOEING"], re: /^B29/, pack: "rk:B29", family: "piston" },
  { mfr: ["DOUGLAS"], re: /^DC3[A-Z0-9]*|^C47[A-Z0-9]*/, pack: "rk:DC3", family: "piston" },
  { mfr: ["DOUGLAS", "MCDONNELL"], re: /^DC87/, pack: "rk:DC87", family: "piston" },
  { mfr: ["DORNIER"], re: /^DO27/, pack: "rk:DO27", family: "piston" },
  { mfr: ["DORNIER"], re: /^D?O28/, pack: "rk:DO28", family: "piston" },
  { mfr: ["CESSNA", "TEXTRON"], re: /^[A-Z]{0,2}[1-7]\d\d(?!\d)/, family: "piston" }, // catch — 150H, 310, T337HSP… (208 → turboprop above)
  { mfr: ["BEECH"], re: /^B(25|35|55|58|99)([A-Z]|$)/, family: "piston" }, // catch — B350 → King Air above
  { mfr: ["PIPER"], re: /^PA\d/, family: "piston" }, // catch
  { mfr: ["DIAMOND"], re: /^DA\d/, family: "piston" }, // catch
  { re: /^SR2[02]/, family: "piston" }, // catch
  { re: /^L410/, family: "piston" },
  { re: /^L(18|36)/, family: "piston" },
  { mfr: ["SCHLEICHER"], re: /^(ASK|ARCUS|DUO|SECOR)/, family: "piston" }, // catch
  { mfr: ["RANS"], re: /^S\d/, family: "piston" }, // ultralights (S7, S20…)
  { mfr: ["QUICKSILVER"], re: /^Q200/, family: "piston" },
];
