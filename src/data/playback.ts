// Pure client-side playback core: virtual clock, lerp/skip frame modes,
// window buffer, render governor. No DOM, no Worker — the only global is
// atob (browsers and Node 16+). Task 15 wires this into main.ts.

import type { Craft } from "../../shared/craft.js";
import { SPEED_DEFAULT, SPEED_MAX, SPEED_MIN, WINDOW_MAX_BYTES_DEFAULT } from "../../shared/limits.js";
import type { WindowChunk } from "./ws.js";

export type PlaybackState = "idle" | "buffering" | "playing" | "paused";

export interface PlaybackWindowReq {
  seq: number;
  from: number;
  to: number;
  stride: number;
  maxBytes: number;
}

export interface PlaybackOpts {
  snapshotMs: () => number;
  staleMs: () => number;
  historyFrom: () => number | null;
  historyTo: () => number | null;
  requestWindow: (req: PlaybackWindowReq) => void;
  decode: (gz: ArrayBuffer) => Promise<Craft[]>;
  onFrame: (crafts: Craft[], t: number) => void;
  onState: (s: PlaybackState) => void;
  now: () => number;
  log?: (msg: string) => void;
}

export interface PlaybackApi {
  readonly state: PlaybackState;
  readonly cursor: number;
  start(t0: number): void;
  pause(): void;
  stop(): void;
  setSpeed(s: number): void;
  feed(chunk: WindowChunk): void;
  tick(nowMs: number): void;
}

function b64ToBuf(b64: string): ArrayBuffer {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes.buffer;
}

function lerpHeading(a: number | null, b: number | null, f: number): number | null {
  if (a === null || b === null) return a;
  return (a + ((b - a + 540) % 360 - 180) * f + 360) % 360;
}

export function lerpCrafts(a: Craft[], b: Craft[], f: number, t: number, staleMs: number): Craft[] {
  const bById = new Map(b.map((c) => [c.id, c]));
  const out: Craft[] = [];
  for (const ca of a) {
    const cb = bById.get(ca.id);
    if (cb === undefined) continue; // only in a: disappears
    out.push({
      ...ca,
      lat: ca.lat + (cb.lat - ca.lat) * f,
      lon: ca.lon + (cb.lon - ca.lon) * f,
      heading: lerpHeading(ca.heading, cb.heading, f),
      stale: t - cb.updatedAt > staleMs,
    });
  }
  const aIds = new Set(a.map((c) => c.id));
  for (const cb of b) {
    if (!aIds.has(cb.id)) out.push({ ...cb, stale: t - cb.updatedAt > staleMs }); // appears
  }
  return out;
}

