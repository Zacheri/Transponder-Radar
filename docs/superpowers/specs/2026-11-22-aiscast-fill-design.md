# aiscast fill-source — second AIS client with aimed tiles — design

Date: 2026-11-22 · Status: draft for user review
Papertrail: `ML_Docs/2026Nov20-1.md` · Wave 6 of the Nov-20 review package.
Research (binding): `ML_Docs/research/ais-sources.md` · Memory #5, #50.

## Problem

aisstream.io is the only vessel feed: worldwide terrestrial with open-ocean and
regional gaps, no uptime guarantee. aiscast (`ais.openwaters.io`) aggregates
AISHub's ~50k-vessel feed plus Norwegian/Finnish government feeds and
volunteers, speaks the **aisstream.io WS protocol verbatim** (hostname swap,
token as `APIKey`), and is free self-serve — but beta and capped (2 streams,
50 msg/s, 20°×20° max area), so per the approved roadmap rulings it is a
**complement, never a replacement**.

## Rulings (user-approved 2026-11-22)

1. Tile strategy = **hybrid**: one 20° tile parked at a user-defined home
   region (default unset), one following the map viewport; two tiles total,
   within the free tier's 2-stream allowance (each tile is one subscribe box
   on one connection — if aiscast enforces 20°/stream strictly and rejects a
   2-box subscription on one connection, fall back to a second connection
   automatically; the client interface must allow both).
2. Home region is a **setting** (map-center "park" button), not an env var;
   the API key is an env var.
3. aiscast never replaces aisstream; aisstream's behavior is frozen
   (existing tests stay green untouched).
4. ≤1-min backward position jitter from the AISHub relay leg is accepted
   (~0.5 km at 15 kn); per-source freshness gating is backlog.
5. Attribution: rolling per-event attribution display in the HUD satisfies
   aiscast's ToS; no per-vessel attribution UI this wave.

## Requirements

- R1 — Zero regression risk to the aisstream path: parameterization only;
  the aisstream instance's subscribe JSON, deflate, ping/pong, backoff and
  flush behavior unchanged (its tests pass unmodified).
- R2 — aiscast disabled unless `AISCAST_API_KEY` set; disabled state is
  visible in status (`secondary.enabled:false`), not silent.
- R3 — ≤2 subscribe boxes on the aiscast connection at all times; box
  re-subscription debounced to ≥1.2 s (their etiquette: ≤1 update/s).
