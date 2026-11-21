# Flight context implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** FR24-style flight context — merged recorded+OpenSky past trails with a credit-guarded refresh loop, dep/arr routes via adsbdb with a fallback ladder, offline airport resolution, and geodesic predicted paths on the map.

**Architecture:** Three new server services (`airports`, `routes`, `tracks`) behind two new seq-guarded WS frame pairs that mirror `aircraft.info`; a pure `shared/geo.ts` math module; client draws two new line layers + panel chips and owns the refresh scheduler (visibility/rewind-aware).

**Tech Stack:** TypeScript, Fastify + ws, vanilla-DOM UI, MapLibre GL, Vitest (node env), OpenSky OAuth2 (existing token provider), adsbdb (plain fetch).

**Spec:** `docs/superpowers/specs/2026-11-21-flight-context-design.md`

## Global constraints

- No new npm packages. Comments minimal; never reference tickets/tasks in comments.
- Gate after every task: `npm test` → `npm run typecheck` → `npm run build` (maplibre >500 kB chunk warning is the accepted exception).
- `/states` credits untouched (R1): new OpenSky calls use `/tracks/all` and `/flights/all` only.
- Daily track ledger: auto cap 300, hard cap 800 (R2); persisted `data/tracks/ledger.json`.
- Refresh cadence is exactly `clamp(pollMs / 2, 30_000, 300_000)`; client sends nothing while panel closed, tab hidden, or rewound (R3).
- adsbdb: descriptive plain browser-like UA, ≤1 req/s limiter, positive cache 24 h / negative 1 h persisted; OpenSky est-airport fallback only when flights-bucket remaining ≥ 200 (from response headers).
- `airports.dat` pinned single-file download (URL+sha256 constants), first-start into `data/airports/`, init never throws (R5).
- New WS frames require ALL four mirrors: `server/hub.ts` (`ClientMessage` + `parseClientMessage`), `server/index.ts` switch, `src/data/ws.ts` (`RadarMessage`/`parseRadarMessage`/send method/handler), `src/main.ts` wiring.
- Never re-record fixtures casually; new fixtures are recorded real responses saved byte-for-byte, lowercase hyphen names.

## Review Focus

1. Rapid selection changes (click A→B→C) with replies arriving out of order → only the newest selection's data renders; superseded seq replies dropped (Task 5 pins the server echo in tests; the client drop lives in `main.ts` — tsc-covered, browser-verified per the R6 checklist).
2. Selected craft disappears from the store (landed/swept) while its panel trail is open → `path: []`/`route: null` echo, trail persists until deselect, no console error (Task 5).
3. Track timestamps from two clocks (HistoryRecorder receive-time vs OpenSky server time) merged 10-s-bucket-ascending, no NaN/future entries (Task 4).
4. Daily ledger across UTC midnight rollover and corrupt-file states → reset cleanly, never blocks below cap (Task 4).
5. Great-circle paths crossing the antimeridian (e.g. ANC→HND) → continuous longitudes so MapLibre draws the short way, not across the whole world (Task 1 unwrap, Task 6 renders it).

---

### Task 1: Shared geo math (`shared/geo.ts`)

