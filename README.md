# Transponder Radar

A local, browser-based live world map of **aircraft** (ADS-B via OpenSky) and
**vessels** (AIS via aisstream.io). Per-kind icons, a click-to-open detail
panel, a kind filter drawer, a live aircraft poll-rate slider, and a timeline
scrubber that rewinds the map back in time. For US-registered aircraft the
detail panel also shows make/model, year, and registered owner from the FAA
registry.

## Setup

1. `npm install`
2. Create a free AIS key: <https://aisstream.io/account> (GitHub sign-in; the
   key is shown once — copy it now).
3. `cp .env.example .env` and paste your key into `AISSTREAM_API_KEY`.
   (Aircraft work without a key; vessels need it.)
   Optional (recommended): create an OpenSky OAuth2 API client
   (<https://opensky-network.org/my-opensky/account> → API clients → download
   `credentials.json`) and set `OPENSKY_CLIENT_ID` / `OPENSKY_CLIENT_SECRET`.
   OpenSky charges 4 credits per full-globe poll; the standard tier gets 4,000
   credits/day, so `OPENSKY_POLL_MS=120000` keeps the feed alive 24/7.
   Anonymous access only gets 400 credits/day (~100 globe polls) and will 429.
4. Optional: paste a free Carto key (<https://account.carto.com>) into
   `VITE_CARTO_API_KEY` for the Carto dark basemap. Without it (or if the key
   is invalid), the map falls back to OpenFreeMap dark — no key needed.
5. `npm run dev`
6. Open <http://localhost:1738>.

The first start also downloads the FAA aircraft registry in the background
(~73 MB; refreshed automatically) to power the aircraft type/owner panel rows.

## Production

`npm run build && npm start` — the backend serves the built frontend from
`dist/` plus the API + WS on one port. Open <http://127.0.0.1:2001>.

## Scripts

| Command             | What it does                                |
| ------------------- | ------------------------------------------- |
| `npm run dev`       | Backend (`:2001`) + frontend (`:1738`)      |
| `npm test`          | Unit + integration tests (Vitest)           |
| `npm run typecheck` | `tsc --noEmit`                              |
| `npm run build`     | Production frontend build → `dist/`         |
| `npm start`         | Serves `dist/` + API + WS on `:2001` (prod) |

## How it works

A single Node backend (Fastify + `ws`) polls OpenSky and subscribes to
aisstream.io, normalizes both into one `Craft` model, keeps an in-memory store,
and pushes a snapshot + ~1Hz deltas to the browser over WebSocket. The browser
(Vite + vanilla TS + MapLibre GL JS) renders all craft as a GeoJSON source with
data-driven icon/label layers.

- **Aircraft** = ADS-B (OpenSky `states/all`, OAuth2 client-credentials;
  polled every `OPENSKY_POLL_MS` — default 120 s to stay inside the
  4,000-credit/day budget; the HUD slider changes it live).
- **Vessels** = AIS (aisstream.io, free key).
- Stale craft dim after 2 min; removed after 10 min. Air craft missing from a
  fresh OpenSky snapshot are pruned after a 30 s grace.

## Timeline rewind

The server's live craft store is snapshotted to `data/history/` as a gzipped
JSON file every `HISTORY_SNAPSHOT_MS` (default 60 s). The bottom timeline bar
scrubs the map back in time (aircraft **and** vessels); while rewound the HUD
shows the replayed time with a `REPLAY` badge, and the LIVE button returns to
now. History is evicted oldest-first beyond `HISTORY_MAX_BYTES` (default 10 GB)
and survives restarts.

## Aircraft type & owner (FAA)

Clicking a US-registered aircraft shows its make/model (to subvariant),
year, and registered owner. Source: the FAA's daily bulk "Releasable Aircraft
Database" (~73 MB zip → ~200 MB in `data/faa/`, refreshed every
`FAA_REFRESH_MS`). Aircraft missing from the bulk DB (e.g. registered after
the last refresh) are resolved on click via the FAA N-number lookup, cached in
`data/faa/enrichment.json`. Non-US aircraft — or records the FAA redacts —
show "—".

## Data directory

`data/` (gitignored) holds `faa/` (registry cache + enrichment cache) and
`history/` (timeline snapshots). Delete it to reset all cached data.

## Layout

- `shared/craft.ts` — the `Craft` model + 14 kinds (imported by both sides).
- `server/` — config, classify, normalize, store, opensky, ais, hub, history
  (timeline snapshots), faa (FAA bulk registry), faa-lookup (per-click
  N-number fallback), bootstrap.
- `src/` — map, data (store/ws/features/filter/replay), ui
  (panel/filters/hud/timeline/pollrate), icons.
- `test/` — Vitest unit + integration (stub feeds → full pipeline).
