# Timeline Modernization — Design Spec

- **Date:** 2026-10-26
- **Status:** Pending user review (design approved in chat 2026-10-26)
- **Owner:** zacheri
- **Scope:** Feature additions to the existing local app (not a new project)

## 1. Overview

Five features modernizing the timeline, plus one extensibility substrate:

- **A. Date/time timeline** — the timeline bar gains real dates (it currently
  shows HH:MM:SS only), day-boundary ticks, and a date-aware HUD replay clock.
- **B. Master settings menu** — a new extensible settings drawer (Timeline
  section first) with runtime-mutable, persisted settings. v1 options:
  **storage cap** (GB) for the timeline history and **snapshot cache** (RAM, GB)
  for faster loading of past entries.
- **C. Pinned time ranges** — mark spans of the timeline as important; they
  render in a distinct color and are **strictly exempt** from auto-deletion.
- **D. Playback** — play through history with a log-scale speed slider from
  30 s/s (30×) to 1 day/s (86,400×). Smooth where feasible: interpolation at
  low/mid speeds, fast scrub (montage) at the top of the range.
- **E. Rendering optimization** — rAF-coalesced refresh, a playback render
  mode (label collision pass disabled, labels stay visible), and an adaptive
  frame governor. No live-behavior changes.

### Superseded decisions

- `2026-10-03-timeline-pollrate-faa-design.md` listed "**Sub-60-second rewind
  resolution; event-level replay**" as non-goals. Feature D supersedes this in
  the *rendering* sense: display resolution becomes the frame rate via
  interpolation between 60 s snapshots. The *storage* resolution stays 60 s.
- The same spec's deliberate "**no decompressed in-memory snapshots**" ruling
  is superseded by an **opt-in, byte-capped** LRU (Feature B, default 1 GiB,
  0 = off restores the old disk-only behavior).

### Grounding numbers (measured 2026-10-25 on the owner's machine)

- Snapshot size ≈ **1.1 MB gz** avg (8,390 files measured; spec estimate was
  ~4 MB). 1 day = 1,440 snapshots ≈ **1.6 GB gz**.
- 10 GiB cap ≈ **6.5 days** of history at the 60 s cadence.
- Decoded snapshot ≈ 8–10 MB raw JSON; V8 object overhead ≈ 20–30 MB.

## 2. Feature A — Date/time timeline

### Behavior

- **Range label** (left of the scrubber):
  - Span crosses a local-day boundary → `Oct 20 09:12 – Oct 26 09:12`
    (abbreviated month + day, hour:minute, `hour12: false`).
  - Same local day → `09:12 – 14:40` (existing time-only format).
- **Selected readout** (right of the scrubber): while rewound, **always**
  `Oct 26 09:12:34` (date + full time) — unambiguous across multi-day
  history. While live, unchanged (`live`).
- **Day ticks**: when the span crosses a day boundary, 1 px × 4 px ticks at
  each local midnight within (from, to), muted color (`--border`-family,
  **not** amber — amber is reserved for pins). Rendered on a
  `pointer-events: none` overlay div aligned to the slider track; recomputed
  on `setRange` and on resize (ResizeObserver on the bar).
- **HUD replay clock**: while replaying, if the snapshot's local date ≠
  today's, show `Oct 24 14:32` (date + hour:minute) instead of the bare
  HH:MM:SS; `.replay` (amber) styling unchanged.
- **Ruling: no date-picker jump input** — slider + day ticks cover navigation;
  a timeline zoom/window is a natural future settings option (the drawer is
  built to absorb new sections).

## 3. Feature B — Master settings menu

### Substrate

- `data/settings.json` — the runtime settings file (gitignored `data/`):
  ```json
  { "storageCapGb": 10, "ramCacheGb": 1 }
  ```
  Absent → `.env`/code defaults apply. Corrupt → log + defaults (never
  crashes). Written atomically (tmp + rename) on every change. **The file is
  authoritative at runtime**; `.env` supplies initial defaults only
  (`HISTORY_MAX_BYTES` → storage cap, `HISTORY_RAM_CACHE_GB` (new, default 1)
  → RAM cache). No restart needed for any change.
- `server/settings.ts` (new): load/merge/validate/apply/persist. Clamps:
  - `storageCapGb`: 0.5 … 1000 (step 0.5 in the UI)
  - `ramCacheGb`: 0 … 16 (**0 = off** — restores pre-change disk-only behavior)
