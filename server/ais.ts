import WebSocket from "ws";
import type { CraftStore } from "./store.js";
import {
  normalizePositionReport,
  normalizeShipStaticData,
  pickMmsi,
  type AisStatic,
} from "./normalize.js";

export const PING_INTERVAL_MS = 20000;
export const PING_TIMEOUT_MS = 40000;

export interface AisClientOpts {
  url?: string;
  apiKey: string;
  store: CraftStore;
  wsImpl?: typeof WebSocket;
  now?: () => number;
  log?: (msg: string) => void;
  pingIntervalMs?: number;
  pingTimeoutMs?: number;
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

  constructor(private opts: AisClientOpts) {}

  private now(): number {
    return this.opts.now?.() ?? Date.now();
  }

  get isConnected(): boolean {
    return this.connected;
  }

  get feedStatus(): { lastError: string | null; lastMessageAt: number | null } {
    return { lastError: this.lastError, lastMessageAt: this.lastMessageAt };
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
    if (this.ws) {
      try {
        this.ws.close();
      } catch {
        /* ignore */
      }
      this.ws = null;
    }
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
      this.opts.log?.("ais: connected");
      ws.send(
        JSON.stringify({
          APIKey: this.opts.apiKey,
          BoundingBoxes: [[[-90, -180], [90, 180]]],
          FilterMessageTypes: ["PositionReport", "ShipStaticData"],
        }),
      );
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
      const why = reason?.toString() ? `${code}: ${reason.toString()}` : String(code);
      this.lastError ??= `closed ${why}`;
      this.opts.log?.(`ais: closed ${why}`);
      this.scheduleReconnect();
    });
    ws.on("error", (err: Error) => {
      this.lastError = err.message;
      this.opts.log?.(`ais: error ${err.message}`);
    });
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
      this.opts.log?.("ais: keepalive timeout — terminating");
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
    this.opts.log?.(`ais: reconnect in ${delay}ms`);
    this.retry = setTimeout(() => this.connect(), delay);
  }

  handleMessage(raw: string): void {
    let env: any;
    try {
      env = JSON.parse(raw);
    } catch {
      return;
    }
    const now = this.now();
    const type = env?.MessageType;
    if (type === "SubscriptionConfirmation") {
      const compressed = env?.Message?.CompressionEnabled === true;
      this.opts.log?.(`ais: subscribed (compression: ${compressed})`);
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
