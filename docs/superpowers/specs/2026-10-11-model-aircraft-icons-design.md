# Model-Driven Aircraft Icons — Design Spec

- **Date:** 2026-10-11
- **Status:** Pending user review (design approved in chat 2026-10-11)
- **Owner:** zacheri
- **Scope:** Feature change to the existing app — aircraft icons become
  model-driven (shape family), with kind-based fallbacks

## 1. Overview

The four aircraft icons are not representative of the aircraft they depict:
`commercial` and `business` are near-identical generic jet shapes; `military`
and `general` are literal star/dart shapes with no airframe resemblance.

This change makes every aircraft icon represent its **shape family**
(narrowbody jet, fighter, single-engine prop, …), resolved server-side from
model data where it exists:

- **US-registered civil aircraft** — FAA bulk registry model code
  (e.g. `737-8DR`, `G650`, `C172N`), already in memory as the `FaaProvider`
  index (icao24-hex → `FaaRecord`).
- **Military aircraft** — callsign tokens (military callsigns routinely encode
  the type: `C130`, `KC135`, `F16`…; military aircraft are not in the FAA
  registry).
- **Everything else** (all non-US aircraft — OpenSky's live feed carries no
  model data) — kind-based fallback.

Approved scope (2026-10-11): the model-driven set **and** the redrawn
category fallbacks land in one pass. Sea icons are unchanged.

### Ruling

Icon **color follows the shape family, not the kind** (except families that
are inherently kind-specific: bizjet/bizheli are the business light blue, all
military families are the military red). Consequence: a US C172 broadcast as
`N12345` is classified *business* (N-number heuristic) but renders the gray
`piston` silhouette — shape truth over color convention. The filter drawer,
HUD, and panel continue to use `kind`.

## 2. Icon set (13 air families, approved)

All 24×24, top-down, nose-up (icons rotate by heading), single-path fills in
the existing style. Distinguishability at ~12 px (zoom 0) is the design
constraint.

| Image name | Silhouette | Family coverage | Color |
|---|---|---|---|
| `narrowbody` | single-aisle jet, twin engines, conventional tail | 737, 757, A318/319/320/321, E170/175/190/195, CRJ, MD80/82/88/90, B717, DC9, BAe 146, Fokker 100/70, Saab 340, F28 | `#4fc3f7` |
| `widebody` | widebody, four engines, long fuselage | 747, 767, 777, 787, A330, A340, A350, A380, MD11, IL-96, TU-204, AN-124 | `#4fc3f7` |
| `turboprop` | prop disc + wing, utilitarian fuselage | ATR42/72, DHC-6/8, C208, PC-12, D228, Saab 2000, F27, YAK-40 | `#4fc3f7` |
| `bizjet` | slim jet, long nose, T-tail | Gulfstream (G150/280/550/650), Citation (C5xx/6xx), Challenger (CL6xx), Falcon (F50/F7X), Learjet, Phenom (P28/35), Hawk (M9xx) | `#81d4fa` |
| `bizheli` | heavy/executive helicopter | R66, B407/B429/B52/B76, AW139/AW169, S76/S92/S202/S300 | `#81d4fa` |
| `piston` | high-wing single, tailwheel/tricycle prop | C150/152/172/180/182/185/206/210/310, DA20/40/42, SR20/22, B25/36/58, L18, ASK | `#90a4ae` |
| `heli` | light helicopter | R22/R44, K120/K135, EC120/130, H125/135/145, B206 | `#90a4ae` |
| `fighter` | swept/delta wing, pointed nose, single fin | F-15/16/18/22/35, Typhoon, Rafale, MiG, Su; fallback for unknown military | `#ef5350` |
| `attack` | straight wings, stub wings, twin fins | A-10 | `#ef5350` |
| `transport` | boxy high-wing, four turboprops | C-130, C-17, C-5, A400M, C-21, VC-25 | `#ef5350` |
| `tanker` | widebody + belly refueling boom | KC-135, KC-10, KC-46 | `#ef5350` |
| `isr` | long slender fuselage; E-3 rotodome | E-3, P-3, RC-135, U-2, EP-3, TACAMO, RQ-4 (GRIFIN), MQ-9 (REAPER) | `#ef5350` |
| `milheli` | heavy/attack helicopter | CH-47, CH-53, AH-64, UH-60/MH-60, BLACKHAWK | `#ef5350` |

