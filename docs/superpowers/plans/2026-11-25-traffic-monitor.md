# traffic monitor + feed-surface honesty implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A live, honest traffic graph (Radar-server + Radar-browser + whole-device + top-processes) docked beside the settings drawer, plus three feed-surface honesty fixes (AIS tile outlines, no-key hint, boost-paused tooltip).

**Architecture:** `server/traffic.ts` is a pure-first monitor (counters, UTC-day persistence, `netstat -ib`/`nettop -P` parsers via the iconpack.ts `execFile` idiom); index.ts wraps every WAN egress with a one-line `count()`, streams 1 Hz `traffic` frames only to watchers, and exposes composed AIS boxes on the secondary status block; the browser contributes WAN-down via a pure resource-timing harvest deduped by name+startTime; the panel is a canvas two-liner (device gray behind, Radar accent) in user's band layout.

**Tech Stack:** TypeScript, Node child_process (execFile), Canvas 2D, Vitest (node env).

**Spec:** `docs/superpowers/specs/2026-11-25-traffic-monitor-design.md` (R1–R8, rulings 1–6).

## Global constraints

- Counting wraps egress, never restructures fetch control flow (no URL/order/status behavior changes — wave-7 R1 discipline).
- All arithmetic/parsers pure and exported; subprocess + timers injectable (iconpack `git()` runner is the execFile template: `execFile(cmd, args, {maxBuffer}, cb)`).
- `netstat`/`nettop` failures (non-mac, restricted) degrade: device series + `top` null, Radar series unaffected (ruling 4).
- Server→client frames need an explicit `else if` arm in ws.ts `open()` BEFORE the terminal `timeline.state` else (ws.ts:310) — applies to `traffic`.
- AIS socket bytes are INFLATED payload (permessage-deflate) — documented caveat, honest under-count on the wire (note it in code comment + AGENTS.md).
- `git clone` pack downloads are uncapturable at Node level — device series covers them; note in AGENTS.md.
- No new npm packages. Comments minimal. Gate every task: `npm test` → `npm run typecheck` → `npm run build`. Existing test files append-only.

## Review Focus

