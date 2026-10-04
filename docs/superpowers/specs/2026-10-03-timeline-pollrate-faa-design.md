# Timeline Rewind, Live Poll Rate, FAA Enrichment — Design Spec

- **Date:** 2026-10-03
- **Status:** Pending user review (design approved in chat 2026-10-03)
- **Owner:** zacheri
- **Scope:** Feature additions to the existing local app (not a new project)

## 1. Overview

Three features for the existing transponder radar:

- **A. Live poll rate** — HUD slider that changes the OpenSky poll interval in
  real time, with a credits/day warning.
- **B. Timeline rewind** — every state the server receives is snapshotted to a
  durable, size-capped history; a bottom timeline bar scrubs the map back in
  time (both aircraft and vessels) and returns to live.
- **C. FAA enrichment** — clicking an aircraft shows its exact type
  (manufacturer + model to subvariant, e.g. `737-8DR`) and year, plus the
  registered owner, from the FAA registry (US-registered aircraft only in v1).

### Superseded non-goals

`docs/superpowers/specs/2026-09-27-transponder-map-design.md` listed as
non-goals: "No airframe-level aircraft type" and "No historical replay /
persistence of positions." This spec implements both — replay at 60 s
snapshot resolution, type via the FAA registry. The original rationale
("not available from the free OpenSky feed") is resolved by the FAA bulk
database (verified available 2026-10-03).

## 2. Feature A — Live poll rate

### Behavior

- `OpenSkyPoller.setInterval(ms)` (`server/opensky.ts`): clamps to
  `POLL_MIN_MS=15000` … `POLL_MAX_MS=3600000`; stores as the poller's `pollMs`
  (replacing the constructor value). Applies from the **next scheduled cycle** —
  never interrupts an in-flight poll. `pollMs` also remains the base for
  exponential backoff (existing behavior).
- The startup value stays `config.OPENSKY_POLL_MS`; runtime changes are
  **session-only** (no persistence — the env var remains the source of truth
  for the default).
- The slider affects **aircraft only**. AIS is a stream and is unaffected; the
  UI control is labeled "Aircraft poll".

### Protocol

- Client → server: `{type:"poll.rate", ms:number}`. Invalid/absent/`ms` outside
  clamp → ignored (no error frame).
- `status` frame: `feeds.opensky` gains `pollMs:number` (current effective
  interval) so any client can render the true state.

### UI

- New `src/ui/pollrate.ts` (mounted by `main.ts` next to the HUD):
  - Label showing the current rate in seconds (e.g. `120 s`), initialized from
    the first `status` frame.
  - `<input type="range">` 30 000–900 000 ms, step 15 000. On change: send
    `{type:"poll.rate"}`, then reconcile the label from the next `status`
    frame (server is authoritative).
  - Credits/day estimate: `ceil(86_400_000 / ms) × 4`; displayed beside the
    slider. Amber above 2 000 credits/day, red above 4 000 (standard-tier
    daily budget).
- Style: matches existing HUD/panel conventions in `src/style.css`.

### Tests

- `setInterval`: clamping (below min, above max, valid), takes effect for the
  next scheduled delay (fake timers / injected `setTimeout`), backoff still
  uses the new base.
- Frame handling: valid `poll.rate` applied; malformed frames ignored.

## 3. Feature B — History cache + timeline rewind

### Storage

- `server/history.ts` — `HistoryRecorder`:
  - Every `HISTORY_SNAPSHOT_MS` (default 60 000): serialize
    `store.all()` → JSON → gzip (level 6) →
    `data/history/<epochMs>.json.gz`. `data/` is created on demand and
    gitignored.
  - **Retention:** after each write (and on boot), while total history size >
    `HISTORY_MAX_BYTES` (default **10 GB** = `10_737_418_240`), delete the
    oldest snapshot files first. The user-designated cap comes from
    `HISTORY_MAX_BYTES` in `.env`.
  - **Index:** file list (name + size) rebuilt by scanning `data/history/`
    (filenames are epoch-ms → sort = order). No separate index file, no
    decompressed in-memory snapshots — V8 object overhead makes cached
    `Craft[]` arrays far heavier than their JSON, so every seek reads +
    gunzips from disk. A 4 MB gzip read+parse is tens of ms; the OS page
    cache makes repeated scrubs over the same window fast. This bounds
    server memory to the file index regardless of retention size.