**Kind fallbacks** (no model data — all non-US aircraft, SPI-only military,
unknown codes): `commercial → narrowbody`, `business → bizjet`,
`military → fighter`, `general → piston`. Sea: `icon = kind` (unchanged).

The four existing air SVGs (`commercial.svg`, `business.svg`, `military.svg`,
`general.svg`) are **deleted**; the 10 sea SVGs are untouched.

## 3. Resolution logic — `server/icons.ts` (new)

```ts
// shared/craft.ts gains: export type AirKind = Extract<CraftKind,
//   "commercial" | "business" | "military" | "general">;

export const AIR_FAMILY_ICONS: string[];                    // the 13 names
export function resolveAirIcon(args: {
  kind: AirKind;            // typed to the air union — sea kinds cannot be passed
  callsign?: string;
  faaModel?: string | null; // FaaRecord.model, e.g. "737-8DR"
  faaMfr?: string | null;   // FaaRecord.mfr,   e.g. "BOEING"
}): string;               // MapLibre image name
```

Rule order (first match wins):

1. **Military kind** → callsign token table (see §3.1). No table hit →
   `fighter`.
2. **FAA model present** (civil only) → ordered rule table (see §3.2). No
   table hit → kind fallback (§2).
3. **Kind fallback.**

### 3.1 Military callsign table

Callsign is uppercased and tokenized. Word-boundary matching; where a token is
a valid prefix of a real variant (`E3` → E-3G, `P3` → P-3C, `U2` → U-28), a
**prefix** match (no trailing boundary) is used. Order is significant:

| Priority | Tokens (regex, word-anchored) | Icon |
|---|---|---|
| 1 | `KC135`, `KC10`, `KC46`, `KCTC` | `tanker` |
| 2 | `CH47`, `CH53`, `UH60`, `UH6`, `MH60`, `SH60`, `H60`, `AH64`, `BLACKHAWK` | `milheli` |
| 3 | `A10` | `attack` |
| 4 | `C130`, `C17`, `C5`*, `C21`, `A400M`, `VC25`, `C40` | `transport` |
| 5 | `RC135`, `EP3`, `E3`, `P3`, `U2`, `TACAMO`, `AWACS`, `GRIFIN`, `REAPER`, `MQ9`, `RQ4` | `isr` |
| 6 | `F15`, `F16`, `F18`, `F22`, `F35` | `fighter` |
| — | any other military kind (incl. SPI, squadrons: EAGLE, RAPTOR, TIGER, BANDIT…) | `fighter` (fallback) |

\* `C5` is word-anchored so `C130`/`C550` cannot match it; `C17` is anchored
so `C172` (a Cessna, never military-kind) cannot match. Squadrons/nicknames
that do not encode a type are deliberately **not** mapped (they fall back to
`fighter`); no speculative guessing.

### 3.2 FAA model table

Normalization: uppercase, strip spaces and hyphens (`737-8DR` → `7378DR`,
`UH-60A` → `UH60A`, `ATR 72-600` → `ATR72600`).

Rules are an **ordered list** of `{ mfr?: RegExp, re: RegExp, family: string }`
— `mfr` (when present) is a case-insensitive substring test on the normalized
`FaaRecord.mfr`; `re` tests the normalized model. First match wins; helicopter
rules come **before** fixed-wing rules.

Minimum coverage (every one of these model codes must resolve as shown —
these are the table's unit-test cases; the implementation may add further
codes):

- **helis** → `bizheli` or `heli` (split by size class, model-driven — the
  resolver does not consider kind):
  - `bizheli`: `R66`, `B407`, `B429`, `B52`, `B76`, `AW139`, `AW169`, `S76`,
    `S92`, `S202`, `S300`
  - `heli`: `R22`, `R44`, `K120`, `K135`, `EC120`, `EC130`, `H125`, `H135`,
    `H145`, `B206`
  - Defensive (should not occur for civil kind): `CH47`, `CH53`, `UH60`,
    `AH64` → `milheli`
- **bizjet**: `G150`, `G280`, `G550`, `G650`; `C500`, `C510`, `C525`, `C550`,
  `C560`, `C680`; `CL600`, `CL650`; `F50`, `F7X` (+`F70` when mfr DASSAULT);
  `L420`, `LJ35`, `LJ45`, `L100`, `L200`; `P28`, `P35`; `M900`, `M1000`
