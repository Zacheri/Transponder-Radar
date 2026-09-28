import { describe, it, expect, afterAll } from "vitest";
import { WebSocketServer } from "ws";
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
});
