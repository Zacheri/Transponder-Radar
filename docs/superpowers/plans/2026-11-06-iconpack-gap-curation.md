# Plan — Icon Pack Gap Curation + Variant Precision

- **Spec:** `docs/superpowers/specs/2026-11-06-iconpack-gap-curation-design.md` (approved 2026-11-06)
- **Date:** 2026-11-06
- **Gate after every task:** `npm test` → `npm run typecheck` → `npm run build`
- **Papertrail (AGENTS.md rule 18):** `~/Documents/BCP/ML/ML_Docs/Radar/2026Nov06-1.md` — caveman shorthand, updated as tasks land.

## Ruling: spec R6 amended (client pipeline)

Spec R6 says the client pipeline is not modified. All sourced plan-view art
lives on multi-view sheets (top view in an arbitrary quadrant, never the top
band), so gap-fill needs **rectangle crops**, not top-band ratios, plus one
per-entry `style` override (a filled SVG) and a GIF content-type sniff.
R6 is amended to allow exactly those changes in `src/map/pack-icons.ts`,
`server/icons-catalog.ts`, and the `/icons/list` payload. Everything else in
R6 stands: no new routes, no feature/layer changes, offline-first, no new
packages. Cost if wrong: one more client file in review than the spec
promised — the feature pipeline itself is untouched.

## Verified curation data (2026-11-06, all files fetched + visually inspected)

Staged under `$TMPDIR/opencode/iconpack-curation/` (re-fetched during Task 3;
shas below are of the Commons bytes and are stable).

| name | source (Commons file) | bytes | license | attribution | crop {x,y,w,h} | style |
|---|---|---|---|---|---|---|
| pd:CH47 | Boeing_Vertol_CH-47_Chinook_3-view_line_drawing.png (574×385) `https://upload.wikimedia.org/wikipedia/commons/0/07/Boeing_Vertol_CH-47_Chinook_3-view_line_drawing.png` | `dd8cbe47eef479a8fb015da8da6a91a52ff6bd606f275069f8c3a3eb42e7aa63` | Public domain | U.S. Air Force (NASA 3-view series) | {0.02, 0, 0.40, 1} | gapfill |
| pd:MQ9 | MQ-9_Reaper_dimensioned_sketch.png (1000×800) `https://upload.wikimedia.org/wikipedia/commons/d/d8/MQ-9_Reaper_dimensioned_sketch.png` | `bcd51e5ebc16c87a413eb483fffdd1b0ec6be93f88898267a44e426c5f5f0943` | Public domain | Tomáš Hruška | {0.33, 0.17, 0.66, 0.70} | gapfill |
| pd:CH53 | Sikorsky_CH-53E_Super_Stallion_Drawing.svg (881×441) `https://upload.wikimedia.org/wikipedia/commons/1/15/Sikorsky_CH-53E_Super_Stallion_Drawing.svg` | `e27339b3e0342b863b49a225213e62f5b0189160c133eac6f49602e265d2be51` | CC BY 3.0 | Jetijones | {0, 0, 0.53, 0.99} | gapfill |
| pd:E6 | Boeing_707-300_v1.0.png (2422×1600) `https://upload.wikimedia.org/wikipedia/commons/2/2c/Boeing_707-300_v1.0.png` | `191e864123fdaef374bd38a403e758278d2d0b1e46b4e4a340920b2069e337f2` | CC BY-SA 3.0 | Julien.scavini | {0, 0.25, 0.48, 0.63} | gapfill |
| pd:MD8 | McDonnell_Douglas_MD-82_v1.0.png (1888×1644) `https://upload.wikimedia.org/wikipedia/commons/1/1d/McDonnell_Douglas_MD-82_v1.0.png` | `7729b43de903b373237f605f5c2698600ec350d4dfd8ca2261f5d647b1956d17` | CC BY-SA 3.0 | Julien.scavini | {0.56, 0, 0.43, 0.62} | gapfill |
| pd:ATR72 | ATR_family_v1.0.png (1188×1044) `https://upload.wikimedia.org/wikipedia/commons/3/38/ATR_family_v1.0.png` | `b61abe4c9213bd1f8da93b44ffb43ed7e0463b5992ec081989ec91bc4dfa0383` | CC BY-SA 3.0 | Julien.scavini | {0, 0.22, 0.52, 0.58} | gapfill |
| pd:B200 | Beechcraft_B200_King_Air_3-view_line_drawing.gif (3030×1757) `https://upload.wikimedia.org/wikipedia/commons/a/aa/Beechcraft_B200_King_Air_3-view_line_drawing.gif` | `ae2e15e56323f34f611110916ae402ab1752fecfbbeaac7cb9db1cdc4d01d52a` | Public domain (NASA EG-0057-01) | NASA | {0, 0, 0.50, 0.99} | gapfill |
| pd:737C | Boeing_737-300_silhouette.svg (320×320) `https://upload.wikimedia.org/wikipedia/commons/3/3e/Boeing_737-300_silhouette.svg` | `3fd32335c775f5179ed5982e507c87ec4e99e721bf1c738feeec535331aa58cb` | CC BY-SA 4.0 | Peter James Lowden | {0, 0, 1, 1} | **filled** |

