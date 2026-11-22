# aiscast fill-source implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** a second, protocol-identical AIS client (aiscast) whose two 20°×20° subscribe tiles are aimed one-at-home-region (user-parked) and one-at-viewport, merging into the same vessel store with ToS attribution surfaced in the HUD.

**Architecture:** `server/ais.ts` gains optional parameterization (subscribe-box provider, named logs, per-event hook, attribution tracker) with the aisstream instance's behavior frozen by its existing green tests; a pure tile composer; one new client frame (`ais.tile`); `homeRegion` joins the existing settings doc; status gains `feeds.ais.secondary`; client side adds a debounced `moveend` sender, HUD fill line, and park/clear controls.

**Tech Stack:** TypeScript, `ws`, vanilla-DOM UI, Vitest (node env; real `WebSocketServer` stubs for AIS tests per existing harness).

**Spec:** `docs/superpowers/specs/2026-11-22-aiscast-fill-design.md`

## Global constraints

- R1 FROZEN AISSTREAM: `test/ais.test.ts` passes UNMODIFIED throughout; the aisstream instance keeps today's exact subscribe JSON (`BoundingBoxes: [[[-90,-180],[90,180]]]`), `ais: ` log prefix, deflate/ping/backoff behavior. New opts must default to today's behavior.
- Controller ruling (spec deviation, R1-first): the spec's `AisStreamClient`/`createAisStream` rename is YAGNI-dropped — class name `AisClient` stays; parameterization via new optional opts only. Cost: spec §A naming; none functional.
- ≤2 subscribe boxes on the aiscast connection; re-subscribes debounced ≥1.2 s; subscription-update rate capped at 1/s per connection.
- Browser never sees the token (R4): frames carry only lat/lon.
- aiscast enabled iff `AISCAST_API_KEY` non-empty (config pattern: `X: process.env.X ?? ""`); disabled = zero network, `secondary.enabled:false` in status.
- No new npm packages. Gate after every task: `npm test` → `npm run typecheck` → `npm run build`. Comments minimal, no ticket refs. Fixtures byte-for-byte; never re-record.

## Review Focus

1. Frozen aisstream path: subscribe JSON byte-identical, log prefix `ais: ` unchanged, existing test file untouched (`git show <T2 commit> -- test/ais.test.ts` must be empty) — Task 2.
2. Pan storm: 50 rapid `setBoxes` calls produce ≤1 outbound subscribe per ≥1.2 s window and no leaked timers after `stop()` — Task 2.
3. `homeRegion` null-vs-absent: explicit `null` CLEARS the parked tile; absent leaves it; garbage (NaN/strings) drops the PATCH field while other patch fields still apply — Task 3.
4. `ais.tile` frame with NaN/missing/oversized coords is silently dropped (no crash, no subscription change) — Task 3.
5. Attribution line appears iff `secondary.enabled && connected`, shows ≤3 distinct strings + `+N`, prunes entries unseen >5 min — Task 4.
6. `moveend` sender: nothing sent while status never reported `secondary.enabled === true`; socket-null safety; no duplicate timers — Task 4.

---

### Task 1: Tile composer (`server/ais-tiles.ts`)

