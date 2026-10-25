# AGENTS.md — Transponder Radar

Orientation for agents working in this repo. Full history: git log +
`docs/superpowers/specs/2026-09-27-transponder-map-design.md` (spec) and
`docs/superpowers/plans/2026-09-27-transponder-map.md` (plan, incl. Scope Round 2).

## What this is

Local, single-user web app: live world map of **aircraft** (OpenSky ADS-B) and
**vessels** (aisstream.io AIS) on a dark MapLibre GL map, with per-kind icons,
click-to-open detail panel (FAA type/year/owner for US-registered aircraft),
model-driven aircraft shape-family icons (see Aircraft icons below),
kind filter drawer, live aircraft poll-rate slider, timeline rewind, and a
status HUD.

## Commands

| Command | Purpose |
|---|---|
| `npm run dev` | Backend `:2001` (tsx watch) + Vite `:1738` (proxies `/ws`, `/health`) |
| `npm test` | Vitest, `test/**/*.test.ts` — **gate: all pass** |
| `npm run typecheck` | `tsc --noEmit` — **gate: clean** |
| `npm run build` | Vite build — **gate: succeeds** (maplibre-gl >500 kB chunk warning is an accepted exception) |
| `npm start` | Prod: serves `dist/` + API + WS on `:2001` |
| `npm run icons:setup` | One-shot icon pack download into `data/icons/` (deliberate pre-warm on good Wi‑Fi; normally automatic at first start) |
| `npm run icons:repin` | Re-pin pw/rk to upstream `main` + fresh re-download + name-set diff (deliberate dev action, never automatic) |

`npm run lint` is broken repo-wide (pre-existing: no eslint config). It is NOT
part of the gate.

The gate is run after every change: `npm test` then `npm run typecheck` then
`npm run build`.

## Secrets — never commit, never echo

All live in `.env` (gitignored). `credentials.json` (OpenSky OAuth2 client) is
in the repo root and gitignored. Values: `AISSTREAM_API_KEY`,
`OPENSKY_CLIENT_ID`, `OPENSKY_CLIENT_SECRET`, `VITE_CARTO_API_KEY`.
`.env.example` holds empty secrets plus non-secret defaults (`PORT`,
`OPENSKY_POLL_MS`, `BATCH_MS`, `STALE_MS`, `REMOVE_MS`, `HISTORY_SNAPSHOT_MS`,
`HISTORY_MAX_BYTES`, `FAA_REFRESH_MS`). When reporting or committing, never
print the secret values.

`data/` (gitignored) is a local runtime cache — `data/faa/` (FAA registry
cache + `enrichment.json`), `data/history/` (timeline snapshots). Never
commit it; delete it to reset all cached data.

## Execution conventions (established with the user)

- Continuous execution: make rulings rather than stalling. Log significant
  rulings as `Ruling: <what> — <why> — <cost if wrong>`.
