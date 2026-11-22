import WebSocket from "ws";
import type { BoundingBoxes } from "./ais-tiles.js";
import type { CraftStore } from "./store.js";
import {
  normalizePositionReport,
  normalizeShipStaticData,
  pickMmsi,
  type AisStatic,
} from "./normalize.js";

export const PING_INTERVAL_MS = 20000;
export const PING_TIMEOUT_MS = 40000;
export const DEFAULT_RESUBSCRIBE_MS = 1200;
export const MIN_SUBSCRIBE_SPACING_MS = 1100;
export const FALLBACK_WINDOW_MS = 3000;
export const ATTRIBUTION_MAX_AGE_MS = 5 * 60 * 1000;

// Shared fallback state: frozen so nobody can mutate it through a stored ref.
const GLOBAL_BOXES = Object.freeze([
  Object.freeze([
    Object.freeze([-90, -180]) as [number, number],
    Object.freeze([90, 180]) as [number, number],
  ]) as BoundingBoxes,
]) as BoundingBoxes[];

export interface AisClientOpts {
  url?: string;
  apiKey: string;
  store: CraftStore;
  wsImpl?: typeof WebSocket;
  now?: () => number;
  log?: (msg: string) => void;
  pingIntervalMs?: number;
  pingTimeoutMs?: number;
  name?: string;
  boxesProvider?: () => BoundingBoxes[];
  trackAttribution?: boolean;
  resubscribeMs?: number;
}

export interface AisSecondaryStatus {
  connected: boolean;
  lastError: string | null;
  lastMessageAt: number | null;
  attributions: string[];
}

// Ruled: close-window check is a pure helper so the fallback decision is
// unit-testable without connection timing games.
export function shouldFallBackFollow(
  closeCode: number,
  elapsedMs: number,
  boxCount: number,
): boolean {
  return boxCount >= 2 && closeCode >= 4000 && elapsedMs <= FALLBACK_WINDOW_MS;
}

export class AisClient {
  private staticMap = new Map<string, AisStatic>();
  private ws: WebSocket | null = null;
  private closed = false;
  private connected = false;
  private retry: NodeJS.Timeout | null = null;
  private attempts = 0;
  private pingTimer: NodeJS.Timeout | null = null;
  private lastPongAt: number | null = null;
  private lastError: string | null = null;
  private lastMessageAt: number | null = null;
  private latestBoxes: BoundingBoxes[] | null = null;
  private resubTimer: NodeJS.Timeout | null = null;
  private lastSubscribeAt: number | null = null;
  private lastSentBoxes: BoundingBoxes[] | null = null;
  private attributions = new Map<string, number>();

  constructor(private opts: AisClientOpts) {}

  private get name(): string {
    return this.opts.name ?? "ais";
  }

  private now(): number {
    return this.opts.now?.() ?? Date.now();
  }

  get isConnected(): boolean {
    return this.connected;
  }

  get feedStatus(): { lastError: string | null; lastMessageAt: number | null } {
    return { lastError: this.lastError, lastMessageAt: this.lastMessageAt };
  }

  get secondaryStatus(): AisSecondaryStatus {
    const attributions: string[] = [];
    if (this.opts.trackAttribution) {
      this.pruneAttributions(this.now());
      for (const [s] of [...this.attributions.entries()].sort((a, b) => b[1] - a[1])) {
        attributions.push(s);
      }
    }
    return {
      connected: this.connected,
      lastError: this.lastError,
      lastMessageAt: this.lastMessageAt,
      attributions,
    };
  }

  start(): void {
    this.closed = false;
    this.connect();
  }

  stop(): void {
    this.closed = true;
    this.connected = false;
    this.stopPings();
    if (this.retry) clearTimeout(this.retry);
    this.retry = null;
    if (this.resubTimer) clearTimeout(this.resubTimer);
    this.resubTimer = null;
    if (this.ws) {
      try {
        this.ws.close();
      } catch {
        /* ignore */
      }
      this.ws = null;
    }
  }

  setBoxes(boxes: BoundingBoxes[]): void {
    this.latestBoxes = boxes.slice();
    if (!this.connected) return;
    if (this.resubTimer) clearTimeout(this.resubTimer);
    this.resubTimer = setTimeout(
      () => this.resubscribeTick(),
      this.opts.resubscribeMs ?? DEFAULT_RESUBSCRIBE_MS,
    );
  }

  private currentBoxes(): BoundingBoxes[] {
    return this.latestBoxes ?? this.opts.boxesProvider?.() ?? GLOBAL_BOXES;
  }

  private resubscribeTick(): void {
    this.resubTimer = null;
    if (this.closed || !this.connected || !this.ws) return;
    const since = this.lastSubscribeAt == null ? Infinity : this.now() - this.lastSubscribeAt;
    const wait = MIN_SUBSCRIBE_SPACING_MS - since;
    if (wait > 0) {
      this.resubTimer = setTimeout(() => this.resubscribeTick(), wait);
      return;
    }
    this.sendSubscribe();
  }

