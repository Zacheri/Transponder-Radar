import { describe, it, expect, beforeAll, afterAll } from "vitest";
import http from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import WebSocket, { WebSocketServer } from "ws";
import { buildApp } from "../server/index.js";
import { CraftStore } from "../server/store.js";
import { OpenSkyPoller } from "../server/opensky.js";
import { AisClient } from "../server/ais.js";
import { Hub } from "../server/hub.js";
import { HistoryRecorder } from "../server/history.js";
import type { Craft } from "../shared/craft.js";
import { waitFor } from "./util.js";

const PLANE: (string | number | boolean | null)[] = [
  "ac4963", "DAL539", "United States", 1700000000, 1700000000,
  -73.7, 40.6, 10000, false, 250, 90, 10, null, 10050, "1200", false, 2,
];

describe("full pipeline (stub feeds -> hub)", () => {
  let httpServer: http.Server;
  let wsServer: WebSocketServer;
  let server: Awaited<ReturnType<typeof buildApp>>;
  let port: number;
  let hport: number;
  let wport: number;
  let current: { time: number; states: (string | number | boolean | null)[][] } = { time: 0, states: [] };

  beforeAll(async () => {
    httpServer = http.createServer((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(current));
    });
    await new Promise<void>((r) => httpServer.listen(0, () => r()));
    hport = (httpServer.address() as { port: number }).port;

    wsServer = new WebSocketServer({ port: 0 });
    await new Promise<void>((r) => wsServer.once("listening", () => r()));
    wport = (wsServer.address() as { port: number }).port;
    wsServer.on("connection", (socket) => {
      socket.send(JSON.stringify({
        MessageType: "ShipStaticData", MMSI: 999,
        Message: { ShipStaticData: { Name: "PIPELINE SHIP", Type: 70 } },
      }));
      socket.send(JSON.stringify({
        MessageType: "PositionReport", MMSI: 999,
        Message: { PositionReport: { Latitude: 50, Longitude: 5, Sog: 8, Cog: 180 } },
      }));
    });

    const store = new CraftStore();
    const opensky = new OpenSkyPoller({
      url: `http://127.0.0.1:${hport}/states/all`,
      pollMs: 50,
      graceMs: 30000,
      store,
    });
    const ais = new AisClient({ url: `ws://127.0.0.1:${wport}`, apiKey: "test", store });
    const hub = new Hub({
      store,
      batchMs: 50,
      statusPayload: () => ({
        feeds: {
          opensky: opensky.feedStatus,
          ais: { connected: ais.isConnected, enabled: true },
        },
        history: { from: null, to: null, snapshots: 0 },
      }),
    });

    server = await buildApp({ store, hub, opensky, ais, recorder: null });
    await server.app.listen({ port: 0, host: "127.0.0.1" });
    port = (server.app.server.address() as { port: number }).port;
  });

  afterAll(async () => {
    await server.stop();
    await new Promise<void>((r) => httpServer.close(() => r()));
    await new Promise<void>((r) => wsServer.close(() => r()));
  });

  it("streams a snapshot and updates for both domains", async () => {
    current = { time: 0, states: [PLANE] };
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    const messages: any[] = [];
    ws.on("message", (d) => messages.push(JSON.parse(d.toString())));

    await waitFor(() => messages.length > 0, 3000);
    expect(messages[0].type).toBe("snapshot");

    await waitFor(() => messages.some((m) => m.type === "status"), 3000);
    const st = messages.find((m) => m.type === "status");
    expect(st.feeds.opensky.pollMs).toBeTypeOf("number");
    expect(st.history).toEqual({ from: null, to: null, snapshots: 0 });

    await waitFor(() => {
      const all = messages.flatMap((m) => m.upsert ?? (m.type === "snapshot" ? m.craft : []));
      return all.some((c: any) => c.id === "ac4963") && all.some((c: any) => c.id === "999");
    }, 3000);

    const all = messages.flatMap((m) => m.upsert ?? (m.type === "snapshot" ? m.craft : []));
    const plane = all.find((c: any) => c.id === "ac4963");
    const ship = all.find((c: any) => c.id === "999");
    expect(plane.domain).toBe("air");
    expect(ship.domain).toBe("sea");
    expect(ship.kind).toBe("cargo");
    expect(ship.shipName).toBe("PIPELINE SHIP");
    ws.close();
  });

  it("poll.rate frame changes the effective poll interval", async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    let opened = false;
    ws.on("open", () => {
      opened = true;
    });
    await waitFor(() => opened, 3000);
    ws.send(JSON.stringify({ type: "poll.rate", ms: 60000 }));
    await waitFor(() => server.opensky.feedStatus.pollMs === 60000, 3000);
    expect(server.opensky.feedStatus.pollMs).toBe(60000);
    ws.close();
  });

  it("timeline.seek / timeline.live end-to-end (real recorder, incl. missing-snapshot error path)", async () => {
    const dir = await mkdtemp(join(tmpdir(), "radar-hist-it-"));
    let t = Date.now();
    const histCraft = (id: string): Craft => ({
      id, domain: "air", kind: "commercial", lat: 1, lon: 2, speed: null, heading: null, updatedAt: 0, stale: false,
    });
    const recorder = new HistoryRecorder({
      dir,
      snapshotMs: 60000,
      maxBytes: 10_000_000,
      now: () => (t += 1000),
    });
    await recorder.recordNow(() => [histCraft("h1")]);
    await recorder.recordNow(() => [histCraft("h2")]);
    const t2 = t;

    const store = new CraftStore();
    const hub = new Hub({ store, batchMs: 50 });
    const opensky = new OpenSkyPoller({
      url: `http://127.0.0.1:${hport}/states/all`,
      pollMs: 60000,
      graceMs: 30000,
      store,
    });
    const ais = new AisClient({ url: `ws://127.0.0.1:${wport}`, apiKey: "test", store });
    const app2 = await buildApp({ store, hub, opensky, ais, recorder });
    await app2.app.listen({ port: 0, host: "127.0.0.1" });
    const port2 = (app2.app.server.address() as { port: number }).port;

    const ws = new WebSocket(`ws://127.0.0.1:${port2}/ws`);
    const messages: any[] = [];
    ws.on("message", (d) => messages.push(JSON.parse(d.toString())));
    let opened = false;
    ws.on("open", () => {
      opened = true;
    });
    await waitFor(() => opened, 3000);

    ws.send(JSON.stringify({ type: "timeline.seek", time: t2 }));
    await waitFor(() => messages.some((m) => m.type === "timeline.state"), 3000);
    const st = messages.find((m) => m.type === "timeline.state");
    expect(st.time).toBe(t2);
    expect(st.craft.map((c: any) => c.id)).toEqual(["h2"]);

    await rm(join(dir, `${t2}.json.gz`));
    ws.send(JSON.stringify({ type: "timeline.seek", time: t2 }));
    await waitFor(() => messages.filter((m) => m.type === "timeline.state").length >= 2, 3000);
    const st2 = messages.filter((m) => m.type === "timeline.state").pop();
    expect(st2.time).toBeNull();
    expect(st2.craft).toEqual([]);

    const snapsBefore = messages.filter((m) => m.type === "snapshot").length;
    ws.send(JSON.stringify({ type: "timeline.live" }));
    await waitFor(() => messages.filter((m) => m.type === "snapshot").length > snapsBefore, 3000);
    const live = messages.filter((m) => m.type === "snapshot").pop();
    expect(Array.isArray(live.craft)).toBe(true);
    expect(ws.readyState).toBe(WebSocket.OPEN);

    ws.close();
    await app2.stop();
    await rm(dir, { recursive: true, force: true });
  });
});
