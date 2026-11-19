import { describe, it, test, expect } from "vitest";
import { ICON_URLS, ICON_NAMES } from "../src/map/icon-urls.js";
import { SEA_KINDS, KINDS, KIND_FALLBACK_ICON } from "../shared/craft.js";
import { resolveAirIcon, AIR_FAMILY_ICONS } from "../server/icons.js";

describe("icon registry", () => {
  it("has exactly one icon per air family (13) + sea kind (10) = 23", () => {
    expect(ICON_NAMES).toHaveLength(23);
    for (const name of [...AIR_FAMILY_ICONS, ...SEA_KINDS]) {
      expect(ICON_NAMES, `missing icon for ${name}`).toContain(name);
      expect(typeof ICON_URLS[name], `url for ${name}`).toBe("string");
      expect(ICON_URLS[name].length, `url for ${name}`).toBeGreaterThan(0);
    }
  });

  it("no image-name collision between air families and sea kinds", () => {
    const sea = new Set<string>(SEA_KINDS);
    for (const fam of AIR_FAMILY_ICONS) {
      expect(sea.has(fam), `${fam} collides with a sea kind`).toBe(false);
    }
  });

  it("every KIND_FALLBACK_ICON value is a registered image", () => {
    for (const v of Object.values(KIND_FALLBACK_ICON)) {
      expect(ICON_NAMES, `fallback ${v} not registered`).toContain(v);
    }
  });

  it("every KINDS[k].icon is a registered image (air entries use fallback families)", () => {
    for (const k of Object.keys(KINDS) as (keyof typeof KINDS)[]) {
      expect(ICON_NAMES, `KINDS[${k}].icon not registered`).toContain(KINDS[k].icon);
    }
  });

  it("KINDS air icons equal their KIND_FALLBACK_ICON family", () => {
    for (const k of ["commercial", "business", "military", "general"] as const) {
      expect(KINDS[k].icon, `KINDS[${k}].icon`).toBe(KIND_FALLBACK_ICON[k]);
    }
  });

  it("old air-kind icon names are gone", () => {
    for (const old of ["commercial", "business", "military", "general"]) {
      expect(ICON_NAMES).not.toContain(old);
    }
  });
});

describe("resolver pack emission", () => {
  const pack = new Set(["rk:C130", "rk:H60", "rk:E3TF", "rk:R135", "rk:H64"]);

  test("military token emits pack name when present", () => {
    expect(resolveAirIcon({ kind: "military", callsign: "C130", faaModel: null, faaMfr: null, pack })).toBe("rk:C130");
    expect(resolveAirIcon({ kind: "military", callsign: "UH60A", faaModel: null, faaMfr: null, pack })).toBe("rk:H60");
    // E-3 Sentry: the vendored rk pack carries the art (TF33 engine variant)
    expect(resolveAirIcon({ kind: "military", callsign: "E3", faaModel: null, faaMfr: null, pack })).toBe("rk:E3TF");
    expect(resolveAirIcon({ kind: "military", callsign: "AWACS", faaModel: null, faaMfr: null, pack })).toBe("rk:E3TF");
    expect(resolveAirIcon({ kind: "military", callsign: "AH64", faaModel: null, faaMfr: null, pack })).toBe("rk:H64");
  });

  test("pack name absent from set → family fallback (today's behavior)", () => {
    expect(resolveAirIcon({ kind: "military", callsign: "C130", faaModel: null, faaMfr: null, pack: new Set() })).toBe("transport");
    expect(resolveAirIcon({ kind: "military", callsign: "C130", faaModel: null, faaMfr: null })).toBe("transport"); // no pack arg at all
  });

  test("military without callsign → family fallback (unchanged)", () => {
    expect(resolveAirIcon({ kind: "military", callsign: null, faaModel: null, faaMfr: null, pack })).toBe("fighter");
  });
});

