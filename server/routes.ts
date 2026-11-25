import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { Airports } from "./airports.js";
import type { TokenProvider } from "./opensky-auth.js";
import type { TrafficCounter } from "./traffic.js";

export interface AirportRef {
  code: string; // display code: IATA when known, else ICAO, else the raw code
  icao: string | null;
  iata: string | null;
  name: string | null;
  city: string | null;
  country: string | null;
  lat: number | null;
  lon: number | null;
}

export interface FlightRoute {
  airline: string | null;
  dep: AirportRef | null;
  arr: AirportRef | null;
  source: "adsbdb" | "opensky";
}

export interface RoutesService {
  get(craft: { id: string; callsign?: string }): Promise<FlightRoute | null>;
  stop(): void;
}

export interface RoutesOpts {
  cacheFile: string;
  airports: Airports;
  tokenProvider?: TokenProvider;
  flightsAllUrl?: string;
  fetchImpl?: typeof fetch;
  now?: () => number;
  log?: (m: string) => void;
  positiveTtlMs?: number;
  negativeTtlMs?: number;
  traffic?: TrafficCounter;
}

const ADSBDB_URL = "https://api.adsbdb.com/v0/callsign/";
const ADSBDB_UA = "RadarLocalApp/1.0 (personal radar; contact via local app)";
const FLIGHTS_ALL_URL = "https://opensky-network.org/api/flights/all";
const DEFAULT_POSITIVE_TTL_MS = 24 * 3_600_000;
const DEFAULT_NEGATIVE_TTL_MS = 3_600_000;
const THROTTLED_NEGATIVE_TTL_MS = 300_000; // 429
const FALLBACK_WINDOW_MS = 30 * 60_000;
const FALLBACK_MIN_REMAINING = 200;
const DEFAULT_FLIGHTS_REMAINING = 4000; // standard-tier /flights budget
const MIN_SPACING_MS = 1000;

interface CacheEntry {
  foundAt: number;
  negative?: boolean;
  route?: FlightRoute;
  negativeTtlMs?: number;
}

interface AdsbdbAirport {
  iata_code?: string | null;
  icao_code?: string | null;
  name?: string | null;
  municipality?: string | null;
  country_name?: string | null;
  latitude?: number | null;
  longitude?: number | null;
}

interface AdsbdbFlightroute {
  airline?: { name?: string | null } | null;
  origin?: AdsbdbAirport | null;
  destination?: AdsbdbAirport | null;
}

// The live /flights/all response is a bare array; the docs show a
// {time, elapsed, data} wrapper. Accept both.
interface OpenSkyFlight {
  icao24?: string | null;
  callsign?: string | null;
  lastSeen?: number | null;
  estDepartureAirport?: string | null;
  estArrivalAirport?: string | null;
}

const msg = (e: unknown): string => (e instanceof Error ? e.message : String(e));

