import { describe, it, expect } from "vitest";
import {
  effectivePosition,
  startMotionTick,
  MOTION_MAX_AGE_MS,
} from "../src/map/motion.js";
import { haversineMeters, initialBearingDeg, MS_PER_KNOT } from "../shared/geo.js";
import type { Craft } from "../shared/craft.js";
import { sleep, waitFor } from "./util.js";

function air(over: Partial<Craft> = {}): Craft {
  return {
    id: "ac4963", domain: "air", kind: "commercial", lat: 0, lon: 0,
    speed: 480, heading: 90, callsign: "DAL539", updatedAt: 0, stale: false, ...over,
  };
}
function sea(over: Partial<Craft> = {}): Craft {
  return {
    id: "368207620", domain: "sea", kind: "cargo", lat: 51.5, lon: -0.1,
    speed: 12.5, heading: 90, shipName: "EXAMPLE", updatedAt: 0, stale: false, ...over,
  };
}

const stored = (c: Craft) => ({ lat: c.lat, lon: c.lon });

describe("effectivePosition — exclusions (R1) pass the fix through untouched", () => {
  it("never moves a vessel, however fast", () => {
    expect(effectivePosition(sea({ speed: 480 }), 60_000)).toEqual(stored(sea()));
    expect(effectivePosition(sea({ speed: 480 }), MOTION_MAX_AGE_MS * 4)).toEqual(stored(sea()));
  });

  it("leaves on-ground craft at the fix (null/undefined = airborne)", () => {
    expect(effectivePosition(air({ onGround: true }), 60_000)).toEqual(stored(air()));
    expect(effectivePosition(air({ onGround: undefined }), 60_000)).not.toEqual(stored(air()));
    expect(effectivePosition(air({ onGround: false }), 60_000)).not.toEqual(stored(air()));
  });

  it("leaves craft with no usable speed at the fix", () => {
    for (const speed of [null, 0, -480, NaN]) {
      expect(effectivePosition(air({ speed }), 60_000)).toEqual(stored(air()));
    }
  });

  it("leaves craft with a missing or out-of-range heading at the fix", () => {
    for (const heading of [null, NaN, -1, -0.001, 360, 1000, Infinity]) {
      expect(effectivePosition(air({ heading }), 60_000)).toEqual(stored(air()));
    }
    // the valid ends of the range do move
    for (const heading of [0, 359.999, 180]) {
      expect(effectivePosition(air({ heading }), 60_000)).not.toEqual(stored(air()));
    }
  });

  it("returns the stored fix verbatim at age 0 and for a future-dated fix", () => {
    expect(effectivePosition(air(), 0)).toEqual(stored(air()));
    expect(effectivePosition(air({ updatedAt: 10_000 }), 5_000)).toEqual(stored(air()));
  });

  it("passes through without float churn (exact stored values)", () => {
    const c = air({ lat: 40.63987654321, lon: -73.7789012345678, onGround: true });
    const p = effectivePosition(c, 60_000);
    expect(p.lat).toBe(c.lat);
    expect(p.lon).toBe(c.lon);
  });

  it("reads only nowMs — a 1970 fix extrapolates, it does not freeze", () => {
    const c = air({ updatedAt: 0 });
    const p = effectivePosition(c, 60_000);
    expect(haversineMeters(stored(c), p)).toBeCloseTo(480 * MS_PER_KNOT * 60, -1);
  });

  it("is deterministic and never mutates the craft", () => {
    const c = air({ updatedAt: 5_000 });
    const before = JSON.parse(JSON.stringify(c));
    expect(effectivePosition(c, 65_000)).toEqual(effectivePosition(c, 65_000));
    expect(c).toEqual(before);
  });
});

