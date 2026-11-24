import { AIR_KINDS } from "../shared/craft.js";
import type { AirKind, Craft, CraftKind } from "../shared/craft.js";
import type { LonLat } from "../shared/geo.js";
import type { AisSecondaryStatus } from "./ais.js";
import type { TileCenter } from "./ais-tiles.js";
import type { CraftStore } from "./store.js";
import type { HistoryStatus } from "./history.js";
import type { FaaStatus } from "./faa.js";
import type { IconStatus } from "./iconpack.js";
import type { Pin } from "./pins.js";

export interface WsLike {
  send(data: string): void;
  on(event: string, cb: (...args: any[]) => void): void;
  close(): void;
}

export interface FeedStatus {
  opensky: {
    lastOkAt: number | null;
    lastError: string | null;
    pollMs: number;
    // Mirror of the poller's BoostStatus (import-free by hub convention); the
    // poller sends it once a zones.config is live, null/absent = legacy.
    boost?: { active: boolean; count: number; intervalMs: number | null; paused: "credits" | null } | null;
  };
  ais: {
    connected: boolean;
    enabled: boolean;
    lastError: string | null;
    lastMessageAt: number | null;
    flushMs: number;
    // aiscast fill feed. Non-nullable by design: disabled = enabled:false
    // zeroed block, never null (kills a client-branch class).
    secondary: { enabled: boolean } & AisSecondaryStatus;
  };
}

export const FEED_IDS = ["opensky", "ais"] as const;
export type FeedId = (typeof FEED_IDS)[number];

// Server-side slider bounds for the sea flush window (client agrees).
// Vessels move slowly: 60–600 s is the useful range (2026-10-29, with user).
export const AIS_FLUSH_MIN_MS = 60000;
export const AIS_FLUSH_MAX_MS = 600000;
export const AIS_FLUSH_DEFAULT_MS = 120000;

// Fixed internal tick; per-feed windows decide when a domain drains.
const TICK_MS = 250;

export type ClientMessage =
  | { type: "feed.rate"; feed: FeedId; ms: number }
  | { type: "timeline.seek"; time: number; seq?: number }
  | { type: "timeline.live" }
  | { type: "aircraft.info"; id: string }
  | { type: "settings.update"; patch: { storageCapGb?: number; ramCacheGb?: number; homeRegion?: TileCenter | null } }
  | { type: "ais.tile"; lat: number; lon: number }
  | { type: "zones.config"; kinds: CraftKind[]; boostMs: number }
  | { type: "pin.add"; from: number; to: number }
  | { type: "pin.remove"; id: string }
  | { type: "flight.track"; id: string; seq?: number; auto?: boolean }
  | { type: "flight.context"; id: string; seq?: number }
  | { type: "timeline.window"; seq: number; from: number; to: number; stride: number; maxBytes: number };

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
    if (m.type === "timeline.seek" && typeof m.time === "number" && Number.isFinite(m.time)) {
      // Optional seq (stale-reply suppression); absent or non-numeric → no key.
      return typeof m.seq === "number" && Number.isFinite(m.seq)
        ? { type: "timeline.seek", time: m.time, seq: m.seq }
        : { type: "timeline.seek", time: m.time };
    }
    if (m.type === "timeline.live") return m;
    if (m.type === "aircraft.info" && typeof m.id === "string" && m.id.length > 0) return m;
    if (m.type === "settings.update" && typeof m.patch === "object" && m.patch !== null && !Array.isArray(m.patch)) return m;
    // homeRegion passes through untouched (object-or-null); field checks live
    // in the index.ts handler.
    if (
      m.type === "ais.tile" &&
      typeof m.lat === "number" &&
      Number.isFinite(m.lat) &&
      typeof m.lon === "number" &&
      Number.isFinite(m.lon)
    )
      return m;
    // zones.config carries what it carries: one invalid kind member drops the
    // whole frame; dedup + boostMs clamping are the poller's (setZonesConfig).
    if (
      m.type === "zones.config" &&
      Array.isArray(m.kinds) &&
      m.kinds.every((k) => typeof k === "string" && (AIR_KINDS as readonly string[]).includes(k)) &&
      typeof m.boostMs === "number" &&
      Number.isFinite(m.boostMs)
    )
      return m;
    if (
      m.type === "pin.add" &&
      typeof m.from === "number" &&
      Number.isFinite(m.from) &&
      typeof m.to === "number" &&
      Number.isFinite(m.to)
    ) return m;
    if (m.type === "pin.remove" && typeof m.id === "string" && m.id.length > 0) return m;
    // seq here is a strict optional key (unlike timeline.seek, whose garbage
    // seq is silently dropped): a malformed seq/auto marks the whole frame bad.
    if (
      m.type === "flight.track" &&
      typeof m.id === "string" &&
      m.id.length > 0 &&
      (m.seq === undefined || (Number.isInteger(m.seq) && m.seq >= 0)) &&
      (m.auto === undefined || typeof m.auto === "boolean")
    )
      return m;
    if (
      m.type === "flight.context" &&
      typeof m.id === "string" &&
      m.id.length > 0 &&
      (m.seq === undefined || (Number.isInteger(m.seq) && m.seq >= 0))
    )
      return m;
    if (
      m.type === "timeline.window" &&
      Number.isInteger(m.seq) &&
      typeof m.from === "number" &&
      Number.isFinite(m.from) &&
      typeof m.to === "number" &&
      Number.isFinite(m.to) &&
      Number.isInteger(m.stride) &&
      m.stride >= 1 &&
      typeof m.maxBytes === "number" &&
      Number.isFinite(m.maxBytes) &&
      m.maxBytes > 0
    ) return m;
    return null;
  } catch {
    return null;
  }
}

export interface StatusPayload {
  feeds: FeedStatus;
  history: HistoryStatus;
  settings: { storageCapGb: number; ramCacheGb: number; cacheUsedBytes: number; homeRegion: TileCenter | null };
  pins: Pin[];
  staleMs: number;
  faa: FaaStatus;
  icons: IconStatus;
  // Broadcast-geometry copy of the live hot zone (R4 hysteresis; the poller's
  // dominantKind ships as `kind`), or null when no zone is configured/formed.
  hotzone: { center: LonLat; halfW: number; halfH: number; count: number; kind: AirKind } | null;
}

export interface HubOpts {
  store: CraftStore;
  batchMs: number; // air flush window (today's BATCH_MS semantics)
  aisFlushMs?: number; // sea flush window; default = AIS_FLUSH_DEFAULT_MS
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
    this.seaWindow = opts.aisFlushMs ?? AIS_FLUSH_DEFAULT_MS;
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
      socket.send(JSON.stringify({ type: "status", ...payload, serverTime: Date.now() }));
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
      const json = JSON.stringify(payload);
      if (this.lastStatusJson !== json) {
        this.lastStatusJson = json;
        const frame = JSON.stringify({ type: "status", ...payload, serverTime: Date.now() });
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