- R4 — Map never sees the token: browser → local server only (offline-first,
  memory #30); the client frame carries just the viewport center.
- R5 — Attribution visible whenever aiscast is delivering (HUD credit line),
  gone when it isn't; distinct-string rolling window, capped display.
- R6 — One bad source cannot hurt the other: independent clients,
  independent reconnect ladders, shared store upserts only.
- R7 — No new npm packages. Gate green (tests, tsc, build). Browser surfaces
  (HUD line, park button, fill coverage) user-verified.

## Design

### A. `AisStreamClient` (refactor of `server/ais.ts`)

Extract the existing class as `AisStreamClient` with opts `{ name, url?, key?,
buildSubscribe(ctx), onMessage(msg, sourceTag), statusTag, log }`, preserving
the existing `wsImpl`/URL-override seams. The exported `AisClient` becomes
`createAisStream(opts)`-compatible with the current API surface so index.ts,
hub wiring and all existing tests compile and pass unmodified (R1). The two
instantiations:

- `aisstream`: today's URL/key/subscription (global bbox) — behavior frozen.
- `aiscast`: url `wss://ais.openwaters.io/v0/stream`, key =
  `config.aiscastApiKey`, subscription boxes from the tile policy (B);
  messages flow through the SAME normalize→store upsert path the aisstream
  handler uses (source tag recorded per message for attribution only).

Config: `AISCAST_API_KEY` in `server/config.ts` + `.env.example` (empty).

### B. Tile policy (pure module `server/ais-tiles.ts`)

```ts
interface Tile { lat: number; lon: number }            // 20° box CENTER
composeTiles(home: {lat,lon}|null, follow: {lat,lon}|null): Tile[]  // max 2, dedup when equal
clampCenter(c: {lat,lon}): Tile                        // lat/lon clamped so the 20° box is valid
toBoundingBoxes(tiles: Tile[]): [[number,number],[number,number]][] // aisstream JSON shape
```

Pure, unit-tested; the aiscast subscription builder calls it;
`boxes.length <= 2` asserted at build (throw in dev, log+truncate at runtime).

### C. Viewport frame + subscription refresh

```
client → { type:"ais.tile", lat: number, lon: number }   // viewport center, debounced
```
- New `ClientMessage` branch + `parseClientMessage` (finite lat/lon check) +
  index.ts handler: `aiscastTiles.setFollow({lat,lon})` on the aiscast
  client (no-op when disabled). No reply frame (fire-and-forget, like
  feed.rate).
- The aiscast client owns resubscribe: follow-center change → debounce 1.2 s
  → recompose boxes → if set changed, send replacement subscribe frame on the
  open connection (protocol replaces on update); rate-limited internally so
  two sources of churn can't exceed one update/second (R3).
- Client sends `ais.tile` from the map `moveend` handler in `src/main.ts`
  (debounced 1 s), only while
  `status.feeds.ais.secondary?.enabled === true` (the client gates on the
  real status field, E).
- Connection-vs-2-streams fallback (Ruling 1): if a 2-box subscribe is
  rejected (close or SubscriptionConfirmation with <2 boxes), the client logs
  and retries with the follow box alone (parked tile waits until follow
  leaves it — the parked tile is the LESS favored of the two under rejection,
  since following is the interactive value).

### D. Settings — home region

`homeRegion: {lat,lon} | null` added to the settings frame/validator
(`settings.update` patch) and the persisted settings file. UI in the
existing settings drawer: button "Park AIS fill tile here" (applies current
map center via `map.getCenter()`) and a clear control; value round-trips
through `sendSettingsUpdate`. index.ts's settings handler forwards to
`aiscastTiles.setHome(...)` alongside persistence.

### E. Attribution + status

- aiscast client keeps `attributions: Map<string, number>` (string → last
  seen); pruned older than 5 min; strings come off every event's
  `attribution` field (falling back to `source`/`license` when absent — pin
  exact field names from the recorded fixture).
- `status.feeds.ais.secondary = { enabled, connected, lastError,
  attributions: string[] }` (last 3 by recency + `+N` count computed client
  side). Hub status assembly gains the nested block; HUD: when
  `secondary.enabled && secondary.connected`, credit line under the AIS
  status: `AIS fill: AISHub · NLOD…  (+2)`.
- Existing HUD `AIS: …` line untouched (R1).

### F. Client wiring (`src/main.ts`, HUD, settings drawer)

- `moveend` → 1 s debounce → `sendAisTile(center)` (new `ws.ts` sender).
- Status handler feeds the HUD credit line + settings-drawer controls
  (park button posts `settings.update {homeRegion}`, clear posts null).
- Rewind mode: irrelevant (server keeps feeding the store exactly as
  aisstream does today — replay gate already suppresses client updates).

## Failure modes

- No key → secondary disabled at construction; status says so (R2); zero
  network.
- aiscast 401/close-loop → own backoff ladder; aisstream unaffected (R6);
  `lastError` surfaced.
- Token valid but subscription refused → follow-only fallback (C), logged.
- Home region NaN/garbage → validator rejects frame/patch (existing pattern:
  frame dropped, settings patch ignored).
- Attribution absent on events → credit line shows source tags instead;
  never blank-renders.
- aiscast quiet (no events 3 min) → stale semantics unchanged (shared sweep);
  attribution window prunes the line away (R5).

## Testing

- `test/ais-tiles.test.ts` — compose/dedup/clamp/bbox shape, max-2.
- `test/ais.test.ts` (existing, must stay green untouched = R1 gate) + new
  cases: parameterized client (name/url/subscribe builder called), 1.2 s
  resubscribe debounce + rate cap (fake timers), 2-box-rejection fallback,
  attribution rolling/pruning, disabled-without-key.
- `test/integration.test.ts` — `ais.tile` frame → (stubbed) subscribe
  replacement observable; `settings.update homeRegion` round-trip +
  validation drops; status secondary block shape; aisstream-only boot
  unchanged.
- `src/ui` shim tests: park button posts the right patch; HUD credit line
  render/absent rules.
- Manual (user): park a home tile over a thin region, watch fill-sourced
  vessels + attribution line; kill key → disabled status; pan → tile
  follows (server log).

## Out of scope (backlog)

BarentsWatch poller; AISHub receive API; RTL-SDR ingest; per-source
freshness gating (jitter); per-vessel attribution in the panel; native
aiscast `/v1` protocol and REST; msg/s burst shaping; tile strategy beyond
hybrid (e.g. multi-tile viewport chains on the feeder tier); NOAA bulk
historical layer.
