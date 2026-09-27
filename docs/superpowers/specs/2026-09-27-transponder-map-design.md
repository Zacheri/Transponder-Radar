# Live Transponder Map — Design Spec

- **Date:** 2026-09-27
- **Status:** Approved (brainstorming complete)
- **Owner:** zacheri
- **Scope:** New project, local/personal, single user

## 1. Overview

A browser-based, live, world map of aircraft and water vessels populated from real
transponder data:

- **Aircraft** via **ADS-B** (OpenSky Network).
- **Vessels** via **AIS** (aisstream.io).

The map is zoomable/panable and increases in detail with zoom level. Every craft has an
icon that reflects its kind (cargo ship, tanker, warship, airliner, fighter, biz-jet,
etc.). Clicking a craft opens a side-bound detail panel showing everything transponded
(speed, altitude, type, country of origin, squawk, nav status, destination, raw data).
A filter system shows/hides craft by subtype.

> **Domain note:** aircraft broadcast ADS-B; water vessels broadcast AIS (a different
> protocol with its own feeds). "Transponder data" here means ADS-B (air) + AIS (sea).

## 2. Goals

- Live, global map of airborne + seagoing craft, updating in real time.
- Per-kind icon for every craft.
- Click → detail panel with all transpondered fields, live-updating.
- Filter drawer to show/hide craft by kind, with live counts.
- Runs locally with one command; no external services to operate.
- Graceful degradation when a feed drops (never crashes).

## 3. Non-Goals (YAGNI)

- No multi-user deployment, auth, or database.
- No historical replay / persistence of positions.
- No airframe-level aircraft type (e.g. "B738") — not available from the free OpenSky
  feed (that is adsb.fi, key-gated). Aircraft are classified by callsign + SPI into
  commercial / business / military / general.
- No viewport-based server filtering (client + WebGL handle visibility).
- No mobile-native build (responsive web only).

## 4. Key Decisions

| Area | Decision | Rationale |
|------|----------|-----------|
| Deployment | Local / personal, single user | Simplest; shared rate limits are a non-issue |
| Frontend | Vite + vanilla TypeScript (no framework) | Minimal boilerplate for a single-view map app |
| Backend | Node.js (Fastify + `ws`), single process | Owns both feeds + browser socket in one process |
| Map engine | MapLibre GL JS (WebGL) | Handles 10k+ moving objects at 60fps; data-driven styling |
| ADS-B source | OpenSky Network (REST poll) | Free, no key, rich state vectors |
| AIS source | aisstream.io (WebSocket) | Free, real-time, verified live |
| Data transport | Backend → browser WebSocket, snapshot + batched deltas | Keeps wire light, map smooth |
| Basemap | Carto `dark-matter` vector (no key) | Fits the "radar" theme; one-line swap |

**Why a backend is mandatory (verified):**
- OpenSky's CORS is hard-locked to its own origin (`access-control-allow-origin:
  https://opensky-network.org` regardless of caller) → a browser cannot call it directly.
- aisstream.io states: *"Direct browser connections are not permitted. Connect from your
  own server and proxy only the information your clients need."* It also requires an API
  key, which must stay server-side.

## 5. Architecture

