import { describe, it, expect } from "vitest";
import { loadIconSources } from "../server/iconpack-sources.js";

describe("iconpack-sources manifest", () => {
  const s = loadIconSources(); // committed file

  it("repos pinned with 40-hex shas and license/attribution", () => {
    for (const src of [s.pw, s.rk]) {
      expect(src.repo).toMatch(/^https:\/\/github\.com\//);
      expect(src.sha).toMatch(/^[0-9a-f]{40}$/);
      expect(src.license.length).toBeGreaterThan(0);
      expect(src.attribution.length).toBeGreaterThan(0);
    }
  });

  it("pd entries well-formed and unique", () => {
    expect(new Set(s.pd.map((e) => e.name)).size).toBe(s.pd.length);
    for (const e of s.pd) {
      expect(e.name).toMatch(/^pd:[A-Z0-9]+$/);
      expect(e.file).toMatch(/^pd\/.+\.png$/);
      expect(e.sha256).toMatch(/^[0-9a-f]{64}$/);
      expect(e.url).toMatch(/^https:\/\/(commons\.wikimedia\.org|upload\.wikimedia\.org)\//);
      expect(e.title.length).toBeGreaterThan(0);
      expect(e.license.length).toBeGreaterThan(0);
      expect(e.attribution.length).toBeGreaterThan(0);
      expect(e.cropTopRatio).toBeGreaterThan(0);
      expect(e.cropTopRatio).toBeLessThanOrEqual(1);
    }
  });

  it("gapTargets non-empty, unique designators", () => {
    expect(s.gapTargets.length).toBeGreaterThanOrEqual(10);
    expect(new Set(s.gapTargets.map((g) => g.designator)).size).toBe(s.gapTargets.length);
  });

  it("gapTargets designators are uppercase alphanumeric (ICAO-style)", () => {
    for (const g of s.gapTargets) expect(g.designator).toMatch(/^[A-Z0-9]{2,6}$/);
  });
  // (full collision validation — family/sea/tanker_air — lives in IconPack
  // index build, pinned in test/iconpack.test.ts Task 2.)
});