export function createRoutes(opts: RoutesOpts): RoutesService {
  const now = opts.now ?? Date.now;
  const fetchImpl = opts.fetchImpl ?? fetch;
  const log = opts.log ?? (() => {});
  const positiveTtl = opts.positiveTtlMs ?? DEFAULT_POSITIVE_TTL_MS;
  const negativeTtl = opts.negativeTtlMs ?? DEFAULT_NEGATIVE_TTL_MS;
  const cache = new Map<string, CacheEntry>();
  let flightsRemaining = DEFAULT_FLIGHTS_REMAINING;
  let lastRequestAt = Number.NEGATIVE_INFINITY;
  let queue: Promise<unknown> = Promise.resolve();

  // Load-at-boot (faa-lookup pattern): absent file is fine, corrupt resets.
  const boot = (async () => {
    try {
      const raw = await readFile(opts.cacheFile, "utf8");
      for (const [cs, entry] of Object.entries(JSON.parse(raw) as Record<string, CacheEntry>)) {
        if (entry && typeof entry.foundAt === "number") cache.set(cs, entry);
      }
    } catch (e) {
      cache.clear();
      if ((e as NodeJS.ErrnoException)?.code !== "ENOENT") {
        log(`routes: cache file corrupt, starting empty: ${msg(e)}`);
      }
    }
  })();

  // One global 1 req/s spacing queue for every outbound call.
  function serialized<T>(fn: () => Promise<T>): Promise<T> {
    const run = queue.then(async () => {
      const wait = MIN_SPACING_MS - (now() - lastRequestAt);
      if (wait > 0) await new Promise<void>((r) => setTimeout(r, wait));
      lastRequestAt = now();
      return fn();
    });
    queue = run.catch(() => undefined);
    return run;
  }

  function num(v: unknown): number | null {
    return typeof v === "number" && Number.isFinite(v) ? v : null;
  }

  const codeOrNull = (v: unknown): string | null => {
    const s = typeof v === "string" ? v.trim().toUpperCase() : "";
    return s === "" ? null : s;
  };

  function refFromAdsbdb(a?: AdsbdbAirport | null): AirportRef | null {
    if (!a) return null;
    const iata = codeOrNull(a.iata_code);
    const icao = codeOrNull(a.icao_code);
    if (!iata && !icao) return null;
    const known = opts.airports.lookup((icao ?? iata) as string);
    const effIata = iata ?? known?.iata ?? null;
    const effIcao = icao ?? known?.icao ?? null;
    return {
      code: effIata ?? effIcao ?? "",
      icao: effIcao,
      iata: effIata,
      name: a.name ?? known?.name ?? null,
      city: a.municipality ?? known?.city ?? null,
      country: a.country_name ?? known?.country ?? null,
      lat: num(a.latitude) ?? known?.lat ?? null,
      lon: num(a.longitude) ?? known?.lon ?? null,
    };
  }

  function mapAdsbdb(flightroute?: AdsbdbFlightroute | null): FlightRoute | null {
    if (!flightroute) return null;
    const dep = refFromAdsbdb(flightroute.origin);
    const arr = refFromAdsbdb(flightroute.destination);
    if (!dep && !arr) return null;
    return { airline: flightroute.airline?.name ?? null, dep, arr, source: "adsbdb" };
  }

  // est-codes are ICAO; an unresolved code still renders (spec: codes without names).
  function refFromEst(code: string | null | undefined): AirportRef | null {
    const key = codeOrNull(code);
    if (!key) return null;
    const a = opts.airports.lookup(key);
    if (!a) {
      return { code: key, icao: null, iata: null, name: null, city: null, country: null, lat: null, lon: null };
    }
    return {
      code: a.iata ?? a.icao ?? key,
      icao: a.icao,
      iata: a.iata,
      name: a.name ?? null,
      city: a.city,
      country: a.country,
      lat: a.lat,
      lon: a.lon,
    };
  }

  async function adsbdbGet(cs: string): Promise<{ route: FlightRoute | null; negativeTtlMs: number }> {
    const res = await serialized(() =>
      fetchImpl(`${ADSBDB_URL}${encodeURIComponent(cs)}`, {
        headers: { "user-agent": ADSBDB_UA },
        signal: AbortSignal.timeout(5000),
      }),
    );
    if (res.status === 429) return { route: null, negativeTtlMs: THROTTLED_NEGATIVE_TTL_MS };
    if (!res.ok) return { route: null, negativeTtlMs: negativeTtl };
    let body: { response?: { flightroute?: AdsbdbFlightroute } | string };
    try {
      // text+parse (not res.json()) to count raw bytes; a malformed body
      // throws here exactly as res.json() did and is swallowed the same way.
      const text = await res.text();
      opts.traffic?.count("in", Buffer.byteLength(text));
      body = JSON.parse(text) as typeof body;
    } catch {
      return { route: null, negativeTtlMs: negativeTtl };
    }
    const fr = typeof body.response === "object" && body.response !== null ? body.response.flightroute : undefined;
    return { route: mapAdsbdb(fr), negativeTtlMs: negativeTtl };
  }

  async function openskyRoute(id: string, cs: string): Promise<FlightRoute | null> {
    const endMs = now();
    const begin = Math.floor((endMs - FALLBACK_WINDOW_MS) / 1000);
    const end = Math.floor(endMs / 1000);
    const url = `${opts.flightsAllUrl ?? FLIGHTS_ALL_URL}?begin=${begin}&end=${end}`;
    const provider = opts.tokenProvider as TokenProvider;
    const call = () =>
      serialized(async () => {
        const headers: Record<string, string> = { Authorization: `Bearer ${await provider.getToken()}` };
        return fetchImpl(url, { headers, signal: AbortSignal.timeout(10000) });
      });
    let res = await call();
    if (res.status === 401) {
      provider.invalidate();
      res = await call();
    }
    const remaining = res.headers.get("x-rate-limit-remaining");
    if (remaining !== null && remaining !== "" && Number.isFinite(Number(remaining))) flightsRemaining = Number(remaining);
    if (!res.ok) throw new Error(`flights/all HTTP ${res.status}`);
    // text capture: byte count + identical throw behavior on a bad body.
    const text = await res.text();
    opts.traffic?.count("in", Buffer.byteLength(text));
    const body = JSON.parse(text) as OpenSkyFlight[] | { data?: OpenSkyFlight[] };
    const records = Array.isArray(body) ? body : body.data ?? [];
    const hex = id.trim().toLowerCase();
    let pool = records.filter((r) => r.icao24 !== null && r.icao24 !== undefined && r.icao24.toLowerCase() === hex);
    if (pool.length === 0) pool = records.filter((r) => codeOrNull(r.callsign) === cs);
    let newest: OpenSkyFlight | null = null;
    for (const r of pool) if (!newest || (r.lastSeen ?? 0) > (newest.lastSeen ?? 0)) newest = r;
    if (!newest) return null;
    const dep = refFromEst(newest.estDepartureAirport);
    const arr = refFromEst(newest.estArrivalAirport);
    if (!dep && !arr) return null;
    return { airline: null, dep, arr, source: "opensky" };
  }

  function setCache(cs: string, entry: CacheEntry): void {
    cache.set(cs, entry);
    void persist();
  }

  async function persist(): Promise<void> {
    try {
      await mkdir(dirname(opts.cacheFile), { recursive: true });
      const tmp = `${opts.cacheFile}.tmp`;
      await writeFile(tmp, JSON.stringify(Object.fromEntries(cache), null, 1));
      await rename(tmp, opts.cacheFile);
    } catch (e) {
      log(`routes: cache persist failed: ${msg(e)}`);
    }
  }

  return {
    async get(craft: { id: string; callsign?: string }): Promise<FlightRoute | null> {
      await boot;
      const cs = (craft.callsign ?? "").trim().toUpperCase();
      if (cs === "") return null;
      const t = now();
      const hit = cache.get(cs);
      if (hit) {
        if (hit.route && t - hit.foundAt < positiveTtl) return hit.route;
        if (hit.negative && t - hit.foundAt < (hit.negativeTtlMs ?? negativeTtl)) return null;
      }
      let ads: { route: FlightRoute | null; negativeTtlMs: number };
      try {
        ads = await adsbdbGet(cs);
      } catch (e) {
        log(`routes: adsbdb ${msg(e)}`);
        ads = { route: null, negativeTtlMs: negativeTtl };
      }
      if (ads.route) {
        setCache(cs, { foundAt: t, route: ads.route });
        return ads.route;
      }
      if (opts.tokenProvider && flightsRemaining >= FALLBACK_MIN_REMAINING) {
        try {
          const route = await openskyRoute(craft.id, cs);
          if (route) {
            setCache(cs, { foundAt: t, route });
            return route;
          }
        } catch (e) {
          log(`routes: opensky fallback failed: ${msg(e)}`);
        }
      }
      setCache(cs, { foundAt: t, negative: true, negativeTtlMs: ads.negativeTtlMs });
      return null;
    },
    stop(): void {
      /* write-through persistence, nothing to flush */
    },
  };
}
