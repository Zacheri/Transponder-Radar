# Timeline Modernization Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Date/time-aware timeline with a runtime-mutable settings menu (storage cap + RAM snapshot cache), pinned "important" time ranges exempt from auto-deletion, and variable-speed playback (30×–86,400×) that interpolates between 60 s snapshots.

**Architecture:** Server side extends `HistoryRecorder` (pin-aware eviction, strided window streaming, decoded-snapshot LRU) and adds three small server modules (`PinStore`, settings store, `SnapshotCache`). Client side adds a rAF-driven playback engine that decodes gz snapshots in a Web Worker pool and lerps between bracketing snapshots, plus an extended timeline bar (dates, day ticks, pin spans, play + log-scale speed slider, Mark mode) and a new settings drawer. Protocol stays text/JSON WebSocket: 4 new client→server and 2 new server→client frame types.

**Tech Stack:** TypeScript; Fastify + ws (server); Vite + MapLibre GL v4 (client); Vitest (Node env); Web Workers + `DecompressionStream` (client decode, Node 18+ — dev machine is Node 26).

**Spec:** `docs/superpowers/specs/2026-10-26-timeline-modernization-design.md`

## Global Constraints

- **Gate after every task:** `npm test` → `npm run typecheck` → `npm run build` (the maplibre >500 kB chunk warning is an accepted exception).
- **No new runtime dependencies** (maplibre-gl is the only runtime dep; `validateStyleMin` stays a devDep).
- WS protocol stays **text/JSON only** (no binary frames; window payloads are base64 in JSON).
- `data/` is gitignored; runtime files added: `data/settings.json`, `data/history/pins.json`. Never commit `.env` or `data/`.
- Test imports use `.js` extensions (ESM convention, e.g. `from "../server/history.js"`).
- Browser-only code (DOM, WebGL, real workers) is **browser-verified by the owner** — no unit tests for it (repo convention).
- Commit after each task; push at the end (if push fails with `Permission denied (publickey)`, the user must run `ssh-add ~/.ssh/id_rsa`).
- `src/data/replay.ts` (ReplayGate) is **deliberately unchanged** — playback reuses its semantics (play = `enterReplay`, LIVE = `requestLive`, pause stays rewound).

## Review Focus