export function createPlaybackEngine(opts: PlaybackOpts): PlaybackApi {
  let state: PlaybackState = "idle";
  let cursor = 0;
  let speed = SPEED_DEFAULT;
  let seq = 0;
  let lastTick = 0;
  let lastRender = 0;
  let targetFps = 60;
  let ema = 0;
  let nextFrom: number | null = null;
  let inflightTo: number | null = null;
  const buffer = new Map<number, Craft[]>();

  const snapMs = () => opts.snapshotMs();
  const advancePerFrame = () => (speed * 1000) / targetFps;
  const lookAhead = () => Math.min(1_800_000, Math.max(600_000, advancePerFrame() * 8));

  function setState(s: PlaybackState): void {
    state = s;
    opts.onState(s);
  }

  // Newest buffered entry with ts <= cursor ("lo") and the next entry after
  // it ("hi"); hi.ts > cursor always holds while lo is the greatest <= cursor.
  function bracket(): { loTs: number; lo: Craft[]; hiTs: number | null; hi: Craft[] | null } | null {
    let loTs = -Infinity;
    let lo: Craft[] | null = null;
    let hiTs = Infinity;
    let hi: Craft[] | null = null;
    for (const [ts, crafts] of buffer) {
      if (ts <= cursor) {
        if (ts > loTs) {
          loTs = ts;
          lo = crafts;
        }
      } else if (ts < hiTs) {
        hiTs = ts;
        hi = crafts;
      }
    }
    return lo === null ? null : { loTs, lo, hiTs: hi === null ? null : hiTs, hi };
  }

  function trim(): void {
    const behind = cursor - 2 * snapMs();
    const ahead = cursor + lookAhead();
    for (const ts of [...buffer.keys()]) {
      if (ts < behind || ts > ahead) buffer.delete(ts);
    }
  }

  function maybePromote(): void {
    if (state === "buffering" && bracket() !== null) {
      setState("playing");
      lastTick = opts.now();
    }
  }

  function requestNext(): void {
    if (state !== "buffering" && state !== "playing") return;
    if (inflightTo !== null) return;
    if (nextFrom === null) return;
    const to = opts.historyTo();
    if (to === null || nextFrom > to) return;
    seq++;
    const req: PlaybackWindowReq = {
      seq,
      from: nextFrom,
      to,
      stride: Math.max(1, Math.ceil(advancePerFrame() / snapMs())),
      maxBytes: WINDOW_MAX_BYTES_DEFAULT,
    };
    inflightTo = to;
    nextFrom = null;
    opts.requestWindow(req);
  }

  function start(t0: number): void {
    const from = opts.historyFrom();
    const to = opts.historyTo();
    if (from === null || to === null) return; // empty history: no-op
    buffer.clear();
    targetFps = 60;
    ema = 0;
    lastRender = 0;
    lastTick = opts.now();
    seq++;
    inflightTo = null; // superseded request's chunk drops via the seq check
    cursor = Math.max(from, Math.min(t0, to));
    nextFrom = from;
    setState("buffering");
    requestNext();
  }

  function pause(): void {
    setState("paused");
    lastTick = 0;
  }

  function stop(): void {
    setState("idle");
    buffer.clear();
    seq++;
    inflightTo = null;
    nextFrom = null;
  }

  function setSpeed(s: number): void {
    if (!Number.isFinite(s)) return;
    speed = Math.max(SPEED_MIN, Math.min(SPEED_MAX, s));
    seq++; // in-flight request superseded; the next tick re-requests
  }

  function feed(chunk: WindowChunk): void {
    if (chunk.seq !== seq) return; // superseded: dropped entirely
    for (const item of chunk.items) {
      if (buffer.has(item.ts)) continue;
      let bytes: ArrayBuffer;
      try {
        bytes = b64ToBuf(item.b64);
      } catch {
        opts.log?.(`playback: bad b64 for ts ${item.ts}`);
        continue;
      }
      void opts.decode(bytes).then(
        (crafts) => {
          buffer.set(item.ts, crafts);
          trim();
          maybePromote();
        },
        (err) => opts.log?.(`playback: decode failed for ts ${item.ts}: ${String(err)}`)
      );
    }
    if (chunk.done) {
      const reqTo = inflightTo;
      inflightTo = null;
      nextFrom = chunk.reachedTo === null ? (reqTo ?? 0) + 1 : chunk.reachedTo + 1;
    }
  }

  function tick(nowMs: number): void {
    if (state !== "buffering" && state !== "playing") return;
    if (state === "playing") {
      const dt = nowMs - lastTick;
      lastTick = nowMs;
      const to = opts.historyTo();
      cursor = Math.min(cursor + speed * dt, to ?? cursor);
    }
    requestNext();
    if (nowMs - lastRender < 1000 / targetFps) return; // governor gate
    const br = bracket();
    if (br === null) return; // stall: no renderable lo; the clock still advances
    let frame: Craft[];
    if (
      br.hi !== null &&
      br.hiTs !== null &&
      advancePerFrame() < snapMs() &&
      br.hiTs - br.loTs <= 1.5 * snapMs()
    ) {
      const f = (cursor - br.loTs) / (br.hiTs - br.loTs);
      frame = lerpCrafts(br.lo, br.hi, f, cursor, opts.staleMs());
    } else {
      frame = br.lo.map((c) => ({ ...c, stale: cursor - c.updatedAt > opts.staleMs() }));
    }
    lastRender = nowMs;
    const t0 = opts.now();
    opts.onFrame(frame, cursor);
    const cost = opts.now() - t0;
    ema = ema ? 0.8 * ema + 0.2 * cost : cost;
    if (ema > 34) targetFps = targetFps === 60 ? 30 : 15;
    trim();
    const to = opts.historyTo();
    if (to !== null && cursor >= to) pause(); // after the final frame
  }

  return {
    get state() {
      return state;
    },
    get cursor() {
      return cursor;
    },
    start,
    pause,
    stop,
    setSpeed,
    feed,
    tick,
  };
}
