# Timeline, Poll Rate & FAA Enrichment — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a live poll-rate slider, a durable history cache with a timeline-rewind UI, and FAA type/year/owner enrichment to the transponder radar.

**Architecture:** All new behavior lives in small server modules (`history.ts`, `faa.ts`, `faa-lookup.ts`) wired through the existing Fastify+WS app, plus thin client UI modules (`timeline.ts`, `pollrate.ts`) and a pure `ReplayGate` state machine. The WS protocol gains client→server control frames (`poll.rate`, `timeline.seek`, `timeline.live`, `aircraft.info`) and richer `status` frames; the `Craft` wire model is unchanged.

**Tech Stack:** Node 20 + TypeScript (ESM, `strict`), Fastify + `ws`, Vite + vanilla TS, MapLibre GL (untouched), Vitest (Node env), new runtime dep `yauzl` (zip reading).

**Spec:** `docs/superpowers/specs/2026-10-03-timeline-pollrate-faa-design.md` — read it first; it carries the rationale and the verified FAA source facts.

## Global Constraints

- Gate after **every** task: `npm test` then `npm run typecheck` then `npm run build` — all must pass. `npm run lint` is broken repo-wide and NOT part of the gate.
- `tsconfig` is `strict` with `noUnusedLocals`/`noUnusedParameters` — no dead code.
- ESM imports use explicit `.js` extensions for local modules (e.g. `import { Hub } from "./hub.js"`).
- Never commit or echo secret values; never add files under `data/` (gitignored).
- The map's style/layers are untouched by this plan — do not edit `src/map/*` or `src/data/features.ts`/`filter.ts` except where a task explicitly says so.
- WS protocol has no shared file: server shapes live in `server/hub.ts` / `server/faa.ts`, mirrored client-side in `src/data/ws.ts`. Keep both ends in sync within each task.
- Test helpers available: `test/util.ts` (`sleep`, `waitFor`). Existing test patterns: fake sockets (`test/hub.test.ts`), injected `fetchImpl`/`now` (`test/poller.test.ts`).
- Commit after each task with the exact message given in that task.

## File Structure

**Created:**
- `server/history.ts` — `HistoryRecorder`: gzipped snapshot log, size-capped eviction, disk-backed seek.
- `server/faa.ts` — `parseCsv`, `buildIndex`, `FaaLoader` (bulk DB download/parse/refresh), `FaaRecord`/`FaaStatus` types, `FaaProvider` DI interface.
- `server/faa-lookup.ts` — `parseNResult` (HTML), `FaaLookup` (per-click N-number fallback + persistent enrichment cache).
- `src/ui/timeline.ts` — bottom scrubber bar.
- `src/ui/pollrate.ts` — poll-rate slider pill.
- `src/data/replay.ts` — `ReplayGate` (pure rewind-mode state machine).
- `test/history.test.ts`, `test/replay.test.ts`, `test/faa.test.ts`, `test/faa-lookup.test.ts`.
- `test/fixtures/faa-inquiry.html`, `faa-nresult.html`, `faa-nresult-dereg.html` (already recorded and present in the repo — use them; do NOT re-fetch from the network in tests).

**Modified:**
- `server/opensky.ts` — `setInterval`, `feedStatus.pollMs`, `POLL_MIN_MS`/`POLL_MAX_MS`.
- `server/hub.ts` — `FeedStatus.opensky.pollMs`, `ClientMessage` + `parseClientMessage`, `StatusPayload` (feeds + history + faa) in status frames.
- `server/index.ts` — client-frame dispatch, recorder/loader/lookup wiring, DI for tests.
- `server/config.ts` — `HISTORY_SNAPSHOT_MS`, `HISTORY_MAX_BYTES`, `FAA_REFRESH_MS`.
- `server/classify.ts` — export `N_NUMBER_RE`.
- `src/data/ws.ts` — new frames, `HistoryRange`/`FaaStatus`/`AircraftInfo` mirror types, send helpers, `onConnection`/`onStatus` handler split.
- `src/main.ts` — wiring (rewind mode, timeline, poll-rate, info cache).
- `src/ui/hud.ts` — REPLAY badge + replayed-time clock.
- `src/ui/panel.ts` — Type / N-number / Owner rows with pending state, `PanelHooks`, `setInfo`.
- `src/style.css` — `.pollrate`, `.timeline`, `.hud-replay`.
- `package.json` — `yauzl` (dep), `@types/yauzl` (dev).
- `.env.example` — three new keys.
- `test/hub.test.ts`, `test/ws.test.ts`, `test/poller.test.ts`, `test/integration.test.ts` — extended per task.
- `README.md`, `AGENTS.md` — Task E.

---

### Task A: Live poll rate (server + slider)

**Files:**
- Modify: `server/opensky.ts`, `server/hub.ts`, `server/index.ts`
- Create: `src/ui/pollrate.ts`
- Modify: `src/data/ws.ts`, `src/main.ts`, `src/style.css`
- Test: `test/poller.test.ts`, `test/hub.test.ts`, `test/ws.test.ts`

**Interfaces:**
- Produces: `OpenSkyPoller.setInterval(ms: number): void`; `OpenSkyPoller.feedStatus: { lastOkAt; lastError; pollMs: number }`; `POLL_MIN_MS = 15000`, `POLL_MAX_MS = 3600000` (exported from `server/opensky.ts`); `FeedStatus.opensky.pollMs: number`; `ClientMessage` type + `parseClientMessage(raw: string): ClientMessage | null` (in `server/hub.ts`); `RadarSocket.sendPollRate(ms: number)` and `RadarSocket.send(obj: unknown)`; `createPollRate(root: HTMLElement, send: (ms: number) => void): { setPollMs(ms: number): void }`.
- Consumes: nothing from later tasks. Task B extends `ClientMessage` handling (its branches already parse but dispatch is a `default: break` until then).

- [ ] **Step A1: Failing tests for `setInterval`**

Append to `test/poller.test.ts` (add `POLL_MIN_MS, POLL_MAX_MS` to the existing import from `../server/opensky.js`):

```ts
describe("setInterval", () => {
  it("reports the current interval in feedStatus", () => {
    const store = new CraftStore();
    const p = new OpenSkyPoller({ url, pollMs: 120000, graceMs: 30000, store });
    expect(p.feedStatus.pollMs).toBe(120000);
  });

  it("clamps below POLL_MIN_MS and above POLL_MAX_MS", () => {
    const store = new CraftStore();
    const p = new OpenSkyPoller({ url, pollMs: 120000, graceMs: 30000, store });
    p.setInterval(1000);
    expect(p.feedStatus.pollMs).toBe(POLL_MIN_MS);
    p.setInterval(999999999);
    expect(p.feedStatus.pollMs).toBe(POLL_MAX_MS);
    p.setInterval(45000);
    expect(p.feedStatus.pollMs).toBe(45000);
  });

  it("applies the new interval to the next successful poll", async () => {
    const store = new CraftStore();
    const p = new OpenSkyPoller({ url, pollMs: 120000, graceMs: 30000, store });
    p.setInterval(30000);
    current = { time: 0, states: [PLANE] };
    expect((await p.pollOnce()).nextDelayMs).toBe(30000);
  });
});
```

- [ ] **Step A2: Run to verify failure**

Run: `npx vitest run test/poller.test.ts`
Expected: FAIL — `setInterval` is not a function / `feedStatus.pollMs` undefined.

- [ ] **Step A3: Implement in `server/opensky.ts`**

Add exported constants next to `BACKOFF_CAP_MS`:

```ts
export const POLL_MIN_MS = 15000;
export const POLL_MAX_MS = 3600000;
```

In the class, change the `feedStatus` getter to include the interval and add `setInterval` (applies from the next cycle; it also becomes the backoff base because the loop reads `this.opts.pollMs` every iteration):

```ts
  get feedStatus(): { lastOkAt: number | null; lastError: string | null; pollMs: number } {
    return { lastOkAt: this.lastOkAt, lastError: this.lastError, pollMs: this.opts.pollMs };
  }

  setInterval(ms: number): void {
    const n = Math.round(ms);
    if (Number.isFinite(n)) {
      this.opts.pollMs = Math.min(POLL_MAX_MS, Math.max(POLL_MIN_MS, n));
    }
  }
```

- [ ] **Step A4: Run to verify pass**

Run: `npx vitest run test/poller.test.ts`
Expected: PASS.

- [ ] **Step A5: Failing tests for `parseClientMessage` + status `pollMs`**

Append to `test/hub.test.ts`:

```ts
import { parseClientMessage } from "../server/hub.js"; // add to the existing hub.js import

describe("parseClientMessage", () => {
  it("accepts well-formed control frames", () => {
    expect(parseClientMessage(JSON.stringify({ type: "poll.rate", ms: 60000 }))).toEqual({ type: "poll.rate", ms: 60000 });
    expect(parseClientMessage(JSON.stringify({ type: "timeline.seek", time: 123 }))).toEqual({ type: "timeline.seek", time: 123 });
    expect(parseClientMessage(JSON.stringify({ type: "timeline.live" }))).toEqual({ type: "timeline.live" });
    expect(parseClientMessage(JSON.stringify({ type: "aircraft.info", id: "ac4963" }))).toEqual({ type: "aircraft.info", id: "ac4963" });
  });

  it("rejects malformed frames", () => {
    expect(parseClientMessage("not json")).toBeNull();
    expect(parseClientMessage(JSON.stringify({ type: "poll.rate" }))).toBeNull();
    expect(parseClientMessage(JSON.stringify({ type: "poll.rate", ms: -5 }))).toBeNull();
    expect(parseClientMessage(JSON.stringify({ type: "poll.rate", ms: "60000" }))).toBeNull();
    expect(parseClientMessage(JSON.stringify({ type: "timeline.seek" }))).toBeNull();
    expect(parseClientMessage(JSON.stringify({ type: "aircraft.info", id: "" }))).toBeNull();
    expect(parseClientMessage(JSON.stringify({ type: "bogus" }))).toBeNull();
  });
});
```

Update the two existing tests that construct `FeedStatus` objects ("broadcasts a status frame when the feed status changes" and "attach sends the snapshot then the status"): add `pollMs: 120000` to each `opensky` object (and the `FeedStatus`-typed `feeds` variable in the first).

- [ ] **Step A6: Run to verify failure**

Run: `npx vitest run test/hub.test.ts`
Expected: FAIL — `parseClientMessage` not exported.

- [ ] **Step A7: Implement in `server/hub.ts`**

Extend `FeedStatus` and add the client-frame protocol:

```ts
export interface FeedStatus {
  opensky: { lastOkAt: number | null; lastError: string | null; pollMs: number };
  ais: { connected: boolean; enabled: boolean };
}

export type ClientMessage =
  | { type: "poll.rate"; ms: number }
  | { type: "timeline.seek"; time: number }
  | { type: "timeline.live" }
  | { type: "aircraft.info"; id: string };

export function parseClientMessage(raw: string): ClientMessage | null {
  try {
    const m = JSON.parse(raw) as ClientMessage;
    if (m.type === "poll.rate" && typeof m.ms === "number" && Number.isFinite(m.ms) && m.ms > 0) return m;
    if (m.type === "timeline.seek" && typeof m.time === "number" && Number.isFinite(m.time)) return m;
    if (m.type === "timeline.live") return m;
    if (m.type === "aircraft.info" && typeof m.id === "string" && m.id.length > 0) return m;
    return null;
  } catch {
    return null;
  }
}
```

