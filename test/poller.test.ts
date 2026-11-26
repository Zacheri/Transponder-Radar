import { describe, it, expect, beforeAll, afterAll } from "vitest";
import http from "node:http";
import { OpenSkyPoller, BACKOFF_CAP_MS, POLL_MIN_MS, POLL_MAX_MS } from "../server/opensky.js";
import { CraftStore } from "../server/store.js";

const PLANE: (string | number | boolean | null)[] = [
  "ac4963", "DAL539", "United States", 1700000000, 1700000000,
  -73.7, 40.6, 10000, false, 250, 90, 10, null, 10050, "1200", false, 2,
];

const jsonResponse = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });

describe("OpenSkyPoller", () => {
  let server: http.Server;
  let url: string;
  let current: { time: number; states: (string | number | boolean | null)[][] } = { time: 0, states: [] };

  beforeAll(async () => {
    server = http.createServer((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(current));
    });
    await new Promise<void>((r) => server.listen(0, () => r()));
    const addr = server.address();
    const port = typeof addr === "object" && addr ? addr.port : 0;
    url = `http://127.0.0.1:${port}/states/all`;
  });
  afterAll(async () => {
    await new Promise<void>((r) => server.close(() => r()));
  });

  it("polls, normalizes, upserts into store", async () => {
    current = { time: 0, states: [PLANE] };
    const store = new CraftStore();
    const poller = new OpenSkyPoller({ url, pollMs: 1000, graceMs: 30000, store });
    const { upserted } = await poller.pollOnce();
    expect(upserted).toBe(1);
    expect(store.get("ac4963")!.kind).toBe("commercial");
  });

  it("applies resolveIcon to normalized crafts when configured", async () => {
    const store = new CraftStore();
    const poller = new OpenSkyPoller({
      url, pollMs: 1000, graceMs: 30000, store,
      resolveIcon: () => "narrowbody",
    });
    current = { time: 0, states: [PLANE] };
    await poller.pollOnce();
    expect(store.get("ac4963")!.icon).toBe("narrowbody");
  });

  it("leaves icon unset when no resolver is configured", async () => {
    const store = new CraftStore();
    const poller = new OpenSkyPoller({ url, pollMs: 1000, graceMs: 30000, store });
    current = { time: 0, states: [PLANE] };
    await poller.pollOnce();
    expect(store.get("ac4963")!.icon).toBeUndefined();
  });

  it("prunes air absent from a later snapshot after grace", async () => {
    const store = new CraftStore();
    let t = 0;
    const poller = new OpenSkyPoller({ url, pollMs: 1000, graceMs: 30000, store, now: () => t });
    current = { time: 0, states: [PLANE] };
    t = 0;
    await poller.pollOnce();
    expect(store.size).toBe(1);
    current = { time: 0, states: [] };
    t = 1000;
    await poller.pollOnce(); // within grace
    expect(store.size).toBe(1);
    t = 31000;
    await poller.pollOnce(); // past grace
    expect(store.size).toBe(0);
  });

  it("does not prune on a failed poll", async () => {
    const store = new CraftStore();
    let t = 0;
    const good = new OpenSkyPoller({ url, pollMs: 1000, graceMs: 30000, store, now: () => t });
    current = { time: 0, states: [PLANE] };
    t = 0;
    await good.pollOnce();
    expect(store.size).toBe(1);
    const dead = new OpenSkyPoller({ url: "http://127.0.0.1:1", pollMs: 1000, graceMs: 30000, store, now: () => t });
    t = 999999;
    const { upserted } = await dead.pollOnce();
    expect(upserted).toBe(0);
    expect(store.size).toBe(1); // unchanged — a failed poll must not prune
  });

  it("429 with Retry-After backs off by the header value", async () => {
    const store = new CraftStore();
    const poller = new OpenSkyPoller({
      pollMs: 1000, graceMs: 30000, store,
      fetchImpl: (async () => jsonResponse(null, 429, { "retry-after": "5" })) as typeof fetch,
    });
    const { upserted, nextDelayMs } = await poller.pollOnce();
    expect(upserted).toBe(0);
    expect(nextDelayMs).toBe(5000);
  });

  it("429 without Retry-After backs off exponentially per consecutive 429", async () => {
    const store = new CraftStore();
    const poller = new OpenSkyPoller({
      pollMs: 1000, graceMs: 30000, store,
      fetchImpl: (async () => jsonResponse(null, 429)) as typeof fetch,
    });
    expect((await poller.pollOnce()).nextDelayMs).toBe(2000); // 1st: pollMs * 2
    expect((await poller.pollOnce()).nextDelayMs).toBe(4000); // 2nd: pollMs * 4
  });

  it("429 with only X-Rate-Limit-Retry-After-Seconds backs off by that header", async () => {
    const store = new CraftStore();
    const poller = new OpenSkyPoller({
      pollMs: 1000, graceMs: 30000, store,
      fetchImpl: (async () =>
        jsonResponse(null, 429, { "x-rate-limit-retry-after-seconds": "6" })) as typeof fetch,
    });
    const { upserted, nextDelayMs } = await poller.pollOnce();
    expect(upserted).toBe(0);
    expect(nextDelayMs).toBe(6000);
  });

  it("429: Retry-After wins over X-Rate-Limit-Retry-After-Seconds", async () => {
    const store = new CraftStore();
    const poller = new OpenSkyPoller({
      pollMs: 1000, graceMs: 30000, store,
      fetchImpl: (async () =>
        jsonResponse(null, 429, {
          "retry-after": "5",
          "x-rate-limit-retry-after-seconds": "9",
        })) as typeof fetch,
    });
    expect((await poller.pollOnce()).nextDelayMs).toBe(5000);
  });

  it("caps backoff at BACKOFF_CAP_MS after enough consecutive errors", async () => {
    const store = new CraftStore();
    const poller = new OpenSkyPoller({
      pollMs: 1000, graceMs: 30000, store,
      fetchImpl: (async () => { throw new Error("boom"); }) as typeof fetch,
    });
    let nextDelayMs = 0;
    for (let i = 0; i < 9; i++) nextDelayMs = (await poller.pollOnce()).nextDelayMs;
    expect(nextDelayMs).toBe(BACKOFF_CAP_MS);
  });

  it("network error: first error backs off pollMs*2 and keeps last-good", async () => {
    const store = new CraftStore();
    let calls = 0;
    const poller = new OpenSkyPoller({
      pollMs: 1000, graceMs: 30000, store,
      fetchImpl: (async () => {
        calls += 1;
        if (calls === 1) return jsonResponse({ states: [PLANE] });
        throw new Error("ECONNRESET");
      }) as typeof fetch,
    });
    expect((await poller.pollOnce()).upserted).toBe(1);
    const { upserted, nextDelayMs } = await poller.pollOnce();
    expect(upserted).toBe(0);
    expect(nextDelayMs).toBe(2000);
    expect(store.size).toBe(1); // last-good kept
  });

  it("malformed body: skips poll without throwing", async () => {
    const store = new CraftStore();
    const poller = new OpenSkyPoller({
      pollMs: 1000, graceMs: 30000, store,
      fetchImpl: (async () => jsonResponse({ states: "nope" })) as typeof fetch,
    });
    const { upserted, nextDelayMs } = await poller.pollOnce();
    expect(upserted).toBe(0);
    expect(nextDelayMs).toBe(1000);
    expect(store.size).toBe(0);
  });

  it("passes an AbortSignal to fetch", async () => {
    const store = new CraftStore();
    let init: RequestInit | undefined;
    const poller = new OpenSkyPoller({
      pollMs: 1000, graceMs: 30000, store,
      fetchImpl: (async (_url: string, options?: RequestInit) => {
        init = options;
        return jsonResponse({ states: [] });
      }) as typeof fetch,
    });
    await poller.pollOnce();
    expect(init?.signal).toBeInstanceOf(AbortSignal);
  });

  it("sends a Bearer token when a token provider is configured", async () => {
    const store = new CraftStore();
    let init: RequestInit | undefined;
    const poller = new OpenSkyPoller({
      pollMs: 1000, graceMs: 30000, store,
      tokenProvider: { getToken: async () => "tok123", invalidate: () => {} },
      fetchImpl: (async (_url: string, options?: RequestInit) => {
        init = options;
        return jsonResponse({ states: [] });
      }) as typeof fetch,
    });
    await poller.pollOnce();
    const headers = (init?.headers ?? {}) as Record<string, string>;
    expect(headers["Authorization"]).toBe("Bearer tok123");
  });

  it("omits the auth header when no token provider is configured", async () => {
    const store = new CraftStore();
    let init: RequestInit | undefined;
    const poller = new OpenSkyPoller({
      pollMs: 1000, graceMs: 30000, store,
      fetchImpl: (async (_url: string, options?: RequestInit) => {
        init = options;
        return jsonResponse({ states: [] });
      }) as typeof fetch,
    });
    await poller.pollOnce();
    const headers = (init?.headers ?? {}) as Record<string, string>;
    expect(headers["Authorization"]).toBeUndefined();
  });

  it("invalidates the token and retries once on 401", async () => {
    const store = new CraftStore();
    let invalidated = 0;
    let calls = 0;
    const poller = new OpenSkyPoller({
      pollMs: 1000, graceMs: 30000, store,
      tokenProvider: {
        getToken: async () => "stale",
        invalidate: () => {
          invalidated += 1;
        },
      },
      fetchImpl: (async () => {
        calls += 1;
        return calls === 1 ? jsonResponse(null, 401) : jsonResponse({ states: [PLANE] });
      }) as typeof fetch,
    });
    const { upserted } = await poller.pollOnce();
    expect(upserted).toBe(1);
    expect(invalidated).toBe(1);
    expect(calls).toBe(2);
  });

  it("backs off when a 401 persists after a token refresh", async () => {
    const store = new CraftStore();
    const poller = new OpenSkyPoller({
      pollMs: 1000, graceMs: 30000, store,
      tokenProvider: { getToken: async () => "bad", invalidate: () => {} },
      fetchImpl: (async () => jsonResponse(null, 401)) as typeof fetch,
    });
    const { upserted, nextDelayMs } = await poller.pollOnce();
    expect(upserted).toBe(0);
    expect(nextDelayMs).toBe(2000);
  });

  describe("setPollInterval", () => {
    it("reports the current interval in feedStatus", () => {
      const store = new CraftStore();
      const p = new OpenSkyPoller({ url, pollMs: 120000, graceMs: 30000, store });
      expect(p.feedStatus.pollMs).toBe(120000);
    });

    it("clamps below POLL_MIN_MS and above POLL_MAX_MS", () => {
      const store = new CraftStore();
      const p = new OpenSkyPoller({ url, pollMs: 120000, graceMs: 30000, store });
      p.setPollInterval(1000);
      expect(p.feedStatus.pollMs).toBe(POLL_MIN_MS);
      p.setPollInterval(999999999);
      expect(p.feedStatus.pollMs).toBe(POLL_MAX_MS);
      p.setPollInterval(45000);
      expect(p.feedStatus.pollMs).toBe(45000);
    });

    it("applies the new interval to the next successful poll", async () => {
      const store = new CraftStore();
      const p = new OpenSkyPoller({ url, pollMs: 120000, graceMs: 30000, store });
      p.setPollInterval(30000);
      current = { time: 0, states: [PLANE] };
      expect((await p.pollOnce()).nextDelayMs).toBe(30000);
    });

    it("backoff base tracks the live interval", async () => {
      const store = new CraftStore();
      const p = new OpenSkyPoller({
        pollMs: 120000, graceMs: 30000, store,
        fetchImpl: (async () => { throw new Error("ECONNRESET"); }) as typeof fetch,
      });
      p.setPollInterval(30000);
      expect((await p.pollOnce()).nextDelayMs).toBe(60000); // 1st error: 30000 * 2
    });
  });
});