Per-entry verification notes (spec R3):

- **CH47** — top view = left column (twin counter-rotating rotordisks,
  sponsons, tail skids); front top-right, side bottom-right. PD beats the
  CC-BY SVG twin of the same drawing.
- **MQ9** — top view = right half (slender fuselage, V-tail, winglets);
  side view left. "dimensioned sketch" by Hruška — the only proper drawing
  found.
- **CH53** — top view = left half (7-blade rotordisk, twin tailbooms, stub
  wings); front top-right, side bottom-right. CH-53E = the US service
  standard; rule token is CH53 (covers all variants).
- **E6** — 707-300 sheet, top view = bottom-left quadrant (152'11" length
  label). E-6B is a 707-320 with **no rotodome** (masts only) — the top view
  is the plain 707 planform, correct by construction. Title reads "Boeing
  E-6 TACAMO (707-300 planform)".
- **MD8** — top view = top-right (32m82 = 32.82 m label = MD-82; T-tail,
  rear nacelles). One art covers the whole `^MD[89]` / `^DC9[89]` family:
  the MD-90 is the same airframe with new engines. Left column = DC-9-10 /
  B717 / MD-87 / MD-90 side views (unused).
- **ATR72** — top view = middle-left (27m17 label ✓ ATR 72). The sheet's
  ATR-42 top view (middle-right) is **misproportioned** (sheet labels it
  22.67 m; real ATR 42 = 19.55–19.92 m) → rejected, OmittedModels.
- **B200** — top view = left half (T-tail, tail-mounted twin nacelles);
  front top-right, side bottom-right. B200/B300 share this airframe.
- **737C** — full image is one closed filled path (fill #ccffff = near-white
  → rides the existing `recolorPixels` path; that is why it needs
  `style: "filled"` instead of the gapfill threshold). 737 Classic with
  winglets — used for the 737-600 (same Classic family, +3.5 m).

Registry facts verified against `data/faa/ACFTREF.txt` (2026-11-06):

- MD-8x codes are `DC-9-8x(MD-8x)` (mfr MCDONNELL DOUGLAS / DOUGLAS / BOEING)
  and `MD-90-30` (mfr BOEING) — normalize to `DC982(MD82)` / `MD9030`; the
  current `^MD(8|9)` catch never sees the former and misses the latter
  (BOEING mfr not in the catch list).
- 737-600 codes: `737-600`, `737-66N`, `737-6Q8`, `737-683` → `^7376`.
- ATR-72 codes: `ATR-72-201`, `ATR-72-212`, `ATR72-212`, `ATR72` (mfrs
  vary: AEROSPATIALE, ATR-GIE, even "AIR") → no mfr constraint.
- King Air: `B200`, `B200C`, `B200CT`, `B200T`, `B300` (mfr BEECH…) →
  `^B(200|300)`. No B360 code exists.