**Files:**
- Create: `shared/geo.ts`
- Test: `test/geo.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces from `shared/geo.js`:
  `type LonLat = { lon: number; lat: number }`
  `haversineMeters(a: LonLat, b: LonLat): number`
  `greatCircle(a: LonLat, b: LonLat, points?: number): LonLat[]` — default 64; `a` deep-equal `b` → `[a]`; endpoints EXACT (no float drift); longitudes continuous (each step adjusts by the shortest delta, so a dateline crossing yields |lon| growing past 180, never a >180° jump between consecutive points).
  `destinationPoint(from: LonLat, bearingDeg: number, meters: number): LonLat`
  `initialBearingDeg(a: LonLat, b: LonLat): number`
  `etaMs(from: LonLat, to: LonLat, speedKnots: number | null | undefined, now: number): number | null` — null/≤0 speed → null.
- Note: `Craft.speed` is KNOTS — etaMs takes knots (convert internally, MS constant local).

- [ ] **Step 1: Write failing tests** `test/geo.test.ts`: haversine known pairs (JFK→LHR ≈ 5540 km ±1%, same point 0); greatCircle endpoint exactness + `points` count + a==b single + ANC(149.99,-149.9)… use (lon -149.9, lat 61.17) → HND (139.78, 50.31): max consecutive |Δlon| < 30 and longitudes monotonic across the dateline (Review Focus 5); destinationPoint north/east quadrants (from (0,0) bearing 0/90 within 1 m at 100 km); etaMs null cases + 500 km @ 450 kt ≈ 2000 s + now.
- [ ] **Step 2: Run** `npx vitest run test/geo.test.ts` — fail (module missing).
- [ ] **Step 3: Implement** pure functions (radians local helpers; greatCircle = spherical slerp on unit vectors with shortest-delta longitude unwrapping; bearings normalized 0–360).
- [ ] **Step 4: Run tests** — pass. Full gate.
- [ ] **Step 5: Commit** `git add shared/geo.ts test/geo.test.ts && git commit -m "feat(shared): great-circle/eta geo helpers"`

### Task 2: Airports loader (`server/airports.ts`)

**Files:**
- Create: `server/airports.ts`
- Test: `test/airports.test.ts`

**Interfaces:**
- Consumes: nothing new (module-local pinned constants + injectable seams).
- Produces from `server/airports.js`:
  `interface Airport { icao: string | null; iata: string | null; name: string; city: string | null; country: string | null; lat: number; lon: number }`
  `interface Airports { init(): Promise<void>; lookup(code: string): Airport | null; status(): { loaded: boolean; count: number; lastError: string | null } }`
  `createAirports(opts: { dir: string; fetchImpl?: typeof fetch; log?: (m: string) => void; url?: string; sha256?: string }): Airports`
  — defaults: OpenFlights GitHub-raw `airports.dat` + its sha256 (compute once with `shasum -a 256` against the fetched file and hardcode; record both in the constant comment as the pin).
  Keys the Map by ICAO and IATA uppercased; ICAO collisions → first wins, IATA-vs-ICAO collision → ICAO wins. Parses the CSV quoting style already used in `server/faa.ts` (`parseCsv`-equivalent; import it if exported, else a 6-line local split honoring quoted fields). Rows kept where field 10 (`type`-ish per research columns `…,type,source`) is blank or airport-like — pin the exact filter by inspecting real values in the test fixture. `init()` never throws: download/parse failure → empty map + `lastError`. Writes `data/airports/ATTRIBUTION.md` (ODbL line + URL) alongside the file at download time. Re-download only when the file is missing (sha-verify on read of existing file is NOT required — one-time pin).

- [ ] **Step 1: Record fixture** — `curl -sL <pinned-url> -o test/fixtures/airports-sample.dat` then TRUNCATE the real file's head? No: fixtures must be byte-for-byte real — instead keep a small REAL slice: `head -c 4000` then trim to the last full line (record in the test comment that it is a head-slice of the pinned file). Plus one hand-noted constant set of expected lookups from that slice.
- [ ] **Step 2: Write failing tests**: init-from-existing-file (fixture copied into tmp dir named `airports.dat`) → lookup by ICAO and by IATA, miss → null, lowercase/padded lookup normalizes; missing file + stubbed fetchImpl → downloaded (asserts sha match using the fixture's real sha) + attribution file written; corrupt/404 fetch → `status().loaded false`, `lastError` set, no throw; empty-map lookups → null.
- [ ] **Step 3: Run** — fail. **Step 4: Implement** (download into `<dir>/airports.dat.tmp` → verify → rename; parse per above). **Step 5: Run tests** — pass; full gate.
- [ ] **Step 6: Commit** `git commit -am "feat(server): pinned offline airports.dat loader"`

### Task 3: Routes service (`server/routes.ts`)

**Files:**
- Create: `server/routes.ts`
- Test: `test/routes.test.ts`, fixtures `test/fixtures/adsbdb-callsign-jbu2064.json`, `test/fixtures/adsbdb-unknown.json`, `test/fixtures/opensky-flights-all.json` (recorded real responses, byte-for-byte; the OpenSky one from `/flights/all` narrowed to ≤30 min, trimmed to a head slice ending on a full JSON array item if >200 KB — record the trim rule in the test comment)
- Modify: nothing else (wired in Task 5)

**Interfaces:**
- Consumes: `Airports` (Task 2) via opts; `TokenProvider` shape from `server/opensky-auth.js` for the fallback.
- Produces from `server/routes.js`:
  `interface AirportRef { code: string; icao: string | null; iata: string | null; name: string | null; city: string | null; country: string | null; lat: number | null; lon: number | null }`
  `interface FlightRoute { airline: string | null; dep: AirportRef | null; arr: AirportRef | null; source: "adsbdb" | "opensky" }`
  `interface RoutesService { get(craft: { id: string; callsign?: string }): Promise<FlightRoute | null>; stop(): void }`
  `createRoutes(opts: { cacheFile: string; airports: Airports; tokenProvider?: TokenProvider; flightsAllUrl?: string; fetchImpl?: typeof fetch; now?: () => number; log?: (m: string) => void; positiveTtlMs?; negativeTtlMs? }): RoutesService`
  Behavior (spec §C): normalize callsign (trim + uppercase only — no zero-strip); empty callsign → null immediately; adsbdb GET `https://api.adsbdb.com/v0/callsign/{cs}` UA `RadarLocalApp/1.0 (personal radar; contact via local app)` timeout 5 s; map `response.flightroute.origin/destination` (+`airline.name`) → AirportRefs, resolving via `airports.lookup` for anything adsbdb didn't carry (coords/name); 404/non-200/timeout → negative-cache 1 h; 429 → negative-cache 5 min. Fallback when adsbdb missed: only if `tokenProvider` AND flights-remaining ≥ 200 (track `x-rate-limit-remaining` from ANY flights-bucket response, default 4000 until first seen): GET `/flights/all?begin&end` = [now−30 min, now] (authed, 401-invalidate-retry-once like opensky.ts), newest record matching `icao24` (case-insensitive) else callsign, `estDeparture/ArrivalAirport` → airports.lookup → `source:"opensky"`; both-miss → null (negative-cached). Cache: `Record<callsign, { foundAt: number; negative?: boolean; route?: FlightRoute }>`, load-at-boot (absent file fine), write-through tmp+rename every set (faa-lookup pattern), corrupt → reset + log once. Limiter: internal 1 s spacing queue (fake-timer-testable via `now`). No `stop()`: persistence is write-through, nothing to flush.

