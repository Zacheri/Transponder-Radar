# Map controls + user regions — design (Wave 11, 2026-11-26)

User-reported (browser): the detail panel covers the top-right map controls;
the compact attribution renders as a mysterious "white bar" behind the
timeline; there is no globe option at all. Feature ask: user-drawn,
click-to-remove highlight sections on the map, typed ADS-B or AIS, working
on flat, pitched, and globe views.

## A. Control row + projection toggle

- **Custom control row, top-right.** MapLibre's `NavigationControl` is a
  vertical stack and has no projection toggle (`NavigationControlOptions`
  is compass/zoom/pitch only — verified in maplibre-gl 4.7.1 d.ts). Ship a
  small custom `IControl` (`src/map/controls.ts`) rendering ONE horizontal
  group: zoom −, zoom +, compass (click = reset bearing AND pitch; always
  visible, rotation reflected), globe/flat toggle. Dark-themed to match the
  UI; keyboard-accessible buttons with `aria-label`s and `title`s.
- **Projection (corrected 2026-11-26 post-review).** maplibre-gl 4.7.1 has
  NO public `map.setProjection()`, and the style-diff route is a trap: the
  diff EMITS a `setProjection` command but `Style#setState` has no applier
  for it — the command throws a caught TypeError, `setStyle` warns and
  **full-rebuilds the style** (camera survives; sources/layers are rebuilt
  from the serialized copy; images re-add via the existing `style.load`
  registrars). `getStyle()` also never round-trips `projection` and is
  `undefined` before load. Shipped design: the Carto inline style carries
  `projection: {type}` at creation (zero boot reload); the OpenFreeMap URL
  fallback applies one `setStyle` after first load only when globe is
  wanted; the toggle no-ops until `loaded()` and requests the rebuild
  deterministically with `setStyle(copy, { diff: false })`; ALL layer/source
  setup lives in an idempotent `style.load`-registered routine so a
  projection rebuild heals the map (socket created once, outside style
  events). Full-rebuild-on-toggle is the accepted 4.7.1 cost; a future
  maplibre 5.x upgrade buys the in-place `setProjection`.
- **Detail panel drops below the row:** `.panel { top: 56px }` (12 + ~36 +
  8) so it can never occlude the controls; the controls sit at top-right
  above it (z-order: controls > panel).
- **Attribution never behind the timeline:** keep the compact control at
  bottom-right but raise it above the timeline band (`bottom` offset past
  the timeline row), give it the panel background/`--text` theme (no more
  white pill), and keep it expandable. Timeline/HUD z-order unchanged.

## B. User regions (ADS-B / AIS highlight sections)

- **Model (client-only — server untouched; pure highlight, user ruling):**
  `Region { id: string; kind: "adsb" | "ais"; b: [[minLat,minLon],[maxLat,maxLon]] }`,
  persisted in localStorage `radar.regions` (JSON array; corrupt → `[]`).
  Multiple regions of each kind. No antimeridian wrapping in v1 (plain
  min/max rectangle — logged as known gap; the boost grid has the same rule).
- **Draw tool (rectangles, user ruling):** settings-drawer group "Map
  sections" with two buttons: `+ ADS-B area`, `+ AIS area`. Arming enters
  draw mode: crosshair cursor, `dragPan`/`dragRotate` disabled (pitch kept
  via shift, like MapLibre defaults), mousedown anchors, mousemove updates
  a live preview rect, mouseup commits (drag under ~8 px = treated as a
  cancel-click), Escape or leaving the window cancels. Works on globe and
  mercator — everything goes through `map.unproject` (both projections).
  Re-arm while armed switches the pending kind.
- **Rendering:** new `src/map/regions.ts` — `region-fill` (12% alpha) +
  `region-outline` (1.5 px) layers from one GeoJSON source, per-feature
  `color` property (ADS-B = `#4fc3f7` accent blue, AIS = `#4db6ac` teal,
  through the color api idiom). Inserted directly below `craft-icons`
  (after hotzone/ais-tile outlines, before icons — same before-id chain as
  `aisTiles.ts`). Layers are non-interactive (no click handling — craft
  clicks must not be stolen). Validated via `validateStyleMin` like the
  other layer waves.
- **Click to remove (user ruling):** each region is a row in the "Map
  sections" list (color chip + "ADS-B area"/"AIS area" + size in °).
  Clicking the row removes the region and persists; the row's `title`
  says so. Empty state: hint text, no rows.
- **Restore:** boot reads `radar.regions`, paints after map load; every
  mutation re-paints + persists. Regions are independent of feed state.

## C. Explicitly NOT in scope (backlog)
- Region tags driving data (AIS → aiscast tile aim; ADS-B → pinned boost
  zone) — parked with the existing two-zone machinery as natural seed.
- "Walls" extruded to airliner altitude in 3D (user joke, logged in
  earnest): `fill-extrusion` is not supported on the globe renderer, so
  walls need either terrain-draped tricks or a 3D-only mercator mode —
  genuinely its own future wave.
- Altitude-true craft rendering. RULING (2026-11-26, user): vertical
  displacement from real altitude may ONLY be applied in globe mode — in
  pitched Mercator the offset projects against the ground plane and reads
  as wrong positions. Globe's radial-up frame is the only one where
  height-off-surface is visually honest.
- Antimeridian-straddling regions; polygon (non-rect) drawing.

## D. Testing
- Pure: region store parse/serialize (corrupt → `[]`), add/remove, rect
  normalization (drag any direction), min-size guard, kind switch.
- Setters: `setRegionData` builds 0/1/N feature FC with color props;
  style-validation test extended for both basemaps.
- Draw-mode FSM via injected map stub (arm/move/commit/cancel/Escape,
  preview source updates, cursor + dragPan restore on exit).
- Controls: toggle calls setProjection with the right literal + persists;
  compass reset pins bearing/pitch calls. DOM via the FakeEl idiom.
- Browser-only (user): globe toggle looks right, panel below controls,
  attribution dark + above timeline, drawing on globe tracks the cursor.
