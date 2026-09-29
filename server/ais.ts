import WebSocket from "ws";
import type { CraftStore } from "./store.js";
import {
  normalizePositionReport,
  normalizeShipStaticData,
  type AisStatic,
} from "./normalize.js";

export interface AisClientOpts {
  url?: string;
  apiKey: string;
  store: CraftStore;
  wsImpl?: typeof WebSocket;
  now?: () => number;
  log?: (msg: string) => void;
}

export class AisClient {
  private staticMap = new Map<string, AisStatic>();
  private ws: WebSocket | null = null;
  private closed = false;
  private retry: NodeJS.Timeout | null = null;
  private attempts = 0;

  constructor(private opts: AisClientOpts) {}

  start(): void {
    this.closed = false;
    this.connect();
  }

  stop(): void {
    this.closed = true;
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
    const ws = new WSImpl(url);
    this.ws = ws;
    ws.on("open", () => {
      this.attempts = 0;
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
    ws.on("close", () => this.scheduleReconnect());
    ws.on("error", (err: Error) => this.opts.log?.(`ais: error ${err.message}`));
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
    const now = this.opts.now?.() ?? Date.now();
    const type = env?.MessageType;
    if (type === "ShipStaticData") {
      const sd = normalizeShipStaticData(env);
      if (sd) this.staticMap.set(sd.mmsi, sd);
      return;
    }
    if (type === "PositionReport") {
      const mmsi = String(
        env?.MMSI ?? env?.metaData?.mmsi ?? env?.Message?.PositionReport?.UserID ?? "",
      );
      const sd = mmsi ? this.staticMap.get(mmsi) : undefined;
      const c = normalizePositionReport(env, sd, now);
      if (c) this.opts.store.upsert(c, now);
    }
  }
}