- [ ] **Step 1: Write failing tests** (fixture-backed `fetchImpl` stubs + fake `now`): adsbdb hit maps dep/arr + airline; hit → second call serves cache (fetch called once); negative TTL (61 min later retries with fake timers); 429 → 5-min negative; miss + provider + remaining ok → opensky fallback maps est* codes through airports, `source:"opensky"`, and a second call for the same callsign does NOT re-hit adsbdb (negative still fresh) NOR opensky (positive cached); remaining < 200 → no fallback call; limiter: 2 immediate gets → second waits 1 s (fake timers, no real sleep); corrupt cache file → loads empty, logs.
- [ ] **Step 2: Run** — fail. **Step 3: Implement.** **Step 4: Run** — pass; full gate.
- [ ] **Step 5: Commit** `git commit -am "feat(server): routes service — adsbdb + opensky fallback ladder"`

### Task 4: `trackFor` + TracksService (`server/history.ts`, `server/tracks.ts`)

**Files:**
- Modify: `server/history.ts` (new method only)
- Create: `server/tracks.ts`
- Test: `test/history.test.ts` (append), `test/tracks.test.ts`

**Interfaces:**
- Consumes: `HistoryRecorder` internals (index, cache, `now`); `TokenProvider`; Task 1 nothing.
- Produces:
  On HistoryRecorder: `trackFor(icao24: string, hours: number): Promise<{ t: number; lat: number; lon: number; alt: number | null; onGround: boolean }[]>` — ascending; scans snapshots in `[now − min(hours,24)*3600e3, now]`, gunzips each (cache-first like `seek`), picks `id === icao24` (exact store id), maps `{t: snapshot.ts, lat, lon, alt: altitude ?? null, onGround: onGround ?? false}`; 60 s memo per icao24 (Map with expiry via `now`); read-only (no index/cache mutation beyond cache reads); missing snapshots mid-range skipped (deletion-safe).
  From `server/tracks.js`:
  `interface TrackPoint { t: number; lat: number; lon: number; alt: number | null; onGround: boolean }`
  `interface TrackReply { path: TrackPoint[]; fetchedAt: number; source: "both" | "history" | "opensky" | "none"; budget: { autoLeft: number; hard: boolean } }`
  `interface TracksService { get(icao24: string, auto: boolean): Promise<TrackReply> }`
  `createTracks(opts: { recorder?: HistoryRecorder | null; tokenProvider?: TokenProvider; ledgerFile: string; fetchImpl?: typeof fetch; now?: () => number; log?: (m: string) => void; tracksAllUrl?: string; cacheMs?: number; autoDailyCap?: number; hardDailyCap?: number }): TracksService`
  — defaults `tracksAllUrl` OpenSky `/tracks/all`, `cacheMs 10_000`, caps 300/800 (export them as named constants).
  Merge (spec §D): history first then OpenSky into a `Map<floor(t/1000), TrackPoint>` (OpenSky overwrites), values sorted ascending; drop entries with non-finite lat/lon. OpenSky call: `?icao24={hex}&time=0`, authed when provider present (401-invalidate-retry-once), timeout 10 s, response `data[0].path` → `[time, lat, baro_altitude?, ... ]` per docs shape `[time, lat, lon, baro_alt, true_track, on_ground]` — pin the exact index map from the recorded fixture. Per-icao24 10 s in-memory cache. Ledger: `{ day: "YYYY-MM-DD", count: number }` UTC-day-keyed, load-at-boot corrupt→reset+log, count BEFORE the call, auto request over `autoDailyCap` → serve cache (any age) + `budget.autoLeft: 0` without calling; ALL requests over `hardDailyCap` → same but also `budget.hard: true`; `autoLeft = max(0, autoDailyCap − count)`. Errors: OpenSky failure → history-only source (or `"none"` when both empty), never throws.

