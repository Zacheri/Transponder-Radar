import type { CraftStore } from "./store.js";
import type { HistoryRange } from "./history.js";

export interface WsLike {
  send(data: string): void;
  on(event: string, cb: (...args: any[]) => void): void;
  close(): void;
}

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

export interface StatusPayload {
  feeds: FeedStatus;
  history: HistoryRange;
}

export interface HubOpts {
  store: CraftStore;
  batchMs: number;
  log?: (msg: string) => void;
  statusPayload?: () => StatusPayload;
}

export class Hub {
  private clients = new Set<WsLike>();
  private timer: NodeJS.Timeout | null = null;
  private lastStatusJson: string | null = null;

  constructor(private opts: HubOpts) {}

  get clientCount(): number {
    return this.clients.size;
  }

  attach(socket: WsLike): void {
    this.clients.add(socket);
    const onClose = () => this.detach(socket);
    socket.on("close", onClose);
    socket.on("error", onClose);
    socket.send(JSON.stringify({ type: "snapshot", craft: this.opts.store.all() }));
    const payload = this.opts.statusPayload?.();
    if (payload) {
      socket.send(JSON.stringify({ type: "status", feeds: payload.feeds, history: payload.history, serverTime: Date.now() }));
    }
  }

  private detach(socket: WsLike): void {
    this.clients.delete(socket);
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => this.tick(), this.opts.batchMs);
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
    const { upsert, remove } = this.opts.store.drainDirty();
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
