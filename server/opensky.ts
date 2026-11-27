import { AIR_KINDS } from "../shared/craft.js";
import type { CraftStore } from "./store.js";
import { normalizeOpenSky } from "./normalize.js";
import type { Craft, AirKind } from "../shared/craft.js";
import type { TokenProvider } from "./opensky-auth.js";
import type { TrafficCounter } from "./traffic.js";
import type { HotZone, PolledZone, PollSection, SectionBox, ZoneMember, ZonesState, ZoneBox } from "./hotzones.js";
import { buildPollPlan, planZones, surplusCredits, zoneIntervalFor } from "./hotzones.js";

// Per-zone poll bookkeeping; auto zones live in slot-indexed zoneRuns,
// sections in a Map keyed by section id. A zone whose box vanishes (auto) or
// whose id is removed from the config (section) has its runtime reset.
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
const BOOST_DEFAULT_MS = 30000;
const MAX_SECTIONS = 6;
const AUTO_ID_PREFIX = "auto:";

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

// --- zones.config v2 (design 2026-11-27 §C/§D) ------------------------------

// Wire shapes as the hub forwards them (the hub checks SHAPE only; values are
// clamped/dropped here). A v1 frame omits auto/sections -> the defaults below
// reproduce wave-10 behavior exactly.
export interface ZonesAutoInput {
  enabled?: boolean;
  createMin?: number;
  standdownAt?: number;
}

export interface PollSectionWire {
  id: string;
  kinds: AirKind[];
  boostMs: number;
  b: SectionBox;
}

export interface ZonesConfigInput {
  kinds: AirKind[];
  boostMs: number;
  auto?: ZonesAutoInput | null;
  sections?: PollSectionWire[] | null;
}

// Normalized config held by the poller. autoEnabled is cfg.auto.enabled;
// standdownAt gates auto against sections.length (boost-ENABLED wire sections
// — the wire only ever carries enabled boosts, plain highlights never arrive).
export interface ZonesConfig {
  kinds: AirKind[];
  boostMs: number;
  auto: { enabled: boolean; createMin: number; standdownAt: 0 | 1 | 2 };
  sections: PollSection[];
}

// Broadcast entry for status.hotzones (design §D): geometry + live count,
// plus the v2 identity fields. `id` always; sections add manual/active and
// ship ONLY while active (the plan only contains active sections). Auto
// entries keep the legacy shape plus their "auto:<slot>" id.
export interface ZoneStatusWire {
  center: { lat: number; lon: number };
  halfW: number;
  halfH: number;
  count: number;
  kind: AirKind;
  id: string;
  manual?: boolean;
  active?: boolean;
}

export interface BoostStatus {
  active: boolean; // any configured boost (sections present or auto enabled)
  count: number; // craft across live polled zones (plan: auto + active sections)
  intervalMs: number | null; // auto cadence (stretched); null with no auto zones
  paused: "credits" | "standdown" | null;
  zones: number; // live auto zone count (<= MAX_ZONES)
  sectionsActive: number; // active (polling) sections
  sectionsIdle: number; // configured sections currently failing the activation gate
  creditsToday: number; // zone credits spent this UTC day (memory-only; a
  // restart resets it — best-effort surface, never a ledger)
}

const clampBoostMs = (ms: number): number =>
  !Number.isFinite(ms)
    ? BOOST_DEFAULT_MS
    : Math.min(ZONE_BOOST_MAX_MS, Math.max(ZONE_BOOST_MIN_MS, Math.round(ms)));

const clampCreateMin = (n: number | undefined): number =>
  !Number.isFinite(n) ? 2 : Math.min(10, Math.max(2, Math.round(n as number)));

function normalizeAuto(a: ZonesAutoInput | null | undefined): ZonesConfig["auto"] {
  return {
    enabled: a?.enabled ?? true,
    createMin: clampCreateMin(a?.createMin),
    standdownAt: a?.standdownAt === 1 ? 1 : a?.standdownAt === 2 ? 2 : 0,
  };
}

const boxPairOk = (p: unknown): boolean =>
  Array.isArray(p) && p.length === 2 && p.every((v) => typeof v === "number" && Number.isFinite(v));

