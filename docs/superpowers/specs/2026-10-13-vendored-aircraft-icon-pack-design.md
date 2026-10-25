# Vendored Aircraft Icon Pack + Ships Rate Slider — Design Spec

- **Date:** 2026-10-13
- **Status:** Icon pack: implemented (pending browser verification, 2026-10-24) · ships slider: pending (separate plan)
- **Owner:** zacheri
- **Scope:** Two work items. (1) **Icon pack (architectural):** replace the
  hand-drawn 13 family silhouettes as the *primary* aircraft icon source with a
  vendored, per-model/per-type silhouette pack downloaded once at initial setup
  and kept in `data/icons/`; the 13 family icons remain the fallback layer.
  (2) **Ships rate slider (bounded, Appendix A):** a second feed-rate slider
  controlling how often vessel updates are applied to the map.

Supersedes (for art quality) the 2026-10-11 model-aircraft-icons spec: that
work's resolver structure, tables, protocol, and tests are **kept and
extended**, not rewritten. The 13 hand-drawn air SVGs stay in the repo as the
fallback layer (user-rejected as primary art 2026-10-13). Sea icons unchanged.

## 1. Overview

The 13 hand-drawn family icons read as "wrong/asymmetrical" in the browser.
Direction chosen with the user (2026-10-13): use **established, open-licensed
per-model silhouette art** — "maximum coverage" (all open sources worth using),
with **military at-a-glance identity as the priority** (E-3, C-130, C-17,
UH-60… distinguishable without opening the panel).

Coverage target: **~250–270 unique aircraft types** across three sources, plus
the existing 13 family icons as fallback for everything unmatched (any type
with no pack icon renders exactly as today — no visual regression possible).

```
craft (WS) ── server resolver ──► icon name ──► client
  kind/callsign/FAA model          pack name        lazy registration:
  (existing inputs)                or family        fetch → transform →
                                               rasterize → addImage
```

### Rulings (logged 2026-10-13)

- **R1 — Storage:** pack lives in `data/icons/` (gitignored), downloaded on
  first server start, kept locally, never re-fetched unless the dir is
  missing/corrupt or pins change. Mirrors the FAA cache pattern and the user's
  "download during initial setup and keep in the directory" phrasing.
  *Cost if wrong:* user wanted it committed to the repo → move files + delete
  download step, ~1 h.
- **R2 — Namespaced icon names:** pack icon names carry a source prefix —
  `pw:B737`, `rk:C130`, `pd:E3` — distinct from the 13 bare family names and
  the 10 sea kind names. The two SVG sets overlap on designators (and could
  disagree); namespaces make the resolver's choice explicit and keep the
  registry-collision test meaningful. *Cost:* slightly longer WS strings.
- **R3 — In-memory render transforms only:** vendored files stay byte-identical
  on disk. Line-art→fill, PNG binarize, and white→color recolor all happen at
  rasterization time in the browser (or catalog page). No derivative files are
  ever written. *Cost:* every transform edge case must be caught visually —
  the catalog page (R7) is the safety net.
- **R4 — Pack icon color by domain:** military-kind craft render pack icons in
  the military red `#ef5350`, civil-kind in the narrowbody blue `#4fc3f7`.
  The 13 family fallbacks keep their existing per-family colors (that layer is
  unchanged). Shape carries the identity; color carries the domain. *Cost:*
  loses the 4-shade civil family nuance for covered types (intentional —
  covered types are already shape-distinguished).
- **R5 — No hand-drawn gap-fill art:** the user rejected hand-drawn art as
  primary. Any type with no usable open source (possible: E-3) stays on its
  family icon and is listed as a gap on the catalog page. *Cost:* one named
  priority (AWACS) may not get a dedicated silhouette.
- **R6 — Gap-fill tier is a curated manifest:** the public-domain tier is not
  "all of Commons" — it is an explicit per-file manifest (file, URL, license,
  attribution) reviewed before download. *Cost:* manual curation of ~8–15
  files at setup time.
