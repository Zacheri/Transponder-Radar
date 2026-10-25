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
  const pack = new Set(["rk:C130", "rk:H60", "pd:E3", "rk:R135", "rk:H64"]);

  test("military token emits pack name when present", () => {
    expect(resolveAirIcon({ kind: "military", callsign: "C130", faaModel: null, faaMfr: null, pack })).toBe("rk:C130");
    expect(resolveAirIcon({ kind: "military", callsign: "UH60A", faaModel: null, faaMfr: null, pack })).toBe("rk:H60");
    expect(resolveAirIcon({ kind: "military", callsign: "E3", faaModel: null, faaMfr: null, pack })).toBe("pd:E3");
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
    ["BD-700-2A12", "BOMBARDIER INC", "rk:GL5T"],
    ["RJ85A", "BAE SYSTEMS", "rk:RJ85"],
    ["F.28 2000", "FOKKER", "pw:F28"],
    // bizjet
    ["GVI (G650)", "GULFSTREAM AEROSPACE", "rk:GLF6"],
    ["P-180", "PIAGGIO", "rk:P180"],
    ["560XL", "CESSNA AIRCRAFT CO", "pw:C560"],
    // helis
    ["CH-47D", "MCDONNELL DOUGLAS", "milheli"], // pd:CH47 dropped (3-view sheet) — family fallback
    ["UH-60A", "AAR AIRLIFT GROUP INC", "rk:H60"],
    ["212", "BELL", "rk:UH1"],
    ["206", "BELL", "pw:B06"],
    ["SA365N", "AEROSPATIALE", "pw:AS65"],
    ["BK117A-4", "KAWASAKI", "pw:EC45"],
    ["AGUSTA A109", "AGUSTA SPA", "pw:A109"],
    // turboprop
    ["HS.748 SERIES 2A", "HAWKER SIDDELEY", "pw:A748"],
    ["ATR42-500", "AEROSPATIALE", "rk:AT45"],
    ["DHC-8-300", "DEHAVILLAND", "rk:DH8C"],
    ["208B", "CESSNA", "rk:F406"],
    ["1900D", "BEECH", "pw:B190D"],
    ["B-350", "BEECH", "pw:B350"],
    ["328JET", "DORNIER", "rk:D328"],
    ["690A", "ROCKWELL INTERNATIONAL", "pw:AC90"],
    ["840", "GULFSTREAM TURBO COMMANDER", "pw:AC90"],
    // piston / light
    ["C-47", "DOUGLAS", "rk:DC3"],
    ["75-L-3", "STEARMAN AIRCRAFT", "rk:ST75"],
    ["PA-32-300", "PIPER", "pw:P32T"],
    ["441", "CESSNA", "pw:C441"],
    ["BN-2B-21", "PILATUS BRITTEN NORMAN", "rk:BN2P"],
    ["8GCBC", "BELLANCA", "pw:BL8"],
    ["EMB-820", "EMBRAER", "pw:PA31"],
    // no-art controls (family layer must stay put)
    ["737-600", "BOEING", "narrowbody"],
    ["ATR-72-212", "AEROSPATIALE", "turboprop"],
    ["CL-600-2B16", "BOMBARDIER INC", "bizjet"], // Challenger 600 — no art
    ["B206", "BELL", "heli"], // custom B-prefixed name
    ["MD-88", "MCDONNELL DOUGLAS", "narrowbody"],
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
