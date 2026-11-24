# smooth motion implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Client-side dead-reckoning so aircraft glide between poll fixes — pure `effectivePosition` math, a 200 ms repaint tick reusing the existing coalesced `refresh()`, a settings-drawer "Smooth motion" toggle (`radar.motion`, default on), zero protocol/server changes.

**Architecture:** `src/map/motion.ts` (pure position math + self-disabling tick wrapper) plugs into `buildFeatureCollection` via a new optional `motion: { nowMs }` opt consumed only by the LIVE `refresh()` path (playback's `onFrame` never interpolates — it has its own lerp); rewind/playback gating is exactly `replay.rewound` (playback enters replay); the drawer row follows the settings.ts callback idiom with persistence through `src/data/motion-cfg.ts` (StorageLike, icon-colors.ts pattern).

**Tech Stack:** TypeScript, MapLibre GL, Vitest (node env, FakeEl shims for UI).

**Spec:** `docs/superpowers/specs/2026-11-23-smooth-motion-design.md` (R1–R5 + rulings: vessels out, 150 s freeze cap, 200 ms tick, `Craft.speed` is KNOTS — use `MS_PER_KNOT`).

## Global constraints

- One shared `nowMs` per feature-collection build (no intra-frame skew).
- Motion never touches the playback path (`onFrame` main.ts:207 — never pass `motion` there) and never runs while `replay.rewound` is true.
- R2: motion changes only `geometry.coordinates`; property set must stay identical to motion-off (test deep-equals the keys).
- Off state (toggle off, gated, or any R1 exclusion) returns the craft's stored `lat/lon` UNTOUCHED — byte-identical to today.
- No new npm packages. Gate every task: `npm test` → `npm run typecheck` → `npm run build` (maplibre chunk warning accepted). Comments minimal.
- Existing test files: append-style extensions only.

## Review Focus

1. `effectivePosition` table exact (vessel / onGround / speed null|0|neg / heading null|NaN|≥360|<0 / age 0–150 continuous / >150 frozen at 150; knots→meters via `MS_PER_KNOT`, equator 1-min ≈ 1 NM × speed_kt ±0.5%) — Task 1.
2. Playback path provably never interpolates (grep `motion` opt call sites; onFrame excluded) and `replay.rewound` is the single gate — Task 2.
3. Tick lifecycle: single disposer, restart on LIVE, toggle spam leak-free, 3 throws → stopped + warned once — Task 1 + Task 2.
4. Shared clock single-`nowMs`-per-build; toggling OFF triggers one immediate refresh (snap back) — Task 2.
5. `radar.motion` corrupt → default ON; drawer row state always reflects truth after reload — Task 2.
6. `onFrame`, `refresh()` non-motion behavior byte-identical (existing features/main-path tests untouched).

---

### Task 1: Motion module (`src/map/motion.ts`)

**Files:**
- Create: `src/map/motion.ts`
- Test: `test/motion.test.ts`

**Interfaces (spec §A verbatim):**
```ts
export function effectivePosition(c: Craft, nowMs: number): { lat: number; lon: number }
export function startMotionTick(intervalMs: number, onTick: () => void, onGiveUp?: () => void): () => void
```
R1 rules; displacement = `destinationPoint({lat, lon}, heading, speed * MS_PER_KNOT * min(age,150)/1000_meters_form)` (geo.ts `MS_PER_KNOT`, meters). `startMotionTick`: `setInterval`; catches per-tick throws; 3 CONSECUTIVE throws → clearInterval + `onGiveUp?.()` once (default: one `console.warn`); disposer idempotent. Pure clock (no Date inside — `effectivePosition` takes `nowMs`).

- [ ] **Step 1: Failing tests** — R1 table above (factory Craft like features.test.ts `air()`); determinism; equator displacement check (480 kt, 60 s ≈ 480 NM/60 = 8 NM ±0.5%) and 60°N latitude-only leg exact-ish; frozen-at-150 (age 300 s lands same point as age 150 s); on-ground; every R2 passthrough case returns EXACT stored lat/lon (no float churn). Tick: counting fn + real short intervals (30 ms, 15 ms — repo style, no fake timers), disposer stops, throw/throw/throw stops + give-up once, success resets the streak.
- [ ] **Step 2: Fail → implement → pass; full gate.**
- [ ] **Step 3: Commit** `feat(client): dead-reckoning motion module`

### Task 2: Wiring — features, main, drawer, persistence

**Files:**
- Modify: `src/data/features.ts` (`toFeature`/`buildFeatureCollection` gain optional `motion?: { nowMs: number }` in the existing opts object), `src/main.ts`, `src/ui/settings.ts`
- Create: `src/data/motion-cfg.ts` (`loadMotion(storage)/saveMotion(on, storage)` — absent/corrupt → true; save `"1"`/`"0"`, removeItem-on-default allowed either way — impl picks the simpler total posture and pins it in tests)
- Test: `test/features.test.ts` (append), `test/motion-cfg.test.ts` (new), `test/settings-drawer.test.ts` (append), `test/motion-wiring.test.ts` (new — shim level if a main.ts test harness precedent exists; else the wiring is verified via the settings-drawer + features surfaces and pinned manual-checklist items in the report)

**Interfaces:**
- features.ts: when `opts.motion` present, `geometry.coordinates` uses `effectivePosition(c, opts.motion.nowMs)`; NOTHING else changes (heading property keeps the raw value; labels keep speed/heading text).
- main.ts: `let motionOn = loadMotion(localStorage);` boot (before map handlers, zonesCfg idiom). `refresh()`: pass `motion: motionOn && !replay.rewound ? { nowMs: Date.now() } : undefined`. `onFrame`: never. Tick: `let stopMotion: () => void` — armed when `motionOn && !replay.rewound` (start on LIVE restore / toggle on), disposed on toggle off / `replay.enterReplay()` (via the same callback points already starting/stopping playback — do not add new listeners if an existing hook suffices); toggle flip always triggers one immediate `void refresh()`.
- settings.ts: `SettingsApi` unchanged; `createSettings` opts gain `setMotion(on: boolean): void` + the constructor takes the current value (add to opts: `motionOn: boolean`); row `Smooth motion` with a checkbox (label+input idiom from filters drawer), checked = motionOn at build; change → `opts.setMotion(v)`.
- motion-cfg.ts mirrors icon-colors.ts error posture (throw in getItem → default true).

- [ ] **Step 1: Failing tests** — features: motion on moves an eastbound air craft off its stored lon (assert via fixed `nowMs`); off/undefined byte-identical (deep-equal whole FC); gated-equivalent (undefined motion) identical; vessel never displaced even WITH motion opt; property-key parity R2 pin. settings-drawer: row renders checked per opt, click fires `setMotion(false)`. motion-cfg: round-trip, corrupt → true, absent → true, save stores parseable value.
- [ ] **Step 2: Fail → implement → pass; full gate.**
- [ ] **Step 3: AGENTS.md** — `map/motion.ts` + `data/motion-cfg.ts` one-liners, refresh-motion opt + 200 ms tick + `replay.rewound` gate in the `main.ts` bullet, drawer "Smooth motion" row, `radar.motion` key, test count.
- [ ] **Step 4: Commit** `feat(client): smooth motion wiring + drawer toggle`
- [ ] **Step 5: Manual checklist (user):** glide over dense traffic; toggle off mid-glide → instant snap to fixes, no residual drift; rewind → frozen, LIVE → resumes; 20-min hidden tab → no jump-storm on return; toggle spam → no perf leak (DevTools FPS).