- `C-295` (mfr AIRBUS DEFENSE AND SPACE S A) exists. `C-160`'s only code is
  a **balloon** — do not wire rk:C160. No PC-21, AN-28/AN-12, F100, F70,
  BD700, CL600-2A12/B19/2C1/2D, A330-7/8, E2 E-Jet, Agusta A140/148/158,
  TU204 codes → those pack names stay in the pack but unreachable (no rules).
- L-410 codes exist (`L-410-UVP`, `L-410-UVPE`, mfr LET) → OmittedModels.
- Challenger 600 codes exist (`CL600-2B16(CL601-3A…`) → OmittedModels.
- Pack title confirmations (`data/icons/index.json`): rk:B737 = "Boeing
  737-700", rk:B748 = "Boeing 747-800", rk:P3 = "Lockheed P-3 Orion",
  rk:R135 = "Boeing RC-135", rk:C295 = "C-295 Persuader", rk:B1 fast/slow,
  rk:TOR fast/slow, rk:F5 = "F5 (Northrop F-5 Tiger 2)", rk:T38, rk:LYNX,
  rk:HAWK = "BAe Hawk", rk:Q4 = "RQ-4 Global Hawk". `pd:E3`/`pd:CH47` are
  NOT in the index (dangling refs, gated by pack.has → family today).

## Phase 1 — pipeline: rectangle crop, per-entry style, GIF

### Task 1 — `crop` rectangle through the stack

Files: `server/iconpack-sources.ts`, `server/iconpack.ts`, `server/index.ts`
(/icons/list), `server/icons-catalog.ts`, `src/map/pack-icons.ts`,
`test/iconpack-sources.test.ts`, `test/iconpack.test.ts`,
`test/integration.test.ts`, `test/icons-catalog.test.ts`.

Steps:
1. **Failing tests first.**
   - `iconpack-sources.test.ts`: export a shape-checker (or test via
     `loadIconSources` on temp files): entry with `crop` passes; entry with
     BOTH `crop` and `cropTopRatio` throws; entry with NEITHER throws; crop
     coords outside [0,1] or w/h ≤ 0 throw. Update the real-manifest loop
     test (currently asserts `cropTopRatio` in (0,1]) to
     "`cropTopRatio` in (0,1] **or** `crop` well-formed".
   - `iconpack.test.ts`: fake-transport pd source with `crop` →
     `entry.crop` equals it; with `cropTopRatio: 0.5` → `{x:0,y:0,w:1,h:0.5}`.
   - `integration.test.ts`: `/icons/list` entries carry `crop` (replace the
     `cropTopRatio` assertions).
2. `iconpack-sources.ts`: `CropRect` interface; `PdSourceEntry` gains
   `crop?: CropRect`, `cropTopRatio` becomes optional; `pdEntryShape`
   enforces exactly-one + range.
3. `iconpack.ts`: `PackIconEntry.crop?: CropRect` (drop `cropTopRatio`);
   buildIndex pd loop normalizes (crop wins, else `{0,0,1,r}` from
   cropTopRatio).
4. `index.ts` /icons/list: emit `crop: e.crop` (drop `cropTopRatio`).
5. `icons-catalog.ts`: `CatalogCell.crop?: CropRect`; gapfill preview uses
   the rectangle — 84×84 box with the data-URL as `background-image`,
   `background-size: (100/w)% (100/h)%`, `background-position: (x/(1-w))%
   (y/(1-h))%` (0% when w or h is 1); full-image entries render as today.
6. `pack-icons.ts`: `ListEntry.crop?: CropRect`; `rasterizeGapfill(url,
   crop, color)` draws `[crop.x·w, crop.y·h, crop.w·w, crop.h·h]` (no crop →
   full image). Everything else unchanged.
7. Gate.

### Task 2 — per-entry pd `style` + GIF sniff

