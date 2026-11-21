import { describe, it, expect } from "vitest";
import {
  haversineMeters,
  greatCircle,
  destinationPoint,
  initialBearingDeg,
  etaMs,
  type LonLat,
} from "../shared/geo.js";

const JFK: LonLat = { lon: -73.7789, lat: 40.6399 };
const LHR: LonLat = { lon: -0.4543, lat: 51.47 };
const ANC: LonLat = { lon: -149.9, lat: 61.17 };
const HND: LonLat = { lon: 139.78, lat: 50.31 };

describe("haversineMeters", () => {
  it("computes JFK→LHR ≈ 5540 km (±1%)", () => {
    const m = haversineMeters(JFK, LHR);
    expect(Math.abs(m - 5_540_000) / 5_540_000).toBeLessThan(0.01);
  });

  it("is 0 for the same point and symmetric", () => {
    expect(haversineMeters(JFK, JFK)).toBe(0);
    expect(haversineMeters(JFK, LHR)).toBeCloseTo(haversineMeters(LHR, JFK), 6);
  });
});

describe("greatCircle", () => {
  it("interpolates with exact endpoints and default 64 points", () => {
    const pts = greatCircle(JFK, LHR);
    expect(pts.length).toBe(64);
    expect(pts[0]).toEqual(JFK);
    expect(pts[63]).toEqual(LHR);
  });

  it("honours the points argument", () => {
    const pts = greatCircle(JFK, LHR, 10);
    expect(pts.length).toBe(10);
    expect(pts[0]).toEqual(JFK);
    expect(pts[9]).toEqual(LHR);
  });

  it("returns a single point for a deep-equal pair", () => {
    expect(greatCircle(ANC, { lon: ANC.lon, lat: ANC.lat })).toEqual([ANC]);
  });

  it("stays on the great circle between the endpoints", () => {
    const pts = greatCircle(JFK, LHR, 33);
    for (let i = 1; i < 32; i++) {
      const via = haversineMeters(JFK, pts[i]) + haversineMeters(pts[i], LHR);
      expect(via / haversineMeters(JFK, LHR)).toBeGreaterThan(0.999);
      expect(via / haversineMeters(JFK, LHR)).toBeLessThan(1.001);
    }
  });

  it("crosses the dateline continuously (ANC→HND)", () => {
    const pts = greatCircle(ANC, HND);
    for (let i = 1; i < pts.length; i++) {
      expect(Math.abs(pts[i].lon - pts[i - 1].lon)).toBeLessThan(30);
    }
    // Unwrapped longitudes run monotonically westward: -149.9 down past 180.
    for (let i = 1; i < pts.length; i++) {
      expect(pts[i].lon).toBeLessThan(pts[i - 1].lon);
    }
    const last = pts[pts.length - 1];
    expect(last.lon).toBe(HND.lon - 360);
    expect(last.lat).toBe(HND.lat);
  });
});

describe("destinationPoint", () => {
  const origin: LonLat = { lon: 0, lat: 0 };

  it("goes due north from the equator", () => {
    const p = destinationPoint(origin, 0, 100_000);
    expect(p.lat).toBeGreaterThan(0);
    expect(Math.abs(p.lon)).toBeLessThan(1e-9);
    expect(Math.abs(haversineMeters(origin, p) - 100_000)).toBeLessThan(1);
  });

  it("goes due east from the equator", () => {
    const p = destinationPoint(origin, 90, 100_000);
    expect(p.lon).toBeGreaterThan(0);
    expect(Math.abs(p.lat)).toBeLessThan(1e-9);
    expect(Math.abs(haversineMeters(origin, p) - 100_000)).toBeLessThan(1);
  });
});

describe("initialBearingDeg", () => {
  it("gives cardinals from the equator", () => {
    expect(initialBearingDeg({ lon: 0, lat: 0 }, { lon: 0, lat: 5 })).toBeCloseTo(0, 6);
    expect(initialBearingDeg({ lon: 0, lat: 0 }, { lon: 5, lat: 0 })).toBeCloseTo(90, 6);
    expect(initialBearingDeg({ lon: 0, lat: 5 }, { lon: 0, lat: 0 })).toBeCloseTo(180, 6);
    expect(initialBearingDeg({ lon: 0, lat: 0 }, { lon: -5, lat: 0 })).toBeCloseTo(270, 6);
  });

  it("normalizes to [0, 360)", () => {
    for (const b of [initialBearingDeg(JFK, LHR), initialBearingDeg(LHR, JFK)]) {
      expect(b).toBeGreaterThanOrEqual(0);
      expect(b).toBeLessThan(360);
    }
    expect(initialBearingDeg(JFK, LHR)).toBeCloseTo(51.4, 1);
    expect(initialBearingDeg(LHR, JFK)).toBeCloseTo(287.9, 1);
  });
});

describe("etaMs", () => {
  const now = 1_700_000_000_000;

  it("is null for null/undefined/non-positive speed", () => {
    expect(etaMs(JFK, LHR, null, now)).toBeNull();
    expect(etaMs(JFK, LHR, undefined, now)).toBeNull();
    expect(etaMs(JFK, LHR, 0, now)).toBeNull();
    expect(etaMs(JFK, LHR, -250, now)).toBeNull();
  });

  it("flies 500 km at 450 kt in ≈2160 s past now", () => {
    const from: LonLat = { lon: 0, lat: 0 };
    const to = destinationPoint(from, 0, 500_000);
    const eta = etaMs(from, to, 450, now);
    expect(eta).not.toBeNull();
    expect(eta! - now).toBeGreaterThan(2_160_000 * 0.99);
    expect(eta! - now).toBeLessThan(2_160_000 * 1.01);
  });

  it("arrives at now for the same point", () => {
    expect(etaMs(JFK, JFK, 450, now)).toBe(now);
  });
});