// --- hot-zone boost (Task 2) -------------------------------------------------

import type { AirKind, Craft } from "../shared/craft.js";

// Three military rows in one dense 3x3 grid hood around (40, -100); the
// 0.5° offsets keep every centroid/half computation exact in binary floats.
const CLUSTER: [string, number, number][] = [
  ["m1", 40, -100],
  ["m2", 40.5, -100.5],
  ["m3", 39.5, -99.5],
];

const airCraft = (id: string, kind: AirKind, lat: number, lon: number, updatedAt = 0): Craft => ({
  id, domain: "air", kind, lat, lon, speed: null, heading: null, updatedAt, stale: false,
});

// OpenSky state row with spi set — classifyAir maps that to military.
const spiRow = (icao24: string, lat: number, lon: number): (string | number | boolean | null)[] => [
  icao24, "VIPER1", "United States", 1700000000, 1700000000,
  lon, lat, 10000, false, 250, 90, 10, null, 10050, "1200", true, 2,
];

const seedCluster = (store: CraftStore) => {
  store.upsert(CLUSTER.map(([id, lat, lon]) => airCraft(id, "military", lat, lon)), 0);
};

// A second, non-overlapping cluster (2 members, far south) plus one extra
// member crowding the dense cluster's cell, so CLUSTER unambiguously ranks
// as zone 1 (cell counts decide the rank) in the funding-order tests.
const FAR_CLUSTER: [string, number, number][] = [
  ["f1", -30, 60],
  ["f2", -30.5, 60.5],
];
const SEED_BOTH: [string, number, number][] = [...CLUSTER, ["m4", 41, -100], ...FAR_CLUSTER];

