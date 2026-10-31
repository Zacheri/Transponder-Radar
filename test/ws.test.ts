import { describe, it, expect } from "vitest";
import { parseRadarMessage, RadarSocket } from "../src/data/ws.js";
import { parseClientMessage } from "../server/hub.js";

const feeds = {
  opensky: { lastOkAt: 1000, lastError: null, pollMs: 120000 },
  ais: { connected: true, enabled: true, lastError: null, lastMessageAt: 900, flushMs: 120000 },
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

describe("pins and window.chunk frames", () => {
  it("accepts a valid pins frame and passes the array through", () => {
    const raw = JSON.stringify({ type: "pins", pins: [{ id: "p1", from: 1, to: 2 }] });
    const msg = parseRadarMessage(raw);
    expect(msg).not.toBeNull();
    expect(msg?.type).toBe("pins");
    if (msg?.type === "pins") expect(msg.pins).toEqual([{ id: "p1", from: 1, to: 2 }]);
  });

  it("rejects a pins frame with a non-array pins field", () => {
    const raw = JSON.stringify({ type: "pins", pins: "x" });
    expect(parseRadarMessage(raw)).toBeNull();
  });

  it("accepts a valid timeline.window.chunk frame", () => {
    const raw = JSON.stringify({ type: "timeline.window.chunk", seq: 7, items: [{ ts: 1, b64: "eA==" }], done: true, reachedTo: 10 });
    const msg = parseRadarMessage(raw);
    expect(msg).not.toBeNull();
    expect(msg?.type).toBe("timeline.window.chunk");
    if (msg?.type === "timeline.window.chunk") {
      expect(msg.seq).toBe(7);
      expect(msg.items).toEqual([{ ts: 1, b64: "eA==" }]);
      expect(msg.done).toBe(true);
      expect(msg.reachedTo).toBe(10);
    }
  });

  it("rejects a chunk missing seq", () => {
    const raw = JSON.stringify({ type: "timeline.window.chunk", items: [], done: false, reachedTo: null });
    expect(parseRadarMessage(raw)).toBeNull();
  });

  it("rejects a chunk missing items", () => {
    const raw = JSON.stringify({ type: "timeline.window.chunk", seq: 1, done: false, reachedTo: null });
    expect(parseRadarMessage(raw)).toBeNull();
  });

  it("rejects a chunk missing done", () => {
    const raw = JSON.stringify({ type: "timeline.window.chunk", seq: 1, items: [], reachedTo: null });
    expect(parseRadarMessage(raw)).toBeNull();
  });

  it("rejects a chunk with a non-number reachedTo", () => {
    const raw = JSON.stringify({ type: "timeline.window.chunk", seq: 1, items: [], done: false, reachedTo: "x" });
    expect(parseRadarMessage(raw)).toBeNull();
  });

  it("accepts a status frame with the new settings/pins/staleMs fields", () => {
    const raw = JSON.stringify({ type: "status", feeds, history: { from: null, to: null, snapshots: 0, usedBytes: 0, pinnedBytes: 0, snapshotMs: 60000 }, faa, icons: { state: "absent", count: 0, updatedAt: null, lastError: null }, serverTime: 2000, settings: { storageCapGb: 4, ramCacheGb: 2, cacheUsedBytes: 100 }, pins: [{ id: "p1", from: 1, to: 2 }], staleMs: 180000 });
    const msg = parseRadarMessage(raw);
    expect(msg).not.toBeNull();
    expect(msg?.type).toBe("status");
    if (msg?.type === "status") {
      expect(msg.settings).toEqual({ storageCapGb: 4, ramCacheGb: 2, cacheUsedBytes: 100 });
      expect(msg.pins).toEqual([{ id: "p1", from: 1, to: 2 }]);
      expect(msg.staleMs).toBe(180000);
    }
  });

  it("still accepts a status frame without the new fields (back-compat)", () => {
    const raw = JSON.stringify({ type: "status", feeds, history, faa, icons: { state: "absent", count: 0, updatedAt: null, lastError: null }, serverTime: 2000 });
    const msg = parseRadarMessage(raw);
    expect(msg).not.toBeNull();
    expect(msg?.type).toBe("status");
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

describe("pins/settings/window.send helpers", () => {
  it("emit byte-exact JSON for settings.update, pin.add, pin.remove, timeline.window", () => {
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
      socket.sendSettingsUpdate({ storageCapGb: 4 });
      expect(frames[0]).toBe('{"type":"settings.update","patch":{"storageCapGb":4}}');
      socket.sendPinAdd(1, 2);
      expect(frames[1]).toBe('{"type":"pin.add","from":1,"to":2}');
      socket.sendPinRemove("p1");
      expect(frames[2]).toBe('{"type":"pin.remove","id":"p1"}');
      socket.sendTimelineWindow(7, 1, 2, 3, 4);
      expect(frames[3]).toBe('{"type":"timeline.window","seq":7,"from":1,"to":2,"stride":3,"maxBytes":4}');
      socket.close();
    } finally {
      globalThis.WebSocket = original;
    }
  });
});
