import type { Craft } from "../shared/craft.js";
import type { CraftStore } from "./store.js";
import type { HistoryRange } from "./history.js";
import type { FaaStatus } from "./faa.js";
import type { IconStatus } from "./iconpack.js";

export interface WsLike {
  send(data: string): void;
  on(event: string, cb: (...args: any[]) => void): void;
  close(): void;
}

export interface FeedStatus {
  opensky: { lastOkAt: number | null; lastError: string | null; pollMs: number };
  ais: { connected: boolean; enabled: boolean; lastError: string | null; lastMessageAt: number | null; flushMs: number };
}

export const FEED_IDS = ["opensky", "ais"] as const;
export type FeedId = (typeof FEED_IDS)[number];

// Server-side slider bounds for the sea flush window (client agrees).
export const AIS_FLUSH_MIN_MS = 500;
export const AIS_FLUSH_MAX_MS = 15000;

// Fixed internal tick; per-feed windows decide when a domain drains.
const TICK_MS = 250;

export type ClientMessage =
  | { type: "feed.rate"; feed: FeedId; ms: number }
  | { type: "timeline.seek"; time: number }
  | { type: "timeline.live" }
  | { type: "aircraft.info"; id: string };

export function parseClientMessage(raw: string): ClientMessage | null {
  try {
    const m = JSON.parse(raw) as ClientMessage;
    if (
      m.type === "feed.rate" &&
      (FEED_IDS as readonly string[]).includes(m.feed) &&
      typeof m.ms === "number" &&
      Number.isFinite(m.ms) &&
      m.ms > 0
    ) {
      return { type: "feed.rate", feed: m.feed as FeedId, ms: m.ms };
    }
    if (m.type === "timeline.seek" && typeof m.time === "number" && Number.isFinite(m.time)) return m;
    if (m.type === "timeline.live") return m;
    if (m.type === "aircraft.info" && typeof m.id === "string" && m.id.length > 0) return m;
    return null;
  } catch {
    return null;
  }
}

export interface StatusPayload {
  feeds: FeedStatus;
  history: HistoryRange;
  faa: FaaStatus;
  icons: IconStatus;
}

export interface HubOpts {
  store: CraftStore;
  batchMs: number; // air flush window (today's BATCH_MS semantics)
  aisFlushMs?: number; // sea flush window; default = batchMs
  log?: (msg: string) => void;
  statusPayload?: () => StatusPayload;
}

export class Hub {
  private clients = new Set<WsLike>();
  private timer: NodeJS.Timeout | null = null;
  private lastStatusJson: string | null = null;
  private seaWindow: number;
  private airLastFlush = 0;
  private seaLastFlush = 0;

  constructor(private opts: HubOpts) {
    this.seaWindow = opts.aisFlushMs ?? opts.batchMs;
  }

  get clientCount(): number {
    return this.clients.size;
  }

  get aisFlushMs(): number {
    return this.seaWindow;
  }

  // Live; clamped to the slider bounds. Non-finite input is ignored.
  setAisFlushMs(ms: number): void {
    if (typeof ms !== "number" || !Number.isFinite(ms)) return;
    this.seaWindow = Math.min(AIS_FLUSH_MAX_MS, Math.max(AIS_FLUSH_MIN_MS, ms));
  }

  attach(socket: WsLike): void {
    this.clients.add(socket);
    const onClose = () => this.detach(socket);
    socket.on("close", onClose);
    socket.on("error", onClose);
    socket.send(JSON.stringify({ type: "snapshot", craft: this.opts.store.all() }));
    const payload = this.opts.statusPayload?.();
    if (payload) {
      socket.send(JSON.stringify({ type: "status", feeds: payload.feeds, history: payload.history, faa: payload.faa, icons: payload.icons, serverTime: Date.now() }));
    }
  }

  private detach(socket: WsLike): void {
    this.clients.delete(socket);
  }

  start(): void {
    if (this.timer) return;
    // Windows start at start(): no instant flush burst — the first drain of a
    // domain can only happen once its full window has elapsed.
    this.airLastFlush = Date.now();
    this.seaLastFlush = Date.now();
    this.timer = setInterval(() => this.tick(), TICK_MS);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    for (const c of this.clients) {
      try {
        c.close();
      } catch {
        /* ignore */
      }
    }
    this.clients.clear();
  }

  private tick(): void {
    const payload = this.opts.statusPayload?.();
    if (payload) {
      const json = JSON.stringify({ feeds: payload.feeds, history: payload.history, faa: payload.faa, icons: payload.icons });
      if (this.lastStatusJson !== json) {
        this.lastStatusJson = json;
        const frame = JSON.stringify({ type: "status", feeds: payload.feeds, history: payload.history, faa: payload.faa, icons: payload.icons, serverTime: Date.now() });
        for (const c of this.clients) {
          try {
            c.send(frame);
          } catch {
            /* ignore */
          }
        }
      }
    }
    // Per-feed flush windows: a domain drains only on a tick where its own
    // window has elapsed; changes from both due domains ride ONE combined
    // update frame (skipped when nothing drained).
    const now = Date.now();
    const upsert: Craft[] = [];
    const remove: string[] = [];
    if (now - this.airLastFlush >= this.opts.batchMs) {
      const d = this.opts.store.drainDirty("air");
      upsert.push(...d.upsert);
      remove.push(...d.remove);
      this.airLastFlush = now;
    }
    if (now - this.seaLastFlush >= this.seaWindow) {
      const d = this.opts.store.drainDirty("sea");
      upsert.push(...d.upsert);
      remove.push(...d.remove);
      this.seaLastFlush = now;
    }
    if (upsert.length === 0 && remove.length === 0) return;
    const update = JSON.stringify({ type: "update", upsert, remove });
    for (const c of this.clients) {
      try {
        c.send(update);
      } catch {
        /* ignore */
      }
    }
  }
}
