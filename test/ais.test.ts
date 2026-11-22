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

import { MIN_SUBSCRIBE_SPACING_MS, shouldFallBackFollow } from "../server/ais.js";
import type { BoundingBoxes } from "../server/ais-tiles.js";
import { sleep } from "./util.js";

const BOX_A: BoundingBoxes = [[40, -74], [60, -54]];
const BOX_B: BoundingBoxes = [[0, 5], [20, 25]];

async function recordingServer(): Promise<{ port: number; frames: string[]; times: number[] }> {
  const wss = new WebSocketServer({ port: 0 });
  servers.push(wss);
  await new Promise<void>((r) => wss.once("listening", () => r()));
  const port = (wss.address() as { port: number }).port;
  const frames: string[] = [];
  const times: number[] = [];
  wss.on("connection", (socket) => {
    socket.on("message", (data) => {
      frames.push(data.toString());
      times.push(Date.now());
    });
  });
  return { port, frames, times };
}

describe("AisClient parameterization (R1 defaults)", () => {
  it("sends a byte-identical default subscribe frame with the ais log prefix", async () => {
    const { port } = await recordingServer();
    const sent: string[] = [];
    const logs: string[] = [];
    const client = new AisClient({
      url: `ws://127.0.0.1:${port}`,
      apiKey: "k",
      store: new CraftStore(),
      log: (m) => logs.push(m),
      wsImpl: (function (this: unknown, url: string, protocols?: string, opts?: Record<string, unknown>) {
        const ws = new WebSocket(url, protocols, opts);
        const orig = ws.send.bind(ws) as (d: string) => void;
        (ws as unknown as { send: (d: string) => void }).send = (d: string) => {
          sent.push(d);
          orig(d);
        };
        return ws;
      }) as unknown as typeof WebSocket,
    });
    client.start();
    await waitFor(() => sent.length === 1, 3000);
    client.stop();

    expect(sent[0]).toBe(
      '{"APIKey":"k","BoundingBoxes":[[[-90,-180],[90,180]]],"FilterMessageTypes":["PositionReport","ShipStaticData"]}',
    );
    expect(logs.some((l) => l.startsWith("ais: connected"))).toBe(true);
  });

  it("uses the custom name prefix and boxesProvider in logs and subscribe", async () => {
    const { port, frames } = await recordingServer();
    const logs: string[] = [];
    const client = new AisClient({
      url: `ws://127.0.0.1:${port}`,
      apiKey: "secret",
      store: new CraftStore(),
      name: "aiscast",
      boxesProvider: () => [BOX_A, BOX_B],
      log: (m) => logs.push(m),
    });
    client.start();
    await waitFor(() => frames.length === 1, 3000);
    client.stop();

    expect(JSON.parse(frames[0]).BoundingBoxes).toEqual([BOX_A, BOX_B]);
    expect(logs.some((l) => l.startsWith("aiscast: connected"))).toBe(true);
    expect(logs.every((l) => !l.startsWith("ais: "))).toBe(true);
  });

  it("exposes the secondaryStatus shape with empty attributions by default", () => {
    const client = new AisClient({ apiKey: "k", store: new CraftStore() });
    expect(client.secondaryStatus).toEqual({
      connected: false,
      lastError: null,
      lastMessageAt: null,
      attributions: [],
    });
  });
});

describe("AisClient setBoxes", () => {
  it("stores boxes while disconnected; the open handler sends them", async () => {
    const { port, frames } = await recordingServer();
    const client = new AisClient({ url: `ws://127.0.0.1:${port}`, apiKey: "k", store: new CraftStore() });
    client.setBoxes([BOX_B]);
    client.start();
    await waitFor(() => frames.length === 1, 3000);
    client.stop();
    expect(JSON.parse(frames[0]).BoundingBoxes).toEqual([BOX_B]);
  });

  it("coalesces a 50-call pan storm into one replacement subscribe with the latest boxes", async () => {
    const { port, frames } = await recordingServer();
    const client = new AisClient({ url: `ws://127.0.0.1:${port}`, apiKey: "k", store: new CraftStore() });
    client.start();
    await waitFor(() => client.isConnected, 3000);

    for (let i = 0; i < 50; i++) client.setBoxes([[[i, i], [i + 10, i + 10]] as BoundingBoxes]);
    await waitFor(() => frames.length === 2, 3000);
    await sleep(600);
    client.stop();

    expect(frames.length).toBe(2);
    expect(JSON.parse(frames[1]).BoundingBoxes).toEqual([[[49, 49], [59, 59]]]);
  });

  it("paces outbound subscribes at a minimum 1.1s spacing", async () => {
    const { port, frames, times } = await recordingServer();
    const client = new AisClient({
      url: `ws://127.0.0.1:${port}`,
      apiKey: "k",
      store: new CraftStore(),
      resubscribeMs: 30,
    });
    client.start();
    await waitFor(() => client.isConnected, 3000);

    for (let i = 0; i < 50; i++) client.setBoxes([BOX_B]);
    await waitFor(() => frames.length === 2, 3000);
    await sleep(400);
    client.stop();

    expect(frames.length).toBe(2);
    expect(JSON.parse(frames[1]).BoundingBoxes).toEqual([BOX_B]);
    expect(times[1] - times[0]).toBeGreaterThanOrEqual(MIN_SUBSCRIBE_SPACING_MS);
  });

  it("stop() clears the pending debounce timer and no subscribe follows", async () => {
    const { port, frames } = await recordingServer();
    const client = new AisClient({ url: `ws://127.0.0.1:${port}`, apiKey: "k", store: new CraftStore() });
    client.start();
    await waitFor(() => client.isConnected, 3000);

    client.setBoxes([BOX_A]);
    await sleep(50);
    expect((client as unknown as { resubTimer: unknown }).resubTimer).not.toBeNull();
    client.stop();
    expect((client as unknown as { resubTimer: unknown }).resubTimer).toBeNull();

    await sleep(1500);
    expect(frames.length).toBe(1);
  });
});

