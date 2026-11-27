# MapLibre GL JS 4.7.1 → 5.x — upgrade impact report

Date: 2026-11-27 · Goal: real globe renderer. Target verdict: **maplibre-gl 5.24.1**
(`latest-5`), paired with `@maplibre/maplibre-gl-style-spec` **24.x** (see §6).

Method: every claim below is either (a) measured against this repo's `node_modules`
and the actual npm tarballs of 4.7.1 / 5.24.1 / 6.19.0 (commands + output in §11), or
(b) cited to a primary source (official CHANGELOG, official docs/API, upstream source
files, npm registry). Where evidence is thinner it is marked **verify-in-browser**.

## 1. Verdict

- Upgrade to **5.24.1** (published 2026-11-11, actively maintained latest 5.x). Real
  globe, public `map.setProjection()`, in-place switching that preserves
  sources/layers/images/tiles — every projection workaround we shipped becomes optional.
- Stay on 5.x; do **not** jump to 6.19.0 in the same move. v6 is ESM-only, drops the
  default export, requires a Vite `setWorkerUrl()` call, removes WebGL1, and rewrites
  event types — none of it needed for the globe (§7).
- Code impact is small and localized: `src/map/controls.ts` rewrite (the toggle), a
  simplification in `src/map/map.ts` / `applyStoredProjection`, small comment updates,
  a version bump in two `package.json` entries. Everything else is expected to compile
  and behave as-is; the style-validation tests should pass unchanged on style-spec 24.
- Effort estimate: **~half a day of code + gate, plus one browser-verification session**
  (checklist §10). Riskiest surfaces: globe rendering of our exact layer mix and the
  dateline-unwrapped trails on globe — logic unchanged, rendering new (§8).

## 2. Baseline — verified: 4.7.1 has no globe renderer

Measured against the installed artifact (`node_modules/maplibre-gl@4.7.1`) and the
upstream npm tarball (identical build):

| probe (minified `dist/maplibre-gl.js`) | hits |
|---|---|
| `isGlobe` | **0** |
| string `globe` | **1** — the bundled style-spec enum (`projection.type` default `mercator`, values `mercator`/`globe`) |
| `vertical-perspective` | **0** |
| `setProjection` | 1 — a diff-command name string, not an applier |