- [ ] **Step 1: Write failing history tests**: record 3 snapshots with a plane id, `trackFor` returns ascending 3 with alt/onGround mapped; absent craft → `[]`; memo: second call adds no file read (spy via injected `log` count or cache-hit observable by mutating the underlying file then re-calling within 60 s → stale); `hours` cap: 48 h of data, `hours=24` → only last-day points.
- [ ] **Step 2: Run** `npx vitest run test/history.test.ts` — fail. **Step 3: Implement trackFor.**
- [ ] **Step 4: Write failing tracks tests** (stub fetchImpl serving recorded `/tracks/all` fixture; fake `now`): merge dedups near-identical timestamps (OpenSky wins), ascending; recorder-null → source "opensky"; OpenSky 500 → source "history"; 10 s cache (two gets one call, then advance 11 s → call); ledger: 299 auto calls ok, 300th refused auto but manual (`auto:false`) allowed, 800th hard-refused; midnight rollover resets; corrupt ledger resets.
- [ ] **Step 5: Run** — fail. **Step 6: Implement createTracks.** Run — pass; full gate.
- [ ] **Step 7: Commit** `git commit -am "feat(server): merged history+opensky tracks with daily ledger guard"`

### Task 5: Wire protocol + handlers

**Files:**
- Modify: `server/hub.ts` (ClientMessage union + parseClientMessage branches)
- Modify: `server/index.ts` (deps construction + two switch cases)
- Modify: `src/data/ws.ts` (types, parse, sendFlightTrack/sendFlightContext, handlers)
- Test: `test/integration.test.ts` (append)