Files: `server/iconpack-sources.ts`, `server/iconpack.ts`,
`shared/pack-transforms.ts`, `test/iconpack.test.ts`,
`test/pack-transforms.test.ts`.

1. Tests: pd entry `style: "filled"` → `entry.style === "filled"`; omitted →
   `"gapfill"`; `style: "line"` throws; `sniffImageType` on `GIF89a` bytes →
   `"image/gif"`.
2. `iconpack-sources.ts`: `style?: "gapfill" | "filled"` + check.
3. `iconpack.ts`: buildIndex pd loop `style: e.style ?? "gapfill"`.
4. `pack-transforms.ts`: `sniffImageType` detects `GIF8` → `"image/gif"`
   (extend the return union); comment noting pd:B200 is a GIF.
5. Gate. (The /icons/catalog builder already branches on `style` — a
   `filled` pd entry rides the SVG preview path unchanged.)

## Phase 2 — curate the 8 `pd:` entries

### Task 3 — manifest entries

File: `server/iconpack-sources.json`, `test/iconpack-sources.test.ts`.

1. Add the 8 entries from the table above (each with `title`, `license`,
   `attribution`, exact `url`, `sha256`, `crop`; 737C adds `style`
   `"filled"`). Titles (R3): `Boeing CH-47 Chinook`, `General Atomics
   MQ-9 Reaper`, `Sikorsky CH-53E Super Stallion`, `Boeing E-6 TACAMO
   (707-300 planform)`, `McDonnell Douglas MD-8x/MD-90`, `ATR 72
   (-200/-212)`, `Beechcraft King Air 200/300`, `Boeing 737 Classic
   (737-300 silhouette; used for the 737-600)`.
2. `gapTargets`: add `CH47`, `CH53`, `MQ9`, `E6` (coverage tracking — they
   drop off the catalog gap list once wired + indexed; `E3`, `B2`, `F14`,
   `F117`, `E4` remain as the standing gap list).
3. Extend the real-manifest test: 11 pd entries, all fields non-empty,
   sha256 64-hex, exactly one of crop/cropTopRatio.
4. Gate.

### Task 4 — download, verify, index, eyeball

1. `npm run icons:setup` (or start the server — the init download path
   re-fetches all pd files; pins changed, so this is the full download).
   Any sha mismatch = manifest byte drift: recompute from the downloaded
   file, fix the manifest sha, record in the papertrail.
2. `data/icons/index.json` → 289 entries (281 + 8); `pins.json`/
   `ATTRIBUTION.md` regenerated.
3. **Eyeball handoff (user):** `GET /icons/catalog` — every new cell shows
   its top view inside the 84px box, correct aircraft. Crop values above
   are from inspected files, not estimates; adjust only on visible
   mis-crop (record final values in the papertrail).

## Phase 3 — resolver rules (TDD, one test per rule)

Test pattern (existing, `test/icons.test.ts`):
`resolveAirIcon({ kind, callsign, faaModel, faaMfr, pack: new Set([...]) })`
→ expected pack name; pack absent → family fallback.

### Task 5 — military table

File: `server/icon-tables.ts` (MILITARY_RULES), `test/icons.test.ts`.

Pack wiring on existing tokens (pack name, art title confirming the
airframe):

| token | pack | why correct |
|---|---|---|
| `CH53` | `pd:CH53` | new art, CH-53E standard |
| `REAPER` | `pd:MQ9` | REAPER = MQ-9 callsign |
| `MQ9` | `pd:MQ9` | new art |
| `TACAMO` | `pd:E6` | TACAMO = E-6 callsign |
| `KCTC` | `rk:R135` | KCTC = USN KC-135 variant; art = RC-135 (same C-135 airframe, as the KC135 rule already uses) |
| `C21` | `rk:B737` | C-21A = 737-700 derivative; art = "Boeing 737-700" |
| `C40` | `rk:B737` | C-40 = 737-700/800-based; art = 737-700 (closest confirmed) |
| `VC25` | `rk:B748` | VC-25A = 747-8F airframe; art = "Boeing 747-800" |
| `EP3` | `rk:P3` | EP-3E = P-3C airframe |