```
┌────────────────────────────────────────────────────────┐
│  BROWSER  (Vite + vanilla TS + MapLibre GL JS)         │
│  • Map view, per-type icons, zoom-dependent detail     │
│  • Click → detail panel • Filter UI (show/hide kinds)  │
│  • Holds a live GeoJSON source of all visible craft    │
└───────────────────────────┬────────────────────────────┘
                            │  WebSocket  /ws
                            │  ① full snapshot on connect
                            │  ② batched deltas (upsert/remove) ~1x/sec
┌───────────────────────────┴────────────────────────────┐
│  NODE BACKEND  (Fastify + ws)  — single process        │
│                                                        │
│  ┌──────────────────┐   ┌──────────────────────────┐   │
│  │ OpenSky poller    │   │ aisstream.io WS client   │   │
│  │ (ADS-B) REST      │   │ (AIS) persistent socket  │   │
│  │ poll /states/all  │   │ PositionReport +         │   │
│  │ every ~5 s        │   │ ShipStaticData           │   │
│  └────────┬─────────┘   └────────────┬─────────────┘   │
│           └────────────┬─────────────┘                 │
│                        ▼                               │
│        Normalizer → unified Craft model                │
│        Type classifier (air/sea kind)                  │
│        In-memory store  Map<id, Craft> + dirty set     │
│                        ▼                               │
│        WS hub → broadcast snapshot + batched deltas    │
└──────────────┬────────────────────────────┬────────────┘
               │ HTTPS (poll)               │ WSS (headers: APIKey, filters)
        ┌──────┴──────┐              ┌──────┴───────────┐
        │  OpenSky     │              │  aisstream.io    │
        │  (ADS-B)     │              │  (AIS)           │
        └──────────────┘              └──────────────────┘
```

**Data flow:**
1. Backend polls OpenSky `states/all` every ~5s → all airborne ADS-B state vectors.
2. Backend holds one persistent WebSocket to aisstream.io → AIS `PositionReport` +
   `ShipStaticData` messages stream in real time.
3. Both are normalized into one `Craft` shape and written to an in-memory store keyed by
   a stable ID (aircraft = `icao24`, vessel = `MMSI`).
4. The WS hub sends the browser a full `snapshot` on connect, then batched `update`s
   (only changed craft) ~1×/sec.
5. Frontend applies snapshot then updates, updating the MapLibre GeoJSON source;
   MapLibre re-renders moving icons on the GPU.
6. Click an icon → detail panel with all transpondered fields. Filters toggle visibility
   by kind.

## 6. Data Model

One unified shape for air + sea, with a `domain` discriminator. Shared between server and
client (`shared/craft.ts`).

```ts
type Domain = "air" | "sea";

type CraftKind =
  // air
  | "commercial" | "business" | "military" | "general"
  // sea
  | "cargo" | "tanker" | "passenger" | "military_vessel"
  | "fishing" | "sailing" | "pleasure" | "tug_work" | "service" | "other";

interface Craft {
  id: string;                 // air: icao24 hex ("ac4963"); sea: MMSI ("368207620")
  domain: Domain;
  kind: CraftKind;            // drives icon + filter

  lat: number;
  lon: number;
  speed: number | null;       // knots
  heading: number | null;     // degrees true

  // air (OpenSky)
  callsign?: string;
  altitude?: number | null;   // feet (geo, fallback baro)
  verticalRate?: number | null; // fpm
  squawk?: string | null;
  onGround?: boolean;
  spi?: boolean;              // special-mode identity → military signal
  originCountry?: string;

  // sea (aisstream.io)
  shipName?: string;
  imo?: number | null;
  callSign?: string;
  destination?: string;
  navStatus?: number | null;
  aisType?: number | null;    // raw AIS vessel-type code (0–255)

  updatedAt: number;          // epoch ms of last position fix
  stale: boolean;             // no fix for > STALE_MS
}
```

`KINDS` metadata (in `shared/craft.ts`) maps each `CraftKind` → `{ label, domain, icon,
color }` so labels, icons, and filter groups stay consistent across server and client.

### 6.1 Type classification

**Aircraft** — OpenSky does not send airframe type, so classify by callsign + SPI:

| kind | signal |
|------|--------|
| `military` | `spi === true`, or callsign matches a military pattern |
| `commercial` | ICAO airline designator + flight number (e.g. `DAL539`, `AAL2174`, `UAL1716`) |
| `business` | US N-number (`N759SG`) or biz-jet callsign prefix (`EJA`, `GTF`, `LEG`, `RJS`, `FGE`, …) |
| `general` | everything else (GA, unknown, helicopter) |

