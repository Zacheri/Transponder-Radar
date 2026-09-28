import { describe, it, expect } from "vitest";
import { classifySea, classifyAir } from "../server/classify.js";

describe("classifySea", () => {
  it("maps each AIS code bucket to the right kind", () => {
    const cases: Array<[number, string]> = [
      [70, "cargo"], [79, "cargo"],
      [80, "tanker"], [86, "tanker"],
      [44, "passenger"], [47, "passenger"], [60, "passenger"], [63, "passenger"],
      [30, "military_vessel"], [54, "military_vessel"], [57, "military_vessel"],
      [32, "fishing"],
      [31, "sailing"], [36, "sailing"],
      [37, "pleasure"],
      [33, "tug_work"], [35, "tug_work"], [50, "tug_work"], [52, "tug_work"], [59, "tug_work"],
      [38, "service"], [43, "service"], [53, "service"], [56, "service"], [58, "service"],
      [0, "other"], [90, "other"], [99, "other"],
    ];
    for (const [code, kind] of cases) expect(classifySea(code), `code ${code}`).toBe(kind);
  });

  it("returns other for null/undefined", () => {
    expect(classifySea(null)).toBe("other");
    expect(classifySea(undefined)).toBe("other");
  });
});

describe("classifyAir", () => {
  it("SPI flag → military regardless of callsign", () => {
    expect(classifyAir({ spi: true, callsign: "WHATEVER" })).toBe("military");
  });

  it("airline designator + number → commercial", () => {
    for (const cs of ["DAL539", "AAL2174", "UAL1716", "BAW123", "UAE24"]) {
      expect(classifyAir({ callsign: cs }), cs).toBe("commercial");
    }
  });

  it("US N-number → business", () => {
    for (const cs of ["N759SG", "N123AB", "N4567"]) {
      expect(classifyAir({ callsign: cs }), cs).toBe("business");
    }
  });

  it("known biz-jet prefix → business", () => {
    for (const cs of ["EJA123", "GTF456", "LEG789", "RJS101", "FGE202"]) {
      expect(classifyAir({ callsign: cs }), cs).toBe("business");
    }
  });

  it("military callsign pattern → military", () => {
    for (const cs of ["USAF700", "NATOLIFT", "REAPER1"]) {
      expect(classifyAir({ callsign: cs }), cs).toBe("military");
    }
  });

  it("everything else → general", () => {
    for (const cs of ["HELLO", "", undefined]) {
      expect(classifyAir({ callsign: cs }), String(cs)).toBe("general");
    }
  });
});