// One wire section -> PollSection, or null to drop it (bad id, kind outside
// AIR_KINDS, or an out-of-range/inverted box). Dedup by id happens in the
// caller (later duplicates dropped). Wire sections are always enabled; AIS
// kinds never arrive (the client filters — push feed, nothing to poll).
function normalizeSection(w: PollSectionWire | null | undefined): PollSection | null {
  if (!w || typeof w.id !== "string" || w.id.length === 0) return null;
  if (!Array.isArray(w.kinds) || w.kinds.some((k) => !(AIR_KINDS as readonly string[]).includes(k)))
    return null;
  const b = w.b;
  if (!Array.isArray(b) || b.length !== 2 || !boxPairOk(b[0]) || !boxPairOk(b[1])) return null;
  const [[minLat, minLon], [maxLat, maxLon]] = b;
  if (Math.abs(minLat) > 90 || Math.abs(maxLat) > 90 || Math.abs(minLon) > 180 || Math.abs(maxLon) > 180)
    return null;
  if (!(minLat < maxLat) || !(minLon < maxLon)) return null;
  return {
    id: w.id,
    kinds: [...w.kinds],
    boostMs: clampBoostMs(w.boostMs),
    b: [[minLat, minLon], [maxLat, maxLon]],
    enabled: true,
  };
}

