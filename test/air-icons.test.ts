import { describe, it, expect } from "vitest";
import { resolveAirIcon, AIR_FAMILY_ICONS, normalizeModel } from "../server/icons.js";
import { isPackIconName, type AirKind } from "../shared/craft.js";

const air = (
  kind: AirKind,
  over: { callsign?: string; faaModel?: string | null; faaMfr?: string | null } = {},
) => resolveAirIcon({ kind, ...over });

describe("resolveAirIcon — military callsign table", () => {
  const mil = (callsign?: string) => air("military", { callsign });

  it.each([
    ["KC135", "tanker_air"], ["KC10", "tanker_air"], ["KC46", "tanker_air"], ["KCTC", "tanker_air"],
    ["CH47", "milheli"], ["CH53", "milheli"], ["UH60", "milheli"], ["UH6", "milheli"],
    ["MH60", "milheli"], ["SH60", "milheli"], ["H60", "milheli"], ["AH64", "milheli"],
    ["BLACKHAWK", "milheli"],
    ["A10", "attack"],
    ["C130", "transport"], ["C17", "transport"], ["C5", "transport"], ["C21", "transport"],
    ["A400M", "transport"], ["VC25", "transport"], ["C40", "transport"],
    ["RC135", "isr"], ["EP3", "isr"], ["E3", "isr"], ["P3", "isr"], ["U2", "isr"],
    ["TACAMO", "isr"], ["AWACS", "isr"], ["GRIFIN", "isr"], ["REAPER", "isr"],
    ["MQ9", "isr"], ["RQ4", "isr"],
    ["F15", "fighter"], ["F16", "fighter"], ["F18", "fighter"], ["F22", "fighter"], ["F35", "fighter"],
  ])("callsign %s → %s", (callsign, icon) => {
    expect(mil(callsign)).toBe(icon);
  });

  it("prefix tokens: E3G → isr, P3C → isr, U2S → isr", () => {
    expect(mil("E3G")).toBe("isr");
    expect(mil("P3C")).toBe("isr");
    expect(mil("U2S")).toBe("isr");
  });

  it("word anchors: C172, C550, F162 do not match their prefixes", () => {
    expect(mil("C172")).toBe("fighter"); // C17 anchor fails → fallback
    expect(mil("C550")).toBe("fighter"); // C5 anchor fails → fallback
    expect(mil("F162")).toBe("fighter"); // F162 DOES match the F16 rule (\bF16\w*\b) → fighter via that rule's family (no pack set here)
  });

  it("squadron names do not map: EAGLE, RAPTOR, TIGER, BANDIT → fighter fallback", () => {
    for (const cs of ["EAGLE", "RAPTOR", "TIGER", "BANDIT"]) expect(mil(cs)).toBe("fighter");
  });

  it("no callsign / SPI → fighter fallback", () => {
    expect(mil()).toBe("fighter");
    expect(mil("")).toBe("fighter");
  });

  it("military kind ignores FAA data", () => {
    expect(air("military", { callsign: "F16", faaModel: "737-8DR", faaMfr: "BOEING" })).toBe("fighter");
  });
});

