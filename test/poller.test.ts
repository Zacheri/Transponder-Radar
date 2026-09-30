import { describe, it, expect, beforeAll, afterAll } from "vitest";
import http from "node:http";
import { OpenSkyPoller, BACKOFF_CAP_MS } from "../server/opensky.js";
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

  it("sends a Basic auth header when credentials are configured", async () => {
    const store = new CraftStore();
    let init: RequestInit | undefined;
    const poller = new OpenSkyPoller({
      pollMs: 1000, graceMs: 30000, store,
      username: "user", password: "pass",
      fetchImpl: (async (_url: string, options?: RequestInit) => {
        init = options;
        return jsonResponse({ states: [] });
      }) as typeof fetch,
    });
    await poller.pollOnce();
    const headers = (init?.headers ?? {}) as Record<string, string>;
    expect(headers["Authorization"]).toBe(
      "Basic " + Buffer.from("user:pass").toString("base64"),
    );
  });

  it("omits the auth header when no credentials are configured", async () => {
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
});