describe("military table curation wiring (gap curation 2026-11-06)", () => {
  const pack = new Set([
    "rk:B703", "rk:B737", "rk:B748", "rk:P3", "rk:R135",
    "rk:B1 fast", "rk:F5", "rk:T38", "rk:LYNX", "rk:HAWK", "rk:TOR fast",
  ]);

  const rows: Array<[callsign: string, expected: string]> = [
    // re-wired existing tokens
    // 2026-11-18 audit: CH53/MQ9 vetoes stay locked on family (no usable art)
    ["CH53", "milheli"],
    ["CH53E", "milheli"],
    ["REAPER", "isr"],
    ["MQ9", "isr"],
    ["TACAMO", "rk:B703"], // E-6 = 707-300 airframe (707 top view; the rotodome is not drawable at icon size)
    ["KCTC", "rk:R135"], // USN KC-135 variant — RC-135 art (same C-135 airframe)
    ["C21", "rk:B737"], // C-21A = 737-700 derivative
    ["C40", "rk:B737"], // C-40 = 737-based
    ["VC25", "rk:B748"], // VC-25A = 747-8F airframe
    ["EP3E", "rk:P3"], // EP-3E = P-3C airframe
    // new tokens
    ["B1", "rk:B1 fast"],
    ["B1B", "rk:B1 fast"],
    ["F5E", "rk:F5"],
    ["T38", "rk:T38"],
    ["LYNX", "rk:LYNX"],
    ["HAWK", "rk:HAWK"],
    ["TOR", "rk:TOR fast"],
    ["TORNADO", "rk:TOR fast"],
  ];

  for (const [cs, exp] of rows) {
    it(`${cs} → ${exp}`, () => {
      expect(resolveAirIcon({ kind: "military", callsign: cs, faaModel: null, faaMfr: null, pack })).toBe(exp);
    });
  }

  it("each wiring falls back to its family when the pack lacks the name", () => {
    const bare = new Set<string>();
    expect(resolveAirIcon({ kind: "military", callsign: "CH53", faaModel: null, faaMfr: null, pack: bare })).toBe("milheli");
    expect(resolveAirIcon({ kind: "military", callsign: "REAPER", faaModel: null, faaMfr: null, pack: bare })).toBe("isr");
    expect(resolveAirIcon({ kind: "military", callsign: "TACAMO", faaModel: null, faaMfr: null, pack: bare })).toBe("isr");
    expect(resolveAirIcon({ kind: "military", callsign: "KCTC", faaModel: null, faaMfr: null, pack: bare })).toBe("tanker_air");
    expect(resolveAirIcon({ kind: "military", callsign: "C21", faaModel: null, faaMfr: null, pack: bare })).toBe("transport");
    expect(resolveAirIcon({ kind: "military", callsign: "VC25", faaModel: null, faaMfr: null, pack: bare })).toBe("transport");
    expect(resolveAirIcon({ kind: "military", callsign: "B1", faaModel: null, faaMfr: null, pack: bare })).toBe("attack");
  });

  it("strict tokens: F5 has no rule, HAWKER ≠ HAWK (different airframe), TORCH ≠ TOR", () => {
    expect(resolveAirIcon({ kind: "military", callsign: "F5", faaModel: null, faaMfr: null, pack })).toBe("fighter");
    expect(resolveAirIcon({ kind: "military", callsign: "HAWKER", faaModel: null, faaMfr: null, pack })).toBe("fighter");
    expect(resolveAirIcon({ kind: "military", callsign: "TORCH", faaModel: null, faaMfr: null, pack })).toBe("fighter");
  });
});