const seedInto = (store: CraftStore, list: [string, number, number][]) => {
  store.upsert(list.map(([id, lat, lon]) => airCraft(id, "military", lat, lon)), 0);
};

const zoneUrls = (urls: string[]) => urls.filter((u) => u.includes("lamin="));

describe("OpenSkyPoller hot-zone boost", () => {
  // t is hand-advanced; 0 = epoch (UTC midnight) so reserve math is exact:
  // pollMs 120000 -> 720 due polls -> reserve 720*4 + 100 = 2980.

  const makeStub =
    (urls: string[], respond: (url: string, calls: number) => Response) =>
    ((async (url: string) => {
      urls.push(url);
      return respond(url, urls.length);
    }) as unknown) as typeof fetch;

  const funded = (remaining: string) =>
    jsonResponse({ states: [] }, 200, { "x-rate-limit-remaining": remaining });

  it("captures X-Rate-Limit-Remaining on globe polls; absent header keeps previous", async () => {
    const store = new CraftStore();
    let t = 0;
    const urls: string[] = [];
    let headers: Record<string, string> = { "x-rate-limit-remaining": "4000" };
    const poller = new OpenSkyPoller({
      pollMs: 120000, graceMs: 30000, store, now: () => t,
      fetchImpl: (async (url: string) => {
        urls.push(url);
        return jsonResponse({ states: [] }, 200, headers);
      }) as typeof fetch,
    });
    await poller.pollOnce(); // 1 globe call, remaining 4000 -> surplus 1020
    seedCluster(store);
    poller.setZonesConfig({ kinds: ["military"], boostMs: 10000 });
    await poller.pollZoneOnce();
    expect(urls).toHaveLength(2); // funded zone fetch happened
    expect(poller.feedStatus.boost?.intervalMs).toBe(84706); // ceil(86400000/1020)

    headers = { "x-rate-limit-remaining": "100" };
    await poller.pollOnce(); // captured: below reserve 2980 -> surplus 0
    headers = {}; // header absent -> previous 100 must be kept
    await poller.pollOnce();
    const r = await poller.pollZoneOnce();
    expect(urls).toHaveLength(4); // two globe polls, no third (zone) fetch
    expect(r.upserted).toBe(0);
    expect(poller.feedStatus.boost?.paused).toBe("credits");
    expect(poller.feedStatus.boost?.intervalMs).toBeNull();
    poller.setZonesConfig(null);
  });
  it("zone tick fetches the bbox URL with lamin/lomin/lamax/lomax", async () => {
    const store = new CraftStore();
    let t = 0;
    const urls: string[] = [];
    const poller = new OpenSkyPoller({
      pollMs: 120000, graceMs: 30000, store, now: () => t,
      fetchImpl: makeStub(urls, () => funded("4000")),
    });
    await poller.pollOnce();
    seedCluster(store);
    poller.setZonesConfig({ kinds: ["military"], boostMs: 10000 });
    await poller.pollZoneOnce();
    expect(urls).toHaveLength(2);
    const zoneUrl = new URL(urls[1]);
    expect(zoneUrl.pathname).toBe("/api/states/all");
    expect([...zoneUrl.searchParams.keys()]).toEqual(["lamin", "lomin", "lamax", "lomax"]);
    expect(zoneUrl.searchParams.get("lamin")).toBe("39.5");
    expect(zoneUrl.searchParams.get("lomin")).toBe("-100.5");
    expect(zoneUrl.searchParams.get("lamax")).toBe("40.5");
    expect(zoneUrl.searchParams.get("lomax")).toBe("-99.5");
    poller.setZonesConfig(null);
  });

  it("zone upserts carry icons and NEVER prune: far-away craft survive a zone poll", async () => {
    const store = new CraftStore();
    const t = 0;
    const urls: string[] = [];
    const poller = new OpenSkyPoller({
      pollMs: 120000, graceMs: 30000, store, now: () => t,
      resolveIcon: () => "rk:A10",
      fetchImpl: makeStub(urls, () =>
        jsonResponse({ states: [spiRow("b001", 40, -100), spiRow("b002", 40.2, -100.2)] }, 200, {
          "x-rate-limit-remaining": "4000",
        })
      ),
    });
    await poller.pollOnce(); // funds the boost; pruneAir runs on this globe path only
    seedCluster(store);
    store.upsert(airCraft("far", "military", 10, -60, -100000), -100000); // past any grace
    poller.setZonesConfig({ kinds: ["military"], boostMs: 10000 });
    const { upserted } = await poller.pollZoneOnce();
    expect(upserted).toBe(2);
    expect(store.get("b001")?.icon).toBe("rk:A10");
    expect(store.get("b001")?.kind).toBe("military");
    expect(store.get("far")).toBeDefined(); // pruneAir on this path would have swept it
    expect(store.get("m1")).toBeDefined();
    poller.setZonesConfig(null);
  });

  it("unfunded (remaining below reserve, or never seen) -> paused credits, no fetch", async () => {
    const store = new CraftStore();
    const t = 0;
    const urls: string[] = [];
    const poller = new OpenSkyPoller({
      pollMs: 120000, graceMs: 30000, store, now: () => t,
      fetchImpl: makeStub(urls, () => funded("100")),
    });
    await poller.pollOnce();
    seedCluster(store);
    poller.setZonesConfig({ kinds: ["military"], boostMs: 10000 });
    const r = await poller.pollZoneOnce();
    expect(urls).toHaveLength(1); // globe only — zone never fetched
    expect(r.upserted).toBe(0);
    expect(poller.feedStatus.boost).toEqual({
      active: true, count: 3, intervalMs: null, paused: "credits", zones: 1,
    });

    // No header ever seen -> surplus 0 -> boost stays off as well.
    const cold = new OpenSkyPoller({
      pollMs: 120000, graceMs: 30000, store, now: () => t,
      fetchImpl: makeStub(urls, () => jsonResponse({ states: [] })),
    });
    cold.setZonesConfig({ kinds: ["military"], boostMs: 10000 });
    await cold.pollZoneOnce();
    expect(cold.feedStatus.boost?.paused).toBe("credits");
    expect(urls).toHaveLength(1);
    poller.setZonesConfig(null);
    cold.setZonesConfig(null);
  });

  it("zone 429 pauses boost without touching globe consecutiveErrors", async () => {
    const store = new CraftStore();
    let t = 0;
    const urls: string[] = [];
    let mode = "ok";
    const poller = new OpenSkyPoller({
      pollMs: 120000, graceMs: 30000, store, now: () => t,
      fetchImpl: makeStub(urls, (url) => {
        if (mode === "429") return jsonResponse(null, 429);
        if (mode === "zone429" && url.includes("lamin=")) {
          return jsonResponse(null, 429, { "retry-after": "30" });
        }
        return funded("4000");
      }),
    });
    await poller.pollOnce();
    seedCluster(store);
    poller.setZonesConfig({ kinds: ["military"], boostMs: 10000 });
    await poller.pollZoneOnce(); // funded ok fetch, zoneNextAt = 0 + 84706
    mode = "zone429";
    t = 84707; // due again
    await poller.pollZoneOnce();
    expect(urls).toHaveLength(3);
    expect(poller.feedStatus.boost?.paused).toBe("credits");
    expect(poller.feedStatus.boost?.intervalMs).toBeNull();

    // Globe 429 backoff schedule is still its own: first globe 429 = pollMs*2,
    // as if the zone 429 never happened.
    mode = "429";
    expect((await poller.pollOnce()).nextDelayMs).toBe(240000);
    expect((await poller.pollOnce()).nextDelayMs).toBe(300000); // cap
    poller.setZonesConfig(null);
  });

  it("setZonesConfig(null) disables: zone and boost status clear, no more ticks", async () => {
    const store = new CraftStore();
    let t = 0;
    const urls: string[] = [];
    const poller = new OpenSkyPoller({
      pollMs: 120000, graceMs: 30000, store, now: () => t,
      fetchImpl: makeStub(urls, () => funded("4000")),
    });
    await poller.pollOnce();
    seedCluster(store);
    poller.setZonesConfig({ kinds: ["military"], boostMs: 10000 });
    await poller.pollZoneOnce();
    expect(poller.zonesStatus).toHaveLength(1);
    expect(poller.zonesStatus[0].dominantKind).toBe("military");
    expect(poller.feedStatus.boost?.active).toBe(true);
    expect(poller.feedStatus.boost?.count).toBe(3);
    expect(poller.feedStatus.boost?.zones).toBe(1);

    poller.setZonesConfig(null);
    expect(poller.zonesStatus).toHaveLength(0);
    expect(poller.feedStatus.boost).toBeNull();
    t = 1_000_000;
    await poller.pollZoneOnce();
    expect(urls).toHaveLength(2); // no zone fetch after disable
  });

  it("setZonesConfig clamps boostMs into its slider range and ignores non-finite values", async () => {
    const store = new CraftStore();
    const t = 0;
    const urls: string[] = [];
    // remaining 15000: surplus 12020 -> stretched interval 7188, so the
    // effective boostMs (when above the stretch) is observable via intervalMs.
    const poller = new OpenSkyPoller({
      pollMs: 120000, graceMs: 30000, store, now: () => t,
      fetchImpl: makeStub(urls, () => funded("15000")),
    });
    await poller.pollOnce();
    seedCluster(store);
    poller.setZonesConfig({ kinds: ["military"], boostMs: 500 });
    await poller.pollZoneOnce();
    expect(poller.feedStatus.boost?.intervalMs).toBe(10000);
    poller.setZonesConfig({ kinds: ["military"], boostMs: 999999 });
    await poller.pollZoneOnce();
    expect(poller.feedStatus.boost?.intervalMs).toBe(120000);
    poller.setZonesConfig({ kinds: ["military"], boostMs: NaN }); // dropped, prior config kept
    await poller.pollZoneOnce();
    expect(poller.feedStatus.boost?.intervalMs).toBe(120000);
    poller.setZonesConfig(null);
    poller.setZonesConfig({ kinds: ["military"], boostMs: Infinity }); // from null -> still off
    expect(poller.feedStatus.boost).toBeNull();
  });

  it("two clusters: surplus >= 2 funds both zones in one tick (zone 1 = denser first)", async () => {
    const store = new CraftStore();
    const t = 0;
    const urls: string[] = [];
    const poller = new OpenSkyPoller({
      pollMs: 120000, graceMs: 30000, store, now: () => t,
      fetchImpl: makeStub(urls, () => funded("4000")),
    });
    await poller.pollOnce(); // remaining 4000 -> surplus 1020
    seedInto(store, SEED_BOTH);
    poller.setZonesConfig({ kinds: ["military"], boostMs: 10000 });
    const r = await poller.pollZoneOnce();
    expect(zoneUrls(urls)).toHaveLength(2); // both due zones funded off one surplus
    expect(r.upserted).toBe(0);
    expect(poller.feedStatus.boost?.zones).toBe(2);
    expect(poller.feedStatus.boost?.count).toBe(6); // craft summed across zones
    expect(poller.feedStatus.boost?.paused).toBeNull();
    expect(zoneUrls(urls)[0]).toContain("lamin=39.5"); // the dense cluster
    expect(zoneUrls(urls)[1]).toContain("lamin=-30.5"); // the far pair
    poller.setZonesConfig(null);
  });

  it("zone 2 skipped when surplus covers only zone 1's due poll (THE RULE)", async () => {
    const store = new CraftStore();
    // 60 s to UTC midnight: reserve = 1 due globe poll x 4 + 100 = 104.
    let t = Date.parse("2026-11-22T23:59:00.000Z");
    const urls: string[] = [];
    const poller = new OpenSkyPoller({
      pollMs: 120000, graceMs: 30000, store, now: () => t,
      fetchImpl: makeStub(urls, () => funded("105")), // surplus exactly 1
    });
    await poller.pollOnce();
    seedInto(store, SEED_BOTH);
    poller.setZonesConfig({ kinds: ["military"], boostMs: 10000 });
    const r = await poller.pollZoneOnce();
    expect(zoneUrls(urls)).toHaveLength(1); // zone 1's credit spent; zone 2 waits
    expect(zoneUrls(urls)[0]).toContain("lamin=39.5"); // the denser zone funded first
    expect(poller.feedStatus.boost?.zones).toBe(2);
    expect(poller.feedStatus.boost?.paused).toBe("credits");
    expect(r.nextDelayMs).toBe(60000); // stretched interval (ceil(60000/1))
    poller.setZonesConfig(null);
  });

  it("a 429 pauses only its own zone; the other zone keeps polling", async () => {
    const store = new CraftStore();
    let t = 0;
    const urls: string[] = [];
    let mode = "ok";
    const poller = new OpenSkyPoller({
      pollMs: 120000, graceMs: 30000, store, now: () => t,
      fetchImpl: makeStub(urls, (url) => {
        // Only zone 1's bbox 429s (retry-after 30 s -> max(pollMs, 30s) pause).
        if (mode === "zone1_429" && url.includes("lamin=39.5")) {
          return jsonResponse(null, 429, { "retry-after": "30" });
        }
        return funded("4000");
      }),
    });
    await poller.pollOnce();
    seedInto(store, SEED_BOTH);
    poller.setZonesConfig({ kinds: ["military"], boostMs: 10000 });

    mode = "zone1_429";
    await poller.pollZoneOnce(); // both due: zone 1 429s, zone 2 succeeds
    expect(zoneUrls(urls)).toHaveLength(2);
    expect(poller.feedStatus.boost?.zones).toBe(2);
    expect(poller.feedStatus.boost?.paused).toBe("credits"); // aggregate: zone 1 paused

    // Same instant: zone 1 in its pause, zone 2 between due times -> no fetch.
    await poller.pollZoneOnce();
    expect(zoneUrls(urls)).toHaveLength(2);

    // Past zone 1's pause both are due again -> two fresh polls, pause cleared.
    mode = "ok";
    t = 120000;
    await poller.pollZoneOnce();
    expect(zoneUrls(urls)).toHaveLength(4);
    expect(poller.feedStatus.boost?.paused).toBeNull();
    poller.setZonesConfig(null);
  });

  it("a 429 pause on a held zone does not leak into the next zone in its slot", async () => {
    const store = new CraftStore();
    let t = 0;
    const urls: string[] = [];
    let mode = "ok";
    const poller = new OpenSkyPoller({
      pollMs: 120000, graceMs: 30000, store, now: () => t,
      fetchImpl: makeStub(urls, (url) => {
        // retry-after 300 s -> the capped 300000 pause, long enough to
        // outlive the held copy's expiry when members leave now.
        if (mode === "zone429" && url.includes("lamin=")) {
          return jsonResponse(null, 429, { "retry-after": "300" });
        }
        return funded("4000");
      }),
    });
    await poller.pollOnce();
    seedCluster(store); // zone forms at t=0 (lastMembersAt 0), nextAt = 84706
    poller.setZonesConfig({ kinds: ["military"], boostMs: 10000 });
    await poller.pollZoneOnce();

    // Members gone -> the zone holds its copy on TTL and the next due tick
    // 429s: pausedUntil = 84707 + 300000 = 384707, PAST the copy's expiry.
    store.pruneAir(new Set(), 1, 0);
    mode = "zone429";
    t = 84707;
    await poller.pollZoneOnce();
    expect(zoneUrls(urls)).toHaveLength(2);

    // The slot expires with the pause still pending — the empty-slot path
    // must reset the run, not hand the stale pause to the next zone.
    t = 300_001;
    await poller.pollZoneOnce();
    expect(zoneUrls(urls)).toHaveLength(2);

    // A new cluster in the same slot polls immediately.
    t = 300_002;
    mode = "ok";
    seedCluster(store);
    await poller.pollZoneOnce();
    expect(zoneUrls(urls)).toHaveLength(3);
    expect(poller.feedStatus.boost?.paused).toBeNull();
    poller.setZonesConfig(null);
  });
});