**Interfaces:**
- Consumes: `createAirports/createRoutes/createTracks` (Tasks 2–4).
- Produces: server frames `{type:"flight.track", id, seq?, path, fetchedAt, source, budget}` and `{type:"flight.context", id, seq?, route}`; client senders `sendFlightTrack(id: string, seq: number, auto: boolean)`, `sendFlightContext(id: string, seq: number)`; handler opts `onFlightTrack?(id, reply)` / `onFlightContext?(id, route)` (`reply: TrackReply`-shaped). Client `RadarMessage` union gains both.
- Frames are `aircraft.info`-shaped: `{type:"flight.track", id: string, seq?: number, auto?: boolean}` and `{type:"flight.context", id: string, seq?: number}` — `auto` default true when undefined; `seq` optional non-negative int passthrough (echoed).
- index.ts: construct `airports` + `routes` + `tracks` in buildApp beside `faaLookup` (data dirs `data/airports`, `data/routes/cache.json`, `data/tracks/ledger.json`; `airports.init()` fire-and-forget like iconPack init, log errors); handlers resolve craft from `store.get(msg.id)`, callsign from `store` — craft absent → `path: []` / `route: null` immediately (Review Focus 2); `aircraft.info`'s shape is the model (async IIFE + `reply`). Domain guard: sea ids → same empty echo. Track handler passes `auto` and lowercased id.

- [ ] **Step 1: Write failing integration tests** (boot pattern per existing aircraft.info test; stub tracks/routes services? NO — pass real `createTracks`/`createRoutes` with stubbed fetchImpl via new ServerDeps fields? Do NOT add deps fields: construct real services and let their internal fetch fail → sources degrade to history/none — deterministic). Tests: `flight.track` for unknown id → `{path: [], source: "none", budget}` echo with seq 7 echoed; `flight.context` unknown → `route: null`, seq echoed; malformed frames (id missing / seq string) → dropped silently (no crash, no reply); real recorded craft in a seeded recorder + store → track reply includes its history path (recorder boot pattern from existing timeline tests).
- [ ] **Step 2: Run** — fail. **Step 3: Implement** the four mirrors (client `src/data/ws.ts` in this task too, since types/tests touch both). **Step 4: Run tests** — pass; full gate (typecheck enforces the client union/handler mirror).
- [ ] **Step 5: Commit** `git commit -am "feat(ws): flight.track + flight.context frames"`

### Task 6: Track layers (`src/map/trackLayers.ts`)