  private sendSubscribe(): void {
    const ws = this.ws;
    if (!ws || !this.connected) return;
    const boxes = this.currentBoxes();
    // A subscription frame with zero boxes would replace the server-side
    // filter with nothing; stay silent until a tile exists instead.
    if (boxes.length === 0) {
      this.opts.log?.(`${this.name}: no subscribe boxes — keeping the connection silent`);
      return;
    }
    this.lastSubscribeAt = this.now();
    this.lastSentBoxes = boxes.slice();
    ws.send(
      JSON.stringify({
        APIKey: this.opts.apiKey,
        BoundingBoxes: boxes,
        FilterMessageTypes: ["PositionReport", "ShipStaticData"],
      }),
    );
  }

  private connect(): void {
    if (this.closed) return;
    const WSImpl = this.opts.wsImpl ?? WebSocket;
    const url = this.opts.url ?? "wss://stream.aisstream.io/v0/stream";
    const ws = new WSImpl(url, undefined, { perMessageDeflate: true });
    this.ws = ws;
    ws.on("open", () => {
      this.attempts = 0;
      this.connected = true;
      this.lastError = null;
      this.lastPongAt = this.now();
      this.startPings();
      this.opts.log?.(`${this.name}: connected`);
      this.sendSubscribe();
    });
    ws.on("message", (data: WebSocket.RawData) => {
      this.handleMessage(data.toString());
    });
    ws.on("pong", () => {
      this.lastPongAt = this.now();
    });
    ws.on("close", (code: number, reason: Buffer) => {
      this.stopPings();
      this.connected = false;
      if (this.resubTimer) clearTimeout(this.resubTimer);
      this.resubTimer = null;
      const why = reason?.toString() ? `${code}: ${reason.toString()}` : String(code);
      this.lastError ??= `closed ${why}`;
      this.opts.log?.(`${this.name}: closed ${why}`);
      this.maybeFallBackFollow(code);
      this.scheduleReconnect();
    });
    ws.on("error", (err: Error) => {
      this.lastError = err.message;
      this.opts.log?.(`${this.name}: error ${err.message}`);
    });
  }

  private maybeFallBackFollow(closeCode: number): void {
    const sent = this.lastSentBoxes;
    if (!sent || this.lastSubscribeAt == null) return;
    if (!shouldFallBackFollow(closeCode, this.now() - this.lastSubscribeAt, sent.length)) return;
    this.latestBoxes = sent.slice(-1);
    this.opts.log?.(`${this.name}: fell back to follow tile`);
  }

  private startPings(): void {
    this.stopPings();
    this.pingTimer = setInterval(() => this.heartbeat(), this.opts.pingIntervalMs ?? PING_INTERVAL_MS);
  }

  private stopPings(): void {
    if (this.pingTimer) clearInterval(this.pingTimer);
    this.pingTimer = null;
  }

  private heartbeat(): void {
    const ws = this.ws;
    if (this.closed || !ws) return;
    const timeout = this.opts.pingTimeoutMs ?? PING_TIMEOUT_MS;
    if (this.lastPongAt != null && this.now() - this.lastPongAt > timeout) {
      this.lastError = "keepalive timeout";
      this.opts.log?.(`${this.name}: keepalive timeout — terminating`);
      ws.terminate();
      return;
    }
    try {
      ws.ping();
    } catch {
      /* socket closing */
    }
  }

  private scheduleReconnect(): void {
    if (this.closed) return;
    const delay = Math.min(30000, 1000 * 2 ** this.attempts++);
    this.opts.log?.(`${this.name}: reconnect in ${delay}ms`);
    this.retry = setTimeout(() => this.connect(), delay);
  }

  private captureAttribution(env: any): void {
    const type = env?.MessageType;
    if (type !== "PositionReport" && type !== "ShipStaticData") return;
    const s = env.attribution ?? env.source ?? env.license;
    if (typeof s !== "string" || s.length === 0) return;
    const now = this.now();
    this.pruneAttributions(now);
    this.attributions.set(s, now);
  }

  private pruneAttributions(now: number): void {
    for (const [s, seenAt] of this.attributions) {
      if (now - seenAt > ATTRIBUTION_MAX_AGE_MS) this.attributions.delete(s);
    }
  }

  handleMessage(raw: string): void {
    let env: any;
    try {
      env = JSON.parse(raw);
    } catch {
      return;
    }
    if (this.opts.trackAttribution) this.captureAttribution(env);
    const now = this.now();
    const type = env?.MessageType;
    if (type === "SubscriptionConfirmation") {
      const compressed = env?.Message?.CompressionEnabled === true;
      this.opts.log?.(`${this.name}: subscribed (compression: ${compressed})`);
      return;
    }
    if (type === "ShipStaticData") {
      this.lastMessageAt = now;
      const sd = normalizeShipStaticData(env);
      if (sd) this.staticMap.set(sd.mmsi, sd);
      return;
    }
    if (type === "PositionReport") {
      this.lastMessageAt = now;
      const mmsi = pickMmsi(env);
      const sd = mmsi ? this.staticMap.get(mmsi) : undefined;
      const c = normalizePositionReport(env, sd, now);
      if (c) this.opts.store.upsert(c, now);
    }
  }
}