describe("OpenSkyPoller hot-zone boost active flag", () => {
  it("boost.active stays true through the whole in-flight zone-tick window", async () => {
    const { vi } = await import("vitest"); // dynamic: the import line above is frozen
    const store = new CraftStore();
    const urls: string[] = [];
    const t = 0;
    let resolveZone!: (r: Response) => void;
    const poller = new OpenSkyPoller({
      pollMs: 120000, graceMs: 30000, store, now: () => t,
      fetchImpl: (async (url: string) => {
        urls.push(url);
        if (url.includes("lamin=")) return new Promise<Response>((r) => (resolveZone = r));
        return jsonResponse({ states: [] }, 200, { "x-rate-limit-remaining": "4000" });
      }) as typeof fetch,
    });
    vi.useFakeTimers();
    try {
      poller.start(); // real zoneTick path; globe re-poll sits at 120000, never reached
      await vi.advanceTimersByTimeAsync(1); // start's globe poll settles -> remaining captured
      seedCluster(store);
      poller.setZonesConfig({ kinds: ["military"], boostMs: 10000 });
      await vi.advanceTimersByTimeAsync(10000); // enable-arm fires: zoneTick -> pending fetch
      expect(urls).toHaveLength(2);
      expect(poller.feedStatus.boost?.active).toBe(true); // in-flight (bug: timer-identity = false)

      resolveZone(jsonResponse({ states: [] }, 200, { "x-rate-limit-remaining": "4000" }));
      await vi.advanceTimersByTimeAsync(0); // in-flight resolves, zoneTick re-arms

      poller.setZonesConfig(null);
      expect(poller.feedStatus.boost).toBeNull();
      // Re-enable must not inherit the stale due-time: the next cadence tick fetches.
      poller.setZonesConfig({ kinds: ["military"], boostMs: 10000 });
      await vi.advanceTimersByTimeAsync(10000);
      expect(urls).toHaveLength(3);
      expect(poller.feedStatus.boost?.active).toBe(true);
    } finally {
      poller.stop();
      vi.useRealTimers();
    }
  });
});

