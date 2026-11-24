# Smooth motion — client-side dead-reckoning interpolation — design

Date: 2026-11-23 · Status: draft for user review
Papertrail: `ML_Docs/2026Nov20-1.md` · Wave 8 of the Nov-20 review package.

## Problem

Aircraft positions arrive at poll cadence (default 90 s), so at any zoom the
map shows craft teleporting once per poll. The improvement design ruled
"interpolation over extra polling": between fixes, render the obvious
physics — last fix + velocity × elapsed time along track. Zero server/credit
cost; FR24-class smoothness. Playback already lerps between history frames
(wave 4); this is the same idea for live mode, done once and done pure.

## Rulings (user-approved 2026-11-23 in-chat design)

1. Vessels out — AIS streams ~1 s cadence; already smooth.
2. Extrapolation freezes at 150 s past the last fix (data-outage safety:
   nothing sails off the map).
3. Render tick 200 ms via setInterval (absolute-clock math — a missed tick
   costs a repaint, never accumulated error).
4. Motion is OFF during rewind/REPLAY and during playback (their own lerp).
5. Settings-drawer toggle "Smooth motion", default ON, persisted
   `radar.motion` (localStorage, `radar.zonesCfg` idiom); off = byte-identical
   to today's render path.
6. A throwing motion loop self-disables (log once) — the map must never die
   because of the animation.

## Requirements

- R1 — `effectivePosition(craft, nowMs)` is pure: unchanged for vessels,
  on-ground craft, speed ≤ 0, missing/invalid `Craft.heading` (degrees true,
  nullable — pistons etc.), or age > 150 s (frozen at the 150 s point — not
  the last fix, not beyond); otherwise last fix displaced by
  speed·min(age,150 s) along `heading` (local equirectangular approximation
  is fine at ≤150 s legs; reuse/extend `shared/geo.ts` `destinationPoint`).
  `Craft.speed` is KNOTS (main.ts flight-context math confirms; normalize
  converts OpenSky m/s) — displacement converts explicitly (× 0.514444 m/s
  per kt).
  Air fixes may arrive ground-stale (OpenSky timestamps) — displacement uses
  age from the same clock, so staleness only shrinks the error vs. a frozen
  fix either way.
- R2 — Motion only rewrites WHERE a feature sits (and the same
  `heading` property it already carries for `icon-rotate`) — no new
  properties on features, no layer/paint changes, no protocol changes.
- R3 — Live-mode feature building applies R1 when the toggle is on and
  motion is not gated off (rewind/playback); everything else (icons, filters,
  labels, selection ring) follows position as today.
- R4 — Interpolated craft remain click/selectable at their rendered spot
  (hit-testing follows the source data, so free).
- R5 — Gate green; loop itself browser-verified by the user (R6 convention);
  all math and gating unit-tested. No new npm packages.

## Design

### A. `src/map/motion.ts` (pure + tiny clock loop)

```ts
export interface MotionConfig { enabled: boolean }          // from radar.motion
export function effectivePosition(c: Craft, nowMs: number): { lat: number; lon: number }
  // R1 rules; heading validity: finite && 0 <= heading < 360; null heading
  // -> no displacement.
export function startMotionTick(intervalMs: number, onTick: () => void): () => void
  // setInterval wrapper returning a disposer; try/catch around onTick:
  // N=3 consecutive throws -> stop + single console warn (ruling 6).
```

### B. Wiring (`src/main.ts`, `src/data/features.ts`)

- Feature building already funnels every craft through one builder for the
  `craft-icons`/`craft-labels` source. Change the position read to
  `effectivePosition(c, nowMs)` when `motionOn && !gated` (gated =
  `replay.isReplaying() || playbackActive`), passing one `nowMs` per build
  pass (all craft share the clock — no intra-frame skew).
- `startMotionTick(200, () => rebuildAndSetData())` — same setData path data
  updates use; when motion is off/gated, the tick does not run (disposer).
- Toggle changes flip the flag, immediately rebuild (on→off snaps back to
  true fixes; off→on starts smooth), persist, start/stop the tick.
- Rewind entry stops the tick; LIVE restore restarts it if the toggle is on.

### C. Settings drawer row

`settings.ts`: "Smooth motion" checkbox row (same idiom as the existing
rows), fed from `radar.motion` (absent = on); onChange → callback into
main (which owns the tick), persisted via `src/ui/motion-cfg.ts`
(`loadMotion/saveMotion(storage)` StorageLike pair like icon-colors.ts —
pure, Node-testable).

## Failure modes

- Data outage: everything freezes at its 150 s point (faded styling per
  staleness as today), then sweep removes at REMOVE_MS; on feed recovery,
  fixes resume the live path.
- Heading flicker between adjacent polls (e.g. 359°→1°): displacement uses
  the fresh `heading` from the new fix immediately — no cross-poll turn
  smoothing (out of scope; matches FR24 snap).
- Tab hidden: setInterval throttles; absolute-clock math self-heals on show.
- Toggle spam: each flip is a rebuild + tick start/stop — idempotent, no
  leak (disposer pattern; test pins double-start safety).

## Testing

- `test/motion.test.ts` — R1 table: vessel untouched; on-ground; speed
  0/null; heading null/NaN/out-of-range; age 0 / 60 s / 149.9 / 150 / 300 s
  (frozen point); equator sanity displacement ≈ speed×t (±equirect error) and
  60° N latitude error bound; determinism (same inputs → same output).
  `startMotionTick`: counts, disposer, throw-thrice → stopped + warned once
  (fake fn, not fake timers — counting callback).
- `test/features.test.ts` extend — motion on/off/gated × live (positions
  move/hold; single shared nowMs); R2: no new feature properties appear.
- `test/settings-drawer.test.ts` (or existing drawer file) — toggle row
  presence, persistence round-trip, corrupt → default on.
- Manual (user): enable over dense traffic — craft glide between polls;
  toggle off mid-flight → instant snap to fixes; rewind → motion off, LIVE →
  resumes; leave a tab backgrounded 10 min → no jump/leak on return.

## Out of scope (backlog)

Vessel motion; turn smoothing between heading flips; great-circle legs;
altitude-profile animation; frame-rate scaling with zoom (tick is flat 200 ms);
"catch-up" glide when a fix arrives far from the extrapolated point (currently
snaps, like FR24).
