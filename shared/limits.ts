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

// Playback speed: history-ms consumed per real-ms.
export const SPEED_MIN = 30;        // history-ms per real-ms (30 s/s)
export const SPEED_DEFAULT = 3_600; // 1 h/s
export const SPEED_MAX = 86_400;    // 1 d/s
// Slider resolution (0..SPEED_SLIDER_MAX) the UI binds to.
export const SPEED_SLIDER_MAX = 1000;

// Timeline window chunk: max frames rendered per animation frame.
export const WINDOW_CHUNK_ITEMS = 3;

// Timeline window RAM budget (bytes).
export const WINDOW_MAX_BYTES_MIN = 1 << 20;       // 1 MiB
export const WINDOW_MAX_BYTES_MAX = 64 << 20;      // 64 MiB
export const WINDOW_MAX_BYTES_DEFAULT = 32 << 20;  // 32 MiB (client request default)

// Log-scale speed ↔ slider mapping. speedFromSlider(v) = SPEED_MIN
// × (SPEED_MAX/SPEED_MIN)^(v/SPEED_SLIDER_MAX); sliderFromSpeed is its exact
// inverse, rounded to an int and clamped to [0, SPEED_SLIDER_MAX].
export function speedFromSlider(v: number): number {
  return SPEED_MIN * Math.pow(SPEED_MAX / SPEED_MIN, v / SPEED_SLIDER_MAX);
}

export function sliderFromSpeed(s: number): number {
  const raw =
    SPEED_SLIDER_MAX * Math.log(s / SPEED_MIN) / Math.log(SPEED_MAX / SPEED_MIN);
  return Math.max(0, Math.min(SPEED_SLIDER_MAX, Math.round(raw)));
}

export function clampStorageCapGb(gb: number): number {
  if (!Number.isFinite(gb)) return STORAGE_CAP_GB_MIN;
  return Math.max(STORAGE_CAP_GB_MIN, Math.min(STORAGE_CAP_GB_MAX, gb));
}

export function clampRamCacheGb(gb: number): number {
  if (!Number.isFinite(gb)) return RAM_CACHE_GB_MIN;
  return Math.max(RAM_CACHE_GB_MIN, Math.min(RAM_CACHE_GB_MAX, gb));
}