describe("civil resolver pack emission (Task 6 curation lock)", () => {
  // [model, mfr, expected] — real FAA ACFTREF model strings (normalizeModel
  // applies: uppercase, spaces/hyphens stripped). expected = the pack name
  // the curation pinned for that rule, or a family name for no-art controls.
  // This table is the regression lock for the pack names on CIVIL_RULES:
  // while the rules carry no `pack` field the pack rows fail (red), and
  // after curation they pin the chosen names against drift.
  const rows: Array<[model: string, mfr: string, expected: string]> = [
    // widebody
    ["777-233LR", "BOEING", "rk:B77L"],
    ["777-35RER", "BOEING", "pw:B77W"],
    ["DC10", "AIRCRAFT BUILDERS ASSOC LLC", "rk:DC10"],
    ["MD-11", "MCDONNELL DOUGLAS", "rk:MD11"],
    ["IL 78", "ILYUSHIN", "rk:IL76"],
    ["377SGT", "AERO SPACELINES", "rk:SGUP"],
    // narrowbody (incl. MAX/neo detection and CRJ/Challenger codes)
    ["737-8JM", "BOEING", "pw:B38M"], // MAX 8 — M in suffix
    ["737-8200", "BOEING", "pw:B38M"], // MAX 200
    ["A321-253NY", "AIRBUS", "pw:A21N"], // neo — digits + N
    ["CL-600-2B19", "BOMBARDIER INC", "rk:CRJ7"],
    ["CL-600-2E25", "BOMBARDIER INC", "rk:CRJX"],
    ["RJ85A", "BAE SYSTEMS", "rk:RJ85"],
    ["F.28 2000", "FOKKER", "pw:F28"],
    // bizjet
    ["GVI (G650)", "GULFSTREAM AEROSPACE", "rk:GLF6"],
    // Global Express family (2026-11-09): roman-numeral and parenthetical
    // codes resolve the generic Global silhouette; G280 codes carry IAI mfr
    ["G-IV", "GULFSTREAM AEROSPACE", "pd:GIV"], // was pw:GLEX — the Global art, wrong airframe (G-IV = Gulfstream IV)
    ["G-V", "GULFSTREAM AEROSPACE", "pw:GLEX"],
    ["GV-SP(G550)", "GULFSTREAM AEROSPACE CORP", "pw:GLEX"],
    ["GVII(G500)", "GULFSTREAM AEROSPACE CORP", "pw:GLEX"],
    ["GVII(G600)", "GULFSTREAM AEROSPACE CORP", "pw:GLEX"],
    ["GVIII(G700)", "GULFSTREAM AEROSPACE CORP", "pw:GLEX"],
    ["G200", "GULFSTREAM", "pw:GLEX"],
    ["G280", "IAI LTD", "bizjet"], // family until dedicated art (OmittedModels)
    ["P-180", "PIAGGIO", "rk:P180"],
    ["560XL", "CESSNA AIRCRAFT CO", "pw:C560"],
    // helis
    ["CH-47D", "MCDONNELL DOUGLAS", "pd:CH47"], // gap fill curated 2026-11-06
    ["UH-60A", "AAR AIRLIFT GROUP INC", "rk:H60"],
    ["212", "BELL", "rk:UH1"],
    ["206", "BELL", "pw:B06"],
    ["SA365N", "AEROSPATIALE", "pw:AS65"],
    ["BK117A-4", "KAWASAKI", "pw:EC45"],
    ["AGUSTA A109", "AGUSTA SPA", "pw:A109"],
    // Bell 407/429 (2026-11-09): bare "407"/"429" codes exist in the
    // registry (984/175 ac) and bypassed the B-prefixed rule
    ["407", "BELL", "bizheli"],
    ["407", "BELL HELICOPTER TEXTRON CANADA", "bizheli"],
    ["429", "BELL", "bizheli"],
    ["525", "BELL", "heli"], // 525 was falling to the fixed-wing family icon
    // turboprop
    ["HS.748 SERIES 2A", "HAWKER SIDDELEY", "pw:A748"],
    // Antonov An-12/28 (2026-11-09): 1/0 US ACFTREF codes — the rules wire
    // the existing pack art so a registration, if one ever appears, resolves
    ["AN-12", "ANTONOV", "pw:AN12"],
    ["AN-28", "ANTONOV", "pw:AN28"],
    ["ATR42-500", "AEROSPATIALE", "rk:AT45"],
    ["DHC-8-300", "DEHAVILLAND", "rk:DH8C"],
    ["208B", "CESSNA", "rk:F406"],
    ["1900D", "BEECH", "pw:B190D"],
    ["B-350", "BEECH", "pw:B350"],
    ["328JET", "DORNIER", "rk:D328"],
    ["690A", "ROCKWELL INTERNATIONAL", "pw:AC90"],
    ["840", "GULFSTREAM TURBO COMMANDER", "pw:AC90"],
    // Cessna prefix extension (2026-11-09): R/T/P/F-prefixed codes resolve
    // their type; the mfr guard keeps non-Cessna "206/210" records (BELL/
    // AGUSTA helis, AIRBUS A210) on their own rules or the family layer
    ["R172G", "CESSNA", "pw:C172"],
    ["F172H", "CESSNA", "pw:C172"],
    ["P172D", "CESSNA", "pw:C172"],
    ["R182", "CESSNA", "pw:C182"],
    ["T182T", "CESSNA", "pw:C182"],
    ["T206", "CESSNA", "pw:C206"],
    ["U206D", "CESSNA", "pw:C206"],
    ["P206C", "CESSNA", "pw:C206"],
    ["P210N", "CESSNA", "pw:C210"],
    ["T210M", "CESSNA", "pw:C210"],
    ["2105", "CESSNA", "piston"], // registry 205 mislabeled 2105 — not a 210
    ["A210-322", "AIRBUS INDUSTRIE", "piston"], // mfr guard: not the Cessna 210
    // piston / light
    ["C-47", "DOUGLAS", "rk:DC3"],
    ["75-L-3", "STEARMAN AIRCRAFT", "rk:ST75"],
    ["PA-32-300", "PIPER", "pw:P32T"],
    ["441", "CESSNA", "pw:C441"],
    ["BN-2B-21", "PILATUS BRITTEN NORMAN", "rk:BN2P"],
    ["8GCBC", "BELLANCA", "pw:BL8"],
    ["EMB-820", "EMBRAER", "pw:PA31"],
    // light-GA fleet curation 2026-11-11 (pd: from Commons, rect-cropped;
    // PA-28 top view drawn nose-down → rot 180 in the manifest)
    ["PA-28-181", "PIPER", "pd:PA28"],
    ["PA-28-140FL", "PIPER", "pd:PA28"],
    ["PA-28R-201T", "PIPER", "pd:PA28"],
    ["150", "CESSNA", "pd:C150"],
    ["150F", "CESSNA", "pd:C150"],
    ["150M", "CESSNA", "pd:C150"],
    ["M20C", "MOONEY", "pd:M20"],
    ["M20", "MOONEY AIRCRAFT CORP.", "pd:M20"],
    ["M-20G", "MOONEY INTERNATIONAL CORP", "pd:M20"],
    // light-GA fleet curation, block 2 (2026-11-11)
    ["PA-24-180", "PIPER", "pd:PA24"], // Comanche top view nose-down → rot 180
    ["PA-24-260", "PIPER", "pd:PA24"],
    ["177", "CESSNA", "piston"], // 2026-11-18 veto: banner text inside the only top view
    ["177R", "CESSNA", "piston"],
    ["177RG", "CESSNA", "piston"],
    ["310", "CESSNA", "pd:C310"], // L-27A (C-310 military) art, nose-down → rot 180
    ["310L", "CESSNA", "pd:C310"],
    ["310Q", "CESSNA", "pd:C310"],
    ["L27A", "CESSNA", "pd:C310"],
    ["G-IV", "GULFSTREAM", "pd:GIV"], // G-IV/IV-SP (52'8" span, verified on-sheet)
    ["G-IV SP", "GULFSTREAM", "pd:GIV"],
    ["G-IV (G400)", "GULFSTREAM", "pd:GIV"],
    ["G550", "GULFSTREAM", "bizjet"], // no dedicated art (thin-line SVG only — OmittedModels)
    // E33 art serves the classic 33/35 V-tail family (same airframe)
    ["E33", "BEECH", "pd:B35"],
    ["G35", "BEECHCRAFT", "pd:B35"],
    ["V35B", "BEECH", "pd:B35"],
    ["35", "BEECH", "pd:B35"],
    ["33", "BEECH", "pd:B35"],
    ["35-A33", "BEECH", "pd:B35"],
    ["A-37", "CESSNA", "pd:A37"], // A-37 = C-37 Airmaster airframe
    ["C-37", "CESSNA", "pd:A37"],
    ["A37A", "CESSNA", "pd:A37"],
    ["D55", "BEECHCRAFT", "pd:D55"], // Baron 55/58 (58P, 95-B55 codes)
    ["58", "BEECH", "pd:D55"],
    ["58P", "BEECH", "pd:D55"],
    ["152", "CESSNA", "piston"], // 152 ≠ 150 — its own code
    ["A75N1", "BOEING", "rk:ST75"], // Kaydet/PT-17/N2S = Stearman 75 airframes (mfr "BOEING", 1k ac)
    ["A75N1(PT17)", "BOEING", "rk:ST75"],
    ["N2S-3", "BOEING", "rk:ST75"],
    ["PT-17", "BOEING", "rk:ST75"],
    ["757-231", "BOEING", "pw:B752"], // (?!\d) guard: the 757 must NOT catch ^75
    // gap fills curated 2026-11-06 (pd: from Commons, rect-cropped)
    ["737-600", "BOEING", "pd:737C"], // 737 Classic silhouette (same family as the 600)
    ["737-66N", "BOEING", "pd:737C"],
    // ATR-72-200/212 → the ATR-72-500 airframe art (same fuselage family;
    // the pd:ATR72 scan was unusable — gray line art on a dark background)
    ["ATR-72-212", "AEROSPATIALE", "rk:AT75"],
    ["ATR-72-201", "AEROSPATIALE", "rk:AT75"],
    ["MD-88", "MCDONNELL DOUGLAS", "pd:MD8"],
    ["DC-9-82(MD-82)", "MCDONNELL DOUGLAS", "pd:MD8"], // real registry code form
    ["MD-90-30", "BOEING", "pd:MD8"],
    ["B200", "BEECHCRAFT CORP", "pd:B200"], // King Air 200
    ["B300", "BEECH", "pd:B200"], // King Air 300 — same airframe art
    ["C-295", "AIRBUS DEFENSE AND SPACE S A", "rk:C295"],
    // Bombardier Global/Challenger (2026-11-09 wave): BD-100 = Global Express
    // family (generic Global silhouette); BD-700 = Challenger 300/350 — the
    // pre-wave rules pointed at Global art, wrong airframe (family until
    // Challenger art is curated; OmittedModels)
    ["BD-100-1A10", "BOMBARDIER INC", "pw:GLEX"],
    ["BD-700-1A10", "BOMBARDIER INC", "narrowbody"],
    ["BD-700-2A12", "BOMBARDIER INC", "narrowbody"],
    // Bonanza/Baron: A36 art exists; classic 33/35 (E33 art) and Baron 55/58
    // (D55 art) curated 2026-11-11
    ["A36", "BEECHCRAFT", "pw:BE36"],
    ["A36", "RAYTHEON AIRCRAFT COMPANY", "pw:BE36"], // 445 ac registered under the parent co
    ["A36A", "NORTH AMERICAN", "piston"], // vintage NA-36 Navy 36 — not a Bonanza
    ["V35A", "BEECH", "pd:B35"],
    ["S35", "BEECH", "pd:B35"],
    ["P35", "BEECH", "pd:B35"],
    ["35-B33", "BEECH", "pd:B35"],
    ["F33A", "BEECH", "pd:B35"],
    ["95-B55", "BEECH", "pd:D55"],
    ["B350", "BEECH", "pw:B350"], // King Air 350 — must not fall to the Bonanza 35 rule
    // no-art controls (family layer must stay put)
    ["CL-600-2B16", "BOMBARDIER INC", "bizjet"], // Challenger 600 — no art (OmittedModels)
    ["DC-9-30", "MCDONNELL DOUGLAS", "narrowbody"], // true DC-9 series — no top-view art (OmittedModels)
    ["B206", "BELL", "heli"], // custom B-prefixed name
    // wrong-family routing fixes (2026-11-19 fleet sweep)
    ["45", "LEARJET INC", "bizjet"], // Learjet 23/24/25/28/31/36/40/45/55/60/70/75/142 bare codes
    ["60 XR", "LEARJET INC", "bizjet"],
    ["55", "GATES LEARJET CORP", "bizjet"],
    ["31A", "LEARJET INC", "bizjet"],
    ["25D", "GATES LEAR JET", "bizjet"],
    ["24F-A", "GATES LEAR JET", "bizjet"],
    ["40", "BOMBARDIER AEROSPACE", "bizjet"], // Learjet 40 under parent-co mfr string
    ["C-21A", "LEARJET INC", "bizjet"], // civil-registered ex-military jets
    ["35A", "LEARJET INC", "rk:LJ35"], // art rule precedes the bare-code catch
    ["45", "PIPER", "piston"], // mfr guard: Piper 45 is not a jet
    ["501", "CESSNA", "bizjet"], // Citation I/SP
    ["510", "CESSNA AIRCRAFT CO", "bizjet"], // Mustang
    ["526", "CESSNA", "bizjet"], // CJ family type code
    ["650", "CESSNA", "bizjet"], // Citation Excel
    ["680", "CESSNA AIRCRAFT INC", "bizjet"], // Citation Sovereign
    ["680A", "TEXTRON AVIATION INC", "bizjet"],
    ["65", "CESSNA", "piston"], // ^650 must not swallow bare 65
    ["EMB-500", "EMBRAER EXECUTIVE AIRCRAFT INC", "bizjet"], // Phenom 100
    ["EMB-505", "EMBRAER S A", "bizjet"], // Phenom 300 (was on the E-Jet catch)
    ["EMB-145", "EMBRAER", "rk:E35L"], // E-Jet art precedence
  ];

  const pack = new Set(rows.map(([, , e]) => (e.includes(":") ? e : "")).filter(Boolean));

  it("pack fixture set is non-trivial", () => {
    expect(pack.size).toBeGreaterThanOrEqual(30);
  });

  for (const [model, mfr, expected] of rows) {
    it(`${model} (${mfr}) → ${expected}`, () => {
      expect(resolveAirIcon({ kind: "general", callsign: null, faaModel: model, faaMfr: mfr, pack })).toBe(expected);
    });
  }
});