- Snapshot content is the normalized `Craft[]` — the same object shape the WS
  `snapshot` frame carries. Raw feed payloads are **not** dumped (non-goal).
- Disk write failures (full disk, permissions) → log + skip that snapshot;
  feeds keep running. The recorder must never take down the server.

### Seek semantics

- Seek to time `t` → the newest snapshot with `ts <= t`.
- `t` earlier than the oldest snapshot → clamped to the oldest.
- `t` later than the newest snapshot → clamped to the newest.
- Empty history → reply `{type:"timeline.state", time:null, craft:[]}`;
  client shows "no history yet".

### Protocol

- `status` frame gains `history: {from:number|null, to:number|null,
  snapshots:number}` (epoch ms; `from`/`to` are the oldest/newest snapshot
  times).
- Client → server: `{type:"timeline.seek", time:number}` →
  server → `{type:"timeline.state", time:number, craft:Craft[]}`.
- Client → server: `{type:"timeline.live"}` → server replies with a regular
  `{type:"snapshot", craft}` of the current live store (reuses the existing
  frame — no new live frame type).

### Rewind mode (client)

- `src/main.ts` gains a mode: `live` | `rewound`.
- While `rewound`: incoming `update` frames are **suppressed** (not applied to
  `ClientStore`). The server keeps broadcasting; suppression is client-side
  (single-user app; simplest correct behavior — logged ruling).
- `timeline.state` replaces the client store contents (same path as
  `applySnapshot`); the map re-renders through the existing `setCraftData`.
  HUD counts recompute. If the panel's selected craft is absent from the
  snapshot, the panel hides.
- `timeline.live` (via the LIVE button) clears rewind mode; the reply is a
  live `snapshot`.
- While rewound, the HUD clock shows the replayed time with a `REPLAY` badge;
  `REPLAY` also appears on the timeline bar's LIVE button state (LIVE button
  highlighted/pulsing whenever not live).

### UI — `src/ui/timeline.ts`

- Bottom bar spanning the map width:
  - Range readout: `from — to` (HH:MM:SS local) + current selection.
  - Scrubber: `<input type="range">` over `[from, to]`; drag sends seeks
    debounced ~150 ms (coalesced); the displayed time updates instantly from
    the local value.
  - **LIVE** button: requests `timeline.live`, clears rewind mode.
- Bar is inert (disabled + dimmed) while history is empty.
- Style in `src/style.css` following existing conventions.

### Tests

- Recorder (temp dir): writes gzipped snapshots; gunzip round-trips to the
  exact `Craft[]`; eviction deletes oldest first when size cap exceeded; boot
  index rebuild lists files in ts order.
- Seek: clamps early/late; picks nearest `<= t`; empty history.
- Frame handling: `timeline.seek`/`timeline.live` dispatch; malformed frames
  ignored; `status` carries `history` bounds.
- Client: rewind mode suppresses `update`; `timeline.live` restores.

## 4. Feature C — FAA type + owner (US only, v1)

### Source facts (verified 2026-10-03 by live download)

- Bulk: `https://registry.faa.gov/database/ReleasableAircraft.zip` (~73 MB;
  data refreshed daily 11:30 pm CT). Landing page:
  https://www.faa.gov/licenses_certificates/aircraft_certification/aircraft_registry/releasable_aircraft_download/
- `MASTER.txt` (~195 MB, ~317k rows). Columns used (1-based):
  1 `N-NUMBER`, 3 `MFR MDL CODE`, 5 `YEAR MFR` (≈78% populated),
  6 `TYPE REGISTRANT`, 7 `NAME` (registrant; blank when redacted per
  49 U.S.C. § 44114(b)), 10 `CITY`, 11 `STATE`, 34 `MODE S CODE HEX`
  (= icao24; 100% populated).
- `ACFTREF.txt` (~94k rows): 1 `CODE`, 2 `MFR`, 3 `MODEL` — model text at
  subvariant quality (verified rows: `737-8DR`, `737-8DV`, `A320-214`,
  `A320-211`, `UH-60A`), joined on `MASTER.MFR MDL CODE`.
- Files are comma-delimited, space-padded, BOM-prefixed; a small number of
  rows contain quoted fields → parsing must be quote-aware (no external CSV
  dep; hand-rolled, unit-tested).
