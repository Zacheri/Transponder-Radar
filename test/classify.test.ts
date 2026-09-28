import { describe, it, expect } from "vitest";
import { classifySea } from "../server/classify.js";

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
