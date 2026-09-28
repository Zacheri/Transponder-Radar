import { describe, it, expect } from "vitest";
import { normalizeOpenSky } from "../server/normalize.js";

// 17-field OpenSky state vector
function vec(over: Record<number, string | number | boolean | null> = {}): (string | number | boolean | null)[] {
  const base: (string | number | boolean | null)[] = [
    "ac4963", "DAL539", "United States", 1700000000, 1700000000,
    -73.7, 40.6, 10000, false, 250, 90, 10, null, 10050, "1200", false, 2,
  ];
  return base.map((v, i) => (i in over ? over[i as number] : v));
}

describe("normalizeOpenSky", () => {
  it("maps fields and converts units", () => {
    const c = normalizeOpenSky(vec(), 1700000000000)!;
    expect(c.id).toBe("ac4963");
    expect(c.domain).toBe("air");
    expect(c.kind).toBe("commercial");
    expect(c.lat).toBeCloseTo(40.6);
    expect(c.lon).toBeCloseTo(-73.7);
    expect(c.speed).toBeCloseTo(250 * 1.94384); // m/s -> kn
    expect(c.heading).toBe(90);
    expect(c.altitude).toBeCloseTo(10050 * 3.28084); // geo alt m -> ft
    expect(c.verticalRate).toBeCloseTo(10 * 196.850); // m/s -> fpm
    expect(c.squawk).toBe("1200");
    expect(c.onGround).toBe(false);
    expect(c.spi).toBe(false);
    expect(c.originCountry).toBe("United States");
    expect(c.callsign).toBe("DAL539");
    expect(c.updatedAt).toBe(1700000000000);
    expect(c.stale).toBe(false);
  });

  it("prefers geo altitude, falls back to baro", () => {
    const geo = normalizeOpenSky(vec({ 13: 10050 }), 0)!;
    const baro = normalizeOpenSky(vec({ 13: null }), 0)!;
    expect(geo.altitude).toBeCloseTo(10050 * 3.28084);
    expect(baro.altitude).toBeCloseTo(10000 * 3.28084);
  });

  it("SPI → military kind", () => {
    const c = normalizeOpenSky(vec({ 15: true, 1: "USAF1" }), 0)!;
    expect(c.kind).toBe("military");
    expect(c.spi).toBe(true);
  });

  it("nulls speed/heading/altitude when missing", () => {
    const c = normalizeOpenSky(vec({ 9: null, 10: null, 7: null, 13: null, 11: null }), 0)!;
    expect(c.speed).toBeNull();
    expect(c.heading).toBeNull();
    expect(c.altitude).toBeNull();
    expect(c.verticalRate).toBeNull();
  });

  it("returns null when icao24 or position missing", () => {
    expect(normalizeOpenSky(vec({ 0: null }), 0)).toBeNull();
    expect(normalizeOpenSky(vec({ 5: null }), 0)).toBeNull();
    expect(normalizeOpenSky(vec({ 6: null }), 0)).toBeNull();
  });
});