**Files:**
- Create: `src/map/trackLayers.ts`
- Test: `test/track-layers.test.ts` (style-validation extension pattern)
- Modify: `src/map/layers.ts` ONLY if the style-validation test needs a shared registration point (it doesn't — track layers register at map init from main.ts in Task 7; keep this file standalone)

**Interfaces:**
- Consumes: `shared/geo.js` `greatCircle`/`destinationPoint`/`LonLat`; maplibre types.
- Produces from `src/map/trackLayers.js`:
  `TRACK_SOURCES = ["flight-trail", "flight-predicted", "flight-dest"]` (source ids === layer ids)
  `addTrackLayers(map): void` — idempotent; three geojson sources (empty FeatureCollection) + layers: `flight-trail` line, `paint: { "line-color": ["get","color"], "line-width": 2, "line-opacity": 0.9 }`; `flight-predicted` line, dashed (`"line-dasharray": [2, 2]`), `#80cbc4`, width 2; `flight-dest` symbol, `text-field` from feature `name`, font `CRAFT_TEXT_FONT`, `text-offset [0,1]`, `text-color "#e0e0e0"` (glyphs already in both basemaps). Layers inserted BELOW `craft-icons` (or `craft-labels` when present) so icons stay on top.
  `setTrailData(map, path: {lat,lon}[], color: string): void` (single LineString feature, `color` property) / `clearTrailData(map)`
  `setPredictedData(map, coords: LonLat[] | null)` / `clearPredicted(map)`
  `setDestMarker(map, dest: { name: string } & LonLat | null)` / `clearDestMarker(map)`
- Style-validation test extends `test/style-validation.test.ts`'s validator usage: build the same basemap-independent style object the test already assembles, append the three track layer defs via an exported `trackLayerDefs(): LayerSpecification[]` (pure) consumed by `addTrackLayers` — validate clean (mirror the existing craft-layer validation).

- [ ] **Step 1: Write failing test** (pure defs validate; `trackLayerDefs()` returns 3 with ids/below-order — assert paint keys).
- [ ] **Step 2: Fail → Step 3: implement → Step 4: pass; full gate.** (Browser placement/eyecandy is R6-user; the shim can't render — same convention as icons.)
- [ ] **Step 5: Commit** `git commit -am "feat(map): flight trail/predicted/destination layers"`

### Task 7: Client wiring — selection, refresh loop, panel chips

**Files:**
- Modify: `src/main.ts`, `src/ui/panel.ts`, `src/data/ws.ts` (handler wiring already typed; wire in main)
- Test: `test/panel.test.ts` (extend), `test/main-wiring.test.ts` NOT created (main stays test-exempt; tsc + browser checklist)

**Interfaces:**
- Consumes: Tasks 5–6 exports; `status.feeds.opensky.pollMs`; existing selection/`lastPlayFrame`; `CRAFT_KIND_COLORS` (or the kind→color map actually used by `features.ts` — grep and reuse it, do NOT invent a second palette).
- Produces: panel opts gains `onDestClick?: (dest: { name: string; lat: number; lon: number }) => void` and `showContext(id, route)` / `showTrack(id, budget)`-style callbacks (exact names the panel implementer defines in this task's test; keep the `setInfo` idiom: ignore unless `selected.id === id`); panel renders dep/arr chip row from `FlightRoute`-shaped data (import type from `server/routes.js`? NO — client-side mirror type in `src/data/ws.ts` like `AircraftInfo`; Task 5 already defines the client shape).

Behavior (spec §F):
- On panel `show` of an AIR craft: send `flight.context` (new seq) + first `flight.track` (auto). Track refresh interval recreated per selection and per pollMs change; `document.visibilitychange` → pause (clear) / resume (immediate + interval); rewind mode (existing `lastPlayFrame` gate) → suppress sends AND slice displayed path to `t <= cursor`; LIVE → restore full.
- Trail: `setTrailData` with the selected kind's color from the shared palette; predicted: route.arr (coords) → `greatCircle(current, arr)`; else `destinationPoint(current, heading ?? lastHeading, speed×1200)` 20-min stub when heading present; recomputed on each `update` tick for the selected craft (FR24-follows-the-aircraft).
- Panel chips: `IATA · city` labels; arr chip with coords → `onDestClick` → main calls `setDestMarker` + `map.flyTo` (padding so the panel doesn't cover it). `budget.autoLeft === 0` → panel note row; `route: null` → "no route data" row. Manual refresh button in the trail section sends `auto:false`.
- Selection change/close: bump seq, clear all three track sources.
- AGENTS.md: extend the `ui/` and `data/` one-liners + WS protocol block with the two new frames (mirror the existing terse shape), `server/` line gains airports/routes/tracks services, status: note `budget` (no new HUD item).

- [ ] **Step 1: Write failing panel tests** (existing shim pattern): route renders dep+arr chips with codes; null route → "no route data"; budget note row on autoLeft 0; arr chip click fires onDestClick with coords; `showContext` for non-selected id ignored.
- [ ] **Step 2: Fail → Step 3: implement panel + main wiring → Step 4: tests pass; full gate.**
- [ ] **Step 5: Update AGENTS.md; commit** `git commit -am "feat(client): flight context panel chips + credit-guarded trail refresh"`
- [ ] **Step 6: Hand the user the R6 manual checklist** (spec Testing/manual list).
