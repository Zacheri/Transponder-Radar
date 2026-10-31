import { describe, it, expect } from "vitest";
import type { Craft } from "../shared/craft.js";
import { SPEED_MAX } from "../shared/limits.js";
import {
  createPlaybackEngine,
  lerpCrafts,
  type PlaybackApi,
  type PlaybackOpts,
  type PlaybackWindowReq,
} from "../src/data/playback.js";

const T0 = 1_000_000;

function craft(id: string, over: Partial<Craft> = {}): Craft {
  return {
    id,
    domain: "air",
    kind: "commercial",
    lat: 0,
    lon: 0,
    speed: 10,
    heading: 90,
    updatedAt: 0,
    stale: false,
    ...over,
  };
}

interface Snap {
  ts: number;
  crafts: Craft[];
}

interface Harness {
  engine: PlaybackApi;
  requests: PlaybackWindowReq[];
  frames: { crafts: Craft[]; t: number }[];
  logs: string[];
  decodes: Map<number, number>;
  advanceNow: (ms: number) => number;
  flush: () => Promise<void>;
  decodeFailNext: boolean;
}

const tsB64 = (ts: number) => Buffer.from(String(ts)).toString("base64");

// Manual-clock harness. requestWindow records the req and auto-answers
// synchronously with the first snapshot ts >= req.from (or an empty done
// chunk when none exists); decode maps the ts-encoded payload back to the
// real crafts and counts calls per ts.
function makeEngine(snapshots: Snap[], overrides: Partial<PlaybackOpts> = {}): Harness {
  const tsList = snapshots.map((s) => s.ts).sort((a, b) => a - b);
  const byTs = new Map(snapshots.map((s) => [s.ts, s.crafts]));
  const requests: PlaybackWindowReq[] = [];
  const frames: { crafts: Craft[]; t: number }[] = [];
  const logs: string[] = [];
  const decodes = new Map<number, number>();
  const fail = { on: false };
  let nowMs = T0;

  const base: PlaybackOpts = {
    snapshotMs: () => 60_000,
    staleMs: () => 120_000,
    historyFrom: () => (tsList.length ? tsList[0] : null),
    historyTo: () => (tsList.length ? tsList[tsList.length - 1] : null),
    requestWindow: (req) => {
      requests.push(req);
      const ts = tsList.find((t) => t >= req.from);
      h.engine.feed(
        ts === undefined
          ? { seq: req.seq, items: [], done: true, reachedTo: null }
          : { seq: req.seq, items: [{ ts, b64: tsB64(ts) }], done: true, reachedTo: ts }
      );
    },
    decode: async (gz) => {
      const ts = parseInt(Buffer.from(gz).toString("utf8"), 10);
      decodes.set(ts, (decodes.get(ts) ?? 0) + 1);
      if (fail.on) {
        fail.on = false;
        throw new Error("simulated decode failure");
      }
      return byTs.get(ts) ?? [];
    },
    onFrame: (crafts, t) => {
      frames.push({ crafts, t });
    },
    onState: () => {},
    now: () => nowMs,
    log: (msg) => logs.push(msg),
  };

  const h: Harness = {
    engine: createPlaybackEngine({ ...base, ...overrides }),
    requests,
    frames,
    logs,
    decodes,
    advanceNow: (ms) => (nowMs += ms),
    flush: () => new Promise((r) => setTimeout(r, 0)),
    get decodeFailNext() {
      return fail.on;
    },
    set decodeFailNext(v: boolean) {
      fail.on = v;
    },
  };
  return h;
}

