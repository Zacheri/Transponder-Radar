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
| `npm run dev` | Backend `:2001` (tsx watch) + Vite `:1738` (proxies `/ws`, `/health`, `/icons`) |
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
`AISCAST_API_KEY`,
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
- Practical numbers: standard tier full-globe = 1,000 polls/day (4 credits
  each). Default `OPENSKY_POLL_MS=90000` (960/day, ~3,840 credits) is
  sustainable 24/7; `120000` (720/day) is the old, more conservative default.
  Much shorter intervals exhaust the daily budget.
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
icon. `IconPack.onReady` fires once per process on the first non-ready→ready
transition: buildApp re-resolves every air craft in the store and upserts the
changed ones, so pack art replaces boot-time family fallbacks without waiting
for the next poll. `GET /icons/:name` sends a content-sha `ETag`
(`If-None-Match` → 304) + `Cache-Control: public, max-age=86400`. Client:
`features.ts` property `icon: c.icon ?? (air ? KIND_FALLBACK_ICON[kind] :
kind)`; `layers.ts` `"icon-image": ["get", "icon"]`; pack names are lazy-
registered by `src/map/pack-icons.ts`. Family/sea SVGs are browser-verified
only (no canvas in unit tests) — tune paths in
`src/assets/icons/` and re-run the gate; names are the contract.

Gap status (through the 2026-11-19 registry-sweep wave): five waves —
11-06 wired 9 military tokens + 6 new tokens + 8 `pd:` entries; 11-09
fixed the `E3`/BD-700 wrong-art bugs + Cessna/Bonanza/Bell/Global breadth
rules; 11-11 curated 10 more `pd:` entries from the Commons 3-view series
and re-sourced TACAMO→`rk:B703`/ATR-72→`rk:AT75`; 11-18 audited every
`pd:` crop at icon size, fixed 9 bad ones and vetoed 4
(`pd:C177`/`pd:MQ9`/`pd:C141`/`pd:CH53` — `OmittedModels.md` 30–33), and
wired the AWACS token to `rk:E3TF`; 11-19 (registry sweep + vision-gated
curation via subagent) added Kaydet/PT-17→`rk:ST75` (1k ac, table-only),
Learjet-bare/Phenom/Citation family routing fixes, and three **derived**
`pd:` entries — `pd:PA22` (2.9k), `pd:PA30` (0.9k), `pd:MUSK` (1.2k) —
each pre-binarized/dilated/rot-baked from a Commons 3-view sheet
(`style:"filled"`, scripts + provenance in the wave2c papertrail).
Several entries use `rot: 90|180|270` (sheet top views drawn nose-down
or sideways) — rotation is applied after the crop. `pw:CT4`/`pw:HAWK`
vetoed (unidentifiable at pack size). Standing gaps — military
`B2 F14 F117 E4` (photos only) and the entries in
`ML_Docs/Radar/OmittedModels.md`, incl. the large fleets Commons
cannot serve: **Piper J-3 (3.8k — every Commons SVG clips its own top
view)**, **PA-18 (3.7k — overlapping view regions)**, Aeronca 7AC Chief
(2.3k — vignetted gray-fill scan, no threshold window), **Stinson 108
(1.4k — sheet has no plan view)**, C177/C170 (banner text inside the top
view), C421/C411/C414, AA-5, C337, PA-34, plus Challenger 300/350,
737 MAX 7, L-410, Hawker 400/800, DC-9, G280/G550 dedicated art — one
entry per omitted variant (code, rule, reason, search log, date) so a
future agent can re-source. Anything else renders the shape-family
fallback. **Crop verification bar: eyeball every crop at final size for
region, orientation and in-view text before shipping — 12 of 16 shipped
`pd:` crops were wrong in 2026-11-18.**

### Icon pack (`server/iconpack.ts`, `data/icons/`)

