import { describe, expect, it } from "vitest";
import { creditsPerDay, statesCallCost } from "../shared/credits.js";

describe("statesCallCost", () => {
  it("prices the <=25 sq deg tier as 1 (5x5 exactly on the edge)", () => {
    expect(statesCallCost(5, 5)).toBe(1);
    expect(statesCallCost(1, 1)).toBe(1);
  });

  it("steps to 2 just past 25 sq deg", () => {
    expect(statesCallCost(25.0001, 1)).toBe(2);
  });

  it("prices <=100 sq deg as 2, steps to 3 just past 100", () => {
    expect(statesCallCost(10, 10)).toBe(2);
    expect(statesCallCost(100.0001, 1)).toBe(3);
  });

  it("prices <=400 sq deg as 3 (20x20 exactly on the edge), steps to 4 past 400", () => {
    expect(statesCallCost(20, 20)).toBe(3);
    expect(statesCallCost(400.0001, 1)).toBe(4);
  });

  it("prices the globe as 4", () => {
    expect(statesCallCost(360, 180)).toBe(4);
  });

  it("returns the worst tier for garbage dims (conservative, never under-costs)", () => {
    expect(statesCallCost(NaN, 5)).toBe(4);
    expect(statesCallCost(5, NaN)).toBe(4);
    expect(statesCallCost(-5, -5)).toBe(4); // negative product must not read as area
    expect(statesCallCost(-1, 10)).toBe(4);
    expect(statesCallCost(Number.POSITIVE_INFINITY, 1)).toBe(4);
  });
});

describe("creditsPerDay", () => {
  it("is cost x cadence (20x20 at 30 s = 3 x 2880)", () => {
    expect(creditsPerDay(20, 20, 30_000)).toBe(3 * 2880);
  });

  it("matches the known globe math (4 credits at 90 s = 3840)", () => {
    expect(creditsPerDay(360, 180, 90_000)).toBe(3840);
  });

  it("is 0 for a non-polling interval", () => {
    expect(creditsPerDay(5, 5, 0)).toBe(0);
    expect(creditsPerDay(5, 5, -1)).toBe(0);
    expect(creditsPerDay(5, 5, NaN)).toBe(0);
    expect(creditsPerDay(5, 5, Number.POSITIVE_INFINITY)).toBe(0);
  });
});
