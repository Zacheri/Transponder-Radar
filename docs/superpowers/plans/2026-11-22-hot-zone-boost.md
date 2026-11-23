# hot-zone boost implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Credit-guarded densest-cluster OpenSky zone polling (1-credit bbox calls funded only by surplus credits) with a kind-colored map highlight, checkbox/slider controls, and HUD boost state.

**Architecture:** Two pure modules (`server/hotzones.ts`: zone engine + scheduler) feed a zone-tick mechanism inside `OpenSkyPoller` (own setTimeout, never touches the globe chain; zone responses NEVER prune air coverage); one new client frame (`zones.config`) plus two additive status fields (`feeds.opensky.boost`, `status.hotzone`); client adds a filter-drawer section (air-kind checkboxes + interval slider, `radar.zonesCfg` persistence), a `hotzone-fill` polygon layer between track layers and icons, and HUD boost segments.

**Tech Stack:** TypeScript, Fastify/ws, MapLibre GL, Vitest (node env; poller tests call `pollOnce()` directly with stub `fetchImpl`/`now` — no fake timers).

**Spec:** `docs/superpowers/specs/2026-11-22-hot-zone-boost-design.md` (incl. rulings: one zone/densest cluster, surplus-only funding, air kinds only, dateline = non-wrapping grid, per-craft impossible-by-credit-law).

## Global constraints

- NEVER `store.pruneAir()` from a zone poll — its `present` set is partial; pruning on it would delete the world from the store. Only the globe poll prunes. (Review Focus 1.)
- Zone calls are `/states/all?lamin&lomin&lamax&lomax` on the SAME authed fetch path; box ≤25 sq° (halfW/halfH ≤2.5°) by engine construction; `lon` clamped so the box never crosses ±180.
- Scheduler math is pure and total: missing/NaN `X-Rate-Limit-Remaining` → surplus 0 → boost paused. Boost can never delay, block, or replace a globe poll (separate timers, no shared backoff state).
- Zone 429: compute pause like the globe formula (`retry-after` ?? `x-rate-limit-retry-after-seconds` ?? exponential, cap `BACKOFF_CAP_MS`) into `boostPausedUntil`; do NOT increment the globe's `consecutiveErrors`. Zone replies otherwise flow through the identical `normalizeOpenSky` → `resolveIcon` → `upsert` path.
- Additive protocol fields stay legacy-safe: `boost` and `hotzone` are OPTIONAL client-side; `zones.config` validation drops bad frames whole (kinds ⊆ AIR_KINDS dedup, boostMs clamped [10000, 120000]).
- No new npm packages. Gate every task: `npm test` → `npm run typecheck` → `npm run build`. Comments minimal, no ticket refs. `test/poller.test.ts` existing cases must stay green unmodified (extend by append).

## Review Focus

1. No `pruneAir` on any zone path; globe prune semantics byte-identical — Task 2.
2. Scheduler table: default 90 s globe ⇒ surplus ≈ 160 ⇒ boost @10 s stretches/pauses exactly per spec math; reserve recomputed from LIVE `pollMs` after slider moves — Task 1 + Task 2.
3. Legacy frames: `boost`/`hotzone` deleted from a status fixture → HUD text, drawer, layer, main wiring all behave (the wave-6 `delete`-field test idiom) — Tasks 3–4.
4. Zone upserts carry icons (`resolveIcon` applied) and `kind` (normalize unchanged) — Task 2.
5. `zones.config` full-replace semantics + validation matrix (empty kinds = disable; dup kinds; non-air kind; NaN boostMs → drop whole frame) — Task 3.
6. Drawer restore: `radar.zonesCfg` parsed at boot BEFORE first status; slider position round-trips; corrupt storage → defaults, no throw — Task 4.

---

### Task 1: Engine + scheduler (`server/hotzones.ts`)

**Files:**
- Create: `server/hotzones.ts`
- Test: `test/hotzones.test.ts`

