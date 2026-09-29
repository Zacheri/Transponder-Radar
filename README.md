# Transponder Radar

A local, browser-based live world map of **aircraft** (ADS-B via OpenSky) and
**vessels** (AIS via aisstream.io). Per-kind icons, a click-to-open detail
panel, and a kind filter drawer.

## Setup

1. `npm install`
2. Create a free AIS key: <https://aisstream.io/account> (GitHub sign-in; the
   key is shown once — copy it now).
3. `cp .env.example .env` and paste your key into `AISSTREAM_API_KEY`.
   (Aircraft work without a key; vessels need it.)
4. `npm run dev`
5. Open <http://localhost:5173>.

## Scripts

| Command             | What it does                              |
| ------------------- | ----------------------------------------- |
| `npm run dev`       | Backend (`:8787`) + frontend (`:5173`)    |
| `npm test`          | Unit + integration tests (Vitest)         |
| `npm run typecheck` | `tsc --noEmit`                            |
| `npm run build`     | Production frontend build → `dist/`       |
| `npm start`         | Backend API + WS on `:8787` (prod)        |

## How it works

A single Node backend (Fastify + `ws`) polls OpenSky and subscribes to
aisstream.io, normalizes both into one `Craft` model, keeps an in-memory store,
and pushes a snapshot + ~1Hz deltas to the browser over WebSocket. The browser
(Vite + vanilla TS + MapLibre GL JS) renders all craft as a GeoJSON source with
data-driven icon/label layers.

- **Aircraft** = ADS-B (OpenSky `states/all`, free, no key; polled every 36 s
  because the anonymous rate limit is ~100 req/hour).
- **Vessels** = AIS (aisstream.io, free key).
- Stale craft dim after 2 min; removed after 10 min. Air craft missing from a
  fresh OpenSky snapshot are pruned after a 30 s grace.

## Layout

- `shared/craft.ts` — the `Craft` model + 14 kinds (imported by both sides).
- `server/` — config, classify, normalize, store, opensky, ais, hub, bootstrap.
- `src/` — map, data (store/ws/features/filter), ui (panel/filters/hud), icons.
- `test/` — Vitest unit + integration (stub feeds → full pipeline).