- [ ] **Step A8: Wire dispatch in `server/index.ts`**

In `buildApp`, import `parseClientMessage` from `./hub.js` and replace the `/ws` handler with:

```ts
  app.get("/ws", { websocket: true }, (socket) => {
    const ws = socket as any;
    hub.attach(ws);
    ws.on("message", (data: Buffer | string) => {
      const msg = parseClientMessage(data.toString());
      if (!msg) return;
      switch (msg.type) {
        case "poll.rate":
          opensky.setInterval(msg.ms);
          break;
        // "timeline.seek", "timeline.live", "aircraft.info": wired by later tasks
        default:
          break;
      }
    });
  });
```

The `feedStatus` lambda needs no change — `opensky.feedStatus` now carries `pollMs`.

- [ ] **Step A9: Run server-side tests + typecheck**

Run: `npx vitest run test/hub.test.ts test/poller.test.ts && npm run typecheck`
Expected: PASS / clean.

- [ ] **Step A10: Client — extend `src/data/ws.ts`**

- Add `pollMs: number` to `FeedStatus.opensky` (mirror of the server type).
- Add to `RadarSocket`:

```ts
  send(obj: unknown): void {
    this.ws?.send(JSON.stringify(obj));
  }

  sendPollRate(ms: number): void {
    this.send({ type: "poll.rate", ms });
  }
```

- In `test/ws.test.ts`, add `pollMs: 120000` to the `feeds` constant.

- [ ] **Step A11: Create `src/ui/pollrate.ts`**

```ts
const MIN_MS = 30000;
const MAX_MS = 900000;
const STEP_MS = 15000;
const DEFAULT_MS = 120000;

const CREDITS_PER_POLL = 4;
const WARN_CREDITS_PER_DAY = 2000;
const DANGER_CREDITS_PER_DAY = 4000;

export function createPollRate(
  root: HTMLElement,
  send: (ms: number) => void,
): { setPollMs: (ms: number) => void } {
  const el = document.createElement("div");
  el.className = "pollrate";
  const label = document.createElement("span");
  label.className = "pollrate-label";
  const slider = document.createElement("input");
  slider.type = "range";
  slider.min = String(MIN_MS);
  slider.max = String(MAX_MS);
  slider.step = String(STEP_MS);
  slider.value = String(DEFAULT_MS);
  slider.setAttribute("aria-label", "Aircraft poll interval");
  const credits = document.createElement("span");
  credits.className = "pollrate-credits";
  el.append(label, slider, credits);
  root.appendChild(el);

  function render(ms: number): void {
    label.textContent = `Aircraft poll ${Math.round(ms / 1000)} s`;
    const c = Math.ceil(86400000 / ms) * CREDITS_PER_POLL;
    credits.textContent = `≈${c.toLocaleString()} credits/day`;
    credits.dataset.level = c >= DANGER_CREDITS_PER_DAY ? "danger" : c >= WARN_CREDITS_PER_DAY ? "warn" : "ok";
  }

  slider.addEventListener("input", () => {
    const ms = Number(slider.value);
    render(ms);
    send(ms);
  });

  function setPollMs(ms: number): void {
    slider.value = String(Math.min(MAX_MS, Math.max(MIN_MS, ms)));
    render(Number(slider.value));
  }

  setPollMs(DEFAULT_MS);
  return { setPollMs };
}
```

- [ ] **Step A12: Wire in `src/main.ts`**

- `import { createPollRate } from "./ui/pollrate.js";`
- Before the `map.on("load", ...)` callback, add:

```ts
let socket: RadarSocket | null = null;
const pollRate = createPollRate(document.getElementById("app") as HTMLElement, (ms) => {
  socket?.sendPollRate(ms);
});
```

- Inside `map.on("load", ...)`, change `const socket = new RadarSocket(...)` to `socket = new RadarSocket(...)` (same arguments).
- In the socket handlers, extend the feeds handler:

```ts
    onFeeds: (feeds, t) => {
      hud.setFeeds(feeds, t);
      pollRate.setPollMs(feeds.opensky.pollMs);
    },
```

- [ ] **Step A13: Styles in `src/style.css`**

Append:

```css
.pollrate {
  position: absolute;
  top: 12px;
  right: 12px;
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 12px;
  background: var(--panel);
  border: 1px solid var(--border);
  border-radius: 999px;
  backdrop-filter: blur(8px);
  font-size: 12px;
  z-index: 10;
}
.pollrate-label {
  color: var(--muted);
  white-space: nowrap;
}
.pollrate input[type="range"] {
  width: 110px;
  accent-color: #4fc3f7;
}
.pollrate-credits {
  color: var(--muted);
  font-size: 11px;
  white-space: nowrap;
  font-variant-numeric: tabular-nums;
}
.pollrate-credits[data-level="warn"] {
  color: #ffb300;
}
.pollrate-credits[data-level="danger"] {
  color: #ef5350;
}
```

- [ ] **Step A14: Run the full gate**

Run: `npm test && npm run typecheck && npm run build`
Expected: all pass (build chunk warning is the accepted exception).

- [ ] **Step A15: Commit**

```bash
git add server/opensky.ts server/hub.ts server/index.ts src/ui/pollrate.ts src/data/ws.ts src/main.ts src/style.css test/poller.test.ts test/hub.test.ts test/ws.test.ts
git commit -m "feat: live aircraft poll-rate control (slider + poll.rate frame)"
```

---

### Task B: History recorder + timeline rewind

**Files:**
- Create: `server/history.ts`, `src/data/replay.ts`, `src/ui/timeline.ts`, `test/history.test.ts`, `test/replay.test.ts`
- Modify: `server/config.ts`, `server/hub.ts`, `server/index.ts`, `src/data/ws.ts`, `src/main.ts`, `src/ui/hud.ts`, `src/style.css`, `.env.example`
- Test: `test/hub.test.ts`, `test/ws.test.ts`, `test/integration.test.ts`

**Interfaces:**
- Consumes: `FeedStatus` (Task A shape), `parseClientMessage` / `ClientMessage` (Task A), `RadarSocket.send`.
- Produces: `HistoryRange = { from: number | null; to: number | null; snapshots: number }` (exported from `server/history.ts` and mirrored in `src/data/ws.ts`); `HistoryRecorder` with `init(): Promise<void>`, `start(getCrafts: () => Craft[]): void`, `stop(): void`, `recordNow(getCrafts: () => Craft[]): Promise<void>`, `range(): HistoryRange`, `seek(time: number): Promise<{ time: number | null; craft: Craft[] }>`; `StatusPayload = { feeds: FeedStatus; history: HistoryRange }` (hub); `ReplayGate` with `rewound: boolean`, `enterReplay(): void`, `requestLive(): void`, `onSnapshot(): boolean`, `onUpdate(): boolean`; `RadarSocket.sendTimelineSeek(t: number)` / `sendTimelineLive()`; `RadarSocket` handlers `onConnection` (renamed from `onStatus`) and `onStatus(s: StatusMessage)`; `createTimeline(root, { seek, goLive }): { setRange(from, to): void; setLive(): void }`; `createHud(...).setReplay(t: number | null): void`; `config.HISTORY_SNAPSHOT_MS`, `config.HISTORY_MAX_BYTES`.

- [ ] **Step B1: Config + env**

`server/config.ts` — add to the `config` object:

```ts
  HISTORY_SNAPSHOT_MS: int("HISTORY_SNAPSHOT_MS", 60000),
  HISTORY_MAX_BYTES: int("HISTORY_MAX_BYTES", 10_737_418_240),
```

`.env.example` — append:

```
# Timeline rewind: snapshot cadence (ms) and disk cap in bytes — oldest snapshots are
# evicted first once the cap is exceeded (data/history/).
HISTORY_SNAPSHOT_MS=60000
HISTORY_MAX_BYTES=10737418240
```

- [ ] **Step B2: Failing tests for `ReplayGate` (`test/replay.test.ts`)**

```ts
import { describe, it, expect } from "vitest";
import { ReplayGate } from "../src/data/replay.js";

describe("ReplayGate", () => {
  it("applies updates and snapshots while live", () => {
    const g = new ReplayGate();
    expect(g.rewound).toBe(false);
    expect(g.onSnapshot()).toBe(true);
    expect(g.onUpdate()).toBe(true);
  });

  it("suppresses updates while rewound but still applies the seek snapshot", () => {
    const g = new ReplayGate();
    g.enterReplay();
    expect(g.rewound).toBe(true);
    expect(g.onSnapshot()).toBe(true);
    expect(g.onUpdate()).toBe(false);
  });

  it("returns to live only on the snapshot that answers timeline.live", () => {
    const g = new ReplayGate();
    g.enterReplay();
    expect(g.onUpdate()).toBe(false);
    g.requestLive();
    expect(g.onUpdate()).toBe(false); // live snapshot not received yet
    expect(g.onSnapshot()).toBe(true);
    expect(g.rewound).toBe(false);
    expect(g.onUpdate()).toBe(true);
  });
});
```

- [ ] **Step B3: Run to verify failure, then implement `src/data/replay.ts`**

Run: `npx vitest run test/replay.test.ts` → FAIL (module missing).

```ts
export class ReplayGate {
  rewound = false;
  private expectLive = false;

  enterReplay(): void {
    this.rewound = true;
  }

  requestLive(): void {
    this.expectLive = true;
  }

  /** Snapshot frames are always applied; the one answering requestLive() exits rewind. */
  onSnapshot(): boolean {
    if (this.expectLive) {
      this.expectLive = false;
      this.rewound = false;
    }
    return true;
  }

  onUpdate(): boolean {
    return !this.rewound;
  }
}
```

Run: `npx vitest run test/replay.test.ts` → PASS.

- [ ] **Step B4: Failing tests for `HistoryRecorder` (`test/history.test.ts`)**

```ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, readdir, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HistoryRecorder } from "../server/history.js";
import type { Craft } from "../../shared/craft.js";

function craft(id: string): Craft {
  return { id, domain: "air", kind: "commercial", lat: 1, lon: 2, speed: 10, heading: 90, updatedAt: 0, stale: false };
}

describe("HistoryRecorder", () => {
  let dir: string;
  let t = 1_000_000_000;

  beforeEach(async () => {
    t = 1_000_000_000;
    dir = await mkdtemp(join(tmpdir(), "radar-hist-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const rec = (maxBytes = 1_000_000) =>
    new HistoryRecorder({ dir, snapshotMs: 60000, maxBytes, now: () => t });

  it("starts empty; seek returns null time", async () => {
    const h = rec();
    await h.init();
    expect(h.range()).toEqual({ from: null, to: null, snapshots: 0 });
    expect(await h.seek(t)).toEqual({ time: null, craft: [] });
  });

  it("records gzipped snapshots that round-trip to the exact craft list", async () => {
    const h = rec();
    await h.init();
    const crafts = [craft("a1"), craft("a2")];
    await h.recordNow(() => crafts);
    expect(await readdir(dir)).toEqual([`${t}.json.gz`]);
    expect(h.range()).toEqual({ from: t, to: t, snapshots: 1 });
    expect(await h.seek(t)).toEqual({ time: t, craft: crafts });
  });

  it("seek picks the newest snapshot <= t, clamping early and late", async () => {
    const h = rec();
    await h.init();
    t = 1000;
    await h.recordNow(() => [craft("s1")]);
    t = 2000;
    await h.recordNow(() => [craft("s2")]);
    expect((await h.seek(1500)).time).toBe(1000);
    expect((await h.seek(500)).time).toBe(1000); // clamped to oldest
    expect((await h.seek(99999)).time).toBe(2000); // clamped to newest
    expect((await h.seek(99999)).craft[0].id).toBe("s2");
  });

  it("evicts oldest snapshots first beyond maxBytes", async () => {
    const h = rec(1); // any real snapshot exceeds 1 byte → keep only the newest
    await h.init();
    t = 1000;
    await h.recordNow(() => [craft("s1")]);
    t = 2000;
    await h.recordNow(() => [craft("s2")]);
    t = 3000;
    await h.recordNow(() => [craft("s3")]);
    expect(await readdir(dir)).toEqual([`${3000}.json.gz`]);
    expect(h.range()).toEqual({ from: 3000, to: 3000, snapshots: 1 });
  });

  it("rebuilds the index from disk on init (restart)", async () => {
    const h1 = rec();
    await h1.init();
    t = 1000;
    await h1.recordNow(() => [craft("s1")]);
    t = 2000;
    await h1.recordNow(() => [craft("s2")]);
    const h2 = rec();
    await h2.init();
    expect(h2.range()).toEqual({ from: 1000, to: 2000, snapshots: 2 });
    expect((await h2.seek(1500)).craft[0].id).toBe("s1");
  });
});
```

(`utimes` import may be unused after trimming — if so, drop it to satisfy `noUnusedLocals`.)

- [ ] **Step B5: Run to verify failure, then implement `server/history.ts`**

Run: `npx vitest run test/history.test.ts` → FAIL (module missing).

```ts
import { gzipSync, gunzipSync } from "node:zlib";
import { mkdir, readdir, readFile, stat, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Craft } from "../shared/craft.js";

export interface HistoryRange {
  from: number | null;
  to: number | null;
  snapshots: number;
}

export interface HistoryRecorderOpts {
  dir: string;
  snapshotMs: number;
  maxBytes: number;
  now?: () => number;
  log?: (msg: string) => void;
}

interface Meta {
  ts: number;
  size: number;
}

export class HistoryRecorder {
  private timer: NodeJS.Timeout | null = null;
  private index: Meta[] = []; // ascending ts
  private now: () => number;

  constructor(private opts: HistoryRecorderOpts) {
    this.now = opts.now ?? Date.now;
  }

  async init(): Promise<void> {
    await mkdir(this.opts.dir, { recursive: true });
    this.index = [];
    for (const f of await readdir(this.opts.dir)) {
      const m = /^(\d+)\.json\.gz$/.exec(f);
      if (!m) continue;
      const st = await stat(join(this.opts.dir, f)).catch(() => null);
      if (st) this.index.push({ ts: Number(m[1]), size: st.size });
    }
    this.index.sort((a, b) => a.ts - b.ts);
    await this.evict();
  }

  start(getCrafts: () => Craft[]): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      this.recordNow(getCrafts()).catch((e) =>
        this.opts.log?.(`history: ${e instanceof Error ? e.message : String(e)}`),
      );
    }, this.opts.snapshotMs);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async recordNow(getCrafts: () => Craft[]): Promise<void> {
    const ts = this.now();
    const buf = gzipSync(Buffer.from(JSON.stringify(getCrafts())));
    await writeFile(join(this.opts.dir, `${ts}.json.gz`), buf);
    this.index.push({ ts, size: buf.length });
    this.index.sort((a, b) => a.ts - b.ts);
    await this.evict();
  }

  private async evict(): Promise<void> {
    let total = this.index.reduce((s, m) => s + m.size, 0);
    // Always keep at least the newest snapshot, even below the cap.
    while (total > this.opts.maxBytes && this.index.length > 1) {
      const oldest = this.index.shift()!;
      total -= oldest.size;
      await unlink(join(this.opts.dir, `${oldest.ts}.json.gz`)).catch(() => {});
    }
  }

  range(): HistoryRange {
    const n = this.index.length;
    return { from: n ? this.index[0].ts : null, to: n ? this.index[n - 1].ts : null, snapshots: n };
  }

  /** Newest snapshot with ts <= time; clamps to oldest/newest; null time when empty. */
  async seek(time: number): Promise<{ time: number | null; craft: Craft[] }> {
    if (this.index.length === 0) return { time: null, craft: [] };
    let pick = this.index[0];
    for (const m of this.index) {
      if (m.ts <= time) pick = m;
      else break;
    }
    const raw = await readFile(join(this.opts.dir, `${pick.ts}.json.gz`));
    const craft = JSON.parse(gunzipSync(raw).toString("utf8")) as Craft[];
    return { time: pick.ts, craft };
  }
}
```

Run: `npx vitest run test/history.test.ts` → PASS.

- [ ] **Step B6: Extend `server/hub.ts` with `StatusPayload`**

```ts
import type { HistoryRange } from "./history.js";

export interface StatusPayload {
  feeds: FeedStatus;
  history: HistoryRange;
}
```

- `HubOpts.feedStatus` becomes `statusPayload?: () => StatusPayload` (rename at the definition; Task A call sites are updated in Step B8).
- In `attach`, replace the old status send with:

```ts
    const payload = this.opts.statusPayload?.();
    if (payload) {
      socket.send(JSON.stringify({ type: "status", feeds: payload.feeds, history: payload.history, serverTime: Date.now() }));
    }
```

- In `tick`, replace the feed-status change detection with:

```ts
    const payload = this.opts.statusPayload?.();
    if (payload) {
      const json = JSON.stringify({ feeds: payload.feeds, history: payload.history });
      if (this.lastStatusJson !== json) {
        this.lastStatusJson = json;
        const frame = JSON.stringify({ type: "status", feeds: payload.feeds, history: payload.history, serverTime: Date.now() });
        for (const c of this.clients) {
          try {
            c.send(frame);
          } catch {
            /* ignore */
          }
        }
      }
    }
```

Update `test/hub.test.ts`: change every `feedStatus: () => feeds` to `statusPayload: () => ({ feeds, history: { from: null, to: null, snapshots: 0 } })` (and destructure/shape local `feeds` vars as `FeedStatus` where typed). Add a test:

```ts
  it("status frames carry history bounds", async () => {
    const store = new CraftStore();
    let history = { from: null, to: null, snapshots: 0 };
    const feeds = { opensky: { lastOkAt: null, lastError: null, pollMs: 120000 }, ais: { connected: false, enabled: false } };
    const hub = new Hub({ store, batchMs: 20, statusPayload: () => ({ feeds, history }) });
    const sock = fakeSocket();
    hub.attach(sock);
    const st = JSON.parse(sock.sent[1]);
    expect(st.history).toEqual({ from: null, to: null, snapshots: 0 });
    history = { from: 100, to: 200, snapshots: 2 };
    hub.start();
    await waitFor(() => statusFrames(sock.sent).length >= 2);
    const last = statusFrames(sock.sent)[statusFrames(sock.sent).length - 1];
    expect(last.history).toEqual({ from: 100, to: 200, snapshots: 2 });
    hub.stop();
  });
```

- [ ] **Step B7: Wire the recorder in `server/index.ts`**

- Imports: `HistoryRecorder` + `HistoryRange` from `./history.js`; `resolve`/`join` already imported (`resolve` yes; add `join` if needed).
- Add to `ServerDeps`: `recorder?: HistoryRecorder | null`.
- In `buildApp`, after the hub is created:

```ts
  const recorder =
    deps.recorder === undefined
      ? new HistoryRecorder({
          dir: resolve(process.cwd(), "data/history"),
          snapshotMs: config.HISTORY_SNAPSHOT_MS,
          maxBytes: config.HISTORY_MAX_BYTES,
          log,
        })
      : deps.recorder;
  if (recorder) await recorder.init();
  const emptyRange: HistoryRange = { from: null, to: null, snapshots: 0 };
```

- Replace the hub's `feedStatus` option with:

```ts
        statusPayload: () => ({
          feeds: {
            opensky: opensky.feedStatus,
            ais: { connected: ais.isConnected, enabled: Boolean(config.AISSTREAM_API_KEY) },
          },
          history: recorder ? recorder.range() : emptyRange,
        }),
```

- After `hub.start();` add `recorder?.start(() => store.all());`.
- In the message dispatch switch, add:

```ts
        case "timeline.seek": {
          const r = recorder;
          if (!r) break;
          void r.seek(msg.time).then((res) => {
            ws.send(JSON.stringify({ type: "timeline.state", time: res.time, craft: res.craft }));
          });
          break;
        }
        case "timeline.live":
          ws.send(JSON.stringify({ type: "snapshot", craft: store.all() }));
          break;
```

(Keep the now-stale "wired by later tasks" comment trimmed to `aircraft.info`.)
- In `stop`: `recorder?.stop();`

- [ ] **Step B8: Client protocol in `src/data/ws.ts`**

- Add:

```ts
export interface HistoryRange {
  from: number | null;
  to: number | null;
  snapshots: number;
}

export interface StatusMessage {
  type: "status";
  feeds: FeedStatus;
  history: HistoryRange;
  serverTime: number;
}
```

- `RadarMessage` becomes:

```ts
export type RadarMessage =
  | { type: "snapshot"; craft: Craft[] }
  | { type: "update"; upsert: Craft[]; remove: string[] }
  | StatusMessage
  | { type: "timeline.state"; time: number | null; craft: Craft[] };
```

- `parseRadarMessage`: status branch becomes
  `if (msg.type === "status" && msg.feeds != null && msg.history != null && typeof msg.serverTime === "number") return msg;`
  and add
  `if (msg.type === "timeline.state" && (msg.time === null || typeof msg.time === "number") && Array.isArray(msg.craft)) return msg;`.
- Handlers: rename `onStatus` (connection state) to `onConnection`, and add `onStatus?: (s: StatusMessage) => void` plus `onTimelineState?: (time: number | null, craft: Craft[]) => void`. Dispatch in `onmessage`:

```ts
      if (msg.type === "snapshot") this.handlers.onSnapshot(msg.craft);
      else if (msg.type === "update") this.handlers.onUpdate(msg.upsert, msg.remove);
      else if (msg.type === "status") this.handlers.onStatus?.(msg);
      else this.handlers.onTimelineState?.(msg.time, msg.craft);
```

  and in `open`/`close`: `this.handlers.onConnection?.(...)`.
