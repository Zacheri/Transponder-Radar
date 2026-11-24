// Client-side dead reckoning (spec 2026-11-23-smooth-motion R1): where a craft
// should be drawn right now, given its last fix and velocity. Pure — no clock,
// no store, no MapLibre. Vessels and on-ground craft are excluded (ruling 1).
import type { Craft } from "../../shared/craft.js";
import { MS_PER_KNOT, destinationPoint } from "../../shared/geo.js";

// Extrapolation freezes here rather than sailing off the map during an outage
// (ruling 2). Tests pin the displacement cap symbolically.
export const MOTION_MAX_AGE_MS = 150_000;

const MAX_CONSECUTIVE_THROWS = 3;

/**
 * Fix displaced by speed × min(age, {@link MOTION_MAX_AGE_MS}) along heading.
 * Every exclusion (sea, on-ground, speed ≤ 0, heading null/out of range, age
 * ≤ 0 or NaN) returns the stored lat/lon untouched — no arithmetic, so the
 * off state stays byte-identical to the raw fix.
 */
export function effectivePosition(c: Craft, nowMs: number): { lat: number; lon: number } {
  const fix = { lat: c.lat, lon: c.lon };
  const { domain, onGround, speed, heading } = c;
  if (domain !== "air" || onGround === true) return fix;
  if (typeof speed !== "number" || !Number.isFinite(speed) || speed <= 0) return fix;
  if (typeof heading !== "number" || !Number.isFinite(heading) || heading < 0 || heading >= 360) {
    return fix;
  }
  const age = Math.min(nowMs - c.updatedAt, MOTION_MAX_AGE_MS);
  if (!(age > 0)) return fix; // future-dated fix or NaN clock
  return destinationPoint(fix, heading, speed * MS_PER_KNOT * (age / 1000));
}

/**
 * setInterval wrapper for the repaint tick: a per-tick throw is swallowed, and
 * {@link MAX_CONSECUTIVE_THROWS} in a row stop the loop and call `onGiveUp`
 * once (default: one console.warn) — the map must never die (ruling 6).
 * Returns an idempotent disposer.
 */
export function startMotionTick(
  intervalMs: number,
  onTick: () => void,
  onGiveUp?: () => void,
): () => void {
  let timer: ReturnType<typeof setInterval> | null = null;
  let streak = 0;

  const stop = () => {
    if (timer !== null) clearInterval(timer);
    timer = null;
  };

  timer = setInterval(() => {
    try {
      onTick();
      streak = 0;
    } catch (err) {
      streak++;
      if (streak < MAX_CONSECUTIVE_THROWS) return;
      stop();
      if (onGiveUp) onGiveUp();
      else console.warn(`smooth motion: render tick failed ${streak}× in a row, disabled`, err);
    }
  }, intervalMs);

  return stop;
}
