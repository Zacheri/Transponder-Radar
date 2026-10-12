import { describe, it, expect } from "vitest";
import { KIND_FALLBACK_ICON } from "../shared/craft.js";

describe("KIND_FALLBACK_ICON", () => {
  it("maps each air kind to its approved fallback family", () => {
    expect(KIND_FALLBACK_ICON).toEqual({
      commercial: "narrowbody",
      business: "bizjet",
      military: "fighter",
      general: "piston",
    });
  });
});