New tokens (art exists; callsign-driven best effort):

| token | pack | family |
|---|---|---|
| `\bB1\w*\b` word | `rk:B1 fast` | attack (bombers sit in attack per the B52 precedent) |
| `\bF5E\w*\b` word | `rk:F5` | fighter |
| `\bT38\w*\b` word | `rk:T38` | fighter |
| `\bLYNX\w*\b` word | `rk:LYNX` | milheli |
| `\bHAWK\w*\b` word | `rk:HAWK` | fighter |
| `\bTOR\w*\b` word | `rk:TOR fast` | fighter (also matches "TORNADO" callsigns — intended) |

Place new tokens beside their family section. Update the header comment:
uncovered designators are now exactly `E3, B2, F14, F117, E4`; the
"non-designator tokens stay family-only" list loses KCTC, CH53, C21, VC25,
C40, EP3, TACAMO, REAPER, MQ9 (GRIFIN, AWACS remain family-only — see
OmittedModels: RQ-4 art is the wrong airframe for the MQ-4C; E-3 has no
rotodome art). One resolver test per row (15). Gate.

### Task 6 — civil table

File: `server/icon-tables.ts` (CIVIL_RULES), `test/icons.test.ts`.

| rule (placement) | pack | matches (normalized) |
|---|---|---|
| `{ mfr: ["BOEING"], re: /^7376/ }` after the 7375 rule | `pd:737C` | 737600, 73766N, 7376Q8, 737683 |
| `{ mfr: ["MCDONNELL","DOUGLAS","BOEING"], re: /^DC9[89]\d/ }` **before** the `^DC9` catch | `pd:MD8` | DC982(MD82), DC983, DC981(MD81)… |
| existing `^MD(8|9)` catch: add `BOEING` to mfr + `pack: "pd:MD8"` | `pd:MD8` | MD9030 (BOEING) |
| `{ re: /^ATR72/ }` after the ATR725 rule | `pd:ATR72` | ATR72201, ATR72212, ATR72 (mfr varies — no constraint) |
| `{ mfr: ["BEECH","TEXTRON"], re: /^B(200|300)/ }` after the `^B?350` rule | `pd:B200` | B200, B200C, B200CT, B200T, B300 |
| `{ mfr: ["AIRBUS"], re: /^C295/ }` (turboprop section) | `rk:C295` | C295 |

Update the "no-art gap list" comment to post-curation reality (see Task 8
for the canonical list). One resolver test per rule (6). Gate.

### Task 7 — gap-list coverage

Files: `server/icons-catalog.ts` (DESIGNATOR_ALIASES if needed — not
needed: locals CH47/CH53/MQ9/E6 equal their designators),
`test/icons-catalog.test.ts` or `test/icons.test.ts`.

Test `coveredDesignators` with the post-curation index: E6, CH47, CH53, MQ9
covered via the new rules; E3, B2, F14, F117, E4 uncovered → the catalog
gap list renders exactly those five. Gate.

## Phase 4 — docs

### Task 8 — OmittedModels.md

File: `~/Documents/BCP/ML/ML_Docs/Radar/OmittedModels.md` (outside the repo,
never committed — spec R5). One entry per variant, fields: FAA-code form +
human name / rule it lands on + fallback family / reason / what was
searched (sources + queries + best rejected candidate) / date 2026-11-06.

Entries:

1. **E-3 Sentry** (E3 prefix token + AWACS callsign) → isr. No top-view art
   showing the rotodome in any checked source. Searched: Wikimedia Commons
   full-text (multiple query forms, drawing file types), DVIDS (search API
   dead; fact-sheet "graphics" are photos), af.mil fact sheets (403),
   Julien.scavini v1.0 sheet series (military types absent), DPLA (API
   error). Best rejected: none with a rotodome plan view.
2. **B-2 Spirit** (B2 token) → attack. Searched as #1. Best rejected: DVIDS
   6003921 B-2 "infographic" — a photo, not a drawing.
