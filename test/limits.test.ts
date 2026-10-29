import { describe, it, expect } from "vitest";
import {
  GB,
  STORAGE_CAP_GB_MIN,
  STORAGE_CAP_GB_MAX,
  RAM_CACHE_GB_MIN,
  RAM_CACHE_GB_MAX,
  RAM_CACHE_GB_DEFAULT,
  MIN_PIN_MS,
  SPEED_MIN,
  SPEED_DEFAULT,
  SPEED_MAX,
  SPEED_SLIDER_MAX,
  WINDOW_CHUNK_ITEMS,
  WINDOW_MAX_BYTES_MIN,
  WINDOW_MAX_BYTES_MAX,
  WINDOW_MAX_BYTES_DEFAULT,
  speedFromSlider,
  sliderFromSpeed,
  clampStorageCapGb,
  clampRamCacheGb,
} from "../shared/limits.js";

describe("timeline-modernization limits constants", () => {
  it("matches the exact Interfaces block values", () => {
    expect(GB).toBe(1024 ** 3);
    expect(STORAGE_CAP_GB_MIN).toBe(0.5);
    expect(STORAGE_CAP_GB_MAX).toBe(1000);
    expect(RAM_CACHE_GB_MIN).toBe(0);
    expect(RAM_CACHE_GB_MAX).toBe(16);
    expect(RAM_CACHE_GB_DEFAULT).toBe(1);
    expect(MIN_PIN_MS).toBe(60_000);
    expect(SPEED_MIN).toBe(30);
    expect(SPEED_DEFAULT).toBe(3_600);
    expect(SPEED_MAX).toBe(86_400);
    expect(SPEED_SLIDER_MAX).toBe(1000);
    expect(WINDOW_CHUNK_ITEMS).toBe(3);
    expect(WINDOW_MAX_BYTES_MIN).toBe(1 << 20);
    expect(WINDOW_MAX_BYTES_MAX).toBe(64 << 20);
    expect(WINDOW_MAX_BYTES_DEFAULT).toBe(32 << 20);
  });
});

describe("speedFromSlider / sliderFromSpeed", () => {
  it("maps the slider endpoints exactly", () => {
    expect(speedFromSlider(0)).toBe(30);
    expect(speedFromSlider(1000)).toBe(86_400);
  });

  it("clamps out-of-range input to the slider bounds", () => {
    expect(speedFromSlider(-10)).toBe(30);
    expect(speedFromSlider(1001)).toBe(86_400);
  });

  it("maps speed to the slider endpoints", () => {
    expect(sliderFromSpeed(30)).toBe(0);
    expect(sliderFromSpeed(86_400)).toBe(1000);
  });

  it("round-trips an interior speed to within ±2", () => {
    expect(Math.abs(speedFromSlider(sliderFromSpeed(3600)) - 3600)).toBeLessThanOrEqual(2);
  });
});

describe("clampStorageCapGb / clampRamCacheGb", () => {
  it("clamps storage cap to [0.5, 1000]", () => {
    expect(clampStorageCapGb(0.0001)).toBe(0.5);
    expect(clampStorageCapGb(99_999)).toBe(1000);
    expect(clampStorageCapGb(NaN)).toBe(0.5);
  });

  it("clamps ram cache to [0, 16]", () => {
    expect(clampRamCacheGb(-1)).toBe(0);
    expect(clampRamCacheGb(99)).toBe(16);
    expect(clampRamCacheGb(NaN)).toBe(0);
  });
});