The vendored per-model silhouette pack is the **primary aircraft art**
(namespaced names; see Aircraft icons above). Three pinned upstream
sources (`server/iconpack-sources.json`: repo commits + a per-file
public-domain manifest): `pw` = `plane-watch/pw-silhouettes`
(CC BY‑NC‑SA 4.0, filled SVGs; `-N` animation frames → use `-1`),
`rk` = `RexKramer1/AircraftShapesSVG` (GPL‑3.0, line‑art SVGs),
`pd` = curated Wikimedia Commons files for gap types (PNG/GIF/SVG,
per-file license + attribution). Names are namespaced by source — `pw:B737`, `rk:C130`,
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
rebuild the index from disk, no network). Editing the manifest's `pd` list
invalidates `pins.json` (it pins every pd sha + the entry count), so the
next start takes the full-download path — if that hits Commons 429s,
sha-verify the files on disk against the manifest and rewrite `pins.json`'s
`pd` map locally; `init` then rebuilds with no network.
`npm run icons:setup` is a deliberate one-shot pre-warm on good Wi-Fi; `npm run icons:repin`
(scripts/repin-icons.ts) re-pins pw/rk to `main` and re-downloads (prints
the name-set diff). **Offline‑first (spec R10): no third‑party network
access at runtime** — the browser only talks to the local server, which
serves the pack over `GET /icons/*`; a failed download retries on each
start and degrades to the 13 family icons. `GET /icons/catalog` is the
eyeball surface (every icon at final color/size + title/source/license +
the gap list); `GET /icons/list` is the machine surface the client loader
reads — `{version, entries: [{name, style, crop?, color}]}` (`version`
changes when the pack content changes — keys the browser's IndexedDB
pre-color raster cache; `crop` only on gapfill
entries, a `{x,y,w,h}` rectangle in fractions of the file — the manifest's
legacy `cropTopRatio` normalizes to `{0,0,1,r}`; every sourced sheet's top
view sits in an arbitrary quadrant, so top-band crops can't express them).
pd entries may carry `style: "filled"` (near-white SVG silhouettes like
`pd:737C` ride the `recolorPixels` path; default is `"gapfill"`). pd files
can be JPEG bytes (Commons .jpg sources — c5/kc10), GIF (`pd:B200`), or
SVG (`pd:CH53`, `pd:737C`) under any extension — the extension is part of
the sha pin; never "fix" the filename, it would invalidate verification.
**Derived entries** (`pd:PA22`/`pd:PA30`/`pd:MUSK`) ship authoring-time
silhouettes (sheet cropped, binarized at a measured threshold, dilated,
rotation-baked, white-out on alpha, `style: "filled"`) — their `url`
points at the source sheet but the sha matches the DERIVED file, so a
full `data/icons/` wipe fails re-download verification for those three
and degrades to family fallback; re-author with the wave2c scripts
(`silgen.js` pattern) instead.
Recolor limit: `recolorPixels`
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
- FAA bulk registry cadence: download only if ≥24 h since the last *successful*
  one (gate = extracted-files mtime, written by the loader), checked at startup
  + every `FAA_REFRESH_MS` (default 4 h; failures retry per check, never reset
  the clock). Every successful download keeps a daily zip copy
  (`data/faa/dailies/`, deleted only once today is ≥7 days past the most recent
  Friday they precede, 16-file cap) and the first download of each
  Friday-anchored week is snapshotted to `data/faa/fridays/` (52 kept).
  Offline-first (spec R10): same local-cache pattern as the icon pack —
  download once, serve from disk, keep serving the stale index on failure.

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
  `opensky-auth.ts` (OAuth2 token provider), `ais.ts` (parameterized AIS WS
  client — url/name/boxesProvider/attribution injectable; index.ts runs two
  instances: primary aisstream + the `aiscast` fill client aimed by
  `ais-tiles.ts` composed home/follow tiles),
  `normalize.ts` (raw → `Craft`), `classify.ts` (kind inference from
  callsign/`aisType`; exports `N_NUMBER_RE`), `history.ts` (HistoryRecorder:
  gzipped snapshots to `data/history/`, size-capped eviction, `seek()`; tiered
  retention — younger than `FULL_RES_AGE_MS` (48 h) rides `snapshotMs`, older
  collapses to one survivor per `COMPACT_STEP_MS` bucket (`planCompaction`),
  pins exempt, hourly `compact()` pass),
  `faa.ts` (FaaLoader: daily bulk registry download + hex→record index),
  `faa-lookup.ts` (FaaLookup: per-click N-number web fallback + enrichment
  cache), `airports.ts` (createAirports: pinned offline `airports.dat` download
  into `data/airports/`, ICAO+IATA lookup, never throws), `routes.ts`
  (RoutesService: callsign→route ladder adsbdb → OpenSky `/flights/all`
  est-airports → null; 24 h/1 h caches persisted `data/routes/cache.json`),
  `tracks.ts` (TracksService: HistoryRecorder.trackFor + OpenSky `/tracks/all`
  merged per-icao24 trail; daily ledger `data/tracks/ledger.json` caps auto
  fetches at 300/day and all at 800/day — refusals answer cache + `budget`),
  `icon-tables.ts` (MILITARY_RULES/CIVIL_RULES — the resolver's
  callsign/model tables; a rule may carry a `pack` name),
  `icons.ts` (resolveAirIcon: military callsign table → FAA model table →
  kind fallback; emits the rule's pack name when the caller's pack set
  contains it; 13 shape families as fallback),
  `iconpack.ts` (IconPack: download/verify/index the vendored pack into
  `data/icons/`; `init()` never throws — failures land in `status()`),
  `icons-catalog.ts` (catalog page HTML + gap list).
- `src/` — `main.ts` (top-level await; wiring, rewind mode, info cache,
  flight-trail selection + credit-guarded refresh loop
  `clamp(pollMs/2, 30 s, 300 s)` — paused while hidden/rewound, seq-guarded
  replies, layers cleared on selection close/change),
  `map/` (basemap probe, map creation, icon rasterization, `icon-urls.ts` =
  13 air family + 10 sea SVG imports = 23 entries, `pack-icons.ts` = lazy
  pack‑icon loader (fetch `GET /icons/*` → transform → 96×96 raster →
  `addImage`, failed-set retry), layer defs, `trackLayers.ts` =
  `flight-trail`/`flight-predicted`/`flight-dest` defs + pure data setters,
  inserted below `craft-icons`), `data/`
  (socket client, client store, feature building, icon filter, `replay.ts` =
  client-side update suppression gate for rewind), `ui/` (panel (FAA info
  rows; air: dep/arr route chips `IATA · city` → fly-to + dest marker,
  trail refresh button, R2 budget note), filters, HUD, `timeline.ts` (scrubber + REPLAY badge + LIVE +
  view-window row — preset/custom range select over `ViewSel` (`format.ts`),
  persisted to the `radar.viewSel` localStorage key; scrubber and playback
  follow the view, no protocol change),
  `pollrate.ts` (`createFeedRate` factory — one slider per feed; the opensky
  instance shows credit warnings; the ais instance is the "Ship updates"
  slider (no credits)); the HUD adds an aiscast fill credit line under the
  pill (`AIS fill: ≤3 attributions joined " · " (+N)`, visible only while
  `secondary.enabled && connected`); the settings drawer has an "AIS fill"
  home-tile park/clear control (posts `settings.update {homeRegion}`).
- WS protocol (both ends mirror it, no shared file):
  client → server: `{type:"feed.rate",feed,ms}` (`feed` ∈ hub `FEED_IDS` =
  `["opensky", "ais"]`; the server clamps `feed.rate`/`ais` to [60000, 600000]
  (default 120000; `AIS_FLUSH_*` in `hub.ts`) — bounds agree with the client
  slider — and ignores non-finite values; a
  new service adds one `feedRate` handler entry in `index.ts` + a slider via
  the `createFeedRate` factory),
  `{type:"timeline.seek",time,seq?}`, `{type:"timeline.live"}`,
  `{type:"aircraft.info",id}` (the optional `seq` is echoed on the reply so the
  client can drop replies from superseded seeks; legacy seq-less replies are
  always applied),
  `{type:"flight.track",id,seq,auto?}` (`auto:false` = manual refresh, exempt
  from the daily auto ledger), `{type:"flight.context",id,seq}` (both carry a
  client-monotonic `seq` bumped on every selection change and refresh wave),
  `{type:"settings.update",patch{storageCapGb?,ramCacheGb?,homeRegion?:{lat,lon}|null}}`
  (`homeRegion` null clears the parked aiscast tile),
  `{type:"ais.tile",lat,lon}` (viewport center; sent from the client's
  moveend 1 s debounce only while status `secondary.enabled` — multiple
  connected browsers are last-writer-wins, by design);
  server → client: `{type:"snapshot",craft}`, `{type:"update",upsert,remove}`
  (craft objects carry an optional `icon` — air shape family / sea kind /
  absent in pre-icon snapshots),
  `{type:"status",feeds:{opensky:{lastOkAt,lastError,pollMs},ais:{connected,enabled,lastError,lastMessageAt,flushMs,secondary:{enabled,connected,lastError,lastMessageAt,attributions}}},settings:{storageCapGb,ramCacheGb,cacheUsedBytes,homeRegion},history:{from,to,snapshots},faa:{state,updatedAt,aircraft,lastError},icons:{state,count,updatedAt,lastError},serverTime}`
  (icons.state: ready|downloading|failed|absent; `secondary` is non-nullable —
  disabled = `enabled:false` zeroed, never null; `homeRegion` is
  `{lat,lon}|null`),
  `{type:"timeline.state",time,craft,seq?}` (`time:null` = return to live / seek
  error), `{type:"aircraft.info",id,info}` (`info:null` = no data; else
  `{nNumber,year,mfr,model,owner,city,state,source:"db"|"live"}`),
  `{type:"flight.track",id,seq?,path,fetchedAt,source,budget}` (`path` =
  ascending `{t,lat,lon,alt,onGround}` trail points, unknown id → `[]`;
  `source`: both|history|opensky|none; `budget` = `{autoLeft,hard}` daily
  ledger remaining — note row in the panel, no HUD item),
  `{type:"flight.context",id,seq?,route}` (`route:null` = none; else
  `{airline,dep,arr,source}` with server-resolved `{icao,iata,name,city,
  country,lat,lon}` airport refs — the client never looks airports up).
- `test/` — 46 files, 880 tests. Node-environment Vitest; browser-only code
  (canvas/WebGL) is not unit-testable and is verified by the user in-browser.