- Send helpers:

```ts
  sendTimelineSeek(time: number): void {
    this.send({ type: "timeline.seek", time });
  }

  sendTimelineLive(): void {
    this.send({ type: "timeline.live" });
  }
```

- `test/ws.test.ts`: update the status fixtures to include `history: { from: null, to: null, snapshots: 0 }`; add tests:

```ts
  it("accepts a timeline.state frame (number time)", () => {
    const raw = JSON.stringify({ type: "timeline.state", time: 123, craft: [] });
    const msg = parseRadarMessage(raw);
    expect(msg).not.toBeNull();
    if (msg?.type === "timeline.state") expect(msg.time).toBe(123);
  });

  it("accepts a timeline.state frame (null time)", () => {
    const raw = JSON.stringify({ type: "timeline.state", time: null, craft: [] });
    expect(parseRadarMessage(raw)?.type).toBe("timeline.state");
  });

  it("rejects a status frame missing history", () => {
    const raw = JSON.stringify({ type: "status", feeds, serverTime: 2000 });
    expect(parseRadarMessage(raw)).toBeNull();
  });
```

- [ ] **Step B9: Create `src/ui/timeline.ts`**

```ts
export interface TimelineApi {
  setRange: (from: number | null, to: number | null) => void;
  setLive: () => void;
}

export function createTimeline(
  root: HTMLElement,
  opts: { seek: (t: number) => void; goLive: () => void },
): TimelineApi {
  const el = document.createElement("div");
  el.className = "timeline";
  const rangeLbl = document.createElement("span");
  rangeLbl.className = "timeline-range";
  const slider = document.createElement("input");
  slider.type = "range";
  slider.setAttribute("aria-label", "Timeline scrubber");
  const selLbl = document.createElement("span");
  selLbl.className = "timeline-sel";
  const liveBtn = document.createElement("button");
  liveBtn.className = "timeline-live";
  liveBtn.textContent = "LIVE";
  el.append(rangeLbl, slider, selLbl, liveBtn);
  root.appendChild(el);

  let from: number | null = null;
  let to: number | null = null;
  let debounce: number | null = null;

  const fmt = (t: number) => new Date(t).toLocaleTimeString([], { hour12: false });

  function setRange(f: number | null, t: number | null): void {
    from = f;
    to = t;
    const enabled = f != null && t != null;
    el.classList.toggle("disabled", !enabled);
    if (!enabled) {
      rangeLbl.textContent = "no history yet";
      selLbl.textContent = "";
      return;
    }
    slider.min = String(f);
    slider.max = String(t);
    slider.step = "1000";
    slider.value = String(t);
    rangeLbl.textContent = `${fmt(f)} – ${fmt(t)}`;
    selLbl.textContent = "live";
  }

  slider.addEventListener("input", () => {
    const t = Number(slider.value);
    selLbl.textContent = fmt(t);
    liveBtn.classList.add("active");
    if (debounce != null) clearTimeout(debounce);
    debounce = window.setTimeout(() => opts.seek(t), 150);
  });

  liveBtn.addEventListener("click", () => {
    liveBtn.classList.remove("active");
    selLbl.textContent = "live";
    opts.goLive();
  });

  function setLive(): void {
    liveBtn.classList.remove("active");
    selLbl.textContent = "live";
  }

  return { setRange, setLive };
}
```

- [ ] **Step B10: REPLAY badge in `src/ui/hud.ts`**

- Add a badge element after the dot:

```ts
  const replayBadge = document.createElement("span");
  replayBadge.className = "hud-replay";
  replayBadge.textContent = "REPLAY";
  el.append(dot, replayBadge, status, counts, feedsEl, clock);
```

- Add state + extend the return type with `setReplay`:

```ts
  let replayT: number | null = null;

  function renderClock(): void {
    const pad = (n: number) => String(n).padStart(2, "0");
    if (replayT != null) {
      const d = new Date(replayT);
      clock.textContent = `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
      clock.classList.add("replay");
      return;
    }
    clock.classList.remove("replay");
    const d = new Date();
    clock.textContent = `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
  }
```

(replace the existing `renderClock` body accordingly; keep the `setInterval(renderClock, 1000)`).

```ts
  function setReplay(t: number | null): void {
    replayT = t;
    replayBadge.classList.toggle("visible", t != null);
    renderClock();
  }
```

Return `{ setCounts, setStatus, setFeeds, setReplay }` and extend the return type.

- [ ] **Step B11: Wire in `src/main.ts`**

- Imports: `createTimeline` from `./ui/timeline.js`, `ReplayGate` from `./data/replay.js`.
- After `let socket ...; const pollRate ...;` add:

```ts
const replay = new ReplayGate();
const timeline = createTimeline(document.getElementById("app") as HTMLElement, {
  seek: (t) => {
    replay.enterReplay();
    hud.setReplay(t);
    socket?.sendTimelineSeek(t);
  },
  goLive: () => {
    replay.requestLive();
    socket?.sendTimelineLive();
  },
});
```

- The socket handlers object (built in Task A) becomes:

```ts
  const socket = new RadarSocket(wsUrl, {
    onSnapshot: (crafts) => {
      replay.onSnapshot();
      if (!replay.rewound) timeline.setLive();
      store.applySnapshot(crafts);
    },
    onUpdate: (upsert, remove) => {
      if (replay.onUpdate()) store.applyUpdate(upsert, remove);
    },
    onConnection: (s) => hud.setStatus(s),
    onStatus: (s) => {
      hud.setFeeds(s.feeds, s.serverTime);
      pollRate.setPollMs(s.feeds.opensky.pollMs);
      timeline.setRange(s.history.from, s.history.to);
    },
    onTimelineState: (time, crafts) => {
      store.applySnapshot(crafts);
      hud.setReplay(time);
    },
  });
```

(Remove the old `onFeeds` and old connection-state `onStatus` handlers; the rename to `onConnection` matches the Task B8 change in `ws.ts`.)

- [ ] **Step B12: Styles in `src/style.css`**

Change `.hud { bottom: 12px; ... }` to `bottom: 60px;` and append:

```css
.timeline {
  position: absolute;
  bottom: 12px;
  left: 12px;
  right: 12px;
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 6px 14px;
  background: var(--panel);
  border: 1px solid var(--border);
  border-radius: 999px;
  backdrop-filter: blur(8px);
  font-size: 11px;
  z-index: 9;
}
.timeline.disabled {
  opacity: 0.5;
  pointer-events: none;
}
.timeline input[type="range"] {
  flex: 1;
  accent-color: #4fc3f7;
}
.timeline-range {
  color: var(--muted);
  white-space: nowrap;
  font-variant-numeric: tabular-nums;
}
.timeline-sel {
  color: var(--text);
  white-space: nowrap;
  font-variant-numeric: tabular-nums;
  min-width: 64px;
  text-align: right;
}
.timeline-live {
  background: none;
  border: 1px solid var(--border);
  border-radius: 999px;
  color: var(--muted);
  font-size: 11px;
  padding: 2px 10px;
  cursor: pointer;
}
.timeline-live.active {
  border-color: #ffb300;
  color: #ffb300;
}
.hud-replay {
  display: none;
  color: #ffb300;
  font-size: 10px;
  letter-spacing: 0.08em;
}
.hud-replay.visible {
  display: inline;
}
.hud-clock.replay {
  color: #ffb300;
}
```

- [ ] **Step B13: Update `test/integration.test.ts`**

Pass the new DI nulls so the test app doesn't touch disk or the network. Find the `buildApp(...)` call (it currently passes stub feeds) and add `recorder: null` to the deps. Assert the status frame shape:

```ts
      expect(st.feeds.opensky.pollMs).toBeTypeOf("number");
      expect(st.history).toEqual({ from: null, to: null, snapshots: 0 });
```