- Applying: `HistoryRecorder.setCap(bytes)` (triggers an evict pass) +
  `SnapshotCache.resize(bytes)`.
- Shared constants live in `shared/limits.ts` (new) so client slider bounds
  and server clamps agree (same pattern as shared craft constants).

### UI — `src/ui/settings.ts` (new)

- A second `<aside class="drawer">`, **bottom-left** (`left:12px;
  bottom:60px; width:260px`), above the timeline, opposite corner from the
  filter drawer (no overlap). Identical skeleton to the filter drawer:
  `.drawer-head` (⚙ + "Settings" + chevron) toggles collapse; own
  `localStorage` key `radar.settingsCollapsed`; **default collapsed**.
- Sectioned body (`.settings-group` headers) — v1 has one section:
  ```
  ─ Timeline
  Storage cap
    [ 10 ] GB                        ← number input, 0.5–1000, step 0.5
    using 9.2 GB (pinned 0.4 GB)     ← live line from status
    ⚠ pinned data exceeds cap by 1.2 GB   ← only when usedBytes > cap
  Snapshot cache (RAM)
    slider 0–16 GB — label "1 GB" / "off"
    holding 312 MB                   ← live line from status
  Pinned ranges
    Oct 22 14:00 – 16:30            ×
    (none)
  ```
- Inputs apply **debounced 500 ms** → `settings.update`; the server clamps,
  persists, and echoes via `status` (drawer re-renders from status — server
  authoritative, same pattern as the poll-rate sliders).
- Future options = new `.settings-group` sections; no structural change.

### Protocol

- c→s: `{type:"settings.update", patch:{storageCapGb?:number, ramCacheGb?:number}}`
  — non-finite/out-of-range values clamped; invalid frame → ignored (existing
  convention). No dedicated reply frame — the `status` echo is the reply.
- `status` gains:
  - `settings: {storageCapGb, ramCacheGb, cacheUsedBytes}`
  - `history` gains: `usedBytes, pinnedBytes, snapshotMs`
  - `staleMs` (top-level — the server's effective `STALE_MS`, used by the
    playback engine for stale recomputation; avoids client/server constant
    drift)
  - `pins: [{id, from, to}]`
  - Hub diff-broadcast covers updates (payload JSON changes on any change).

## 4. Feature C — Pinned time ranges

### Storage & server

- `server/pins.ts` (new) `PinStore`, persisted to
  `data/history/pins.json` (invisible to the snapshot scan regex
  `/^(\d+)\.json\.gz$/` — verified):
  ```json
  { "pins": [ { "id": "p1792991000000", "from": 1792900000000, "to": 1792907200000 } ] }
  ```
  `id` = `"p" + Date.now()` at creation. Corrupt file → log + empty.
- Validation on `add(from, to)`: finite, `to − from ≥ MIN_PIN_MS (60 000)`,
  clamped to the current history `[from, to]` (rejected if the clamped span
  falls below `MIN_PIN_MS`). **Overlapping pins are allowed** (harmless —
  exemption is an OR). Persisted atomically after every mutation.
- API: `all()`, `add(from,to)`, `remove(id)`, `contains(ts)`,
  `pinnedBytes(snapshotIndex)`.

### Eviction — pin-aware (`server/history.ts`)

Semantics (user-confirmed): **the cap bounds unpinned data only; total on-disk
usage = pinned + unpinned (up to cap). Pinned files are never deleted.**

```
unpinned = index entries where !pins.contains(ts)
total    = Σ unpinned.size
while total > cap and a deletable unpinned entry exists:
    candidate = oldest unpinned
    if candidate is the newest snapshot and the only unpinned one: break   # keep-newest invariant
    delete candidate; total -= candidate.size; cache.drop(candidate.ts)
```
Termination is guaranteed (each iteration removes one entry). If the loop
exits with `total > cap` (only protected files remain), usage legitimately
exceeds the cap — surfaced in the settings drawer, never a data-loss event.
`setCap(bytes)`: stores the cap + fires an async evict pass (errors logged).
Evict also runs on boot (existing) and after every write (existing).

### UI

