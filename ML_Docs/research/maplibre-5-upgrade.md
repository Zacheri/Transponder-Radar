# MapLibre GL JS 4.7.1 → 5.x upgrade impact report

Date: 2026-11-27 · Scope: docs-only research, no source edits.
Goal: real globe rendering. Verdict up front: **upgrade to `maplibre-gl@5.24.1`**
(npm dist-tag `latest-5`), devDependency `@maplibre/maplibre-gl-style-spec`
`^20.4.0` → `^24.8.1`. Skip 6.x (evaluated in §5). Expected code churn is
small — every maplibre API this app touches is unchanged in 5.x — and the
upgrade *deletes* our largest shipped workaround (the full-style-rebuild
projection toggle in `src/map/controls.ts`).

## 0. Verified baseline (local evidence, 2026-11-27)

- `node_modules/maplibre-gl` = **4.7.1** (`package.json` pins `^4.5.2`),
  `@maplibre/maplibre-gl-style-spec` = **20.4.0** (devDependency).
- `grep -c 'isGlobe' node_modules/maplibre-gl/dist/maplibre-gl.js` → **0**;
  `grep -c 'setProjection' node_modules/maplibre-gl/dist/maplibre-gl.d.ts` →
  **0**. 4.7.1 has no globe renderer; the style-level `projection` key is
  type-valid even at style-spec 20.4.0 (`"projection"?: ProjectionSpecification`,
  installed `dist/index.d.ts` line 512) but silently ignored at runtime — the
  exact trap documented in `src/map/controls.ts` lines 8–19.
- `maplibre-gl@5.24.1` (fetched via unpkg, `dist/maplibre-gl.d.ts`) exposes
  `getProjection(): ProjectionSpecification` and
  `setProjection(projection: ProjectionSpecification): this` on `Map`, plus a
  Style-level `setProjection`/`_setProjectionInternal` (the applier 4.x lacks,
  so the style-diff trap is fixed) and the `projectiontransition` event.
- npm dist-tags: `latest-5 = 5.24.1`, `latest = 6.19.0`.

## 1. INVENTORY — every maplibre API in `src/`, and its 5.x status

Only `src/map/map.ts` imports maplibre at runtime (`import maplibregl from
"maplibre-gl"` + `import "maplibre-gl/dist/maplibre-gl.css"`); the other nine
`src/map/*.ts` files use `import type maplibregl from "maplibre-gl"` (type-only,
erased). No file outside `src/map/` + `src/main.ts` touches the API.