**Interfaces:**
- Consumes: `shared/craft.js` (`AirKind`, `Craft`).
- Produces from `server/hotzones.js`:
```ts
export interface ZoneMember { id: string; kind: AirKind; lat: number; lon: number }
export interface HotZone { center: LonLat; halfW: number; halfH: number; count: number; dominantKind: AirKind }
export interface ZoneState { cells: Record<string, number>; lastMembersAt: number; box: HotZone | null } // shape impl may refine; tests pin behavior not fields
export function planZone(members: ZoneMember[], nowMs: number, prev: ZoneState | null): { zone: HotZone | null; state: ZoneState }
  // 2° non-wrapping grid; densest cell + 8-neighbors cluster; ties by later input order;
  // box = centroid ± members, halfW/halfH <= 2.5, lon edges clamped to +-180;
  // create >=2 members, sustain >=1 (expire lastMembersAt + 5*60_000);
  // broadcast-copy hysteresis: returned zone keeps prev.box unless centroid drift > 0.5 deg
  //   (a kept stale box still reports fresh count).
export function surplusCredits(remaining: number | null, nowMs: number, globePollMs: number, globeCost: number): number
  // null/NaN remaining -> 0; reserve = ceil(secToUtcMidnight(now)/globePollMs)*globeCost + 100; max(0, remaining - reserve)
export function zoneIntervalFor(requestedMs: number, surplus: number, nowMs: number): number | null
  // interval = max(requested, ceil(secToUtcMidnight / surplus) * 1000); null if surplus < 1 or floor > 120000
```
(`LonLat` from `shared/geo.js`.)

- [ ] **Step 1: Failing tests** — clustering (two clusters → densest wins; tie determinism; members outside 3×3 neighborhood excluded from box), 5°×5° cap, lon clamp at ±180, hysteresis create/sustain/expire with injected `nowMs`, copy-hysteresis (drift 0.4° keeps prev box, 0.6° moves it, count updates either way), empty members → null. Scheduler table: remaining null/NaN → 0; remaining below reserve → 0; big surplus keeps requested interval; surplus 100 with 3600 s to midnight → 36000 s → floor 120000 rules → stretch vs pause exactly; midnight boundary (23:59:59) arithmetic; reserve tracks pollMs (90000 vs 900000).
- [ ] **Step 2: Fail → implement → pass; full gate.**
- [ ] **Step 3: Commit** `feat(server): hot-zone engine + credit scheduler`

### Task 2: Poller zone mechanism (`server/opensky.ts`)

**Files:**
- Modify: `server/opensky.ts`
- Test: `test/poller.test.ts` APPEND only (existing cases byte-untouched)

**Interfaces:**
- Consumes: Task 1 (`planZone`, `surplusCredits`, `zoneIntervalFor`, types).
- Produces (public API on `OpenSkyPoller`; opts unchanged):
  `setZonesConfig(cfg: { kinds: AirKind[]; boostMs: number } | null): void` (null/full-replace semantics; enabling starts the zone timer machinery, disabling clears zone + timer).
  `feedStatus` gains `boost: { active: boolean; count: number; intervalMs: number | null; paused: "credits" | null } | null` (null when config null; existing 3 fields unchanged — poller.test consumers keep compiling).
  `get zoneStatus(): { center: LonLat; halfW: number; halfH: number; count: number; dominantKind: AirKind } | null` (the broadcast-copy box).
  Private mechanism: capture `this.statesRemaining` from `x-rate-limit-remaining` in `pollOnce` (routes.ts idiom: present + finite wins; else keep previous). Shared private `fetchStates(url)` extraction of today's fetch/401/parse tail (R1: globe behavior identical incl. header reads). Zone tick `pollZoneOnce()` own `setTimeout` armed after every globe response AND every zone attempt: guard chain — config active → zone exists (planZone from `store.all()` filtered air+kinds, using `now`) → funded (`zoneIntervalFor(requested, surplusCredits(statesRemaining, now, this.opts.pollMs, 4), now)` non-null AND due) → fetch bbox URL, parse rows via the SAME success-path tail MINUS `pruneAir` (Review Focus 1), upsert; not-due → reschedule; 429 → `boostPausedUntil` (own formula, globe `consecutiveErrors` untouched) + interval null/paused until expiry; unfunded → `paused: "credits"`.
  Status assembly (Task 3 consumes; do NOT touch hub/index here).

