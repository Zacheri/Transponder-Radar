import type { Craft } from "../../shared/craft.js";

export type RadarMessage =
  | { type: "snapshot"; craft: Craft[] }
  | { type: "update"; upsert: Craft[]; remove: string[] };

export function parseRadarMessage(raw: string): RadarMessage | null {
  try {
    const msg = JSON.parse(raw) as RadarMessage;
    if (msg.type === "snapshot" && Array.isArray(msg.craft)) return msg;
    if (msg.type === "update" && Array.isArray(msg.upsert) && Array.isArray(msg.remove)) return msg;
    return null;
  } catch {
    return null;
  }
}

export interface RadarSocketHandlers {
  onSnapshot: (craft: Craft[]) => void;
  onUpdate: (upsert: Craft[], remove: string[]) => void;
  onStatus?: (status: "connecting" | "open" | "closed") => void;
}

export class RadarSocket {
  private ws: WebSocket | null = null;
  private closed = false;
  private retry: number | null = null;
  private attempts = 0;

  constructor(private url: string, private handlers: RadarSocketHandlers) {}

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
    this.handlers.onStatus?.("connecting");
    const ws = new WebSocket(this.url);
    this.ws = ws;
    ws.onopen = () => {
      this.attempts = 0;
      this.handlers.onStatus?.("open");
    };
    ws.onmessage = (ev) => {
      const msg = parseRadarMessage(ev.data as string);
      if (!msg) return;
      if (msg.type === "snapshot") this.handlers.onSnapshot(msg.craft);
      else this.handlers.onUpdate(msg.upsert, msg.remove);
    };
    ws.onclose = () => {
      this.handlers.onStatus?.("closed");
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
