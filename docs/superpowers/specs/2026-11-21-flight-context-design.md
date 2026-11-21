# Flight context — FR24-style past/predicted paths + route info — design

Date: 2026-11-21 · Status: draft for user review
Papertrail: `ML_Docs/2026Nov20-1.md` · Wave 5 of the Nov-20 review package.
Research (binding findings): `ML_Docs/research/flight-routes.md` · Memory #49/#50.

## Problem

Clicking an aircraft shows identity (FAA panel) but nothing about *where it is
going or where it came from*. FR24 shows a past trail, a predicted continuation
and dep/arr airports; the user approved building the free-tier equivalent:
OpenSky `/tracks/*` for the live trail (a separate 4,000-credit/day bucket,
verified available to our client), adsbdb for callsign→route, bundled
OpenFlights `airports.dat` for airport resolution, great-circle math for
prediction, and — the free win no external app has — our *own*
`HistoryRecorder`, which draws the recorded part of the trail at zero API
cost.

## Rulings (user-approved 2026-11-21)

1. Trail auto-refresh = `clamp(pollMs / 2, 30 s, 300 s)` (`pollMs` = current
   OpenSky poll interval from `status.feeds.opensky.pollMs`), while and only
   while the panel visibly shows that flight; hard credit guards (R2).
2. Trail merges our recorded history + the OpenSky live track; prediction is
   geodesic-to-destination, heading stub otherwise. No paid schedule data.
3. Route ladder: adsbdb → OpenSky `/flights/all` est-airports → none (honest
   "—"; GA/military normally have no route — FR24 behaves the same).
4. No new third-party runtime dependency: one optional free HTTP source
   (adsbdb), fully cached; all else is OpenSky (already a dep) + vendored data.

## Requirements

- R1 — `/states` credits untouched: all new OpenSky calls are `/tracks/*` or
  `/flights/*` bucket; the states poller never gains a call.
- R2 — Track auto-refresh cannot exhaust the tracks bucket: server-side daily
  ledger caps *auto* fetches at 300 (1,200 credits) and all fetches at 800
  (3,200 credits); past-auto-cap replies serve cache with a budget note; the
  states buckets are independent (verified in research).
- R3 — Client sends zero track requests while the panel is closed, the tab is
  hidden (`document.hidden`), or the timeline is rewound.
- R4 — Everything degrades: adsbdb down → ladder; OpenSky tracks 429/expired
  → recorded-history trail alone; airports file absent → codes without names;
  no route → heading stub + "no route data". The app never logs the user out
  of a working map because context failed.