- **Mark mode**: a `Mark` button on the timeline bar (toggles `.active`).
  While active, the bar is `cursor: crosshair`; mouse events are captured on
  the slider **input** (the rendering overlay stays `pointer-events: none`)
  and time is computed from `offsetX` relative to the track width. Scrubbing
  is suppressed while Mark is active:
  - mousedown → drag → live preview span (amber `#ffb300` at 60 % opacity)
    on the overlay; mouseup with span ≥ `MIN_PIN_MS` → `pin.add`; shorter →
    cancelled (no flash, no frame).
  - click (no drag) on an existing pin span → `pin.remove(id)`; click on
    empty track → nothing.
- **Rendering**: pin spans on the track, amber at 35 % opacity (preview 60 %),
  on the same `pointer-events: none` overlay as the day ticks (the slider
  input sits above it). Re-rendered from any `pins` frame (status or reply).
- **Settings drawer**: "Pinned ranges" list with per-row `×` (second delete
  path), showing `MMM d HH:mm – HH:mm`.
- Pins are **metadata over the time axis**: a pin protects the snapshot files
  that currently fall in its range. Un-pinning makes those files evictable
  like any others. A pin whose files are later evicted (after un-pinning) is
  simply a range with no (or fewer) snapshots behind it — seeking clamps as
  today.

### Protocol

- c→s: `{type:"pin.add", from, to}` / `{type:"pin.remove", id}`
- s→c: `{type:"pins", pins:[{id,from,to}]}` — reply to add/remove **and**
  carried in every `status` (attach path).

## 5. Feature D — Playback

### Approach (user-confirmed: "smooth where feasible")

**Client-driven playback** (approach A of the design discussion; server-driven
streaming and precomputed binary tracks were rejected — see rulings):
the server streams raw gz snapshot bytes for a time window (undecoded); the
client decodes in a Web Worker pool and owns the playback clock,
interpolation, and render loop. The **stride** parameter bounds wire and CPU
at every speed: low speed → stride 1 (every snapshot, for interpolation);
high speed → stride = snapshots-per-frame, so only displayed snapshots are
ever transferred.

### Modes

- `advance = speed × frameDt` (history ms advanced per rendered frame).
- **Lerp mode** while `advance < snapshotMs` (the server's actual cadence,
  carried in `status.history.snapshotMs`; 60 000 at defaults): holds the two
  bracketing snapshots, interpolates per frame. Crossover ≈ 1,800–3,600×
  depending on effective fps.
- **Skip mode** above the crossover: fast scrub/montage. The server is asked
  for a **strided** window with `stride = ceil(advance / snapshotMs)`, so the
  buffer holds one snapshot per rendered frame. Each frame renders the newest
  buffered strided snapshot with `ts ≤ cursor` (when the buffer lags, that is
  the last one loaded — the cursor stalls per the rule below rather than
  jumping past unloaded data).
- The engine selects the mode per frame from the current `advance`; the
  slider range is unaffected.

### Engine — `src/data/playback.ts` (new)

Pure core with injected I/O (testable in Node; rAF + workers injected):

- State: `idle | buffering | playing | paused`.
- `start(t0)`, `pause()`, `stop()`, `setSpeed(s)`, `seek(t)` (pause +
  re-anchor), `tick(nowMs)` — called from the rAF loop.
- `start(t0)`: called with the current scrubber/seeked time — the map already
  displays that snapshot, so playback begins seamlessly (no visual jump).
- Virtual clock: `cursor += speed × (nowMs − lastNow)`, clamped to
  `[historyFrom, historyTo]` (from `status.history`); reaching the end →
  `paused` at `to`.
- **Buffer**: sorted `{ts, crafts}[]` of decoded snapshots; trimmed to keep
  ~2 snapshots behind the cursor plus `lookAhead` ahead
  (`lookAheadMs = clamp(advance × 8, 600 000, 1 800 000)`); window requests
  are pipelined — up to **2 in flight**, each tagged with a
  client-monotonic `seq`; a speed change supersedes all in-flight `seq`s
  (their chunks are dropped).
- **Stall, don't skip**: if the buffer can't serve the frame (starvation),
  the cursor holds until data arrives.
- **Interpolation** (lerp mode): per craft id —
  - both snapshots: `lat`/`lon` linear; `heading` shortest-arc (step when
    either is null); all other fields from the "from" snapshot.
  - only in "to" → appears (steps in at the boundary); only in "from" →
    disappears (steps out).
  - `stale` **recomputed against the virtual clock**
    (`t − updatedAt > staleMs`, `staleMs` from status) — historical
    snapshots currently carry recorded stale flags, which are wrong in
    rewind; playback frames are honest.
