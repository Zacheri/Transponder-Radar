import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, expect } from "vitest";
import { loadIconSources, type IconSources } from "../server/iconpack-sources.js";

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
    expect(s.pd.length).toBe(15);
    expect(new Set(s.pd.map((e) => e.name)).size).toBe(s.pd.length);
    for (const e of s.pd) {
      expect(e.name).toMatch(/^pd:[A-Z0-9]+$/);
      expect(e.file).toMatch(/^pd\/.+\.(png|svg|gif)$/);
      expect(e.sha256).toMatch(/^[0-9a-f]{64}$/);
      expect(e.url).toMatch(/^https:\/\/(commons\.wikimedia\.org|upload\.wikimedia\.org)\//);
      expect(e.title.length).toBeGreaterThan(0);
      expect(e.license.length).toBeGreaterThan(0);
      expect(e.attribution.length).toBeGreaterThan(0);
      // exactly one of cropTopRatio / crop, each well-formed
      const ratioOk = typeof e.cropTopRatio === "number" && e.cropTopRatio > 0 && e.cropTopRatio <= 1;
      const cropOk =
        e.crop !== undefined &&
        [e.crop.x, e.crop.y, e.crop.w, e.crop.h].every((v) => typeof v === "number" && v >= 0 && v <= 1) &&
        e.crop.w > 0 &&
        e.crop.h > 0;
      expect(ratioOk || cropOk).toBe(true);
      expect(ratioOk && cropOk).toBe(false);
    }
  });

  it("rotated sheets carry the audited rot + crop (2026-11-18 fix wave)", () => {
    const expected: Record<string, [number, { x: number; y: number; w: number; h: number }]> = {
      "pd:C150": [180, { x: 0, y: 0.35, w: 1, h: 0.35 }],
      "pd:A37": [180, { x: 0.01, y: 0.16, w: 0.5, h: 0.64 }],
      "pd:D55": [180, { x: 0, y: 0.04, w: 1, h: 0.33 }],
      "pd:PA24": [180, { x: 0, y: 0.025, w: 1, h: 0.43 }],
      "pd:C310": [180, { x: 0, y: 0.52, w: 1, h: 0.45 }],
      "pd:GIV": [90, { x: 0, y: 0.2, w: 0.86, h: 0.42 }],
      "pd:MD8": [180, { x: 0.625, y: 0.015, w: 0.375, h: 0.5 }],
    };
    for (const [name, [rot, crop]] of Object.entries(expected)) {
      const e = s.pd.find((x) => x.name === name);
      expect(e?.rot, `${name} rot`).toBe(rot);
      expect(e?.crop, `${name} crop`).toEqual(crop);
    }
    const rotated = s.pd.filter((e) => e.rot !== undefined).map((e) => e.name).sort();
    expect(rotated).toEqual(Object.keys(expected).sort());
  });

  it("no pd entry may point at the two re-sourced names (replaced by vendored art)", () => {
    for (const name of ["pd:E6", "pd:ATR72"]) {
      expect(s.pd.find((e) => e.name === name)).toBeUndefined();
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

  // pdEntryShape is exercised through loadIconSources on a temp manifest so
  // the real committed file is never mutated by a synthetic case.
  function tempSources(mutate: (s: IconSources) => void): string {
    const base = loadIconSources();
    mutate(base);
    const p = join(mkdtempSync(join(tmpdir(), "radar-sources-")), "iconpack-sources.json");
    writeFileSync(p, JSON.stringify(base, null, 2));
    return p;
  }

  it("pd entry with a crop rectangle loads", () => {
    const p = tempSources((s) => {
      const e = s.pd[0];
      delete e.cropTopRatio;
      e.crop = { x: 0.5, y: 0, w: 0.5, h: 0.6 };
    });
    const s = loadIconSources(p);
    expect(s.pd[0].crop).toEqual({ x: 0.5, y: 0, w: 0.5, h: 0.6 });
  });

  it("pd entry with BOTH crop and cropTopRatio throws", () => {
    const p = tempSources((s) => {
      s.pd[0].crop = { x: 0, y: 0, w: 1, h: 1 };
    });
    expect(() => loadIconSources(p)).toThrowError(/exactly one/);
  });

  it("pd entry with NEITHER crop nor cropTopRatio throws", () => {
    const p = tempSources((s) => {
      delete s.pd[0].cropTopRatio;
    });
    expect(() => loadIconSources(p)).toThrowError(/exactly one/);
  });

  it("pd entry rot: only 90/180/270 accepted", () => {
    for (const rot of [90, 180, 270] as const) {
      const p = tempSources((s) => {
        s.pd[0].rot = rot;
      });
      expect(loadIconSources(p).pd[0].rot).toBe(rot);
    }
    for (const bad of [0, 45, 360, -90, "180"]) {
      const p = tempSources((s) => {
        (s.pd[0] as unknown as Record<string, unknown>).rot = bad;
      });
      expect(() => loadIconSources(p), String(bad)).toThrowError(/rot/);
    }
  });

  it("pd crop coordinates outside [0,1] or zero size throw", () => {
    for (const bad of [
      { x: -0.1, y: 0, w: 1, h: 1 },
      { x: 0, y: 1.5, w: 1, h: 1 },
      { x: 0, y: 0, w: 0, h: 1 },
      { x: 0, y: 0, w: 1, h: 0 },
    ]) {
      const p = tempSources((s) => {
        delete s.pd[0].cropTopRatio;
        s.pd[0].crop = bad;
      });
      expect(() => loadIconSources(p), JSON.stringify(bad)).toThrowError(/crop/);
    }
  });
});