- **widebody**: `747`, `767`, `777`, `787`; `A330`, `A340`, `A350`, `A380`
  (incl. subvariant suffixes `A332`…`A388`); `MD11`, `IL96`, `TU204`, `AN124`
- **narrowbody**: `737`, `757`; `A318`, `A319`, `A320`, `A321` (incl.
  `A320214`-style subvariants); `E170`, `E175`, `E190`, `E195`; `CRJ`;
  `MD80`, `MD82`, `MD88`, `MD90`; `B717`; `DC9`; `146`; `F100` and `F70`
  (mfr FOKKER); `S340` (mfr SAB); `F28` (mfr FOKKER)
- **turboprop**: `AT42`, `AT72` (or `ATR` prefix); `DHC6`, `DHC8`; `C208`;
  `PC12`; `D228`; `S200` (mfr SAB); `F27` (mfr FOKKER); `YAK40`
- **piston**: `C150`, `C152`, `C172`, `C180`, `C182`, `C185`, `C206`, `C210`,
  `C310`; `DA20`, `DA40`, `DA42`; `SR20`, `SR22`; `B25`, `B36`, `B58`; `L18`

Required disambiguations (each has a dedicated test):

| Trap | Resolution |
|---|---|
| `F70` | DASSAULT mfr → `bizjet`; FOKKER mfr → `narrowbody`; no mfr → `bizjet` (default when ambiguous) |
| `S202` vs `S200` | SIKORSKY mfr → `bizheli`/`heli`; SAB mfr → `turboprop`. Mfr required: `S2xx` without mfr → no match → kind fallback |
| `L410` vs `L420` | `L410` (LET motor glider/prop) → `piston`; `L420`/LJ (LEARJET mfr) → `bizjet` |
| `C208` | → `turboprop` (never piston, despite the `C2xx` Cessna pattern) |
| `F28` vs `F27` | `F28` (mfr FOKKER) → `narrowbody` (it is a jet); `F27` (mfr FOKKER) → `turboprop` |

## 4. Wiring

- `shared/craft.ts`:
  - `Craft` gains `icon?: string` (MapLibre image name; **optional** so old
    history snapshots and existing test fixtures remain valid).
  - New shared type `AirKind` and constant `KIND_FALLBACK_ICON:
    Record<AirKind, string>` (the §2 fallback table) — single source of
    truth used by both the server resolver and the client fallback (§5).
- `server/opensky.ts`: `OpenSkyPollerOpts` gains
  `resolveIcon?: (c: Craft) => string`. In the `pollOnce` loop, after
  `normalizeOpenSky`, the poller sets `c.icon = this.opts.resolveIcon?.(c) ?? c.kind`.
  (Icon is set post-normalization — `normalize.ts` is untouched.)
- `server/index.ts`: when a `faa` provider exists, passes
  `resolveIcon: (c) => resolveAirIcon({ kind: c.kind, callsign: c.callsign, faaModel: faa.lookup(c.id)?.model ?? null, faaMfr: faa.lookup(c.id)?.mfr ?? null })`
  (one lookup call, cached in a local). No `faa` → no resolver → `icon = kind`.
- **FAA still loading:** `lookup` returns null → kind fallback icons; every
  aircraft is re-upserted each poll (default 120 s), so icons upgrade within
  one poll interval with no re-sync mechanism.
- AIS path: the server sets **no** `icon` on vessels; the client's sea
  branch (§5) returns `kind`, so ships keep their kind icon.
- History: old snapshots carry no `icon` → client falls back (§5). New
  snapshots carry `icon` (a few bytes per craft; snapshots stay lean — no
  model string is broadcast).

## 5. Client

- `src/data/features.ts`: feature property gains
  `icon: c.icon ?? (c.domain === "air" ? KIND_FALLBACK_ICON[c.kind] : c.kind)`
  — server-set icon wins; air without icon (old snapshots) → kind fallback;
  sea → `kind`.
- `src/map/layers.ts`: `"icon-image": ["get", "kind"]` → `["get", "icon"]`.
- `src/map/icon-urls.ts`: 13 new air family SVG imports + existing 10 sea
  imports = 23 entries; the 4 old air SVGs are removed from the map and
  deleted from `src/assets/icons/`.
- Filter drawer, panel, HUD, replay gate: unchanged (all `kind`-based).

## 6. SVG authoring constraints

- 24×24 viewBox, nose up, centered; single `<path>` with one fill (existing
  style); no strokes (they vanish at 12 px).
