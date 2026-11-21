# Timeline range windows + tiered retention — design

Date: 2026-11-21 · Status: draft for user review
Papertrail: `ML_Docs/2026Nov20-1.md` · Wave 4 of the Nov-20 review package.

## Problem

The scrubber renders the entire recorded history, so after extended use the
track is thousands of hours wide ("squished") and there is no way to scope it.
Separately, retention is flat 60 s resolution, byte-capped: real data measures
~1.05 MB gz/snapshot, so the 10 GB default cap holds only ~7 days — the
requested 336 h (14 d) default window is unreachable without changing the
storage shape.

## Rulings (user-approved 2026-11-21)

1. Full 60 s resolution for the last 48 h; snapshots older than 48 h are
   compacted to 5-min resolution; pins are never compacted.
2. Scrubber presets (24 h / 3 d / 7 d / 14 d / All) + custom from/to pickers;
   the scrubber renders only the selected window. Zoom/pan gestures: backlog.
3. Default window = last 336 h, clamped to available history.
4. Storage cap remains the ultimate bound; compaction keeps the default 10 GB
   cap comfortably inside 14 d at full shape:
   2 880 × 1.05 MB (48 h @ 60 s) + 3 888 × 1.05 MB (13.5 d @ 5 min) ≈ 7.1 GB.
   History older than the selected window survives on disk
   ("All" still reaches it); only byte-cap eviction deletes.

## Requirements

- R1 — Compaction never deletes: a snapshot inside the 48 h window; a pinned
  snapshot; or anything the index no longer holds. It deletes whole files and
  nothing else (no rewrites).
- R2 — After compaction, `seek()`, `window()`, `range()` and playback behave
  correctly over the mixed 60 s + 5-min cadence (they already read whatever
  files exist; behavior is pinned by tests).
- R3 — Compaction runs at init and periodically; it is pure-plan + mechanical
  apply, in the established `planDailyCleanup` pattern.
- R4 — The view window is purely a client concept: no wire-frame changes.
  Seek, playback bounds, and the scrubber all use the view window; the window
  is clamped to available history on every status frame and survives reloads.
- R5 — `status.history` gains no fields; the server keeps broadcasting full
  history range; the client intersects it with the selection.
- R6 — Gate stays green (tests, tsc, build); browser-only surfaces
  (date pickers, scrubber layout) are verified by the user.

## Design

### A. Shared constants (`shared/limits.ts`)

```ts
export const HISTORY_WINDOW_MS = 336 * 3600_000; // default scrubber window (14 d)
export const FULL_RES_AGE_MS   = 48 * 3600_000;  // full-resolution horizon
export const COMPACT_STEP_MS   = 5 * 60_000;     // one kept snapshot per 5-min bucket beyond it
```

Not settings knobs (v1): the storage cap already bounds totals, and the
tiers are a storage-shape decision, not a preference.

### B. Server compaction (`server/history.ts`)

Pure planner, exported for tests:

```ts
export function planCompaction(
  index: { ts: number }[], now: number, pinned: (ts: number) => boolean,
  horizonMs = FULL_RES_AGE_MS, stepMs = COMPACT_STEP_MS,
): number[] // ts's to delete
```

Rule: for every bucket `b = floor(ts/stepMs)` with bucket-end (`(b+1)*stepMs`)
strictly older than `now − horizonMs`, delete every unpinned snapshot except
at most one survivor: the **earliest unpinned** snapshot in the bucket, and
only if the bucket contains no pinned snapshot at all (a pinned snapshot is
already a survivor). Skip all pinned ts. The bucket-end rule means the *first*
bucket beyond the horizon is pruned whole at the boundary — at most 4 s of
extra resolution is kept at the seam. The survivor is never the newest
snapshot (the bucket end is ≥48 h in the past), so the keep-newest invariant
is safe by construction.

Apply: `HistoryRecorder.compact()` gathers `planCompaction(this.index,
this.now(), ts => this.opts.pins?.contains(ts) ?? false)`, then for each ts:
filter the index, `cache?.drop(ts)`, unlink-and-log — reusing the exact delete
mechanism of `evict()`. Returns the deleted count; caller logs
`history: compacted N snapshots older than 48 h`.