describe("OpenSkyPoller start() re-establishes boost enablement", () => {
  it("stop() clears boost.active and the next start() restores it while a config is live", async () => {
    const store = new CraftStore();
    const poller = new OpenSkyPoller({
      pollMs: 120000, graceMs: 30000, store,
      fetchImpl: (async () => jsonResponse({ states: [] })) as typeof fetch,
    });
    poller.setZonesConfig({ kinds: ["military"], boostMs: 10000 });
    expect(poller.feedStatus.boost?.active).toBe(true);
    poller.stop();
    expect(poller.feedStatus.boost?.active).toBe(false);
    poller.start(); // stop()+start() with a live config: display must not lie
    expect(poller.feedStatus.boost?.active).toBe(true);
    poller.stop();

    // No live config: a restart stays fully off.
    const cold = new OpenSkyPoller({
      pollMs: 120000, graceMs: 30000, store,
      fetchImpl: (async () => jsonResponse({ states: [] })) as typeof fetch,
    });
    cold.start();
    expect(cold.feedStatus.boost).toBeNull();
    cold.stop();
  });

  it("counts response bytes into the traffic monitor (before parsing)", async () => {
    const counted: Array<{ dir: "in" | "out"; bytes: number }> = [];
    const body = JSON.stringify({ time: 0, states: [] });
    const bad = "{oops";
    let n = 0;
    const poller = new OpenSkyPoller({
      pollMs: 1000,
      graceMs: 30000,
      store: new CraftStore(),
      traffic: { count: (dir, bytes) => counted.push({ dir, bytes }) },
      fetchImpl: (async () => new Response(n++ === 0 ? body : bad)) as typeof fetch,
    });
    expect((await poller.pollOnce()).upserted).toBe(0);
    expect(counted).toEqual([{ dir: "in", bytes: Buffer.byteLength(body) }]);
    // Malformed body (JSON.parse throws where res.json() threw): the null
    // path is intact AND the bytes are counted — they crossed the wire.
    const r = await poller.pollOnce();
    expect(r.upserted).toBe(0);
    expect(poller.feedStatus.lastError).toBe("malformed body");
    expect(counted).toHaveLength(2);
    expect(counted[1]).toEqual({ dir: "in", bytes: Buffer.byteLength(bad) });
  });
});