**Vessels** — from AIS `ShipStaticData.Type` (ITU-R M.1371 codes):

| kind | AIS codes |
|------|-----------|
| `cargo` | 70–79 |
| `tanker` | 80–86 |
| `passenger` | 44–47, 60–63 |
| `military_vessel` | 30, 54, 57 |
| `fishing` | 32 |
| `sailing` | 31, 36 |
| `pleasure` | 37 |
| `tug_work` | 33, 34, 35, 50, 51, 52, 59 |
| `service` | 38, 39, 40, 41, 42, 43, 53, 55, 56, 58 |
| `other` | 0, 90–99, unknown/missing |

### 6.2 The AIS join (critical)

aisstream.io sends **separate message types**: `PositionReport` (live position/speed/
course) and `ShipStaticData` (name, **`Type`**, destination, IMO, call sign). The backend:
- Subscribes to `FilterMessageTypes: ["PositionReport", "ShipStaticData"]`.
- Caches `ShipStaticData` in `Map<mmsi, staticData>`.
- Merges the cached static data into each `PositionReport` for that MMSI.
- A vessel appears as `kind: "other"` until its static data arrives, then upgrades to its
  real kind (and gains name/destination/IMO).

## 7. Data Sources

### 7.1 OpenSky Network (ADS-B)

- **Endpoint:** `GET https://opensky-network.org/api/states/all` (global; no bbox needed).
- **Auth:** none. **Rate limit:** 100 requests / 5 min per IP (a 5s poll ≈ 12/min is safe
  for a single user).
- **CORS:** locked to its own origin → **must be called from the backend**.
- **Response:** `{ time, states: [ [ ...17 fields... ], ... ] }`.

State vector field indices:

| idx | field | notes |
|-----|-------|-------|
| 0 | `icao24` | hex, stable ID |
| 1 | `callsign` | padded string |
| 2 | `origin_country` | e.g. "United States" |
| 3 | `time_position` | epoch s |
| 4 | `last_contact` | epoch s |
| 5 | `longitude` | deg |
| 6 | `latitude` | deg |
| 7 | `baro_altitude` | meters, or null |
| 8 | `on_ground` | bool |
| 9 | `velocity` | m/s, or null |
| 10 | `true_track` | deg, or null |
| 11 | `vertical_rate` | m/s, or null |
| 12 | `sensors` | — |
| 13 | `geo_altitude` | meters, or null |
| 14 | `squawk` | string, or null |
| 15 | `spi` | bool (military signal) |
| 16 | `position_source` | 0 unknown, 1 mlat, 2 ads-b |

**Unit conversions (in normalizer):** velocity m/s → knots (×1.94384); altitude m → ft
(×3.28084); vertical rate m/s → fpm (×196.850). Altitude prefers `geo_altitude`, falls
back to `baro_altitude`. Heading = `true_track`.

### 7.2 aisstream.io (AIS)

- **Endpoint:** `wss://stream.aisstream.io/v0/stream` (Node `ws` client).
- **Auth:** free API key (GitHub sign-in at aisstream.io/account; shown once at creation).
  Kept in server `.env` as `AISSTREAM_API_KEY`. **No direct browser connections.**
- **Connect headers:** `APIKey`, `FilterMessageTypes` (e.g.
  `PositionReport,ShipStaticData`), optional `FiltersShipMMSI`. `permessage-deflate`
  recommended.
- **Frames:** binary WebSocket frames containing UTF-8 JSON.

Envelope (per official docs; confirm exact casing with a live capture during
implementation — the normalizer reads MMSI defensively from top-level or `metaData`):

```jsonc
{
  "MessageType": "PositionReport",   // or "ShipStaticData"
  "MMSI": 368207620,
  "ShipName": "EXAMPLE VESSEL",
  "Message": { "PositionReport": { /* fields below */ } }
}
```