describe("shouldFallBackFollow", () => {
  it("fires only for an application close right after a multi-box subscribe", () => {
    expect(shouldFallBackFollow(4001, 1500, 2)).toBe(true);
    expect(shouldFallBackFollow(4000, 0, 2)).toBe(true);
    expect(shouldFallBackFollow(4001, 3000, 2)).toBe(true);
    expect(shouldFallBackFollow(4001, 3001, 2)).toBe(false);
    expect(shouldFallBackFollow(1006, 0, 2)).toBe(false);
    expect(shouldFallBackFollow(1002, 100, 2)).toBe(false);
    expect(shouldFallBackFollow(4001, 0, 1)).toBe(false);
    expect(shouldFallBackFollow(4001, 0, 0)).toBe(false);
  });
});

describe("AisClient 2-box fallback", () => {
  it("drops to the follow box and logs after a fast 2-box close", async () => {
    const wss = new WebSocketServer({ port: 0 });
    servers.push(wss);
    await new Promise<void>((r) => wss.once("listening", () => r()));
    const port = (wss.address() as { port: number }).port;
    const subs: string[] = [];
    wss.on("connection", (socket) => {
      socket.on("message", (data) => {
        const msg = data.toString();
        subs.push(msg);
        if (JSON.parse(msg).BoundingBoxes.length >= 2) socket.close(4001, "stream limit");
      });
    });

    const logs: string[] = [];
    const client = new AisClient({
      url: `ws://127.0.0.1:${port}`,
      apiKey: "k",
      store: new CraftStore(),
      name: "aiscast",
      boxesProvider: () => [BOX_A, BOX_B],
      log: (m) => logs.push(m),
    });
    client.start();
    await waitFor(() => subs.length === 2, 4000);
    client.stop();

    expect(logs.some((l) => l === "aiscast: fell back to follow tile")).toBe(true);
    expect(JSON.parse(subs[1]).BoundingBoxes).toEqual([BOX_B]);
  });
});

const posFrame = (extra: Record<string, unknown>) =>
  JSON.stringify({
    MessageType: "PositionReport",
    MMSI: 222,
    Message: { PositionReport: { Latitude: 1, Longitude: 2, Sog: 3, Cog: 4 } },
    ...extra,
  });

const staticFrame = (extra: Record<string, unknown>) =>
  JSON.stringify({
    MessageType: "ShipStaticData",
    MMSI: 222,
    Message: { ShipStaticData: { Name: "X", Type: 70 } },
    ...extra,
  });

describe("AisClient attribution", () => {
  it("tracks distinct attribution strings from PositionReport and ShipStaticData events, newest first", () => {
    let t = 1_000_000;
    const client = new AisClient({
      apiKey: "k",
      store: new CraftStore(),
      trackAttribution: true,
      now: () => t,
    });
    client.handleMessage(posFrame({ attribution: "AISHub" }));
    t += 1000;
    client.handleMessage(staticFrame({ source: "NLOB" }));
    t += 1000;
    client.handleMessage(posFrame({ license: "NLOD" }));
    t += 1000;
    client.handleMessage(posFrame({}));
    client.handleMessage(
      JSON.stringify({
        MessageType: "SubscriptionConfirmation",
        attribution: "SHOULD-NOT-TRACK",
        Message: { CompressionEnabled: false },
      }),
    );
    expect(client.secondaryStatus.attributions).toEqual(["NLOD", "NLOB", "AISHub"]);

    t += 1000;
    client.handleMessage(posFrame({ attribution: "AISHub" }));
    expect(client.secondaryStatus.attributions).toEqual(["AISHub", "NLOD", "NLOB"]);
  });

  it("prefers attribution, then source, then license", () => {
    const client = new AisClient({ apiKey: "k", store: new CraftStore(), trackAttribution: true });
    client.handleMessage(posFrame({ attribution: "A", source: "B", license: "C" }));
    client.handleMessage(posFrame({ source: "B2", license: "C" }));
    client.handleMessage(staticFrame({ license: "C3" }));
    const got = client.secondaryStatus.attributions;
    expect(got).toContain("A");
    expect(got).toContain("B2");
    expect(got).toContain("C3");
    expect(got).not.toContain("B");
    expect(got).not.toContain("C");
  });

  it("prunes attributions older than five minutes on read", () => {
    let t = 500_000;
    const client = new AisClient({
      apiKey: "k",
      store: new CraftStore(),
      trackAttribution: true,
      now: () => t,
    });
    client.handleMessage(posFrame({ attribution: "OLD" }));
    t += 300_000;
    expect(client.secondaryStatus.attributions).toEqual(["OLD"]);
    t += 1;
    expect(client.secondaryStatus.attributions).toEqual([]);
  });

  it("prunes stale attributions on event, not only on read", () => {
    let t = 500_000;
    const client = new AisClient({
      apiKey: "k",
      store: new CraftStore(),
      trackAttribution: true,
      now: () => t,
    });
    client.handleMessage(posFrame({ attribution: "OLD" }));
    t += 300_001;
    client.handleMessage(posFrame({ attribution: "NEW" }));
    expect((client as unknown as { attributions: Map<string, number> }).attributions.size).toBe(1);
  });

  it("never tracks attribution when trackAttribution is off (default)", () => {
    const client = new AisClient({ apiKey: "k", store: new CraftStore() });
    client.handleMessage(posFrame({ attribution: "AISHub" }));
    client.handleMessage(staticFrame({ source: "NLOB" }));
    expect(client.secondaryStatus.attributions).toEqual([]);
  });
});