- Silhouettes must remain distinguishable at 12 px: rely on gross shape
  (wing planform, tail count, prop discs, rotor disc, boom) over detail.
  `isr`'s E-3 rotodome and `turboprop`'s prop disc are the two licensed
  details.
- The browser is the only visual verification path (repo convention) — expect
  a user tuning round after the first draw.

## 7. Testing

- `test/air-icons.test.ts` (new, table-driven):
  - every §3.1 military token (incl. order traps: `KC135` → tanker not
    transport; `C172`-style non-matches; prefix variants `E3G`, `P3C`).
  - every §3.2 minimum-coverage code and all five disambiguation traps.
  - fallbacks: unknown model, no model, military SPI without callsign.
  - sea kinds never enter the resolver (type-level; no test needed).
- `test/icons.test.ts` (rewritten): 10 sea kinds 1:1 with registered images;
  all 13 `AIR_FAMILY_ICONS` registered with non-empty URLs; every
  `KIND_FALLBACK_ICON` value is a registered name; no image-name collisions
  between air families and sea kinds.
- `test/poller.test.ts` (extended): poller applies `resolveIcon` to each
  normalized craft; absent resolver → `icon = kind`.
- `test/features.test.ts` (extended): `icon` property = `craft.icon` when
  present; fallback via `KIND_FALLBACK_ICON` when absent.
- `test/integration.test.ts` (extended): the existing fixture plane `ac4963`
  (fakeFaa model `737-8DR`, mfr `BOEING`) must arrive with `icon ===
  "narrowbody"` in the snapshot; a vessel keeps `icon === <kind>`.
- `test/style-validation.test.ts`: untouched pattern still validates
  (`icon-image` via `["get", "icon"]` is expression-valid).
- Gate after every task: `npm test` → `npm run typecheck` → `npm run build`.

## 8. Error handling & degradation

- FAA index absent/loading/error → all aircraft get kind-fallback icons; app
  fully functional (icons are cosmetic; never a feed blocker).
- Unknown/ambiguous model code → kind fallback (never a crash, never `null`).
- Client receiving a `Craft` without `icon` (old snapshot/rewind) →
  `KIND_FALLBACK_ICON` fallback; a `Craft` whose kind is sea → `kind`.
- No new runtime dependencies.

## 9. Non-goals (v1)

- Vessel icon changes (AIS types already map 1:1 to representative icons).
- Non-US civil model data (no other registries — same v1 ruling as FAA
  enrichment).
- Per-variant distinction beyond shape family (a 737-700 and 737-900 share
  `narrowbody`; that is the legible limit at icon scale).
- Client-side model display changes (panel already shows `mfr model year`).
- Icon rotation/animation beyond the existing heading rotation.

## 10. File map

**New**
- `server/icons.ts` (resolver + tables)
- `src/assets/icons/{narrowbody,widebody,turboprop,bizjet,bizheli,piston,heli,fighter,attack,transport,tanker,isr,milheli}.svg`
- `test/air-icons.test.ts`

**Changed**
- `shared/craft.ts` — `Craft.icon?`, `KIND_FALLBACK_ICON`
- `server/opensky.ts` — `resolveIcon` opt + application
- `server/index.ts` — wire resolver to FAA provider
- `src/data/features.ts` — `icon` property
- `src/map/layers.ts` — `icon-image` from `icon`
- `src/map/icon-urls.ts` — 13 new entries, 4 removed
- `test/icons.test.ts` (rewrite), `test/poller.test.ts`, `test/features.test.ts`,
  `test/integration.test.ts` (extend)
- `AGENTS.md` — icon section (family-based air icons, resolver, tables)

**Deleted**
- `src/assets/icons/{commercial,business,military,general}.svg`

## 11. Execution order (sequential — shared files make parallel unsafe)

1. **Resolver:** `server/icons.ts` + `KIND_FALLBACK_ICON` + `test/air-icons.test.ts`
   (TDD: tables first).
2. **Wiring:** `Craft.icon?`, poller opt, `index.ts` wiring, poller test,
   integration assertion.
3. **Assets:** 13 SVGs, `icon-urls.ts`, deleted files, registry test rewrite.
4. **Client:** `features.ts`, `layers.ts`, features test, style validation.
5. **Docs:** AGENTS.md pass.
6. Full gate, in-browser icon review with the user (expect shape tuning),
   commit + push.