describe("resolveAirIcon — FAA model table (minimum coverage)", () => {
  const civ = (model: string, mfr?: string, kind: "commercial" | "business" | "general" = "general") =>
    air(kind, { faaModel: model, faaMfr: mfr ?? null });

  it("normalizes model text (case, spaces, hyphens)", () => {
    expect(normalizeModel("737-8DR")).toBe("7378DR");
    expect(normalizeModel("ATR 72-212A")).toBe("ATR72212A");
    expect(normalizeModel("FALCON XP")).toBe("FALCONXP");
    expect(normalizeModel(null)).toBe("");
  });

  it.each([
    // narrowbody
    ["737-8DR", "BOEING", "narrowbody"],
    ["737-9", "BOEING", "narrowbody"],
    ["737-8200", "BOEING", "narrowbody"],
    ["757-300", "BOEING", "narrowbody"],
    ["B717-200", "BOEING", "narrowbody"],
    ["A320-214", "AIRBUS", "narrowbody"],
    ["A321-271NX", "AIRBUS", "narrowbody"],
    ["A319-112", "AIRBUS INDUSTRIE", "narrowbody"],
    ["E175", "EMBRAER", "narrowbody"],
    ["E190", "EMBRAER", "narrowbody"],
    ["EMB-145LR", "EMBRAER", "narrowbody"],
    ["EMB-190", "EMBRAER", "narrowbody"],
    ["CRJ700", "BOMBARDIER INC", "narrowbody"],
    ["MD-88", "MCDONNELL DOUGLAS CORPORATION", "narrowbody"],
    ["MD-90-30", "MCDONNELL DOUGLAS", "narrowbody"],
    ["DC9-15", "DOUGLAS", "narrowbody"],
    ["146-200", "BRITISH AEROSPACE", "narrowbody"],
    ["F100", "FOKKER", "narrowbody"],
    ["F70", "FOKKER", "narrowbody"],
    ["F28F", "FOKKER", "narrowbody"],
    ["SAAB 340B", "SAAB AB", "narrowbody"],
    // widebody
    ["747-428", "BOEING", "widebody"],
    ["747-8ZV", "BOEING", "widebody"],
    ["767-300F", "BOEING", "widebody"],
    ["777-35RER", "BOEING", "widebody"],
    ["787-8", "BOEING", "widebody"],
    ["A330-941", "AIRBUS", "widebody"],
    ["A330-302", "AIRBUS", "widebody"],
    ["A380-841", "AIRBUS S A S", "widebody"],
    ["MD-11F", "MCDONNELL DOUGLAS", "widebody"],
    ["IL-96-300", "ILYUSHIN", "widebody"],
    // turboprop
    ["ATR72-212A", "AEROSPATIALE", "turboprop"],
    ["ATR 72-212", "ATR", "turboprop"],
    ["ATR42-500", "AEROSPATIALE/ATR", "turboprop"],
    ["DHC-8-400", "DEHAVILLAND", "turboprop"],
    ["DHC-6-300", "VIKING AIR", "turboprop"],
    ["TWIN OTTER", "HANGAR 9", "turboprop"],
    ["208B", "CESSNA", "turboprop"],
    ["PC-12/47E", "PILATUS AIRCRAFT LTD", "turboprop"],
    ["SAAB 2000", "SAAB-SCANIA AB", "turboprop"],
    ["B200GT", "BEECH", "turboprop"],
    ["B350", "BEECH", "turboprop"],
    ["F27", "FOKKER", "turboprop"],
    ["F27M", "FAIRCHILD", "turboprop"],
    // bizjet
    ["G150", "GULFSTREAM AEROSPACE", "bizjet"],
    ["G650", "GULFSTREAM AEROSPACE", "bizjet"],
    ["G280", "GULFSTREAM", "bizjet"],
    ["C550", "CESSNA", "bizjet"],
    ["C680", "CESSNA", "bizjet"],
    ["CJ1", null, "bizjet"],
    ["CJ-6A", null, "bizjet"],
    ["CL600-1A11", "CANADAIR LTD", "bizjet"],
    ["FALCON XP", "DASSAULT AVIATION", "bizjet"],
    ["FALCON 50", "DASSAULT", "bizjet"],
    ["F50", "DASSAULT", "bizjet"],
    ["F7X", "DASSAULT", "bizjet"],
    ["F70", "DASSAULT AVIATION", "bizjet"],
    ["MD-311", "DASSAULT", "bizjet"],
    ["L420", "LEARJET INC", "bizjet"],
    ["LJ-200-1A10", "LEARJET INC", "bizjet"],
    ["P28A", "PIPER", "bizjet"],
    ["HAWKER 800XP", "HAWKER BEECHCRAFT CORP", "bizjet"],
    ["HAWKER 900XP", "RAYTHEON", "bizjet"],
    ["HAWK 800XP", "HAWKER BEECHCRAFT CORP", "bizjet"],
    // heli
    ["R44", "ROBINSON HELICOPTER", "heli"],
    ["R44 II", "ROBINSON HELICOPTER COMPANY", "heli"],
    ["R22", "ROBINSON", "heli"],
    ["K120", null, "heli"],
    ["B206", "BELL", "heli"],
    ["EC130", "AIRBUS HELICOPTERS", "heli"],
    ["H135", "AIRBUS HELICOPTERS SAS", "heli"],
    ["280FX", "ENSTROM", "heli"],
    ["F28F", "ENSTROM HELICOPTER CORP", "heli"],
    // bizheli
    ["R66", "ROBINSON HELICOPTER CO", "bizheli"],
    ["B407", "BELL", "bizheli"],
    ["AW139", "AGUSTA", "bizheli"],
    ["S76", "SIKORSKY", "bizheli"],
    ["S202", "SIKORSKY", "bizheli"],
    ["S300", "SIKORSKY", "bizheli"],
    // piston
    ["172S", "CESSNA", "piston"],
    ["172", "CESSNA", "piston"],
    ["182T", "CESSNA", "piston"],
    ["206", "CESSNA", "piston"],
    ["310", "CESSNA", "piston"],
    ["B35", "BEECH", "piston"],
    ["B58", "BEECH", "piston"],
    ["PA-28-181", "PIPER", "piston"],
    ["DA40 D", "DIAMOND AIRCRAFT IND GMBH", "piston"],
    ["SR22", null, "piston"],
    ["SR22T", null, "piston"],
    ["L410", "LET", "piston"],
    ["ASK 21", "SCHLEICHER", "piston"],
    ["S7", "RANS", "piston"],
    ["Q200", "QUICKSILVER", "piston"],
  ])("%s (%s) → %s", (model, mfr, icon) => {
    expect(civ(model, mfr ?? undefined)).toBe(icon);
  });

  it("military heli models resolve by model only (operator MFRs in real data)", () => {
    expect(civ("UH-60A", "AAR AIRLIFT GROUP INC")).toBe("milheli");
    expect(civ("CH-47D", "MCDONNELL DOUGLAS")).toBe("milheli");
    expect(civ("AH-64", "BOEING")).toBe("milheli");
  });
});