- **Never mutates buffered crafts**: lerp mode emits new objects; skip mode
  emits shallow copies (`{...c, stale}`) so the buffer stays clean.
- **Frame governor**: EMA of frame time; > 34 ms sustained → drop target
  fps 60 → 30 → 15 (ratchet resets on next `start()`). Crossover speed
  recomputes from the effective fps.
- `onFrame(crafts, t, meta)` — the main wiring renders (below).

### Decode pool — `src/data/decode.ts` + `src/data/decode.worker.ts` (new)

- `createDecodePool(size = min(4, navigator.hardwareConcurrency || 2))` →
  `decode(gz: ArrayBuffer): Promise<Craft[]>`.
- Worker: `DecompressionStream('gzip')` → read → `JSON.parse` → postMessage
  (structured clone). **Ruling: native only — no pako fallback.** If
  `DecompressionStream` is missing (very old Safari), the play button is
  disabled with a tooltip; scrubbing is unaffected.

### Protocol

- c→s: `{type:"timeline.window", seq, from, to, stride, maxBytes}` —
  `seq` client-monotonic int; `stride ≥ 1`; `maxBytes` client default
  **32 MiB** (≈ 28 snapshots — ~1 s of runway at top speed, keeping the
  2-request pipeline ahead of consumption), server clamps to
  [1 MiB, 64 MiB].
- s→c: `{type:"timeline.window.chunk", seq, items:[{ts, b64}], done,
  reachedTo}` — the server collects strided snapshots in `[from, to]` until
  `maxBytes` of gz or range end; emits chunk frames of **≤ 3 items** (≤ ~5 MB
  text each); final chunk `done: true`, `reachedTo` = last item's ts (null
  when none). Missing/0-byte files are skipped (logged) — the stream
  continues. Recorder disabled → no reply (existing silent convention).
- No binary frames — the protocol stays text/JSON (b64 payload).

### UI — timeline bar layout (left → right)

```
[ Oct 20 09:12 – Oct 26 09:12 ] [ ▶/⏸ ] [ speed slider  1 h/s ] [ scrubber with ticks+pins ] [ Oct 26 09:12:34 ] [ Mark ] [ LIVE ]
```

- **Play button**: `▶`/`⏸`; disabled (with tooltip) when history is empty or
  decoding is unsupported.
- **Speed slider**: 80–100 px, **log scale**, internal value 0–1000:
  `speed = 30 × 2880^(v/1000)` → range **30× ("30 s/s") … 86,400× ("1 d/s")**.
  Human label: `<60 → "N s/s"`, `<3600 → "N min/s"`, `<86400 → "N h/s"`,
  `else → "N d/s"`. **Default 3,600× ("1 h/s")** — a day plays in 24 s.
- While playing, the scrubber thumb rides the virtual clock (programmatic
  `value` set per frame — no input events). Scrubbing (user `input`) while
  playing → `stop()` + the existing seek path (map stays in REPLAY).
- `LIVE` → `stop()` + existing snapshot-gated live return. Reconnect →
  `stop()` (existing replay-exit path). `ReplayGate` is reused **unchanged**
  (play start = `enterReplay`, LIVE = `requestLive`, pause stays rewound).

### Rendering wiring — `main.ts` / `src/map/layers.ts`

- `onFrame` renders **directly** (not via `ClientStore`):
  `setCraftData(map, buildFeatureCollection(crafts, {iconRegistered}))` using
  the last-known registered icon set (no new pack-`ensure()` calls mid-frame;
  unregistered pack names fall back to family silhouettes as today).
  One `setData` per frame. Counts + HUD throttled to ~2 Hz; HUD clock
  (virtual time) at ~4 Hz; REPLAY badge stays on.
- **Clicks while playing** resolve against the engine's last frame
  (`lastPlayFrame` map in `main.ts`), since the store holds pre-playback
  state. FAA `aircraft.info` is unaffected (server answers from the live
  store/FAA index as today; historically-only crafts return null — existing
  limitation, unchanged).
- **Playback render mode**: `setPlaybackMode(map, on)` in `layers.ts` —
  one `setLayoutProperty('craft-labels', 'text-ignore-placement', on)` at
  mode start/end (not per frame). Labels stay **visible** (may overlap) —
  the expensive collision pass is what's disabled. Restored on
  pause-to-live/stop. **Ruling: visible-but-uncrowded beats hidden** for
  "without impinging on functionality".

