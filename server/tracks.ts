import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { HistoryRecorder } from "./history.js";
import type { TokenProvider } from "./opensky-auth.js";
import type { TrafficCounter } from "./traffic.js";

export interface TrackPoint {
  t: number; // epoch ms (server clock)
  lat: number;
  lon: number;
  alt: number | null;
  onGround: boolean;
}

export interface TrackReply {
  path: TrackPoint[];
  fetchedAt: number;
  source: "both" | "history" | "opensky" | "none";
  budget: { autoLeft: number; hard: boolean };
}

export interface TracksService {
  get(icao24: string, auto: boolean): Promise<TrackReply>;
  // The live budget for echo replies that make no request (unknown-id
  // flight.track); reads the ledger, never spends.
  budget(): Promise<TrackReply["budget"]>;
}

export interface TracksOpts {
  recorder?: HistoryRecorder | null;
  tokenProvider?: TokenProvider;
  ledgerFile: string;
  fetchImpl?: typeof fetch;
  now?: () => number;
  log?: (m: string) => void;
  tracksAllUrl?: string;
  cacheMs?: number;
  autoDailyCap?: number;
  hardDailyCap?: number;
  traffic?: TrafficCounter;
}

export const AUTO_DAILY_CAP = 300;
export const HARD_DAILY_CAP = 800;

const TRACKS_ALL_URL = "https://opensky-network.org/api/tracks/all";
const TRACK_HOURS = 24;
const DEFAULT_CACHE_MS = 10_000;

const msg = (e: unknown): string => (e instanceof Error ? e.message : String(e));

// The live /tracks/all?icao24=… response is the bare track record
// ({icao24, callsign, startTime, endTime, path} — recorded 2026-11-21). The
// docs show a {time, elapsed, data:[…]} wrapper; accept that and a bare
// array too (routes.ts hit the same bare-vs-wrapper split on /flights/all).
// Path entries: [time (epoch s), lat, lon, baro alt, true track, on ground].
function firstRecord(body: unknown): { path?: unknown } | null {
  if (Array.isArray(body)) return body.length > 0 ? firstRecord(body[0]) : null;
  if (!body || typeof body !== "object") return null;
  const b = body as Record<string, unknown>;
  if (Array.isArray(b.path)) return b;
  if (Array.isArray(b.data)) return b.data.length > 0 ? firstRecord(b.data[0]) : null;
  return null;
}

interface Ledger {
  day: string; // YYYY-MM-DD (UTC)
  count: number; // OpenSky track requests made that day
}