Scheduling (`index.ts`, beside `recorder.start`): fire-and-forget once after
`recorder.init()` resolves, then `setInterval(compact, HOUR)`; cleared on
shutdown with the other timers. Errors land in `log` only — compaction must
never take the recorder down.

### C. Client view window (`src/ui/format.ts` gains the pure helpers)

```ts
export const PRESETS: { label: string; ms: number | null }[] = [
  { label: "24 h", ms: 86_400_000 },
  { label: "3 d", ms: 259_200_000 },
  { label: "7 d", ms: 604_800_000 },
  { label: "14 d", ms: 1_209_600_000 }, // == HISTORY_WINDOW_MS
  { label: "All", ms: null },
];

export interface ViewSel { mode: "preset"; ms: number | null } | { mode: "custom"; from: number; to: number }

export function computeViewWindow(histFrom, histTo, sel): {from, to} | null
// hist nulls → null (no history yet). preset: from = max(histFrom, histTo − ms)
// (ms=null → full range), to = histTo. custom: intersect [from,to] with
// [histFrom,histTo]; empty intersection → clamped degenerate window (UI
// disables seek); never null when history exists.

export function windowToLabel(from, to): string  // "Nov 8 03:00 – Nov 21 03:00"
```

`sel` defaults to `{mode:"preset", ms: HISTORY_WINDOW_MS}`.

### D. Timeline UI (`src/ui/timeline.ts`)

A controls row above the track (never overlapping it — same rule as the feed
sliders): select + two `datetime-local` inputs + apply/clear. Preset change or
apply calls back `viewSel(sel | null)` (null = clear custom → presets again).
`setRange(from, to)` is unchanged in meaning — it now receives the VIEW
window; `renderTicks`/`formatRangeLabel` adapt for free. Day ticks stay
day-aligned, so a short window (24 h) simply shows few ticks; sub-day tick
granularity is backlog.

### E. Wiring (`src/main.ts`)

- `let viewSel: ViewSel | null` restored from `localStorage` (`radar.viewSel`,
  JSON, corrupt → default; mirror the existing speed-stored pattern).
- `const view = (): {from,to}|null => computeViewWindow(histFrom, histTo, viewSel ?? DEFAULT)`
- onStatus: `timeline.setRange(view()?.from ?? s.history.from, ...)` — on every
  status frame the view re-intersects as history grows/shrinks; no new fields.
- Playback engine closures become `historyFrom: () => view()?.from` /
  `historyTo: () => view()?.to`, so playback bounds follow the view (R4).
- Seek is unchanged: absolute ms; the scrubber can only request inside the view.
- onPlay `t0` fallback `histTo` → `view()?.to ?? histTo`.

## Failure modes

- Corrupt `localStorage` JSON → default preset, logged nowhere (user-visible
  effect is only the window).
- Custom range entirely outside history → degenerate window; track disabled,
  LIVE button remains usable.
- Recorder storage error during compact → logged, retried next hour (plan is
  idempotent; deleted files are gone from the index already on success).
- `view()` null (no history yet) → scrubber disabled exactly as today.
- Timeline controls on narrow viewports: wrap, never overlap the track.

## Testing

- `test/limits.test.ts` — new constants (values, in-range invariants).
- `test/history.test.ts` — planCompaction unit matrix (young untouched;
  old-pruned with exactly one survivor per bucket, earliest kept; pinned
  survivor kept even young-adjacent; bucket spanning horizon untouched;
  empty index); `compact()` end-to-end: files+index+cache updated, seek over
  compacted range returns the survivor, `range().from` advances iff the
  oldest file died, second run is a no-op, pinned bytes intact.
- `test/format.test.ts` — computeViewWindow matrix (null history; preset
  clamp from both ends; custom inside/partial/fully-outside; windowToLabel
  strings); PRESETS table values.
- `test/timeline.test.ts` — controls render; preset selection fires
  viewSel(null-able) callback; custom apply passes the picked range.
- Manual (user): pickers under system timezone; scrubber with 14 d on disk;
  playback within a preset; reload persistence; "All" squish is the user's
  choice now.

## Out of scope (backlog)

Timeline zoom/pan; sub-day tick granularity; user-configurable tier knobs;
server-side per-window downsampling variants; multi-window compare.
