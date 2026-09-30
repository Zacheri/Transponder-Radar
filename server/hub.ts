import type { CraftStore } from "./store.js";

export interface WsLike {
  send(data: string): void;
  on(event: string, cb: (...args: any[]) => void): void;
  removeListener(event: string, cb: (...args: any[]) => void): void;
  close(): void;
}

export interface FeedStatus {
  opensky: { lastOkAt: number | null; lastError: string | null };
  ais: { connected: boolean; enabled: boolean };
}

export interface HubOpts {
  store: CraftStore;
  batchMs: number;
  log?: (msg: string) => void;
  feedStatus?: () => FeedStatus;
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
    const feeds = this.opts.feedStatus?.();
    if (feeds) {
      socket.send(JSON.stringify({ type: "status", feeds, serverTime: Date.now() }));
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
    const feeds = this.opts.feedStatus?.();
    if (feeds) {
      const json = JSON.stringify(feeds);
      if (this.lastStatusJson !== json) {
        this.lastStatusJson = json;
        const statusPayload = JSON.stringify({ type: "status", feeds, serverTime: Date.now() });
        for (const c of this.clients) {
          try {
            c.send(statusPayload);
          } catch {
            /* ignore */
          }
        }
      }
    }
    const { upsert, remove } = this.opts.store.drainDirty();
    if (upsert.length === 0 && remove.length === 0) return;
    const payload = JSON.stringify({ type: "update", upsert, remove });
    for (const c of this.clients) {
      try {
        c.send(payload);
      } catch {
        /* ignore */
      }
    }
  }
}