- Per-click lookup: `GET https://registry.faa.gov/aircraftinquiry/Search/NNumberInquiry`
  (yields cookie + `__RequestVerificationToken`) then
  `POST .../Search/NNumberResult` with `NNumbertxt` + token; result is an HTML
  page (parser written against a saved real-response fixture).

### Bulk loader — `server/faa.ts`

- On boot: if `data/faa/MASTER.txt` + `ACFTREF.txt` missing or older than 20 h
  → download the zip (fetch → stream to disk), extract **only** those two
  entries via `yauzl` (new runtime dep + `@types/yauzl` dev dep), delete the
  zip, keep the extracted txts (~220 MB on disk).
- Then refresh every `FAA_REFRESH_MS` (default 86 400 000 = 24 h) in the
  background; a refresh failure keeps serving the stale index.
- Parse → in-memory `Map<string, FaaRecord>` keyed by lowercased 6-hex
  icao24:
  ```
  FaaRecord = {
    nNumber: string;
    year: number | null;        // YEAR MFR
    mfr: string | null;         // ACFTREF.MFR (trimmed)
    model: string | null;       // ACFTREF.MODEL (trimmed)
    owner: string | null;       // MASTER.NAME, null when blank/redacted
    city: string | null; state: string | null;
  }
  ```
  Memory ≈ 317k × ~120 B ≈ 40 MB — acceptable.
- Feed-status style surface: `faa: {state:"loading"|"ready"|"stale"|"error",
  updatedAt:number|null, aircraft:number, lastError:string|null}` added to the
  `status` frame.
- Non-US aircraft have no FAA record → `null` info (v1 scope; no other
  registries).

### Enrichment protocol (no `Craft` model change)

- `Craft` stays exactly as-is (keeps snapshots/deltas/history lean — logged
  ruling). Info travels on a side channel:
- Client → server: `{type:"aircraft.info", id:string}` (air craft only).
- Server → `{type:"aircraft.info", id:string, info: (FaaRecord &
  {source:"db"|"live"}) | null}`.
- Server resolves: in-memory index first (`source:"db"`); miss → per-click
  fallback (§4.4) — the reply may be immediate `null` or, for the live path,
  sent when the lookup resolves (client awaits; panel shows a pending row).

### Panel — `src/ui/panel.ts`

- On aircraft select: if the client's local `Map<id, info>` has the record,
  render immediately; else show pending rows and send `aircraft.info`.
- New rows (air domain only, placed after "Origin"):
  - `Type` — `"{mfr} {model}"` (trim empties) + `, {year}` when present; "—"
    when unknown.
  - `N-number` — `nNumber` or "—".
  - `Owner` — `"{owner} — {city}, {state}"` (omit location parts when null);
    "—" when unknown.
- Sea craft: no info rows, no request.

### Per-click fallback — `server/faa-lookup.ts`

Triggered only from the `aircraft.info` path when the hex is absent from the
bulk index:

1. Determine an N-number, in order:
   a. persistent enrichment cache `data/faa/enrichment.json`
      (`Map<icao24, FaaRecord>` + negative entries);
   b. craft `callsign` matching `/^N\d{1,5}[A-Z]{0,3}$/i` — export the
      existing `N_NUMBER_RE` from `server/classify.ts` for reuse (GA
      aircraft broadcast their N-number as callsign).
   No N-number → reply `info: null` (no source available).
2. Live lookup: fetch inquiry page → extract token + cookie → POST result →
   parse HTML → `FaaRecord`. "No results" → negative cache 1 h. Network/4xx/
   5xx → negative cache 1 h (no retry storms; logged ruling).
3. Success → merge into the in-memory index **and** persist to the enrichment
   cache (survives restarts; also serves as the hex→N bridge for future
   refreshes).
- Concurrency: in-flight de-duplication per N-number
  (`Map<nNumber, Promise>`); click-rate only — no bulk scraping of the
  per-click endpoint.
- PII: display only registrant name + city/state exactly as FAA publishes
  them in the releasable file; redactions (blank NAME) render "—".

### Tests

- CSV parser: BOM, space padding, quoted fields, empty trailing columns.
- Join: fixture MASTER + ACFTREF → expected `FaaRecord` (incl. missing year,
  blank owner, unknown MFR MDL CODE).
- HTML parser: against a saved real-response fixture (recorded during
  implementation; committed as `test/fixtures/faa-nresult.html`).