## 6. Feature E — Rendering optimization

1. **rAF-coalesced refresh** (`main.ts`): store emits set a dirty flag; at
   most one `refresh()` per animation frame, latest wins, single-flight.
   Also fixes the pre-existing hazard where two overlapping async
   `refresh()` calls (one awaiting `packLoader.ensure`) can issue
   `setData` out of order.
2. **Playback render mode** (see §5) — icons keep
   `icon-allow-overlap: true` (already the case); the label collision pass is
   the only layout work removed during playback.
3. **Frame governor** (see §5 engine).
4. **Feasibility spike** (delegated, before implementation — see §11):
   Node-measurable parts (decompression/parse throughput on the real 1.1 MB
   snapshots → worker-pool sizing) run via sub-agent; the browser-side
   `setData` cost at ~11k features is verified by the owner in-browser during
   the implementation gate (the governor + the existing zoom-gated label
   layers are the backstops). If the spike shows 30 fps is unreachable even
   icons-only, the spec's fallback is a documented in-playback label-thin
   below zoom 6 (labels already hide below zoom 4).

## 7. Snapshot cache (RAM) — `server/snapshot-cache.ts` (new)

- Byte-capped **LRU of decoded `Craft[]`** keyed by snapshot ts. Size proxy =
  raw JSON byte length (available at decode time).
- `get(ts)` (hit → move to MRU end), `set(ts, crafts, rawBytes)` (trims),
  `drop(ts)` (called from eviction — file deleted ⇒ entry stale),
  `resize(bytes)` (trims; 0 = disabled), `usedBytes`.
- Warmed by: every successful `seek` decode, and `recordNow` (the just-written
  state — scrubbing "now-ish" is instant).
- Serves **`seek()` only** (the scrub path): hit → reply without any disk
  I/O or gunzip. Window fetches ship raw gz and never decode server-side
  (zero per-snapshot server CPU during playback).
- Default 1 GiB (≈ 30–40 decoded snapshots ≈ an hour of instant scrubbing);
  `status.settings.cacheUsedBytes` feeds the drawer's live line.

## 8. Configuration

| Key | Where | Default | Notes |
|---|---|---|---|
| `HISTORY_SNAPSHOT_MS` | `.env` | 60 000 | unchanged |
| `HISTORY_MAX_BYTES` | `.env` | 10 GiB | **initial default** for the storage cap |
| `HISTORY_RAM_CACHE_GB` (new) | `.env` | 1 | **initial default** for the RAM cache |
| `storageCapGb` | `data/settings.json` | from env | 0.5–1000, runtime-mutable |
| `ramCacheGb` | `data/settings.json` | from env | 0–16, runtime-mutable, 0 = off |
| pins | `data/history/pins.json` | empty | runtime-mutable |

`config.ts` gains `HISTORY_RAM_CACHE_GB` via the existing `int()` helper
(non-numeric env value → default, existing `int()` behavior; no `int()`
changes). `.env.example` documents it. Runtime-value clamping lives in
`server/settings.ts`, not in env parsing.

## 9. File map

**New:**

| File | Job |
|---|---|
| `shared/limits.ts` | shared constants: speed range/default, cap + RAM clamps, `MIN_PIN_MS`, chunk size, `maxBytes` bounds |
| `server/pins.ts` | `PinStore` (persist, validate, `contains`, `pinnedBytes`) |
| `server/settings.ts` | settings load/validate/apply/persist |
| `server/snapshot-cache.ts` | decoded LRU |
| `src/data/playback.ts` | playback engine (pure core) |
| `src/data/decode.ts` | worker pool |
| `src/data/decode.worker.ts` | gunzip + parse worker |
| `src/ui/settings.ts` | settings drawer |
| `test/pins.test.ts`, `test/settings.test.ts`, `test/snapshot-cache.test.ts`, `test/window.test.ts`, `test/playback.test.ts` | see §11 |

**Extended:**