3. **F-14 Tomcat** (F14) → fighter. Searched as #1; photos only.
4. **F-117 Nighthawk** (F117) → fighter. Searched as #1; photos only.
5. **E-4B Nightwatch** (E4) → isr. Searched as #1; photos only.
6. **737 MAX 7** (codes `737-7M2` / `^7377[A-Z0-9]*M` guard) → narrowbody.
   Only 737 NG art exists (no split-scythem winglets — the MAX
   distinction); rejected per R3.
7. **DC-9** (codes `DC-9`, `DC-9-10`, `DC-9-11`, `DC-9-30` — the non-MD
   series) → narrowbody. The scavini MD-82 sheet carries a DC-9-10 **side**
   view only (no top view); all other Commons files are photos.
8. **Challenger 600/604/605** (code `CL600-2B16(CL601-3A…`) → bizjet. The
   Commons "C-21A 3-view" is a mislabeled Learjet 35A; rest photos.
9. **ATR 42** (codes `ATR-42-320` etc.) → turboprop. The scavini ATR sheet's
   ATR-42 top view is misproportioned (sheet label 22.67 m vs real
   19.55–19.92 m) — rejected per R3; do not wire if re-found on that sheet.
10. **L-410** (codes `L-410-UVP`, `L-410-UVPE`) → existing `^L410` rule
    (piston family — pre-existing classification, unchanged). Photos only in
    every checked source.
11. **MQ-4C Triton** (GRIFIN callsign) → isr. `rk:Q4` (Global Hawk) rejected:
    different airframe (fuselage 18.6 m vs 14.5 m; wingspans ≈ 40 m but
    planforms differ).

Footer section — verified NOT in the US registry (no rule possible; pack
art stays in the pack, unreachable): Fokker F-100/F-70, Antonov An-12/An-28,
A330-700/800, Embraer E2 (E190-E2/E290/E390), Agusta/Leonardo A140/148/158,
Il-62, Tu-204, King Air 360 (no `B360` code), PC-21, C-160 (only code is a
balloon), Challenger 300/850 (`BD700` codes absent — the existing
`^BD7002 → rk:GL5T` rule is therefore dead; left untouched per scope).
Gate (docs only — run anyway).

### Task 9 — AGENTS.md + comment refresh

Files: `AGENTS.md` (Aircraft icons + Icon pack sections),
`server/icon-tables.ts` (comments done in Tasks 5–6).

AGENTS.md: gap list → the five standing military gaps + OmittedModels.md
pointer (path); pipeline notes: rectangle `crop` (back-compat with
`cropTopRatio`), per-entry pd `style`, GIF sniff; color-picker section
(after Phase 5). Gate.

## Phase 5 — per-category map color picker (approved phase 2)

Owner decisions (2026-11-06): General default `#90a4ae` (gray), Commercial
default `#ffd500` (yellow); business/military keep `#81d4fa`/`#ef5350`;
sea kinds keep their current SVG fills as defaults; all 14 kinds get
pickers.

Default color table (sea fills read from `src/assets/icons/*.svg`;
`other.svg` inspected at task time):

| kind | default | kind | default |
|---|---|---|---|
| commercial | #ffd500 | cargo | #ffb74d |
| business | #81d4fa | tanker | #ff8a65 |
| military | #ef5350 | passenger | #4dd0e1 |
| general | #90a4ae | military_vessel | #e57373 |
| | | fishing | #aed581 |
| | | sailing | #ba68c8 |
| | | pleasure | #f06292 |
| | | tug_work | #fff176 |
| | | service | #a1887f |
| | | other | (svg fill) |

### Task 10 — color state + color-key helper

Files: `shared/craft.ts`, `src/data/icon-colors.ts` (new),
`test/shared-craft.test.ts`, `test/icon-colors.test.ts` (new).