const sameKindSet = (a: AirKind[], b: AirKind[]): boolean => {
  const sa = new Set(a);
  const sb = new Set(b);
  if (sa.size !== sb.size) return false;
  for (const k of sa) if (!sb.has(k)) return false;
  return true;
};

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
  // Per-section runs keyed by section id, reconciled against the config on
  // every setZonesConfig (a 429 pause survives unrelated edits).
  private sectionRuns = new Map<string, ZoneRun>();
  // Last buildPollPlan output; drives the boost/hotzones status surfaces and
  // is replaced every zone tick (null between a config change and the tick).
  private lastPlan: PolledZone[] | null = null;
  private boostPaused: "credits" | "standdown" | null = null;
  private boostIntervalMs: number | null = null;
  // Zone credits spent this UTC day (memory-only — restart resets to 0;
  // documented best-effort, spec §G). Roll-checked at every zone tick.
  private zoneCreditsToday = 0;
  private zoneCreditsDay: number | null = null;

  constructor(private opts: OpenSkyPollerOpts) {}

  get feedStatus(): {
    lastOkAt: number | null;
    lastError: string | null;
    pollMs: number;
    boost: BoostStatus | null;
  } {
    const cfg = this.zonesCfg;
    const plan = this.lastPlan ?? [];
    const sectionsActive = plan.reduce((n, z) => n + (z.source === "section" ? 1 : 0), 0);
    const boost = cfg
      ? {
          active: this.zoneActive,
          count: plan.reduce((n, z) => n + z.count, 0),
          intervalMs: this.boostPaused ? null : this.boostIntervalMs,
          paused: this.boostPaused,
          zones: plan.reduce((n, z) => n + (z.source === "auto" ? 1 : 0), 0),
          sectionsActive,
          sectionsIdle: cfg.sections.length - sectionsActive,
          creditsToday: this.zoneCreditsToday,
        }
      : null;
    return { lastOkAt: this.lastOkAt, lastError: this.lastError, pollMs: this.opts.pollMs, boost };
  }

  // Entries "being polled right now" (design §D): the last plan — active
  // sections (manual, id, brighter-render hint) first in id order, then live
  // auto zones in slot order. Cleared between a config change and the next
  // zone tick, so a config swap voids the wire immediately.
  get zonesStatus(): ZoneStatusWire[] {
    return (this.lastPlan ?? []).map((z) =>
      z.source === "section"
        ? {
            center: z.box.center,
            halfW: z.box.halfW,
            halfH: z.box.halfH,
            count: z.count,
            kind: z.kind,
            id: z.id,
            manual: true,
            active: true,
          }
        : {
            center: z.box.center,
            halfW: z.box.halfW,
            halfH: z.box.halfH,
            count: z.count,
            kind: z.kind,
            id: z.id,
          },
    );
  }

  // Full-replace semantics; null disables and clears everything. Server-side
  // validation/clamping lives here (the hub only checks frame shape):
  // createMin clamp [2,10], standdownAt ∈ {0,1,2} else 0, boostMs clamp, and
  // per-section drops (id/kinds/box garbage drops that SECTION; >6 truncates;
  // later duplicate ids dropped).
  //
  // Scoped sledgehammer: a kinds/boostMs/auto change voids the auto zone
  // state + runs (old behavior), but NEVER touches section runs; a
  // sections-only change reconciles the runs Map by id (surviving ids keep
  // their run incl. a 429 pause, removed ids drop, new ids are fresh) and
  // NEVER touches auto state.
  setZonesConfig(cfg: ZonesConfigInput | null): void {
    if (!cfg) {
      this.zonesCfg = null;
      this.zoneState = null;
      this.zoneActive = false;
      this.zoneRuns = [freshRun(), freshRun()];
      this.sectionRuns.clear();
      this.lastPlan = null;
      this.boostPaused = null;
      this.boostIntervalMs = null;
      this.clearZoneTimer();
      return;
    }
    if (!Number.isFinite(cfg.boostMs)) return; // defensive: hub drops these frames
    const boostMs = Math.min(ZONE_BOOST_MAX_MS, Math.max(ZONE_BOOST_MIN_MS, Math.round(cfg.boostMs)));
    const kinds = [...cfg.kinds];
    const auto = normalizeAuto(cfg.auto);
    const sections: PollSection[] = [];
    const seenIds = new Set<string>();
    for (const w of Array.isArray(cfg.sections) ? cfg.sections.slice(0, MAX_SECTIONS) : []) {
      if (w && typeof w.id === "string" && w.id.length > 0) {
        if (seenIds.has(w.id)) continue; // later duplicate dropped
        seenIds.add(w.id);
      }
      const s = normalizeSection(w);
      if (s) sections.push(s);
    }

    // Reconcile section runs BEFORE anything else (wave-10 ordering rule):
    // a removed id must be dropped even on paths that return early.
    const keptRuns = new Map<string, ZoneRun>();
    for (const s of sections) {
      const r = this.sectionRuns.get(s.id);
      if (r) keptRuns.set(s.id, r);
    }
    this.sectionRuns = keptRuns;

    const prev = this.zonesCfg;
    if (!prev) {
      this.zonesCfg = { kinds, boostMs, auto, sections };
      this.zoneState = null; // fresh enablement: no zones yet
      this.zoneActive = auto.enabled || sections.length > 0;
      this.zoneRuns = [freshRun(), freshRun()]; // re-enable must not inherit stale due-times
      this.boostPaused = null;
      this.boostIntervalMs = null;
      this.lastPlan = null;
      this.armZoneTimer(boostMs); // enabling starts the zone timer machinery
      return;
    }
    const autoRelevant =
      boostMs !== prev.boostMs ||
      !sameKindSet(prev.kinds, kinds) ||
      auto.enabled !== prev.auto.enabled ||
      auto.createMin !== prev.auto.createMin ||
      auto.standdownAt !== prev.auto.standdownAt;
    if (autoRelevant) {
      // Auto state is void (kind set/rate/engine changed); section runs
      // survive (already reconciled above).
      this.zoneState = null;
      this.zoneRuns = [freshRun(), freshRun()];
      this.boostPaused = null;
      this.boostIntervalMs = null;
    }
    this.zonesCfg = { kinds, boostMs, auto, sections };
    this.zoneActive = auto.enabled || sections.length > 0;
    this.lastPlan = null; // the wire reflects the new config from the next tick
    this.armZoneTimer(boostMs);
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
    const cfg = this.zonesCfg;
    this.zoneActive = cfg !== null && (cfg.auto.enabled || cfg.sections.length > 0);
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

  // One guarded boost attempt driving the whole plan (design §C): active
  // sections first (id order), then auto zones (slot order). Funding is
  // cost-aware — every zone costs its area tier off the per-tick surplus; a
  // due zone with budget < cost is SKIPPED (timer untouched, resumes when
  // budget returns), never paused. A zone 429 pauses only that zone and
  // spends nothing (429 = no credit billed: budget refunded, nothing charged
  // to creditsToday). Success charges the zone's COST to creditsToday.
  // THE RULE: this path must NEVER call store.pruneAir — a zone response is
  // a partial present-set.
  async pollZoneOnce(): Promise<PollResult> {
    const cfg = this.zonesCfg;
    if (!cfg) return { upserted: 0, nextDelayMs: this.opts.pollMs };
    const now = this.now();
    this.rollCreditsDay(now);

    const members: ZoneMember[] = []; // cfg.kinds = the auto tracker's selectors
    const allMembers: ZoneMember[] = []; // sections match their own kinds
    for (const c of this.opts.store.all()) {
      if (c.domain !== "air") continue;
      const kind = c.kind as AirKind;
      allMembers.push({ id: c.id, kind, lat: c.lat, lon: c.lon });
      if (cfg.kinds.includes(kind)) members.push({ id: c.id, kind, lat: c.lat, lon: c.lon });
    }

    // The auto engine runs only while auto is enabled; disabled clears the
    // zone state (nothing is polled, so nothing broadcasts).
    if (cfg.auto.enabled) {
      this.zoneState = planZones(members, now, this.zoneState, { createMin: cfg.auto.createMin }).state;
    } else {
      this.zoneState = null;
    }
    const slots = this.zoneState?.slots ?? [];
    // SPARSE array: holes keep slot indices, so a plan auto id "auto:<n>"
    // indexes zoneRuns directly (forEach skips holes).
    const autoZones: HotZone[] = [];
    slots.forEach((s, i) => {
      if (s.box) autoZones[i] = s.box;
    });
    // Empty-slot run reset happens BEFORE any early return: a 429 on
    // a held copy (members already gone) can outlive that copy's expiry, and
    // the next zone forming in the slot must not inherit the stale pause.
    while (this.zoneRuns.length < slots.length) this.zoneRuns.push(freshRun());
    for (let i = 0; i < slots.length; i++) {
      if (!slots[i].box) this.zoneRuns[i] = freshRun();
    }

    const plan = buildPollPlan({
      autoZones,
      sections: cfg.sections,
      members: allMembers,
      autoEnabled: cfg.auto.enabled,
      boostedSectionCount: cfg.sections.length,
      standdownAt: cfg.auto.standdownAt,
    });
    this.lastPlan = plan;
    const sectionsActive = plan.reduce((n, z) => n + (z.source === "section" ? 1 : 0), 0);
    const hasAuto = plan.some((z) => z.source === "auto");
    // Stand-down gate suppressed the auto leg (mirrors buildPollPlan's rule):
    // with active sections this surfaces as paused "standdown" below.
    const standdownSuppressed =
      cfg.auto.enabled && cfg.auto.standdownAt > 0 && cfg.sections.length >= cfg.auto.standdownAt;

    if (plan.length === 0) {
      this.boostIntervalMs = null;
      this.boostPaused = null;
      return { upserted: 0, nextDelayMs: cfg.boostMs };
    }

    // Funding re-read once per tick (the header/slider only move between
    // ticks): the surplus is the whole budget; zones spend their area cost
    // from it in plan order.
    const surplus = surplusCredits(this.statesRemaining, now, this.opts.pollMs, GLOBE_CALL_COST);
    // The stretch applies ONLY to auto zones (the self-budgeting citizens).
    // A null stretched cadence pauses the AUTO leg pause-first (wave-7
    // posture, even between due times) but never blocks section funding —
    // those poll at the user's rate or get budget-skipped.
    const autoInterval = hasAuto ? zoneIntervalFor(cfg.boostMs, surplus, now) : null;
    this.boostIntervalMs = autoInterval;
    let available = surplus;
    let upserted = 0;
    let zonePaused = false; // any zone (either kind) inside its 429 window
    let autoBlocked = false; // auto leg cannot fund this tick (pause-first) —
    // an auto zone stayed due with no credit left
    let nextDelayMs = Number.POSITIVE_INFINITY;
    const base = this.opts.url ?? "https://opensky-network.org/api/states/all";
    for (const z of plan) {
      const run = this.runFor(z);
      if (now < run.pausedUntil) {
        zonePaused = true;
        nextDelayMs = Math.min(nextDelayMs, run.pausedUntil - now);
        continue;
      }
      if (z.source === "auto" && autoInterval === null) {
        autoBlocked = true;
        nextDelayMs = Math.min(nextDelayMs, this.opts.pollMs);
        continue;
      }
      const interval = z.source === "auto" ? (autoInterval as number) : z.intervalMs ?? cfg.boostMs;
      if (run.nextAt !== null && now < run.nextAt) {
        nextDelayMs = Math.min(nextDelayMs, run.nextAt - now);
        continue;
      }
      if (available < z.cost) {
        // Budget skip: the zone stays due (timer untouched) and simply does
        // not poll this tick. Only the auto leg's skip is a "credits" pause;
        // a skipped section reads as idle (the HUD never claims a pause).
        if (z.source === "auto") autoBlocked = true;
        nextDelayMs = Math.min(nextDelayMs, this.opts.pollMs);
        continue;
      }
      available -= z.cost;
      run.nextAt = now + interval;
      let res: Response;
      try {
        res = await this.fetchStates(zoneBboxUrl(base, z.box));
      } catch (e) {
        this.opts.log?.(`opensky: zone poll: ${e instanceof Error ? e.message : String(e)}`);
        nextDelayMs = Math.min(nextDelayMs, interval);
        continue;
      }
      if (res.status === 429) {
        // Own pause; the globe backoff state (consecutiveErrors, lastError,
        // lastOkAt) and the OTHER zones' runs are untouched — zone and globe
        // rate-limits are independent. The 429 bills no OpenSky credit, so
        // the tick budget is refunded and creditsToday stays untouched.
        run.errors += 1;
        const retryAfterRaw =
          res.headers.get("retry-after") ?? res.headers.get("x-rate-limit-retry-after-seconds");
        const pauseMs =
          retryAfterRaw !== null && Number.isFinite(Number(retryAfterRaw))
            ? Math.min(BACKOFF_CAP_MS, Math.max(this.opts.pollMs, Number(retryAfterRaw) * 1000))
            : Math.min(BACKOFF_CAP_MS, this.opts.pollMs * 2 ** run.errors);
        run.pausedUntil = now + pauseMs;
        available += z.cost;
        zonePaused = true;
        this.opts.log?.(`opensky: zone ${z.id} 429 — boost paused ${pauseMs}ms`);
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
      this.zoneCreditsToday += z.cost;
      upserted += crafts.length;
      nextDelayMs = Math.min(nextDelayMs, interval);
    }
    // Aggregate pause: any zone 429-windowed, or the auto leg credit-blocked.
    // A stand-down-suppressed auto leg with active sections reads "standdown".
    this.boostPaused =
      zonePaused || autoBlocked
        ? "credits"
        : standdownSuppressed && sectionsActive > 0
          ? "standdown"
          : null;
    if (this.boostPaused) this.boostIntervalMs = null;
    if (nextDelayMs === Number.POSITIVE_INFINITY) nextDelayMs = cfg.boostMs;
    return { upserted, nextDelayMs };
  }

  // The run behind a plan entry: auto ids "auto:<slot>" index zoneRuns;
  // section ids index the Map (lazily created for defensive direct calls —
  // setZonesConfig pre-creates every configured section's run).
  private runFor(z: PolledZone): ZoneRun {
    if (z.source === "section") {
      let r = this.sectionRuns.get(z.id);
      if (!r) {
        r = freshRun();
        this.sectionRuns.set(z.id, r);
      }
      return r;
    }
    const slot = Number(z.id.slice(AUTO_ID_PREFIX.length));
    let r = this.zoneRuns[slot];
    if (!r) {
      r = freshRun();
      this.zoneRuns[slot] = r;
    }
    return r;
  }

  // Earliest time (ms from now) a planned zone wants to be seen again: its
  // due time or the end of its 429 pause; 0 when due now or nothing is live.
  // Idle (unplanned) sections are excluded — their stale timers must not
  // drive the tick cadence.
  private zoneWaitMs(nowMs: number): number {
    let wait = Number.POSITIVE_INFINITY;
    for (const z of this.lastPlan ?? []) {
      const run = this.runFor(z);
      const due = Math.max(run.nextAt ?? 0, run.pausedUntil);
      wait = Math.min(wait, Math.max(0, due - nowMs));
    }
    return wait === Number.POSITIVE_INFINITY ? 0 : wait;
  }

  // UTC-day roll for the creditsToday counter (epoch ms / 86400000 is the UTC
  // day number; UTC getters not needed — the epoch itself is UTC).
  private rollCreditsDay(nowMs: number): void {
    const day = Math.floor(nowMs / 86_400_000);
    if (day !== this.zoneCreditsDay) {
      this.zoneCreditsDay = day;
      this.zoneCreditsToday = 0;
    }
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

function zoneBboxUrl(base: string, box: ZoneBox): string {
  const u = new URL(base);
  u.searchParams.set("lamin", String(box.center.lat - box.halfH));
  u.searchParams.set("lomin", String(box.center.lon - box.halfW));
  u.searchParams.set("lamax", String(box.center.lat + box.halfH));
  u.searchParams.set("lomax", String(box.center.lon + box.halfW));
  return u.toString();
}
