import { describe, it, expect } from "vitest";
import { parseZonesCfg, serializeZonesCfg, ZONES_CFG_KEY, type ZonesCfg } from "../src/ui/zones-cfg.js";

describe("zones-cfg storage", () => {
  it("exposes the localStorage key", () => {
    expect(ZONES_CFG_KEY).toBe("radar.zonesCfg");
  });

  it("round-trips a config through serialize/parse", () => {
    const cfg: ZonesCfg = {
      kinds: ["military", "general"],
      boostMs: 45000,
      auto: { enabled: true, createMin: 4, standdownAt: 1 },
    };
    expect(parseZonesCfg(serializeZonesCfg(cfg))).toEqual(cfg);
  });

  it("accepts an empty kinds list", () => {
    const cfg: ZonesCfg = { kinds: [], boostMs: 30000, auto: { enabled: true, createMin: 2, standdownAt: 0 } };
    expect(parseZonesCfg(serializeZonesCfg(cfg))).toEqual(cfg);
  });

  it("returns null for null/empty/corrupt input", () => {
    expect(parseZonesCfg(null)).toBeNull();
    expect(parseZonesCfg("")).toBeNull();
    expect(parseZonesCfg("{oops")).toBeNull();
    expect(parseZonesCfg("null")).toBeNull();
    expect(parseZonesCfg("[]")).toBeNull();
    expect(parseZonesCfg('"x"')).toBeNull();
  });

  it("returns null when kinds is missing, not an array, or holds a non-air kind", () => {
    expect(parseZonesCfg(JSON.stringify({ boostMs: 30000 }))).toBeNull();
    expect(parseZonesCfg(JSON.stringify({ kinds: "military", boostMs: 30000 }))).toBeNull();
    expect(parseZonesCfg(JSON.stringify({ kinds: ["cargo"], boostMs: 30000 }))).toBeNull();
    expect(parseZonesCfg(JSON.stringify({ kinds: [1], boostMs: 30000 }))).toBeNull();
  });

  it("returns null when boostMs is missing, non-numeric or non-finite", () => {
    expect(parseZonesCfg(JSON.stringify({ kinds: [] }))).toBeNull();
    expect(parseZonesCfg(JSON.stringify({ kinds: [], boostMs: "30000" }))).toBeNull();
    expect(parseZonesCfg(JSON.stringify({ kinds: [], boostMs: NaN }))).toBeNull();
    expect(parseZonesCfg(JSON.stringify({ kinds: [], boostMs: null }))).toBeNull();
  });
});

describe("zones-cfg auto block (v2)", () => {
  const auto = (a: unknown): ZonesCfg => parseZonesCfg(JSON.stringify({ kinds: [], boostMs: 30000, auto: a }))!;

  it("a v1 payload (no auto) upgrades to the defaults", () => {
    const cfg = parseZonesCfg(JSON.stringify({ kinds: ["military"], boostMs: 30000 }));
    expect(cfg).toEqual({ kinds: ["military"], boostMs: 30000, auto: { enabled: true, createMin: 2, standdownAt: 0 } });
  });

  it("fills defaults per field ({} and null behave like absent)", () => {
    expect(auto({}).auto).toEqual({ enabled: true, createMin: 2, standdownAt: 0 });
    expect(auto(null).auto).toEqual({ enabled: true, createMin: 2, standdownAt: 0 });
    expect(auto({ enabled: false, standdownAt: 2 }).auto).toEqual({ enabled: false, createMin: 2, standdownAt: 2 });
  });

  it("self-heals numeric-but-out-of-set values (createMin round+clamp, standdownAt fallback)", () => {
    expect(auto({ createMin: 1 }).auto.createMin).toBe(2);
    expect(auto({ createMin: 20 }).auto.createMin).toBe(10);
    expect(auto({ createMin: 3.6 }).auto.createMin).toBe(4);
    expect(auto({ standdownAt: 5 }).auto.standdownAt).toBe(0);
    expect(auto({ standdownAt: -1 }).auto.standdownAt).toBe(0);
    expect(auto({ standdownAt: 1.5 }).auto.standdownAt).toBe(0);
  });

  it("shape-corrupt auto drops the whole config (mixed strictness)", () => {
    for (const bad of [5, "x", [], { enabled: "yes" }, { createMin: "3" }, { createMin: NaN }, { standdownAt: "x" }, { standdownAt: null }]) {
      expect(auto(bad)).toBeNull();
    }
  });
});
