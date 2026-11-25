# Traffic monitor + feed-surface honesty — design

Date: 2026-11-25 · Status: draft for user review
Papertrail: `ML_Docs/2026Nov20-1.md` · Wave 9.

## Problem

The user saw 50 GB of device traffic in 4 days with no way to attribute it,
and three wave-6/7 surfaces silently no-op'd or looked like something else:
the aiscast park button does nothing without a key (never says so), the AIS
fill tiles have no visual at all, and a paused hot-zone boost doesn't say
why. This wave ships the user-specced live traffic graph (scope: Radar
own-bytes + whole-device counters + per-process breakdown) and the three
honesty fixes.

## Rulings (user-approved 2026-11-25 in-chat)

1. Scope 1 of the offered graph scopes: Radar-server + Radar-browser +
   Device (interface deltas) + per-process top-N — Radar and Device always
   separately visible.
2. Layout exactly as the user specced: upload speed+total top band, download
   speed+total bottom band, totals column on the side; docked next to the
   settings drawer at the drawer's collapsed height.
3. Streaming is watch-gated (`traffic.watch`) — zero traffic data when the
   panel is hidden.
4. Rootless only: `netstat -ib` + `nettop -P` subprocesses, no privileged
   anything, macOS-only extras degrade to Radar-only series elsewhere.
5. AIS fill tiles render as blue outline-only rectangles; the boost rect's
   red family stays unique.
6. Local server↔browser bytes are NOT traffic; only WAN edges count
   (server WAN counters + browser external-origin resource timing).

## Requirements