- Enrichment cache: positive + negative TTL, persistence round-trip.
- Loader: staleness check (fresh file skipped), refresh scheduling,
  failure-keeps-stale (stubbed fetch).
- Frames: `aircraft.info` request/reply validation.

## 5. Configuration

`.env.example` additions (all optional; defaults in `server/config.ts`):

```
HISTORY_SNAPSHOT_MS=60000
HISTORY_MAX_BYTES=10737418240
FAA_REFRESH_MS=86400000
```

`data/` (root) added to `.gitignore` — holds FAA cache, history snapshots,
enrichment cache.

## 6. File map

**New**
- `server/history.ts`, `server/faa.ts`, `server/faa-lookup.ts`
- `src/ui/timeline.ts`, `src/ui/pollrate.ts`
- `test/history.test.ts`, `test/faa.test.ts`, `test/faa-lookup.test.ts`
- `test/fixtures/faa-nresult.html` (recorded response)

**Changed**
- `server/opensky.ts` — `setInterval`, expose current `pollMs` in feedStatus
- `server/config.ts` — new env keys
- `server/classify.ts` — export `N_NUMBER_RE`
- `server/hub.ts` — `status` gains `pollMs`, `history`, `faa`
- `server/index.ts` — client→server frame dispatch (`poll.rate`,
  `timeline.seek`, `timeline.live`, `aircraft.info`); wire recorder + FAA
  modules; clean shutdown extends to them
- `src/data/ws.ts` — send control frames; handle new frame types
- `src/main.ts` — rewind mode; mount timeline + poll-rate UI; panel info hook
- `src/ui/hud.ts` — REPLAY badge + replayed-time clock
- `src/ui/panel.ts` — Type / N-number / Owner rows (pending state)
- `src/style.css` — new UI styles
- `package.json` — `yauzl` (+ `@types/yauzl` dev)
- `README.md`, `AGENTS.md` — final docs pass (incl. fixing README's stale
  "36 s anonymous poll" claim)

## 7. Error handling & degradation

- FAA download/parse failure → keep stale index; `faa.state` reflects it;
  app fully functional without FAA data (panel shows "—").
- History disk error → skip snapshot, log; live map unaffected.
- `poll.rate` malformed → ignored.
- `timeline.seek` with no history → clamped/`null` time, client shows
  "no history yet".
- FAA live lookup failure → negative cache 1 h; reply `null`.
- Nothing here may crash a feed: all new modules are best-effort with logged
  failures (matches existing app behavior).

## 8. Test strategy

- Gate after **every** task: `npm test` → `npm run typecheck` → `npm run
  build` (AGENTS.md gate; lint remains out of scope).
- New unit tests per §2–§4 above; all in Node-environment Vitest. No MapLibre
  style/layer changes → existing `test/style-validation.test.ts` pattern is
  untouched. Browser-only behavior (scrubber feel, panel rendering) is
  verified by the user in-browser.
- Integration test (`test/integration.test.ts`) extended: boot app with stub
  feeds → assert `status` carries `pollMs`/`history`/`faa`, and a
  `timeline.seek` after an injected snapshot round-trips.

## 9. Non-goals (v1)

- Non-US aircraft type/owner (other-country registries, key-gated services).
- Sub-60-second rewind resolution; event-level replay.
- Play/pause/animation playback (scrub + LIVE only).
- Per-craft trails/tracks on the map (rewind is global-state based).
- Persistence of runtime poll-rate changes (env var remains the default).
- Raw feed payload dumps (normalized `Craft` snapshots only).
- Vessel enrichment (no owner/type lookup for ships).

## 10. Execution order (sub-agent tasks, sequential)

Shared files (`server/hub.ts`, `server/index.ts`, `src/data/ws.ts`,
`src/main.ts`) make parallel work unsafe → sequential, one gate run each:

1. **A — Poll rate:** `setInterval`, frame, HUD slider, tests.
2. **B — History + timeline:** recorder, frames, rewind mode, timeline UI,
   tests.
3. **C — FAA bulk:** loader, parser, index, `aircraft.info` frame, panel
   rows, tests.
4. **D — FAA per-click:** live lookup, enrichment cache, tests.
5. **E — Docs:** README (incl. stale poll claim), AGENTS.md, `.env.example`
   already done per task.

After all tasks: full-diff code review, fixes, final gate, commit + push.