describe("effectivePosition — dead-reckoned displacement", () => {
  it("freezes at the 150 s cap, not the last fix", () => {
    expect(MOTION_MAX_AGE_MS).toBe(150_000);
    const c = air({ updatedAt: 0 });
    const at150 = effectivePosition(c, MOTION_MAX_AGE_MS);
    expect(at150).not.toEqual(stored(c));
    expect(effectivePosition(c, MOTION_MAX_AGE_MS + 1)).toEqual(at150);
    expect(effectivePosition(c, 10 * 60_000)).toEqual(at150);
    expect(haversineMeters(stored(c), at150)).toBeCloseTo(480 * MS_PER_KNOT * 150, -1);
  });

  it("grows monotonically with age up to the cap", () => {
    const c = air({ updatedAt: 0 });
    const d = (ms: number) => haversineMeters(stored(c), effectivePosition(c, ms));
    expect(d(0)).toBe(0);
    expect(d(60_000)).toBeGreaterThan(d(1_000));
    expect(d(149_900)).toBeGreaterThan(d(60_000));
    expect(d(150_000)).toBeGreaterThan(d(149_900));
    expect(d(160_000)).toBe(d(150_000));
  });

  it("moves an equator eastbound leg speed×time (480 kt, 60 s = 8 NM)", () => {
    const c = air({ lat: 0, lon: 0, speed: 480, heading: 90, updatedAt: 0 });
    const p = effectivePosition(c, 60_000);
    const expectedM = 480 * MS_PER_KNOT * 60; // 8 NM
    expect(Math.abs(haversineMeters(stored(c), p) - expectedM) / expectedM).toBeLessThan(0.005);
    // great-circle distance and track agree with the model to micro-degree scale
    expect(haversineMeters(stored(c), p)).toBeCloseTo(expectedM, 6);
    expect(initialBearingDeg(stored(c), p)).toBeCloseTo(90, 6);
    expect(Math.abs(p.lat)).toBeLessThan(1e-9);
    // 8 NM = 8 arcmin of longitude on the equator
    expect(Math.abs(p.lon - 8 / 60) / (8 / 60)).toBeLessThan(0.005);
    expect(p.lon).toBeGreaterThan(0);
  });

  it("flies a 60°N meridian leg on the meridian (latitude-only, exact-ish)", () => {
    const start = { lat: 60, lon: -73.78 };
    const c = air({ ...start, speed: 300, heading: 0, updatedAt: 0 });
    const p = effectivePosition(c, 60_000);
    const expectedM = 300 * MS_PER_KNOT * 60; // 5 NM
    expect(Math.abs(haversineMeters(start, p) - expectedM) / expectedM).toBeLessThan(0.005);
    expect(p.lat).toBeGreaterThan(60);
    expect(Math.abs(p.lon - start.lon)).toBeLessThan(1e-9);
    expect(initialBearingDeg(start, p)).toBeCloseTo(0, 6);
  });

  it("keeps the aircraft on the heading it was given", () => {
    for (const heading of [0, 45, 90, 135, 180, 225, 270, 315]) {
      const c = air({ lat: 34.05, lon: -118.24, heading, speed: 400, updatedAt: 0 });
      const p = effectivePosition(c, 90_000);
      const delta = Math.abs(((initialBearingDeg(stored(c), p) - heading + 540) % 360) - 180);
      expect(delta).toBeLessThan(1e-4);
    }
  });
});

describe("startMotionTick", () => {
  it("ticks repeatedly and stops when disposed", async () => {
    let calls = 0;
    const stop = startMotionTick(15, () => calls++);
    await waitFor(() => calls >= 3);
    stop();
    const seen = calls;
    await sleep(60);
    expect(calls).toBe(seen);
  });

  it("returns an idempotent disposer that is safe before the first tick", async () => {
    let calls = 0;
    const stop = startMotionTick(15, () => calls++);
    expect(() => stop()).not.toThrow();
    expect(() => stop()).not.toThrow();
    const seen = calls;
    await sleep(60);
    expect(calls).toBe(seen);
  });

  it("gives up once after 3 consecutive throws and stops ticking", async () => {
    let calls = 0;
    let giveUps = 0;
    startMotionTick(
      15,
      () => {
        calls++;
        throw new Error("render exploded");
      },
      () => giveUps++,
    );
    await waitFor(() => giveUps === 1);
    await sleep(60);
    expect(calls).toBe(3);
    expect(giveUps).toBe(1);
  });

  it("resets the consecutive-throw streak on a successful tick", async () => {
    const steps = ["throw", "throw", "ok", "throw", "throw", "throw"];
    let calls = 0;
    let giveUps = 0;
    let callsAtGiveUp = 0;
    startMotionTick(
      15,
      () => {
        const step = steps[Math.min(calls++, steps.length - 1)];
        if (step === "throw") throw new Error("render exploded");
      },
      () => {
        giveUps++;
        callsAtGiveUp = calls; // 6, not 3: the success cleared the streak
      },
    );
    await waitFor(() => giveUps === 1);
    await sleep(60);
    expect(callsAtGiveUp).toBe(6);
    expect(giveUps).toBe(1);
  });

  it("warns once and stops when no onGiveUp is given", async () => {
    const realWarn = console.warn;
    let warns = 0;
    console.warn = () => warns++;
    let calls = 0;
    try {
      startMotionTick(15, () => {
        calls++;
        throw new Error("render exploded");
      });
      await waitFor(() => warns === 1);
      await sleep(60);
      expect(warns).toBe(1);
      expect(calls).toBe(3);
    } finally {
      console.warn = realWarn;
    }
  });
});
