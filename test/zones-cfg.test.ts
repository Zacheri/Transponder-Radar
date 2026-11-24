import { describe, it, expect } from "vitest";
import { parseZonesCfg, serializeZonesCfg, ZONES_CFG_KEY, type ZonesCfg } from "../src/ui/zones-cfg.js";

describe("zones-cfg storage", () => {
  it("exposes the localStorage key", () => {
    expect(ZONES_CFG_KEY).toBe("radar.zonesCfg");
  });

  it("round-trips a config through serialize/parse", () => {
    const cfg: ZonesCfg = { kinds: ["military", "general"], boostMs: 45000 };
    expect(parseZonesCfg(serializeZonesCfg(cfg))).toEqual(cfg);
  });

  it("accepts an empty kinds list", () => {
    const cfg: ZonesCfg = { kinds: [], boostMs: 30000 };
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