- **R7 — Catalog page is a first-class deliverable:** `GET /icons/catalog`
  renders every pack icon in final color/size on a dark background, with
  title, source, and license, plus the family/sea sets and the gap list. This
  is the browser-verification surface for the whole pack (one screen instead
  of watching live traffic).
- **R8 — Ships slider = server-side per-feed flush window** (not a poll rate —
  AIS is a push stream; see Appendix A). *Cost:* user may have imagined a
  different knob; the honest equivalent is documented in the UI tooltip.
- **R10 — Offline-first (user constraint 2026-10-14):** the app targets slow,
  spotty internet. **No third-party network access at runtime.** Anything
  consumable is acquired by the initial setup download (icon pack: R1) or a
  scheduled local database refresh (FAA bulk: `FAA_REFRESH_MS`, daily default,
  weekly optional for spotty connections). The browser only ever talks to the
  local server. A failed setup download retries on each start and degrades to
  family icons. *Cost:* none — the design already served local files after
  setup; this ruling pins it and adds a `npm run icons:setup` pre-warm.

## 2. Sources and licensing

| Key | Source | License | What we take |
|---|---|---|---|
| `pw` | `plane-watch/pw-silhouettes` (main, pinned commit) | CC BY-NC-SA 4.0 | `silhouettes/*.svg` (186 files; `-N` animation frames → use frame `-1`), `airframes/*.json` (metadata: ICAO designator, title) |
| `rk` | `RexKramer1/AircraftShapesSVG` (main, pinned commit) | GPL-3.0 | `Shapes SVG/*.svg` (182 files, line-art) |
| `pd` | Wikimedia Commons files, per-file manifest (R6) | Public domain (US Gov / Greg Goebel releases) etc., per-file | ~8–15 two-view silhouette PNGs for key military types missing from `pw`∪`rk` (E-3, B-2, F-14, F-117, C-5, C-141, E-4, KC-10… — final list at curation) |

Union ≈ 250–270 unique types. `pw` military coverage ≈ {F16, F100}; `rk`
covers the rest of the named list (C130, C17, H60, K35E, KC2, KC46, A10, B52,
F15, F18, F22, F35, P1, P3, P8, Q4, R135, S61, U2, UH1, V22, A400, SB39, ST75,
T38, E8, NH90, MI24, H47, H64, B1…). `pd` fills the residual gaps (R5/R6).

**License terms (accepted by user, "maximum coverage" answer 2026-10-13):**
practical obligation for this local, non-distributed, non-commercial app is
~0 (GPL triggers on distribution; NC on commercial use). Constraints if the
repo is ever open-sourced or productized are recorded in:

- `data/icons/ATTRIBUTION.md` — generated at setup: per-source license text,
  attribution, source URLs, pinned commits (R6 manifest for `pd` per-file).
- `AGENTS.md` — "Icon pack" section: sources, licenses, the constraint note,
  setup/re-pin procedure.

**Pinning:** `data/icons/pins.json` records the exact commits/files used
(`{ pw: {repo, sha}, rk: {repo, sha}, pd: [{file, url, sha256, license,
attribution}] }`). Setup re-downloads only when `pins.json` is absent or its
sha no longer matches the pinned value (explicit re-pin via
`npm run icons:repin` updates pins to source `main` — a deliberate, logged
action). No periodic refresh: silhouette sets are static.

## 3. Data layout and index

```
data/icons/                     (gitignored; R1)
  pins.json                     source pins (above)
  index.json                    built at setup (below)
  exclude.json                  vetoed names (R7), optional
  ATTRIBUTION.md                generated license/attribution record
  plane-watch/silhouettes/*.svg raw, unmodified (R3)
  plane-watch/airframes/*.json  raw, unmodified
  rk/*.svg                      raw, unmodified (renamed from "Shapes SVG/")
  pd/*.png                      raw, unmodified
```