- R1 — Radar-server counters: every WAN response increments
  `{dir, bytes}` at the established egress points: OpenSky poller (incl.
  zone polls + auth), aisstream + aiscast socket bytes (received; they
  have no meaningful up), FAA bulk zip, per-click FAA lookup, adsbdb +
  OpenSky routes/tracks, icon-pack downloads, airports download, Carto
  probe. Counters must not change fetch semantics (wrap, don't restructure).
- R2 — Radar-browser counter: periodic (5 s) resource-timing harvest of
  external-origin entries (transferSize ?? encodedBodySize fallback) —
  these are browser WAN DOWNLOADS — sent up via `traffic.report`; server
  folds them into the radar DOWN series (dedupe repeated entries by
  entry name+startTime set).
- R3 — Device series: `netstat -ib` (first line, ibytes/obytes) polled 1 Hz,
  delta = device rate; wrap/negative-delta (counter reset) → treat as 0
  with log. `nettop -P -L 1 -x -J bytes_in,bytes_out` every 5 s, parsed to
  top-5 by delta bytes since previous sample (proc names truncated at
  first '.'), 30 s process cache bounded; parse failure → omit `top`
  (never kill the sample).
- R4 — Totals: per UTC day, persisted `data/traffic/day.json`
  `{day, radarUp, radarDown, devUp, devDown}` (browser bytes fold into
  radar totals; device totals come from counters). Session totals in
  memory. Day rollover: new day starts fresh; the previous day is kept in
  `data/traffic/history.json` appended (last 30 days).
- R5 — Frames: client→server `{type:"traffic.watch", on:boolean}`;
  client→server `{type:"traffic.report", down:number}` (delta WAN-down
  bytes since last report, finite ≥ 0, clamped ≤ 50 MB/report); server→client
  `{type:"traffic", at, radar:{up,down,upTotal,downTotal},
  device:{up,down,upTotal,downTotal}, top:[{proc,bytes}]|null}` at 1 Hz
  while any client watches. Additive validator idiom; hub union mirrors.
- R6 — Panel: right-docked beside the settings drawer, collapsed height
  matches the drawer's collapsed header; expand/collapse persisted
  `radar.trafficPanel`; while expanded, sends `traffic.watch true`,
  collapse/reconnect lifecycle mirrors the ais.tile sender (re-send on
  open); canvas two-line graph (device = thin translucent, radar = bold
  accent) over a 10-min ring buffer; bands/columns per ruling 2; numbers
  humanized (KB/MB/GB, /s).
- R7 — Honesty fixes: (a) AIS fill tile outlines (home + follow) as a
  dashed blue (kind-independent `#4fc3f7`-family line layer from
  `status.feeds.ais.secondary` tile info — server piggybacks
  `boxes:[{lat,lon}|null ×2]` on the secondary status block) inserted
  above hotzone layers, below `craft-icons`; (b) park button renders
  disabled with text "Needs AISCAST_API_KEY" while
  `status.feeds.ais.secondary.enabled === false` (server-sourced truth);
  (c) HUD boost-paused title tooltip: "Slow the Aircraft-poll slider to
  fund zone polling" (pure attribute add on the existing segment).
- R8 — No new npm packages; subprocess calls spawn-capped (one concurrent
  each, kill on shutdown, never block status tick); gate green.

## Design

### A. `server/traffic.ts`

`createTrafficMonitor({ now?, spawnImpl?, log?, dir }) → { count(dir:'in'|'out', bytes),
sample(): TrafficSample, watch(on:boolean): void, addBrowserBytes(n),
statusBlock() }`. All arithmetic pure where possible; the two subprocess
planners are exported pure functions (`parseNetstat(out) → {in, out}`,
`parseNettop(out) → rows`, `nettopTop(prev, next, 5) → top`). index.ts:
one shared monitor; poller/ais/faa/routes/iconpack/airports wrappers call
`count()` (single-line at each egress — enumerated in R1); status tick
1 Hz while watchers exist broadcasts `traffic` frames (own interval, not
the hub diff timer).

### B. Client monitor + panel

`src/ui/traffic.ts` — panel factory (drawer-adjacent), owns ring buffer +
canvas; `src/data/browser-tx.ts` — resource-timing harvest (`Harvest` pure
fn over a resource-entry list → delta WAN-down bytes; StorageLike-free;
5 s interval owned by main; skips entries already seen via a bounded name+
startTime LRU of 5000). WS mirrors both frames (hub + ws.ts + main switch).

### C. Honesty fixes

(a) `src/map/aisTiles.ts` — `setAisTileBoxes(map, boxes|null)` builds a
2-feature outline layer (line-dash, `#4fc3f7`), source registered lazily
by the same idiom as hotzone; `status.feeds.ais.secondary.boxes` added
server-side where `boxesFor` already computes them (wave 6 kept them in
the client-sent composition — expose the composed boxes on the secondary
status block, additive). (b) settings.ts park button: read the flag from
`setStats` input extension (`secondaryEnabled`), re-render on change.
(c) hud.ts: `feedsEl.title = ...` on the paused segment.

## Failure modes

- `netstat`/`nettop` missing/failing (non-macOS, restricted env): device
  series + top null; Radar series keep working (ruling 4 degrade).
- Interface counter reset (sleep/Wi-Fi flap): negative delta → 0, log once
  per 10 min; totals unaffected (totals only ever add positive deltas).
- Browser reports double-count risk (entries overlap reports): dedupe by
  name+startTime keys; entries missing transferSize (cross-origin without
  Timing-Allow-Origin — Carto's header status may vary) fall back to
  encodedBodySize, and if BOTH absent the entry counts 0 (honest
  undercount; documented on the panel as "browser tiles: exact or 0").
- Watcher leak (client tab crash): watcher state is per-socket; the hub's
  existing disconnect handling clears it, so streaming stops with the
  socket — no separate heartbeat needed.
- Panel resize: canvas backing store re-sized on container resize
  (ResizeObserver, DPR-aware).

## Testing

- `test/traffic.test.ts` — counters; day rollover + persistence; netstat/
  nettop parser fixtures (real-format recorded output); top-N delta logic;
  counter-reset handling; watch-gating (no interval without watchers).
- `test/browser-tx.test.ts` — harvest dedupe, fallback sizes, clamp.
- Frame validator matrix + status `secondary.boxes` additive shape.
- `test/ais-tiles-layer.test.ts` — defs pass validateStyleMin extension +
  setAisTileBoxes geometry (2 rects, null clears).
- settings-drawer append: disabled park button text/state per flag;
  hud append: paused tooltip.
- Manual (user): watch Radar's own line spike ~70 MB over one FAA refresh;
  open tiles-heavy zoom and see browser bytes; top-N names visibly explain
  device traffic; AIS park → blue outlines appear both tiles (needs key —
  user supplies `AISCAST_API_KEY` to see it live; no-key shows the hint).

## Out of scope (backlog)

Historical dashboards beyond 30-day totals; per-process history; non-macOS
device counters (Linux `/proc/net/dev` adapter); network usage alerts/
caps; per-craft bandwidth attribution; any 3D work (W10+).