(Adapt to the test's existing variable names — read the file first.)

- [ ] **Step B14: Run the full gate**

Run: `npm test && npm run typecheck && npm run build`
Expected: all pass.

- [ ] **Step B15: Commit**

```bash
git add server/history.ts server/config.ts server/hub.ts server/index.ts src/data/replay.ts src/data/ws.ts src/ui/timeline.ts src/ui/hud.ts src/main.ts src/style.css .env.example test/history.test.ts test/replay.test.ts test/hub.test.ts test/ws.test.ts test/integration.test.ts
git commit -m "feat: timeline rewind — gzipped history log, seek frames, scrubber UI"
```

---

### Task C: FAA bulk registry (type/year/owner for US-registered aircraft)

**Files:**
- Create: `server/faa.ts`, `test/faa.test.ts`
- Modify: `package.json` (dep), `server/config.ts`, `server/hub.ts`, `server/index.ts`, `server/classify.ts`, `src/data/ws.ts`, `src/ui/panel.ts`, `src/main.ts`, `.env.example`, `test/hub.test.ts`, `test/ws.test.ts`, `test/integration.test.ts`

**Interfaces:**
- Consumes: `StatusPayload` (Task B), `parseClientMessage` (Task A).
- Produces: `FaaRecord = { nNumber: string; year: number | null; mfr: string | null; model: string | null; owner: string | null; city: string | null; state: string | null }`; `FaaStatus = { state: "loading" | "ready" | "stale" | "error"; updatedAt: number | null; aircraft: number; lastError: string | null }`; `FaaProvider = { lookup(hex: string): FaaRecord | null; merge(hex: string, rec: FaaRecord): void; status(): FaaStatus; init(): Promise<void>; stop(): void }`; `parseCsv(text: string): string[][]`; `buildIndex(masterText: string, refText: string): Map<string, FaaRecord>`; `FaaLoader implements FaaProvider` with `constructor(opts: { dir: string; refreshMs: number; zipUrl?: string; fetchImpl?: typeof fetch; now?: () => number; log?: (m: string) => void })`; `FRESHNESS_MS = 20 * 3600 * 1000` (exported); `StatusPayload.faa: FaaStatus`; `RadarSocket.sendAircraftInfo(id: string)`; client `AircraftInfo` type + `onAircraftInfo` handler; `PanelHooks = { getInfo?: (id: string) => AircraftInfo | undefined; requestInfo?: (id: string) => void }`; `createPanel(root, hooks).setInfo(id, info)`.

- [ ] **Step C1: Install the zip dependency**

```bash
npm install yauzl && npm install -D @types/yauzl
```

- [ ] **Step C2: Failing tests (`test/faa.test.ts`)**

```ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseCsv, buildIndex, FaaLoader, FRESHNESS_MS } from "../server/faa.js";

function masterRow(n: string, code: string, year: string, name: string, city: string, state: string, hex: string): string {
  const f = new Array<string>(35).fill("");
  f[0] = n;
  f[2] = code;
  f[4] = year;
  f[6] = name;
  f[9] = city;
  f[10] = state;
  f[33] = hex;
  return f.join(",");
}

const MASTER = [
  "N-NUMBER,SERIAL NUMBER,MFR MDL CODE,ENG MFR MDL,YEAR MFR,TYPE REGISTRANT,NAME,STREET,STREET2,CITY,STATE,ZIP CODE,REGION,COUNTY,COUNTRY,LAST ACTION DATE,CERT ISSUE DATE,CERTIFICATION,TYPE AIRCRAFT,TYPE ENGINE,STATUS CODE,MODE S CODE,FRACT OWNER,AIR WORTH DATE,OTHER NAMES(1),OTHER NAMES(2),OTHER NAMES(3),OTHER NAMES(4),OTHER NAMES(5),EXPIRATION DATE,UNIQUE ID,KIT MFR, KIT MODEL,MODE S CODE HEX,",
  masterRow("100GX", "4500304", "2007", "BRULECREEK AVIATION LLC", "PARK CITY", "UT", "A00560"),
  masterRow("1234A", "9999999", "", "HIDDEN OWNER", "TULSA", "OK", "A1B2C3"),
  masterRow("5678B", "1382529", "2019", "", "DENVER", "CO", "DEADBEEF"),
].join("\n");

const REF = [
  "CODE,MFR,MODEL,TYPE-ACFT,TYPE-ENG,AC-CAT,BUILD-CERT-IND,NO-ENG,NO-SEATS,AC-WEIGHT,SPEED,TC-DATA-SHEET,TC-DATA-HOLDER,",
  "4500304,ISRAEL AIRCRAFT INDUSTRIES,GULFSTREAM G150,5,5,1,0,02,149,CLASS 3,0000,,",
  "1382529,BOEING,737-8DR,5,5,1,0,02,149,CLASS 3,0000,,",
].join("\n");

describe("parseCsv", () => {
  it("handles BOM, padding, and quoted fields", () => {
    const rows = parseCsv('\ufeff"O\'BRIEN & SONS",  TULSA ,');
    expect(rows).toEqual([["O'BRIEN & SONS", "TULSA", ""]]);
  });
});

describe("buildIndex", () => {
  const idx = buildIndex(MASTER, REF);

  it("joins master + ref on MFR MDL CODE, keyed by lowercased hex", () => {
    expect(idx.get("a00560")).toEqual({
      nNumber: "100GX",
      year: 2007,
      mfr: "ISRAEL AIRCRAFT INDUSTRIES",
      model: "GULFSTREAM G150",
      owner: "BRULECREEK AVIATION LLC",
      city: "PARK CITY",
      state: "UT",
    });
  });

  it("nulls missing year and unknown model code; keeps owner", () => {
    expect(idx.get("a1b2c3")).toEqual({
      nNumber: "1234A",
      year: null,
      mfr: null,
      model: null,
      owner: "HIDDEN OWNER",
      city: "TULSA",
      state: "OK",
    });
  });

  it("nulls redacted owners (blank NAME)", () => {
    expect(idx.get("deadbeef")?.owner).toBeNull();
    expect(idx.get("deadbeef")?.model).toBe("737-8DR");
  });
});

describe("FaaLoader", () => {
  let dir: string;
  let t: number;
  let fetchCalls: number;

  beforeEach(async () => {
    t = Date.now();
    fetchCalls = 0;
    dir = await mkdtemp(join(tmpdir(), "radar-faa-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const writeFiles = async (ageMs = 0) => {
    await writeFile(join(dir, "MASTER.txt"), MASTER);
    await writeFile(join(dir, "ACFTREF.txt"), REF);
    if (ageMs > 0) {
      const when = new Date(t - ageMs);
      await utimes(join(dir, "MASTER.txt"), when, when);
      await utimes(join(dir, "ACFTREF.txt"), when, when);
    }
  };

  it("loads fresh files from disk without fetching", async () => {
    await writeFiles(0);
    const loader = new FaaLoader({ dir, refreshMs: 3600000, now: () => t, fetchImpl: (async () => { fetchCalls++; throw new Error("no network in this test"); }) as typeof fetch });
    await loader.init();
    expect(fetchCalls).toBe(0);
    expect(loader.status().state).toBe("ready");
    expect(loader.status().aircraft).toBe(3);
    expect(loader.lookup("a00560")?.nNumber).toBe("100GX");
    loader.stop();
  });

  it("falls back to stale disk data when a refresh download fails", async () => {
    await writeFiles(FRESHNESS_MS + 60000);
    const loader = new FaaLoader({ dir, refreshMs: 3600000, now: () => t, fetchImpl: (async () => { fetchCalls++; throw new Error("net down"); }) as typeof fetch });
    await loader.init();
    expect(loader.status().state).toBe("stale");
    expect(loader.lookup("a00560")?.nNumber).toBe("100GX");
    loader.stop();
  });

  it("reports error when download fails and no disk data exists", async () => {
    const loader = new FaaLoader({ dir, refreshMs: 3600000, now: () => t, fetchImpl: (async () => { fetchCalls++; throw new Error("net down"); }) as typeof fetch });
    await loader.init();
    expect(loader.status().state).toBe("error");
    expect(loader.status().lastError).toBe("net down");
    expect(loader.lookup("a00560")).toBeNull();
    loader.stop();
  });
});
```

- [ ] **Step C3: Run to verify failure, then implement `server/faa.ts`**

Run: `npx vitest run test/faa.test.ts` → FAIL (module missing).

```ts
import yauzl from "yauzl";
import { mkdir, readFile, readdir, stat, unlink, utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Buffer } from "node:buffer";

export interface FaaRecord {
  nNumber: string;
  year: number | null;
  mfr: string | null;
  model: string | null;
  owner: string | null;
  city: string | null;
  state: string | null;
}

export interface FaaStatus {
  state: "loading" | "ready" | "stale" | "error";
  updatedAt: number | null;
  aircraft: number;
  lastError: string | null;
}

export interface FaaProvider {
  lookup(hex: string): FaaRecord | null;
  merge(hex: string, rec: FaaRecord): void;
  status(): FaaStatus;
  init(): Promise<void>;
  stop(): void;
}

export const FRESHNESS_MS = 20 * 3600 * 1000;
const DEFAULT_ZIP_URL = "https://registry.faa.gov/database/ReleasableAircraft.zip";
const MASTER_NAME = "MASTER.txt";
const REF_NAME = "ACFTREF.txt";

/** RFC4180-lite: BOM, quoted fields, CRLF; every field is trimmed (FAA pads columns). */
export function parseCsv(text: string): string[][] {
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ",") {
      row.push(field.trim());
      field = "";
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      row.push(field.trim());
      field = "";
      if (row.length > 1 || row[0] !== "") rows.push(row);
      row = [];
    } else {
      field += ch;
    }
  }
  if (field !== "" || row.length > 0) {
    row.push(field.trim());
    if (row.length > 1 || row[0] !== "") rows.push(row);
  }
  return rows;
}

/** Fixed column layout of FAA MASTER.txt (1-based in FAA docs, 0-based here). */
const C_N = 0;
const C_MFR_MDL_CODE = 2;
const C_YEAR = 4;
const C_NAME = 6;
const C_CITY = 9;
const C_STATE = 10;
const C_MODES_HEX = 33;

export function buildIndex(masterText: string, refText: string): Map<string, FaaRecord> {
  const ref = new Map<string, { mfr: string; model: string }>();
  for (const r of parseCsv(refText).slice(1)) {
    if (r[0]) ref.set(r[0], { mfr: r[1] || "", model: r[2] || "" });
  }
  const idx = new Map<string, FaaRecord>();
  for (const r of parseCsv(masterText).slice(1)) {
    const hex = (r[C_MODES_HEX] ?? "").toUpperCase();
    const n = r[C_N] ?? "";
    if (!/^[0-9A-F]{6}$/.test(hex) || !n) continue;
    const codeInfo = ref.get(r[C_MFR_MDL_CODE] ?? "");
    const yearRaw = r[C_YEAR] ?? "";
    idx.set(hex.toLowerCase(), {
      nNumber: n,
      year: yearRaw && Number.isInteger(Number(yearRaw)) ? Number(yearRaw) : null,
      mfr: codeInfo?.mfr || null,
      model: codeInfo?.model || null,
      owner: r[C_NAME] || null,
      city: r[C_CITY] || null,
      state: r[C_STATE] || null,
    });
  }
  return idx;
}

export interface FaaLoaderOpts {
  dir: string;
  refreshMs: number;
  zipUrl?: string;
  fetchImpl?: typeof fetch;
  now?: () => number;
  log?: (msg: string) => void;
}

export class FaaLoader implements FaaProvider {
  private index = new Map<string, FaaRecord>();
  private state: "loading" | "ready" | "stale" | "error" = "loading";
  private updatedAt: number | null = null;
  private lastError: string | null = null;
  private timer: NodeJS.Timeout | null = null;
  private now: () => number;

  constructor(private opts: FaaLoaderOpts) {
    this.now = opts.now ?? Date.now;
  }

  status(): FaaStatus {
    return { state: this.state, updatedAt: this.updatedAt, aircraft: this.index.size, lastError: this.lastError };
  }

  lookup(hex: string): FaaRecord | null {
    return this.index.get(hex.toLowerCase()) ?? null;
  }

  merge(hex: string, rec: FaaRecord): void {
    this.index.set(hex.toLowerCase(), rec);
  }

  async init(): Promise<void> {
    await mkdir(this.opts.dir, { recursive: true });
    if (await this.diskFresh()) {
      try {
        await this.loadFromDisk();
        this.state = this.index.size ? "ready" : "error";
      } catch {
        this.state = "error";
      }
    } else {
      await this.refresh();
    }
    this.timer = setInterval(() => {
      this.refresh().catch((e) => this.opts.log?.(`faa: refresh failed: ${e instanceof Error ? e.message : String(e)}`));
    }, this.opts.refreshMs);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  private async diskFresh(): Promise<boolean> {
    for (const name of [MASTER_NAME, REF_NAME]) {
      const st = await stat(join(this.opts.dir, name)).catch(() => null);
      if (!st || this.now() - st.mtimeMs > FRESHNESS_MS) return false;
    }
    return true;
  }

  /** Loads + parses disk data. Does NOT set `state` — the caller decides
   *  ready (fresh) vs stale (fallback after a failed download). */
  private async loadFromDisk(): Promise<void> {
    const master = await readFile(join(this.opts.dir, MASTER_NAME), "utf8");
    const ref = await readFile(join(this.opts.dir, REF_NAME), "utf8");
    this.index = buildIndex(master, ref);
    this.updatedAt = this.now();
  }

  async refresh(): Promise<void> {
    let downloaded = false;
    try {
      await this.downloadAndExtract();
      downloaded = true;
    } catch (e) {
      this.lastError = e instanceof Error ? e.message : String(e);
    }
    try {
      await this.loadFromDisk();
    } catch {
      if (!this.lastError) this.lastError = "no disk data";
    }
    this.state = downloaded ? "ready" : this.index.size ? "stale" : "error";
  }

  private async downloadAndExtract(): Promise<void> {
    const fetchImpl = this.opts.fetchImpl ?? fetch;
    const res = await fetchImpl(this.opts.zipUrl ?? DEFAULT_ZIP_URL);
    if (!res.ok) throw new Error(`FAA download HTTP ${res.status}`);
    const buf = Buffer.from(await res.arrayBuffer());
    const zipPath = join(this.opts.dir, "ReleasableAircraft.zip");
    await writeFile(zipPath, buf);
    try {
      const entries = await this.extractEntries(zipPath, [MASTER_NAME, REF_NAME]);
      for (const name of [MASTER_NAME, REF_NAME]) {
        await writeFile(join(this.opts.dir, name), entries[name]);
      }
    } finally {
      await unlink(zipPath).catch(() => {});
    }
  }

  private extractEntries(zipPath: string, names: string[]): Promise<Record<string, Buffer>> {
    return new Promise((resolve, reject) => {
      yauzl.open(zipPath, { lazyEntries: true }, (err, zip) => {
        if (err || !zip) return reject(err ?? new Error("yauzl: open failed"));
        const out: Record<string, Buffer> = {};
        const wanted = new Set(names);
        zip.readEntry();
        zip.on("entry", (entry: yauzl.Entry) => {
          if (!wanted.has(entry.fileName)) {
            zip.readEntry();
            return;
          }
          const rs = zip.openReadStream(entry);
          const chunks: Buffer[] = [];
          rs.on("data", (c: Buffer) => chunks.push(c));
          rs.on("end", () => {
            out[entry.fileName] = Buffer.concat(chunks);
            zip.readEntry();
          });
          rs.on("error", reject);
        });
        zip.on("end", () => {
          if (names.every((n) => out[n])) resolve(out);
          else reject(new Error("yauzl: missing expected entry"));
        });
        zip.on("error", reject);
      });
    });
  }
}
```

State machine note: `state` is explicit, never derived — the constructor starts `loading`; the fresh-disk path in `init()` sets `ready`/`error`; `refresh()` sets `ready` only when the download succeeded, otherwise `stale` (disk fallback present) or `error` (none).

Run: `npx vitest run test/faa.test.ts` → PASS (all 7 tests).

- [ ] **Step C4: Export `N_NUMBER_RE` from `server/classify.ts`**

```ts
export const N_NUMBER_RE = /^N\d{1,5}[A-Z]{0,3}$/;
```

(no behavior change; `classifyAir` keeps using it).

- [ ] **Step C5: Extend `server/hub.ts` status with FAA**

```ts
import type { FaaStatus } from "./faa.js";

export interface StatusPayload {
  feeds: FeedStatus;
  history: HistoryRange;
  faa: FaaStatus;
}
```

In both `attach` and `tick`, include `faa: payload.faa` in the status frame JSON (both the frame and the change-detection string).

Update `test/hub.test.ts` `statusPayload` call sites: `() => ({ feeds, history: {...}, faa: { state: "ready", updatedAt: null, aircraft: 0, lastError: null } })` and add to the "status frames carry history bounds" test: `expect(st.faa.state).toBe("ready")`.

- [ ] **Step C6: Wire the loader in `server/index.ts`**

- Imports: `FaaLoader`, `type FaaProvider` from `./faa.js`; `join` from `node:path` (if not present).
- `ServerDeps`: add `faa?: FaaProvider | null`.
- In `buildApp`:

```ts
  const faaDir = resolve(process.cwd(), "data/faa");
  const faa: FaaProvider | null =
    deps.faa === undefined
      ? new FaaLoader({ dir: faaDir, refreshMs: config.FAA_REFRESH_MS, log })
      : deps.faa;
  if (faa) void faa.init();
```

(the `FaaLoader` downloads in the background; the server starts immediately and the panel shows "—" until `ready`.)

- Extend the hub `statusPayload` object with `faa: faa?.status() ?? { state: "loading", updatedAt: null, aircraft: 0, lastError: null }`.
- In the dispatch switch, add:

```ts
        case "aircraft.info": {
          const provider = faa;
          if (!provider) break;
          const rec = provider.lookup(msg.id);
          ws.send(
            JSON.stringify({
              type: "aircraft.info",
              id: msg.id,
              info: rec ? { ...rec, source: "db" as const } : null,
            }),
          );
          break;
        }
```

- `stop`: `faa?.stop();`
- `config.ts`: add `FAA_REFRESH_MS: int("FAA_REFRESH_MS", 86400000),`; `.env.example` append:

```
# FAA bulk registry refresh (ms). First run downloads a ~73 MB zip (~220 MB extracted) into data/faa/.
FAA_REFRESH_MS=86400000
```

- [ ] **Step C7: Client protocol in `src/data/ws.ts`**

```ts
export interface FaaStatus {
  state: "loading" | "ready" | "stale" | "error";
  updatedAt: number | null;
  aircraft: number;
  lastError: string | null;
}

export interface AircraftInfo {
  nNumber: string;
  year: number | null;
  mfr: string | null;
  model: string | null;
  owner: string | null;
  city: string | null;
  state: string | null;
  source: "db" | "live";
}
```

- `StatusMessage` gains `faa: FaaStatus`; `parseRadarMessage` status branch also requires `msg.faa != null`.
- `RadarMessage` gains `| { type: "aircraft.info"; id: string; info: AircraftInfo | null }`; parser branch:

```ts
    if (msg.type === "aircraft.info" && typeof msg.id === "string" && (msg.info === null || (msg.info && typeof msg.info.nNumber === "string"))) return msg;
```

- Handlers gain `onAircraftInfo?: (id: string, info: AircraftInfo | null) => void`; dispatch:

```ts
      else if (msg.type === "aircraft.info") this.handlers.onAircraftInfo?.(msg.id, msg.info);
```

- Send helper:

```ts
  sendAircraftInfo(id: string): void {
    this.send({ type: "aircraft.info", id });
  }
```

- `test/ws.test.ts`: add `faa: { state: "ready", updatedAt: null, aircraft: 0, lastError: null }` to status fixtures; add tests:

```ts
  it("accepts an aircraft.info frame with a record", () => {
    const info = { nNumber: "N100GX", year: 2007, mfr: "IAI", model: "G150", owner: "X LLC", city: "PARK CITY", state: "UT", source: "db" };
    const msg = parseRadarMessage(JSON.stringify({ type: "aircraft.info", id: "a00560", info }));
    expect(msg?.type).toBe("aircraft.info");
    if (msg?.type === "aircraft.info") expect(msg.info?.nNumber).toBe("N100GX");
  });

  it("accepts an aircraft.info frame with null info", () => {
    expect(parseRadarMessage(JSON.stringify({ type: "aircraft.info", id: "a00560", info: null })?.type)).toBe("aircraft.info");
  });

  it("rejects a status frame missing faa", () => {
    const raw = JSON.stringify({ type: "status", feeds, history: { from: null, to: null, snapshots: 0 }, serverTime: 2000 });
    expect(parseRadarMessage(raw)).toBeNull();
  });
```

- [ ] **Step C8: Panel info rows in `src/ui/panel.ts`**

- Import `type { AircraftInfo }` from `../data/ws.js`.
- Replace the `createPanel` signature and add hooks:

```ts
export interface PanelHooks {
  getInfo?: (id: string) => AircraftInfo | undefined;
  requestInfo?: (id: string) => void;
}

export function createPanel(root: HTMLElement, hooks: PanelHooks = {}): {
  show(craft: Craft): void;
  hide(): void;
  update(craft: Craft): void;
  selectedId(): string | null;
  setInfo(id: string, info: AircraftInfo | null): void;
} {
```

- Inside, add `const requestedInfo = new Set<string>();` and an info-row builder used in `renderBody` for the air branch (append after the `row("Origin", ...)` line, inside the same `body.append(...)` list — extract to keep it readable):

```ts
  function infoRows(craft: Craft): HTMLDivElement[] {
    const info = hooks.getInfo?.(craft.id);
    if (info === undefined) {
      if (!requestedInfo.has(craft.id)) {
        requestedInfo.add(craft.id);
        hooks.requestInfo?.(craft.id);
      }
      return [row("Type", "…"), row("N-number", "…"), row("Owner", "…")];
    }
    if (info === null) return [row("Type", null), row("N-number", null), row("Owner", null)];
    const typeText = [info.mfr, info.model].filter(Boolean).join(" ") + (info.year ? `, ${info.year}` : "");
    const where = [info.city, info.state].filter(Boolean).join(", ");
    const ownerText = info.owner ? (where ? `${info.owner} — ${where}` : info.owner) : null;
    return [row("Type", typeText || null), row("N-number", info.nNumber), row("Owner", ownerText)];
  }
```

  In `renderBody`, for the air branch, keep the existing `body.append(row(...), ...)` and afterwards call `body.append(...infoRows(craft));` before the Position row.
- Add:

```ts
  function setInfo(id: string, info: AircraftInfo | null): void {
    if (selected && selected.id === id) render(selected);
  }
```

  (The hooks cache is updated by the caller before invoking `setInfo`.) Return it from the factory.

- [ ] **Step C9: Wire in `src/main.ts`**

- `import type { AircraftInfo } from "./data/ws.js";`
- Before creating the panel:

```ts
const infoCache = new Map<string, AircraftInfo | null>();
```

- `const panel = createPanel(document.getElementById("app") as HTMLElement, { getInfo: (id) => infoCache.get(id), requestInfo: (id) => socket?.sendAircraftInfo(id) });`
- Socket handlers gain:

```ts
    onAircraftInfo: (id, info) => {
      infoCache.set(id, info);
      panel.setInfo(id, info);
    },
```

- [ ] **Step C10: Extend `test/integration.test.ts`**

Pass a fake provider in `buildApp` deps and exercise the frame end-to-end. Add near the existing socket test:

```ts
const fakeFaa = {
  lookup: (hex: string) =>
    hex === "ac4963"
      ? { nNumber: "N123A", year: 2001, mfr: "BOEING", model: "737-8DR", owner: "TEST LLC", city: "KANSAS CITY", state: "MO" }
      : null,
  merge: () => {},
  status: () => ({ state: "ready", updatedAt: null, aircraft: 1, lastError: null }),
  init: async () => {},
  stop: () => {},
};
```

Add `faa: fakeFaa` to the `buildApp` deps, and in the socket test (reuse its helper to send a frame — read the file first):

```ts
      wsSend(JSON.stringify({ type: "aircraft.info", id: "ac4963" }));
      await waitFor(() => frames.some((f) => f.type === "aircraft.info"));
      const infoMsg = frames.find((f) => f.type === "aircraft.info")!;
      expect(infoMsg.info.nNumber).toBe("N123A");
      expect(infoMsg.info.source).toBe("db");
```

- [ ] **Step C11: Run the full gate**

Run: `npm test && npm run typecheck && npm run build`
Expected: all pass.

- [ ] **Step C12: Commit**

```bash
git add package.json package-lock.json server/faa.ts server/config.ts server/hub.ts server/index.ts server/classify.ts src/data/ws.ts src/ui/panel.ts src/main.ts .env.example test/faa.test.ts test/hub.test.ts test/ws.test.ts test/integration.test.ts
git commit -m "feat: FAA bulk registry — type/year/owner for US-registered aircraft"
```

---

### Task D: FAA per-click N-number fallback + enrichment cache

**Files:**
- Create: `server/faa-lookup.ts`, `test/faa-lookup.test.ts`
- Modify: `server/index.ts`
- Uses: `test/fixtures/faa-inquiry.html`, `test/fixtures/faa-nresult.html`, `test/fixtures/faa-nresult-dereg.html` (already in the repo — read them, do not modify)

**Interfaces:**
- Consumes: `FaaProvider` (Task C), `N_NUMBER_RE` (Task C export).
- Produces: `parseNResult(html: string): FaaRecord | null`; `FaaLookup` with `constructor(provider: FaaProvider, opts: { cacheFile: string; fetchImpl?: typeof fetch; now?: () => number; log?: (m: string) => void; negativeTtlMs?: number; inquiryUrl?: string; resultUrl?: string })`, `init(): Promise<void>`, `stop(): void`, `lookup(craft: Craft): Promise<(FaaRecord & { source: "live" }) | null>`.

- [ ] **Step D1: Failing tests (`test/faa-lookup.test.ts`)**

```ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseNResult, FaaLookup } from "../server/faa-lookup.js";
import type { FaaRecord, FaaProvider } from "../server/faa.js";
import type { Craft } from "../../shared/craft.js";

const INQUIRY_HTML = readFileSync(new URL("./fixtures/faa-inquiry.html", import.meta.url), "utf8");
const POSITIVE_HTML = readFileSync(new URL("./fixtures/faa-nresult.html", import.meta.url), "utf8");
const DEREG_HTML = readFileSync(new URL("./fixtures/faa-nresult-dereg.html", import.meta.url), "utf8");

function craft(overrides: Partial<Craft> = {}): Craft {
  return { id: "a1b2c3", domain: "air", kind: "business", lat: 0, lon: 0, speed: null, heading: null, callsign: "N100GX", updatedAt: 0, stale: false, ...overrides };
}

function fakeProvider(): FaaProvider & { merged: Array<[string, FaaRecord]> } {
  const merged: Array<[string, FaaRecord]> = [];
  return {
    merged,
    lookup: () => null,
    merge: (hex: string, rec: FaaRecord) => {
      merged.push([hex, rec]);
    },
    status: () => ({ state: "ready", updatedAt: null, aircraft: 0, lastError: null }),
    init: async () => {},
    stop: () => {},
  };
}

function seqFetchImpl(responses: Array<() => Response>): { fetchImpl: typeof fetch; calls: { current: number } } {
  const calls = { current: 0 };
  const fetchImpl = (async () => {
    const fn = responses[calls.current];
    calls.current++;
    return fn();
  }) as typeof fetch;
  return { fetchImpl, calls };
}

const inquiryResponse = () =>
  new Response(INQUIRY_HTML, { status: 200, headers: { "set-cookie": "ASP.NET_SessionId=abc123" } });

describe("parseNResult", () => {
  it("parses a positive N-number result page", () => {
    expect(parseNResult(POSITIVE_HTML)).toEqual({
      nNumber: "N100GX",
      year: 2007,
      mfr: "ISRAEL AIRCRAFT INDUSTRIES",
      model: "GULFSTREAM G150",
      owner: "BRULECREEK AVIATION LLC",
      city: "PARK CITY",
      state: "UTAH",
    });
  });

  it("returns null for a deregistered result", () => {
    expect(parseNResult(DEREG_HTML)).toBeNull();
  });

  it("returns null for a validation-error page (no results section)", () => {
    expect(parseNResult("<html><body><form>N-Number:</form></body></html>")).toBeNull();
  });
});

describe("FaaLookup", () => {
  let dir: string;
  let t: number;

  beforeEach(async () => {
    t = 1_000_000_000;
    dir = await mkdtemp(join(tmpdir(), "radar-faalk-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const cacheFile = () => join(dir, "enrichment.json");

  it("resolves a DB-miss aircraft via live lookup, merges and caches it", async () => {
    const provider = fakeProvider();
    const { fetchImpl, calls } = seqFetchImpl([inquiryResponse, () => new Response(POSITIVE_HTML, { status: 200 })]);
    const lookup = new FaaLookup(provider, { cacheFile: cacheFile(), fetchImpl, now: () => t });
    await lookup.init();
    const rec = await lookup.lookup(craft());
    expect(rec?.source).toBe("live");
    expect(rec?.nNumber).toBe("N100GX");
    expect(provider.merged).toHaveLength(1);
    expect(provider.merged[0][0]).toBe("a1b2c3");
    expect(calls.current).toBe(2);
    const cached = JSON.parse(await readFile(cacheFile(), "utf8")) as Record<string, unknown>;
    expect(cached["a1b2c3"]).toBeDefined();
  });

  it("serves repeat lookups from the positive cache without fetching", async () => {
    const provider = fakeProvider();
    const { fetchImpl, calls } = seqFetchImpl([inquiryResponse, () => new Response(POSITIVE_HTML, { status: 200 })]);
    const lookup = new FaaLookup(provider, { cacheFile: cacheFile(), fetchImpl, now: () => t });
    await lookup.init();
    await lookup.lookup(craft());
    t += 60_000;
    const again = await lookup.lookup(craft());
    expect(again?.nNumber).toBe("N100GX");
    expect(calls.current).toBe(2); // no extra fetches
  });

  it("negative-caches deregistered results: no re-fetch within TTL, re-fetch after", async () => {
    const provider = fakeProvider();
    const { fetchImpl, calls } = seqFetchImpl([
      inquiryResponse,
      () => new Response(DEREG_HTML, { status: 200 }), // 1st attempt → negative
      inquiryResponse,
      () => new Response(POSITIVE_HTML, { status: 200 }), // 2nd attempt (past TTL) → positive
    ]);
    const lookup = new FaaLookup(provider, { cacheFile: cacheFile(), fetchImpl, now: () => t, negativeTtlMs: 3_600_000 });
    await lookup.init();
    expect(await lookup.lookup(craft())).toBeNull();
    expect(calls.current).toBe(2);
    await lookup.lookup(craft());
    expect(calls.current).toBe(2); // negative cache hit, no fetch
    t += 3_700_000; // past TTL → re-fetch allowed
    expect((await lookup.lookup(craft()))?.nNumber).toBe("N100GX");
    expect(calls.current).toBe(4);
  });

  it("returns null immediately when no N-number is derivable", async () => {
    const provider = fakeProvider();
    const { fetchImpl, calls } = seqFetchImpl([inquiryResponse]);
    const lookup = new FaaLookup(provider, { cacheFile: cacheFile(), fetchImpl, now: () => t });
    await lookup.init();
    expect(await lookup.lookup(craft({ callsign: "UAL123" }))).toBeNull();
    expect(calls.current).toBe(0);
  });

  it("deduplicates concurrent lookups for the same N-number", async () => {
    const provider = fakeProvider();
    const { fetchImpl, calls } = seqFetchImpl([inquiryResponse, () => new Response(POSITIVE_HTML, { status: 200 })]);
    const lookup = new FaaLookup(provider, { cacheFile: cacheFile(), fetchImpl, now: () => t });
    await lookup.init();
    const [a, b] = await Promise.all([lookup.lookup(craft()), lookup.lookup(craft())]);
    expect(a?.nNumber).toBe("N100GX");
    expect(b?.nNumber).toBe("N100GX");
    expect(calls.current).toBe(2);
  });
});
```

- [ ] **Step D2: Run to verify failure, then implement `server/faa-lookup.ts`**

Run: `npx vitest run test/faa-lookup.test.ts` → FAIL (module missing).

```ts
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { Craft } from "../shared/craft.js";
import { N_NUMBER_RE } from "./classify.js";
import type { FaaProvider, FaaRecord } from "./faa.js";

const DEFAULT_INQUIRY_URL = "https://registry.faa.gov/aircraftinquiry/Search/NNumberInquiry";
const DEFAULT_RESULT_URL = "https://registry.faa.gov/aircraftinquiry/Search/NNumberResult";
// Browser-like UA: the registry validates plain clients aggressively.
const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36";
const DEFAULT_NEGATIVE_TTL_MS = 3_600_000;

function stripTags(html: string): string {
  return html
    .replace(/<[^>]+>/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}

/** Parse an FAA N-Number Inquiry Results page. Null when no usable record. */
export function parseNResult(html: string): FaaRecord | null {
  if (!html.includes("Inquiry Results")) return null;
  if (/\bis Deregistered\b/i.test(html)) return null;
  if (!/\bis Assigned\b|\bhas Assigned\/Multiple Records\b/i.test(html)) return null;
  const pair = (label: string): string | null => {
    const re = new RegExp(`<td[^>]*>\\s*${label}\\s*</td>\\s*<td[^>]*>(.*?)</td>`, "is");
    const m = re.exec(html);
    if (!m) return null;
    const v = stripTags(m[1]);
    return v === "" || /^none$/i.test(v) ? null : v;
  };
  const entered = html.match(/N-Number Entered:\s*([A-Za-z0-9]+)/i);
  if (!entered) return null;
  const yearRaw = pair("MFR Year");
  return {
    nNumber: "N" + entered[1].toUpperCase(),
    year: yearRaw && Number.isInteger(Number(yearRaw)) ? Number(yearRaw) : null,
    mfr: pair("Manufacturer Name"),
    model: pair("Model"),
    owner: pair("Name"),
    city: pair("City"),
    state: pair("State"),
  };
}

interface CacheEntry {
  foundAt: number;
  negative?: boolean;
  record?: FaaRecord;
}

export interface FaaLookupOpts {
  cacheFile: string;
  fetchImpl?: typeof fetch;
  now?: () => number;
  log?: (msg: string) => void;
  negativeTtlMs?: number;
  inquiryUrl?: string;
  resultUrl?: string;
}

export class FaaLookup {
  private cache = new Map<string, CacheEntry>();
  private inflight = new Map<string, Promise<(FaaRecord & { source: "live" }) | null>>();
  private now: () => number;

  constructor(private provider: FaaProvider, private opts: FaaLookupOpts) {
    this.now = opts.now ?? Date.now;
  }

  async init(): Promise<void> {
    try {
      const raw = await readFile(this.opts.cacheFile, "utf8");
      for (const [hex, entry] of Object.entries(JSON.parse(raw) as Record<string, CacheEntry>)) {
        this.cache.set(hex.toLowerCase(), entry);
      }
    } catch {
      /* first run */
    }
  }

  stop(): void {
    /* nothing to clean up */
  }

  async lookup(craft: Craft): Promise<(FaaRecord & { source: "live" }) | null> {
    const hex = craft.id.toLowerCase();
    const t = this.now();
    const entry = this.cache.get(hex);
    if (entry?.record) return { ...entry.record, source: "live" };
    if (entry?.negative && t - entry.foundAt < (this.opts.negativeTtlMs ?? DEFAULT_NEGATIVE_TTL_MS)) return null;
    const n = this.nNumberFor(craft);
    if (!n) return null;
    const key = n.toUpperCase();
    const existing = this.inflight.get(key);
    if (existing) return existing;
    const p = this.fetchRecord(n)
      .then((rec) => {
        this.inflight.delete(key);
        if (rec) {
          this.provider.merge(hex, rec);
          this.setCache(hex, { foundAt: t, record: rec });
        } else {
          this.setCache(hex, { foundAt: t, negative: true });
        }
        return rec;
      })
      .catch((e) => {
        this.inflight.delete(key);
        this.opts.log?.(`faa-lookup: ${e instanceof Error ? e.message : String(e)}`);
        this.setCache(hex, { foundAt: t, negative: true });
        return null;
      });
    this.inflight.set(key, p);
    return p;
  }

  private nNumberFor(craft: Craft): string | null {
    const cs = (craft.callsign ?? "").trim().toUpperCase();
    return N_NUMBER_RE.test(cs) ? cs : null;
  }

  private async fetchRecord(n: string): Promise<FaaRecord | null> {
    const fetchImpl = this.opts.fetchImpl ?? fetch;
    const page = await fetchImpl(this.opts.inquiryUrl ?? DEFAULT_INQUIRY_URL, { headers: { "user-agent": UA } });
    if (!page.ok) throw new Error(`FAA inquiry page HTTP ${page.status}`);
    const pageHtml = await page.text();
    const token = pageHtml.match(/name="__RequestVerificationToken"[^>]*value="([^"]+)"/)?.[1];
    if (!token) throw new Error("FAA inquiry page: CSRF token not found");
    const cookie = (page.headers.get("set-cookie") ?? "").split(";")[0];
    const body = new URLSearchParams({ NNumbertxt: n, __RequestVerificationToken: token });
    const res = await fetchImpl(this.opts.resultUrl ?? DEFAULT_RESULT_URL, {
      method: "POST",
      headers: {
        "user-agent": UA,
        "content-type": "application/x-www-form-urlencoded",
        ...(cookie ? { cookie } : {}),
      },
      body: body.toString(),
    });
    if (!res.ok) throw new Error(`FAA result HTTP ${res.status}`);
    const rec = parseNResult(await res.text());
    if (!rec) return null;
    rec.nNumber = n.toUpperCase();
    return rec;
  }

  private setCache(hex: string, entry: CacheEntry): void {
    this.cache.set(hex.toLowerCase(), entry);
    void this.persist();
  }

  private async persist(): Promise<void> {
    try {
      await mkdir(dirname(this.opts.cacheFile), { recursive: true });
      await writeFile(this.opts.cacheFile, JSON.stringify(Object.fromEntries(this.cache), null, 1));
    } catch (e) {
      this.opts.log?.(`faa-lookup: cache persist failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
}
```

Run: `npx vitest run test/faa-lookup.test.ts` → PASS. If the fixture-based positive test fails on a field (e.g. label casing), inspect `test/fixtures/faa-nresult.html` and correct the parser — the fixture is the source of truth, do not edit it.

- [ ] **Step D3: Wire the fallback in `server/index.ts`**

- Imports: `FaaLookup` from `./faa-lookup.js`.
- After the `faa` provider is created:

```ts
  const faaLookup = faa
    ? new FaaLookup(faa, { cacheFile: join(faaDir, "enrichment.json"), log })
    : null;
  if (faaLookup) await faaLookup.init();