`index.json` (built by the setup step, consumed by server + client):

```json
{
  "version": 1,
  "builtAt": "2026-10-13T…",
  "icons": [
    { "name": "pw:B737", "source": "pw", "file": "plane-watch/silhouettes/B737.svg",
      "style": "filled", "title": "Boeing 737", "license": "CC BY-NC-SA 4.0" },
    { "name": "rk:C130", "source": "rk", "file": "rk/C130.svg",
      "style": "line", "title": "Lockheed C130J-30 Hercules", "license": "GPL-3.0" },
    { "name": "pd:E3",   "source": "pd", "file": "pd/e3.png",
      "style": "gapfill", "title": "Boeing E-3 Sentry", "license": "Public Domain" }
  ]
}
```

`style` ∈ `filled` (pw art: render as-is, recolor white→domain color, keep the
author's black hairline) | `line` (rk art: Outline layer only, rendered with
`fill: <domain color>`, `stroke: none` — the outline paths are closed; the
Accent detail layer is dropped) | `gapfill` (pd two-view PNG: crop top half,
dark→opaque, white→transparent).

Name validation at setup (fail the setup step, don't write a bad index):
- unique names;
- no collision with the 13 family names, 10 sea kind names, or `tanker_air`;
- `pw:`/`rk:`/`pd:` prefix matches source; file exists and is non-empty.

`exclude.json`: `{ "vetoed": ["rk:XYZ", …], "reasons": {…} }` — names present
in the index but skipped by the server (catalog shows them badged "vetoed").
This is the user's one-screen curation control (R7).

## 4. Setup pipeline (server, first start)

`server/iconpack.ts` — `IconPack` class, wired in `buildApp` exactly like
`FaaLoader` (async init, log line, non-fatal failure):

1. `pins.json` present and verified (sha matches; files present) → load
   `index.json` → state `ready`.
2. Otherwise → state `downloading`: clone the two pinned repos
   (`git clone --depth 1 <repo> <tmp>` + checkout sha — git is a repo
   dependency; no new npm packages), fetch each `pd` manifest URL, verify
   sha256, copy into the layout above, build `index.json`, write
   `ATTRIBUTION.md`, atomically replace `pins.json`.
3. Any failure → keep whatever verified files exist; state
   `failed(<reason>)`; resolver falls back to family icons (R9 below).
   `downloading`/`failed` states are visible in the status frame + HUD.

`npm run icons:repin` (dev script, tsx): re-pins to source `main` heads,
re-downloads, logs the diff of the name set. *Not* run automatically.

Server routes (new):
- `GET /icons/:name` → raw file bytes (`image/svg+xml` / `image/png`), 404 for
  unknown/vetoed. Served in dev (proxied by Vite like `/health`) and prod
  (static route before the `dist/` fallback).
- `GET /icons/catalog` → self-contained dark HTML grid (R7): every icon in
  final color (inline-transformed: `line`→fill, `gapfill`→binarized,
  `filled`→recolor) at map size and 2× size, name + title + license; family
  and sea sets included; gap list (target military types with no icon) at the
  top. No dependencies; generated from `index.json` + the 23 committed SVGs.
- `GET /icons/list` → `{ names: string[] }` (client preflight; also how the
  client learns what exists).

Status frame gains `icons: { state: "ready"|"downloading"|"failed"|"absent",
count: number, updatedAt: number | null }` (mirrors the `faa` block). HUD
shows e.g. `Icons: 263` / `Icons: loading…` / `Icons: offline (families only)`.

## 5. Resolver changes (`server/icons.ts`)

Signature extends with an optional pack set (existing behavior unchanged
without it — the ~150 existing table tests keep passing unmodified):

```ts
resolveAirIcon(args: {
  kind: AirKind; callsign: string | null;
  faaModel: string | null; faaMfr: string | null;
  pack?: ReadonlySet<string>;   // pack icon names, from IconPack (empty if absent)
}): string
```

- **Military path:** the existing token table's entries gain an optional
  `pack` name alongside the current family: `{ re, pack?: "rk:C130",
  family: "transport" }`. Resolution: `pack` given and `entry.pack ∈ pack` →
  return `entry.pack`; else the entry's family (current behavior). Tokens get
  pack names for every military type available in the sets (C130, C17, E3→
  `pd:E3` when present, UH60→`rk:H60`, KC135, A10, F15/F16/F18/F22/F35, P3,
  Q4/MQ9, U2, B52, A400, KC46, V22, NH90, MI24, …). Letter-suffixed tokens
  (`UH60A`, `C17A`, `F16C` — parked minor from the 2026-10-11 review) are
  fixed here as a side benefit: token regexes anchor the base (`UH60\w*`).
- **Civil path:** the existing ordered model table's entries gain an optional
  `pack` designator name (preferring `pw:` art, `rk:` where `pw` lacks the
  type): `{ mfr?, re, pack?: "pw:B738", family: "narrowbody" }`. Same
  resolution rule. Table curation (data-driven, offline): cross the union
  name set against `data/faa/ACFTREF.txt` model strings (available in the
  dev environment) and write one rule per covered designator; uncovered long
  tail → family as today. Expected: ~150–200 rules with a `pack` name.
- **Fallbacks:** unchanged — `KIND_FALLBACK_ICON[kind]`.
- `buildApp` wiring: `resolveIcon` now passes `iconPack.names()` (empty set
  when the pack is absent/failed).

## 6. Client changes

- `src/map/icons.ts` keeps `registerIcons` (the 23 static icons, eager,
  unchanged). New `ensurePackIcons(map, names: string[])`:
  1. For each name not in `map.hasImage` and not in the in-flight set:
     fetch `GET /icons/<name>` (dev: Vite proxy; prod: same origin).
  2. Transform per `style` (R3, in memory): `line` → string-edit the SVG
     (keep first visible layer, `fill:none`→`fill:<color>`, drop
     `stroke:#000000`, drop accent layer); `gapfill` → `<img>` → crop top
     half → threshold (dark→opaque); `filled` → render as-is.
  3. Rasterize into a **fixed 96×96 box** (preserveAspectRatio, centered) so
     every pack icon shares one canvas size → uniform on-map scale; pixel
     recolor step for `filled`: pixels with R,G,B ≥ 200 and alpha > 0 become
     the domain color (military `#ef5350` / civil `#4fc3f7`, R4), author's
     black hairline kept.
  4. `map.addImage(name, imageData, { pixelRatio: 2 })`; cache `ImageData` in
     a module-level `Map<name, ImageData>`; on `style.load` (basemap
     fallback / any future setStyle), re-add every cached name (images are
     lost on style change).
  5. Failures (404, decode, empty raster) → name goes to a failed set; never
     throws, never blocks the frame.
- `src/data/features.ts`: after `ensurePackIcons`, any craft whose `icon` is a
  pack name in the failed set is re-emitted with its family fallback
  (`c.icon` recompute from kind) — same rule covers timeline-rewound
  snapshots referencing pack names that no longer resolve (R9).
- `src/main.ts`: second `createFeedRate` instance (Appendix A) + status
  restore for both sliders; HUD icon count line.
- Icon filter drawer, layers, and panel: unchanged (`["get", "icon"]` works
  for pack names exactly as for family names).

## 7. Degradation matrix (R9)

| Situation | Behavior |
|---|---|
| Pack absent (never downloaded / offline first start) | All aircraft render family icons — byte-identical to today |
| Pack `failed` after partial download | Only verified names resolve; others → family |
| Single icon 404/broken at runtime | That craft → family icon (client failed set) |
| Timeline rewind, snapshot predates pack | Snapshot `Craft.icon` values are family names (old snapshots) → family icons; no fetches |
| Timeline rewind, snapshot contains pack names, name since vetoed/missing | Family fallback per §6 |
| AIS craft | Never carry a pack icon (AIS sets no icon) — unchanged |

No user-visible state is worse than today in any row.

## 8. Testing (TDD, offline)

- `store` (Appendix A): `drainDirty(domain)` per-domain drain.
- `hub` (Appendix A, fake timers): air flushes on its window, sea held until
  its window, combined single frame, `setAisFlushMs` live + clamped.
- `parseClientMessage`: accepts `feed: "ais"`, rejects unknown feeds.
- `iconpack`: setup from fixtures (tiny inline SVG/PNG set — no network):
  index build + validation (collision/family/sea-name tests), pin verification
  (bad sha → re-download path → `failed` without throwing), `exclude.json`
  filtering, `status()` shape.
- `icons` (resolver): new tests — pack name emitted when `pack` set contains
  it, family fallback when absent, `pack: undefined` ≡ old behavior (existing
  ~150 tests untouched and green); letter-suffixed military tokens.
- client `recolorPixels` / binarize / line-transform: pure functions over
  plain arrays/strings — unit-testable in Node (extracted from the DOM
  code): white→color with alpha preserved, black hairline kept, threshold
  edge cases, first-layer-only extraction.
- `features`: failed pack name → family fallback property.
- style-validation test: unchanged (layer defs untouched).
- Registry test: updated — asserts the 23 static names, pack-name prefix
  convention, and no air/sea/family collision against a fixture index.
- Browser-only verification (user): catalog page pass (all pack icons, final
  color, dark background) + live-map spot check of the named military list.

## 9. Docs

- `AGENTS.md`: new "Icon pack" section (sources + licenses + constraint note,
  `data/icons/` layout, setup/re-pin, catalog URL, exclude file, R1–R9);
  "Ships slider" note in the WS protocol section (`feed` ∈
  `["opensky","ais"]`, `ais.flushMs` in status); `data/icons/` added to the
  `data/` cache description.
- `.gitignore`: `data/icons/` (covered by existing `data/` entry — verify).
- This spec + plan under `docs/superpowers/`.

---

## Appendix A — Ships rate slider (bounded work item)

**Semantics (R8):** AIS is a live push stream — there is no poll interval to
tune. The slider controls **how often vessel position updates are applied to
the map** (server-side per-feed flush window). The stream keeps receiving
everything; the store keeps updating; the broadcast to clients for sea craft
is coalesced over the chosen window. Label: "Ship updates N s" with tooltip
"Vessel stream is continuous; this is how often the map applies vessel
updates."

**Server:**
- `HubOpts`: `aisFlushMs?: number` (default = `batchMs`). Internals: tick
  every 250 ms (`TICK_MS`); per-feed `lastFlush` timestamps; on tick, drain
  `store.drainDirty("air")` when the air window (`batchMs`, unchanged) is due
  and `store.drainDirty("sea")` when the sea window is due; broadcast one
  combined `update` frame (as today) with whatever drained.
- `store.drainDirty(domain: "air" | "sea")` — dirty sets filtered by
  `craft.domain` (field already exists).
- `hub.setAisFlushMs(ms)` — clamped to `[500, 15000]`, live.
- `FEED_IDS = ["opensky", "ais"]`; `feedRate.ais = (ms) => hub.setAisFlushMs(ms)`.
- Status: `feeds.ais.flushMs` (slider restore on reload).

**Client:** second `createFeedRate` instance — label "Ship updates",
min 500 / max 15000 / step 500 / default 1000, no credits line (AIS free key
has no documented credit model). Wired in `main.ts` exactly like the OpenSky
instance (send `feed.rate` with `feed: "ais"`; restore from status).

**Tests:** per §8 hub/store/protocol items. Browser check (user): slider to
15 s → vessels step visibly; back to 1 s → smooth; aircraft slider unaffected;
page reload restores both positions.

**Non-goals:** no client-side render throttle (server coalescing is the knob);
no change to AIS subscription/keepalive; no per-vessel smoothing/interpolation.
