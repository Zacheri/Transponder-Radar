# Hot-zone boost — credit-funded densest-cluster polling — design

Date: 2026-11-22 · Status: draft for user review
Papertrail: `ML_Docs/2026Nov20-1.md` · Wave 7 of the Nov-20 review package.
Research (binding): `ML_Docs/research/zone-polling.md` · Memory #49.

## Problem

The globe poller refreshes everything at one cadence; the user can't make
dense traffic (or the categories they care about) refresh faster without
paying the full global price per call. Live measurement (2026-11-20) killed
per-craft polling: an `icao24`-filtered `/states/all` call costs the FULL 4
credits (global price) — per-aircraft boost is impossible by credit law,
not by effort. What IS cheap: a bounding box ≤25 sq° costs 1 credit. All
`/states` calls share one 4,000/day standard-tier bucket, and the default
90 s globe poll already consumes 3,840/day — so zone polling must be funded
exclusively from surplus the user creates (by slowing the globe) and guarded
by the live credit header, or coverage dies by midnight.

Feature (from the approved brief): when aircraft of user-checked categories
are present, the densest cluster's area gets **increased polling up to a
user-set interval** and is **highlighted on the map**.

## Rulings (user-approved 2026-11-22)

1. Scope A: full boost + highlight (not visual-only, not behind a master
   toggle). The credit guard IS the feature.
2. Exactly ONE hot zone — the densest cluster. Multi-zone = backlog.
   (Delivered 2026-11-26 by wave 10: up to two non-overlapping zones,
   densest first, second funded only from surplus left after zone 1.)
3. Boost funding: surplus only. `surplus = remaining − reserve − 100` where
   `reserve` = globe polls still due before the next UTC midnight × their
   live per-call cost. Boost never touches reserve.
4. Sea kinds excluded (AIS streams live; nothing to boost). Air kinds only.
5. Dateline: the cluster grid never wraps, and zone boxes clamp at ±180 —
   a straddling traffic pattern simply competes as two clusters (each side
   boosted on its own merits).
