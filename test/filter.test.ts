import { describe, it, expect } from "vitest";
import { buildIconFilter } from "../src/data/filter.js";
import { AIR_KINDS, SEA_KINDS } from "../shared/craft.js";
import type { CraftKind } from "../shared/craft.js";

describe("buildIconFilter", () => {
  it("shows visible kinds; tiny kinds only appear at zoom >= 5", () => {
    expect(buildIconFilter(new Set(["commercial", "cargo"]))).toEqual([
      "all",
      ["in", ["get", "kind"], ["literal", ["commercial", "cargo"]]],
      [
        "any",
        [">=", ["zoom"], 5],
        ["!", ["in", ["get", "kind"], ["literal", ["pleasure", "sailing", "general"]]]],
      ],
    ]);
  });

  it("never emits the legacy 'not' keyword — MapLibre expressions use '!' for logical NOT", () => {
    const all = new Set<CraftKind>([...AIR_KINDS, ...SEA_KINDS]);
    expect(JSON.stringify(buildIconFilter(all))).not.toContain('"not"');
  });
});