| File | Changes |
|---|---|
| `server/history.ts` | pin-aware `evict()`, `setCap()`, `window(from,to,stride,maxBytes)`, binary-search index lookup, 0-byte file drop at init + defensive skip in seek/window, cache integration (get/set/drop) |
| `server/hub.ts` | `parseClientMessage`: `settings.update`, `pin.add`, `pin.remove`, `timeline.window`; `StatusPayload` new fields |
| `server/index.ts` | wiring (PinStore, Settings, SnapshotCache), new handlers, status payload |
| `server/config.ts` | `HISTORY_RAM_CACHE_GB` |
| `src/ui/timeline.ts` | date readouts, day ticks + pin segments (overlay), play button, speed slider, Mark mode |
| `src/ui/hud.ts` | date in replay clock when date ≠ today |
| `src/data/ws.ts` | new send helpers + `parseRadarMessage` cases (`pins`, `timeline.window.chunk`) |
| `src/main.ts` | rAF-coalesced refresh, playback wiring (engine, render mode, `lastPlayFrame` click path, HUD throttle), settings drawer creation, staleMs/snapshotMs from status |
| `src/map/layers.ts` | `setPlaybackMode(map, on)` |
| `src/style.css` | `.settings-*`, pin segments, play/speed/Mark controls, overlay |
| `.env.example` | `HISTORY_RAM_CACHE_GB` |

**Unchanged (deliberately):** `src/data/replay.ts` (ReplayGate semantics
cover playback as-is), `server/store.ts`, `server/opensky.ts`, `server/ais.ts`,
`server/faa*.ts`, `src/data/features.ts`, snapshot recording cadence/format.

## 10. Error handling & degradation

- Corrupt `settings.json` / `pins.json` → log + defaults/empty; server up.
- `settings.update` out of range → clamped, echoed (never an error frame).
- `pin.add` with span < `MIN_PIN_MS` after clamping → ignored (no frame).
- `timeline.window` with recorder disabled → silent no-reply (seek
  convention). Missing/0-byte snapshot file mid-window → item skipped,
  stream continues. Client drops chunks for superseded `seq`s.
