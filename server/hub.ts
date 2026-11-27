import { AIR_KINDS } from "../shared/craft.js";
import type { AirKind, Craft, CraftKind } from "../shared/craft.js";
import type { LonLat } from "../shared/geo.js";
import type { AisSecondaryStatus } from "./ais.js";
import type { BoundingBoxes, TileCenter } from "./ais-tiles.js";
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
    // Mirror of the poller's BoostStatus v2 (import-free by hub convention);
    // the poller sends it once a zones.config is live, null/absent = legacy.
    // zones = live auto zone count; sectionsActive/Idle split the manual
    // side; creditsToday is the memory-only UTC-day zone spend (spec §C).
    // count = craft across live polled zones. Mirrored in src/data/ws.ts.
    boost?: {
      active: boolean;
      count: number;
      intervalMs: number | null;
      paused: "credits" | "standdown" | null;
      zones: number;
      sectionsActive: number;
      sectionsIdle: number;
      creditsToday: number;
    } | null;
  };
  ais: {
    connected: boolean;
    enabled: boolean;
    lastError: string | null;
    lastMessageAt: number | null;
    flushMs: number;
    // aiscast fill feed. Non-nullable by design: disabled = enabled:false
    // zeroed block, never null (kills a client-branch class).
    // boxes: the server-composed aiscast tiles as [[minLat,minLon],[maxLat,maxLon]]
    // edge pairs ([] when disabled/no tiles). Present on every server frame
    // since wave 9; typed optional for legacy readers (the boost idiom).
    // Mirrored in src/data/ws.ts.
    secondary: { enabled: boolean; boxes?: BoundingBoxes[] } & AisSecondaryStatus;
  };
}

export const FEED_IDS = ["opensky", "ais"] as const;
export type FeedId = (typeof FEED_IDS)[number];

// Server-side slider bounds for the sea flush window (client agrees).
// Vessels move slowly: 60–600 s is the useful range (2026-10-29, with user).
export const AIS_FLUSH_MIN_MS = 60000;
export const AIS_FLUSH_MAX_MS = 600000;
export const AIS_FLUSH_DEFAULT_MS = 120000;

// Ceiling for one traffic.report frame (client harvests WAN-down deltas every
// 5 s; anything above this is a bug or an attack, so the frame dies at the hub).
export const TRAFFIC_REPORT_MAX_BYTES = 50_000_000;

// Fixed internal tick; per-feed windows decide when a domain drains.
const TICK_MS = 250;

// zones.config v2 wire blocks (spec 2026-11-27 §D). The hub validates SHAPE
// only (strict-style like kinds: a bad auto/sections shape drops the whole
// frame); field VALUES — createMin/standdownAt ranges, per-section kinds
// membership, box extents, the ≤6 cap and id dedup — are the poller's, which
// clamps or drops that SECTION (ruling: per-section drop, never whole-frame,
// for value-level garbage the hub cannot judge). Mirrored in src/data/ws.ts.
export interface ZonesAutoWire {
  enabled: boolean;
  createMin: number;
  standdownAt: number;
}

export interface ZonesSectionWire {
  id: string;
  kinds: CraftKind[];
  boostMs: number;
  b: [[number, number], [number, number]];
}

const zonesAutoShapeOk = (a: unknown): boolean =>
  a === undefined ||
  (typeof a === "object" &&
    a !== null &&
    !Array.isArray(a) &&
    typeof (a as ZonesAutoWire).enabled === "boolean" &&
    typeof (a as ZonesAutoWire).createMin === "number" &&
    Number.isFinite((a as ZonesAutoWire).createMin) &&
    typeof (a as ZonesAutoWire).standdownAt === "number" &&
    Number.isFinite((a as ZonesAutoWire).standdownAt));

const sectionBoxShapeOk = (b: unknown): boolean =>
  Array.isArray(b) &&
  b.length === 2 &&
  b.every((p) => Array.isArray(p) && p.length === 2 && p.every((v) => typeof v === "number" && Number.isFinite(v)));

const zonesSectionsShapeOk = (s: unknown): boolean =>
  s === undefined ||
  (Array.isArray(s) &&
    s.every(
      (el) =>
        typeof el === "object" &&
        el !== null &&
        !Array.isArray(el) &&
        typeof (el as ZonesSectionWire).id === "string" &&
        Array.isArray((el as ZonesSectionWire).kinds) &&
        (el as ZonesSectionWire).kinds.every((k) => typeof k === "string") &&
        typeof (el as ZonesSectionWire).boostMs === "number" &&
        Number.isFinite((el as ZonesSectionWire).boostMs) &&
        sectionBoxShapeOk((el as ZonesSectionWire).b),
    ));

export type ClientMessage =
  | { type: "feed.rate"; feed: FeedId; ms: number }
  | { type: "timeline.seek"; time: number; seq?: number }
  | { type: "timeline.live" }
  | { type: "aircraft.info"; id: string }
  | { type: "settings.update"; patch: { storageCapGb?: number; ramCacheGb?: number; homeRegion?: TileCenter | null } }
  | { type: "ais.tile"; lat: number; lon: number }
  | {
      type: "zones.config";
      kinds: CraftKind[];
      boostMs: number;
      auto?: ZonesAutoWire;
      sections?: ZonesSectionWire[];
    }
  | { type: "pin.add"; from: number; to: number }
  | { type: "pin.remove"; id: string }
  | { type: "flight.track"; id: string; seq?: number; auto?: boolean }
  | { type: "flight.context"; id: string; seq?: number }
  // traffic.*: client → server egress-reporting frames (spec §A); mirrored
  // in src/data/ws.ts.
  | { type: "traffic.watch"; on: boolean }
  | { type: "traffic.report"; down: number }
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
    // whole frame; the poller clamps boostMs and duplicate kinds are made
    // inert by its membership checks. v2: a bad auto/sections SHAPE drops the
    // whole frame too (strict-style); v1 frames (fields absent) pass verbatim
    // — the poller supplies the v1 defaults.
    if (
      m.type === "zones.config" &&
      Array.isArray(m.kinds) &&
      m.kinds.every((k) => typeof k === "string" && (AIR_KINDS as readonly string[]).includes(k)) &&
      typeof m.boostMs === "number" &&
      Number.isFinite(m.boostMs) &&
      zonesAutoShapeOk(m.auto) &&
      zonesSectionsShapeOk(m.sections)
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
    if (m.type === "traffic.watch" && typeof m.on === "boolean") return m;
    if (
      m.type === "traffic.report" &&
      typeof m.down === "number" &&
      Number.isFinite(m.down) &&
      m.down >= 0 &&
      m.down <= TRAFFIC_REPORT_MAX_BYTES
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
  // Broadcast-geometry copies of the zones being polled right now (design §D,
  // section boost): auto zones (slot-stable order, densest at formation,
  // <= MAX_ZONES, dominantKind renamed `kind`, id "auto:<n>") plus MANUAL
  // sections — sections ship ONLY while active, carrying manual/active true.
  // Empty array when nothing is configured/formed.
  hotzones: {
    center: LonLat;
    halfW: number;
    halfH: number;
    count: number;
    kind: AirKind;
    id: string;
    manual?: boolean;
    active?: boolean;
  }[];
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
