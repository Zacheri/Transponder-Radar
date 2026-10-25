import { describe, it, expect } from "vitest";
import { parseRadarMessage, RadarSocket } from "../src/data/ws.js";
import { parseClientMessage } from "../server/hub.js";

const feeds = {
  opensky: { lastOkAt: 1000, lastError: null, pollMs: 120000 },
  ais: { connected: true, enabled: true, lastError: null, lastMessageAt: 900, flushMs: 1000 },
};

const history = { from: null, to: null, snapshots: 0 };

const faa = { state: "ready", updatedAt: null, aircraft: 0, lastError: null };

describe("parseRadarMessage status frames", () => {
  it("accepts a well-formed status frame", () => {
    const raw = JSON.stringify({ type: "status", feeds, history, faa, serverTime: 2000 });
    const msg = parseRadarMessage(raw);
    expect(msg).not.toBeNull();
    expect(msg?.type).toBe("status");
    if (msg?.type === "status") {
      expect(msg.feeds).toEqual(feeds);
      expect(msg.serverTime).toBe(2000);
    }
  });

  it("rejects a status frame missing feeds", () => {
    const raw = JSON.stringify({ type: "status", history, serverTime: 2000 });
    expect(parseRadarMessage(raw)).toBeNull();
  });

  it("rejects a status frame missing serverTime", () => {
    const raw = JSON.stringify({ type: "status", feeds, history });
    expect(parseRadarMessage(raw)).toBeNull();
  });

  it("rejects an unknown type", () => {
    const raw = JSON.stringify({ type: "bogus", feeds, serverTime: 2000 });
    expect(parseRadarMessage(raw)).toBeNull();
  });

  it("accepts a timeline.state frame (number time)", () => {
    const raw = JSON.stringify({ type: "timeline.state", time: 123, craft: [] });
    const msg = parseRadarMessage(raw);
    expect(msg).not.toBeNull();
    if (msg?.type === "timeline.state") expect(msg.time).toBe(123);
  });

  it("accepts a timeline.state frame (null time)", () => {
    const raw = JSON.stringify({ type: "timeline.state", time: null, craft: [] });
    expect(parseRadarMessage(raw)?.type).toBe("timeline.state");
  });

  it("rejects a status frame missing history", () => {
    const raw = JSON.stringify({ type: "status", feeds, serverTime: 2000 });
    expect(parseRadarMessage(raw)).toBeNull();
  });

  it("accepts an aircraft.info frame with a record", () => {
    const info = { nNumber: "N100GX", year: 2007, mfr: "IAI", model: "G150", owner: "X LLC", city: "PARK CITY", state: "UT", source: "db" };
    const msg = parseRadarMessage(JSON.stringify({ type: "aircraft.info", id: "a00560", info }));
    expect(msg?.type).toBe("aircraft.info");
    if (msg?.type === "aircraft.info") expect(msg.info?.nNumber).toBe("N100GX");
  });

  it("accepts an aircraft.info frame with null info", () => {
    const raw = JSON.stringify({ type: "aircraft.info", id: "a00560", info: null });
    expect(parseRadarMessage(raw)?.type).toBe("aircraft.info");
  });

  it("rejects a status frame missing faa", () => {
    const raw = JSON.stringify({ type: "status", feeds, history: { from: null, to: null, snapshots: 0 }, serverTime: 2000 });
    expect(parseRadarMessage(raw)).toBeNull();
  });
});

describe("feed.rate protocol mirror", () => {
  it("feed.rate with feed 'ais' is accepted and sent; 'bogus' rejected", () => {
    // server side: parseClientMessage
    expect(parseClientMessage(JSON.stringify({ type: "feed.rate", feed: "ais", ms: 5000 }))).toEqual({ type: "feed.rate", feed: "ais", ms: 5000 });
    expect(parseClientMessage(JSON.stringify({ type: "feed.rate", feed: "bogus", ms: 5000 }))).toBeNull();

    // client side: sendFeedRate("ais", 5000) lands on the wire
    const frames: string[] = [];
    class FakeWebSocket {
      static CONNECTING = 0;
      static OPEN = 1;
      static CLOSING = 2;
      static CLOSED = 3;
      readyState = FakeWebSocket.OPEN;
      onopen: (() => void) | null = null;
      onmessage: ((ev: { data: unknown }) => void) | null = null;
      onclose: (() => void) | null = null;
      onerror: (() => void) | null = null;
      constructor(public url: string) {}
      send(data: string) {
        frames.push(data);
      }
      close() {}
    }
    const original = globalThis.WebSocket;
    globalThis.WebSocket = FakeWebSocket as unknown as typeof WebSocket;
    try {
      const socket = new RadarSocket("ws://127.0.0.1:2001/ws", { onSnapshot: () => {}, onUpdate: () => {} });
      socket.connect();
      socket.sendFeedRate("ais", 5000);
      expect(frames).toHaveLength(1);
      expect(JSON.parse(frames[0])).toEqual({ type: "feed.rate", feed: "ais", ms: 5000 });
      socket.close();
    } finally {
      globalThis.WebSocket = original;
    }
  });
});
