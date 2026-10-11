import { describe, it, expect, afterAll } from "vitest";
import WebSocket, { WebSocketServer } from "ws";
import { AisClient } from "../server/ais.js";
import { CraftStore } from "../server/store.js";
import { waitFor } from "./util.js";

const servers: WebSocketServer[] = [];

afterAll(async () => {
  for (const s of servers) await new Promise<void>((r) => s.close(() => r()));
});

describe("AisClient.handleMessage", () => {
  it("caches static data and joins it into position reports", () => {
    const store = new CraftStore();
    const client = new AisClient({ apiKey: "k", store });
    client.handleMessage(JSON.stringify({
      MessageType: "ShipStaticData", MMSI: 368207620,
      Message: { ShipStaticData: { Name: "EXAMPLE", Type: 70, ImoNumber: 123, CallSign: "ABCDE", Destination: "RTM" } },
    }));
    client.handleMessage(JSON.stringify({
      MessageType: "PositionReport", MMSI: 368207620,
      Message: { PositionReport: { Latitude: 51.5, Longitude: -0.1, Sog: 12.5, Cog: 90, NavigationalStatus: 0 } },
    }));
    const c = store.get("368207620")!;
    expect(c.kind).toBe("cargo");
    expect(c.shipName).toBe("EXAMPLE");
    expect(c.destination).toBe("RTM");
    expect(c.speed).toBeCloseTo(12.5);
  });

  it("ignores malformed JSON", () => {
    const store = new CraftStore();
    const client = new AisClient({ apiKey: "k", store });
    expect(() => client.handleMessage("not json")).not.toThrow();
    expect(store.size).toBe(0);
  });
});

describe("AisClient connection", () => {
  it("connects, receives frames, updates store", async () => {
    const wss = new WebSocketServer({ port: 0 });
    servers.push(wss);
    await new Promise<void>((r) => wss.once("listening", () => r()));
    const port = (wss.address() as { port: number }).port;
    wss.on("connection", (socket) => {
      socket.send(JSON.stringify({
        MessageType: "ShipStaticData", MMSI: 111,
        Message: { ShipStaticData: { Name: "SHIP", Type: 70 } },
      }));
      socket.send(JSON.stringify({
        MessageType: "PositionReport", MMSI: 111,
        Message: { PositionReport: { Latitude: 10, Longitude: 20, Sog: 5, Cog: 45 } },
      }));
    });

    const store = new CraftStore();
    const client = new AisClient({ url: `ws://127.0.0.1:${port}`, apiKey: "k", store });
    client.start();

    await waitFor(() => store.size === 1, 3000);
    expect(store.get("111")!.kind).toBe("cargo");
    expect(store.get("111")!.shipName).toBe("SHIP");

    client.stop();
  });

  it("terminates and reconnects when pongs stop arriving", async () => {
    const wss = new WebSocketServer({ port: 0, autoPong: false });
    servers.push(wss);
    await new Promise<void>((r) => wss.once("listening", () => r()));
    const port = (wss.address() as { port: number }).port;
    let connections = 0;
    let pings = 0;
    wss.on("connection", (socket) => {
      connections += 1;
      socket.on("ping", () => pings++);
    });

    const client = new AisClient({
      url: `ws://127.0.0.1:${port}`,
      apiKey: "k",
      store: new CraftStore(),
      pingIntervalMs: 50,
      pingTimeoutMs: 150,
    });
    client.start();
    await waitFor(() => client.isConnected, 3000);
    await waitFor(() => connections >= 2, 3000);
    client.stop();

    expect(pings).toBeGreaterThanOrEqual(1);
    expect(connections).toBeGreaterThanOrEqual(2);
  });

  it("records close code and reason as lastError in feedStatus", async () => {
    const wss = new WebSocketServer({ port: 0 });
    servers.push(wss);
    await new Promise<void>((r) => wss.once("listening", () => r()));
    const port = (wss.address() as { port: number }).port;
    wss.on("connection", (socket) => socket.close(4001, "quota exceeded"));

    const client = new AisClient({ url: `ws://127.0.0.1:${port}`, apiKey: "k", store: new CraftStore() });
    client.start();
    await waitFor(() => client.feedStatus.lastError != null, 3000);
    expect(client.feedStatus.lastError).toBe("closed 4001: quota exceeded");
    client.stop();
  });

  it("tracks lastMessageAt when AIS messages arrive", async () => {
    const wss = new WebSocketServer({ port: 0 });
    servers.push(wss);
    await new Promise<void>((r) => wss.once("listening", () => r()));
    const port = (wss.address() as { port: number }).port;
    wss.on("connection", (socket) => {
      socket.send(JSON.stringify({
        MessageType: "PositionReport", MMSI: 111,
        Message: { PositionReport: { Latitude: 10, Longitude: 20, Sog: 5, Cog: 45 } },
      }));
    });

    const store = new CraftStore();
    const client = new AisClient({ url: `ws://127.0.0.1:${port}`, apiKey: "k", store });
    client.start();
    await waitFor(() => store.size === 1, 3000);
    client.stop();
    expect(client.feedStatus.lastMessageAt).not.toBeNull();
  });

  it("logs subscription confirmation with compression state", async () => {
    const wss = new WebSocketServer({ port: 0 });
    servers.push(wss);
    await new Promise<void>((r) => wss.once("listening", () => r()));
    const port = (wss.address() as { port: number }).port;
    wss.on("connection", (socket) => {
      socket.send(JSON.stringify({ MessageType: "SubscriptionConfirmation", Message: { CompressionEnabled: true } }));
    });

    const logs: string[] = [];
    const client = new AisClient({
      url: `ws://127.0.0.1:${port}`,
      apiKey: "k",
      store: new CraftStore(),
      log: (m) => logs.push(m),
    });
    client.start();
    await waitFor(() => logs.some((l) => l.includes("ais: subscribed")), 3000);
    client.stop();
    expect(logs.some((l) => l.includes("compression: true"))).toBe(true);
  });

  it("negotiates permessage-deflate with the server", async () => {
    const wss = new WebSocketServer({ port: 0, perMessageDeflate: true });
    servers.push(wss);
    await new Promise<void>((r) => wss.once("listening", () => r()));
    const port = (wss.address() as { port: number }).port;
    let negotiated: string | null = null;
    wss.on("connection", (socket) => {
      negotiated = socket.extensions;
    });

    const seen: Array<Record<string, unknown> | undefined> = [];
    const client = new AisClient({
      url: `ws://127.0.0.1:${port}`,
      apiKey: "k",
      store: new CraftStore(),
      wsImpl: (function (this: unknown, url: string, protocols?: string, opts?: Record<string, unknown>) {
        seen.push(opts);
        return new WebSocket(url, protocols, opts);
      }) as unknown as typeof WebSocket,
    });
    client.start();
    await waitFor(() => client.isConnected, 3000);
    client.stop();

    expect(seen[0]).toEqual(expect.objectContaining({ perMessageDeflate: true }));
    expect(negotiated).toContain("permessage-deflate");
  });
});