```

- Replace the Task C `aircraft.info` branch with:

```ts
        case "aircraft.info": {
          const provider = faa;
          if (!provider) break;
          const craft = store.get(msg.id);
          void (async () => {
            let info: (FaaRecord & { source: "db" | "live" }) | null = null;
            const db = provider.lookup(msg.id);
            if (db) info = { ...db, source: "db" };
            else if (craft && faaLookup) info = await faaLookup.lookup(craft);
            ws.send(JSON.stringify({ type: "aircraft.info", id: msg.id, info }));
          })();
          break;
        }
```

  (import `type FaaRecord` from `./faa.js`).
- `stop`: `faaLookup?.stop();`

- [ ] **Step D4: Run the full gate**

Run: `npm test && npm run typecheck && npm run build`
Expected: all pass.

- [ ] **Step D5: Commit**

```bash
git add server/faa-lookup.ts server/index.ts test/faa-lookup.test.ts
git commit -m "feat: FAA per-click N-number fallback with persistent enrichment cache"
```

---

### Task E: Docs (README + AGENTS.md)

**Files:**
- Modify: `README.md`, `AGENTS.md`

**Interfaces:**
- Consumes: everything from Tasks A–D. No code changes.

- [ ] **Step E1: README fixes + new sections**

- "How it works" bullet for aircraft — replace the stale 36 s anonymous claim with:

  ```md
  - **Aircraft** = ADS-B (OpenSky `states/all`, OAuth2 client-credentials;
    polled every `OPENSKY_POLL_MS` — default 120 s to stay inside the
    4,000-credit/day budget; the HUD slider changes it live).
  ```

- Add after "How it works":

  ```md
  ## Timeline rewind

  Every state the server holds is snapshot to `data/history/` as a gzipped
  JSON file every `HISTORY_SNAPSHOT_MS` (default 60 s). The bottom timeline
  bar scrubs the map back in time (aircraft **and** vessels); the LIVE button
  returns to now. History is evicted oldest-first beyond
  `HISTORY_MAX_BYTES` (default 10 GB) and survives restarts.

  ## Aircraft type & owner (FAA)

  Clicking a US-registered aircraft shows its make/model (to subvariant),
  year, and registered owner. Source: the FAA's daily bulk "Releasable
  Aircraft Database" (downloaded once, ~73 MB zip → ~220 MB cache in
  `data/faa/`, refreshed every `FAA_REFRESH_MS`). Aircraft missing from the
  bulk DB (e.g. registered after today's refresh) are resolved on click via
  the FAA N-number lookup, cached in `data/faa/enrichment.json`. Non-US
  aircraft show "—".

  ## Data directory

  `data/` (gitignored) holds `faa/` (registry cache), `history/` (timeline
  snapshots), and `faa/enrichment.json`. Delete it to reset all cached data.
  ```

- "Setup" step 5 note: after first `npm run dev`, the FAA download happens in the background (one-time, ~73 MB).
- "Layout": add `server/history.ts`, `server/faa.ts`, `server/faa-lookup.ts`, `src/ui/timeline.ts`, `src/ui/pollrate.ts`, `src/data/replay.ts` lines.
- Env table (if present) / Setup: mention `HISTORY_SNAPSHOT_MS`, `HISTORY_MAX_BYTES`, `FAA_REFRESH_MS`.

- [ ] **Step E2: AGENTS.md updates**

- "External APIs — verified findings": add a section:

  ```md
  ### FAA registry (`server/faa.ts`, `server/faa-lookup.ts`)

  - Bulk: `https://registry.faa.gov/database/ReleasableAircraft.zip` (~73 MB,
    refreshed daily 11:30 pm CT). `MASTER.txt` (~317k rows): col 1 N-NUMBER,
    col 3 MFR MDL CODE, col 5 YEAR MFR (~78%), col 7 NAME (registrant; blank
    when redacted per 49 U.S.C. §44114(b)), col 10 CITY, col 11 STATE, col 34
    MODE S CODE HEX (= icao24, 100% populated). `ACFTREF.txt` (~94k):
    CODE → MFR + MODEL at subvariant quality (`737-8DR`, `A320-214`). Files
    are comma-delimited, space-padded, BOM-prefixed, a few quoted fields.
  - Per-click fallback: GET `.../aircraftinquiry/Search/NNumberInquiry`
    (cookie + `__RequestVerificationToken`) then POST
    `.../Search/NNumberResult` with `NNumbertxt` + token; result page status
    line is `<N> is Assigned` / `has Assigned/Multiple Records` /
    `is Deregistered`; invalid formats return the form page (no
    "Inquiry Results"). Needs a browser-like UA. Fixtures in
    `test/fixtures/` (recorded 2026-10-03).
  - Coverage: US-registered aircraft only (v1 ruling).
  ```

- "Architecture at a glance": add `history.ts` (gzipped snapshot log + seek), `faa.ts` (bulk loader + index), `faa-lookup.ts` (per-click fallback + enrichment cache) to the `server/` bullet; add `ui/timeline.ts`, `ui/pollrate.ts`, `data/replay.ts` to the `src/` bullet.
- WS protocol bullet: extend with client→server frames:
  `{type:"poll.rate",ms}`, `{type:"timeline.seek",time}`, `{type:"timeline.live"}`, `{type:"aircraft.info",id}` and server→client `{type:"timeline.state",time,craft}`, `{type:"aircraft.info",id,info}`; status now carries `feeds.opensky.pollMs`, `history:{from,to,snapshots}`, `faa:{state,updatedAt,aircraft,lastError}`.
- Commands/gate unchanged. Update the `test/` bullet's file/test counts to the actual post-Task-D numbers (run `npm test` and copy the real totals).
- Add to Secrets or a new line: `data/` is gitignored local cache — never commit.

- [ ] **Step E3: Verify docs match reality**

Run: `npm test` (capture the real "Test Files / Tests" totals for the AGENTS.md line). Skim both files for stale claims (e.g. "16 files, 80 tests").

- [ ] **Step E4: Commit**

```bash
git add README.md AGENTS.md
git commit -m "docs: README + AGENTS.md — timeline, poll rate, FAA enrichment"
```

---

## Self-Review (run by the plan author)

- **Spec coverage:** A → spec §2 (slider, frames, clamp, credits, session-only). B → spec §3 (recorder, retention, seek semantics incl. empty-history null, status history, client suppression, UI). C → spec §4 (source facts, loader, parse, index, FaaRecord, status.faa, info frame, panel rows, US-only). D → spec §4 per-click (N derivation, live lookup, negative cache 1 h, dedup, merge + persist). E → spec §5/§6 (env, docs, README stale-claim fix). All spec non-goals respected (no map-layer changes, no Craft model change, no raw dumps, no playback animation).
- **Placeholder scan:** every code step carries full code; test steps carry full test code; no "TBD"/"similar to Task N".
- **Type consistency:** `FaaRecord`/`FaaStatus`/`FaaProvider` defined once (faa.ts) and mirrored client-side as `AircraftInfo`/`FaaStatus` in ws.ts per the no-shared-file convention; `HistoryRange` mirrored likewise; `StatusPayload` fields (feeds/history/faa) added incrementally B→C with hub test fixtures updated in the same step; `onFeeds`→`onStatus` and connection-`onStatus`→`onConnection` rename done in one step (B8) with main.ts rewritten to the full handler object in B11; `feedStatus`→`statusPayload` rename done in B6 with the index.ts call site updated in B7.
- **Known integration risk (noted in tasks):** `buildApp` defaults must stay test-safe — Tasks B/C add `recorder`/`faa` DI with `null` support and the integration test passes stubs; a real `FaaLoader` must never be constructed in tests (it would download 73 MB).
- **Gate:** every task ends with the full gate (test → typecheck → build) and a commit.
