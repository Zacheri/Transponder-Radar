import { describe, it, expect } from "vitest";
import { buildZonesConfig, ZONES_MAX_SECTIONS } from "../src/data/zones-assembly.js";
import type { Region, RegionBox } from "../src/data/regions.js";
import type { ZonesCfg } from "../src/ui/zones-cfg.js";

const box = (d = 0): RegionBox => [
  [d, d],
  [d + 1, d + 1],
];

const CFG: ZonesCfg = {
  kinds: ["military"],
  boostMs: 30000,
  auto: { enabled: true, createMin: 3, standdownAt: 1 },
};

const boosted = (id: string, over: Partial<Region> = {}): Region => ({
  id,
  kind: "adsb",
  b: box(),
  boost: { enabled: true, kinds: ["military"], boostMs: 20000 },
  ...over,
});

describe("buildZonesConfig", () => {
  it("passes the auto knobs through verbatim; empty regions ship no sections", () => {
    const wire = buildZonesConfig([], CFG);
    expect(wire).toEqual({ kinds: ["military"], boostMs: 30000, auto: CFG.auto, sections: [] });
  });

  it("ships only enabled boosted ADS-B sections", () => {
    const regions: Region[] = [
      { id: "plain", kind: "adsb", b: box() },
      { id: "off", kind: "adsb", b: box(), boost: { enabled: false, kinds: ["military"], boostMs: 20000 } },
      // AIS is a push feed — no poll to fund, never on the wire.
      boosted("ais", { kind: "ais" }),
      boosted("keep"),
    ];
    expect(buildZonesConfig(regions, CFG).sections).toEqual([
      { id: "keep", kinds: ["military"], boostMs: 20000, b: box() },
    ]);
  });

  it("caps sections at 6, keeping array (id-stable) order", () => {
    const regions = Array.from({ length: 8 }, (_, i) => boosted(`r${i}`));
    const { sections } = buildZonesConfig(regions, CFG);
    expect(sections).toHaveLength(ZONES_MAX_SECTIONS);
    expect(sections.map((s) => s.id)).toEqual(["r0", "r1", "r2", "r3", "r4", "r5"]);
  });

  it("skips invalid boxes without consuming a cap slot", () => {
    const insane: RegionBox = [
      [80, 0],
      [95, 1],
    ];
    const regions = [boosted("r0"), boosted("bad", { b: insane }), ...Array.from({ length: 6 }, (_, i) => boosted(`r${i + 1}`))];
    const { sections } = buildZonesConfig(regions, CFG);
    expect(sections.map((s) => s.id)).toEqual(["r0", "r1", "r2", "r3", "r4", "r5"]);
  });

  it("clamps each section's boostMs to [10000, 120000] (non-finite → default)", () => {
    const regions: Region[] = [
      boosted("lo", { boost: { enabled: true, kinds: [], boostMs: 5000 } }),
      boosted("hi", { boost: { enabled: true, kinds: [], boostMs: 999999 } }),
      boosted("nan", { boost: { enabled: true, kinds: [], boostMs: NaN } }),
    ];
    expect(buildZonesConfig(regions, CFG).sections.map((s) => s.boostMs)).toEqual([10000, 120000, 30000]);
  });

  it("a section carries exactly id, kinds, boostMs, b", () => {
    const [section] = buildZonesConfig([boosted("r0")], CFG).sections;
    expect(Object.keys(section).sort()).toEqual(["b", "boostMs", "id", "kinds"]);
  });
});