- 0-byte snapshot files (one found on the owner's disk 2026-10-25): dropped
  at `init()` (logged) and treated as missing defensively in `seek`/`window`.
  (Today a seek onto one produces `time: null` → silent bounce to LIVE.)
- Eviction overshoot (pinned > cap): usage legitimately exceeds the cap;
  settings drawer shows `⚠ pinned data exceeds cap by X GB`; no deletion.
- Playback buffer starvation → cursor stalls (buffering state), never skips.
- `DecompressionStream` unsupported → play disabled + tooltip; everything
  else works.
- Worker failure (unexpected) → the pool's decode rejects → engine stalls +
  logs; playback can be retried; scrubbing unaffected.
- WS disconnect mid-playback → engine stops on reconnect (existing path).

## 11. Test strategy

**Server (Node, offline — existing patterns: temp dirs, injected `now`,
FakeWebSocket):**

- `test/pins.test.ts` — persist/reload, validation (min span, clamping to
  history bounds, reject below-min after clamp), overlaps allowed,
  `contains`, `pinnedBytes`, corrupt file → empty.
- `test/settings.test.ts` — env-defaults-when-absent, file-overrides-env,
  clamps (both bounds each var), corrupt file, atomic persistence,
  `setCap` triggers evict, RAM `resize` trims.
- `test/snapshot-cache.test.ts` — LRU order/trim on set, `resize`, `drop`,
  `usedBytes`, 0 = disabled.
- `test/history.test.ts` (extend) — pin-aware eviction: pinned never
  deleted; loop terminates (all-unpinned-gone case); keep-newest invariant;
  cap reduction via `setCap`; 0-byte file dropped at init.
- `test/window.test.ts` — stride math (stride 1 and >1), `maxBytes` bound,
  range clamping, missing/0-byte items skipped with `reachedTo` correct,
  chunking ≤ 3 items.
- `test/hub.test.ts` / `test/ws.test.ts` (extend) — new frames accepted/
  rejected in both parsers (malformed `timeline.window` fields, missing
  `seq`, non-finite `pin.add` bounds).
- `test/integration.test.ts` (extend) — over real WS: `pin.add`/`pin.remove`
  → `pins` reply + status echo; `settings.update` → clamped status echo;
  `timeline.window` streaming (2+ chunks, `done`, correct items) against a
  fake-cadence recorder.

**Client (Node — pure engine, injected clock):**

- `test/playback.test.ts` — cursor advance + clamp, lerp/skip mode selection
  at the threshold (incl. fps-governor recompute), interpolation math
  (lat/lon, heading shortest-arc incl. 350°→10° wrap, null heading step),
  appear/disappear at boundaries, stale recomputation, buffer trim + prefetch
  decisions, `seq` invalidation, stall-don't-skip, speed slider log mapping
  (30×/86,400× ends, default 3,600×), `formatSpeed` labels.

**Browser-verified by the owner (repo convention — no canvas in unit tests):**
timeline bar (dates, ticks, pin segments, play/speed/Mark interactions),
settings drawer, playback smoothness, label-mode toggle.

**Gate** (after every change, per AGENTS.md): `npm test` →
`npm run typecheck` → `npm run build`. Finished work committed + pushed.

## 12. Non-goals (v1)

- Raw feed payload retention ("poll" caching) — the cache covers normalized
  timeline snapshots only (raw dumps remain a spec non-goal).
- Date-picker jump input; timeline zoom / window range.
- Pin labels/notes; pin search; per-pin color choice.
- Storage resolution finer than 60 s (smoothness is display-side only).
- Binary WS frames (protocol stays text/JSON).
- Playback of *live* data; multi-client playback; per-craft trails.
- Server-side decode of window items (client decodes).
- Sub-60 s *seek* resolution semantics (seek still snaps to a snapshot).

## 13. Rulings log

- **Ruling: client-driven playback with windowed raw-gz stream + worker
  decode + stride** (approach A) — bounds server CPU to ~0 per snapshot,
  keeps playback display-synced, minimal wire. Cost if wrong: worker decode
  slower than expected → the feasibility spike measures it before
  implementation; fallbacks exist (governor, seek-mode degradation).
- **Ruling: "smooth where feasible" — lerp below the crossover, skip/montage
  above; slider keeps the full 30×–86,400× range** (user-confirmed).
- **Ruling: pins strictly exempt — cap bounds unpinned data only; overshoot
  surfaced, never a data-loss event** (user-confirmed).
- **Ruling: RAM setting = server-side decoded-snapshot LRU (serves scrub
  `seek`), not client-side, not raw-poll retention.** Cost if wrong: the
  user wanted raw-poll retention — that is a separate, larger subsystem
  (flagged to the user during design).
- **Ruling: playback labels visible but collision-free (not hidden)** —
  "without impinging on functionality". Cost if wrong: preference change is a
  one-line mode toggle.
- **Ruling: settings persisted to `data/settings.json`, runtime-mutable,
  `.env` = initial defaults only** — what makes it a real menu; extensible by
  adding keys. Cost if wrong: user preferred env-only — the file is gitignored
  local state, same class as `data/faa/enrichment.json`.
- **Ruling: native `DecompressionStream` only, no pako fallback** —
  zero-dependency; unsupported browsers get disabled play + tooltip.
- **Ruling: 0-byte snapshot files dropped at init** (found on owner's disk
  2026-10-25; today they cause a silent bounce to LIVE). Cost if wrong: none.
- **Ruling: no date-picker; ticks + slider suffice; settings drawer absorbs
  future options (zoom etc.).**
- **Ruling: default RAM cache 1 GiB; default playback speed 3,600× (1 h/s).**

## 14. Execution order (sub-agent tasks)

Sequential where dependencies exist; tracks 2–4 are parallelizable across
sub-agents once track 1 lands (they touch disjoint files; the protocol
contract is this spec + `shared/limits.ts`).

1. **Spike (general sub-agent, throwaway scripts in /tmp):** decompression +
   `JSON.parse` throughput on real 1.1 MB snapshots (Node `DecompressionStream`)
   → confirms worker-pool sizing (≤ 4 workers, ≤ ~30 decodes/s sustained) and
   main-thread envelope cost of ≤ 5 MB text frames. Findings feed §6.4;
   scripts stay labeled throwaway.
2. **Server track:** `shared/limits.ts` → `pins.ts` → `settings.ts` →
   `snapshot-cache.ts` → `history.ts` extensions → `hub.ts`/`index.ts`
   wiring → `config.ts`/`.env.example` → server tests.
3. **Client data track:** `ws.ts` frames → `playback.ts` core → `decode.ts`
   + worker → `main.ts` wiring (coalescing, render mode, click path) →
   client tests.
4. **Client UI track:** `timeline.ts` (dates/ticks/pins/play/speed/Mark) →
   `settings.ts` → `hud.ts` → `style.css` → browser verification with owner.
5. **Integration:** extended `integration.test.ts`, full gate, browser
   verification pass, commit + push.