**Files:**
- Create: `server/ais-tiles.ts`
- Test: `test/ais-tiles.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces from `server/ais-tiles.js`:
  `type TileCenter = { lat: number; lon: number }`
  `type BoundingBoxes = [[number, number], [number, number]]` // [[minLat,minLon],[maxLat,maxLon]]
  `const TILE_HALF = 10` // 20° boxes
  `clampCenter(c: TileCenter): TileCenter` — lat clamped so `lat±10` stays in `[-90,90]`, lon same for `[-180,180]`
  `boxesFor(center: TileCenter): BoundingBoxes`
  `composeTiles(home: TileCenter | null, follow: TileCenter | null): TileCenter[]` — max 2; drops `follow` duplicate when equal (within 1e-9); order [home?, follow?]; nulls dropped.

- [ ] **Step 1: Failing tests** — clamp edges (lat 89 → 80; lat −95 → −80; lon 175 → 170); boxesFor shape/order; compose dedup/null/order/max-2 cases.
- [ ] **Step 2: Fail → implement → pass; full gate.**
- [ ] **Step 3: Commit** `git commit -am "feat(server): aiscast tile composer"` (add file).

### Task 2: AisClient parameterization (`server/ais.ts`)

**Files:**
- Modify: `server/ais.ts` (behavior-preserving for defaults)
- Test: `test/ais.test.ts` APPEND new describe ONLY (existing cases untouched — Review Focus 1); new fixture none needed (JSON literals inline, protocol is documented)

**Interfaces:**
- Consumes: `server/ais-tiles.js` (Task 1) for default box shape? NO — default stays today's literal (R1); composer used by the aiscast wiring in Task 3.
- Produces (all OPTIONAL, defaults = today):
  `AisClientOpts` gains:
  `name?: string` // log prefix, default `"ais"`
  `boxesProvider?: () => BoundingBoxes[]` // default: global bbox exactly as today
  `trackAttribution?: boolean` // default false
  `resubscribeMs?: number` // debounce for setBoxes re-subscribe, default 1200 (injectable for tests)
  New public members:
  `setBoxes(boxes: BoundingBoxes[]): void` — stores latest; if connected, (re)arms a 1.2 s debounce then sends ONE replacement subscribe frame (protocol replaces in-band); internal min 1.1 s spacing between outbound subscribes regardless of caller churn; NOT armed when disconnected (open handler will send current boxes).
  `get secondaryStatus(): { connected: boolean; lastError: string | null; lastMessageAt: number | null; attributions: string[] }` — `attributions`: distinct `env.attribution ?? env.source ?? env.license` strings (only when `trackAttribution`), keyed by string with last-seen time, PRUNED >5 min on read AND on event; sorted by recency.
- Open handler: subscribe JSON now `{ APIKey, BoundingBoxes: this.currentBoxes(), FilterMessageTypes: [...] }` — for default opts the JSON is byte-identical to today (R1 test pins exact string via the wsImpl wrapper pattern at existing `test/ais.test.ts:167-170`).
- `handleMessage` keeps its shape; attribution capture inside the `onEvent` wiring done by the CALLER (Task 3) OR via `trackAttribution` — implement `trackAttribution` internally in handleMessage right after parse (before type branches) to keep the hook list short.
- 2-box rejection fallback (spec §C): if `SubscriptionConfirmation` arrives and its payload indicates fewer boxes than requested (pin exact semantics from a recorded fixture? aiscast live behavior unknown — implement: accept confirmation as-is, but on close code ≥4000 within 3 s of a 2-box subscribe, RETRY with follow-only boxes and log `"aiscast: fell back to follow tile"`; put the box-dropping decision in a tiny pure helper for testability).

- [ ] **Step 1: Append failing tests** (real `WebSocketServer` harness like existing describes): default subscribe byte-identical (R1, Review Focus 1); custom `boxesProvider` + `name` prefix appears in logs; `setBoxes` pan-storm (50 calls, fake time? timers are real here — use short 1.2 s window + waitFor, or inject `setTimeoutImpl`? NO new seams: use `vi.useFakeTimers()` ONLY if existing client supports it — it doesn't; instead set debounce via `resubscribeMs?: number` opt default 1200 — injectable for tests, ruling: add opt); fallback helper unit tests; `trackAttribution` rolling/prune with injected `now`.
- [ ] **Step 2: Fail → implement → pass. `git diff <T2-base> -- test/ais.test.ts` must show APPEND-ONLY additions. Full gate.**
- [ ] **Step 3: Commit** `git commit -am "feat(server): parameterized AIS client (boxes, attribution, fallback)"`

### Task 3: Wiring — config, settings, frame, status (`server/`)

**Files:**
- Modify: `server/config.ts` (`.env.example` too), `server/hub.ts` (union + validator + `FeedStatus` type), `server/index.ts` (construct aiscast, handlers, status)
- Test: `test/hub.test.ts` (append validator cases), `test/integration.test.ts` (append)

**Interfaces:**
- Consumes: Tasks 1–2 (`composeTiles`, `setBoxes`, `secondaryStatus`, `trackAttribution`).
- Produces:
  `config.AISCAST_API_KEY: string` (+ `.env.example` line, commented like AISSTREAM's).
  Client frames: `{ type:"ais.tile"; lat: number; lon: number }` (validator: both finite; else drop whole frame). `{type:"settings.update"}` patch gains `homeRegion?: {lat:number;lon:number} | null` — validator unchanged (object pass-through); field-level checks live in the index.ts handler (matching existing per-field style).
  `FeedStatus.ais` gains `secondary: { enabled: boolean; connected: boolean; lastError: string | null; lastMessageAt: number | null; attributions: string[] } | null` — `null` when aiscast was never constructed... RULING: never null once shipped; disabled state = `{enabled:false, connected:false, lastError:null, lastMessageAt:null, attributions:[]}` — keep the type non-nullable to kill a whole client-branch class.
  index.ts: construct `aiscast = new AisClient({ name:"aiscast", url: AISCAST_URL, apiKey: config.AISCAST_API_KEY, store, trackAttribution: true, boxesProvider: () => boxesForAll(state), log })` where state = {home from settingsDoc, follow from ais.tile frames}; `setBoxes` called on every state change with `composeTiles(...)` output mapped through `boxesFor`; start/stop guarded by key (mirror the aisstream idiom `if (deps.aiscast || config.AISCAST_API_KEY)`; `deps.aiscast?: AisClient` added to ServerDeps for testability — mirroring `ais?`); `settings.update` case: validate `p.homeRegion === null → clear | object with finite lat/lon → set (clampCenter) | otherwise ignore field`, persist in settingsDoc (index signature preserves it), forward to aiscast tiles; status payload embeds `secondary: aiscast.secondaryStatus` (enabled derived `Boolean(config.AISCAST_API_KEY)`, same posture as primary).
  New case `ais.tile`: `aiscastTiles.setFollow({lat,lon})` (no-op when disabled — but STILL store the follow center? NO: skip entirely when disabled).

- [ ] **Step 1: Failing tests** — hub: `ais.tile` accept/reject matrix (NaN, string, missing → dropped). Integration: boot with `AISCAST_API_KEY` set via injected config override? config is a const — seam: buildApp already accepts deps; add `aiscast?: AisClient` dep and test injects a fake AisClient capturing `setBoxes` calls: send `ais.tile` → expect setBoxes with follow tile; settings.update homeRegion → status echo + setBoxes with [home, follow]; homeRegion:null → cleared; garbage homeRegion object → other patch fields still applied (Review Focus 3); status secondary block present even with disabled key (fake captures... disabled path: construct real client disabled-by-key state instead — keep simple: integration covers enabled path via injected fake asserting setBoxes; disabled path = unit on status assembly via booting with key empty and asserting `secondary.enabled:false`).
- [ ] **Step 2: Fail → implement → pass; full gate.**
- [ ] **Step 3: Commit** `git commit -am "feat(server): aiscast client wiring — tiles frame, homeRegion setting, secondary status"`

### Task 4: Client surfaces (`src/`)

**Files:**
- Modify: `src/data/ws.ts` (sender + client `FeedStatus` mirror + `ais.tile` in sendSettingsUpdate? NO — `sendSettingsUpdate` patch type gains `homeRegion`), `src/main.ts` (moveend sender, settings forwarding, park button opts), `src/ui/hud.ts` (fill line), `src/ui/settings.ts` (park/clear controls)
- Test: `test/ws.test.ts` (append byte-exact sender test), `test/hud.test.ts` (extend existing or new — check on disk), settings-drawer shim test (extend existing settings UI test if present; grep first)

**Interfaces:**
- Consumes: Task 3 status/frame shapes.
- Produces:
  `sendAisTile(lat: number, lon: number): void` — `{type:"ais.tile", lat, lon}`.
  `sendSettingsUpdate` patch type `{ storageCapGb?; ramCacheGb?; homeRegion?: {lat,lon} | null }`.
  Client `FeedStatus` mirror gains `secondary` (non-nullable per Task 3 ruling).
  HUD: below the existing feeds line, a fill line div (hidden by default) — `setFeeds` populates: when `secondary.enabled && secondary.connected` → `AIS fill: <up to 3 attributions joined " · ">< (N more)>`; else hidden (empty). No change to the primary `AIS:` text.
  main.ts: `let aiscastEnabled = false` fed from every status (`secondary?.enabled === true` — optional chain guards pre-secondary servers); `map.on("moveend", debounced1s(() => { if (aiscastEnabled && socket) socket.sendAisTile(center...) }))` inside the load block; settings drawer opts gain `parkHome: () => void` (posts `settings.update {homeRegion: map.getCenter()}`) and `clearHome: () => void` (posts `{homeRegion: null}`); drawer shows current home from `setStats` (extend `SettingsStats` with `homeRegion?: {lat,lon}|null` from `s.settings`... status.settings block on server must echo homeRegion — Task 3 responsibility: ADD `homeRegion` to the status settings block echo (coordinating edit; Task 3 owns it).
- [ ] **Step 1: Failing tests** — ws sender byte-exact; hud fill-line render/hide rules (existing DOM-shim pattern); settings drawer buttons post right patches (existing shim pattern).
- [ ] **Step 2: Fail → implement → pass; full gate.**
- [ ] **Step 3: AGENTS.md** — `ais.ts` line (parameterized client + aiscast instance), config block env list (`AISCAST_API_KEY`), WS protocol both directions (`ais.tile`, `settings.update` patch, `feeds.ais.secondary`), `ui/` HUD fill line, settings drawer park control, test count bump; `.env.example` already done in T3.
- [ ] **Step 4: Commit** `git commit -am "feat(client): aiscast tile follow, home parking, attribution line"`
- [ ] **Step 5: User manual checklist** (spec Testing/manual): park tile, pan follow (server logs), attribution line appears when fill delivering, kill key → disabled status, aisstream unaffected with aiscast down.
