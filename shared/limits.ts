// Shared, pure constants and clamps for the timeline-modernization work.
// No I/O, no dependencies — every later timeline task imports these.

export const GB = 1024 ** 3;

// Storage cap (disk cache) in GB.
export const STORAGE_CAP_GB_MIN = 0.5;
export const STORAGE_CAP_GB_MAX = 1000;

// RAM cache for decoded snapshots in GB.
export const RAM_CACHE_GB_MIN = 0;
export const RAM_CACHE_GB_MAX = 16;
export const RAM_CACHE_GB_DEFAULT = 1;

// Timeline rewind: minimum gap between pinned snapshots (ms).
export const MIN_PIN_MS = 60_000;

// Playback speed: history-ms consumed per real-ms. Discrete step scale:
// 0.5, 1, 1.5, 3 min/s, then 5-min/s increments up to 60 min/s (1 h/s).
export const SPEED_STEPS = [
  30, 60, 90, 180, 300, 600, 900, 1200, 1500, 1800, 2100, 2400, 2700, 3000, 3300, 3600,
];
export const SPEED_MIN = SPEED_STEPS[0];
export const SPEED_DEFAULT = 3_600; // 1 h/s (top of the step scale)
export const SPEED_MAX = SPEED_STEPS[SPEED_STEPS.length - 1];
// Slider position (0..SPEED_SLIDER_MAX) = index into SPEED_STEPS.
export const SPEED_SLIDER_MAX = SPEED_STEPS.length - 1;

// Starting playback at (or past) the end of history anchors to this much
// before the end, so the play button always has something to play.
export const PLAYBACK_TAIL_MS = 30 * 60_000;

// Timeline window chunk: max frames rendered per animation frame.
export const WINDOW_CHUNK_ITEMS = 3;

// Timeline window RAM budget (bytes).
export const WINDOW_MAX_BYTES_MIN = 1 << 20;       // 1 MiB
export const WINDOW_MAX_BYTES_MAX = 64 << 20;      // 64 MiB
export const WINDOW_MAX_BYTES_DEFAULT = 32 << 20;  // 32 MiB (client request default)

// Step-scale speed ↔ slider mapping: the slider position is an index into
// SPEED_STEPS; sliderFromSpeed picks the nearest step.
export function speedFromSlider(v: number): number {
  const i = Math.round(Math.max(0, Math.min(SPEED_SLIDER_MAX, v)));
  return SPEED_STEPS[i];
}

export function sliderFromSpeed(s: number): number {
  let best = 0;
  let bestDist = Infinity;
  for (let i = 0; i < SPEED_STEPS.length; i++) {
    const d = Math.abs(SPEED_STEPS[i] - s);
    if (d < bestDist) {
      bestDist = d;
      best = i;
    }
  }
  return best;
}

export function clampStorageCapGb(gb: number): number {
  if (!Number.isFinite(gb)) return STORAGE_CAP_GB_MIN;
  return Math.max(STORAGE_CAP_GB_MIN, Math.min(STORAGE_CAP_GB_MAX, gb));
}

export function clampRamCacheGb(gb: number): number {
  if (!Number.isFinite(gb)) return RAM_CACHE_GB_MIN;
  return Math.max(RAM_CACHE_GB_MIN, Math.min(RAM_CACHE_GB_MAX, gb));
}
