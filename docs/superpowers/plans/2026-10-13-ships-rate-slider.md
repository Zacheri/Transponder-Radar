# Ships Rate Slider — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a second feed-rate slider ("Ship updates") that controls how
often vessel position updates are applied to the map — a server-side
per-feed flush window — mirroring the existing OpenSky poll slider.

**Architecture:** AIS is a live push stream (no poll interval to tune), so
the slider sets a per-feed broadcast coalescing window: the hub ticks every
250 ms and flushes each feed's dirty crafts when that feed's window elapses
(air = today's `BATCH_MS`, sea = user-set 0.5–15 s). The stream and the store
are untouched; only the server→client flush cadence changes. Rides the
existing `feed.rate` protocol (`FEED_IDS += "ais"`) and the `createFeedRate`
factory.

**Tech Stack:** Node/TS (Fastify + ws), Vitest fake timers, vanilla TS client.

**Spec:** `docs/superpowers/specs/2026-10-13-vendored-aircraft-icon-pack-design.md`
(Appendix A).

## Global Constraints

- **Gate after every task:** `npm test` → `npm run typecheck` →
  `npm run build`, all green (lint broken repo-wide — not in the gate; the
  maplibre-gl >500 kB chunk warning is the accepted build exception).
- **No new npm packages.**
- **Existing hub/store/ws tests keep passing** except where their assertions
  must change mechanically for the new `drainDirty(domain)` signature (those
  edits are called out in Task 1).
- **TDD:** every task red → green → gate → commit. No placeholder code.
- Slider bounds (client and server agree): **min 500 ms, max 15000 ms, step
  500 ms, default 1000 ms**.
- Independent of the icon-pack plan; may execute before, after, or in
  parallel with it (no shared files: icon-pack touches `server/index.ts`
  statusPayload too — if running concurrently, Task 2 here and icon-pack
  Task 7 both edit `server/index.ts`/`server/hub.ts`; sequence the commits,
  rebase, keep both green).

## Review Focus

1. **Both feeds due on the same tick** → exactly one combined `update` frame
   (never two). Pinned: Task 2 combined-frame test.
2. **Sea window much larger than the stream rate** → vessel positions on the
   map lag the true positions by up to the window (intended); HUD "AIS: ok"
   still reflects stream liveness, not the flush. Pinned: Task 2 test
   (craft stays in store with fresh `updatedAt` while unflushed) + spec note.
3. **Page reload restores the slider** from the status frame
   (`feeds.ais.flushMs`); server restart resets to the 1 s default
   (accepted — the value is per-session). Pinned: Task 2 status test +
   Task 3 restore wiring.
4. **Replay/rewind mode is unaffected** — the replay gate and timeline
   snapshots don't interact with the flush windows. Pinned: existing
   `test/replay.test.ts` + `test/history.test.ts` stay green (gate).
5. **Client slider bounds match the server clamp** — a hand-crafted
   `feed.rate` with `feed:"ais", ms:10` must not corrupt the hub. Pinned:
   Task 2 clamp test (server clamps regardless of client).

---

### Task 1: Per-domain dirty drain in the store

**Files:**
- Modify: `server/store.ts` (`drainDirty` gains a domain parameter)
- Modify: `server/hub.ts` (call site)
- Test: `test/store.test.ts` (extend), `test/hub.test.ts` (mechanical)

**Interfaces:**
- Consumes: `Craft.domain` (existing: `"air" | "sea"`).
- Produces:

```ts
// server/store.ts — replaces the current no-arg drainDirty()
drainDirty(domain: "air" | "sea"): { upsert: Craft[]; remove: string[] }
// drains ONLY the dirty ids whose craft has the given domain (removed ids are
// matched against the domain of the craft record if still present; ids already
// removed from the map are drained with the domain the caller tracks — see
// implementation note). Clears only that domain's drained ids.
```

Implementation note: `dirtyUpsert` ids resolve to live crafts (domain
available). `dirtyRemove` ids may no longer be in the map — keep a
`removeDomain = Map<string, "air" | "sea">` populated in `upsert`/`remove`/
`sweep`/`pruneAir` (domain of the removed craft), so the domain filter works
for removals too.

- [ ] **Step 1: Write the failing tests** (extend `test/store.test.ts`)

```ts
test("drainDirty('air') drains only air upserts and removes", () => {
  // upsert one air + one sea craft, remove one air craft
  const air = store.drainDirty("air");
  expect(air.upsert.map((c) => c.id)).toEqual([airId]);
  expect(air.remove).toEqual([removedAirId]);
  const sea = store.drainDirty("sea");
  expect(sea.upsert.map((c) => c.id)).toEqual([seaId]);
  expect(sea.remove).toEqual([]);
  expect(store.drainDirty("air")).toEqual({ upsert: [], remove: [] });
});
test("sweep/pruneAir removals are drained under the right domain", () => {
  // sweep() marks a stale sea craft dirty and removes an old air craft →
  // drainDirty("air").remove contains the air id; drainDirty("sea").upsert
  // contains the stale sea craft
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/store.test.ts`
Expected: FAIL — `drainDirty` takes no argument / behavior unchanged.

- [ ] **Step 3: Implement** per the block + implementation note; update the
  `server/hub.ts` call site temporarily to `drainDirty("air")` **and**
  `drainDirty("sea")` combined (preserves today's behavior exactly —
  `test/hub.test.ts` stays green with only the mechanical signature update if
  it constructs a store directly).

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/store.test.ts test/hub.test.ts`
Expected: PASS.

- [ ] **Step 5: Gate + commit**

```bash
npm test && npm run typecheck && npm run build
git add server/store.ts server/hub.ts test/store.test.ts test/hub.test.ts
git commit -m "feat(ships): per-domain dirty drain in CraftStore"
```

---

### Task 2: Hub per-feed flush windows, protocol, status

**Files:**
- Modify: `server/hub.ts`
- Modify: `server/index.ts` (`feedRate.ais`, hub opts, status `flushMs`)
- Modify: `src/data/ws.ts` (client `FeedStatus.ais.flushMs`)
- Test: `test/hub.test.ts` (extend), `test/ws.test.ts` (extend protocol)

**Interfaces:**
- Consumes: `store.drainDirty(domain)` (Task 1).
- Produces:

```ts
// server/hub.ts
export const FEED_IDS = ["opensky", "ais"] as const;
export const AIS_FLUSH_MIN_MS = 500;
export const AIS_FLUSH_MAX_MS = 15000;

export interface FeedStatus {
  opensky: { lastOkAt: number | null; lastError: string | null; pollMs: number };
  ais: { connected: boolean; enabled: boolean; lastError: string | null; lastMessageAt: number | null; flushMs: number };
}

export interface HubOpts {
  store: CraftStore;
  batchMs: number;        // air flush window (today's BATCH_MS semantics)
  aisFlushMs?: number;    // sea flush window; default = batchMs
  log?: (m: string) => void;
  statusPayload?: () => StatusPayload;
}
// Hub class gains:
setAisFlushMs(ms: number): void;   // clamped to [AIS_FLUSH_MIN_MS, AIS_FLUSH_MAX_MS], live
get aisFlushMs(): number;
```

Behavior: internal tick interval = `250` ms (module constant `TICK_MS`); per
feed track `lastFlushAt`; on tick, `airDue = now - airLast >= batchMs`,
`seaDue = now - seaLast >= this.aisFlushMs`; drain the due domains and
broadcast **one** `update` frame with the combined upsert/remove (skip the
frame when nothing drained); status-frame logic unchanged (still rides the
same tick). Initial `lastFlushAt` = `start()` time (no instant flush burst).

`server/index.ts`: `feedRate: Record<FeedId, (ms) => void>` gains
`ais: (ms) => hub.setAisFlushMs(ms)`; hub construction gains
`aisFlushMs: config.BATCH_MS` (default equals today's behavior);
`statusPayload` feeds.ais object gains `flushMs: hub.aisFlushMs`.

`src/data/ws.ts`: client `FeedStatus.ais` gains `flushMs: number` (mirror).

- [ ] **Step 1: Write the failing tests** (extend `test/hub.test.ts` —
  `vi.useFakeTimers()`; the existing file already drives ticks — follow its
  setup; use a real `CraftStore` with air/sea fixture crafts)

```ts
describe("per-feed flush windows", () => {
  test("air flushes on batchMs, sea held until its window (default = batchMs)", async () => {
    // batchMs 1000, aisFlushMs 2000. t=0: upsert air A + sea S.
    // advance 1000 → frame contains A only.
    // advance 1000 (t=2000) → frame contains S.
  });
  test("air and sea due together → single combined frame", async () => {
    // both due on the same tick → exactly ONE update frame with both ids
    // (count sends on the fake client between advances — Review Focus #1)
  });
  test("setAisFlushMs changes the sea window live", async () => {
    // default 1000; at t=500 setAisFlushMs(3000) → sea upserted at t=600
    // is NOT flushed at t=1000/2000, IS flushed at t=3000+
  });
  test("setAisFlushMs clamps to [500, 15000]", () => {
    hub.setAisFlushMs(10); expect(hub.aisFlushMs).toBe(500);
    hub.setAisFlushMs(99999); expect(hub.aisFlushMs).toBe(15000);
    hub.setAisFlushMs(7000); expect(hub.aisFlushMs).toBe(7000);
  });
  test("unflushed sea craft stays fresh in the store", async () => {
    // sea window 10000; at t=1000 upsert sea with new position →
    // store.get(id) has the new position (stream untouched — Review Focus #2)
  });
});
```

Extend `test/ws.test.ts` (protocol mirror — follow the existing
`parseClientMessage`-adjacent client tests):

```ts
test("feed.rate with feed 'ais' is accepted and sent; 'bogus' rejected", () => {
  // parseClientMessage (import from server/hub.js — the ws test may already
  // import it; if not, follow the existing pattern):
  //   parseClientMessage('{"type":"feed.rate","feed":"ais","ms":5000}') → {type,feed:"ais",ms:5000}
  //   parseClientMessage('{"type":"feed.rate","feed":"bogus","ms":5000}') → null
  // client side: socket.sendFeedRate("ais", 5000) → the fake WS received the frame
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/hub.test.ts test/ws.test.ts`
Expected: new tests FAIL (ais not in FEED_IDS, no windows).

- [ ] **Step 3: Implement** per the block.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/hub.test.ts test/ws.test.ts test/integration.test.ts`
Expected: PASS (integration test's status assertion may need `flushMs` in a
fixture — mechanical).

- [ ] **Step 5: Gate + commit**

```bash
npm test && npm run typecheck && npm run build
git add server/hub.ts server/index.ts src/data/ws.ts test/hub.test.ts test/ws.test.ts
git commit -m "feat(ships): per-feed flush windows + feed.rate 'ais'"
```

---

### Task 3: Client slider + status restore

**Files:**
- Modify: `src/ui/pollrate.ts` (optional `title` tooltip)
- Modify: `src/main.ts` (second slider instance + restore)

No new unit tests beyond the gate (the factory itself is covered by existing
tests; this is wiring — verified in the browser per the handoff).

- [ ] **Step 1: Add tooltip support to `createFeedRate`**

`FeedRateOpts` gains `title?: string`; when present, `label.title = opts.title`
(one line). Add one small test to the existing pollrate test file if one
exists (set/absence of the attribute); if no pollrate test file exists, skip
the test (attribute set is trivial) and note it in the commit.

- [ ] **Step 2: Wire the second slider in `src/main.ts`**

Next to the existing `pollRate` instance:

```ts
const shipRate = createFeedRate(document.getElementById("app") as HTMLElement, {
  label: "Ship updates",
  ariaLabel: "Ship update interval",
  title: "The vessel stream is continuous; this is how often the map applies vessel updates.",
  minMs: 500,
  maxMs: 15000,
  stepMs: 500,
  defaultMs: 1000,
  send: (ms) => socket?.sendFeedRate("ais", ms),
});
```

In `onStatus`, alongside `pollRate.setMs(s.feeds.opensky.pollMs)`:
`shipRate.setMs(s.feeds.ais.flushMs);`

- [ ] **Step 3: Gate**

Run: `npm test && npm run typecheck && npm run build`
Expected: green.

- [ ] **Step 4: Commit + browser handoff**

```bash
git add src/ui/pollrate.ts src/main.ts
git commit -m "feat(ships): ship update rate slider (0.5–15 s, default 1 s)"
```

Handoff to the user (browser-only):
1. `npm run dev` → second slider "Ship updates 1 s" below the aircraft one.
2. Drag to 15 s → vessels move in ~15 s steps; drag back to 1 s → smooth.
   Aircraft slider behavior unchanged.
3. Reload the page → slider restores its position (status `flushMs`).
4. HUD "AIS: ok" stays ok at any slider position (stream liveness is
   independent).