The upstream 4.7.1 tarball confirms it structurally: no source file is named for
globe, and the only "globe" text in `src/` is scaffolding comments — *"Temporarily
imported from globe branch"*, *"Code here is subject to change once globe is merged"*.
**The globe was merged into v5, not v4** ([CHANGELOG 5.0.0: "Support globe mode
#3963"](https://github.com/maplibre/maplibre-gl-js/blob/main/CHANGELOG.md#500)).
So the style-level `projection: {type:"globe"}` we pass today validates (style-spec
20.4 knows the enum) and is then **silently ignored by the renderer** — exactly what
the browser shows.

Upstream timeline (npm publish timestamps): 4.7.1 → 2024-09-23; 5.0.0 → 2024-12-31;
6.0.0 → 2026-07-22; 5.24.1 → 2026-11-11; 6.19.0 → 2026-11-17. (The July 2026 newsletter's
"v5 landed in December 2025" is loose; the [December 2024 newsletter](https://maplibre.org/news/2025-01-05-maplibre-newsletter-december-2024/)
matches npm.) Note for honesty: our AGENTS.md "no `map.setProjection()` in 4.7.1, no
projection in `MapOptions`, full-rebuild toggle" findings were all correct **and stay
correct for v5's `MapOptions`** — v5 still has no constructor `projection` option —
but every *reason* for the rebuild (no renderer, no applier, no round-trip) is gone in 5.x.

## 3. Inventory — every maplibre API our `src/` touches, and its 5.x status

Only 10 files import maplibre (`src/map/*`, one type-only); `src/main.ts` holds the
map instance. Nothing else does (server and `src/ui`, `src/data` are maplibre-free;
`test/track-layers.test.ts` is the one type-only test import). Default/namespace value
import (`import maplibregl from "maplibre-gl"`) keeps working in 5.x (it breaks only
in 6.x, §7).

### 3.1 Constructor & controls

| API | Used at | 5.24.1 status |
|---|---|---|
| `new maplibregl.Map({container, style, center, zoom, attributionControl:false})` | `src/map/map.ts:19-25` | Unchanged. No `projection` field added to `MapOptions` (verified — the option still only lives on the style object or `setProjection`). Inline-style `projection` is now **honored** (`Style` init: `this.stylesheet.projection?.type \|\| 'mercator'`, [style.ts:495](https://github.com/maplibre/maplibre-gl-js/blob/v5.24.1/src/style/style.ts)). |
| WebGL context options (`antialias`, …) | not used | ⚠️ v5 moved them into `canvasContextAttributes` — **no impact**, we pass none. Default `contextType: 'webgl2withfallback'` (v5 d.ts). |
| `map.addControl(createMapControls(), "top-right")` (custom IControl) | `map.ts:26` | `IControl` unchanged. Our structural `MapControlRow` stays assignable (contravariant param). |
| `maplibregl.AttributionControl({compact:true})` | `map.ts:27` | Unchanged (`compact` verified in 5.24.1 d.ts). |
| `import "maplibre-gl/dist/maplibre-gl.css"` | `map.ts:2` | Path unchanged in 5.24.1 dist. |

### 3.2 Camera & viewport

| API | Used at | 5.24.1 status |
|---|---|---|
| `map.flyTo({center, zoom, padding})` | `main.ts:76` | Works; globe fixes: padding `flyTo` #5406 (5.x), padding `easeTo` #5134 (5.0.0). |
| `map.easeTo({bearing:0, pitch:0})` | `controls.ts:107` | Works. Note v5 changed drag-rotate to pivot around screen center (⚠️ UX, changelog 5.0.0). |
| `map.zoomIn()/zoomOut()` | `controls.ts:104-105` | Unchanged. |
| `map.getBearing()` | `controls.ts:117` | Unchanged (v5 adds roll as a separate axis; bearing semantics untouched). |
| `map.getZoom()`, `map.getCenter()` | `main.ts:76,129,840` | Unchanged. Globe center-constraint fix #5186 (5.0.0). |
| `map.unproject([x,y])` | `regions.ts:166` | Unchanged signature. **Globe note:** points beyond the horizon clamp to it (#5771, 5.4.0) — region-drag near the globe limb commits clamped corners. `project`, `fitBounds`, `jumpTo`, `maxBounds`, `setMin/MaxZoom` are **not used** anywhere in `src/`. |

### 3.3 Style / sources / layers / images

| API | Used at | 5.24.1 status |
|---|---|---|
| `map.getStyle()` | `controls.ts:88,148` | Exists; now **includes `projection`** (`serialize()` spreads it — [style.ts:1486](https://github.com/maplibre/maplibre-gl-js/blob/v5.24.1/src/style/style.ts)) — fixes the 4.x "never round-trips projection" gotcha. Both call sites disappear in the toggle rewrite (§9). |
| `map.setStyle(copy, {diff:false})` | `controls.ts:96,150` | Exists, unchanged — but **unnecessary** on 5.x (§9). Related fix upstream: the 4.x diff-emits-`setProjection`-with-no-applier trap briefly existed in v5 too; applier landed ([issue #7314](https://github.com/maplibre/maplibre-gl-js/issues/7314), fixed 5.22.0). |
| `map.isStyleLoaded()` | `controls.ts:87,152` | Unchanged, still `(): boolean \| void` — our `ControlMap` comment stays accurate. |
| `map.on("style.load"/"load", …)`, `map.once(...)` | `main.ts:578-579`, `controls.ts:156`, `icons.ts:104`, `pack-icons.ts:305` | Fine. `style.load` is not in v5's typed `MapEventType` (typed properly in 6.x) but the string overload `on(type: string, listener)` on `Evented` compiles. New in 5.x: `projectiontransition` event (fires on projection change — §4/§9). |
| `map.getSource(id)` + `maplibregl.GeoJSONSource.setData(fc)` | `layers.ts:77`, `trackLayers.ts:104`, `hotzone.ts:64`, `aisTiles.ts:78`, `regions.ts:115,126` | Unchanged in v5. (v6 removes `setData`'s 2nd param + `this` return — we never used them; still a v6-only concern, #7538.) |
| `map.addSource(id, {type:"geojson", data})` | `layers.ts:70`, `trackLayers.ts:72`, `hotzone.ts:41`, `aisTiles.ts:37`, `regions.ts:80` | Unchanged (clustering/promoteId changes don't touch us). |
| `map.getLayer(id)` (guard idiom), `map.addLayer(def, beforeId)`, `addLayer(def)` | all six layer modules | Unchanged. |
| `map.setFilter("craft-icons"/"craft-labels"/"craft-sublabels", f)` | `main.ts:781-783` | Unchanged. Our filter (`["all", ["in",["get","kind"]…], … ["!",["in",…]]]`, `src/data/filter.ts`) uses expression `!` — still the correct operator in v5 (the legacy `"not"` keyword was removed long before v5; style-spec 24 keeps `!`). The v5.0.0 "geometry-type Multi-" breaking entry was **reverted before stable** (struck through in the CHANGELOG) and we don't use `geometry-type` anyway. |
| `map.setLayoutProperty("craft-labels","text-ignore-placement", on)` | `layers.ts:90` | Unchanged in v5 (typed harder in v6, #7481). `setPaintProperty` is **not used**. |
| `map.addImage(key, ImageData, {pixelRatio: 2})` | `icons.ts:77`, `pack-icons.ts:265,315` | **Unchanged signature** in 5.24.1: `addImage(id, HTMLImageElement \| ImageBitmap \| ImageData \| {width,height,data} \| StyleImageInterface, options?)`. Our browser-rasterized-SVG → `ImageData` flow (the `loadImage`-can't-decode-SVG workaround) stays exactly as-is. `hasImage(key)`, guarded re-add, and the `style.load` re-registration in both registrars work unchanged. (`styleimagemissing`/`setMissingStyleImageResolver` churn is v6, #7892; we never used the event.) |
| `maplibregl.StyleSpecification` (type) | `basemap.ts:5` | Still exported; `projection` is a typed root property in style-spec 24, so the inline `{...cartoStyle(key), projection:{type}}` keeps compiling. |
| `LayerSpecification` (type) from style-spec | 5 map modules | Same type source; bump the devDependency (§6). |

### 3.4 Interaction

| API | Used at | 5.24.1 status |
|---|---|---|
| `map.on("click", layerId, fn)` / `map.on("click", fn)` / `mouseenter`/`mouseleave` on `"craft-icons"` | `main.ts:801-829` | Typed via `MapLayerEventType` (5.x already had typed layer overloads). `e.features[0].properties.id` stays `unknown`→our `as string` cast still needed. |
| `map.queryRenderedFeatures(e.point, {layers:["craft-icons"]})` | `main.ts:817` | Works on globe; date-line/antimeridian fixes #5765 (5.4.0), #5856 (5.6.0); perf improvement (5.0.0). |
| `map.on/off("mousedown"/"mousemove"/"mouseup")` | `regions.ts:195-213` | Unchanged; handler param (`{point}`) stays structurally assignable. |
| `map.on("move"/"moveend")` | `controls.ts:119`, `main.ts:835` | Unchanged (v6 retypes into `MapMovementEvent`, not a v5 concern). |
| `map.dragPan/dragRotate.enable()/disable()/isEnabled()`, `map.getCanvas()`, `map.getContainer()` | `regions.ts:149-203`, `main.ts:825,829` | Unchanged. ⚠️ behavior note only: v5 re-centered drag-rotate (#5074) and fixed smooth wheel zoom (#5154). |
| `map.on(...)` return value | never used | ⚠️ v5 breaking change: `on` returns a `Subscription`, not the map — chaining `map.on(...).on(...)` broke; we never chain (`controls.ts`/`icons.ts`/`pack-icons.ts` all discard the return). |

Not used anywhere (so v5 removals/changes there are moot): Marker, Popup, any built-in
NavigationControl/ScaleControl/GeolocateControl, `map.project`, `resize`, `remove`,
`setPaintProperty`, `map.loaded()`, terrain/sky/light APIs, custom layers,
`queryTerrainElevation`, `geometry-type`.

## 4. Globe facts for 5.24.1 (primary sources: CHANGELOG 5.x, v5.24.1 d.ts + source, official docs)

- **Style property vs API.** Both work: style root `projection: {type: "globe"|"mercator"|"vertical-perspective", ...}` is read at style load ([style.ts:495](https://github.com/maplibre/maplibre-gl-js/blob/v5.24.1/src/style/style.ts)); `map.setProjection(projection)` / `map.getProjection()` are public on `Map` and `Style` (5.24.1 `maplibre-gl.d.ts`: `setProjection(projection: ProjectionSpecification): this`), and the official pattern is exactly `map.on('style.load', () => map.setProjection({type:'globe'}))` ([globe vector example](https://maplibre.org/maplibre-gl-js/docs/examples/display-a-globe-with-a-vector-map/), [Stadia tutorial](https://docs.stadiamaps.com/tutorials/3d-globe-view-with-maplibre-gl-js/)). There is a built-in [`GlobeControl`](https://maplibre.org/maplibre-gl-js/docs/API/classes/GlobeControl/) toggle if we ever want stock art.
- **Constructor support.** `MapOptions` has **no** `projection` option in 5.24.1 (verified field-by-field in the d.ts) — same shape as our current map.ts: projection rides on the inline style object (now honored) or is applied via `setProjection` after load.
- **`ProjectionSpecification`** (style-spec 24.10.0 d.ts): `{ type?: string | [string,string,number] | expression }` — v5 also supports **projection expressions** interpolated over `zoom` (#5139; style-spec reference: `projection.type` is `projectionDefinition`, `expression.interpolated: true`, parameters `[zoom]`), e.g. globe at low zoom → flat at z≥8 with a smooth morph between. Nice future option for our low-zoom global view.
- **What renders on globe** — every layer type we ship:
  - *Raster tiles* (our Carto basemap): yes — "raster tiles … globe and terrain" fixed in 5.0.0 (#4912); `vertical-perspective`-era globe demos were raster-first.
  - *Symbol icons + text* (craft icons/labels, dest marker): yes, incl. occlusion behind the horizon (#4802, 5.0.0) and symbol-collision work on globe (#4778); `map`-aligned icon rotation is supported (heading-rotated craft are the whole point of our icon layer — see the pole-orientation fixes).
  - *Line layers* (trails, predicted path, hotzone/ais/region outlines): yes (line scaling near poles fixed #4778; line flicker #5094).
  - *Fill layers* (hotzone fill, region fill): yes. Fill-**extrusion** on globe is supported too ([official example](https://maplibre.org/maplibre-gl-js/docs/examples/display-a-globe-with-a-fill-extrusion-layer/)) — we don't use it today; region "walls" would be viable later.
  - *Circles, heatmap, terrain, custom layers*: supported; irrelevant to us.
  - *Not on globe*: `sky` (deliberately disabled, blends in on switch to mercator, #4853) and fog-with-terrain on globe (#4963). We use neither.
- **In-place switching preserves everything.** `Style.setProjection` destroys/recreates only the projection object and calls `map.migrateProjection(transform, cameraHelper)` ([style.ts:1693-1708](https://github.com/maplibre/maplibre-gl-js/blob/v5.24.1/src/style/style.ts)); tile managers, layers, images, and camera center/zoom/bearing/pitch are untouched — **no re-add dance, no image re-registration, tile cache survives**. This is precisely why the 4.x rebuild existed and precisely what makes it unnecessary in 5.x.
- **Animated transition.** Switching projections is an animated mercator↔globe morph (shader uniforms `u_projection_transition` / `u_projection_fallback_matrix` in the 5.24.1 d.ts; white-first-frame fix #4816; the docs "globe control" example demonstrates the morph). Caveats: there is **no `{animate}` / duration option in 5.x** (`projection.type` is `transition: false` in the style spec — the morph is engine-internal; a camera-level transition API (`Camera.setProjectionTransition`) only appears in v6). Fires the `projectiontransition` event (`MapProjectionEvent`, 5.24.1 d.ts) on every change — use it to keep button state in sync.
- **maxBounds / antimeridian.** No maxBounds-specific globe breaking change appears anywhere in the 5.x CHANGELOG; center constraint was *fixed* for globe (#5186). We set no `maxBounds` at all, so this is a non-issue for us. Antimeridian behavior on globe saw a run of fixes: `queryRenderedFeatures` date-line (#5765, 5.4.0) and bbox-crossing (#5856, 5.6.0) fixes, `unproject` horizon clamp (#5771, 5.4.0), `fitBounds`/`cameraForBounds` across ±180 (#4620). Our ±360-unwrapped GeoJSON longitudes (`trackLayers.ts unwrapLongitudes`) remain necessary (v5 renders world copies; nothing in 5.x normalizes input longitudes) — whether an unwrapped trail draws the short way **on the sphere** is a browser-verify item (expected: yes, the renderer paints geometry copies into adjacent worlds — backfacing occlusion tests in the shipped source).
- **Pitch / rotate limits.** Same controls as mercator: `MapOptions.minPitch/maxPitch` default 0/60, range 0–180; 5.0.0 added pitch > 90 and camera roll (`#4717`) and `setVerticalFieldOfView` — all opt-in via `easeTo`/`fitTo`, none of it changes our defaults. Globe supports pitched (tilted) viewing; pitched-globe tile loading was fixed (#4778) and high-pitch globe tile-distance fixed in 5.x (#7219). Rotation (bearing) on globe is unrestricted. **verify-in-browser** is only about feel, not capability.

## 5. Build / runtime

- **Worker bundling with Vite: no change.** 5.24.1 ships the same dist set as 4.7.1
  (`maplibre-gl.js` UMD with the inline blob worker, `maplibre-gl-dev.js`, the CSP pair,
  `maplibre-gl.css`, `.d.ts` — verified tarball listing). `vite.config.ts` needs nothing;
  there is no `workerUrl` MapOption in 5.x (only the `importScriptInWorkers` util for the
  CSP worker). *(v6 changes this completely — §7.)*
- **CSP builds:** `maplibre-gl-csp.js` + `maplibre-gl-csp-worker.js` still published in
  5.24.1; we don't use them and don't need them (inline-worker default only needs
  `worker-src blob:` if a CSP exists at all — we serve locally, no CSP headers).
- **Bundle format:** `import maplibregl from "maplibre-gl"` (default import) and
  `import type maplibregl from "maplibre-gl"` both remain valid in 5.x. Our top-level-await
  + `build.target: es2022` setup is compatible (v6 *raises* the floor to ES2022, which we
  already satisfy).
- **TypeScript.** Two v5 type changes that could surface in `tsc --noEmit`, both benign for
  us: (1) `on()` returns `Subscription` — we discard returns everywhere; (2) event
  listeners are typed against `MapEventType`/`MapLayerEventType`; our inline handlers are
  structurally compatible (region drawer's `{point: {x,y}}` accepts `MapMouseEvent.point:
  Point`). Expect **zero-to-few** compile fixes, most plausibly around `controls.ts`
  `ControlMap`'s `setStyle` shape (which we delete anyway) and possibly `getStyle()`
  (`StyleSpecification` in 5.x types includes `projection`, so the old
  `ControlStyle` workaround can go).
- **Browser floor goes *down*, not up.** 4.x required WebGL2 (switched in the v3 era,
  "Full transition from WebGL1 to WebGL2", CHANGELOG). 5.0.0 added a **dual-stack
  WebGL2→WebGL1 runtime** (#5198) with `canvasContextAttributes.contextType` defaulting to
  `'webgl2withfallback'` (#5236). So every browser that runs 4.7.1 runs 5.x, and 5.x also
  runs on WebGL1-only browsers (globe needs WebGL2-class features regardless — a WebGL1
  browser gets flat maps). v6 then reverses this ("WebGL v1 support has been removed;
  WebGL2 is now required", 6.0.0 ⚠️).
- **Style-spec validation:** see §6 — `validateStyleMin` remains the export, same call
  shape (`validateStyleMin(style, styleSpec?, styleRefs?)`), still the runtime validator.

## 6. Dependency pairing (npm registry, verified today)

```
npm view maplibre-gl@5.24.1 dependencies → "@maplibre/maplibre-gl-style-spec": "^24.8.1"
npm view maplibre-gl@6.19.0 dependencies → "@maplibre/maplibre-gl-style-spec": "^26.8.0"
npm view maplibre-gl dist-tags           → latest: 6.19.0, latest-5: 5.24.1
```

- Target pair: `maplibre-gl@^5.24.1` + `@maplibre/maplibre-gl-style-spec@^24.8.1`
  (installs 24.10.0; style-spec 24.x is the runtime validator 5.24.1 itself uses —
  keep them from drifting apart or the tests validate against a different spec than the
  map enforces). Current style-spec 20.4.0 is a v4-era spec and must move with the bump.
- 24.10.0 keeps the `validateStyleMin` export (declared in `dist/index.d.ts`) and dual
  CJS/ESM entry (`main`/`module`/`types`) — our Vitest (node, no jsdom) imports keep
  working.
- Tests importing `validateStyleMin`: `test/style-validation.test.ts`,
  `test/track-layers.test.ts`, `test/hotzone.test.ts`, `test/region-layers.test.ts`.
  Expectation: **pass unchanged** (spec 24 is a superset; `!`, `["get", …]`, `["in", …]`,
  `["interpolate", …]` all stable). They should also gain one assertion using the now
  fully-typed `projection: {type: "globe"}` on a validated style — a real v5 feature test.
  `test/track-layers.test.ts`'s `import type maplibregl from "maplibre-gl"` stays valid
  (default export exists through 5.x).

## 7. v6.19 — brief evaluation (do not target now)

v6 (6.0.0 = 2026-07-22) is a renderer/state rewrite: ESM-only `maplibre-gl.mjs` +
separate `maplibre-gl-worker.mjs`, **default export removed** (`import maplibregl from
"maplibre-gl"` → namespace/named imports — breaks all 10 of our import sites),
**`setWorkerUrl()` becomes mandatory for bundler users incl. Vite** (per the official
[v5→v6 migration guide](https://maplibre.org/maplibre-gl-js/docs/guides/v5-to-v6-migration-guide/)),
WebGL2-only, `Map` composes `Camera` (`map.transform` gone), `styleimagemissing` no longer
resolves images (#7892), real event classes + generic `Evented` (#7789), `setData`
signature trim (#7538), `zoomLevelsToOverscale` default 4 (QRF result shifts, #7537),
style-spec 25→26 pairing. Globe itself gained custom-CRS/`addProjection` machinery we'd
never touch. **Every globe capability we need already exists in 5.24.1**; a 5.x→6.x pass
later is a contained mechanical wave (imports + `setWorkerUrl` + type fixes) with its own
official guide. Churn avoided today: yes.

## 8. Recommendation

**Order:** deps bump → compile errors → validation tests → toggle rewrite → browser
checklist. (Rewrite *after* green compile so type errors don't chase moving code.)

1. Bump `maplibre-gl` → `^5.24.1`, `@maplibre/maplibre-gl-style-spec` → `^24.8.1`; install.
2. `npm run typecheck`; fix fallout (expected: small; `controls.ts` dominant).
3. `npm test` — the four style-validation suites must pass on spec 24; add the
   `projection:{type:"globe"}` style case.
4. Rewrite the projection toggle (file refs §9); `npm run build`.
5. Browser checklist §10 (WebGL bugs are user-confirmed per repo convention).
6. Single PR, gate green; update the AGENTS.md MapLibre gotcha block (its 4.7.1 facts
   become historical) — separate docs commit.

**Expected effort:** ~2–4 h code/gate, plus one user browser session. The migration is
unusually small *because* almost nothing in our used surface changed (§3) — v5's breaking
list targets controls, custom layers, `MapOptions` WebGL flags, and event chaining, which
we don't touch.

**Top 5 risks (all globe-surface, not compile-surface):**

1. **Craft-icon art on the sphere.** `addImage(ImageData, {pixelRatio})` is byte-identical
   API in 5.24.1, so the flow itself is safe; the *rendering* of our 96×96 tinted
   silhouettes with `icon-rotate` heading + `icon-rotation-alignment: "map"` at globe
   latitudes (pole squish fixes: #4786, #5275) is new visual territory. Mitigate:
   `GET /icons/catalog` unchanged, browser-check icons near poles/dateline; art pipeline
   needs no change either way.
2. **Raster basemap on globe.** Carto tiles warp onto the sphere; low-zoom globe requests
   many more tiles at once (globe tile selection was retuned across 5.x: #4937, #5865).
   Cost check: our OpenSky budget is untouched, but tile fetch volume rides the traffic
   panel — watch radar-DOWN during the first globe session. The `probeCarto` key-probe is
   projection-independent (plain fetch) — unaffected.
3. **Toggle state-sync regressions.** The rewrite must persist on click and sync from
   `projectiontransition` (not `style.load`), or the button and `radar.projection` drift
   when projection changes by other means (e.g., future projection expressions). 5.18-era
   GlobeControl sync fix (#7005) is the same bug class upstream.
4. **Dateline trails & region draws on globe.** `unwrapLongitudes` correctness on the
   sphere, `unproject` horizon-clamp making a big region rect silently wrong near the
   limb (#5771 — it clamps, doesn't throw). Verify-in-browser with a trans-Pacific trail
   selected.
5. **Typed-event/style-spec drift compile errors** — the only *predicted* (not observed)
   item: strict listener typing + `LayerSpecification` from 24.x could surface one-off
   casts. Bounded, mechanical.

## 9. What v5 retires from our shipped workarounds (file refs)

| Workaround | Now | Why |
|---|---|---|
| `src/map/controls.ts` `toggleProjection` — `getStyle()` copy + `setStyle(…, {diff:false})` full rebuild + `isStyleLoaded()` gate + closure-tracked projection state | **Replace with `map.setProjection({type: next}); saveProjection(next, storage)`** — in-place, animated, sources/layers/images/tile cache preserved; read truth from `map.getProjection()`; `once("style.load", apply)` + the whole header comment (the 4.7.1 diff-applier trap) deleted. The stock `GlobeControl` could even replace the button markup if we ever drop the horizontal-row design. | §4 in-place switching |
| `applyStoredProjection` deferred full rebuild (style-URL basemap path), `controls.ts:137-157` | Keep the shape (URL styles still can't carry projection pre-fetch — `MapOptions.projection` remains nonexistent), but the one-time rebuild becomes a zero-cost `map.setProjection(...)` on `style.load`; the "only globe wishes pay the rebuild" reasoning disappears. | §4 |
| `src/map/map.ts` inline `{...cartoStyle(key), projection:{type}}` | Keep as-is (still honored, still zero-reload at boot) — but it stops being load-bearing: with `setProjection` both basemap paths can apply the stored projection identically, letting map.ts drop the inline/fallback asymmetry. | §3.1, §4 |
| `setupStyleLayers` idempotence (`src/main.ts:552-579` "registered before the socket" double-call on `style.load`+`load`) | **Still keep the guards** — the boot double-fire is real on 5.x too, and rebuild-on-toggle was only one of three callers. What changes: the comment's central justification (projection-toggle rebuild) is gone; `style.load` re-registration only matters for future basemap swaps or `setStyle` use. Cheap insurance, not vestigial risk. | §4 preservation |
| `icons.ts:104` / `pack-icons.ts:302-321` re-add-on-`style.load` machinery | Same verdict: now defensive-only (no shipped path rebuilds the style mid-session), harmless to keep. | §4 |
| `regions.ts:140-147` drawer comment "works on globe and mercator alike" | Becomes literally true on 5.x (it was aspirational on 4.7.1's flat-only renderer); add a note on the horizon clamp (#5771). | §4 |
| `controls.ts` `ControlMap.isStyleLoaded(): boolean \| void` comment "match the 4.7.1 d.ts" | Identical in 5.24.1 d.ts — comment stays true; the interface itself shrinks once `getStyle`/`setStyle` go. | §3.3 |
| AGENTS.md "MapLibre GL JS v4 gotchas" block (setStyle-diff trap, `getStyle()` non-round-trip, no `setProjection`) | Historical on upgrade — must be rewritten in the migration PR (this report §2/§4 is the replacement text source). | §2, §4 |

## 10. Browser-verification checklist (user-run, WebGL territory)

1. Globe renders: Carto raster sphere, atmosphere toggle (`setSky`, optional), no polar holes.
2. Craft icons: correct silhouettes/colors, heading rotation sane incl. high latitudes; labels + halos legible; clicks open the panel (`queryRenderedFeatures` on globe).
3. Toggle globe↔flat mid-session: no icon flicker/re-registration (network waterfall shows no `/icons/*` refetch), camera stays put, morph animates, button/persistence sync both ways, no "style diff" warning.
4. Flight trail across the dateline (pick a trans-Pacific flight): short-way trail on globe and flat; prediction stub correct.
5. Region draw on globe incl. near the limb (horizon clamp acceptability); hot-zone rects + AIS tile outlines render on globe.
6. Timeline rewind + playback on globe (pure data path — just confirm no render breakage).
7. Console clean of style-validation warnings on both basemap paths.

## 11. Reproduction (measured commands)

```
grep -c "isGlobe" node_modules/maplibre-gl/dist/maplibre-gl.js          # 0
grep -c "vertical-perspective" node_modules/.../maplibre-gl.js          # 0
npm view maplibre-gl dist-tags --json                                   # latest 6.19.0 / latest-5 5.24.1
npm view maplibre-gl@5.24.1 dependencies --json                         # style-spec ^24.8.1
npm view maplibre-gl@6.19.0 dependencies --json                         # style-spec ^26.8.0
# tarball greps: npm view maplibre-gl@<v> dist.tarball | curl -sL | tar -xzO …
```

## Sources (primary)

- CHANGELOG (all quoted entries): https://github.com/maplibre/maplibre-gl-js/blob/main/CHANGELOG.md (v5.24.1 tag: https://github.com/maplibre/maplibre-gl-js/blob/v5.24.1/CHANGELOG.md)
- 5.24.1 type declarations (extracted from `https://registry.npmjs.org/maplibre-gl/-/maplibre-gl-5.24.1.tgz` → `dist/maplibre-gl.d.ts`): `Map.setProjection/getProjection`, `projectiontransition`, `MapOptions` (no `projection`; `canvasContextAttributes.contextType: 'webgl2withfallback'`; `minPitch/maxPitch` 0–180 default 60; `attributionControl`), `addImage`, `on(): Subscription`, `isStyleLoaded(): boolean | void`
- 5.24.1 sources: `src/style/style.ts` (projection load at :495, `setProjection` :1693, `serialize()` includes projection :1486, `case 'setProjection'` diff applier :952)
- Issue #7314 "Style diff in globe projection falls back to full rebuild due to setProjection handling" (closed, fix released in 5.22.0): https://github.com/maplibre/maplibre-gl-js/issues/7314
- Official API docs: `Map.setProjection` — https://maplibre.org/maplibre-gl-js/docs/API/classes/Map/ ; GlobeControl — https://maplibre.org/maplibre-gl-js/docs/API/classes/GlobeControl/
- Official examples: https://maplibre.org/maplibre-gl-js/docs/examples/display-a-globe-with-a-vector-map/ · display-a-globe-with-a-fill-extrusion-layer/ · display-a-globe-with-an-atmosphere/ · zoom-and-planet-size-relation-on-globe/
- Style spec root `projection` property (style-spec 24.10.0 `v8.json` + `index.d.ts`; 20.4.0 enum presence measured in node_modules): https://maplibre.org/maplibre-style-spec/
- v5→v6 migration guide (ESM/`setWorkerUrl`/CSP/imports): https://maplibre.org/maplibre-gl-js/docs/guides/v5-to-v6-migration-guide/
- Release-timeline newsletters: https://maplibre.org/news/2025-01-05-maplibre-newsletter-december-2024/ (v5 launch) · https://maplibre.org/news/2026-08-02-maplibre-newsletter-july-2026/ (v6 shipped) — npm publish dates authoritative for exact days.
- Note: there is **no official v4→v5 migration guide page** (the docs ship only a v5→v6 guide; checked sitemap + `docs/guides/` at the v5.24.1 tag). The canonical breaking-change list for 4→5 is the ⚠️-marked entries in CHANGELOG 5.0.0.
