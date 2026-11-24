import type { CraftStore } from "./store.js";
import { normalizeOpenSky } from "./normalize.js";
import type { Craft, AirKind } from "../shared/craft.js";
import type { TokenProvider } from "./opensky-auth.js";
import type { HotZone, ZoneMember, ZoneState } from "./hotzones.js";
import { planZone, surplusCredits, zoneIntervalFor } from "./hotzones.js";

export const BACKOFF_CAP_MS = 300000;
export const POLL_MIN_MS = 15000;
export const POLL_MAX_MS = 3600000;
export const ZONE_BOOST_MIN_MS = 10000;
export const ZONE_BOOST_MAX_MS = 120000;

// The globe path only ever makes the global /states/all call: >400 sq° tier.
const GLOBE_CALL_COST = 4;

export interface OpenSkyPollerOpts {
  url?: string;
  pollMs: number;
  graceMs: number;
  store: CraftStore;
  fetchImpl?: typeof fetch;
  now?: () => number;
  log?: (msg: string) => void;
  timeoutMs?: number;
  tokenProvider?: TokenProvider;
  resolveIcon?: (c: Craft) => string;
}

export interface PollResult {
  upserted: number;
  nextDelayMs: number;
}

export interface ZonesConfig {
  kinds: AirKind[];
  boostMs: number;
}

export interface BoostStatus {
  active: boolean;
  count: number;
  intervalMs: number | null;
  paused: "credits" | null;
}

export class OpenSkyPoller {
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private consecutiveErrors = 0;
  private lastOkAt: number | null = null;
  private lastError: string | null = null;
  // x-rate-limit-remaining from the most recent globe /states response; the
  // boost scheduler's only credit signal (never seen -> boost stays off).
  private statesRemaining: number | null = null;
  private zonesCfg: ZonesConfig | null = null;
  private zoneState: ZoneState | null = null;
  private zoneTimer: NodeJS.Timeout | null = null;
  // Boost enablement, independent of timer identity — must stay true through
  // the in-flight window of a zone tick (the timer is nulled during it).
  private zoneActive = false;
  private zoneNextAt: number | null = null;
  private boostPausedUntil = 0;
  private boostPaused: "credits" | null = null;
  private boostIntervalMs: number | null = null;
  private zoneErrors = 0;

  constructor(private opts: OpenSkyPollerOpts) {}

  get feedStatus(): {
    lastOkAt: number | null;
    lastError: string | null;
    pollMs: number;
    boost: BoostStatus | null;
  } {
    const boost = this.zonesCfg
      ? {
          active: this.zoneActive,
          count: this.zoneState?.box?.count ?? 0,
          intervalMs: this.boostPaused ? null : this.boostIntervalMs,
          paused: this.boostPaused,
        }
      : null;
    return { lastOkAt: this.lastOkAt, lastError: this.lastError, pollMs: this.opts.pollMs, boost };
  }

  // Broadcast-geometry copy of the live hot zone (design R4), or null.
  get zoneStatus(): HotZone | null {
    return this.zoneState?.box ?? null;
  }

  // Full-replace semantics; null disables and clears the zone + timer.
  // boostMs is clamped here (the hub validator only checks finiteness).
  setZonesConfig(cfg: ZonesConfig | null): void {
    if (!cfg) {
      this.zonesCfg = null;
      this.zoneState = null;
      this.zoneActive = false;
      this.zoneNextAt = null;
      this.boostPaused = null;
      this.boostIntervalMs = null;
      this.boostPausedUntil = 0;
      this.clearZoneTimer();
      return;
    }
    if (!Number.isFinite(cfg.boostMs)) return; // defensive: hub drops these frames
    const boostMs = Math.min(ZONE_BOOST_MAX_MS, Math.max(ZONE_BOOST_MIN_MS, Math.round(cfg.boostMs)));
    this.zonesCfg = { kinds: [...cfg.kinds], boostMs };
    this.zoneState = null; // new kind set -> the old zone is void
    this.zoneActive = true;
    this.zoneNextAt = null; // re-enable must not inherit a stale due-time
    this.boostPausedUntil = 0;
    this.boostPaused = null;
    this.boostIntervalMs = null;
    this.armZoneTimer(boostMs); // enabling starts the zone timer machinery
  }

  setPollInterval(ms: number): void {
    const n = Math.round(ms);
    if (Number.isFinite(n)) {
      this.opts.pollMs = Math.min(POLL_MAX_MS, Math.max(POLL_MIN_MS, n));
    }
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    // stop() cleared enablement; a restart with a live config must not leave
    // boost.active false while the machinery is back (re-arms on this poll).
    this.zoneActive = this.zonesCfg !== null;
    void this.loop();
  }

  stop(): void {
    this.running = false;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.zoneActive = false;
    this.clearZoneTimer();
  }

  private async loop(): Promise<void> {
    if (!this.running) return;
    let nextDelayMs: number;
    try {
      nextDelayMs = (await this.pollOnce()).nextDelayMs;
    } catch (e) {
      this.opts.log?.(`opensky: ${e instanceof Error ? e.message : String(e)}`);
      nextDelayMs = this.backoffDelay();
    }
    this.schedule(nextDelayMs);
  }