describe("resolveAirIcon — disambiguation traps", () => {
  const civ = (model: string, mfr?: string) =>
    resolveAirIcon({ kind: "general", faaModel: model, faaMfr: mfr ?? null });
  const biz = (model: string, mfr?: string) =>
    resolveAirIcon({ kind: "business", faaModel: model, faaMfr: mfr ?? null });

  it("F70: DASSAULT → bizjet, FOKKER → narrowbody, no mfr → bizjet", () => {
    expect(civ("F70", "DASSAULT")).toBe("bizjet");
    expect(civ("F70", "FOKKER")).toBe("narrowbody");
    expect(civ("F70")).toBe("bizjet");
  });

  it("S-prefix: mfr decides; no mfr → kind fallback", () => {
    expect(civ("S202", "SIKORSKY")).toBe("bizheli");
    expect(civ("S200", "SAAB")).toBe("turboprop");
    expect(civ("S200", "SIPA")).toBe("turboprop");
    expect(civ("S7", "RANS")).toBe("piston");
    expect(civ("S7")).toBe("piston"); // general kind fallback
    expect(biz("S7")).toBe("bizjet"); // business kind fallback
  });

  it("F28F: FOKKER → narrowbody (jet), ENSTROM → heli (Enstrom 28F)", () => {
    expect(civ("F28F", "FOKKER")).toBe("narrowbody");
    expect(civ("F28F", "ENSTROM HELICOPTER CORP")).toBe("heli");
  });

  it("FALCON: DASSAULT → bizjet; FALCONAR (no DASSAULT mfr) → kind fallback", () => {
    expect(civ("FALCON XP", "DASSAULT AVIATION")).toBe("bizjet");
    expect(civ("FALCONAR F-12")).toBe("piston");
    expect(biz("FALCONAR F-12")).toBe("bizjet");
  });

  it("HAWK: HAWKER BEECHCRAFT/RAYTHEON → bizjet; CGS AVIATION glider → fallback", () => {
    expect(civ("HAWKER 800XP", "HAWKER BEECHCRAFT CORP")).toBe("bizjet");
    expect(civ("HAWKER 900XP", "RAYTHEON")).toBe("bizjet");
    expect(civ("HAWK ARROW II", "CGS AVIATION")).toBe("piston");
    expect(biz("HAWK", "CGS AVIATION")).toBe("bizjet");
  });

  it("L410 → piston; L420/LJ (LEARJET mfr) → bizjet; LJ with person mfr → fallback", () => {
    expect(civ("L410", "LET")).toBe("piston");
    expect(biz("L420", "LEARJET INC")).toBe("bizjet");
    expect(civ("LJ-3", "DART ROBERT G")).toBe("piston");
  });

  it("B35 (Bonanza) → piston; B350 (King Air) → turboprop", () => {
    expect(civ("B35", "BEECH")).toBe("piston");
    expect(civ("B350", "BEECH")).toBe("turboprop");
  });

  it("Cessna numbers without C prefix: 172S → piston, 208B → turboprop, CJ1 → bizjet", () => {
    expect(civ("172S", "CESSNA")).toBe("piston");
    expect(civ("208B", "CESSNA")).toBe("turboprop");
    expect(civ("CJ1")).toBe("bizjet");
  });

  it("K120 → heli; K1200 (KIWI) → no match → kind fallback", () => {
    expect(civ("K120", "KAISER")).toBe("heli");
    expect(civ("K1200", "KIWI TECHNOLOGIES INC")).toBe("piston");
    expect(biz("K1200", "KIWI TECHNOLOGIES INC")).toBe("bizjet");
  });
});