| API (occurrences in src/) | Where | Breaking in 5.0/5.x? |
|---|---|---|
| `new maplibregl.Map({container, style, center, zoom, attributionControl:false})` | map.ts:19 | **No.** `MapOptions` still has no `projection` field at 5.24.1 (verified in the 5.24.1 d.ts `MapOptions` block) — inline-style projection remains the constructor path. `style` now *honors* `projection`. |
| `map.on(...)` ×13 — `click` (map + `"craft-icons"` layer), `mouseenter`, `mouseleave`, `move`, `moveend`, `mousedown/mousemove/mouseup`, `load`, `style.load` | main.ts, controls.ts, regions.ts, icons.ts, pack-icons.ts | **No** for us. v5.0.0 changed `on()`'s return to a `Subscription` (breaking only for `map.on('x').on('y')` chaining — we have zero chained calls, and all return values are discarded). Event strings unchanged. |
| `map.off(...)` ×4 | controls.ts, regions.ts | No. |
| `map.once("style.load"/"load")` ×2 | main.ts:578–579, regions.ts:155 | No. `style.load` still fires per style application. |
| `map.getStyle()` ×2, `map.setStyle(style, {diff:false})` ×2 | controls.ts:88/96/148/150 | **No API change — but both uses become unnecessary** (see §6). v5 fixes the underlying issue: style-spec 24 defines the `setProjection` diff operation (d.ts `DiffOperations`), and v5's `Style` implements the applier (`setProjection`/`_setProjectionInternal`), so the 4.x "diff emits setProjection, applier throws, silent full rebuild" trap is gone. |
| `map.isStyleLoaded()` ×2 | controls.ts | No. |
| `map.addSource` ×5 / `getSource(...)` ×10 as `GeoJSONSource` → `setData(fc)` | layers.ts, trackLayers.ts, hotzone.ts, aisTiles.ts, regions.ts | No. `setData(data)` single-arg form unchanged in 5.x (the `waitForCompletion` second param survives in 5.x; only v6 removes it). |
| `map.addLayer` ×5 / `getLayer` ×11 (incl. `beforeId` inserts) | layers.ts, trackLayers.ts, hotzone.ts, aisTiles.ts, regions.ts | No. |
| `map.setFilter` ×3, `map.setLayoutProperty` ×1 | layers.ts, playback | No. `setPaintProperty` is not used. |
| Filters: `["in",["get","kind"],["literal",…]]`, `["any",[">=",["zoom"],5],["!",[...]]]` | src/data/filter.ts (validated by style tests) | No. All modern expressions; the v5 `geometry-type` change was reverted in 5.0.1 and we never used it. The `["!", op]` gotcha behaves the same in v5 (the legacy `["not", …]` keyword is unrelated). |
| `map.addImage(name, ImageData, {pixelRatio:2})` ×3 + `hasImage` ×5 | icons.ts:77/87, pack-icons.ts:265/315/331 | **No v5 change.** `addImage(name, ImageData \| AlphaImage \| StyleImageInterface, options)` signature and pixel semantics are identical; our canvas-rasterize-SVG → `ImageData` flow (needed because `loadImage` can't decode SVG — still true in 5.x) is untouched. The `styleimagemissing` *callback*-resolve change is **v6-only**, and we never relied on it anyway. |
| `map.queryRenderedFeatures(e.point, {layers:["craft-icons"]})` | main.ts:817 | No signature change. On globe it works (globe-era fixes: antimeridian bbox and dateline fixes, 5.x CHANGELOG — PRs [#5765](https://github.com/maplibre/maplibre-gl-js/pull/5765), [#5856](https://github.com/maplibre/maplibre-gl-js/pull/5856)). |
| `map.unproject([x,y])` | regions.ts:201 (rectangle drawer) | No signature change. On globe, later 5.x clamps off-globe points to the horizon (fix PR [#5771](https://github.com/maplibre/maplibre-gl-js/pull/5771)) — better than ±Infinity for the drawer, but verify box-drawing near the globe limb. |
| `map.easeTo({bearing,pitch})` (compass reset), `map.flyTo({center,zoom,padding:{right:304}})` (dest fly-to), `zoomIn`/`zoomOut`, `getZoom`/`getCenter`/`getBearing` | controls.ts, main.ts:76 | No. High-pitch globe `easeTo`/`flyTo` padding had bugs fixed during 5.x ([#5406](https://github.com/maplibre/maplibre-gl-js/issues/5406) in 5.1.1, [#5134](https://github.com/maplibre/maplibre-gl-js/pull/5134)) — 5.24.1 has all of them. |
| `map.getCanvas()` (cursor styling, drawer canvas), `map.getContainer()` | main.ts, regions.ts, pack-icons.ts | No. |
| `map.addControl` ×2 (our `MapControlRow` IControl, `AttributionControl({compact:true})`) | map.ts:26–27 | No. `IControl` interface unchanged; `AttributionControl` options unchanged. Our CSS overrides target `maplibregl-ctrl` classes — class names unchanged in 5.x. |
| `map.dragPan` / `map.dragRotate` (`.isEnabled()/.disable()/.enable()` in the region drawer) | regions.ts:185–236 | No. Behavior note: v5.0.0 changed drag-rotate to pivot around the screen center (⚠ release-note item) — feel change, not break. |
| Style construction: raster `carto` source + `glyphs` URL (`basemap.ts`), inline `projection` at creation (`map.ts:17`), `loadProjection`/`radar.projection` (`src/data/projection-cfg.ts`) | basemap.ts, map.ts | No. `glyphs` requirement unchanged (still needed for our `CRAFT_TEXT_FONT` labels on raster styles). Raster sources render on globe (§2). |
| GeoJSON sources: craft store, trails (dateline-unwrapped via `unwrapLongitudes`), hotzones, AIS tiles, regions — all `setData`-driven | src/map/* | No. |
| WebGL/context options | not passed | The 5.0.0 `canvasContextAttributes` move (⚠ #5196) only affects maps that pass `antialias`/`preserveDrawingBuffer` — we pass none. |
| Script-tag/UMD global loading, `maplibregl` default-import tricks | map.ts default import | Default import compiles in 5.x exactly as today (same d.ts shape: `export as namespace maplibregl; export {};` + synthetic default via `moduleResolution: bundler`; same rollup UMD-style dist). It is **6.x** that kills it (§3). |

Files with maplibre imports (absolute):
`/Users/zacheri/Documents/Radar/src/map/map.ts`, `basemap.ts`, `controls.ts`,
`icons.ts`, `layers.ts`, `pack-icons.ts`, `regions.ts`, `hotzone.ts`,
`trackLayers.ts`, `aisTiles.ts`, `/Users/zacheri/Documents/Radar/src/main.ts`.
`shared/craft.ts` carries only icon-name strings (the `icon-image: ["get","icon"]`
contract) — version-agnostic.

## 2. GLOBE FACTS — maplibre-gl 5.24.1 (latest 5.x)

Sources: v5.0.0 release notes
(<https://github.com/maplibre/maplibre-gl-js/releases/tag/v5.0.0>), the
v5.24.1-tag CHANGELOG
(<https://github.com/maplibre/maplibre-gl-js/blob/v5.24.1/CHANGELOG.md>), and
the 5.24.1 d.ts + `src/ui/control/globe_control.ts` fetched from
unpkg/raw.githubusercontent. Note: **no official v4→v5 migration guide page
exists** (verified via live docs nav and a Wayback CDX sweep of maplibre.org —
the only in-house migration guide is v5→v6). The canonical v5 change list is
the 5.0.0 release notes + CHANGELOG.

- **Style property vs public API.** Both, and they are the same thing: the
  style's top-level `"projection": {"type": "globe"}` (style-spec 24:
  `StyleSpecification.projection`, with `type` even accepting an expression /
  transition state — `<https://unpkg.com/@maplibre/maplibre-gl-style-spec@24.10.0/dist/index.d.ts>`),
  and `map.setProjection({type: "globe" | "mercator" | "vertical-perspective"})`
  / `map.getProjection()` on `Map`. The vendored `GlobeControl` source (5.24.1)
  is a ~70-line file whose entire toggle is `map.setProjection({type: …})` —
  no `setStyle`, no rebuild.
- **Constructor support:** no `MapOptions.projection` in 5.24.1 (verified in
  the d.ts); pass it on the inline style (what `src/map/map.ts` already does —
  that code becomes *correct* rather than silently ignored) or call
  `setProjection` after load.
- **`vertical-perspective`:** added in 5.0.0 (PR #5023) — a globe that does NOT
  morph to mercator at high zoom. A candidate for our toggle's "globe" mode if
  we ever dislike the auto-morph.
- **What renders on globe:** raster tiles (raster-on-globe shipped in 5.0.0;
  its early globe+terrain raster bug was fixed in #4912, in the 5.0.0 notes),
  symbol layers incl. our `addImage` icon families and pack silhouettes
  (symbol-collision work on globe since 5.0; symbols are occluded behind the
  planet, with occlusion behavior tuned through 5.x — fixes PR
  [#4802](https://github.com/maplibre/maplibre-gl-js/issues/4802),
  [#5532](https://github.com/maplibre/maplibre-gl-js/pull/5532)), line layers (pole-scaling fix #4778),
  fill and **fill-extrusion** (a fill-extrusion-on-globe example has existed
  since the 5.0 era — archived as `examples/globe-fill-extrusion`, January
  2025 — and 5.24.1's own `GlobeControl` docs still link
  "Display a globe with a fill extrusion layer"). So: Carto raster basemap
  renders (warped onto the sphere), craft icons render (with back-of-globe
  occlusion), our dateline-unwrapped trail lines render, region fill/outline
  render, and we could even give region walls real `fill-extrusion` (we
  currently don't — regions are fill+line).
- **Animated transition.** `setProjection` in 5.24.1 takes only the
  `ProjectionSpecification` — **there is no `{animate}` options object**
  (checked d.ts signatures on both `Map` and `Camera`). Animation is internal:
  the renderer carries a mercator↔globe interpolation
  (`u_projection_transition`, `u_projection_fallback_matrix` — "Used by globe
  projection to fall back to mercator projection in an animated way", d.ts
  ~4868–4876) and globe auto-morphs to mercator near high zoom, firing the
  `projectiontransition` event (`MapProjectionEvent { newProjection }`).
  `GlobeControl` keeps its icon in sync purely by listening to
  `projectiontransition` + `styledata` — the same idiom our custom button can
  adopt.
- **In-place switching preserves everything — our rebuild dance becomes
  unnecessary.** Evidence chain: the toggle above is a single
  `setProjection` call (sources, layers, images, tile caches are untouched
  because nothing re-runs `setStyle`/`_updateStyle`); style-spec 24's diff
  operation table includes `setProjection` *and* v5 `Style` implements the
  applier (`_setProjectionInternal`), so even a projection-only
  `setStyle(…, {diff:true})` now applies in place (the 4.x throw→rebuild path
  is gone); and 5.x fixed `getProjection()` reliability (#7072) plus a
  globe+`setState` crash (#7314). 4.x's "images lost on toggle" property
  survives only for real `setStyle` calls. *(Our `style.load` re-adders can
  stay as a no-op safety net; browser-confirm per repo convention that a
  toggle no longer triggers them.)*
- **maxBounds / antimeridian.** No v5 breaking change to `maxBounds` (we use
  none; there was a 5.0-era globe center-constrain fix, #5186). Antimeridian:
  GeoJSON lines crossing 180° render correctly (official example
  "Display a line that crosses the 180th meridian"); `queryRenderedFeatures`
  antimeridian/dateline bugs were fixed during 5.x (#5765, #5856). Our
  `unwrapLongitudes` trail pre-processing stays correct — the unwrap makes the
  short-way segment explicit, which both projections consume literally.
  Browser-check a Pacific-crossing trail on globe.
- **Pitch/rotate limits on globe.** The camera constrains itself on globe
  (horizon); off-sphere pixels `unproject` to the horizon instead of
  nonsense (#5771). v5 also added pitch > 90° and camera roll generally
  (#4717). Zoom behaves with the documented "zoom and planet size" relation
  (dedicated example). Nothing here constrains our app (we never pitch past
  the defaults; compass reset is `easeTo({bearing:0,pitch:0})`).
- **GlobeControl exists** (`new maplibregl.GlobeControl()` + `maplibregl.css`,
  i18n keys `GlobeControl.Enable/Disable`) — but it's a stock vertical-stack
  button; our custom horizontal row can stay and just call `setProjection`.

## 3. BUILD / RUNTIME

- **Worker bundling with Vite — no change for 5.x.** The 5.24.1 tarball ships
  the same `dist/` shape as 4.7.1: `maplibre-gl.js` (rollup bundle with the
  worker inlined as a Blob — same bundle prelude, verified tails of both
  local 4.7.1 and 5.24.1), `-csp.js`/`-csp-worker.js`, `-dev.js`, `.css`,
  `.d.ts`; no standalone worker asset. So no `workerUrl` option, no Vite
  config change, and our `build.target: es2022` (needed for the top-level
  await in main.ts) is unaffected. **6.x is the churn:** ESM-only
  `maplibre-gl.mjs` + separate `maplibre-gl-worker.mjs`, and "for bundlers
  (Vite, webpack, …) each consumer still needs a one-time `setWorkerUrl()`
  call" (v5→v6 guide,
  <https://maplibre.org/maplibre-gl-js/docs/guides/v5-to-v6-migration-guide/>).
- **CSP builds:** 5.x still ships the dedicated CSP bundle; we don't set CSP
  (local single-user) and don't use the CSP entry, so N/A for 5. 6.x drops the
  CSP bundle entirely.
- **TypeScript.** 5.x keeps 4.x's loose `Evented` overloads (the strictly
  typed generic `Evented<EventTypeMap>`, event classes, `MapDataEvent`
  removal, and the `Map extends Camera` → composition change are **v6**
  #7789/#7800). v5 type-compile impact for us: essentially none — our
  `ControlMap` structural type (declared `on(type: string, fn): unknown`,
  `getStyle(): ControlStyle | undefined`) remains satisfied by the real
  `Map`'s looser `on` typing; the `Subscription` return is assignable to
  `unknown`/ignored. v6 would be the typed-events breaking round.
  `moduleResolution: bundler` + synthetic default keep
  `import maplibregl from "maplibre-gl"` compiling in 5.x (and break in 6.x).
- **style-spec validation.** `validateStyleMin` is still a stable named export
  at 24.10.0 (verified in its `dist/index.d.ts` export list); the Node-vs-min
  split and the "use `validateStyleMin`, the full `validate` needs
  preprocessed styles" note from our AGENTS.md hold at v24. v24 adds
  projection/MLT validation — our styles gain nothing to declare and lose
  nothing valid. (For context: v6 pairs with style-spec ≥25, which turns
  legacy-expression misuse into thrown warnings — we're clean, but that's one
  more v6 reason to defer.)
- **Browser floor.** 4.7.1 is WebGL2-only. **5.0.0 lowered the floor**: a
  dual-stack WebGL2→WebGL1 runtime was added (#5198, 5.0.0 release notes), so
  5.x runs everywhere 4.7.1 does, plus older WebGL1-only browsers. 6.x raises
  the floor back to WebGL2-required, and the `Map` constructor *throws*
  `GPUInitializationError` when unavailable (v5→v6 guide) — uncaught in our
  current `map.ts`. For this app (local, macOS/Safari-15+/Chromium) all three
  majors are fine; 5.x is strictly the safest.

## 4. DEPENDENCY PAIRING

Verified with `npm view` (2026-11-27):

| maplibre-gl | bundles @maplibre/maplibre-gl-style-spec | notes |
|---|---|---|
| 4.7.1 (installed) | `^20.3.1` (we have 20.4.0) | today |
| 5.24.1 (`latest-5`) | **`^24.8.1`** (latest 24.x = 24.10.0) | target |
| 6.19.0 (`latest`) | `^26.8.0` | would also force the ESM/worker churn |

The runtime dependency is transitive, but our **devDependency must be bumped
in lockstep** (`^20.4.0` → `^24.8.1`): the style tests import
`LayerSpecification`/`validateStyleMin` from the top-level install, and a
20.x/24.x type-identity mismatch against maplibre's own 24.x imports would
fail `tsc`.

Style tests to re-run/adjust (all four import `validateStyleMin` or
style-spec types): `test/style-validation.test.ts`,
`test/track-layers.test.ts`, `test/hotzone.test.ts`, `test/region-layers.test.ts`.
Expect zero edits (our styles/filters are spec-clean at v20; v24 is not
stricter about anything we use) but treat any diff as signal, not noise. If
the controls rewrite lands in the same wave, `test/map-controls.test.ts` is
the one file that must change semantically (its stub swaps
`getStyle`/`setStyle`/`isStyleLoaded` for `getProjection`/`setProjection`/
`projectiontransition`). `test/` otherwise imports maplibre type-only (erased
in the node-env Vitest) — no other test work.

## 5. RECOMMENDATION

**Target: `maplibre-gl@5.24.1` + devDep `@maplibre/maplibre-gl-style-spec@^24.8.1`.**
6.19.0 is not worth it for this goal: the globe (the entire ticket) is fully
present from 5.0 and matured through 5.x, while 6.0 adds ESM-only packaging,
mandatory `setWorkerUrl()` under Vite, default-removal of `import maplibregl from`,
WebGL2-required + throwing constructor, `map.transform`/`Map`-composition
changes, retyped events, plus **rendering-behavior defaults** (`zoomLevelsToOverscale`
default 4 changing `queryRenderedFeatures`/labeling, icon-offset scaling off,
transparent-line compositing change) — all churn, no feature we need. Revisit
6.x later as its own ticket; our post-5 surface (no `getStyle`/`setStyle`, no
chained `.on`) keeps that door cheap.

**Migration order** (single wave, gate after each step: `npm test` →
`npm run typecheck` → `npm run build`):

1. **Deps bump together:** `maplibre-gl` → `^5.24.1`,
   `@maplibre/maplibre-gl-style-spec` → `^24.8.1`. No Vite/tsconfig changes.
2. **Compile errors:** expect ~none in `src/` per §1 (the one v5 trap — `on()`
   chaining — is absent). Fix any style-spec 24 type-identity fallout by
   re-exporting the v24 `LayerSpecification` through the same import chain.
3. **Validation tests:** run the four style tests on style-spec 24; confirm
   clean. Then rewrite `controls.ts` (toggle → `map.setProjection({type:next})`,
   button sync from `map.getProjection()` + `projectiontransition` listener,
   `applyStoredProjection` → one `setProjection` call, delete the
   `getStyle`/`isStyleLoaded` dance and the 4.7.1-trap comments) and update
   `test/map-controls.test.ts` accordingly. Optionally trim `map.ts`/main.ts
   comments that describe the rebuild.
4. **Browser checklist (user-run, per repo convention — these are the
   browser-only risks):**
   - Globe toggle animation both directions; no "Unable to perform style
     diff" warning; no `style.load` re-fire storm.
   - Craft icons + pack silhouettes on globe, correct color/icon, occluded on
     the far side; click/hover selection and pointer cursor work.
   - Carto raster basemap on the sphere looks acceptable (§5 risk 2);
     keyless fallback → OpenFreeMap path renders with its own projection
     behavior honored (risk 3).
   - Selected-craft trail across the dateline on globe; hotzone rects;
     AIS-tile outlines; region fill/outline; rectangle drawer near the limb
     (unproject horizon clamp).
   - Compass reset, fly-to with `padding:{right:304}`, attribution control CSS,
     reload with `radar.projection = globe` → boots as globe with no flash.

**Expected effort:** about half a working day for steps 1–3 (the code delta is
mostly deletions) plus one user browser-verification round.

**Top 5 risks (ranked):**

1. **Icon registration flow across the projection switch** — no v5 API change
   to `addImage(ImageData, {pixelRatio})`, and in-place `setProjection` should
   never evict images, but this is the exact seam our two registrars were
   built to heal; confirm the `style.load` re-adders go idle on toggle rather
   than double-registering (they're `hasImage`-guarded, so worst case is
   wasted rasters, not breakage).
2. **Raster basemap on globe aesthetics** — 256px Carto rasters warp onto the
   sphere; fine at low pitch, soft/stretchy near the limb. Accept, or prefer
   the OpenFreeMap vector fallback for globe mode. (Browser-judged.)
3. **Carto probe / OpenFreeMap fallback now that `projection` is honored** —
   with 4.7.1 the keyless OpenFreeMap style URL could never carry globe; at
   5.x the fetched style's own `projection` (if the remote style ever sets
   one) now *applies*, and our `applyStoredProjection` must run *after* load
   and win. Rewrite order: apply stored projection in one
   `projectiontransition`-safe `setProjection` after the first style load;
   check once whether `tiles.openfreemap.org/styles/dark` sets `projection`.
4. **Camera/UX deltas shipped in 5.0.0** — drag-rotate now pivots around the
   screen center and high-pitch tile loading changed (both ⚠ release-note
   items); feel-only, but a user with muscle memory will notice.
5. **`queryRenderedFeatures` on globe occlusion/antimeridian corners** —
   fixed across 5.x, but our click-fallback + region-drawer paths lean on it
   heavily; cover Pacific-crossing trails and back-hemisphere clicks in the
   browser pass.

## 6. What v5 deletes from our shipped workarounds

- `src/map/controls.ts` — **the big one.** `toggleProjection`'s
  `getStyle()` → spread → `setStyle(…, {diff:false})` full-rebuild dance and
  the header comment (lines 8–19) exist only because 4.7.1 has no public
  `setProjection` and no style-diff applier. Both cease to exist:
  `map.setProjection({type: next})`. The closure-tracked `projection`
  mirror, the `isStyleLoaded()` click gate (added after the 2026-11-26
  `loaded()`-no-op bug), and the `ControlStyle`/`getStyle` stub surface all
  shrink; button sync moves to the `projectiontransition` idiom (the vendored
  `GlobeControl` is the reference implementation). `applyStoredProjection`
  becomes one guarded `setProjection` — and works on the style-URL fallback
  path without any rebuild.
- `src/main.ts` `setupStyleLayers` (lines 552–579) — its reason-for-being is
  "the projection toggle is a full setStyle rebuild". After the rewrite the
  app contains **no `setStyle` call at all**, so `style.load` fires once.
  Keep the function and the double registration (`style.load` + `load`) as
  cheap idempotence insurance (still correct if we ever add a style swap),
  but the rebuild-recovery comments shrink. The socket-outside-style-events
  comment loses its rationale but stays correct.
- `src/map/map.ts` inline-style projection (lines 10–18) — **keep the
  pattern**, but its comment flips from "carried for free at creation
  (ignored)" to "carried for free at creation (**honored**)" — the zero-
  reload boot path becomes actually-globe-at-first-paint. 5.24.1 still has
  no `MapOptions.projection`, so the inline style remains the only
  constructor-time carrier. `applyStoredProjection`'s one-boot-rebuild cost
  on the fallback path disappears too.
- `src/map/icons.ts` + `src/map/pack-icons.ts` registrars — their
  "survive style rebuilds / re-add on style.load" contracts become
  belt-and-suspenders (nothing rebuilds anymore). Keep; harmless; they still
  guard `hasImage` and handle the icon-pack late-ready re-add, which is real
  traffic independent of projections.
- AGENTS.md gotcha block "Projection switching (cost a rejected review
  round)" and the `src/data/projection-cfg.ts` boot story become history at
  the next docs refresh.

## Sources (primary)

- v5.0.0 release notes (globe #3963, GlobeControl #4960,
  vertical-perspective #5023, terrain-on-globe #4976, atmosphere #3888,
  pitch>90/roll #4717, `on()`→Subscription #5080, `canvasContextAttributes`
  #5196, drag-rotate center #5074, WebGL dual-stack #5198, ⚠-marked
  removals): <https://github.com/maplibre/maplibre-gl-js/releases/tag/v5.0.0>
- CHANGELOG as of v5.24.1 (all 5.x globe fixes: #5406 flyTo-padding in 5.1.1,
  #5599 circle hitbox in 5.3.0, #5765/#5856 qRF dateline/antimeridian,
  #5771 unproject horizon clamp, #5865 globe culling, #7005/#7072
  GlobeControl/`getProjection` fixes, #7314 globe `setState` crash):
  <https://github.com/maplibre/maplibre-gl-js/blob/v5.24.1/CHANGELOG.md>
- v5.24.1 API surface (setProjection/getProjection on Map and Style,
  `projectiontransition`/`MapProjectionEvent`, GlobeControl, no
  `MapOptions.projection`, no `{animate}` option, UMD-shape dist):
  <https://unpkg.com/maplibre-gl@5.24.1/dist/maplibre-gl.d.ts>
- GlobeControl source (setProjection-only toggle, `projectiontransition`
  sync idiom):
  <https://raw.githubusercontent.com/maplibre/maplibre-gl-js/v5.24.1/src/ui/control/globe_control.ts>
- style-spec 24.10.0 (`StyleSpecification.projection`,
  `ProjectionSpecification`, `validateStyleMin` export stability,
  `setProjection` diff op):
  <https://unpkg.com/@maplibre/maplibre-gl-style-spec@24.10.0/dist/index.d.ts>
- v5→v6 migration guide (ESM-only, `setWorkerUrl()` under bundlers, CSP
  bundle dropped, `zoomLevelsToOverscale`, styleimagemissing resolver,
  WebGL2-required/`GPUInitializationError`, `map.transform` removed):
  <https://maplibre.org/maplibre-gl-js/docs/guides/v5-to-v6-migration-guide/>
- GlobeControl in current API docs:
  <https://maplibre.org/maplibre-gl-js/docs/API/classes/GlobeControl/>
- Globe examples (fill-extrusion-on-globe shipped in the 5.0 era — archived
  `maplibre.org/maplibre-gl-js/docs/examples/globe-fill-extrusion/`, Jan
  2025, Wayback; current pages:
  <https://maplibre.org/maplibre-gl-js/docs/examples/display-a-globe-with-a-fill-extrusion-layer/>,
  dateline example
  <https://maplibre.org/maplibre-gl-js/docs/examples/display-line-that-crosses-180th-meridian/>).
- npm registry (dist-tags `latest-5 = 5.24.1`, `latest = 6.19.0`; dependency
  pins `5.24.1 → style-spec ^24.8.1`, `6.19.0 → ^26.8.0`, `5.0.0 → ^22.0.1`),
  `npm view` 2026-11-27; dist file listings via jsDelivr data API
  (5.24.1 vs 6.19.0).
- No official v4→v5 migration guide exists (live docs nav + Wayback CDX
  sweep of maplibre.org, 2026-11-27); the 5.0.0 release notes + CHANGELOG are
  canonical for breaking changes.
