# AGENTS.md — Transponder Radar

Orientation for agents working in this repo. Full history: git log +
`docs/superpowers/specs/2026-09-27-transponder-map-design.md` (spec) and
`docs/superpowers/plans/2026-09-27-transponder-map.md` (plan, incl. Scope Round 2).

## What this is

Local, single-user web app: live world map of **aircraft** (OpenSky ADS-B) and
**vessels** (aisstream.io AIS) on a dark MapLibre GL map, with per-kind icons,
click-to-open detail panel, kind filter drawer, and a status HUD.

## Commands

| Command | Purpose |
|---|---|
| `npm run dev` | Backend `:8787` (tsx watch) + Vite `:5173` (proxies `/ws`, `/health`) |
| `npm test` | Vitest, `test/**/*.test.ts` — **gate: all pass** |
| `npm run typecheck` | `tsc --noEmit` — **gate: clean** |
| `npm run build` | Vite build — **gate: succeeds** (maplibre-gl >500 kB chunk warning is an accepted exception) |
| `npm start` | Prod: serves `dist/` + API + WS on `:8787` |

`npm run lint` is broken repo-wide (pre-existing: no eslint config). It is NOT
part of the gate.

The gate is run after every change: `npm test` then `npm run typecheck` then
`npm run build`.

## Secrets — never commit, never echo

All live in `.env` (gitignored). `credentials.json` (OpenSky OAuth2 client) is
in the repo root and gitignored. Values: `AISSTREAM_API_KEY`,
`OPENSKY_CLIENT_ID`, `OPENSKY_CLIENT_SECRET`, `VITE_CARTO_API_KEY`.
`.env.example` holds empty secrets plus non-secret defaults (`PORT`,
`OPENSKY_POLL_MS`, `BATCH_MS`, `STALE_MS`, `REMOVE_MS`). When reporting or
committing, never print the secret values.

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

### aisstream.io (`server/ais.ts`)

- Auth is an **in-band JSON subscription** sent after WS `open` (NOT headers):
  `{APIKey, BoundingBoxes: [[[-90,-180],[90,180]]], FilterMessageTypes:
  ["PositionReport","ShipStaticData"]}`.
- `PositionReport.Timestamp` is a small counter, **not** epoch — vessel
  `updatedAt` is set to receive time.

## Architecture at a glance

- `shared/craft.ts` — `Craft` type, 14 `KINDS` (air: commercial, business,
  military, general; sea: cargo, tanker, passenger, military_vessel, fishing,
  sailing, pleasure, tug_work, service, other), `AIR_KINDS`/`SEA_KINDS`.
  Icon image names are 1:1 with kinds (`src/assets/icons/*.svg`, 24×24).
- `server/` — Fastify + `ws`: `index.ts` (wiring, prod static serving, clean
  shutdown), `config.ts` (env), `store.ts` (CraftStore: upsert/prune/sweep),
  `hub.ts` (WS broadcast: `snapshot`, `update`, `status` frames),
  `opensky.ts` (poller), `opensky-auth.ts` (OAuth2 token provider), `ais.ts`
  (AIS WS client), `normalize.ts` (raw → `Craft`), `classify.ts` (kind
  inference from callsign/`aisType`).
- `src/` — `main.ts` (top-level await; wiring), `map/` (basemap probe, map
  creation, icon rasterization, `icon-urls.ts` = Vite SVG import map, layer
  defs), `data/` (socket client, client store, feature building, icon filter),
  `ui/` (panel, filters, HUD).
- `README.md` "How it works" is partly stale: it still says aircraft poll
  every 36 s under the anonymous limit; current reality is OAuth2 auth with
  `OPENSKY_POLL_MS` default 120 s (`server/config.ts`).
- WS protocol (both ends mirror it, no shared file):
  `{type:"snapshot",craft}`, `{type:"update",upsert,remove}`,
  `{type:"status",feeds:{opensky:{lastOkAt,lastError},ais:{connected,enabled}},serverTime}`.
- `test/` — 16 files, 80 tests. Node-environment Vitest; browser-only code
  (canvas/WebGL) is not unit-testable and is verified by the user in-browser.