- [ ] **Step 1: Append failing tests** (harness: direct `pollOnce()`/`pollZoneOnce()` via `(poller as any)` or exported-for-test method — PREFER making `pollZoneOnce()` public like `pollOnce`): `X-Rate-Limit-Remaining` capture (stub header; absent → unchanged); zone tick fetch URL query params exactly `lamin/lomin/lamax/lomax` from the engineered cluster; zone upsert reaches store WITH icon (resolveIcon stub) AND store's non-zone craft survive (pruneAir-not-called proof: seed a far-away air craft, zone poll, still present); paused states (remaining below reserve → `boost.paused === "credits"`, no fetch); zone 429 → paused, globe consecutiveErrors unaffected (globe 429 backoff schedule then verified still its own); disable (`setZonesConfig(null)`) → zoneStatus null, no tick.
- [ ] **Step 2: Fail → implement → pass; append-only proof (`git diff <base> -- test/poller.test.ts` additions only). Full gate.**
- [ ] **Step 3: Commit** `feat(server): credit-guarded hot-zone polling in the OpenSky poller`

### Task 3: Frames + status wiring (`server/`)

**Files:**
- Modify: `server/hub.ts`, `server/index.ts`
- Test: `test/hub.test.ts` (append), `test/integration.test.ts` (append), `test/ws.test.ts` (sender comes in Task 4 — hub-side here only)

**Interfaces:**
- Consumes: Task 2 (`setZonesConfig`, `feedStatus.boost`, `zoneStatus`).
- Produces:
  `ClientMessage` union += `| { type: "zones.config"; kinds: CraftKind[]; boostMs: number }`; validator: `kinds` array (every member in AIR_KINDS, deduped → reject frame on ANY invalid member), non-empty-or-empty OK, `boostMs` finite (clamping [10000,120000] happens in the poller, validator only checks finiteness — pin which layer clamps in tests).
  `FeedStatus.opensky` type += `boost?: ... | null` (mirror poller); `StatusPayload` += `hotzone: { center: LonLat; halfW: number; halfH: number; count: number; kind: AirKind } | null` (note: `dominantKind` renamed `kind` on the wire — single source name in hub type).
  index.ts: `case "zones.config": opensky.setZonesConfig({ kinds: msg.kinds as AirKind[], boostMs: msg.boostMs }); break;`; statusPayload `hotzone:` from `opensky.zoneStatus` (map `dominantKind` → `kind`; null passthrough). `boost` rides `opensky.feedStatus` automatically once Task 2's getter includes it (verify it flows — do not duplicate).

- [ ] **Step 1: Failing tests** — validator matrix (valid full-replace; `[]` kinds; duplicate kinds; `["cargo"]` → frame DROPPED; boostMs NaN/`"30000"` → dropped); integration: send `zones.config` {military, 30000} → injected/polling stub: `setZonesConfig` observed (real poller instance with stubbed fetch: assert status `boost.active === true` and `hotzone` null until a poll forms a zone — engineer 2 military rows in the stub /states payload, pollOnce, zone appears in next status with kind "military"); legacy status shape test: strip boost/hotzone from a hand-built payload — hub still broadcasts (additive).
- [ ] **Step 2: Fail → implement → pass; full gate.**
- [ ] **Step 3: Commit** `feat(server): zones.config frame + boost/hotzone status`

### Task 4: Client surfaces (`src/`)