- Finished work is committed AND pushed to `origin` (GitHub).
- If a push fails with `Permission denied (publickey)`, the user must run
  `ssh-add ~/.ssh/id_rsa` (passphrase-protected key; agent doesn't persist).
- User is hands-on: they run `npm run dev` and browser-test after fixes;
  browser-only bugs (WebGL, decoding, rendering) can only be confirmed by them.

## External APIs — verified findings (Oct 2026)

### OpenSky (`server/opensky.ts`, `server/opensky-auth.ts`)

- **Basic auth (username/password) is DEAD** — retired 2026-03-18, and the
  server *silently ignores* the header (requests count as anonymous).
  Auth is OAuth2 client-credentials only:
  `POST https://auth.opensky-network.org/auth/realms/opensky-network/protocol/openid-connect/token`
  (`grant_type=client_credentials` + `client_id`/`client_secret`) → Bearer
  token, 30-min expiry. `opensky-auth.ts` caches it and refreshes 60 s early;
  a 401 forces refresh + one retry.
- **Credit model** (per endpoint family: `/states/*`, `/tracks/*`,
  `/flights/*` have independent buckets):
  - Tiers: anonymous **400 credits/day**; standard (registered + API client)
    **4,000/day**; active feeder 8,000/day; licensed 14,400/hour.
  - `/states/all` cost by bounding-box area: ≤25 sq° = 1, ≤100 = 2, ≤400 = 3,
    **>400 or global = 4**.
  - `X-Rate-Limit-Remaining` header = credits left; exhaustion → 429. Docs
    say the 429 carries `X-Rate-Limit-Retry-After-Seconds`, but the poller
    only reads the standard `retry-after` header (`server/opensky.ts:102`) —
    so in practice exponential backoff applies (cap 5 min,
    `BACKOFF_CAP_MS=300000`).
- Practical numbers: standard tier full-globe = 1,000 polls/day →
  `OPENSKY_POLL_MS=120000` (720/day) is sustainable 24/7. Shorter intervals
  exhaust the daily budget.
- Anonymous is also capped at ~10,000 aircraft; authenticated returns the full
  set (11k+ seen).
- Official docs: https://openskynetwork.github.io/opensky-api/rest.html
  (Limitations / API Credits sections). API clients are created at
  https://opensky-network.org/my-opensky/account.

### Carto basemaps (`src/map/basemap.ts`)

- Raster tiles on `basemaps.cartocdn.com` require a free API key
  (https://carto.com/basemaps/apikey) passed as **`?key=`** — `?apiKey=` is
  silently ignored.
- Keyless/invalid requests return the **"API KEY REQUIRED" placeholder as a
  normal 200 `image/png`** — HTTP status cannot detect failure. The placeholder
  is byte-identical at every coordinate; real tiles differ. `probeCarto`
  fetches two tiles at different zooms and compares bytes. Fallback basemap is
  OpenFreeMap dark (`https://tiles.openfreemap.org/styles/dark`, no key).
- Raster styles have **no glyphs** — text layers need an external `glyphs`
  URL. We use `https://demotiles.maplibre.org/font/{fontstack}/{range}.pbf`
  with font `Noto Sans Regular` (verified served by both demotiles and
  OpenFreeMap's `/fonts/` endpoint, so labels work on either basemap).

### MapLibre GL JS v4 (gotchas that caused real bugs here)

- `map.loadImage()` **cannot decode SVG** (wraps bytes in an `image/png` blob
  for `createImageBitmap`; its own error says "SVGs are not supported").
  Rasterize via browser `<img>` + canvas → `ImageData` →
  `map.addImage(name, data, { pixelRatio: 2 })` — see `src/map/icons.ts`.
- Logical NOT in expressions is **`["!", op]`**. `["not", …]` throws
  "Unknown expression" at `addLayer`/`setFilter` time (legacy v6-only
  keyword). In use: `src/data/filter.ts` (`buildIconFilter`).
- `text-field` requires a style `glyphs` property (see above).
- `validateStyleMin` from `@maplibre/maplibre-gl-style-spec` (devDependency)
  is the same validator the runtime uses — `test/style-validation.test.ts`
  validates the full basemap+layers style; this is the pattern for any
  style/layer/filter change. (The full `validate` export crashes standalone —
  it expects preprocessed styles; use `validateStyleMin`.)
- Vite `build.target` is `es2022` (required for top-level await in
  `src/main.ts`); don't lower it.

### Aircraft icons (`server/icons.ts`, `server/icon-tables.ts`)

**Primary art is the vendored icon pack** (see Icon pack below):
`resolveAirIcon` takes the pack's name set and emits a namespaced pack name
(`pw:`/`rk:`/`pd:`) whenever the matched table rule carries one and it is in
the set. The 13 shape-family air icons (24×24 top-down nose-up SVGs in
`src/assets/icons/`) remain committed as the **fallback layer** for every
unmatched type, colored by family: narrowbody/widebody/turboprop
`#4fc3f7`, bizjet/bizheli `#81d4fa`, piston/heli `#90a4ae`,
fighter/attack/transport/tanker_air/isr/milheli `#ef5350`. Color follows the
shape family, NOT the kind (a business-kind C172 renders the gray `piston`
silhouette). Sea icons are 1:1 with kind and unchanged.

Resolution order in
`resolveAirIcon({ kind, callsign, faaModel, faaMfr, pack })`:
military kind → callsign token table (word-anchored; `KC135` → tanker_air
before transport; `E3`/`P3`/`U2` are prefix matches; squadrons like EAGLE
fall back to `fighter`); civil → ordered FAA model table (normalize:
uppercase, strip spaces/hyphens; `{ mfr?: string[], re, pack?, family }`
rules in `server/icon-tables.ts`, helis first); then `KIND_FALLBACK_ICON`.
Real-data traps the table encodes: Cessna
numbers have no C prefix (`172S`, `208B`); `F28F` is Fokker jet vs Enstrom
28F heli (mfr decides); `S`-prefix needs mfr (SIKORSKY heli / SAAB turboprop
/ RANS ultralight); `FALCON` needs DASSAULT mfr (FALCONAR is an ultralight);
`B350` King Air (turboprop) vs `B35` Bonanza (piston); `K120` but not
`K1200`. Image name `tanker_air` (not `tanker`) avoids colliding with the
sea tanker kind — the registry test asserts no air/sea name collision.

Server sets `Craft.icon` post-normalization (poller `resolveIcon` opt wired
to `FaaProvider.lookup` + `iconPack?.names()` in `buildApp`); AIS sets no
icon. Client:
`features.ts` property `icon: c.icon ?? (air ? KIND_FALLBACK_ICON[kind] :
kind)`; `layers.ts` `"icon-image": ["get", "icon"]`; pack names are lazy-
registered by `src/map/pack-icons.ts`. Family/sea SVGs are browser-verified
only (no canvas in unit tests) — tune paths in
`src/assets/icons/` and re-run the gate; names are the contract.

### Icon pack (`server/iconpack.ts`, `data/icons/`)

The vendored per-model silhouette pack is the **primary aircraft art**
(namespaced names; see Aircraft icons above). Three pinned upstream
sources (`server/iconpack-sources.json`: repo commits + a per-file
public-domain manifest): `pw` = `plane-watch/pw-silhouettes`
(CC BY‑NC‑SA 4.0, filled SVGs; `-N` animation frames → use `-1`),
`rk` = `RexKramer1/AircraftShapesSVG` (GPL‑3.0, line‑art SVGs),
`pd` = curated Wikimedia Commons PNGs for gap types (per-file license +
attribution). Names are namespaced by source — `pw:B737`, `rk:C130`,
`pd:E3` — and the 13 family + 10 sea names are reserved: an index entry
colliding with them fails `init` (a curation bug, never a runtime choice).

**License constraint:** the app is local, non‑distributed,
non‑commercial, so the practical obligation is ~0 (GPL triggers on
distribution; NC on commercial use). Open‑sourcing or productizing this
repo would require re‑licensing or replacing these assets (also recorded
in `data/icons/ATTRIBUTION.md`, generated at setup).

`data/icons/` (gitignored — delete to force re‑download): `plane-watch/`
(cloned repo), `rk/` (cloned repo), `pd/` (fetched files), `index.json`
(build artifact — deleting it does not force a re-download), `pins.json`
(exact pins), `ATTRIBUTION.md`, and `exclude.json` for vetoes
(`{ "vetoed": ["rk:XYZ"] }` — vetoed entries stay in the catalog but are
unresolvable).

Setup is automatic at first server start (verified pins + complete files →
rebuild the index from disk, no network); `npm run icons:setup` is a
deliberate one‑shot pre‑warm on good Wi‑Fi; `npm run icons:repin`
(scripts/repin-icons.ts) re-pins pw/rk to `main` and re-downloads (prints
the name-set diff). **Offline‑first (spec R10): no third‑party network
access at runtime** — the browser only talks to the local server, which
serves the pack over `GET /icons/*`; a failed download retries on each
start and degrades to the 13 family icons. `GET /icons/catalog` is the
eyeball surface (every icon at final color/size + title/source/license +
the gap list). Recolor limit: `recolorPixels`
(`shared/pack-transforms.ts`) recolors only near‑white pixels (r, g, b all
≥ 200) — non‑white painted details keep their color.

### aisstream.io (`server/ais.ts`)

- Auth is an **in-band JSON subscription** sent after WS `open` (NOT headers):
  `{APIKey, BoundingBoxes: [[[-90,-180],[90,180]]], FilterMessageTypes:
  ["PositionReport","ShipStaticData"]}`. The first subscription must arrive
  **within 3 s** of connecting or the server closes the connection.
- **permessage-deflate is required**: beginning Sept 2026 uncompressed
  connections are subject to per-user bandwidth limits and over-limit messages
  are **dropped silently** (the stream just goes quiet — vessels then go stale
  and are swept). We connect with `perMessageDeflate: true`; the
  `SubscriptionConfirmation` frame logs its `CompressionEnabled` flag
  (`ais: subscribed (compression: true)`).
- **Keepalive**: the client pings every 20 s and `terminate()`s after 40 s
  without a pong (catches half-open TCP), then reconnects with the usual
  backoff.
- **No documented usage quota** for the free key — limits are
  connection-shaped: 3 subscribed connections/account, 3 open connections/IP,
  subscription updates ≤ 1/s per connection (they replace, not merge),
  200 MMSI filters.
- Documented close causes: late/malformed subscription, invalid key,
  connection-limit breach, update spam, fragmented client messages, missed
  keepalive, slow reads. Close code + reason are logged (`ais: closed 4001: …`)
  and surfaced in the `status` frame (`ais.lastError`); `ais.lastMessageAt`
  feeds the HUD (`AIS: ok / waiting / stale Nm / down / off`, stale = 3 min
  without data).
- `PositionReport.Timestamp` is a small counter, **not** epoch — vessel
  `updatedAt` is set to receive time.

### FAA registry (`server/faa.ts`, `server/faa-lookup.ts`)

- Bulk: `https://registry.faa.gov/database/ReleasableAircraft.zip` (~73 MB,
  data refreshed daily 11:30 pm CT). Files are comma-delimited, space-padded,
  BOM-prefixed; a few rows have quoted fields (`parseCsv` handles all).
  `MASTER.txt` (~317k rows): col 1 N-NUMBER, col 3 MFR MDL CODE, col 5
  YEAR MFR (~78% populated), col 7 NAME (registrant; blank when redacted per
  49 U.S.C. §44114(b) — render "—", never fabricate), col 10 CITY, col 11
  STATE, col 34 MODE S CODE HEX (= icao24, 100% populated). `ACFTREF.txt`
  (~94k): CODE → MFR + MODEL at subvariant quality (e.g. `737-8DR`,
  `A320-214`), joined on MASTER's MFR MDL CODE. In-memory index is keyed by
  lowercased icao24 hex; refresh failure keeps serving the stale index.
  Verified sample: N100GX = hex A00560, 2007, GULFSTREAM G150,
  BRULECREEK AVIATION LLC, PARK CITY UTAH.
- Per-click fallback: GET `.../aircraftinquiry/Search/NNumberInquiry` (yields
  cookie + `__RequestVerificationToken`) then POST `.../Search/NNumberResult`
  with `NNumbertxt` + token; needs a browser-like UA (plain clients get
  rejected). Result page status line is `<N> is Assigned` / `has
  Assigned/Multiple Records` / `is Deregistered`; invalid formats return the
  form page (no "Inquiry Results"). Lookups merge into the in-memory index and
  persist to `data/faa/enrichment.json` (hex → record; misses negative-cached
  1 h). Fixtures in `test/fixtures/` are recorded real responses — tests run
  offline; never re-record casually.
- Coverage: US-registered aircraft only (v1 ruling).
- Offline‑first (spec R10): the bulk DB follows the same local‑cache
  pattern as the icon pack — download once, serve from disk, refresh on a
  cadence (`FAA_REFRESH_MS`, daily default; `604800000` = weekly for
  spotty connections), keep serving the stale index on failure.

## Architecture at a glance

- `shared/craft.ts` — `Craft` type, 14 `KINDS` (air: commercial, business,
  military, general; sea: cargo, tanker, passenger, military_vessel, fishing,
  sailing, pleasure, tug_work, service, other), `AIR_KINDS`/`SEA_KINDS`,
  `Craft.icon?` (MapLibre image name), `AirKind`, `KIND_FALLBACK_ICON`,
  `PACK_NAME_PREFIXES`/`isPackIconName` (pack name registry).
  `shared/pack-transforms.ts` — pack silhouette transforms (line→fill,
  near‑white‑only recolor, image‑type sniff): pure string/byte surgery,
  Node‑testable, shared by the catalog page and the browser loader.
  Sea icon names are 1:1 with kinds; air icon names are shape families
  (fallback) or namespaced pack names (see Icon pack;
  `src/assets/icons/*.svg`, 24×24).
- `server/` — Fastify + `ws`: `index.ts` (wiring, client-frame dispatch, prod
  static serving, clean shutdown), `config.ts` (env), `store.ts`
  (CraftStore: upsert/prune/sweep), `hub.ts` (WS broadcast: `snapshot`,
   `update`, `status` frames), `opensky.ts` (poller; setTimeout chain; live
   `setPollInterval`),
  `opensky-auth.ts` (OAuth2 token provider), `ais.ts` (AIS WS client),
  `normalize.ts` (raw → `Craft`), `classify.ts` (kind inference from
  callsign/`aisType`; exports `N_NUMBER_RE`), `history.ts` (HistoryRecorder:
  gzipped snapshots to `data/history/`, size-capped eviction, `seek()`),
  `faa.ts` (FaaLoader: daily bulk registry download + hex→record index),
  `faa-lookup.ts` (FaaLookup: per-click N-number web fallback + enrichment
  cache), `icon-tables.ts` (MILITARY_RULES/CIVIL_RULES — the resolver's
  callsign/model tables; a rule may carry a `pack` name),
  `icons.ts` (resolveAirIcon: military callsign table → FAA model table →
  kind fallback; emits the rule's pack name when the caller's pack set
  contains it; 13 shape families as fallback),
  `iconpack.ts` (IconPack: download/verify/index the vendored pack into
  `data/icons/`; `init()` never throws — failures land in `status()`),
  `icons-catalog.ts` (catalog page HTML + gap list).
- `src/` — `main.ts` (top-level await; wiring, rewind mode, info cache),
  `map/` (basemap probe, map creation, icon rasterization, `icon-urls.ts` =
  13 air family + 10 sea SVG imports = 23 entries, `pack-icons.ts` = lazy
  pack‑icon loader (fetch `GET /icons/*` → transform → 96×96 raster →
  `addImage`, failed-set retry), layer defs), `data/`
  (socket client, client store, feature building, icon filter, `replay.ts` =
  client-side update suppression gate for rewind), `ui/` (panel (FAA info
  rows), filters, HUD, `timeline.ts` (scrubber + REPLAY badge + LIVE),
  `pollrate.ts` (`createFeedRate` factory — one slider per feed; the opensky
  instance shows credit warnings)).
- WS protocol (both ends mirror it, no shared file):
  client → server: `{type:"feed.rate",feed,ms}` (`feed` ∈ hub `FEED_IDS` =
  `["opensky"]`; a new service adds one `feedRate` handler entry in
  `index.ts` + a slider via the `createFeedRate` factory),
  `{type:"timeline.seek",time}`, `{type:"timeline.live"}`,
  `{type:"aircraft.info",id}`;
  server → client: `{type:"snapshot",craft}`, `{type:"update",upsert,remove}`
  (craft objects carry an optional `icon` — air shape family / sea kind /
  absent in pre-icon snapshots),
  `{type:"status",feeds:{opensky:{lastOkAt,lastError,pollMs},ais:{connected,enabled,lastError,lastMessageAt}},history:{from,to,snapshots},faa:{state,updatedAt,aircraft,lastError},icons:{state,count,updatedAt,lastError},serverTime}`
  (icons.state: ready|downloading|failed|absent),
  `{type:"timeline.state",time,craft}` (`time:null` = return to live / seek
  error), `{type:"aircraft.info",id,info}` (`info:null` = no data; else
  `{nNumber,year,mfr,model,owner,city,state,source:"db"|"live"}`).
- `test/` — 26 files, 389 tests. Node-environment Vitest; browser-only code
  (canvas/WebGL) is not unit-testable and is verified by the user in-browser.
