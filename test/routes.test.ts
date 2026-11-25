import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { readFileSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRoutes, type FlightRoute } from "../server/routes.js";
import type { Airports, Airport } from "../server/airports.js";
import type { TokenProvider } from "../server/opensky-auth.js";

// Fixtures are real recorded responses (2026-11-21):
//   curl -s -A "RadarLocalApp/1.0 (personal radar; contact via local app)" \
//     https://api.adsbdb.com/v0/callsign/JBU2064 -o test/fixtures/adsbdb-callsign-jbu2064.json
//   curl -s -A "RadarLocalApp/1.0 (personal radar; contact via local app)" \
//     https://api.adsbdb.com/v0/callsign/QQ9999 -o test/fixtures/adsbdb-unknown.json   (HTTP 404 body)
//   OpenSky /flights/all recorded authenticated via the token provider, 10-min
//   window; the live response is a bare JSON array (NOT the documented
//   {time, elapsed, data} wrapper) and was 409 KB, so it is trimmed to a head
//   slice of the first 60 array elements, cut immediately after a complete
//   element ("[" + elements 0..59 + "]").
// Test fixture content notes: JBU2064 flies KEYW/EYW -> KBOS/BOS; the OpenSky
// slice contains 06a122 "QTR58G  " OTHH->KIAH and 00b22f "SAA375  " FAOR->FACT.
const ADSBDB_HIT = readFileSync(new URL("./fixtures/adsbdb-callsign-jbu2064.json", import.meta.url), "utf8");
const ADSBDB_MISS = readFileSync(new URL("./fixtures/adsbdb-unknown.json", import.meta.url), "utf8");
const FLIGHTS_ALL = readFileSync(new URL("./fixtures/opensky-flights-all.json", import.meta.url), "utf8");

const JBU_ROUTE: FlightRoute = {
  airline: "JetBlue Airways",
  dep: {
    code: "EYW",
    icao: "KEYW",
    iata: "EYW",
    name: "Key West International Airport",
    city: "Key West",
    country: "United States",
    lat: 24.5561,
    lon: -81.7596,
  },
  arr: {
    code: "BOS",
    icao: "KBOS",
    iata: "BOS",
    name: "Logan International Airport",
    city: "Boston",
    country: "United States",
    lat: 42.3643,
    lon: -71.0052,
  },
  source: "adsbdb",
};

const AIRPORT_TABLE: Record<string, Airport> = {
  OTHH: { icao: "OTHH", iata: null, name: "Hamad International Airport", city: "Doha", country: "Qatar", lat: 25.2731, lon: 51.608 },
  KIAH: { icao: "KIAH", iata: "IAH", name: "George Bush Intercontinental Airport", city: "Houston", country: "United States", lat: 29.9934, lon: -95.3414 },
  FAOR: { icao: "FAOR", iata: "JNB", name: "O.R. Tambo International Airport", city: "Johannesburg", country: "South Africa", lat: -26.1381, lon: 28.2434 },
  FACT: { icao: "FACT", iata: "CPT", name: "Cape Town International Airport", city: "Cape Town", country: "South Africa", lat: -33.9715, lon: 18.6021 },
  KEYW: { icao: "KEYW", iata: "EYW", name: "Key West International Airport", city: "Key West", country: "United States", lat: 24.5561, lon: -81.7596 },
  KBOS: { icao: "KBOS", iata: "BOS", name: "Logan International Airport", city: "Boston", country: "United States", lat: 42.3643, lon: -71.0052 },
};

function stubFetch() {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const queue: Array<() => Response> = [];
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    const next = queue.shift();
    if (!next) throw new Error(`unexpected fetch #${calls.length} to ${String(url)}`);
    return next();
  }) as typeof fetch;
  return {
    fetchImpl,
    calls,
    add: (res: () => Response) => {
      queue.push(res);
    },
    openSkyCalls: () => calls.filter((c) => c.url.startsWith("https://opensky-network.org/")).length,
  };
}