1. **Inverted pin range over WS** (`from > to`) — server normalizes to (min, max) before validation; a pin is still created. → pinned in Task 3 (unit) and Task 15 (integration).
2. **`settings.json` with an unknown future key** — `persistSettingsDoc` preserves unknown keys (forward-compat for the menu's future options). → pinned in Task 5.
3. **Corrupt gz payload in a window chunk** — decode rejects; engine stalls (no frame, no crash) and continues with subsequent chunks. → pinned in Task 11 (pool reject) + Task 10 (stall-continue).
4. **Pinned snapshots are all that exceeds the cap** — eviction loop terminates, pinned files are kept, `usedBytes() > maxBytes` is reportable (overshoot, not data loss). → pinned in Task 6.
5. **Stale boundary in playback** — `updatedAt === t − staleMs` exactly → NOT stale (strict `>`); one ms older → stale. → pinned in Task 10.

---

### Task 1: Feasibility spike (throwaway — no repo changes, no commit)

**Files:**
- Create: throwaway scripts in `/private/var/folders/69/3nhlrb8s7m708ngjx1m9l9xm0000gr/T/opencode/radar-spike/` only
- Test: n/a

**Interfaces:**
- Consumes: `data/history/*.json.gz` on the owner's disk (~1.1 MB gz avg)
- Produces: a numbers report (in the reply, not a file) feeding spec §6.4 confidence

- [ ] **Step 1: Write throwaway script `spike.mjs`**

Node script that: (a) picks up to 20 files from `data/history` (or synthesizes 20 × 1.1 MB gz of a repeated 11k-object JSON if absent); (b) measures gunzip+`JSON.parse` per snapshot via `new DecompressionStream("gzip")` (`new Blob([buf]).stream().pipeThrough(...)` → `new Response(s).text()` → `JSON.parse`), reporting avg ms and the sustained sequential rate (decode 60 snapshots in a loop); (c) measures `JSON.parse` of a ~5 MB text string (simulating a WS chunk envelope) and `atob` of a ~1.5 MB base64 string, each over 10 iterations.

- [ ] **Step 2: Run it**

Run: `node spike.mjs`
Expected: prints ms/decode, decodes/s sustained, envelope parse ms, atob ms.

- [ ] **Step 3: Report findings**

State whether ≤ 4 workers can sustain ≥ 30 decodes/s at ~1.1 MB gz, and whether the main-thread envelope cost (≤ 5 MB text frames at up to ~30/s) stays under the 16 ms frame budget in aggregate. If not, flag which spec §6.4 fallback activates. Label all scripts throwaway. **Do not commit anything.**

---

### Task 2: Shared limits + env config

**Files:**
- Create: `shared/limits.ts`
- Modify: `server/config.ts`, `.env.example`
- Test: `test/limits.test.ts`

**Interfaces:**
- Consumes: nothing
- Produces (exact — all later tasks import these):

```ts
// shared/limits.ts
export const GB = 1024 ** 3;
export const STORAGE_CAP_GB_MIN = 0.5;
export const STORAGE_CAP_GB_MAX = 1000;
export const RAM_CACHE_GB_MIN = 0;
export const RAM_CACHE_GB_MAX = 16;
export const RAM_CACHE_GB_DEFAULT = 1;
export const MIN_PIN_MS = 60_000;
export const SPEED_MIN = 30;        // history-ms per real-ms (30 s/s)
export const SPEED_DEFAULT = 3_600; // 1 h/s
export const SPEED_MAX = 86_400;    // 1 d/s
export const SPEED_SLIDER_MAX = 1000;
export const WINDOW_CHUNK_ITEMS = 3; // max items per timeline.window.chunk frame
export const WINDOW_MAX_BYTES_MIN = 1 << 20;       // 1 MiB
export const WINDOW_MAX_BYTES_MAX = 64 << 20;      // 64 MiB
export const WINDOW_MAX_BYTES_DEFAULT = 32 << 20;  // 32 MiB (client request default)
export function speedFromSlider(v: number): number;   // SPEED_MIN × (SPEED_MAX/SPEED_MIN)^(v/SPEED_SLIDER_MAX), v clamped to [0,1000]
export function sliderFromSpeed(s: number): number;   // exact inverse, rounded to int, clamped to [0,1000]
export function clampStorageCapGb(gb: number): number; // [0.5, 1000]; non-finite → 0.5
export function clampRamCacheGb(gb: number): number;   // [0, 16]; non-finite → 0
```

- [ ] **Step 1: Write the failing test `test/limits.test.ts`**

Assert exact constant values (copy from the Interfaces block), plus:
- `speedFromSlider(0)` is exactly 30; `speedFromSlider(1000)` is exactly 86_400.
- `sliderFromSpeed(30)` is 0; `sliderFromSpeed(86_400)` is 1000; `speedFromSlider(sliderFromSpeed(3600))` is within ±2 of 3600.
- `clampStorageCapGb(0.0001)` → 0.5; `clampStorageCapGb(99_999)` → 1000; `clampStorageCapGb(NaN)` → 0.5.
- `clampRamCacheGb(-1)` → 0; `clampRamCacheGb(99)` → 16; `clampRamCacheGb(NaN)` → 0.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/limits.test.ts`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement `shared/limits.ts`**

Pure constants + the four functions per the Interfaces block. Log-scale mapping: `speedFromSlider(v) = SPEED_MIN * Math.pow(SPEED_MAX / SPEED_MIN, v / SPEED_SLIDER_MAX)`; `sliderFromSpeed(s) = Math.round(SPEED_SLIDER_MAX * Math.log(s / SPEED_MIN) / Math.log(SPEED_MAX / SPEED_MIN))`.

- [ ] **Step 4: Add the env var**

`server/config.ts`: add `HISTORY_RAM_CACHE_GB: int("HISTORY_RAM_CACHE_GB", RAM_CACHE_GB_DEFAULT)` (import `RAM_CACHE_GB_DEFAULT` from `../shared/limits.js`; value is in GB, unlike the bytes-unit `HISTORY_MAX_BYTES` — the name says so). `.env.example`: add under the history block: `HISTORY_RAM_CACHE_GB=1` with a comment "initial default (GB) for the decoded-snapshot RAM cache; 0 = off. Overridden at runtime by data/settings.json".

- [ ] **Step 5: Run test to verify it passes + gate**

Run: `npx vitest run test/limits.test.ts && npm test && npm run typecheck && npm run build`
Expected: all pass.

- [ ] **Step 6: Commit**

```bash
git add shared/limits.ts server/config.ts .env.example test/limits.test.ts
git commit -m "feat: shared timeline-modernization limits + HISTORY_RAM_CACHE_GB env default"
```

---

### Task 3: PinStore (pinned time ranges)

**Files:**
- Create: `server/pins.ts`
- Test: `test/pins.test.ts`

**Interfaces:**
- Consumes: `MIN_PIN_MS` from `shared/limits.ts`
- Produces (exact — Tasks 6, 7, 8 consume):

```ts
// server/pins.ts
export interface Pin { id: string; from: number; to: number }
export interface PinStoreOpts { file: string; log?: (msg: string) => void }
export class PinStore {
  constructor(opts: PinStoreOpts);
  init(): Promise<void>;
  all(): Pin[];   // sorted ascending by from
  add(from: number, to: number, bounds: { from: number; to: number } | null): Pin | null;
  remove(id: string): Pin | null;
  contains(ts: number): boolean;
  pinnedBytes(entries: { ts: number; size: number }[]): number;
}
```

Behavior contract:
- File format `{"pins": [...]}` at `opts.file`; atomic write (tmp + rename) after every mutation; `mkdir(dirname, {recursive:true})` before write.
- `init()`: missing file → empty store; unparseable file → empty + `log("pins: corrupt … using empty")`; per-entry validation (finite `from < to`, span ≥ `MIN_PIN_MS`, non-empty string id) — invalid entries dropped with a log line.
- `add(from, to, bounds)`: **normalize `from > to` by swapping** (Review Focus #1); reject (return `null`) if either bound non-finite; clamp into `bounds` when non-null; reject if clamped span < `MIN_PIN_MS`; overlapping pins allowed; `id = "p" + Date.now()`; persist; return the pin.
- `remove(id)`: unknown id → `null`; else remove, persist, return the pin.
- `pinnedBytes(entries)`: sum of `size` for entries where `contains(ts)`.

- [ ] **Step 1: Write the failing tests `test/pins.test.ts`**

Temp dir per test (pattern from `test/history.test.ts`). Cover:
1. Starts empty; `init()` with no file; `all()` = `[]`.
2. `add` writes the file; a second `PinStore` instance on the same file + `init()` sees the pin (persistence round-trip).
3. **Inverted range normalizes** (Review Focus #1): `add(2000, 1000, null)` → pin `{from: 1000, to: 2000}`.
4. Below-min span rejected: `add(1000, 1000 + MIN_PIN_MS - 1, null)` → `null`, file unchanged.
5. Clamping to bounds: `add(500, 9000, {from: 1000, to: 8000})` → pin `{from: 1000, to: 8000}`; and `add(900, 105_000, {from: 1000, to: 1000 + MIN_PIN_MS - 1})` → `null` (clamped span below min).
6. Non-finite rejected: `add(NaN, 5000, null)` → `null`.
7. `remove` returns the pin, persists the empty list; `remove("nope")` → `null`.
8. `contains` true inside, false outside (inclusive bounds).
9. `pinnedBytes`: entries `[1500 (10), 9500 (7)]` vs pin `[1000, 2000]` → 10.
10. Corrupt file (`init()` after writing `"{not json"`) → empty + does not throw.
11. Overlapping pins both kept: `add(1000, 2000, null); add(1500, 2500, null)` → `all()` length 2.

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/pins.test.ts`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement `server/pins.ts`**

Per the behavior contract. Keep the class under ~120 lines.

- [ ] **Step 4: Run tests to verify they pass + gate**

Run: `npx vitest run test/pins.test.ts && npm test && npm run typecheck && npm run build`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add server/pins.ts test/pins.test.ts
git commit -m "feat: PinStore — persisted pinned time ranges for timeline"
```

---

### Task 4: SnapshotCache (decoded LRU)

**Files:**
- Create: `server/snapshot-cache.ts`
- Test: `test/snapshot-cache.test.ts`

**Interfaces:**
- Consumes: `Craft` from `shared/craft.ts`
- Produces (exact — Tasks 6, 7, 8 consume):

```ts
// server/snapshot-cache.ts
export interface SnapshotCacheOpts { maxBytes: number; log?: (msg: string) => void }
export class SnapshotCache {
  constructor(opts: SnapshotCacheOpts);
  get(ts: number): Craft[] | undefined;   // hit → entry becomes MRU
  set(ts: number, crafts: Craft[], rawBytes: number): void;  // rawBytes = size proxy (raw JSON byte length); trims
  drop(ts: number): void;
  resize(maxBytes: number): void;         // 0 → clear + disabled (subsequent set()s store nothing)
  usedBytes(): number;
}
```

- [ ] **Step 1: Write the failing tests `test/snapshot-cache.test.ts`**

1. `set` then `get` returns the same array content; `usedBytes()` = sum of rawBytes.
2. LRU order: cap 100; set ts 1 (30), 2 (30), 3 (30) → trim evicts ts 1; `get(1)` undefined, `get(3)` defined. Then `get(2)` (makes 2 MRU) and `set(4, …, 30)` → evicts ts 3 (least recently used), keeps 2.
3. `drop(2)` removes; `usedBytes` drops.
4. `resize(50)` trims oldest-first to ≤ 50; `resize(0)` clears everything and `set` afterwards stores nothing (`get` undefined, `usedBytes()` 0).
5. Re-`set` of an existing ts replaces content without double-counting size.

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/snapshot-cache.test.ts`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement `server/snapshot-cache.ts`**

`Map<number, { crafts: Craft[]; size: number }>` — Map insertion order is the LRU order; `get` hit = `delete` + re-`set` (move to MRU end). Trimming: while `usedBytes() > maxBytes` and size > 0, `map.keys().next().value` (LRU end). All under ~90 lines.

- [ ] **Step 4: Run tests to verify they pass + gate**

Run: `npx vitest run test/snapshot-cache.test.ts && npm test && npm run typecheck && npm run build`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add server/snapshot-cache.ts test/snapshot-cache.test.ts
git commit -m "feat: SnapshotCache — byte-capped LRU of decoded snapshots"
```

---

### Task 5: Server settings store

**Files:**
- Create: `server/settings.ts`
- Test: `test/settings.test.ts`

**Interfaces:**
- Consumes: `GB`, `clampStorageCapGb`, `clampRamCacheGb` from `shared/limits.ts`
- Produces (exact — Task 8 consumes):

```ts
// server/settings.ts
export interface RuntimeSettings { storageCapBytes: number; ramCacheBytes: number }
export interface SettingsDoc { storageCapGb: number; ramCacheGb: number; [k: string]: unknown }
export interface SettingsOpts { file: string; envDefaults: RuntimeSettings; log?: (msg: string) => void }
export async function loadSettingsDoc(opts: SettingsOpts): Promise<SettingsDoc>;
export async function persistSettingsDoc(opts: SettingsOpts, doc: SettingsDoc): Promise<void>;
export function toRuntime(doc: SettingsDoc): RuntimeSettings; // { storageCapBytes: doc.storageCapGb * GB, ramCacheBytes: doc.ramCacheGb * GB }
```

Behavior contract:
- `loadSettingsDoc`: file missing → doc built from `envDefaults` (bytes → GB, rounded to 2 decimals); unparseable → log + same defaults; each of the two known keys validated as finite and clamped (`clampStorageCapGb` / `clampRamCacheGb`); **unknown keys are preserved untouched** (Review Focus #2).
- `persistSettingsDoc`: `mkdir(dirname, {recursive:true})`, write `JSON.stringify(doc, null, 2)` to `<file>.tmp`, `rename` to `<file>` (atomic).
- The file is authoritative at runtime; `.env`/`envDefaults` apply only when the file is absent/corrupt.

- [ ] **Step 1: Write the failing tests `test/settings.test.ts`**

Temp dir per test. `envDefaults = { storageCapBytes: 10 * GB, ramCacheBytes: 1 * GB }`:
1. File absent → `loadSettingsDoc` returns `{storageCapGb: 10, ramCacheGb: 1}` (unknown keys empty).
2. File present `{"storageCapGb": 4, "ramCacheGb": 2}` → returned as-is; differs from env defaults (file wins).
3. Corrupt file → defaults + does not throw.
4. Out-of-range in file: `{"storageCapGb": 99_999, "ramCacheGb": -3}` → `{1000, 0}`.
5. **Unknown key preserved (Review Focus #2)**: `loadSettingsDoc` on `{"storageCapGb": 4, "ramCacheGb": 2, "timelineZoom": 2.5}` → keeps `timelineZoom === 2.5`; `persistSettingsDoc` then reload on a fresh opts → still present with the same value.
6. `persistSettingsDoc` writes atomically-valid JSON (file parseable immediately; no `.tmp` remnant).
7. `toRuntime({storageCapGb: 2.5, ramCacheGb: 1})` → `{storageCapBytes: 2.5 * GB, ramCacheBytes: GB}`.

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/settings.test.ts`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement `server/settings.ts`**

Per the behavior contract (~80 lines).

- [ ] **Step 4: Run tests to verify they pass + gate**

Run: `npx vitest run test/settings.test.ts && npm test && npm run typecheck && npm run build`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add server/settings.ts test/settings.test.ts
git commit -m "feat: runtime settings store (data/settings.json) with forward-compatible keys"
```

---

### Task 6: History — pin-aware eviction, live cap, 0-byte cleanup

**Files:**
- Modify: `server/history.ts`
- Test: `test/history.test.ts` (extend)

**Interfaces:**
- Consumes: `PinStore` (Task 3)
- Produces (exact — Tasks 7, 8 consume; existing API unchanged):

```ts
export interface HistoryRecorderOpts {
  dir: string;
  snapshotMs: number;
  maxBytes: number;
  pins?: PinStore;            // NEW — omit = no pin awareness (legacy behavior)
  cache?: SnapshotCache;      // NEW — used in Task 7
  now?: () => number;
  log?: (msg: string) => void;
}
// NEW methods on HistoryRecorder:
setCap(bytes: number): void;                 // updates cap + fires async evict (errors logged)
entries(): { ts: number; size: number }[];   // copy of the index, ascending
usedBytes(): number;                         // sum of ALL index sizes (pinned + unpinned)
get snapshotMs(): number;                    // opts.snapshotMs
```

Eviction algorithm (replaces `evict()`):

```
unpinned = index entries where !pins?.contains(ts)
total = Σ unpinned.size
while total > cap AND unpinned non-empty:
    candidate = oldest unpinned
    if candidate is the newest index entry AND the only unpinned one: break   # keep-newest invariant
    delete candidate (unlink, cache?.drop in Task 7); total -= candidate.size
```

`init()`: while scanning, **0-byte `.json.gz` files are unlinked + logged** and not indexed (a 0-byte file was found on the owner's disk 2026-10-25; today a seek onto one bounces to LIVE). Non-snapshot files (e.g. `pins.json`) stay untouched.

- [ ] **Step 1: Write the failing tests (extend `test/history.test.ts`)**

New `describe("pin-aware eviction")` (PinStore on a `pins.json` in the same temp dir; recorder built with `{...rec(), pins}` — extend the local `rec()` helper to accept extra opts):
1. Pinned survive eviction: cap 1 (any real snapshot exceeds it); record 4 snapshots at t=1000…4000; pin `[1000, 2000]` before a final `recordNow` at t=5000; after settle, disk holds `1000, 2000, 5000` (3000, 4000 evicted — they're unpinned and older); range reflects it.
2. **Pinned-only above cap (Review Focus #4)**: cap 1; two snapshots t=1000, 2000; pin `[1000, 2000]`; `await h.setCap(1)` → both files still on disk, `h.usedBytes() > 1`, index has 2 entries (loop terminated, overshoot is legal).
3. `setCap` lowers the cap live: 3 snapshots, big cap; `setCap(1)` → evicts down (newest kept) and `usedBytes()` reflects post-evict state.
4. No-pin regression: recorder without `pins` opt behaves exactly as before (existing eviction test already covers; add one assertion that `entries()`/`usedBytes()` are consistent).
5. 0-byte cleanup: pre-create `<dir>/1000.json.gz` (empty) and `<dir>/2000.json.gz` (real via `recordNow` at t=2000) + a `pins.json` file with content; `init()` → `1000.json.gz` gone, `2000.json.gz` indexed, `pins.json` byte-identical, range = `{from: 2000, to: 2000, snapshots: 1}`.

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/history.test.ts`
Expected: new tests FAIL (methods/opts missing); old tests still pass.

- [ ] **Step 3: Implement in `server/history.ts`**

Add `pins?`/`cache?` opts, `setCap`/`entries`/`usedBytes`/`snapshotMs`, the pin-aware `evict()`, and the 0-byte drop in `init()`. Keep the existing keep-newest invariant and the `index.length`-based guard.

- [ ] **Step 4: Run tests to verify they pass + gate**

Run: `npx vitest run test/history.test.ts && npm test && npm run typecheck && npm run build`
Expected: all pass (old eviction test unchanged and green).

- [ ] **Step 5: Commit**

```bash
git add server/history.ts test/history.test.ts
git commit -m "feat: pin-aware history eviction, live setCap, 0-byte snapshot cleanup"
```

---

### Task 7: History — window streaming + cache integration

**Files:**
- Modify: `server/history.ts`
- Test: `test/window.test.ts` (new), `test/history.test.ts` (extend)

**Interfaces:**
- Consumes: `SnapshotCache` (Task 4)
- Produces (exact — Task 8 consumes):

```ts
export interface WindowItem { ts: number; gz: Buffer }
export interface HistoryStatus extends HistoryRange {   // NEW type, defined here; hub.ts imports it
  usedBytes: number;
  pinnedBytes: number;
  snapshotMs: number;
}
// NEW on HistoryRecorder:
window(from: number, to: number, stride: number, maxBytes: number): Promise<WindowItem[]>;
status(pins: PinStore): HistoryStatus;  // { ...range(), usedBytes: usedBytes(), pinnedBytes: pins.pinnedBytes(entries()), snapshotMs }
```

`window()` contract: first snapshot with `ts >= from` (binary search), then every `stride`-th entry while `ts <= to`; stop once cumulative gz bytes ≥ `maxBytes` (a range with data always returns ≥ 1 item even if that single item exceeds `maxBytes`); missing file → skipped + logged (index entry kept — could be transient); **0-byte file → skipped, removed from the index, logged**; empty index → `[]`.

Cache integration:
- `seek()`: resolve `pick` as today (refactor the linear scan to a binary-search `lowerBound(time)` — same clamp semantics: newest `ts <= time`, clamp early to oldest, late to newest); then **cache hit → return without any disk I/O**; miss → readFile + gunzip + parse → `cache?.set(pick.ts, craft, Buffer.byteLength(json))` → return.
- `recordNow()`: after writing, `cache?.set(ts, crafts, Buffer.byteLength(json))` (warm — scrubbing "now-ish" is instant).
- `evict()`: `cache?.drop(ts)` for each deleted snapshot.

- [ ] **Step 1: Write the failing tests `test/window.test.ts`**

Recorder with fake `now` (pattern from `test/history.test.ts`), 4 snapshots at t = 1000, 2000, 3000, 4000, distinct craft ids per snapshot:
1. `window(1000, 4000, 1, big)` → 4 items, ascending ts.
2. `window(1000, 4000, 2, big)` → ts `[1000, 3000]` (first ≥ from, then every 2nd).
3. `window(0, 9999, 1, big)` clamps to the same 4 (from before oldest, to after newest).
4. `maxBytes` bound: pick a maxBytes ≈ one item's gz size → ≥ 1 item, and the loop stops (items.length ≤ 2 for 4 equal-size items).
5. Missing file: `rm` the t=2000 file; `window(1000, 4000, 1, big)` → 3 items (2000 skipped), does not throw.
6. 0-byte file: overwrite t=3000 file with empty; `window(1000, 4000, 1, big)` → 3 items; a following `range()` has 3 snapshots (index cleaned).
7. Empty history → `[]`.
8. `gz` payload round-trips: `JSON.parse(gunzipSync(item.gz))` equals the recorded crafts.

Extend `test/history.test.ts`:
9. Seek served from cache: record at t=1000; `seek(1000)` (miss → warms); `rm` the file; `seek(1000)` again → still resolves with the crafts (cache hit, no disk).
10. `recordNow` warms the cache: after `recordNow`, `cache.get(ts)` is defined (construct recorder with a `SnapshotCache` instance you hold).
11. `status(pins)`: with one pin covering one of two snapshots → `usedBytes` = both sizes, `pinnedBytes` = the pinned one, `snapshotMs` = the opts value.

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/window.test.ts test/history.test.ts`
Expected: new tests FAIL (window/status missing); old tests pass.

- [ ] **Step 3: Implement in `server/history.ts`**

Binary-search `lowerBound`, `window()`, `status()`, and the three cache touch points, per the contract.

- [ ] **Step 4: Run tests to verify they pass + gate**

Run: `npx vitest run test/window.test.ts test/history.test.ts && npm test && npm run typecheck && npm run build`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add server/history.ts test/window.test.ts test/history.test.ts
git commit -m "feat: strided history window streaming + decoded-snapshot cache integration"
```

---

### Task 8: Server protocol + wiring (hub + index)

**Files:**
- Modify: `server/hub.ts`, `server/index.ts`
- Test: `test/hub.test.ts` (extend)

**Interfaces:**
- Consumes: `PinStore` (3), `SettingsDoc/RuntimeSettings` (5), `SnapshotCache` (4), `HistoryRecorder.window/status/setCap` (6–7), limits (2)
- Produces — **the protocol contract the client (Task 9) mirrors:**

Client→server (`ClientMessage` union additions + `parseClientMessage`):
```ts
| { type: "settings.update"; patch: { storageCapGb?: number; ramCacheGb?: number } }
| { type: "pin.add"; from: number; to: number }
| { type: "pin.remove"; id: string }
| { type: "timeline.window"; seq: number; from: number; to: number; stride: number; maxBytes: number }
```
Parse rules: `settings.update` → `patch` is a plain object (finite fields applied later; non-finite fields ignored by the handler). `pin.add` → finite `from`/`to` (any order — normalization is the handler's job). `pin.remove` → non-empty string `id`. `timeline.window` → integer `seq`, finite `from`/`to`, integer `stride >= 1`, finite `maxBytes > 0`. Malformed → `null` (ignored, existing convention).

Server→client (`StatusPayload` change; new frames emitted by `index.ts` handlers):
```ts
export interface StatusPayload {
  feeds: FeedStatus;
  history: HistoryStatus;   // from history.ts (Task 7)
  settings: { storageCapGb: number; ramCacheGb: number; cacheUsedBytes: number };
  pins: Pin[];
  staleMs: number;
  faa: FaaStatus;
  icons: IconStatus;
}
// s→c replies (per-client, via the existing reply closure):
// { type: "pins", pins: Pin[] }
// { type: "timeline.window.chunk", seq: number, items: { ts: number; b64: string }[], done: boolean, reachedTo: number | null }
```

- [ ] **Step 1: Write the failing tests (extend `test/hub.test.ts`)**

1. `parseClientMessage` accepts each of the 4 new frames with valid shapes (assert the returned object identity/fields); rejects: `settings.update` with `patch: "x"`; `pin.add` with `to: NaN` or `from` missing; `pin.remove` with empty id; `timeline.window` with `stride: 0`, `seq: 1.5`, `maxBytes: -1`, missing `to`.
2. **Inverted `pin.add` is accepted at parse** (from > to — normalization happens in the handler) (Review Focus #1, server entry).
3. Status frame carries the new fields: build a Hub with a `statusPayload` closure returning a full new-shape payload; `attach` frame JSON includes `settings`, `pins`, `staleMs`; tick re-broadcasts only when the payload changes (existing dedupe behavior still holds with the new fields).
4. Update every existing test that constructs a `StatusPayload` literal so it compiles with the new required fields (settings/pins/staleMs).

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/hub.test.ts`
Expected: new tests FAIL; existing may FAIL on types (expected — they're updated in Step 4).

- [ ] **Step 3: Implement `server/hub.ts`**

Add the 4 `ClientMessage` variants + parse rules; extend `StatusPayload` (import `HistoryStatus` from `./history.js`, `Pin` from `./pins.js`); change both status frame constructions (attach + tick) to `{ type: "status", ...payload, serverTime: Date.now() }` and the dedupe string to `JSON.stringify(payload)` — this removes the per-field listing in two places.

- [ ] **Step 4: Implement `server/index.ts` wiring**

1. `ServerDeps` gains `settingsFile?: string; pinFile?: string;` (defaults `data/settings.json` / `data/history/pins.json` relative to cwd).
2. In `buildApp`, before recorder construction: `const settingsDoc = await loadSettingsDoc({ file, envDefaults: { storageCapBytes: config.HISTORY_MAX_BYTES, ramCacheBytes: config.HISTORY_RAM_CACHE_GB * GB }, log });` — hold in a `let` closure var. `const pinStore = new PinStore({ file: pinFile, log }); await pinStore.init();` `const snapshotCache = new SnapshotCache({ maxBytes: toRuntime(settingsDoc).ramCacheBytes, log });`
3. Default recorder: `maxBytes: toRuntime(settingsDoc).storageCapBytes`, plus `pins: pinStore, cache: snapshotCache`. (Explicit `deps.recorder` — e.g. integration tests — keeps its own constructor opts.)
4. `statusPayload` closure: `history: recorder ? recorder.status(pinStore) : { from: null, to: null, snapshots: 0, usedBytes: 0, pinnedBytes: 0, snapshotMs: config.HISTORY_SNAPSHOT_MS }`, plus `settings: { storageCapGb: settingsDoc.storageCapGb, ramCacheGb: settingsDoc.ramCacheGb, cacheUsedBytes: snapshotCache.usedBytes() }`, `pins: pinStore.all()`, `staleMs: config.STALE_MS`.
5. New switch cases:
   - `settings.update`: for each finite field → `settingsDoc.<key> = clamp...(v)`; `recorder?.setCap(toRuntime(settingsDoc).storageCapBytes)`; `snapshotCache.resize(toRuntime(settingsDoc).ramCacheBytes)`; `await persistSettingsDoc(...)` (void + catch-log). No reply frame — the status tick echoes within 250 ms.
   - `pin.add`: `if (!recorder) break;` bounds = `recorder.range()`; break if `from == null || to == null`; `const pin = pinStore.add(msg.from, msg.to, bounds); if (pin) reply({ type: "pins", pins: pinStore.all() });`
   - `pin.remove`: `const p = pinStore.remove(msg.id); if (p) reply({ type: "pins", pins: pinStore.all() });`
   - `timeline.window`: `if (!recorder) break;` clamp `maxBytes` to `[WINDOW_MAX_BYTES_MIN, WINDOW_MAX_BYTES_MAX]`; `void recorder.window(from, to, stride, maxBytes).then(items => { …chunk… }).catch(log)`. Chunking: slices of ≤ `WINDOW_CHUNK_ITEMS`; each slice → one reply `{ type: "timeline.window.chunk", seq, items: slice.map(it => ({ ts: it.ts, b64: it.gz.toString("base64") })), done: <last slice>, reachedTo: <last slice ? last item ts : null> }`; zero items → single reply `{ seq, items: [], done: true, reachedTo: null }`.

- [ ] **Step 5: Run tests + gate**

Run: `npx vitest run test/hub.test.ts && npm test && npm run typecheck && npm run build`
Expected: all pass.

- [ ] **Step 6: Commit**

```bash
git add server/hub.ts server/index.ts test/hub.test.ts
git commit -m "feat: server protocol + wiring for pins, runtime settings, window streaming"
```

---

### Task 9: Client WS frames

**Files:**
- Modify: `src/data/ws.ts`
- Test: `test/ws.test.ts` (extend)

**Interfaces:**
- Consumes: nothing new
- Produces (exact — Tasks 10, 13, 15 consume):

```ts
// ws.ts additions
export interface Pin { id: string; from: number; to: number }
export interface WindowChunk { seq: number; items: { ts: number; b64: string }[]; done: boolean; reachedTo: number | null }
// RadarMessage union +:
//   { type: "pins"; pins: Pin[] }
//   { type: "timeline.window.chunk" } & WindowChunk
// StatusMessage +:  settings?: { storageCapGb: number; ramCacheGb: number; cacheUsedBytes: number }; pins?: Pin[]; staleMs?: number
// HistoryRange +:   usedBytes?: number; pinnedBytes?: number; snapshotMs?: number
// RadarSocketHandlers +:  onPins?: (pins: Pin[]) => void;  onWindowChunk?: (chunk: WindowChunk) => void
// RadarSocket methods +:
sendSettingsUpdate(patch: { storageCapGb?: number; ramCacheGb?: number }): void;
sendPinAdd(from: number, to: number): void;
sendPinRemove(id: string): void;
sendTimelineWindow(seq: number, from: number, to: number, stride: number, maxBytes: number): void;
```

Parse rules: `pins` → `Array.isArray(msg.pins)`; `timeline.window.chunk` → number `seq`, array `items`, boolean `done`, `reachedTo` number|null. New `StatusMessage` fields are **optional** (mirrors the existing `?? — pre-Task-N frames` tolerance pattern in `main.ts`).

- [ ] **Step 1: Write the failing tests (extend `test/ws.test.ts`)**

1. `parseRadarMessage` accepts a valid `pins` frame and a valid `timeline.window.chunk` (assert fields pass through); rejects: `pins` with `pins: "x"`; chunk missing `seq` / `items` / `done`; `reachedTo: "x"`.
2. A `status` frame WITH the new fields parses; a status frame WITHOUT them still parses (back-compat).
3. Send helpers emit exact JSON: using the existing FakeWebSocket pattern, `sendSettingsUpdate({storageCapGb: 4})` → `{"type":"settings.update","patch":{"storageCapGb":4}}`; `sendPinAdd(1, 2)` → `{"type":"pin.add","from":1,"to":2}`; `sendPinRemove("p1")` → `{"type":"pin.remove","id":"p1"}`; `sendTimelineWindow(7, 1, 2, 3, 4)` → `{"type":"timeline.window","seq":7,"from":1,"to":2,"stride":3,"maxBytes":4}`.

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/ws.test.ts`
Expected: new tests FAIL.

- [ ] **Step 3: Implement in `src/data/ws.ts`**

Types, the two `parseRadarMessage` branches (inserted **before** the final `else` `timeline.state` dispatch), the dispatch lines (`else if (msg.type === "pins") …; else if (msg.type === "timeline.window.chunk") …`), and the four send methods.

- [ ] **Step 4: Run tests + gate**

Run: `npx vitest run test/ws.test.ts && npm test && npm run typecheck && npm run build`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add src/data/ws.ts test/ws.test.ts
git commit -m "feat: client WS frames for pins, settings, window streaming"
```

---

### Task 10: Playback engine (pure core)

**Files:**
- Create: `src/data/playback.ts`
- Test: `test/playback.test.ts`

**Interfaces:**
- Consumes: `Craft` (shared), `WindowChunk` (Task 9), `SPEED_MIN`, `SPEED_MAX`, `WINDOW_MAX_BYTES_DEFAULT` (Task 2)
- Produces (exact — Task 15 consumes):

```ts
export type PlaybackState = "idle" | "buffering" | "playing" | "paused";
export interface PlaybackWindowReq { seq: number; from: number; to: number; stride: number; maxBytes: number }
export interface PlaybackOpts {
  snapshotMs: () => number;   // from status.history.snapshotMs (main defaults 60000)
  staleMs: () => number;      // from status.staleMs (main defaults 120000)
  historyFrom: () => number | null;
  historyTo: () => number | null;
  requestWindow: (req: PlaybackWindowReq) => void;
  decode: (gz: ArrayBuffer) => Promise<Craft[]>;
  onFrame: (crafts: Craft[], t: number) => void;
  onState: (s: PlaybackState) => void;
  now: () => number;          // real-time clock (ms)
  log?: (msg: string) => void;
}
export interface PlaybackApi {
  readonly state: PlaybackState;
  readonly cursor: number;
  start(t0: number): void;
  pause(): void;
  stop(): void;
  setSpeed(s: number): void;  // clamped to [SPEED_MIN, SPEED_MAX]
  feed(chunk: WindowChunk): void;
  tick(nowMs: number): void;
}
export function createPlaybackEngine(opts: PlaybackOpts): PlaybackApi;
export function lerpCrafts(a: Craft[], b: Craft[], f: number, t: number, staleMs: number): Craft[];
```

Semantics (all pinned by the tests below):
- `start(t0)`: `historyFrom() == null` → no-op (stays `idle`). Else `cursor = clamp(t0, from, to)`, governor reset (`targetFps = 60`, `ema = 0`), `seq++`, state → `buffering` (`onState`), prefetch.
- **Modes per frame**: `advancePerFrame = speed × 1000 / targetFps` (history ms per rendered frame). Lerp when `advancePerFrame < snapshotMs()` **and** the bracketing pair exists **and** `hi.ts − lo.ts ≤ 1.5 × snapshotMs()`; otherwise skip (render `lo`).
- **Lerp** = `lerpCrafts(lo, hi, f, cursor, staleMs())`, `f = (cursor − lo.ts) / (hi.ts − lo.ts)`. **Skip** = `lo.crafts.map(c => ({ ...c, stale: cursor − c.updatedAt > staleMs() }))` — fresh objects; the buffer is never mutated.
- `lerpCrafts(a, b, f, t, staleMs)`: per craft id — in both → `{...a, lat: a.lat + (b.lat − a.lat) × f, lon: …, heading: lerpHeading(a.heading, b.heading, f), stale: t − b.updatedAt > staleMs}` (all other fields from `a`); only in `b` → `{...b, stale: t − b.updatedAt > staleMs}` (appears); only in `a` → dropped (disappears). `lerpHeading`: either null → `a.heading`; else `(a + ((b − a + 540) % 360 − 180) × f + 360) % 360`.
- **Stale is strict `>`** (Review Focus #5).
- `feed(chunk)`: `chunk.seq !== seq` → ignore (superseded). Per item: `buffer.has(ts)` → skip; else decode (b64 → `ArrayBuffer`) async → `buffer.set(ts, crafts)` + trim; **decode reject → `log` only — the engine stalls, never throws, and later chunks still work** (Review Focus #3). On `done`: `nextFrom = chunk.reachedTo == null ? reqTo + 1 : chunk.reachedTo + 1` (where `reqTo` is the `to` of the in-flight request for this seq).
- `tick(nowMs)`: `idle` → return. If `playing`: `dt = nowMs − lastTick` (0 on the first tick after start/pause-resume); `cursor = min(cursor + speed × dt, historyTo() ?? cursor)`. Prefetch (`requestNext`) runs in both `buffering` and `playing`. Frame: governor gate first — `nowMs − lastRender < 1000 / targetFps` → return (no frame). `lo` = newest buffered `ts ≤ cursor`; none → stall (return). Compute mode + frame; `cost` measured as `opts.now()` before vs after `onFrame(frame, cursor)`; `ema = ema ? 0.8 × ema + 0.2 × cost : cost`; if `ema > 34` → `targetFps = targetFps === 60 ? 30 : 15`. If `cursor >= historyTo()` → `pause()` after the final frame.
- `requestNext()`: only when state is `buffering`/`playing`, no in-flight request, `nextFrom != null` and `nextFrom ≤ historyTo()`: `seq++`; `stride = max(1, ceil(advancePerFrame / snapshotMs()))`; `req = { seq, from: nextFrom, to: historyTo(), stride, maxBytes: WINDOW_MAX_BYTES_DEFAULT }`; mark in-flight (store its `to`); `nextFrom = null`; `requestWindow(req)`.
- `setSpeed(s)`: clamp to `[SPEED_MIN, SPEED_MAX]`; `seq++` (in-flight request superseded — its chunks drop via the seq check; its decoded items, if they land, are harmless valid data).
- `pause()`: state → `paused` (`onState`), reset `lastTick`. `stop()`: state → `idle` (`onState`), clear buffer, `seq++`, in-flight null, `nextFrom` null.
- **Trim** (after buffer inserts and each rendered frame): drop entries with `ts < cursor − 2 × snapshotMs()` or `ts > cursor + clamp(advancePerFrame × 8, 600_000, 1_800_000)`.

- [ ] **Step 1: Write the failing tests `test/playback.test.ts`**

Harness (top of file): `makeEngine(snapshots: {ts: number; crafts: Craft[]}[], overrides?: Partial<PlaybackOpts>)` → `{ engine, requests: PlaybackWindowReq[], frames: { crafts: Craft[]; t: number }[], advanceNow(ms), decodeFailNext?: boolean }`. Fakes: `now` = manual clock (starts 1_000_000); `historyFrom/To` from the snapshot set (null when empty); `snapshotMs: () => 60_000`, `staleMs: () => 120_000`; `requestWindow` records the req and **auto-answers** with `engine.feed({ seq, items: [that ts's snapshot], done: true, reachedTo: ts })` synchronously (decode fake resolves the real crafts by ts, ignoring b64 content); `onFrame` pushes to `frames`. Drive frames with `engine.tick(engine clock + step)` at 1000/60 ms steps.

Tests:
1. `start` with empty history → `state === "idle"`, no requests, no frames.
2. Cursor advance: `start(firstTs)`, `setSpeed(30)`; one tick of +1000 ms → `cursor` advanced by 30_000.
3. End clamp: speed high, tick until `cursor` reaches `historyTo` → state `paused`, further ticks don't advance.
4. Lerp mode at 30× (default fps 60): two snapshots 60 s apart with `lat` 0/2 → tick so `cursor` sits mid-gap → last frame's craft `lat === 1` (and `lon` mid).
5. Heading: `lerpCrafts` direct — 90→120 at f=0.5 → 105; 350→10 at f=0.5 → 0 (shortest arc via north); null heading → steps to `a.heading`.
6. Appear/disappear: craft only in `b` present in lerped frame; only in `a` absent.
7. **Lerp gap guard**: only two snapshots 120 s apart, speed 30 → frame equals a shallow copy of the LOWER snapshot (skip), not a lerp.
8. **Stale boundary (Review Focus #5)**: craft `updatedAt = t − staleMs` → `stale === false`; `updatedAt = t − staleMs − 1` → `stale === true`.
9. Skip mode at 86_400×: `setSpeed(86_400)` → request stride is 48 (at fps 60); frame objects are shallow copies (mutating a frame object does not change the buffer's copy).
10. **Feed seq staleness**: `setSpeed` mid-flight, then a chunk with the OLD seq → no buffer insert (verified via no frame from that ts / requests re-issued with the new seq).
11. `done`/`nextFrom`: after a done chunk with `reachedTo` X, the next request's `from === X + 1`; an empty done chunk (`items: []`, `reachedTo: null`) → next request `from === reqTo + 1`.
12. Governor: `onFrame` fake advances the manual clock by 40 ms (cost 40) → after the first rendered frame `targetFps` is 30 (asserted indirectly: a tick only 10 ms after `lastRender` produces NO new frame; a tick 40 ms later does).
13. Stall: `requestWindow` fake that does NOT auto-answer → `start` + ticks → state `buffering`, no frames; then answer with a chunk → next tick renders.
14. **Corrupt item (Review Focus #3)**: `decodeFailNext` makes one item's decode reject → engine logs, no frame from it, no throw; a subsequent good chunk still renders.
15. Trim: with a 30× speed, pre-seed the buffer with a snapshot 20 min ahead → after a tick it's dropped (lookAhead floor 600_000 ms); a snapshot 1 min behind is kept (2 × snapshotMs behind-window).

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/playback.test.ts`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement `src/data/playback.ts`**

Per the semantics block. Pure module — no DOM, no `Worker`, no globals except `atob` (Node 16+ provides it; tests rely on that). Keep to ~250 lines.

- [ ] **Step 4: Run tests + gate**

Run: `npx vitest run test/playback.test.ts && npm test && npm run typecheck && npm run build`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add src/data/playback.ts test/playback.test.ts
git commit -m "feat: playback engine — virtual clock, lerp/skip modes, buffer, governor"
```

---

### Task 11: Decode pool + worker

**Files:**
- Create: `src/data/decode.worker.ts`, `src/data/decode.ts`
- Test: `test/decode.test.ts`

**Interfaces:**
- Consumes: `Craft` (shared)
- Produces (exact — Task 15 consumes):

```ts
// src/data/decode.worker.ts
export function decodeGz(buf: ArrayBuffer): Promise<Craft[]>;
// DecompressionStream("gzip") → text → JSON.parse. Node + browser (Blob.stream + Response both exist).
// Worker entry, guarded so importing in Node tests is side-effect free:
//   const isWorker = typeof self !== "undefined" && typeof (self as any).postMessage === "function";
//   if (isWorker) self.onmessage = async (e) => { try { postMessage({ id, crafts: await decodeGz(e.data.buf) }) } catch (err) { postMessage({ id, error: String(err) }) } };

// src/data/decode.ts
export function decodeSupported(): boolean; // typeof DecompressionStream !== "undefined"
export interface DecodePool { decode(gz: ArrayBuffer): Promise<Craft[]> }
export interface PoolWorker {
  postMessage(msg: { id: number; buf: ArrayBuffer }): void;
  onmessage: ((ev: { data: { id: number; crafts?: Craft[]; error?: string } }) => void) | null;
}
export function createDecodePool(size?: number, spawn?: () => PoolWorker): DecodePool;
// size default: min(4, navigator?.hardwareConcurrency ?? 2). spawn default:
//   () => new Worker(new URL("./decode.worker.ts", import.meta.url), { type: "module" }) adapted to PoolWorker.
```

Pool contract: round-robin dispatch over `size` workers; pending results routed by message `id`; a worker that posts `error` → its in-flight promise rejects **and the worker is replaced** by a fresh `spawn()` on the next dispatch (subsequent decodes succeed).

- [ ] **Step 1: Write the failing tests `test/decode.test.ts`**

1. `decodeGz` round-trip: `const raw = JSON.stringify([craft("a"), craft("b")]); const gz = zlib.gzipSync(Buffer.from(raw));` → `decodeGz(gz.buffer)` deep-equals the array. (Use the `craft()` helper shape from `test/history.test.ts`.)
2. `decodeGz` rejects on non-gzip bytes (`new TextEncoder().encode("not gzip").buffer`).
3. `decodeSupported()` is `true` on Node 26.
4. Pool with 2 fake workers (fake = object implementing `PoolWorker`; its `postMessage` defers `onmessage({data:{id, crafts}})` by a microtask, tracking concurrency): 5 concurrent `decode()` calls all resolve with the correct per-id results (embed the id in the returned crafts' `id` field to catch mis-routing); max observed concurrency ≤ 2.
5. **Worker error (Review Focus #3, pool half)**: first fake worker posts `{error: "boom"}` for its first message → that `decode()` rejects; a subsequent `decode()` succeeds (fresh spawned fake).

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/decode.test.ts`
Expected: FAIL (modules not found).

- [ ] **Step 3: Implement `decode.worker.ts` then `decode.ts`**

Per the Interfaces block. `createDecodePool` keeps a `workers: PoolWorker[]`, `next: number`, `pending: Map<number, {resolve, reject}>`, and an `idCounter`.

- [ ] **Step 4: Run tests + gate**

Run: `npx vitest run test/decode.test.ts && npm test && npm run typecheck && npm run build`
Expected: all pass. (Vite bundles the worker via the `new URL` pattern in the build — the successful build verifies it.)

- [ ] **Step 5: Commit**

```bash
git add src/data/decode.worker.ts src/data/decode.ts test/decode.test.ts
git commit -m "feat: gz decode worker pool (DecompressionStream) with fault-tolerant routing"
```

---

### Task 12: Format helpers (dates, bytes, speed)

**Files:**
- Create: `src/ui/format.ts`
- Test: `test/format.test.ts`

**Interfaces:**
- Consumes: nothing (pure display math; speed mapping already lives in `shared/limits.ts`)
- Produces (exact — Tasks 13, 14 consume):

```ts
export function formatBytes(n: number): string;            // 1024-based, 1 decimal, ".0" trimmed: "0 B", "1 KB", "1.5 KB", "1 MB", "9 GB"
export function formatRangeLabel(from: number, to: number): string; // same local day: "09:12 – 14:40"; else "Oct 20 09:12 – Oct 26 09:12"
export function formatSelectedTime(t: number): string;     // always dated: "Oct 26 09:12:34"
export function formatReplayClock(t: number, now?: number): string; // same local day as now: "14:32:05"; else "Oct 24 14:32"
export function dayTicks(from: number, to: number): number[]; // local-midnight epochs strictly within (from, to]
export function formatSpeed(s: number): string;            // <60: "N s/s"; <3600: "N min/s"; <86400: "N h/s"; else "N d/s" (1 decimal, ".0" trimmed)
```

Date formatting via `toLocaleDateString([], { month: "short", day: "numeric" })` + `toLocaleTimeString([], { hour12: false, … })` — **all test dates are constructed in local time** (`new Date(2026, 9, 20, 9, 12)`) so assertions are TZ-independent.

- [ ] **Step 1: Write the failing tests `test/format.test.ts`**

1. `formatBytes`: 0 → "0 B"; 1024 → "1 KB"; 1536 → "1.5 KB"; 1_048_576 → "1 MB"; 9 × 1024³ → "9 GB"; 8.98e9 (≈ 8.98 GiB) → "9 GB".
2. `formatRangeLabel`: `new Date(2026, 9, 20, 9, 12)` → `new Date(2026, 9, 20, 14, 40)` → "09:12 – 14:40"; Oct 20 09:12 → Oct 26 09:12 → "Oct 20 09:12 – Oct 26 09:12"; Dec 31 23:00 → Jan 1 01:00 (year boundary) → "Dec 31 23:00 – Jan 1 01:00".
3. `formatSelectedTime`: `new Date(2026, 9, 26, 9, 12, 34)` → "Oct 26 09:12:34".
4. `formatReplayClock`: same-day t with `now` → "14:32:05"; t one day before `now` → "Oct 24 14:32".
5. `dayTicks`: Oct 20 09:00 → Oct 22 10:00 → exactly `[Oct 21 00:00, Oct 22 00:00]` epochs; same-day span → `[]`; boundary: `from` at midnight excluded, `to` at midnight included.
6. `formatSpeed`: 30 → "30 s/s"; 59.4 → "59.4 s/s"; 60 → "1 min/s"; 720 → "12 min/s"; 3600 → "1 h/s"; 21_600 → "6 h/s"; 86_400 → "1 d/s".

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/format.test.ts`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement `src/ui/format.ts`**

Per the Interfaces block. Shared `trim1(x)` helper for the 1-decimal/".0"-trim. Keep under 80 lines.

- [ ] **Step 4: Run tests + gate**

Run: `npx vitest run test/format.test.ts && npm test && npm run typecheck && npm run build`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add src/ui/format.ts test/format.test.ts
git commit -m "feat: timeline display format helpers (dates, bytes, speed labels)"
```

---

### Task 13: Timeline bar (dates, ticks, pins, play, speed, Mark) + HUD date clock

**Files:**
- Modify: `src/ui/timeline.ts`, `src/ui/hud.ts`, `src/style.css`
- Test: none (DOM — browser-verified by the owner, repo convention)

**Interfaces:**
- Consumes: `formatBytes`-free format fns from Task 12 (`formatRangeLabel`, `formatSelectedTime`, `formatReplayClock`, `dayTicks`, `formatSpeed`); `Pin` from `src/data/ws.ts` (Task 9); `SPEED_DEFAULT`, `SPEED_SLIDER_MAX`, `speedFromSlider`, `sliderFromSpeed`, `MIN_PIN_MS` from `shared/limits.ts` (Task 2)
- Produces (exact — Task 15 consumes):

```ts
export interface TimelineApi {
  setRange: (from: number | null, to: number | null) => void;
  setLive: () => void;
  setPins: (pins: Pin[]) => void;
  setPlaying: (playing: boolean) => void;  // play button ▶/⏸ + .active
  setCursor: (t: number) => void;          // programmatic thumb position (no input event)
}
export function createTimeline(root: HTMLElement, opts: {
  seek: (t: number) => void;
  goLive: () => void;
  play: () => void;                        // toggle play/pause
  speed: (s: number) => void;              // debounced 150 ms
  markAdd: (from: number, to: number) => void;
  markRemove: (id: string) => void;
  playAvailable?: boolean;                 // default true; false → play button disabled + title tooltip
}): TimelineApi;
```

DOM order (all inside `.timeline`): `rangeLbl` · `playBtn` (▶/⏸) · `speedWrap` (`<input type=range min=0 max=1000 step=1>` + label) · `trackWrap` (`.timeline-track` containing `overlay` (`pointer-events: none`, children: day-tick spans, pin segment spans, one preview span) + the scrubber input) · `selLbl` · `markBtn` ("Mark") · `liveBtn`. Pin/tick geometry is **percentage-based** (`left: x%`, `width: y%`) so no resize handling is needed.

Behavior contract:
- `setRange`: labels via `formatRangeLabel` (existing "no history yet" + `.disabled` behavior kept); slider min/max/step as today; re-render day ticks (`dayTicks` — only when the span crosses a local day); re-render existing pins; the not-rewound reposition-to-`to` behavior is kept.
- `selLbl` while rewound: `formatSelectedTime(t)` (always dated).
- `setPins(pins)`: one span per pin — `left = (pin.from − from)/(to − from) × 100 %`, `width = (pin.to − pin.from)/(to − from) × 100 %`, each clamped into [0, 100].
- Speed slider: initial `value = sliderFromSpeed(SPEED_DEFAULT)`; label `formatSpeed(speedFromSlider(v))`; 150 ms debounce → `opts.speed(s)`.
- **Mark mode**: `markBtn` toggles `.active` + `.marking` on `.timeline-track` (crosshair). While marking, scrubber `mousedown` → `preventDefault()` (blocks native drag) + record start time (offsetX → time, clamped to [from, to]) + save pre-gesture slider value; `mousemove` → position preview span (amber, 60 % opacity); `mouseup` → span ≥ `MIN_PIN_MS` → `opts.markAdd(min, max)` (rounded to whole seconds); otherwise a click → if the start point falls inside a rendered pin segment → `opts.markRemove(id)`, else nothing; restore the pre-gesture slider value. The existing `input`-event scrub handler is **suppressed while marking**.
- Existing scrub (150 ms debounce → `opts.seek`) and LIVE button unchanged otherwise.
- HUD (`src/ui/hud.ts`): `setReplay(t)` clock text = `formatReplayClock(t)` (replaces the bare `toLocaleTimeString`; `.replay` amber class unchanged).
- CSS (`src/style.css`, following the existing pill/panel conventions): `.timeline-track` (relative, flex:1), `.timeline-overlay` (absolute, track-height band, `pointer-events: none`), `.timeline-tick` (1×4 px, muted `--border` family), `.timeline-pin` (amber `#ffb300`, 35 % opacity), `.timeline-pin-preview` (60 %), `.timeline-play`, `.timeline-speed` (80–100 px slider), `.timeline-mark` (+ `.active` amber), `.timeline-track.marking` (crosshair), widened `.timeline-sel` min-width (~90 px for the dated readout).

- [ ] **Step 1: Implement `src/ui/timeline.ts` per the contract**

Extend the existing file in place (keep the `TimelineApi` return object; the existing 150 ms debounce and LIVE behavior are preserved).

- [ ] **Step 2: Update `src/ui/hud.ts` + `src/style.css`**

`setReplay` uses `formatReplayClock`; add the new CSS rules.

- [ ] **Step 3: Gate**

Run: `npm test && npm run typecheck && npm run build`
Expected: all pass (no new unit tests — DOM is browser-verified in Task 16).

- [ ] **Step 4: Commit**

```bash
git add src/ui/timeline.ts src/ui/hud.ts src/style.css
git commit -m "feat: timeline bar — date readouts, day ticks, pin spans, play/speed controls, Mark mode"
```

---

### Task 14: Settings drawer

**Files:**
- Create: `src/ui/settings.ts`
- Modify: `src/style.css`
- Test: none (DOM — browser-verified in Task 16)

**Interfaces:**
- Consumes: `formatBytes` (Task 12); `Pin` (Task 9)
- Produces (exact — Task 15 consumes):

```ts
export interface SettingsStats {
  storageCapGb: number;
  ramCacheGb: number;
  cacheUsedBytes: number;
  usedBytes: number;
  pinnedBytes: number;
  pins: Pin[];
}
export interface SettingsApi { setStats: (s: SettingsStats) => void }
export function createSettings(root: HTMLElement, opts: {
  update: (patch: { storageCapGb?: number; ramCacheGb?: number }) => void;
  removePin: (id: string) => void;
}): SettingsApi;
```

DOM: `<aside class="drawer drawer-settings">` — `left: 12px; bottom: 60px; top: auto; width: 260px` (bottom-left, opposite corner from the filter drawer, above the timeline bar). Same skeleton as the filter drawer: `.drawer-head` (⚙ + "Settings" + chevron; click **or** Enter/Space toggles `.collapsed`; `aria-expanded`; persisted to `localStorage` key `radar.settingsCollapsed`; **default collapsed**). Body, one section (`.settings-group` header "Timeline"):
- Storage cap row: label + `<input type="number" min="0.5" max="1000" step="0.5">` + "GB"; live line `using 9.2 GB (pinned 0.4 GB)` from `usedBytes`/`pinnedBytes`; warning line (only when `usedBytes > storageCapGb × GB`): `⚠ pinned data exceeds cap by X GB` with `.warn`.
- Snapshot cache row: label + `<input type="range" min="0" max="16" step="1">` + value label (`"off"` at 0, else `"N GB"`); live line `holding 312 MB` from `cacheUsedBytes`.
- Pinned ranges: one row per pin `MMM d HH:mm – HH:mm` (local, via the same `format.ts` building blocks) + `×` button → `opts.removePin(id)`; "(none)" when empty.

Behavior: number input → **500 ms debounce** → `opts.update({ storageCapGb: v })` (only when finite and different from the current value); range input → 500 ms debounce → `opts.update({ ramCacheGb: v })`. `setStats`: update input values **unless that input is `document.activeElement`** (never yank a focused field), update live lines + pin list. The body is section-based so future options are new `.settings-group` blocks with no structural change.

- [ ] **Step 1: Implement `src/ui/settings.ts` per the contract**

- [ ] **Step 2: Add CSS** (`.drawer-settings` placement override + `.settings-group`, `.settings-row`, `.settings-line`, `.settings-pins`, `.settings-pin-row`, reusing `.warn`).

- [ ] **Step 3: Gate**

Run: `npm test && npm run typecheck && npm run build`
Expected: all pass.

- [ ] **Step 4: Commit**

```bash
git add src/ui/settings.ts src/style.css
git commit -m "feat: settings drawer (storage cap, RAM cache, pinned ranges)"
```

---

### Task 15: Client integration (coalesced refresh + main.ts wiring + WS integration tests)

**Files:**
- Create: `src/data/coalesce.ts`, `test/coalesce.test.ts`
- Modify: `src/main.ts`, `src/map/layers.ts`, `test/integration.test.ts`

**Interfaces:**
- Consumes: Tasks 9, 10, 11, 12, 13, 14 (their exact APIs)
- Produces:

```ts
// src/data/coalesce.ts
export function createCoalescedRun(run: () => void | Promise<void>, schedule?: (cb: () => void) => void): { request: () => void; flush: () => void };
// schedule defaults to requestAnimationFrame (injected in tests). request() marks dirty + schedules at most ONE
// run per scheduled frame (latest wins); a run already in flight + a new request → exactly one more run after it
// completes. flush() runs immediately (single-flight: flush while running just marks dirty).
// src/map/layers.ts
export function setPlaybackMode(map: maplibregl.Map, on: boolean): void;
// map.setLayoutProperty("craft-labels", "text-ignore-placement", on); no-op when the layer is absent.
// (sublabels already have text-ignore-placement: true — labels stay VISIBLE during playback, just uncrowded.)
```

`main.ts` wiring contract:
1. **Coalesced refresh**: `const refreshRun = createCoalescedRun(refresh)`; replace `store.subscribe(() => { void refresh(); })` with `store.subscribe(() => refreshRun.request())`; the initial `void refresh()` in the `map.load` flow stays. `refresh()` additionally records `lastRegistered` (the `ensure()` result set) in a closure var for playback frames.
2. **Meta from status**: closure vars `metaSnapshotMs = 60000`, `metaStaleMs = 120000`, `histFrom: number | null = null`, `histTo: number | null = null`, `lastStats: SettingsStats` (defaults), `lastSeekT: number | null = null` — updated in `onStatus` (`s.history.snapshotMs ?? 60000`, `s.staleMs ?? 120000`, `s.history.from/to`, and `lastStats` from `s.settings`/`s.history.usedBytes|pinnedBytes`/`s.pins ?? []` → `settingsUi.setStats(lastStats)`).
3. **Engine + pool** (created in the `map.load` flow, after the socket): `const pool = decodeSupported() ? createDecodePool() : null;` `createPlaybackEngine({ snapshotMs: () => metaSnapshotMs, staleMs: () => metaStaleMs, historyFrom: () => histFrom, historyTo: () => histTo, requestWindow: (r) => socket?.sendTimelineWindow(r.seq, r.from, r.to, r.stride, r.maxBytes), decode: pool ? (b) => pool.decode(b) : Promise.reject(new Error("decode unsupported")), onFrame, onState, now: () => performance.now() })`. `onState`: `timeline.setPlaying(s === "playing" || s === "buffering")`; start the rAF loop when entering playing/buffering (loop: `engine.tick(performance.now())`; keep requesting frames while state is playing/buffering, else stop). `feed` is wired via the socket handler `onWindowChunk: (c) => engine.feed(c)`.
4. **`onFrame`** (`lastPlayFrame = new Map(crafts.map(c => [c.id, c]))`): `setCraftData(map, buildFeatureCollection(crafts, lastRegistered !== undefined ? { iconRegistered: lastRegistered } : undefined))`; `timeline.setCursor(t)`; HUD `setReplay(t)` throttled to 250 ms; counts (`hud.setCounts` + `filters?.setCounts`) throttled to 500 ms; selected panel row updated from `lastPlayFrame` (when the selected craft is present) in the same 500 ms window — the store is intentionally NOT touched by playback frames.
5. **Timeline opts**: `play: () => { if (engine.state === "playing" || engine.state === "buffering") engine.pause(); else { if (histTo == null) return; replay.enterReplay(); setPlaybackMode(map, true); const t0 = engine.state === "paused" ? engine.cursor : lastSeekT ?? histTo; engine.start(t0); } }`; `speed: (s) => engine.setSpeed(s)`; `markAdd: (f, t) => socket?.sendPinAdd(f, t)`; `markRemove: (id) => socket?.sendPinRemove(id)`; `playAvailable: pool != null`. The existing `seek` closure prepends `if (engine.state !== "idle") { engine.stop(); setPlaybackMode(map, false); }` and sets `lastSeekT = t`; the `goLive` closure prepends the same stop. `onTimelineState`: `lastSeekT = time` when non-null; the `time === null` path also stops the engine + `setPlaybackMode(map, false)`. `onConnection("open")` while rewound: existing exit + engine stop + render mode off.
6. **Pins/status**: `onPins: (pins) => { timeline.setPins(pins); lastStats.pins = pins; settingsUi.setStats(lastStats); }`; `settingsUi = createSettings(appEl, { update: (p) => socket?.sendSettingsUpdate(p), removePin: (id) => socket?.sendPinRemove(id) })` created with the other UI.
7. **Clicks while playing**: `const craft = lastPlayFrame?.get(id) ?? store.get(id);` in the `craft-icons` click handler.

`test/integration.test.ts` extensions (follow the existing timeline e2e test's pattern — real `HistoryRecorder` on a temp dir with fake `now`, `buildApp` with explicit deps; pass `settingsFile`/`pinFile` inside the same temp dir):
1. **Pins over WS**: record 2 snapshots; `pin.add` with an **inverted** range inside the recorded span → `pins` reply with 1 pin, normalized (`from < to`) (Review Focus #1 end-to-end); the next `status` frame carries `pins` length 1; `pin.remove(id)` → `pins` reply `[]`; next `status` `pins` `[]`.
2. **settings.update echo + clamp (Review Focus #2's server behavior)**: send `{type: "settings.update", patch: {storageCapGb: 0.0001, ramCacheGb: 99}}` → a `status` with `settings.storageCapGb === 0.5` and `settings.ramCacheGb === 16`; the `settingsFile` on disk contains the clamped values.
3. **timeline.window streaming**: recorder with 4 snapshots (fake `now` += 1000 ms each); `timeline.window {seq: 1, from: t0, to: t3, stride: 1, maxBytes: <≈ one snapshot's gz size>}` → ≥ 2 chunk frames, last one `done: true`, items' `b64` gunzip (node:zlib in the test) back to the recorded crafts, `reachedTo` = last item ts; then `stride: 2` with a big `maxBytes` → items only at `t0`, `t2`.

- [ ] **Step 1: Write the failing coalesce test `test/coalesce.test.ts`**

Fake scheduler (manual queue, `run()` helper):
1. 3 `request()`s before any scheduled frame runs → exactly ONE `run` invocation when the frame fires.
2. A `run` in flight (async, pending) + `request()` → after it settles, exactly one more run.
3. `flush()` with nothing pending → runs immediately; `flush()` while a run is in flight → no second immediate run, but one more after settle (dirty flag).

- [ ] **Step 2: Run to verify it fails, implement `src/data/coalesce.ts`**

Run: `npx vitest run test/coalesce.test.ts` → FAIL, then implement (~40 lines) → PASS.

- [ ] **Step 3: Implement `setPlaybackMode` in `src/map/layers.ts`** (3-line function + export).

- [ ] **Step 4: Wire `src/main.ts` per the wiring contract above**

- [ ] **Step 5: Write the integration tests (the 3 blocks above) and make them pass**

Run: `npx vitest run test/integration.test.ts`
Expected: new tests pass; existing integration tests untouched and green.

- [ ] **Step 6: Full gate**

Run: `npm test && npm run typecheck && npm run build`
Expected: all pass.

- [ ] **Step 7: Commit**

```bash
git add src/data/coalesce.ts test/coalesce.test.ts src/main.ts src/map/layers.ts test/integration.test.ts
git commit -m "feat: client integration — coalesced refresh, playback wiring, pins/settings plumbing"
```

---

### Task 16: Final gate, browser verification, push

**Files:** none (verification only)

- [ ] **Step 1: Full gate (clean tree)**

Run: `npm test && npm run typecheck && npm run build`
Expected: 398 + new tests pass; typecheck clean; build succeeds (maplibre chunk warning accepted).

- [ ] **Step 2: Browser verification pass (owner, `npm run dev`)** — checklist to walk through together:
  1. Timeline bar shows **dates** in the range label + dated selected readout; day ticks visible (history spans days on this machine).
  2. Settings drawer (bottom-left, collapsed by default): open → cap input + RAM slider changes echo back (status) and survive a server restart (`data/settings.json` content matches); `data/history/pins.json` appears after first pin.
  3. **Mark mode**: drag on the track → amber span appears; listed in the drawer; lower the storage cap below what's pinned → pinned range survives on disk (spot-check `ls data/history`), overshoot warning shows; delete the pin → files become evictable.
  4. **Playback**: scrub to a point → `▶` at 1 h/s → smooth lerp motion; raise the slider to 1 d/s → fast scrub/montage without freezing or server stall (watch `npm run dev` logs); `⏸` holds; LIVE returns; scrubbing mid-playback pauses; HUD clock shows the date while replaying a past day.
  5. Labels stay **visible** (may overlap) during playback; restored after LIVE.
  6. Scrub performance: rapid back-and-forth scrubs over the recent window are instant (RAM cache working — settings drawer "holding …" line grows).

- [ ] **Step 3: Commit + push**

```bash
git add -A
git commit -m "feat: timeline modernization — date/time, settings menu, pinned ranges, playback"  # only if Step 2 left loose changes
git push
```

If push fails with `Permission denied (publickey)`: ask the user to run `ssh-add ~/.ssh/id_rsa`, then re-push. (Per AGENTS.md, finished work is committed AND pushed.)