describe("createPlaybackEngine", () => {
  it("start with empty history is a no-op", () => {
    const h = makeEngine([]);
    h.engine.start(T0);
    expect(h.engine.state).toBe("idle");
    expect(h.requests).toHaveLength(0);
    expect(h.frames).toHaveLength(0);
    h.engine.tick(T0 + 1000);
    expect(h.engine.state).toBe("idle");
    expect(h.frames).toHaveLength(0);
  });

  it("first tick after start measures full elapsed dt: 30x, +1000ms -> +30_000", async () => {
    const A = 10_000_000;
    const h = makeEngine([
      { ts: A, crafts: [craft("a", { updatedAt: A })] },
      { ts: A + 60_000, crafts: [craft("b", { updatedAt: A + 60_000 })] },
    ]);
    h.engine.start(A);
    h.engine.setSpeed(30);
    await h.flush();
    h.engine.tick(h.advanceNow(1000));
    expect(h.engine.cursor).toBe(A + 30_000);
  });

  it("clamps at historyTo and pauses after the final frame; further ticks are no-ops", async () => {
    const A = 10_000_000;
    const B = A + 60_000;
    const h = makeEngine([
      { ts: A, crafts: [craft("a", { updatedAt: A })] },
      { ts: B, crafts: [craft("b", { updatedAt: B })] },
    ]);
    h.engine.start(A);
    h.engine.setSpeed(SPEED_MAX);
    await h.flush();
    h.engine.tick(h.advanceNow(1000 / 60));
    expect(h.engine.cursor).toBe(B);
    expect(h.engine.state).toBe("paused");
    const n = h.frames.length;
    h.engine.tick(h.advanceNow(1000 / 60));
    expect(h.engine.cursor).toBe(B);
    expect(h.frames.length).toBe(n);
    expect(h.engine.state).toBe("paused");
  });

  it("lerps between bracketing snapshots at 30x: mid-gap cursor -> lat 1, lon 1", async () => {
    const A = 10_000_000;
    const B = A + 60_000;
    const h = makeEngine([
      { ts: A, crafts: [craft("a", { lat: 0, lon: 0, updatedAt: A })] },
      { ts: B, crafts: [craft("a", { lat: 2, lon: 2, updatedAt: B })] },
    ]);
    h.engine.start(A);
    await h.flush();
    h.engine.setSpeed(30);
    h.engine.tick(h.advanceNow(0)); // issues the prefetch for B
    await h.flush();
    h.engine.tick(h.advanceNow(1000)); // cursor -> A + 30_000
    const last = h.frames.at(-1)!;
    expect(last.crafts[0].lat).toBe(1);
    expect(last.crafts[0].lon).toBe(1);
  });

  it("lerpCrafts heading: shortest arc (90->120: 105, 350->10: 0), null -> a.heading", () => {
    const t = 1_000_000;
    const mk = (heading: number | null) => [craft("x", { heading, updatedAt: t })];
    expect(lerpCrafts(mk(90), mk(120), 0.5, t, 120_000)[0].heading).toBe(105);
    expect(lerpCrafts(mk(350), mk(10), 0.5, t, 120_000)[0].heading).toBe(0);
    expect(lerpCrafts(mk(90), mk(null), 0.5, t, 120_000)[0].heading).toBe(90);
    expect(lerpCrafts(mk(null), mk(120), 0.5, t, 120_000)[0].heading).toBeNull();
  });

  it("lerpCrafts: craft only in b appears, craft only in a disappears", () => {
    const t = 1_000_000;
    const out = lerpCrafts([craft("x", { updatedAt: t })], [craft("y", { updatedAt: t })], 0.5, t, 120_000);
    expect(out).toHaveLength(1);
    expect(out[0].id).toBe("y");
    expect(out[0].stale).toBe(false);
  });

  it("lerp gap guard: 120s gap at 30x -> skip, frame equals shallow copy of the lower snapshot", async () => {
    const A = 10_000_000;
    const B = A + 120_000;
    const h = makeEngine([
      { ts: A, crafts: [craft("a", { lat: 0, lon: 0, updatedAt: A })] },
      { ts: B, crafts: [craft("a", { lat: 2, lon: 2, updatedAt: B })] },
    ]);
    h.engine.start(A);
    await h.flush();
    h.engine.setSpeed(30);
    h.engine.tick(h.advanceNow(0));
    await h.flush();
    h.engine.tick(h.advanceNow(1000));
    const last = h.frames.at(-1)!;
    expect(last.crafts[0].lat).toBe(0); // lerped it would be 1
    expect(last.crafts[0].lon).toBe(0);
  });

  it("stale is strict >: t - updatedAt === staleMs -> false, one more ms -> true", () => {
    const t = 1_000_000;
    const mk = (updatedAt: number) => [craft("x", { updatedAt })];
    expect(lerpCrafts(mk(t - 120_000), mk(t - 120_000), 0.5, t, 120_000)[0].stale).toBe(false);
    expect(lerpCrafts(mk(t - 120_001), mk(t - 120_001), 0.5, t, 120_000)[0].stale).toBe(true);
  });

  it("skip mode at 86_400x: request stride 24, frame objects are fresh copies (buffer unmutated)", async () => {
    const A = 10_000_000;
    const B = A + 60_000;
    const a0 = craft("a", { lat: 0, lon: 0, updatedAt: A });
    const h = makeEngine([
      { ts: A, crafts: [a0] },
      { ts: B, crafts: [craft("b", { updatedAt: B })] },
    ]);
    h.engine.start(A);
    h.engine.setSpeed(86_400);
    await h.flush();
    h.engine.tick(h.advanceNow(1000 / 60));
    expect(h.requests.at(-1)!.stride).toBe(24);
    expect(h.frames).toHaveLength(1);
    const f = h.frames[0].crafts[0];
    expect(f).not.toBe(a0);
    f.lat = 999; // mutating the frame must not touch the buffered copy
    expect(a0.lat).toBe(0);
  });

  it("feed: chunk with a stale seq is ignored — no insert, request chain intact", async () => {
    const A = 10_000_000;
    const B = A + 60_000;
    const h = makeEngine([
      { ts: A, crafts: [craft("a", { updatedAt: A })] },
      { ts: B, crafts: [craft("b", { updatedAt: B })] },
    ]);
    h.engine.start(A);
    h.engine.setSpeed(60); // supersedes the seq-2 request
    await h.flush();
    h.engine.feed({ seq: 2, items: [{ ts: B, b64: tsB64(B) }], done: true, reachedTo: B });
    h.engine.tick(h.advanceNow(1000 / 60));
    expect(h.requests).toHaveLength(2);
    expect(h.requests[1].seq).toBe(4);
    expect(h.requests[1].from).toBe(A + 1); // old chunk's reachedTo (B) not adopted
    await h.flush();
    expect(h.frames.every((fr) => fr.crafts.every((c) => c.id !== "b"))).toBe(true);
  });

  it("done chunk: next request from === reachedTo + 1; empty done chunk: no further request", async () => {
    const A = 10_000_000;
    const B = A + 60_000;
    const snaps: Snap[] = [
      { ts: A, crafts: [craft("a", { updatedAt: A })] },
      { ts: B, crafts: [craft("b", { updatedAt: B })] },
    ];

    // first half: normal auto-answer chain
    const h1 = makeEngine(snaps);
    h1.engine.start(A);
    await h1.flush();
    h1.engine.tick(h1.advanceNow(1000 / 60));
    expect(h1.requests[1].from).toBe(A + 1);

    // second half: empty done chunk -> nextFrom = reqTo + 1 > historyTo -> no request
    const rec: PlaybackWindowReq[] = [];
    const h2 = makeEngine(snaps, { requestWindow: (req) => rec.push(req) });
    h2.engine.start(A);
    h2.engine.feed({ seq: 2, items: [], done: true, reachedTo: null });
    h2.engine.tick(h2.advanceNow(1000 / 60));
    expect(rec).toHaveLength(1);
    expect(h2.frames).toHaveLength(0);
    expect(h2.engine.state).toBe("buffering");
  });

  it("governor: 40ms frame cost drops fps 60 -> 30 (10ms tick: no frame; 50ms: frame)", async () => {
    const A = 10_000_000;
    const B = A + 60_000;
    const h = makeEngine(
      [
        { ts: A, crafts: [craft("a", { updatedAt: A })] },
        { ts: B, crafts: [craft("b", { updatedAt: B })] },
      ],
      {
        onFrame: (crafts, t) => {
          h.advanceNow(40); // cost 40
          h.frames.push({ crafts, t });
        },
      }
    );
    h.engine.start(A);
    await h.flush();
    h.engine.setSpeed(30);
    const t1 = h.advanceNow(1000 / 60);
    h.engine.tick(t1);
    expect(h.frames).toHaveLength(1);
    await h.flush();
    h.engine.tick(t1 + 10);
    expect(h.frames).toHaveLength(1); // 10ms < 1000/30
    h.engine.tick(t1 + 50);
    expect(h.frames).toHaveLength(2); // 50ms >= 1000/30
  });

  it("stall: unanswered window keeps buffering with no frames; answering lets the next tick render", async () => {
    const A = 10_000_000;
    const B = A + 60_000;
    const rec: PlaybackWindowReq[] = [];
    const h = makeEngine(
      [
        { ts: A, crafts: [craft("a", { updatedAt: A })] },
        { ts: B, crafts: [craft("b", { updatedAt: B })] },
      ],
      { requestWindow: (req) => rec.push(req) }
    );
    h.engine.start(A);
    await h.flush();
    h.engine.tick(h.advanceNow(1000 / 60));
    expect(h.engine.state).toBe("buffering");
    expect(h.frames).toHaveLength(0);
    expect(rec).toHaveLength(1);
    h.engine.feed({ seq: 2, items: [{ ts: A, b64: tsB64(A) }], done: true, reachedTo: A });
    await h.flush();
    h.engine.setSpeed(30);
    h.engine.tick(h.advanceNow(1000 / 60));
    expect(h.frames).toHaveLength(1);
    expect(h.engine.state).toBe("playing");
  });

  it("corrupt item: decode reject logs, no frame from it, no throw; later chunks still render", async () => {
    const A = 10_000_000;
    const B = A + 60_000;
    const h = makeEngine([
      { ts: A, crafts: [craft("a", { updatedAt: A })] },
      { ts: B, crafts: [craft("b", { updatedAt: B })] },
    ]);
    h.decodeFailNext = true;
    h.engine.start(A); // first item's decode rejects
    await h.flush();
    expect(h.logs.length).toBeGreaterThanOrEqual(1);
    expect(h.engine.state).toBe("buffering");
    expect(h.frames).toHaveLength(0);
    h.engine.tick(h.advanceNow(1000 / 60)); // prefetches B (good decode)
    await h.flush();
    expect(h.frames).toHaveLength(0); // A missing: no lo <= cursor yet
    h.engine.feed({ seq: 3, items: [{ ts: A, b64: tsB64(A) }], done: true, reachedTo: A });
    await h.flush();
    h.engine.tick(h.advanceNow(1000 / 60));
    expect(h.frames).toHaveLength(1);
    expect(h.frames[0].crafts[0].id).toBe("a");
  });

  it("trim: 20min-ahead snapshot dropped (lookAhead floor 600_000), 1min-behind and 5min-ahead kept", async () => {
    const A = 10_060_000;
    const P = A - 60_000; // 1 min behind the cursor
    const M = A + 300_000; // 5 min ahead: within floored lookAhead, beyond advancePerFrame*8
    const F = A + 1_200_000; // 20 min ahead: beyond floored lookAhead
    const rec: PlaybackWindowReq[] = [];
    const h = makeEngine(
      [
        { ts: P, crafts: [craft("p", { updatedAt: P })] },
        { ts: A, crafts: [craft("a", { updatedAt: A })] },
        { ts: M, crafts: [craft("m", { updatedAt: M })] },
        { ts: F, crafts: [craft("f", { updatedAt: F })] },
      ],
      { requestWindow: (req) => rec.push(req) }
    );
    h.engine.start(A);
    h.engine.setSpeed(30);
    h.engine.feed({
      seq: 3,
      items: [
        { ts: P, b64: tsB64(P) },
        { ts: A, b64: tsB64(A) },
        { ts: M, b64: tsB64(M) },
        { ts: F, b64: tsB64(F) },
      ],
      done: true,
      reachedTo: F,
    });
    await h.flush();
    expect(h.engine.state).toBe("playing");
    h.engine.tick(h.advanceNow(1000 / 60));
    // probe the buffer: re-feed each ts — buffered ts is skipped (no new
    // decode), dropped ts is decoded again
    h.engine.feed({ seq: 3, items: [{ ts: F, b64: tsB64(F) }], done: false, reachedTo: null });
    h.engine.feed({ seq: 3, items: [{ ts: P, b64: tsB64(P) }], done: false, reachedTo: null });
    h.engine.feed({ seq: 3, items: [{ ts: M, b64: tsB64(M) }], done: false, reachedTo: null });
    await h.flush();
    expect(h.decodes.get(F)).toBe(2); // dropped -> re-decoded
    expect(h.decodes.get(P)).toBe(1); // kept (2 x snapshotMs behind-window)
    expect(h.decodes.get(M)).toBe(1); // kept (lookAhead floor 600_000, not 4000)
  });
});