1. Egress wrapping preserves fetch behavior at every touched site; the `res.json()`→`text()+JSON.parse` conversions (opensky readStates, routes ×2, tracks, opensky-auth) parse identically incl. the malformed-body throw paths. — Task 2.
2. Watcher lifecycle: watcher set membership per socket, cleaned on close (hub attach/route close), broadcast only while non-empty, no broadcast after stop(). — Task 2.
3. Browser harvest: same-origin excluded; dedupe key (name+startTime) cannot double-count across reports; per-entry bytes `transferSize || 0` only (2026-11-25 ruling: the draft's encodedBodySize fallback would inflate cache hits; buffer managed via setResourceTimingBufferSize(SEEN_CAP) + bufferfull clear). — Task 3.
4. Panel math: 10-min ring buffer wrap, humanized units, watch re-send on socket reopen (ais.tile idiom), collapse persisted, canvas DPR-correct sizing. — Task 4.
5. `secondary.boxes` shape stable (`[[minLat,minLon],[maxLat,maxLon]][]`, ≤2, recomputed from `aisHome()`/`aisFollow` at status time — single source); outline layer draws exactly those rects; nulls clear. — Task 2 + Task 5.
6. Park button disabled state derives from server truth (`secondary.enabled`), never from key presence heuristics client-side. — Task 5.

---

### Task 1: Traffic monitor core (`server/traffic.ts`)

**Files:** Create `server/traffic.ts`; Test `test/traffic.test.ts` (new).

**Interfaces:**
```ts
export interface TrafficSample {
  at: number;
  radar: { up: number; down: number; upTotal: number; downTotal: number };   // rates bytes/s since last sample; totals today+browser-folded
  device: { up: number; down: number; upTotal: number; downTotal: number } | null; // null until first netstat ok; rate 0 while spawn failing
  top: { proc: string; bytes: number }[] | null;                              // 5 s cadence, null on any parse fail
}
export interface TrafficMonitorOpts {
  now?: () => number; spawnImpl?: (cmd: string, args: string[]) => Promise<string>; // default execFile-based (netstat -ib / nettop -P -L 1 -x -J bytes_in,bytes_out)
  dir: string;                      // dataBase/traffic
  log?: (msg: string) => void;
}
export function createTrafficMonitor(opts: TrafficMonitorOpts): {
  count(dir: "in" | "out", bytes: number): void;      // radar-server counters (sync, cheap)
  addBrowserDown(bytes: number): void;                // folded into radar down (rate + today total)
  sample(): TrafficSample;                            // advances internal last-sample bookkeeping; 1 Hz assumed
  watch(on: boolean): void;                           // watcher COUNT inc/dec (never below 0)
  watchers(): number;
  start(): void; stop(): void;                        // sample() is driven by index's 1 Hz interval; start() = day-load + netstat seed; stop() idempotent
};
// netstat rule (controller ruling): sum ibytes/obytes over rows whose interface
// name starts with "en" AND whose flags column is the EXTENDED form (contains
// IBYTES) — exactly one row per physical interface; lo0 and duplicate rows
// excluded by construction. Pinned against the recorded fixture.
export function parseNetstat(out: string): { in: number; out: number } | null;
export function parseNettop(out: string): { proc: string; in: number; out: number }[] | null;
export function topDelta(prev: Map<string, number>, next: { proc: string; in: number; out: number }[], n: number): { top: { proc: string; bytes: number }[]; seen: Map<string, number> };
export function dayStamp(nowMs: number): string;  // YYYY-MM-DD UTC
```
Persistence: `day.json` `{day, radarUp, radarDown, devUp, devDown}` written on every sample (write-tmp+rename like faa cache); rollover: previous day appended to `history.json` (cap 30 entries). Counter-wrap/negative device delta → 0 + throttled log (once/10 min). Spawn concurrency: at most one in-flight netstat and one nettop; overlap → skip that tick.

- [ ] **Step 1: failing tests** — counters (incl. non-finite/negative ignored); sample rates from two ticks; browser-fold; day rollover + persistence round-trip + history cap; parseNetstat/parseNettop on RECORDED real-format fixtures (create by running both commands yourself, save under `test/fixtures/` — repo convention); topDelta N-cap + proc-name truncation; negative-delta zeroing; watcher count never negative; degrade (spawn rejects → device null / rates 0, radar fine).
- [ ] **Step 2: implement → pass; full gate.**
- [ ] **Step 3: Commit** `feat(server): traffic monitor core`

### Task 2: Egress counting + wire + status boxes

**Files:** Modify `server/index.ts`, `server/hub.ts`, `server/opensky.ts`, `server/opensky-auth.ts`, `server/faa.ts`, `server/faa-lookup.ts`, `server/routes.ts`, `server/tracks.ts`, `server/airports.ts`, `server/iconpack.ts`, `server/ais.ts`; Tests: `test/hub.test.ts`, `test/traffic.test.ts` (append integration), existing feed tests (append-only).

**Interfaces:** `ServerDeps.traffic?: TrafficMonitor`; buildApp creates one (`deps.traffic ?? createTrafficMonitor({ dir: dataBase/traffic })`), start() with the pollers, stop() included. `count()` one-liners at survey sites: opensky readStates (json→text+parse), auth token (json→text), faa L281 buf.length, faa-lookup ×2 (text vars), routes ×2 + tracks (json→text+parse), airports L111, iconpack fetchFile L125, ais ws.on message (`Buffer.byteLength(data.toString())` — inflated caveat comment). Client frames: hub union `traffic.watch {on:boolean}` + `traffic.report {down:number}` (finite, ≥0, ≤50 MB) with validator matrix tests; index switch: watch → monitor.watch + per-socket Set (close cleanup at the existing /ws close idiom), report → monitor.addBrowserDown; 1 Hz `setInterval` (unref'd, cleared in stop()) broadcasting `{type:"traffic", ...monitor.sample()}` to watchers only. Status: `secondary.boxes` = `composeTiles(aisHome(), aisFollow).map(boxEdges)` (helper `boxEdges` returning `[[minLat,minLon],[maxLat,maxLon]]`; [] when aiscast disabled) — mirror in hub.ts FeedStatus + ws.ts mirror.

- [ ] **Step 1: failing tests** — validator matrix ×2 frames; watcher set lifecycle via real WS (connect→watch→sample arrives→disconnect→broadcast count drops); report clamp; egress counting through EXISTING feed tests' stub fetches (one append per feed asserting monitor counted plausible byte sizes — no byte-exact pins beyond fixtures); `secondary.boxes` present [] disabled / 2 entries with stubbed follow+home; json→text conversions: malformed-body tests still pass UNMODIFIED (proves identical throw behavior) — if any existing test asserted `.json()` call counts, flag not edit.
- [ ] **Step 2: implement → pass; full gate.**
- [ ] **Step 3: Commit** `feat(server): traffic counting, watch-gated frames, AIS boxes in status`

### Task 3: Browser harvest + client wire mirror

**Files:** Create `src/data/browser-tx.ts`; Modify `src/data/ws.ts`, `src/main.ts`; Tests: `test/browser-tx.test.ts` (new), `test/ws.test.ts` (append).

**Interfaces:** `createBrowserTx({ now?, getEntries?, send: (down:number)=>void, intervalMs? = 5000 }): { start(), stop() }` — harvest: entries where `entry.name` origin ≠ page origin (skip localhost/same-origin) and initiatorType not "other"-filtered? NO — count all cross-origin resource entries (tiles are xmlhttprequest/fetch/img); dedupe LRU of `name|startTime` keys cap 5000; per-entry bytes = `transferSize || 0` (2026-11-25 ruling: encodedBodySize fallback superseded — cache hits would inflate; exact-or-0 per spec); send deltas > 0 via `sendTrafficReport`. ws.ts: `sendTrafficWatch(on)` + `sendTrafficReport(down)` (ais.tile sender idiom); `RadarMessage` += traffic frame; `parseRadarMessage` gate (at, radar/device shapes); explicit `else if` arm + `onTraffic?` handler member. main.ts: construct on socket open, start after first open (survives reconnect by keeping one instance; send closure resolves current socket like other senders); stop not needed (page lifecycle).

- [ ] **Step 1: failing tests** — harvest same-origin skip, cross-origin bytes with both fallbacks, dedupe across two harvests (same entries don't double), LRU eviction re-count tolerated (document), zero-delta silent; ws validator matrix + frame method wire bytes.
- [ ] **Step 2: implement → pass; full gate.**
- [ ] **Step 3: Commit** `feat(client): browser WAN-down harvest + traffic frames`

### Task 4: Traffic panel (`src/ui/traffic.ts`)

**Files:** Create `src/ui/traffic.ts`; Modify `src/main.ts`, `src/style.css`; Tests: `test/traffic-panel.test.ts` (new, FakeEl + canvas stub idiom from existing canvas-less UI tests — canvas 2d context stubbed via a fake getContext returning no-op recorder).

**Interfaces:** `createTrafficPanel(root: HTMLElement, opts: { watch: (on: boolean) => void; collapsed?: boolean; now?: () => number }): { update(sample: TrafficSample): void; destroy(): void }`. Docking: `#app` child, absolute, LEFT side beside settings drawer (`left: 284px; bottom: 60px;` — drawer is 260 px + 12 gap at left:12 per survey; pin CSS), `.drawer`-family styling, collapsed = header-only at drawer-header height (~38 px rule pinned in style.css matching `.drawer-head`), persisted `radar.trafficPanel` ("0"/"1", absent = collapsed). Expanded: header "Traffic", top band `↑ device · radar` lines with per-line rate + today total, bottom band `↓` same, right column session+today totals, top-3 process rows when present; canvas 2-line graph (device rgba gray, radar accent `var(--accent)`),
ring buffer pinned 600 points = 10 min at the 1 Hz sample; ResizeObserver +
DPR backing store. `update()` from main's `onTraffic`. Watch lifecycle: expand → `watch(true)`; collapse → `watch(false)`; expanded-at-boot sends watch on every socket open (reopen re-send Set like zonesCfg — keep a `watched` flag, re-`opts.watch(watched)` on open via main wiring).

- [ ] **Step 1: failing tests** — collapse persist/restore; watch fire matrix (expand, collapse, reopen-while-expanded); ring buffer wrap at 600; humanizer (999 B/1.5 KB/2.3 MB/1.02 GB — exact strings pinned); top-3 truncation + null-top renders nothing; update before expand cheap (buffer fills regardless of visibility? pin: buffer only fills while update called — main always forwards, panel just skips drawing).
- [ ] **Step 2: implement → pass; full gate.**
- [ ] **Step 3: Commit** `feat(client): traffic panel docked beside settings`

### Task 5: Honesty fixes + docs

**Files:** Create `src/map/aisTiles.ts`; Modify `src/main.ts`, `src/ui/settings.ts`, `src/ui/hud.ts`, `src/style.css`, `AGENTS.md`; Tests: `test/style-validation.test.ts` (both arrays += ais-tile defs), `test/ais-tiles.test.ts` (new), `test/settings-drawer.test.ts` (append), `test/hud.test.ts` (append).

- `setAisTileBoxes(map, boxes: number[][] | null)` — line layer `ais-tile-outline`, dashed `#4fc3f7`, 1.5 px, from `[[minLat,minLon],[maxLat,maxLon]]` closed rings; empty/null → empty FC; insert below `craft-icons` (after hotzone — above it); idempotent add like hotzone. main onStatus:
`setAisTileBoxes(map, s.feeds?.ais?.secondary?.boxes ?? null)` — boxes live in
the secondary block; server sends `boxes: []` when `enabled === false`, so
disabled state clears the layer straight from status.
- settings.ts: `SettingsStats += secondaryEnabled?: boolean`; park button `disabled = secondaryEnabled === false` with text swap "Needs AISCAST_API_KEY" (restore on true); setStats re-render. main passes it from status.
- hud.ts: paused boost segment gets `title="Slow the Aircraft-poll slider to fund zone polling"` (attribute only; legacy line byte-identical).
- AGENTS.md: traffic monitor block (server + panel + frames), AIS boxes status field + outline layer, park-button hint, counting caveats (inflated AIS bytes, git clones device-only), test counts.

- [ ] **Step 1: failing tests** — layer defs validate both basemaps; box geometry (closed 5-ring, both corners); null/[] clears; enabled=false → server `boxes: []` renders empty (status-driven, no client heuristics); park disabled/text round-trip on secondaryEnabled flip; hud tooltip present on paused, absent otherwise.
- [ ] **Step 2: implement → pass; full gate.**
- [ ] **Step 3: Commit** `feat: AIS tile outlines, no-key hint, boost tooltip, traffic docs`
- [ ] **Step 4: Manual checklist (user):** graph appears docked, moves with device traffic (open a video elsewhere → gray line jumps); Radar line spikes on FAA refresh; AIS park (with key) → two blue dashed rectangles; no key → button says Needs AISCAST_API_KEY; boost paused hover tooltip.
