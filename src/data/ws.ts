import type { Craft } from "../../shared/craft.js";

export interface FeedStatus {
  opensky: { lastOkAt: number | null; lastError: string | null; pollMs: number };
  ais: { connected: boolean; enabled: boolean };
}

export interface HistoryRange {
  from: number | null;
  to: number | null;
  snapshots: number;
}

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

export interface StatusMessage {
  type: "status";
  feeds: FeedStatus;
  history: HistoryRange;
  faa: FaaStatus;
  serverTime: number;
}

export type RadarMessage =
  | { type: "snapshot"; craft: Craft[] }
  | { type: "update"; upsert: Craft[]; remove: string[] }
  | StatusMessage
  | { type: "timeline.state"; time: number | null; craft: Craft[] }
  | { type: "aircraft.info"; id: string; info: AircraftInfo | null };

export function parseRadarMessage(raw: string): RadarMessage | null {
  try {
    const msg = JSON.parse(raw) as RadarMessage;
    if (msg.type === "snapshot" && Array.isArray(msg.craft)) return msg;
    if (msg.type === "update" && Array.isArray(msg.upsert) && Array.isArray(msg.remove)) return msg;
    if (msg.type === "status" && msg.feeds != null && msg.history != null && msg.faa != null && typeof msg.serverTime === "number") {
      return msg;
    }
    if (
      msg.type === "timeline.state" &&
      (msg.time === null || typeof msg.time === "number") &&
      Array.isArray(msg.craft)
    ) {
      return msg;
    }
    if (msg.type === "aircraft.info" && typeof msg.id === "string" && (msg.info === null || (msg.info && typeof msg.info.nNumber === "string"))) return msg;
    return null;
  } catch {
    return null;
  }
}

export interface RadarSocketHandlers {
  onSnapshot: (craft: Craft[]) => void;
  onUpdate: (upsert: Craft[], remove: string[]) => void;
  onConnection?: (status: "connecting" | "open" | "closed") => void;
  onStatus?: (s: StatusMessage) => void;
  onTimelineState?: (time: number | null, craft: Craft[]) => void;
  onAircraftInfo?: (id: string, info: AircraftInfo | null) => void;
}

export class RadarSocket {
  private ws: WebSocket | null = null;
  private closed = false;
  private retry: number | null = null;
  private attempts = 0;

  constructor(private url: string, private handlers: RadarSocketHandlers) {}

  send(obj: unknown): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(obj));
    }
  }

  sendPollRate(ms: number): void {
    this.send({ type: "poll.rate", ms });
  }

  sendTimelineSeek(time: number): void {
    this.send({ type: "timeline.seek", time });
  }

  sendTimelineLive(): void {
    this.send({ type: "timeline.live" });
  }

  sendAircraftInfo(id: string): void {
    this.send({ type: "aircraft.info", id });
  }

  connect(): void {
    this.closed = false;
    this.open();
  }

  close(): void {
    this.closed = true;
    if (this.retry != null) {
      clearTimeout(this.retry);
      this.retry = null;
    }
    this.ws?.close();
    this.ws = null;
  }

  private open(): void {
    if (this.closed) return;
    this.handlers.onConnection?.("connecting");
    const ws = new WebSocket(this.url);
    this.ws = ws;
    ws.onopen = () => {
      this.attempts = 0;
      this.handlers.onConnection?.("open");
    };
    ws.onmessage = (ev) => {
      const msg = parseRadarMessage(ev.data as string);
      if (!msg) return;
      if (msg.type === "snapshot") this.handlers.onSnapshot(msg.craft);
      else if (msg.type === "update") this.handlers.onUpdate(msg.upsert, msg.remove);
      else if (msg.type === "status") this.handlers.onStatus?.(msg);
      else if (msg.type === "aircraft.info") this.handlers.onAircraftInfo?.(msg.id, msg.info);
      else this.handlers.onTimelineState?.(msg.time, msg.craft);
    };
    ws.onclose = () => {
      this.handlers.onConnection?.("closed");
      this.scheduleReconnect();
    };
    ws.onerror = () => {
      /* onclose follows */
    };
  }

  private scheduleReconnect(): void {
    if (this.closed) return;
    const delay = Math.min(15000, 500 * 2 ** this.attempts++);
    this.retry = window.setTimeout(() => this.open(), delay);
  }
}