describe("resolveAirIcon — fallbacks and output shape", () => {
  it("unknown model → kind fallback", () => {
    expect(resolveAirIcon({ kind: "commercial", faaModel: "XYZZY", faaMfr: "ACME" })).toBe("narrowbody");
    expect(resolveAirIcon({ kind: "business", faaModel: "XYZZY" })).toBe("bizjet");
    expect(resolveAirIcon({ kind: "general", faaModel: "XYZZY" })).toBe("piston");
    expect(resolveAirIcon({ kind: "military", faaModel: "XYZZY" })).toBe("fighter");
  });

  it("no model at all → kind fallback", () => {
    expect(resolveAirIcon({ kind: "commercial", callsign: "DAL539" })).toBe("narrowbody");
    expect(resolveAirIcon({ kind: "general" })).toBe("piston");
  });

  it("never returns an unregistered name", () => {
    const names = new Set<string>([...AIR_FAMILY_ICONS]);
    for (const kind of ["commercial", "business", "military", "general"] as const) {
      for (const model of [null, "", "XYZZY", "F70", "S7", "K1200"]) {
        for (const mfr of [null, "BOEING", "FOKKER"]) {
          expect(names.has(resolveAirIcon({ kind, faaModel: model, faaMfr: mfr }))).toBe(true);
        }
      }
    }
  });
});

describe("isPackIconName (pack name registry, shared/craft.ts)", () => {
  it.each(["pw:B737", "rk:C130", "pd:E3"])("pack name %s → true", (name) => {
    expect(isPackIconName(name)).toBe(true);
  });

  it.each([
    "narrowbody", // air family name
    "fighter", // air family name
    "cargo", // sea kind name
    "C130", // bare designator — no prefix
    "pw", // prefix without the colon
  ])("non-pack name %s → false", (name) => {
    expect(isPackIconName(name)).toBe(false);
  });
});