1. `shared/craft.ts`: `DEFAULT_KIND_COLORS: Record<Kind, string>` (table
   above); `colorKey(name: string, hex: string): string` → `name@hex`;
   `parseColorKey(key: string): { name: string; hex: string | null }`
   (splits on the LAST `@`; validates hex when present — throws otherwise).
2. `src/data/icon-colors.ts`: localStorage `radar.iconColors` (kind →
   `#rrggbb`); `loadIconColors(): Partial<Record<Kind, string>>`,
   `saveIconColors`, `effectiveColor(kind, state)` → override ?? default,
   `setKindColor(kind, hex | null)` (null = back to default; drops the key).
   Pure where possible (storage injected) so it is unit-testable.
3. Tests: colorKey/parse round-trip + bad-hex throw; load/save/effective
   with a stubbed storage. Gate.

### Task 11 — color-keyed registration (client)

Files: `src/map/icons.ts`, `src/map/pack-icons.ts`, `src/data/features.ts`,
`src/main.ts`, `test/features.test.ts`.

1. `features.test.ts` first: the feature `icon` property is
   `colorKey(base, effectiveColor(kind))` for air (base = `c.icon ??
   KIND_FALLBACK_ICON[kind]`) and sea (base = kind).
2. `features.ts`: pass a `colorFor: (kind) => string` into feature building;
   `icon: colorKey(base, colorFor(kind))`.
3. `icons.ts`: family/sea registration becomes lazy + color-keyed —
   `ensureKindIcons(map, keys)`: for each `base@hex`, rasterize the base SVG
   once (cache per base), **repaint all alpha>0 pixels** to hex (family/sea
   silhouettes are single-color — full repaint, not recolorPixels),
   `addImage(base@hex)`. Drop the startup 23-name registration (or keep it
   registering defaults — pick the simpler: lazy only).
4. `pack-icons.ts`: cache refactor to **pre-color** rasters: line →
   `lineSvgToFill(text, "#ffffff")` → rasterize (no recolor); filled → raw
   rasterize (no recolor); gapfill → ink-mask (white-tinted). Registration
   of `base@hex`: `recolorPixels(precolor, hex)` (or the gapfill tint pass)
   → `addImage(base@hex)`. `ensure()` now receives color-keyed names. The
   `/icons/list` `color` stays (catalog + default only).
5. `main.ts`: wire state → `colorFor`; on color change → coalesced feature
   refresh (existing path) so icons re-key live.
6. Gate. (Canvas/browser behavior = user browser verification; the
   keying/state logic is unit-tested.)

### Task 12 — sidebar pickers + reset

Files: `src/ui/filters.ts`, `src/style.css`.

Per category row: swatch (effective color) + native `<input
type="color">` + reset button (↺, clears to default). Change →
`setKindColor` → persist → refresh. CSS: compact, no overlap with existing
drawer layout (the ship slider overlap rule, memory #3, still holds —
pickers live in the kind rows, not the slider strip). Browser handoff:
change a color → icons repaint live; reload → persisted; reset → default.
Gate.

### Task 13 — final docs + handoff

Files: `AGENTS.md`, `docs/superpowers/specs/…` (status → implemented
pointer), papertrail.

AGENTS.md color-picker section: state module, color-key convention
(`name@hex`, last-@ split), defaults table, repaint-vs-recolor distinction.
Full handoff checklist for the user:

1. `npm run dev` → HUD `Icons:` count = 289 after setup.
2. `GET /icons/catalog` — eyeball the 8 new cells + the 9 re-wired
   military/civil ones (the accuracy surface).
3. Live map: a CH-53/E-6/TACAMO/MD-8x/ATR-72/King-Air-200/737-600 if any
   are up; wired military tokens (Tornado, T-38, Hawk, Lynx, F-5E, B-1).
4. Color picker: repaint, persistence, reset, no layout regressions.
5. `OmittedModels.md` complete (11 entries + registry-absent footer).

## Out of scope (restated)

Sea icon art; new art sources; upstream repin; WS protocol changes; the
resolver's fallback logic; vendored file modification; the pre-existing
L-410 piston-family classification (recorded, not changed).
