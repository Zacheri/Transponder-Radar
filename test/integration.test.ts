import { describe, it, expect, beforeAll, afterAll } from "vitest";
import http from "node:http";
import WebSocket, { WebSocketServer } from "ws";
import { buildApp } from "../server/index.js";
import { CraftStore } from "../server/store.js";
import { OpenSkyPoller } from "../server/opensky.js";
import { AisClient } from "../server/ais.js";
import { Hub } from "../server/hub.js";
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
  let current: { data: (string | number | boolean | null)[][] } = { data: [] };

  beforeAll(async () => {
    httpServer = http.createServer((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(current));
    });
    await new Promise<void>((r) => httpServer.listen(0, () => r()));
    const hport = (httpServer.address() as { port: number }).port;

    wsServer = new WebSocketServer({ port: 0 });
    await new Promise<void>((r) => wsServer.once("listening", () => r()));
    const wport = (wsServer.address() as { port: number }).port;
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
    const hub = new Hub({ store, batchMs: 50 });
    const opensky = new OpenSkyPoller({
      url: `http://127.0.0.1:${hport}/states/all`,
      pollMs: 50,
      graceMs: 30000,
      store,
    });
    const ais = new AisClient({ url: `ws://127.0.0.1:${wport}`, apiKey: "test", store });

    server = await buildApp({ store, hub, opensky, ais });
    await server.app.listen({ port: 0, host: "127.0.0.1" });
    port = (server.app.server.address() as { port: number }).port;
  });

  afterAll(async () => {
    await server.stop();
    await new Promise<void>((r) => httpServer.close(() => r()));
    await new Promise<void>((r) => wsServer.close(() => r()));
  });

  it("streams a snapshot and updates for both domains", async () => {
    current = { data: [PLANE] };
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    const messages: any[] = [];
    ws.on("message", (d) => messages.push(JSON.parse(d.toString())));

    await waitFor(() => messages.length > 0, 3000);
    expect(messages[0].type).toBe("snapshot");

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
});