const jsonRes =
  (body: string, status = 200, headers: Record<string, string> = {}) =>
  () =>
    new Response(body, { status, headers: { "content-type": "application/json", ...headers } });

const adsbdb404 = () => jsonRes(ADSBDB_MISS, 404);
const flights200 = (remaining = "3900") => jsonRes(FLIGHTS_ALL, 200, { "x-rate-limit-remaining": remaining });

function fakeAirports(table: Record<string, Airport> = AIRPORT_TABLE) {
  const lookups: string[] = [];
  const byCode = new Map<string, Airport>();
  for (const a of Object.values(table)) {
    if (a.icao) byCode.set(a.icao, a);
    if (a.iata && !byCode.has(a.iata)) byCode.set(a.iata, a);
  }
  const airports: Airports = {
    init: async () => {},
    lookup(code: string): Airport | null {
      lookups.push(code);
      return byCode.get(code.trim().toUpperCase()) ?? null;
    },
    status: () => ({ loaded: true, count: Object.keys(table).length, lastError: null }),
  };
  return { airports, lookups };
}

function fakeProvider() {
  let issued = 0;
  const state = { tokens: [] as string[], invalidations: 0 };
  const provider: TokenProvider = {
    async getToken() {
      const t = `tok${++issued}`;
      state.tokens.push(t);
      return t;
    },
    invalidate() {
      state.invalidations += 1;
    },
  };
  return { provider, state };
}

// Fake timers + real fs IO don't share a clock, so tests settle promises by
// pumping the timer queue until the promise lands (never a real sleep).
async function settle<T>(promise: Promise<T>): Promise<T> {
  for (let i = 0; i < 500; i++) {
    let done = false;
    void promise.then(
      () => (done = true),
      () => (done = true),
    );
    await vi.advanceTimersByTimeAsync(50);
    if (done) return promise;
  }
  throw new Error("promise never settled");
}

async function readWhenExists(path: string): Promise<string> {
  for (let i = 0; i < 200; i++) {
    try {
      return await readFile(path, "utf8");
    } catch {
      await vi.advanceTimersByTimeAsync(10);
    }
  }
  throw new Error(`file never appeared: ${path}`);
}

