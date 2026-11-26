# Wave 10 — backlog harvest (2026-11-26)

Five backlog items harvested from waves 5/7/9, executed as three parallel,
file-partitioned SDD tasks. Gates per task: `npm test` → `npm run typecheck`
→ `npm run build`.

## Task A — ETA row + geo/panel minors
Files: `src/ui/panel.ts`, `shared/geo.ts`, `server/tracks.ts`, tests.
1. ETA row in the flight panel: when a flight has a route destination
   (airport lat/lon from `flight.context`) and the craft is airborne with
   speed > 0, show `ETA ~HH:MM UTC` computed with `etaMs(dest, craftPos,
   speedMs, now)`; blank row when speed unknown. Local time (not UTC) for
   the label; use `etaMs` (currently zero callers).
2. `destinationPoint` asin clamp (lat-arg round-trip guard, one-liner + test).
3. `autoLeft` off-by-one display in the tracks budget note (`server/tracks.ts`
   budget computation — report first, then fix): after the day's 300th auto
   call the note must read `0`, not `-1`/`1` (pin the exact semantics in a test).

## Task B — second boost zone (hot-zone multi-cluster)
Files: `server/hotzones.ts`, `server/opensky.ts`, `server/index.ts`,
`server/hub.ts` (status copy), `src/main.ts` (hotzone paint only),
`src/map/hotzone.ts`, tests.
1. `planZone` → `planZones(craft, cfg, nowMs)` returning up to TWO zones:
   densest cluster first; the second zone is the densest remaining cluster
   whose box does NOT overlap the first (clusters are 2°-grid cells, so test
   box intersection; skip, don't split, at the antimeridian — same rule).
2. Poller: per-zone state (nextAt, errors, active); a zone poll is funded
   when surplus ≥ 1 credit remains after reserving for the OTHER zone's due
   poll and the globe reserve (same THE-RULE math, just two ledgers — zone 1
   funds first). A 429 pauses only that zone; pause reason shared.
3. Wire: replace status `hotzone` (object|null) with `hotzones`
   (array, ≤2, ordered). Ruling: local single-user app, both ends ship
   together — no legacy field kept (matches ais.tile precedent of no
   versioning).
4. Client: paint every zone rect (loop `status.hotzones ?? []`), keep the
   dominant-kind coloring per rect.
5. Update the spec's out-of-scope line (2026-11-22-hot-zone-boost-design.md
   §2/§173) to "delivered 2026-11-26".

## Task C — dateline unwrap + layout/a11y nits
Files: `src/map/trackLayers.ts`, `src/ui/traffic.ts` (+ test), `src/style.css`,
`src/ui/settings.ts` (focus attrs only), tests.
1. Recorded-trail dateline: recorded trail points pass raw ±180 longitudes,
   so a trans-Pacific flight draws across the whole map. Add a pure
   `unwrapLongitudes(path)` (per-step ±360 correction vs previous point,
   same algorithm as `greatCircle` unwrap) applied in the `flight-trail`
   data setter; predicted path already unwraps via slerp — leave it.
2. Narrow windows: below 540 px viewport width the traffic panel hides
   (`display:none` media rule). Ruling: this is a desktop tool; at 536+260+12
   px the two left overlays cannot coexist, and stacking vertically fights
   the bottom HUD.
3. Timeline track-edge 2 px clip of an end pin (style.css ~:139 area — the
   parked cosmetic from the wave-4 review; adjust padding/inset so a pin at
   0% or 100% is fully visible).
4. A11y pass (small, no aria-live — 1 Hz announcements are noise; ruling):
   traffic panel gets `role="complementary"` + `aria-label`, the graph
   `aria-hidden="true"` (numeric rows carry the same facts), top-process
   rows get `title="… bytes in the last 5 s"`, filter drawer buttons get
   `aria-pressed` where they toggle (check `filters.ts` existing attrs first;
   only add what's missing).

## Rulings
- Hot-zone second zone funds strictly after zone 1 (greedy, no starvation of
  coverage: the globe reserve already dominates the surplus).
- `hotzone` → `hotzones[]` breaking wire change accepted (no other clients).
- Narrow window hides the traffic panel rather than re-stacking overlays.
- No `aria-live` anywhere; static labels + titles carry the info.

## Not in this wave (still backlog)
Per-process traffic history dashboards, Linux `/proc/net/dev` adapter,
day.json write throttle, dashboards, drawer/panel at <540px beyond hiding.