6. Per-craft boost: impossible (memory #49) — documented here so nobody
   re-derives it.

## Requirements

- R1 — Zone poll costs exactly 1 credit: box area ≤25 sq° enforced at zone
  construction (5°×5° cap; no antimeridian wrap).
- R2 — Credit-safe by construction: scheduler arithmetic is pure and fully
  unit-tested; with no `X-Rate-Limit-Remaining` seen yet, boost is OFF
  (zero surplus assumption). Boost can never delay or replace a globe poll.
- R3 — User controls: checkbox row (air kinds, kind-colored) + boost-interval
  slider 10–120 s (default 30 s) — both persisted client-side (localStorage,
  like `radar.viewSel`); no new server settings.
- R4 — Hysteresis: zone forms at ≥2 matching craft, persists at ≥1, expires
  after 5 min without members. Zone geometry (the broadcast copy) moves only
  when the cluster centroid drifts >0.5° in either axis.
- R5 — Highlight renders strictly under craft icons (above trail layers);
  fill color = dominant checked-kind color, same palette as the icons/filter.
- R6 — Zone replies merge through the existing normalize→store→broadcast
  path (boosted craft are indistinguishable downstream; history records them
  like any update).
- R7 — 429 from a zone call uses the existing backoff ladder and pauses
  boost for its duration; a zone call never retries.
- R8 — No new npm packages. Gate green. Map/HUD rendering user-verified (R6
  convention).

## Design

### A. Zone engine — `server/hotzones.ts` (pure)

```ts
interface ZoneMember { id: string; kind: AirKind; lat: number; lon: number }
interface HotZone { center: { lat: number; lon: number }; halfW: number; halfH: number
                    count: number; dominantKind: AirKind; kindCounts: Record<AirKind, number> }
planZone(members: ZoneMember[], now: number, prev: HotZoneState | null):
  { zone: HotZone | null; state: HotZoneState }
```
2° grid clustering (non-wrapping grid; boxes clamp at ±180, so the dateline
can only split clusters, never break the box rule) from the store's air
craft filtered by checked kinds (server keeps the checked-kinds set from the
client frame; empty set = inactive). Densest cell neighborhood (cell + 8
neighbors) = cluster; box = centroid ± covering members, capped halfW/halfH
≤2.5°; ties → later input order wins (deterministic). Hysteresis state
(`lastMembersAt`, the broadcast-geometry copy) lives in the poller closure;
`planZone` is pure in/out.

### B. Scheduler — `server/hotzones.ts` (same module, pure)

```ts
budgetFor(creditsRemaining: number | null, now: number, globePollMs: number,
          globeCost: 1|2|3|4): { surplus: number }        // null/NaN remaining -> surplus 0
zoneIntervalFor(requestedMs: number, surplus: number, secondsToUtcMidnight: number): number | null
          // requested, stretched so zoneCallsUntilMidnight <= surplus
          // (floor 120000), null = paused. Credits reset at midnight, so
          // spending ALL of surplus before midnight is fine — reserve in
          // budgetFor already protects today's globe; nothing carries over.
```
`reserve = ceil(secondsToUtcMidnight / globePollMs) × globeCost + 100`.
Scheduler re-reads `globePollMs` and the latest header every cycle (the
slider moves). `creditsRemaining` does NOT exist yet in the poller (spec
draft assumption corrected during planning — the `/states` bucket has no
capture today; only `routes.ts` reads it for the flights bucket): Task 2
adds the capture in `pollOnce` following the `routes.ts:217-218` idiom
(present + finite → store; else keep previous).

### C. Poller integration — `server/opensky.ts`

State: `zoneNow: { kinds: Set<AirKind>, boostMs: number }` (set by the frame
handler), `zone: HotZone | null`, `zoneState`, `zoneTimer` slot. The globe
setTimeout chain is untouched; zone ticks run on their own `setTimeout`
(re)armed after every zone poll or state change: due-and-funded → bbox call
`bbox(minLon,minLat,maxLon,maxLat)` on the SAME authed path, same
normalize→store.upsert; not funded → skip tick, recheck at next globe
response (header updates there); zone gone → clear + geometry-off. Boost
status exposed via `feedStatus.boost: { active: boolean; count: number
; intervalMs: number | null; paused: "credits" | null } | null`.

### D. Frames + status

```
client → { type:"zones.config", kinds: AirKind[], boostMs: number }  // full replace, validated
server → status.feeds.opensky.boost = ... (C) and status.hotzone =
          { center, w, h, count, kind } | null   // broadcast-geometry copy (R4 hysteresis)
```
Frame validation: `kinds` array ⊆ AIR_KINDS (dedup), `boostMs` finite and
clamped [10000, 120000]. Hub union + validator + index.ts switch + client
sender/mirror (the usual mirrors; no reply frame). Status blocks are additive
(old clients ignore).

### E. Client — checkbox row, slider, highlight, HUD

- Filter drawer (`src/ui/filters.ts`) gains a "Boost zones" section: four
  air-kind checkboxes tinted with their kind color + the interval slider;
  on change → `sendZonesConfig(...)` + persist to localStorage
  `radar.zonesCfg`; restored at boot BEFORE first status.
- Highlight: `hotzone-fill` GeoJSON polygon layer from `status.hotzone`
  (rounded-corner not needed — plain rect at 18% opacity, dominant-kind
  fill, 1 px stroke); inserted above `flight-*` layers, below `craft-icons`
  (style-validated via `test/style-validation.test.ts` like all layer work).
- HUD: extends the OpenSky segment: ` · Boost: 4 @30s` / ` · Boost paused`.
- Client never sees credits math — it renders `boost`/`hotzone` fields.

## Failure modes

- Never-authed / header-less: surplus 0 → boost never fires; HUD shows
  nothing (paused is a state of an ACTIVE checkbox row with zero surplus —
  shows `paused`).
- User slows/stops the globe mid-boost → reserve recomputed next cycle;
  boost auto-stretches/pauses accordingly.
- Zone members all land under a globe tick anyway — boost is a pure latency
  improvement, never a data dependency; killing boost mid-zone leaves the
  craft on globe cadence with zero special handling.
- Stale `zones.config` kinds include a kind that vanishes → cluster empty →
  the zone holds until 5 min after the last member was seen (the hysteresis
  clock starts at the last sighting, then expiry is immediate on its
  deadline).
- Both hemisphere browsers connected (single-user app): last config wins —
  same posture as `ais.tile`.

## Testing

- `test/hotzones.test.ts` — clustering (grid, densest-tie determinism, cap
  at 5°×5°, hysteresis create/hold/expire, dateline box clamp); scheduler
  table (surplus math incl. null/NaN header, midnight reserve at slider
  extremes, stretch floor, pause boundary).
- `test/opensky.test.ts` extend — zone tick interleaving with counting stub
  fetch (1-credit bbox param correctness; never-due-when-paused; 429 pauses
  boost for backoff duration; zone clear on empty kinds).
- `test/hub.test.ts` / `test/ws.test.ts` — frame validation matrix +
  byte-exact sender; status blocks additive on legacy.
- Client: `filters` drawer shim test (checkbox/slider → send + persist +
  restore), `hotzone` feature builder unit, HUD boost segment states.
- Manual (user): check Military over a busy region → rect appears, HUD
  boost segment, Network log shows bbox calls at slider rate while globe
  continues; slow the globe slider → boost survives; globe fast + boost fast
  → `Boost paused: credits`; uncheck → zone gone within one cycle.

## Out of scope (backlog)

Multi-zone (delivered 2026-11-26 by wave 10); sea kinds; per-craft (impossible — R-list citation); server-side
persistence of zones config; using `/tracks/all` bucket for trail-adjacent
polling; adaptive requested-interval from remaining-craft-count; dateline
split boxes.
