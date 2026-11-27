// OpenSky /states credit law (design 2026-11-27 §A): the per-call cost is a
// function of bounding-box AREA in square degrees — never contents, never
// kind. Both sides import this so plan estimates and accounting never disagree.

// Area tiers: <=25 -> 1, <=100 -> 2, <=400 -> 3, else 4 (global).
// Garbage dims (non-finite or negative) return the worst tier 4: under-costing
// breaks the surplus reserve and risks 429s starving the globe poll;
// over-costing merely leaves surplus unused.
export function statesCallCost(wDeg: number, hDeg: number): 1 | 2 | 3 | 4 {
  if (!Number.isFinite(wDeg) || !Number.isFinite(hDeg) || wDeg < 0 || hDeg < 0) return 4;
  const area = wDeg * hDeg;
  if (!Number.isFinite(area)) return 4;
  if (area <= 25) return 1;
  if (area <= 100) return 2;
  if (area <= 400) return 3;
  return 4;
}

// Estimated credits per UTC day at a fixed cadence; 0 for a non-polling
// interval (non-finite or <= 0). Non-integer for cadences that do not divide
// the day evenly — this is an estimate surface, not the ledger.
export function creditsPerDay(wDeg: number, hDeg: number, intervalMs: number): number {
  if (!Number.isFinite(intervalMs) || intervalMs <= 0) return 0;
  return (statesCallCost(wDeg, hDeg) * 86_400_000) / intervalMs;
}