export function createTracks(opts: TracksOpts): TracksService {
  const now = opts.now ?? Date.now;
  const fetchImpl = opts.fetchImpl ?? fetch;
  const log = opts.log ?? (() => {});
  const cacheMs = opts.cacheMs ?? DEFAULT_CACHE_MS;
  const autoDailyCap = opts.autoDailyCap ?? AUTO_DAILY_CAP;
  const hardDailyCap = opts.hardDailyCap ?? HARD_DAILY_CAP;
  const cache = new Map<string, TrackReply>();
  let ledger: Ledger = { day: "", count: 0 };

  // Load-at-boot (faa-lookup pattern): absent file is fine, corrupt resets.
  const boot = (async () => {
    try {
      const parsed = JSON.parse(await readFile(opts.ledgerFile, "utf8")) as Ledger;
      if (typeof parsed.day === "string" && typeof parsed.count === "number") ledger = parsed;
    } catch (e) {
      ledger = { day: "", count: 0 };
      if ((e as NodeJS.ErrnoException)?.code !== "ENOENT") {
        log(`tracks: ledger corrupt, resetting: ${msg(e)}`);
      }
    }
  })();

  const utcDay = (ms: number): string => new Date(ms).toISOString().slice(0, 10);
  const countFor = (day: string): number => (ledger.day === day ? ledger.count : 0);

  // Write-through persistence, count BEFORE the request goes out: tmp+rename.
  async function bumpLedger(day: string): Promise<void> {
    ledger = { day, count: countFor(day) + 1 };
    try {
      await mkdir(dirname(opts.ledgerFile), { recursive: true });
      const tmp = `${opts.ledgerFile}.tmp`;
      await writeFile(tmp, JSON.stringify(ledger));
      await rename(tmp, opts.ledgerFile);
    } catch (e) {
      log(`tracks: ledger persist failed: ${msg(e)}`);
    }
  }

  const budgetFor = (ms: number): TrackReply["budget"] => {
    const count = countFor(utcDay(ms));
    // autoLeft agrees with the auto gate (refused at count + 1 >= cap):
    // the number of auto calls still accepted, matching `hard`.
    return { autoLeft: Math.max(0, autoDailyCap - 1 - count), hard: count + 1 >= hardDailyCap };
  };

  // Refusal: serve the cached reply (any age), or an empty "none" when this
  // craft was never fetched. The ledger is the guard, not the response.
  const stale = (cached: TrackReply | undefined, budget: TrackReply["budget"]): TrackReply =>
    cached ? { ...cached, budget } : { path: [], fetchedAt: 0, source: "none", budget };

  const finite = (v: unknown): number | null =>
    typeof v === "number" && Number.isFinite(v) ? v : null;

  async function openskyPath(hex: string): Promise<TrackPoint[]> {
    const url = `${opts.tracksAllUrl ?? TRACKS_ALL_URL}?icao24=${encodeURIComponent(hex)}&time=0`;
    const provider = opts.tokenProvider;
    const call = async (): Promise<Response> => {
      const headers: Record<string, string> = provider
        ? { Authorization: `Bearer ${await provider.getToken()}` }
        : {};
      return fetchImpl(url, { headers, signal: AbortSignal.timeout(10_000) });
    };
    let res = await call();
    if (res.status === 401 && provider) {
      provider.invalidate();
      res = await call();
    }
    if (!res.ok) {
      if (res.status === 429) log(`tracks: opensky 429 (retry-after: ${res.headers.get("retry-after") ?? "none"})`);
      throw new Error(`tracks/all HTTP ${res.status}`);
    }
    // text capture (was inline in firstRecord): raw bytes + identical throw.
    const text = await res.text();
    opts.traffic?.count("in", Buffer.byteLength(text));
    const rec = firstRecord(JSON.parse(text));
    const path: TrackPoint[] = [];
    for (const row of Array.isArray(rec?.path) ? (rec.path as unknown[]) : []) {
      if (!Array.isArray(row)) continue;
      const [sec, lat, lon, baroAlt, , onGround] = row as (number | string | boolean | null)[];
      const eLat = finite(lat);
      const eLon = finite(lon);
      if (typeof sec !== "number" || !Number.isFinite(sec) || eLat === null || eLon === null) continue;
      path.push({ t: sec * 1000, lat: eLat, lon: eLon, alt: finite(baroAlt), onGround: onGround === true });
    }
    return path;
  }

  return {
    async budget(): Promise<TrackReply["budget"]> {
      await boot;
      return budgetFor(now());
    },
    async get(icao24: string, auto: boolean): Promise<TrackReply> {
      await boot;
      const hex = icao24.trim().toLowerCase();
      const t0 = now();
      const cached = cache.get(hex);
      if (cached && t0 - cached.fetchedAt < cacheMs) return { ...cached, budget: budgetFor(t0) };

      const day = utcDay(t0);
      const count = countFor(day);
      if (count + 1 >= hardDailyCap) return stale(cached, { autoLeft: 0, hard: true });
      if (auto && count + 1 >= autoDailyCap) return stale(cached, { autoLeft: 0, hard: false });
      await bumpLedger(day);

      let os: TrackPoint[] | null = null;
      try {
        os = await openskyPath(hex);
      } catch (e) {
        log(`tracks: opensky failed: ${msg(e)}`);
      }
      let hist: TrackPoint[] = [];
      if (opts.recorder) {
        try {
          hist = await opts.recorder.trackFor(hex, TRACK_HOURS);
        } catch (e) {
          log(`tracks: history scan failed: ${msg(e)}`);
        }
      }
      // Same-second points collapse; OpenSky (written second) wins.
      const merged = new Map<number, TrackPoint>();
      for (const p of hist) merged.set(Math.floor(p.t / 1000), p);
      for (const p of os ?? []) merged.set(Math.floor(p.t / 1000), p);
      const path = [...merged.values()].sort((a, b) => a.t - b.t);
      const source: TrackReply["source"] =
        path.length === 0
          ? "none"
          : hist.length > 0 && (os?.length ?? 0) > 0
            ? "both"
            : hist.length > 0
              ? "history"
              : "opensky";
      const reply: TrackReply = { path, fetchedAt: now(), source, budget: budgetFor(now()) };
      cache.set(hex, reply);
      return reply;
    },
  };
}
