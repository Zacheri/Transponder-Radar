import type { CraftStore } from "./store.js";
import { normalizeOpenSky } from "./normalize.js";
import type { Craft, AirKind } from "../shared/craft.js";
import type { TokenProvider } from "./opensky-auth.js";
import type { TrafficCounter } from "./traffic.js";
import type { HotZone, ZoneMember, ZonesState } from "./hotzones.js";
import { planZones, surplusCredits, zoneIntervalFor } from "./hotzones.js";

// Per-slot poll bookkeeping (index-aligned with ZonesState.slots); a slot
// whose box vanishes has its runtime reset.
interface ZoneRun {
  nextAt: number | null;
  pausedUntil: number; // per-zone 429 pause (THE RULE: pause the zone, not boost)
  errors: number;
}
const freshRun = (): ZoneRun => ({ nextAt: null, pausedUntil: 0, errors: 0 });

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
  traffic?: TrafficCounter;
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
  count: number; // craft across all zones
  intervalMs: number | null;
  paused: "credits" | null; // aggregate: any zone credit-blocked or 429-paused
  zones: number; // live zone count (<= MAX_ZONES)
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
  private zoneState: ZonesState | null = null;
  private zoneTimer: NodeJS.Timeout | null = null;
  // Boost enablement, independent of timer identity — must stay true through
  // the in-flight window of a zone tick (the timer is nulled during it).
  private zoneActive = false;
  // Index-aligned with zoneState.slots: per-zone due time, 429 pause and
  // error streak (a zone 429 pauses only its own slot).
  private zoneRuns: ZoneRun[] = [freshRun(), freshRun()];
  private boostPaused: "credits" | null = null;
  private boostIntervalMs: number | null = null;

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
          count: (this.zoneState?.slots ?? []).reduce((n, s) => n + (s.box?.count ?? 0), 0),
          intervalMs: this.boostPaused ? null : this.boostIntervalMs,
          paused: this.boostPaused,
          zones: this.zoneState?.slots.filter((s) => s.box !== null).length ?? 0,
        }
      : null;
    return { lastOkAt: this.lastOkAt, lastError: this.lastError, pollMs: this.opts.pollMs, boost };
  }

  // Broadcast-geometry copies of the live hot zones (design R4): slot-stable
  // order (densest first as formed, wave-10 ruling), length <= MAX_ZONES.
  get zonesStatus(): HotZone[] {
    return (this.zoneState?.slots ?? []).flatMap((s) => (s.box ? [s.box] : []));
  }

  // Full-replace semantics; null disables and clears the zone + timer.
  // boostMs is clamped here (the hub validator only checks finiteness).
  setZonesConfig(cfg: ZonesConfig | null): void {
    if (!cfg) {
      this.zonesCfg = null;
      this.zoneState = null;
      this.zoneActive = false;
      this.zoneRuns = [freshRun(), freshRun()];
      this.boostPaused = null;
      this.boostIntervalMs = null;
      this.clearZoneTimer();
      return;
    }
    if (!Number.isFinite(cfg.boostMs)) return; // defensive: hub drops these frames
    const boostMs = Math.min(ZONE_BOOST_MAX_MS, Math.max(ZONE_BOOST_MIN_MS, Math.round(cfg.boostMs)));
    this.zonesCfg = { kinds: [...cfg.kinds], boostMs };
    this.zoneState = null; // new kind set -> the old zones are void
    this.zoneActive = true;
    this.zoneRuns = [freshRun(), freshRun()]; // re-enable must not inherit stale due-times
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
      // text+parse (not res.json()) so the raw bytes can be counted; a
      // malformed body throws here exactly as res.json() did.
      const text = await res.text();
      this.opts.traffic?.count("in", Buffer.byteLength(text));
      body = JSON.parse(text) as { states?: unknown };
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
      this.armZoneTimer(this.zoneWaitMs(now));
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

  // One guarded boost attempt covering every live zone. THE RULE: this path
  // must NEVER call store.pruneAir — a zone response is a partial present-set.
  // Funding: surplus (globe reserve already off the top) is a per-tick budget
  // that each DUE zone spends 1 credit from, densest slot first; a due zone
  // with no credit left stays unpolluted, and a zone 429 pauses only its own
  // slot. nextDelayMs is the suggested time until the next attempt.
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
    const step = planZones(members, now, this.zoneState);
    this.zoneState = step.state;

    // Funding re-read once per tick (the header/slider only move between
    // ticks): each due zone spends 1 credit off the surplus, slot 0 first.
    const surplus = surplusCredits(this.statesRemaining, now, this.opts.pollMs, GLOBE_CALL_COST);
    const interval = zoneIntervalFor(cfg.boostMs, surplus, now);
    const slots = step.state.slots;
    if (!slots.some((s) => s.box !== null)) {
      this.boostIntervalMs = null;
      this.boostPaused = null;
      return { upserted: 0, nextDelayMs: cfg.boostMs };
    }
    // Pause-first (old single-zone posture): no surplus at all means paused
    // even while every zone is between due times.
    if (interval === null) {
      this.boostIntervalMs = null;
      this.boostPaused = "credits";
      return { upserted: 0, nextDelayMs: this.opts.pollMs };
    }
    this.boostIntervalMs = interval;
    let available = surplus;
    let upserted = 0;
    let paused = false;
    let unfundedDue = false;
    let nextDelayMs = Number.POSITIVE_INFINITY;
    const base = this.opts.url ?? "https://opensky-network.org/api/states/all";
    while (this.zoneRuns.length < slots.length) this.zoneRuns.push(freshRun());
    for (let i = 0; i < slots.length; i++) {
      const zone = slots[i].box;
      if (!zone) {
        this.zoneRuns[i] = freshRun();
        continue;
      }
      const run = this.zoneRuns[i];
      if (now < run.pausedUntil) {
        paused = true;
        nextDelayMs = Math.min(nextDelayMs, run.pausedUntil - now);
        continue;
      }
      if (run.nextAt !== null && now < run.nextAt) {
        nextDelayMs = Math.min(nextDelayMs, run.nextAt - now);
        continue;
      }
      if (available < 1) {
        // THE RULE: no credit left after the globe reserve and zone 1's due
        // poll — this zone simply does not poll this tick.
        paused = true;
        unfundedDue = true;
        continue;
      }
      available -= 1;
      run.nextAt = now + interval;
      let res: Response;
      try {
        res = await this.fetchStates(zoneBboxUrl(base, zone));
      } catch (e) {
        this.opts.log?.(`opensky: zone poll: ${e instanceof Error ? e.message : String(e)}`);
        nextDelayMs = Math.min(nextDelayMs, interval);
        continue;
      }
      if (res.status === 429) {
        // Own pause; the globe backoff state (consecutiveErrors, lastError,
        // lastOkAt) and the OTHER zones' runs are untouched — zone and globe
        // rate-limits are independent.
        run.errors += 1;
        const retryAfterRaw =
          res.headers.get("retry-after") ?? res.headers.get("x-rate-limit-retry-after-seconds");
        const pauseMs =
          retryAfterRaw !== null && Number.isFinite(Number(retryAfterRaw))
            ? Math.min(BACKOFF_CAP_MS, Math.max(this.opts.pollMs, Number(retryAfterRaw) * 1000))
            : Math.min(BACKOFF_CAP_MS, this.opts.pollMs * 2 ** run.errors);
        run.pausedUntil = now + pauseMs;
        paused = true;
        this.opts.log?.(`opensky: zone ${i + 1} 429 — boost paused ${pauseMs}ms`);
        nextDelayMs = Math.min(nextDelayMs, pauseMs);
        continue;
      }
      if (!res.ok) {
        this.opts.log?.(`opensky: zone HTTP ${res.status}`);
        nextDelayMs = Math.min(nextDelayMs, interval);
        continue;
      }
      const crafts = await this.readStates(res, now);
      if (crafts === null) {
        this.opts.log?.("opensky: zone malformed body — skipping tick");
        nextDelayMs = Math.min(nextDelayMs, interval);
        continue;
      }
      // Upsert only — a zone poll says nothing about craft outside the box.
      this.opts.store.upsert(crafts, now);
      run.errors = 0;
      upserted += crafts.length;
      nextDelayMs = Math.min(nextDelayMs, interval);
    }
    // Aggregate pause: any zone credit-blocked while due, or 429-paused.
    this.boostPaused = paused ? "credits" : null;
    if (this.boostPaused) this.boostIntervalMs = null;
    if (nextDelayMs === Number.POSITIVE_INFINITY) nextDelayMs = cfg.boostMs;
    if (unfundedDue) nextDelayMs = Math.min(nextDelayMs, this.opts.pollMs);
    return { upserted, nextDelayMs };
  }

  // Earliest time (ms from now) a live zone wants to be seen again: its due
  // time or the end of its 429 pause; 0 when due now or nothing is live.
  private zoneWaitMs(nowMs: number): number {
    let wait = Number.POSITIVE_INFINITY;
    for (let i = 0; i < (this.zoneState?.slots.length ?? 0); i++) {
      if (!this.zoneState?.slots[i].box) continue;
      const run = this.zoneRuns[i];
      const due = Math.max(run.nextAt ?? 0, run.pausedUntil);
      wait = Math.min(wait, Math.max(0, due - nowMs));
    }
    return wait === Number.POSITIVE_INFINITY ? 0 : wait;
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