`PositionReport` fields (wire PascalCase): `MessageID, RepeatIndicator, UserID, Valid,
NavigationalStatus, RateOfTurn, Sog, PositionAccuracy, Longitude, Latitude, Cog,
TrueHeading, Timestamp, Raim, …`
→ `speed = Sog` (kn), `heading = Cog` (fallback `TrueHeading`), `navStatus =
NavigationalStatus`, `lat/lon = Latitude/Longitude`.

`ShipStaticData` fields: `MessageID, RepeatIndicator, UserID, Valid, AisVersion,
ImoNumber, CallSign, Name, Type, Dimension, FixType, Eta, MaximumStaticDraught,
Destination, Dte, Spare`
→ `shipName = Name`, `aisType = Type`, `imo = ImoNumber`, `callSign = CallSign`,
`destination = Destination`.

## 8. Backend Design

Single Node process (Fastify + `@fastify/websocket` for the browser socket; `ws` client
for aisstream.io).

**Components:**
1. **OpenSky poller** — `GET /api/states/all` every `OPENSKY_POLL_MS` (5000ms). Parses
   `states` → `Craft` (domain `air`). On 429: honor `Retry-After`, back off longer. On
   network error / malformed body: log, keep last-good data, exponential backoff (capped).
   Full-snapshot semantics: an `icao24` absent from a fresh snapshot is removed after a
   30s grace (aircraft don't park silently).
2. **aisstream.io WS client** — persistent socket with `APIKey` + `FilterMessageTypes`
   headers. `PositionReport` → `Craft` (domain `sea`) joined with cached static data.
   `ShipStaticData` → cached; re-classifies + enriches any existing craft for that MMSI.
   Reconnect with exponential backoff + jitter on drop.
3. **Normalizer + classifier** — pure functions (`normalizeOpenSky`, `normalizeAis`,
   `classifyAir`, `classifySea`), no I/O, fully unit-testable.
4. **In-memory store** — `Map<id, Craft>` of latest state + a dirty set of changed IDs
   since the last broadcast.
5. **WS hub** — on client connect sends a full `snapshot`; every `BATCH_MS` (1000ms)
   flushes the dirty set as one `update`.
6. **Sweeper** — every 5s: mark `stale` when `now - updatedAt > STALE_MS`; remove from
   store + broadcast when `now - updatedAt > REMOVE_MS`.

**Wire protocol (JSON over WS):**
```jsonc
// on connect
{ "type": "snapshot", "craft": [ Craft, ... ] }
// ~1x/sec, only when something changed
{ "type": "update", "upsert": [ Craft, ... ], "remove": [ "id", ... ] }
```

**Staleness / cleanup thresholds:**
- `STALE_MS = 120000` (2 min) → `stale: true` (rendered dimmed).
- `REMOVE_MS = 600000` (10 min) → removed. Long enough that anchored vessels (which report
  as slowly as every ~3 min) are not dropped.
- Air fast-path: absent from a fresh OpenSky snapshot → removed after 30s grace.

**Config (`.env`, never bundled to the browser):**
`AISSTREAM_API_KEY`, `PORT` (8787), `OPENSKY_POLL_MS` (5000), `BATCH_MS` (1000),
`STALE_MS` (120000), `REMOVE_MS` (600000).

**REST (minimal):** `GET /health` → `{ air, sea, total, lastOpenSkyPoll, openSkyOk,
aisstreamConnected }` for debugging / the HUD.

**Run modes:**
- Dev: `npm run dev` → concurrently `tsx watch server/index.ts` (backend :8787) + `vite`
  (:5173, proxies `/ws` and `/health` → :8787).
- Prod: `npm start` → build frontend, backend serves `dist/` + WS on one port (:8787).

## 9. Frontend Design

Vite + vanilla TypeScript + MapLibre GL JS. No framework.

**Structure:**
```
shared/craft.ts        Craft, CraftKind, Domain + KINDS metadata — imported by server & client
server/                (see §8)
src/
  main.ts              bootstrap: map, WS, UI wiring
  map/map.ts           map init + dark basemap
  map/layers.ts        craft source + icon/label layers, data-driven styling
  map/icons.ts         register per-kind SVGs as MapLibre images
  data/ws.ts           WS client: snapshot/update, reconnect
  data/store.ts        client Map<id,Craft>, apply snapshot/update
  ui/panel.ts          detail panel (right, slide-in)
  ui/filters.ts        filter drawer (show/hide kinds)
  ui/hud.ts            status overlay (counts, feed state)
  style.css
```

**Basemap:** Carto `dark-matter` vector (no key); one-line swap to OpenFreeMap `dark`.

**Craft rendering:** one GeoJSON source (`craft-source`), all craft as Point features.
- **Icon layer** (symbol): `icon-image: ["get","kind"]` (images registered *named after*
  their kind → 1:1, no lookup table). `icon-rotate: ["get","heading"]` +
  `icon-rotation-alignment: "map"` (craft point along track). `icon-allow-overlap: true`.
  `icon-opacity` dims `stale` craft.
- **Label layer** (text): callsign / ship name, gated by `minzoom`.

**Zoom-dependent detail tiers:**

| zoom | what appears |
|------|--------------|
| 0–4 (world) | all craft, small icons, no labels; tiny craft (sailing/pleasure/general-air) hidden to cut clutter |
| 5–8 (region) | icons larger; name/callsign labels fade in |
| 9+ (local) | icons largest; speed + altitude sub-labels; heading tick |

Implemented via `minzoom` on label layers, zoom-interpolated `icon-size`, and a zoom-gated
`filter` for the low-zoom clutter cut.

**Click → detail panel** (right-hand slide-in): `map.on("click","craft-layer")` → feature
`id` → full `Craft` from the client store → render **everything transponded**:
- Header: kind icon + name/callsign + domain badge.
- Identity: ID (icao24/MMSI), origin country / IMO / call sign.
- Motion: lat/lon (formatted), speed, heading, altitude (air), vertical rate (air).
- Status: squawk (air), nav status (sea), on-ground (air), destination (sea).
- Freshness: time-since-last-fix + stale flag.
- Collapsible **raw** section dumping the full object.
- Optional **Follow** toggle (keeps the selected craft centered).
- Live-updates as the craft moves; click background / ✕ to close.

**Filter drawer** (top-left, collapsible): a toggle per `kind`, grouped under
**Aircraft** / **Vessels**, each with a live count (e.g. `Cargo (1 234)`). Quick actions:
All / None / Air-only / Sea-only. Toggling updates a `Set<hiddenKinds>` and applies a
MapLibre `filter` (`kind NOT IN hidden`). State persisted to `localStorage`.

**Status HUD** (top-right): total air/sea counts, feed state (OpenSky last-poll
OK/stale, aisstream connected/dropped), clock; a "reconnecting…" banner when the WS is
down.

**WS client:** connect (same-origin `/ws` via Vite proxy in dev) → apply `snapshot`
(replace store) → apply `update` (upsert/remove). On each batch,
`source.setData(buildFeatureCollection(store))` (10k points @ 1 Hz is trivial; optimize to
per-feature updates only if profiling shows it's needed). Reconnect with backoff; the
server re-sends a snapshot on reconnect.

**Icons:** ~14 hand-authored SVGs (4 air + 10 sea), one per kind, in
`src/assets/icons/`, loaded and registered via `map.addImage(kind, img)` at startup.

## 10. Error Handling

Principle: **a dead feed degrades gracefully (dimmed → empty map + HUD warning); it never
crashes the process.**

*Backend:*
- OpenSky poller: network error/timeout → log, keep last-good, backoff (capped). 429 →
  honor `Retry-After`, back off longer. Malformed body → log + skip poll. Never throws out
  of the poll loop.
- aisstream.io client: socket close/error → backoff + jitter, reconnect (continuous
  position reports resync us). Bad JSON → log + skip. Unknown message type → ignore. Bad
  API key (401) → clear log line, keep retrying, surface in `/health`.
- WS hub: a client disconnect/send-error only affects that client.
- Process: `unhandledRejection`/`uncaughtException` → log + survive where possible;
  truly fatal → exit non-zero so `tsx watch` restarts. Clean shutdown on SIGINT/SIGTERM
  (close sockets, clear timers).

*Frontend:*
- WS down → "reconnecting…" banner; keep the last-rendered map (don't clear); backoff
  retry; snapshot replaces store on reconnect.
- Missing/partial fields → panel shows "—", never throws.
- Icon load failure → fall back to a generic dot for that kind.
- WebGL context loss / tile failure → fallback message; attempt context restore.

## 11. Testing Strategy

Focus on deterministic pure logic; mock the live feeds for integration; a manual live
smoke test.

1. **Unit (Vitest, offline, fast):**
   - `normalizeOpenSky` — field mapping, unit conversion (m/s→kn, m→ft), nulls.
   - `normalizeAis` — mapping + static-data join.
   - `classifyAir` — SPI→military, airline callsign→commercial, N-number→business,
     else→general (table-driven, real callsigns).
   - `classifySea` — every AIS code bucket (table-driven).
   - Store upsert/remove + dirty set; snapshot/update builders; client-store apply;
     filter-expression builder.
2. **Integration (mocked feeds):** boot the backend against a local HTTP stub (OpenSky
   fixture) + a local WS server (aisstream.io fixture frames). Assert correct
   `snapshot`→`update` sequence, vessel-kind join, and staleness/removal (fake timers).
   No dependency on live services.
3. **Live smoke (manual checklist):** run against real feeds — craft appear, icons match
   kind, click→panel works, filters work. Documented, not CI (feeds are live +
   rate-limited).
4. **Type safety + lint:** strict TS (`tsc --noEmit`), ESLint + Prettier. One test runner
   (Vitest) covers server + client.

No DB, no auth (local tool) — nothing to test there.

## 12. Project Layout

```
Radar/
  package.json
  tsconfig.json
  vite.config.ts
  .env.example
  .gitignore
  docs/superpowers/specs/2026-09-27-transponder-map-design.md
  shared/
    craft.ts
  server/
    index.ts            bootstrap: fastify, ws hub, pollers, sweeper
    opensky.ts          OpenSky poller
    ais.ts              aisstream.io WS client
    normalize.ts        normalizeOpenSky / normalizeAis
    classify.ts         classifyAir / classifySea
    store.ts            in-memory store + dirty set
    hub.ts              browser WS hub (snapshot/update)
    config.ts           env loading
  src/
    main.ts
    style.css
    map/{map,layers,icons}.ts
    data/{ws,store}.ts
    ui/{panel,filters,hud}.ts
    assets/icons/*.svg
  test/
    normalize.test.ts
    classify.test.ts
    store.test.ts
    integration.test.ts
```

## 13. Dependencies

- **Frontend:** `maplibre-gl`, `vite`, `typescript`
- **Backend:** `fastify`, `@fastify/websocket`, `ws`, `dotenv`
- **Dev:** `tsx`, `concurrently`, `vitest`, `eslint`, `prettier`, `@types/node`,
  `@types/ws`

## 14. Setup Notes (implementation prerequisites)

- Create a free aisstream.io API key (GitHub sign-in at aisstream.io/account) and place it
  in `.env` as `AISSTREAM_API_KEY`.
- Confirm the exact aisstream.io envelope/field casing and the `FilterMessageTypes`
  header serialization with a live capture during the first integration step (the
  normalizer is written defensively per §7.2).

## 15. Future Work (explicitly out of scope now)

- Airframe-level aircraft type via adsb.fi (requires a key).
- Viewport-based server filtering for very large deployments.
- Historical replay / persistence.
- Multi-user deployment (rate-limit + key-quota engineering).
