import { describe, it, expect, beforeAll, afterAll } from "vitest";
import http from "node:http";
import { OpenSkyPoller } from "../server/opensky.js";
import { CraftStore } from "../server/store.js";

const PLANE: (string | number | boolean | null)[] = [
  "ac4963", "DAL539", "United States", 1700000000, 1700000000,
  -73.7, 40.6, 10000, false, 250, 90, 10, null, 10050, "1200", false, 2,
];

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
    const count = await poller.pollOnce();
    expect(count).toBe(1);
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
    await expect(dead.pollOnce()).rejects.toThrow();
    expect(store.size).toBe(1); // unchanged — a failed poll must not prune
  });
});