describe("routes service", () => {
  let dir: string;

  beforeEach(async () => {
    vi.useFakeTimers();
    dir = await mkdtemp(join(tmpdir(), "radar-routes-"));
  });
  afterEach(async () => {
    vi.useRealTimers();
    for (let i = 0; i < 100; i++) {
      try {
        await rm(dir, { recursive: true, force: true });
        return;
      } catch {
        await new Promise((r) => setTimeout(r, 0));
      }
    }
  });

  const cacheFile = () => join(dir, "cache.json");

  function makeRoutes(opts: Partial<Parameters<typeof createRoutes>[0]> & { fetchImpl: typeof fetch }) {
    const { fetchImpl, ...rest } = opts;
    const airports = rest.airports ?? fakeAirports().airports;
    const svc = createRoutes({ cacheFile: cacheFile(), airports, fetchImpl, ...rest });
    return svc;
  }

  it("maps an adsbdb hit to dep/arr refs plus airline", async () => {
    const fetch = stubFetch();
    fetch.add(jsonRes(ADSBDB_HIT));
    const svc = makeRoutes({ fetchImpl: fetch.fetchImpl, airports: fakeAirports({}).airports });
    const route = await settle(svc.get({ id: "a20c31", callsign: " jbu2064 " }));
    expect(route).toEqual(JBU_ROUTE);
    expect(fetch.calls).toHaveLength(1);
    expect(fetch.calls[0].url).toBe("https://api.adsbdb.com/v0/callsign/JBU2064");
    expect(new Headers(fetch.calls[0].init?.headers).get("user-agent")).toBe(
      "RadarLocalApp/1.0 (personal radar; contact via local app)",
    );
  });

  it("serves a second call for the same callsign from cache (one fetch total) and persists the cache file", async () => {
    const fetch = stubFetch();
    fetch.add(jsonRes(ADSBDB_HIT));
    const svc = makeRoutes({ fetchImpl: fetch.fetchImpl });
    await settle(svc.get({ id: "a20c31", callsign: "JBU2064" }));
    const again = await settle(svc.get({ id: "a20c31", callsign: "JBU2064" }));
    expect(again).toEqual(JBU_ROUTE);
    expect(fetch.calls).toHaveLength(1);
    const persisted = JSON.parse(await readWhenExists(cacheFile())) as Record<string, unknown>;
    expect(persisted["JBU2064"]).toBeDefined();
  });

  it("fills fields adsbdb did not carry from the airports map", async () => {
    const fetch = stubFetch();
    fetch.add(
      jsonRes(
        '{"response":{"flightroute":{"airline":{"name":"Test Air"},"origin":{"iata_code":"eyw"},"destination":{"icao_code":"kbos","name":"Logan Intl"}}}}',
      ),
    );
    const svc = makeRoutes({ fetchImpl: fetch.fetchImpl });
    const route = await settle(svc.get({ id: "abc123", callsign: "TST1" }));
    expect(route).toEqual({
      airline: "Test Air",
      dep: { ...JBU_ROUTE.dep },
      arr: { ...JBU_ROUTE.arr, name: "Logan Intl" },
      source: "adsbdb",
    });
  });

  it("returns null immediately for an empty callsign without fetching", async () => {
    const fetch = stubFetch();
    const svc = makeRoutes({ fetchImpl: fetch.fetchImpl });
    expect(await settle(svc.get({ id: "abc123" }))).toBeNull();
    expect(await settle(svc.get({ id: "abc123", callsign: "   " }))).toBeNull();
    expect(fetch.calls).toHaveLength(0);
  });

  it("negative-caches a 404 for 1 h: no re-fetch within TTL, re-fetch after", async () => {
    const fetch = stubFetch();
    fetch.add(adsbdb404());
    fetch.add(adsbdb404());
    const svc = makeRoutes({ fetchImpl: fetch.fetchImpl });
    expect(await settle(svc.get({ id: "abc123", callsign: "QQ9999" }))).toBeNull();
    expect(fetch.calls).toHaveLength(1);
    expect(await settle(svc.get({ id: "abc123", callsign: "QQ9999" }))).toBeNull();
    expect(fetch.calls).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(61 * 60 * 1000);
    expect(await settle(svc.get({ id: "abc123", callsign: "QQ9999" }))).toBeNull();
    expect(fetch.calls).toHaveLength(2);
  });

  it("negative-caches a 429 for 5 minutes only", async () => {
    const fetch = stubFetch();
    fetch.add(() => new Response("", { status: 429 }));
    fetch.add(adsbdb404());
    const svc = makeRoutes({ fetchImpl: fetch.fetchImpl });
    expect(await settle(svc.get({ id: "abc123", callsign: "ZZ42" }))).toBeNull();
    expect(fetch.calls).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(4 * 60 * 1000);
    expect(await settle(svc.get({ id: "abc123", callsign: "ZZ42" }))).toBeNull();
    expect(fetch.calls).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(2 * 60 * 1000);
    expect(await settle(svc.get({ id: "abc123", callsign: "ZZ42" }))).toBeNull();
    expect(fetch.calls).toHaveLength(2);
  });

  it("falls back to OpenSky flights/all when adsbdb misses, serving the opensky source from cache afterwards", async () => {
    const fetch = stubFetch();
    fetch.add(adsbdb404());
    fetch.add(flights200());
    const { provider } = fakeProvider();
    const svc = makeRoutes({ fetchImpl: fetch.fetchImpl, tokenProvider: provider });
    const route = await settle(svc.get({ id: "06a122", callsign: "QTR58G" }));
    expect(fetch.calls).toHaveLength(2);
    expect(fetch.openSkyCalls()).toBe(1);
    const url = new URL(fetch.calls[1].url);
    expect(url.origin + url.pathname).toBe("https://opensky-network.org/api/flights/all");
    const end = Number(url.searchParams.get("end"));
    expect(Number(url.searchParams.get("begin"))).toBe(end - 1800);
    const nowSec = Math.floor(Date.now() / 1000);
    expect(end).toBeLessThanOrEqual(nowSec);
    expect(end).toBeGreaterThanOrEqual(nowSec - 2);
    expect(new Headers(fetch.calls[1].init?.headers).get("authorization")).toBe("Bearer tok1");
    expect(route).toEqual({
      airline: null,
      dep: {
        code: "OTHH",
        icao: "OTHH",
        iata: null,
        name: "Hamad International Airport",
        city: "Doha",
        country: "Qatar",
        lat: 25.2731,
        lon: 51.608,
      },
      arr: {
        code: "IAH",
        icao: "KIAH",
        iata: "IAH",
        name: "George Bush Intercontinental Airport",
        city: "Houston",
        country: "United States",
        lat: 29.9934,
        lon: -95.3414,
      },
      source: "opensky",
    });
    // Second call: positive cache short-circuits the whole ladder — no adsbdb
    // (negative would still be fresh) and no second opensky spend.
    const again = await settle(svc.get({ id: "06a122", callsign: "QTR58G" }));
    expect(again).toEqual(route!);
    expect(fetch.calls).toHaveLength(2);
  });

  it("matches the opensky record by callsign when the craft id does not appear", async () => {
    const fetch = stubFetch();
    fetch.add(adsbdb404());
    fetch.add(flights200());
    const { provider } = fakeProvider();
    const svc = makeRoutes({ fetchImpl: fetch.fetchImpl, tokenProvider: provider });
    const route = await settle(svc.get({ id: "ffee00", callsign: " saa375" }));
    expect(route?.source).toBe("opensky");
    expect(route?.dep?.code).toBe("JNB");
    expect(route?.dep?.icao).toBe("FAOR");
    expect(route?.arr?.code).toBe("CPT");
  });

  it("retries a 401 once after invalidating the token", async () => {
    const fetch = stubFetch();
    fetch.add(adsbdb404());
    fetch.add(() => new Response("", { status: 401 }));
    fetch.add(flights200());
    const { provider, state } = fakeProvider();
    const svc = makeRoutes({ fetchImpl: fetch.fetchImpl, tokenProvider: provider });
    const route = await settle(svc.get({ id: "06a122", callsign: "QTR58G" }));
    expect(route?.source).toBe("opensky");
    expect(state.invalidations).toBe(1);
    expect(fetch.calls).toHaveLength(3);
    expect(new Headers(fetch.calls[2].init?.headers).get("authorization")).toBe("Bearer tok2");
  });

  it("skips the fallback below 200 flights credits and negative-caches a full miss", async () => {
    const fetch = stubFetch();
    fetch.add(adsbdb404());
    fetch.add(flights200("150")); // A: fallback runs, no record matches, 150 credits left
    fetch.add(adsbdb404()); // B: fallback must be skipped (remaining < 200)
    const { provider } = fakeProvider();
    const svc = makeRoutes({ fetchImpl: fetch.fetchImpl, tokenProvider: provider });
    expect(await settle(svc.get({ id: "abcdef", callsign: "NOPE999" }))).toBeNull();
    expect(fetch.calls).toHaveLength(2);
    expect(await settle(svc.get({ id: "abcdef", callsign: "NOPE999" }))).toBeNull();
    expect(fetch.calls).toHaveLength(2); // still negative-cached
    expect(await settle(svc.get({ id: "123456", callsign: "NOPE888" }))).toBeNull();
    expect(fetch.calls).toHaveLength(3);
    expect(fetch.openSkyCalls()).toBe(1);
  });

  it("spaces consecutive outbound requests by 1 s", async () => {
    const fetch = stubFetch();
    fetch.add(adsbdb404());
    fetch.add(adsbdb404());
    const svc = makeRoutes({ fetchImpl: fetch.fetchImpl });
    // empty callsign fetches nothing but awaits the boot cache read (real IO),
    // so the limiter assertions below run on a purely fake-clock chain
    await settle(svc.get({ id: "warm", callsign: "" }));
    const pA = svc.get({ id: "aaaaaa", callsign: "AAA1" });
    const pB = svc.get({ id: "bbbbbb", callsign: "BBB2" });
    await vi.advanceTimersByTimeAsync(1); // flush boot await + A's request dispatch
    expect(fetch.calls).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(998); // B must still be holding ~1 s after A
    expect(fetch.calls).toHaveLength(1);
    await settle(Promise.all([pA, pB]));
    expect(fetch.calls).toHaveLength(2);
  });

  it("loads a corrupt cache file as empty and logs", async () => {
    await writeFile(cacheFile(), "{ not json !!", "utf8");
    const logs: string[] = [];
    const fetch = stubFetch();
    fetch.add(jsonRes(ADSBDB_HIT));
    const svc = createRoutes({
      cacheFile: cacheFile(),
      airports: fakeAirports().airports,
      fetchImpl: fetch.fetchImpl,
      log: (m) => logs.push(m),
    });
    const route = await settle(svc.get({ id: "a20c31", callsign: "JBU2064" }));
    expect(route).toEqual(JBU_ROUTE);
    expect(logs.some((m) => m.includes("corrupt"))).toBe(true);
  });

  it("serves a persisted positive entry from disk at boot without fetching", async () => {
    await writeFile(
      cacheFile(),
      JSON.stringify({ JBU2064: { foundAt: Date.now(), route: JBU_ROUTE } }),
      "utf8",
    );
    const fetch = stubFetch();
    const svc = makeRoutes({ fetchImpl: fetch.fetchImpl });
    const route = await settle(svc.get({ id: "a20c31", callsign: "JBU2064" }));
    expect(route).toEqual(JBU_ROUTE);
    expect(fetch.calls).toHaveLength(0);
  });

  it("counts response bodies into the traffic monitor", async () => {
    const counted: Array<{ dir: "in" | "out"; bytes: number }> = [];
    const fetch = stubFetch();
    fetch.add(jsonRes(ADSBDB_HIT));
    const svc = makeRoutes({
      fetchImpl: fetch.fetchImpl,
      airports: fakeAirports({}).airports,
      traffic: { count: (dir, bytes) => counted.push({ dir, bytes }) },
    });
    await settle(svc.get({ id: "a20c31", callsign: "JBU2064" }));
    svc.stop();
    expect(counted).toEqual([{ dir: "in", bytes: Buffer.byteLength(ADSBDB_HIT) }]);
  });

  it("malformed adsbdb body: swallowed to null exactly as res.json() threw, bytes still counted", async () => {
    const counted: Array<{ dir: "in" | "out"; bytes: number }> = [];
    const fetch = stubFetch();
    fetch.add(jsonRes("{ not json at all"));
    const svc = makeRoutes({
      fetchImpl: fetch.fetchImpl,
      airports: fakeAirports({}).airports,
      traffic: { count: (dir, bytes) => counted.push({ dir, bytes }) },
    });
    // No throw escapes; the ladder falls to the (tokenless) opensky step → null.
    await expect(settle(svc.get({ id: "a20c31", callsign: "JBU2064" }))).resolves.toBeNull();
    svc.stop();
    expect(counted).toEqual([{ dir: "in", bytes: Buffer.byteLength("{ not json at all") }]);
  });
});