**Files:**
- Modify: `src/data/ws.ts`, `src/ui/filters.ts`, `src/ui/hud.ts`, `src/main.ts`, `src/style.css` (if the rect needs CSS — it doesn't; layer paint lives in style defs; only add if drawer styling needs rules — follow existing drawer css patterns in style.css)
- Create: `src/map/hotzone.ts`, `src/ui/zones-cfg.ts` (pure parse/serialize, StorageLike idiom like icon-colors.ts)
- Test: `test/ws.test.ts` (append), `test/hotzone.test.ts` (new: defs + data builder), `test/zones-cfg.test.ts` (new), `test/hud.test.ts` (append boost segment), drawer shim test (append to existing filters/drawer test file if one exists — grep; else new)

**Interfaces:**
- Consumes: Task 3 wire shapes.
- Produces:
  ws.ts: `sendZonesConfig(kinds: CraftKind[], boostMs: number): void`; `FeedStatus.opensky.boost?` mirror; `StatusMessage.hotzone?: ... | null`.
  `zones-cfg.ts`: `interface ZonesCfg { kinds: CraftKind[]; boostMs: number }` + `parseZonesCfg(raw: string | null): ZonesCfg | null` + `serializeZonesCfg(cfg): string` + key `radar.zonesCfg` (defaults applied in main, parser returns null on anything malformed).
  `src/map/hotzone.ts`: `HOTZONE_LAYER` id, `hotzoneDefs()` (fill layer: `fill-color ["get","color"]`, `fill-opacity 0.18`, + 1px line stroke same color `fill-outline`-style via companion line layer OR single fill layer — pin single fill + line-outline choice per style-validator feedback), `setHotzone(map, zone | null, color: string)` (builds the 5-point rect ring from center±half; Feature with `color` property; empty FC clears), `addHotzoneLayer(map)` with the `below = "craft-icons"` idiom, called in main after `addTrackLayers(map)`.
  filters.ts: after `group("Sea", …)` — `drawer-group` "Boost zones", four AIR_KINDS checkboxes tinted `color.getColor(k)`, `input[type=range]` slider 10–120 s step 5 labeled with value (pollrate.ts idiom), callback `onZonesChange(cfg: ZonesCfg) | undefined` — add OPTIONAL 5th arg to `createFilters` opts-style (existing call sites keep compiling; main passes it).
  hud.ts: append to feeds string ` · Boost: <count> @<s>s` when `feeds.opensky.boost?.active` with interval, ` · Boost paused` when active+paused; absent/null → nothing (legacy idiom).
  main.ts: boot-restore `zonesCfg` before socket handlers wired; on change → persist + `socket?.sendZonesConfig(...)` + send once on first socket open; `onStatus` → `setHotzone(map, s.hotzone ?? null, effectiveColorFor(kind))` (reuse `iconColorFor`) + drawer `setCounts`-style sync of checked state (display only — config lives in `zonesCfg`).
- [ ] **Step 1: Failing tests** — byte-exact sender; zones-cfg parse/serialize round-trip + corrupt → null; hotzone defs pass validateStyleMin extension (add layer + source to the two full-style arrays) + setHotzone geometry (center ± half → closed ring, count/color property); hud boost segment states (active/paused/legacy-deleted); drawer shim: slider input → onZonesChange with clamped value, checkbox → kinds array, restore from storage seeds controls.
- [ ] **Step 2: Fail → implement → pass; full gate.**
- [ ] **Step 3: AGENTS.md** — poller line (hot-zone mechanism + remaining-header capture), `hotzones.ts` one-liner, `zones.config` frame + `boost`/`hotzone` status fields in both directions, `ui/` boost section + HUD segment, `map/` hotzone layer, `radar.zonesCfg`, test count bump.
- [ ] **Step 4: Commit** `feat(client): hot-zone controls, highlight layer, HUD boost state`
- [ ] **Step 5: User manual checklist** (spec Testing/manual): check Military over busy region → rect + HUD boost within a cycle; Network (server log) shows bbox calls at slider cadence while globe continues; slow globe → boost survives; fast globe + fast boost → paused: credits; uncheck → zone clears within one cycle.
