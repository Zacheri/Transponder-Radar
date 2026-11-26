# Wave 11 — map controls + user regions (2026-11-26)

Spec: `docs/superpowers/specs/2026-11-26-map-controls-regions-design.md`.
Three SDD tasks; T1 ∥ T2 in parallel, T3 after (it owns the `main.ts`
wiring both need). Gate per task: npm test → typecheck → build.

## T1 — control row + projection toggle + layout
Files: `src/map/controls.ts` (new), `src/map/map.ts`, `src/data/projection-cfg.ts`
(new), `src/style.css`, tests (`test/map-controls.test.ts`, cfg tests).
- Custom `IControl` horizontal group (top-right): zoom −/+, compass (click
  resets bearing AND pitch; reflects rotation), globe/flat toggle. Dark
  theme, aria-labels + titles. Remove the stock NavigationControl; keep
  the compact AttributionControl.
- `projection-cfg.ts`: load/save `radar.projection` ("globe"|"mercator";
  absent/corrupt → "globe"); unit-tested like motion-cfg.
- Toggle: `map.setStyle({ ...map.getStyle(), projection: { type } })`
  (style-diff applies setProjection in 4.7.1 — no public setProjection
  exists); persists; button state reflects current projection.
- Initial projection applied on first load after map creation (one
  setStyle-diff; guard against doing it twice).
- CSS: control row top-right (12px); `.panel { top: 56px }`; attribution
  themed (panel bg, `--text` links, radius) and `bottom` offset clear of
  the timeline band, above it in z-order; `.maplibregl-ctrl-top-right`
  pointer-event sanity so the panel never covers controls.

## T2 — regions core + layers + draw FSM
Files: `src/data/regions.ts` (pure), `src/map/regions.ts` (new), tests.
NO main.ts / settings.ts / style.css / map.ts.
- Model + store: `Region {id, kind:"adsb"|"ais", b:[[minLat,minLon],[maxLat,maxLon]]}`,
  `radar.regions` parse/serialize (corrupt → []), add/remove, rect
  normalization (any drag direction), min-size guard (≈8 px → null),
  colors via one exported map (adsb `#4fc3f7`, ais `#4db6ac`).
- Layers: `region-fill` (12% alpha) + `region-outline` (1.5 px, per-feature
  color), one GeoJSON source `regions-src`; `addRegionLayers(map)` +
  `setRegionData(map, regions)` (pure setter, 0/1/N features) — style-
  validation test extended for both basemaps; inserted below `craft-icons`
  after the ais-tile outlines (same before-id chain).
- Draw FSM (`createRegionDrawer(map, kind, {onDone, onCancel})`): disables
  dragPan/dragRotate, crosshair cursor, mousedown anchor, mousemove
  preview via a `regions-preview-src` (cleared on exit), mouseup commit
  (`map.unproject` — globe + mercator), Escape/blur/tiny-drag cancel,
  always-restores cursor + gestures (single teardown). Testable against an
  injected map stub emitting mouse events.

## T3 — settings UI + boot restore + wiring
Files: `src/ui/settings.ts`, `src/main.ts`, `src/style.css` (settings-group
rows only), tests.
- "Map sections" drawer group: `+ ADS-B area` / `+ AIS area` buttons
  (armed state visible), list rows (color chip + label + span size in °,
  click = remove + persist + repaint; title says so), empty-state hint.
- main: boot-restore `radar.regions` → paint after map load; arm button →
  drawer lifecycle (re-arm switches kind); on commit → store + persist +
  repaint; settings callback idiom as existing (SettingsOpts additions).

## Rulings
- Projection switch = setStyle-diff (no 4.x public API; verified via the
  bundle's `setProjection` diff command).
- Region layers non-interactive (craft clicks never stolen); list-row
  click is the remove affordance (user ask).
- No antimeridian wrapping for v1 rects; tags carry no data behavior yet
  (walls/altitude + data-aim stay in spec §C backlog).
- Regions are client-only localStorage; server protocol untouched.