- R5 — Offline-first (spec R10, memory #30): `airports.dat` downloads once at
  first start into gitignored `data/airports/` (pinned URL + sha256, icon-pack
  pattern); nothing else downloads ever at runtime except the on-demand,
  cached adsbdb/OpenSky calls.
- R6 — No new npm packages; UI lines sit under craft icons; new wire frames
  mirror the existing `aircraft.info` round-trip shape (seq echo per seek-
  pattern, `info:null` = none).
- R7 — Gate green (tests, tsc, build); browser-only surfaces (line rendering,
  chips, fly-to) verified by user (R6-of-wave-4 convention).

## Design

### A. Shared geo (`shared/geo.ts`) — pure, Node-tested

```ts
export function haversineMeters(a: LonLat, b: LonLat): number
export function greatCircle(a: LonLat, b: LonLat, points = 64): LonLat[]
  // slerp interpolation; >= 2 points; a===b → [a]
export function destinationPoint(from: LonLat, bearingDeg: number, meters: number): LonLat
export function etaMs(from: LonLat, to: LonLat, speedMs: number | null, now: number): number | null
  // null speed/0 → null; distance/speed + now
```

### B. Airports (`server/airports.ts`)

`initAirports(dataDir, log)` — icon-pack download pattern: pinned
`airports.dat` (OpenFlights GitHub raw; sha256 in a constant; ODbL attribution
line written to `data/airports/ATTRIBUTION.md`), parses to
`Map<string, Airport>` keyed by both ICAO and IATA (ICAO wins collisions;
type filtered to airport-ish rows), never throws (failure → empty map +
`lastError`). `lookup(code)` trims/uppercases. Loaded in `buildApp` before
handlers; the panel never queries it directly — the server embeds resolved
airport records into responses.

### C. Routes (`server/routes.ts`)

`RoutesService.get(callsign)` → `{ airline?, dep?: AirportRef, arr?: AirportRef, source: "adsbdb"|"opensky" } | null`
- callsign normalize: trim + uppercase, strip zero-padding? **No** (B001Q is
  real); exact trimmed token.
- adsbdb `GET api.adsbdb.com/v0/callsign/{cs}` with descriptive UA (memory
  #46 lesson: plain browser-ish UA, nothing custom-flaggable), token-bucket
  limiter 1 req/s, on 429/4xx negative-cache, timeouts 5 s.
- Positive cache 24 h, negative 1 h, persisted `data/routes/cache.json`
  (faa-lookup `enrichment.json` pattern: hex/callsign key → record + ts;
  load-at-boot, debounced save).
- Fallback (only when adsbdb misses AND `flightsAll` available): OpenSky
  `GET /flights/all?begin&end` ≤ 30-min window (4 credits, *flights* bucket),
  match `icao24` else callsign, take `estDeparture/ArrivalAirport`, resolve
  via airports; cache the result like adsbdb. Guard: skip fallback when
  flights-bucket remaining < 200 (track from response headers).
- `AirportRef = { code, icao, iata?, name, city?, country?, lat, lon }` —
  server resolves names/coords (adsbdb response carries them; est-codes via
  the airports map) so the client needs no airport lookup.

### D. Tracks (`server/tracks.ts`)

`TracksService.get(icao24)` → `{ path: TrackPoint[], fetchedAt, source: "both"|"history"|"opensky", budget: { autoLeft: number, hard: boolean } }`
- `TrackPoint = { t, lat, lon, alt?, onGround? }`, ascending `t`.
- Sources: (1) `HistoryRecorder.trackFor(icao24, hours)` — new method:
  iterate snapshots newest-back over `[now−hours, now]`, pick the entry for
  `icao24`, collect `(snapshot.ts, lat, lon, baroAltitude, onGround)`. Zero
  API cost, but each snapshot is a full gzip read, so `hours` defaults to and
  caps at **24** — long enough for any real flight's trail and ~1,440 reads
  worst case (the same full-file scan `window()` already performs); results
  memoized per icao24 for 60 s.
  (2) OpenSky `GET /tracks/all?icao24={hex}&time=0` via the existing token
  provider (4 credits, *tracks* bucket; 10 s in-memory cache).
- Merge: seed map keyed `floor(t/1000)`, history first, OpenSky overwrites;
  return sorted array. Server clock is authoritative for both (history ts is
  server-receive time; OpenSky ts is server-side) — no client-clock traps.
- Ledger (`data/tracks/ledger.json`): count per UTC day; auto fetches
  (`request.auto !== false`) refused past 300/day, all refused past 800/day —
  refusal returns cache/stale with `budget` fields telling the client why.
- 429 handling: honor `retry-after` when present; the request fails and the
  client keeps its last path — the ledger, not the response, is the daily
  guard.

### E. Wire protocol (`shared/craft.ts` frames + `server/index.ts` handlers)

```
client → { type:"flight.track",   id, seq?, auto?: boolean }   // auto=false = manual
server → { type:"flight.track",   id, seq?, path, fetchedAt, source, budget }
client → { type:"flight.context", id, seq? }
server → { type:"flight.context", id, seq?, route }            // route: null = none
```
- `id` is the craft id (hex); server 404s softly by echoing `path: []` /
  `route: null` for unknown craft (mirror `aircraft.info` miss).
- seq echo + client drop of superseded replies, identical to `timeline.seek`
  (client-side increment on selection change AND on each refresh wave).
- Server resolves the craft's current callsign per request from the store
  (never trust a client-sent callsign).

### F. Client (`src/main.ts` wiring, `src/ui/panel.ts`, `src/map/layers.ts`)

- Selection (air only) sends `flight.context` once + first `flight.track`
  (auto); a `setInterval` (re-created per selection and per pollMs change,
  cleared on close/hide/rewind) re-sends `{flight.track, auto:true}` at
  `clamp(pollMs/2, 30_000, 300_000)`; `visibilitychange` pause/resume;
  manual "refresh trail" button click sends `auto:false`.
- Layers (drawn under `craft-points`, above polygons): `flight-trail` line,
  solid 2 px, feature `color` property = the kind's icon color (reuse the
  color-keying from icon work); `flight-predicted` line, dashed 2 px,
  `#80cbc4`; `flight-dest` symbol+text (name label, existing glyphs) at the
  destination. GeoJSON source per layer, cleared on selection change.
- Predicted geometry computed CLIENT-side from current craft position +
  route `arr` (greatCircle via `shared/geo`), or heading stub (20 min) —
  recomputed on each update so the line tracks the aircraft (FR24 behavior).
- Panel: dep/arr chip row (`IATA · city` when known); clicking a chip with
  coords `flyTo`s and highlights the destination marker; `budget.autoLeft
  === 0` → note "trail auto-refresh paused (daily limit)"; route null →
  "no route data" row.
- Rewind: while rewound, no refreshes (R3) and the trail/prediction slice to
  `t <= cursor` locally; LIVE restores.

## Failure modes

- adsbdb 429/timeout → negative cache + ladder; ladder miss → `route: null`.
- OpenSky tracks 429 → request fails, client keeps last path (stale); panel
  note; next scheduled tick retries.
- Ledger file corrupt → reset counts (log once), same posture as enrichment.
- Airports map empty → codes render without names; est-fallback returns null.
- Selection churn (rapid clicks) → seq guard drops stale replies; single
  interval per selection.
- Craft vanishes mid-view → trail persists until selection closes/deselects
  (it is the *track*, not live state; matches FR24).

## Testing

- `test/geo.test.ts` — haversine known distances, great-circle endpoints +
  point count + a==b, destinationPoint quadrants, etaMs (null/zero speed).
- `test/routes.test.ts` — ladder order, cache TTLs (fake timers), negative
  cache, limiter (1/s), UA header present, fixtures for both sources.
- `test/tracks.test.ts` — merge/dedup (10 s buckets, OpenSky wins), ledger
  auto/hard caps + reset across UTC midnight, cache TTL, history-hours cap.
- `test/history.test.ts` — `trackFor` extraction (present/absent craft,
  hours bounds, rewind-safety: read-only).
- `test/integration.test.ts` — the four frames end-to-end against fixtures
  (unknown id, seq echo, budget fields).
- `test/style-validation.test.ts` — new layers validate with the style.
- Manual (user): trail+prediction on a long-haul with route; GA flight (no
  route, heading stub); refresh cadence follows poll slider; tab-hidden stop
  (Network tab); rewind slices trail; fly-to chip; offline: recorded-only
  trail still draws.

## Out of scope (backlog)

Smooth interpolated animation (Wave 8 — the trail renders positions as
recorded/reported; marker smoothing is its own wave); multi-aircraft trails;
trail export; VRS FlightRoutes DB supplement; vessel tracks; airway-level
predicted polylines (paid schedule data); clicking history to spawn a ghost
aircraft.