  private schedule(delayMs: number): void {
    if (!this.running) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.loop();
    }, delayMs);
  }

  private backoffDelay(): number {
    this.consecutiveErrors += 1;
    return Math.min(BACKOFF_CAP_MS, this.opts.pollMs * 2 ** this.consecutiveErrors);
  }

  // Authed fetch + one token-refresh retry on 401. Throws on network errors.
  private async fetchStates(url: string): Promise<Response> {
    const fetchImpl = this.opts.fetchImpl ?? fetch;
    const signal = AbortSignal.timeout(this.opts.timeoutMs ?? 10000);
    const provider = this.opts.tokenProvider;
    const doFetch = async (): Promise<Response> => {
      const headers: Record<string, string> = {};
      if (provider) headers["Authorization"] = "Bearer " + (await provider.getToken());
      return fetchImpl(url, { headers, signal });
    };
    let res = await doFetch();
    if (res.status === 401 && provider) {
      // Token rejected (expired/revoked) — force a refresh and retry once.
      provider.invalidate();
      res = await doFetch();
    }
    return res;
  }

  // Success-path body parse + normalize (+ icon). null = malformed body.
  private async readStates(res: Response, now: number): Promise<Craft[] | null> {
    let body: { states?: unknown };
    try {
      body = (await res.json()) as { states?: unknown };
    } catch {
      return null;
    }
    if (!Array.isArray(body.states)) return null;
    const rows = body.states as (string | number | boolean | null)[][];
    const crafts: Craft[] = [];
    for (const row of rows) {
      const c = normalizeOpenSky(row, now);
      if (c) {
        const icon = this.opts.resolveIcon?.(c);
        if (icon) c.icon = icon;
        crafts.push(c);
      }
    }
    return crafts;
  }

  async pollOnce(): Promise<PollResult> {
    const now = this.now();
    const url = this.opts.url ?? "https://opensky-network.org/api/states/all";
    let res: Response;
    try {
      res = await this.fetchStates(url);
    } catch (e) {
      const nextDelayMs = this.backoffDelay();
      const msg = e instanceof Error ? e.message : String(e);
      this.lastError = msg;
      this.opts.log?.(`opensky: ${msg} — backing off ${nextDelayMs}ms`);
      return { upserted: 0, nextDelayMs };
    }
    const remaining = res.headers.get("x-rate-limit-remaining");
    if (remaining !== null && remaining !== "" && Number.isFinite(Number(remaining))) {
      this.statesRemaining = Number(remaining);
    }
    // Globe responses are the boost's funding refresh; make sure a tick is
    // pending (the zone timer's own chain normally already covers it).
    if (this.zonesCfg && !this.zoneTimer) {
      this.armZoneTimer(this.zoneNextAt === null ? 0 : Math.max(0, this.zoneNextAt - now));
    }
    if (res.status === 429) {
      this.consecutiveErrors += 1;
      // OpenSky documents X-Rate-Limit-Retry-After-Seconds on 429s; prefer the
      // standard header when both are present.
      const retryAfterRaw =
        res.headers.get("retry-after") ?? res.headers.get("x-rate-limit-retry-after-seconds");
      const nextDelayMs =
        retryAfterRaw !== null && Number.isFinite(Number(retryAfterRaw))
          ? Math.min(BACKOFF_CAP_MS, Math.max(this.opts.pollMs, Number(retryAfterRaw) * 1000))
          : Math.min(BACKOFF_CAP_MS, this.opts.pollMs * 2 ** this.consecutiveErrors);
      this.lastError = "HTTP 429";
      this.opts.log?.(`opensky: 429 — backing off ${nextDelayMs}ms`);
      return { upserted: 0, nextDelayMs };
    }
    if (!res.ok) {
      const nextDelayMs = this.backoffDelay();
      this.lastError = `HTTP ${res.status}`;
      this.opts.log?.(`opensky: HTTP ${res.status} — backing off ${nextDelayMs}ms`);
      return { upserted: 0, nextDelayMs };
    }
    const crafts = await this.readStates(res, now);
    if (crafts === null) {
      this.lastError = "malformed body";
      this.opts.log?.("opensky: malformed body — skipping poll");
      return { upserted: 0, nextDelayMs: this.opts.pollMs };
    }
    const present = new Set(crafts.map((c) => c.id));
    this.opts.store.upsert(crafts, now);
    this.opts.store.pruneAir(present, now, this.opts.graceMs);
    this.consecutiveErrors = 0;
    this.lastOkAt = now;
    this.lastError = null;
    return { upserted: crafts.length, nextDelayMs: this.opts.pollMs };
  }

  // One guarded boost attempt. THE RULE: this path must NEVER call
  // store.pruneAir — the zone response is a partial present-set.
  // nextDelayMs is the suggested time until the next attempt.
  async pollZoneOnce(): Promise<PollResult> {
    const cfg = this.zonesCfg;
    if (!cfg) return { upserted: 0, nextDelayMs: this.opts.pollMs };
    const now = this.now();
    const members: ZoneMember[] = [];
    for (const c of this.opts.store.all()) {
      if (c.domain !== "air") continue;
      const kind = c.kind as AirKind;
      if (!cfg.kinds.includes(kind)) continue;
      members.push({ id: c.id, kind, lat: c.lat, lon: c.lon });
    }
    const step = planZone(members, now, this.zoneState);
    this.zoneState = step.state;
    if (!step.zone) {
      this.boostIntervalMs = null;
      this.boostPaused = null;
      return { upserted: 0, nextDelayMs: cfg.boostMs };
    }
    const surplus = surplusCredits(this.statesRemaining, now, this.opts.pollMs, GLOBE_CALL_COST);
    const interval = zoneIntervalFor(cfg.boostMs, surplus, now);
    if (interval === null) {
      this.boostPaused = "credits";
      this.boostIntervalMs = null;
      return { upserted: 0, nextDelayMs: this.opts.pollMs };
    }
    if (now < this.boostPausedUntil) {
      this.boostPaused = "credits";
      this.boostIntervalMs = null;
      return { upserted: 0, nextDelayMs: this.boostPausedUntil - now };
    }
    this.boostPausedUntil = 0;
    this.boostPaused = null;
    this.boostIntervalMs = interval;
    if (this.zoneNextAt !== null && now < this.zoneNextAt) {
      return { upserted: 0, nextDelayMs: this.zoneNextAt - now };
    }
    this.zoneNextAt = now + interval;
    const base = this.opts.url ?? "https://opensky-network.org/api/states/all";
    let res: Response;
    try {
      res = await this.fetchStates(zoneBboxUrl(base, step.zone));
    } catch (e) {
      this.opts.log?.(`opensky: zone poll: ${e instanceof Error ? e.message : String(e)}`);
      return { upserted: 0, nextDelayMs: interval };
    }
    if (res.status === 429) {
      // Own pause; the globe backoff state (consecutiveErrors, lastError,
      // lastOkAt) is untouched — zone and globe rate-limits are independent.
      this.zoneErrors += 1;
      const retryAfterRaw =
        res.headers.get("retry-after") ?? res.headers.get("x-rate-limit-retry-after-seconds");
      const pauseMs =
        retryAfterRaw !== null && Number.isFinite(Number(retryAfterRaw))
          ? Math.min(BACKOFF_CAP_MS, Math.max(this.opts.pollMs, Number(retryAfterRaw) * 1000))
          : Math.min(BACKOFF_CAP_MS, this.opts.pollMs * 2 ** this.zoneErrors);
      this.boostPausedUntil = now + pauseMs;
      this.boostPaused = "credits";
      this.boostIntervalMs = null;
      this.opts.log?.(`opensky: zone 429 — boost paused ${pauseMs}ms`);
      return { upserted: 0, nextDelayMs: pauseMs };
    }
    if (!res.ok) {
      this.opts.log?.(`opensky: zone HTTP ${res.status}`);
      return { upserted: 0, nextDelayMs: interval };
    }
    const crafts = await this.readStates(res, now);
    if (crafts === null) {
      this.opts.log?.("opensky: zone malformed body — skipping tick");
      return { upserted: 0, nextDelayMs: interval };
    }
    // Upsert only — a zone poll says nothing about craft outside the box.
    this.opts.store.upsert(crafts, now);
    this.zoneErrors = 0;
    return { upserted: crafts.length, nextDelayMs: interval };
  }

  private now(): number {
    return this.opts.now?.() ?? Date.now();
  }

  private clearZoneTimer(): void {
    if (this.zoneTimer) clearTimeout(this.zoneTimer);
    this.zoneTimer = null;
  }

  private armZoneTimer(delayMs: number): void {
    this.clearZoneTimer();
    if (!this.zonesCfg) return;
    this.zoneTimer = setTimeout(() => {
      this.zoneTimer = null;
      void this.zoneTick();
    }, Math.max(0, delayMs));
    this.zoneTimer.unref(); // the zone chain must never hold the process open
  }

  private async zoneTick(): Promise<void> {
    if (!this.running) return;
    let nextDelayMs = this.opts.pollMs;
    try {
      nextDelayMs = (await this.pollZoneOnce()).nextDelayMs;
    } catch (e) {
      this.opts.log?.(`opensky: zone tick: ${e instanceof Error ? e.message : String(e)}`);
    }
    this.armZoneTimer(nextDelayMs);
  }
}

function zoneBboxUrl(base: string, zone: HotZone): string {
  const u = new URL(base);
  u.searchParams.set("lamin", String(zone.center.lat - zone.halfH));
  u.searchParams.set("lomin", String(zone.center.lon - zone.halfW));
  u.searchParams.set("lamax", String(zone.center.lat + zone.halfH));
  u.searchParams.set("lomax", String(zone.center.lon + zone.halfW));
  return u.toString();
}
