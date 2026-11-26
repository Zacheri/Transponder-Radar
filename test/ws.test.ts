import { describe, it, expect } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import WebSocketClient from "ws";
import { parseRadarMessage, RadarSocket } from "../src/data/ws.js";
import { parseClientMessage } from "../server/hub.js";
import { buildApp } from "../server/index.js";
import { CraftStore } from "../server/store.js";
import { HistoryRecorder } from "../server/history.js";
import { OpenSkyPoller } from "../server/opensky.js";
import { AisClient } from "../server/ais.js";
import type { Craft } from "../shared/craft.js";
import { sleep, waitFor } from "./util.js";

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

  it("passes through ais.secondary and settings.homeRegion (mirror fields)", () => {
    const raw = JSON.stringify({
      type: "status",
      feeds: {
        opensky: { lastOkAt: 1000, lastError: null, pollMs: 120000 },
        ais: {
          connected: true, enabled: true, lastError: null, lastMessageAt: 900, flushMs: 120000,
          secondary: { enabled: true, connected: true, lastError: null, lastMessageAt: 800, attributions: ["AISHub"] },
        },
      },
      history, faa, serverTime: 2000,
      settings: { storageCapGb: 4, ramCacheGb: 2, cacheUsedBytes: 100, homeRegion: { lat: 35, lon: 139 } },
    });
    const msg = parseRadarMessage(raw);
    expect(msg).not.toBeNull();
    if (msg?.type === "status") {
      expect(msg.feeds.ais.secondary).toEqual({ enabled: true, connected: true, lastError: null, lastMessageAt: 800, attributions: ["AISHub"] });
      expect(msg.settings?.homeRegion).toEqual({ lat: 35, lon: 139 });
    }
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

  it("emit byte-exact JSON for ais.tile and settings.update homeRegion patches", () => {
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
      socket.sendAisTile(35.25, 139.75);
      expect(frames[0]).toBe('{"type":"ais.tile","lat":35.25,"lon":139.75}');
      socket.sendSettingsUpdate({ homeRegion: { lat: 35.25, lon: 139.75 } });
      expect(frames[1]).toBe('{"type":"settings.update","patch":{"homeRegion":{"lat":35.25,"lon":139.75}}}');
      socket.sendSettingsUpdate({ homeRegion: null });
      expect(frames[2]).toBe('{"type":"settings.update","patch":{"homeRegion":null}}');
      socket.close();
    } finally {
      globalThis.WebSocket = original;
    }
  });
});

describe("timeline.seek seq echo", () => {
  it("parseClientMessage passes an optional numeric seq; absent or garbage → no seq", () => {
    expect(parseClientMessage(JSON.stringify({ type: "timeline.seek", time: 5, seq: 3 }))).toEqual({
      type: "timeline.seek",
      time: 5,
      seq: 3,
    });
    expect(parseClientMessage(JSON.stringify({ type: "timeline.seek", time: 5 }))).toEqual({
      type: "timeline.seek",
      time: 5,
    });
    expect(parseClientMessage(JSON.stringify({ type: "timeline.seek", time: 5, seq: "x" }))).toEqual({
      type: "timeline.seek",
      time: 5,
    });
  });

  it("overlapping seeks with different latencies reply in completion order, each carrying its own seq", async () => {
    const dir = await mkdtemp(join(tmpdir(), "radar-ws-seq-"));
    // Seek latency by target ts: the older target (1000) resolves slower, so
    // the replies race to the wire out of request order.
    const delays: Record<number, number> = { 1000: 120, 2000: 0 };
    class StaggeredRecorder extends HistoryRecorder {
      async seek(time: number): Promise<{ time: number | null; craft: Craft[] }> {
        const d = delays[time] ?? 0;
        if (d > 0) await sleep(d);
        return super.seek(time);
      }
    }
    let t = 0;
    const histCraft = (id: string): Craft => ({
      id, domain: "air", kind: "commercial", lat: 1, lon: 2, speed: null, heading: null, updatedAt: 0, stale: false,
    });
    const recorder = new StaggeredRecorder({ dir, snapshotMs: 60000, maxBytes: 10_000_000, now: () => (t += 1000) });
    await recorder.init();
    await recorder.recordNow(() => [histCraft("h1")]); // ts 1000
    await recorder.recordNow(() => [histCraft("h2")]); // ts 2000

    const store = new CraftStore();
    const opensky = new OpenSkyPoller({ url: "http://127.0.0.1:1/states/all", pollMs: 600000, graceMs: 30000, store });
    const ais = new AisClient({ url: "ws://127.0.0.1:1", apiKey: "test", store });
    const app = await buildApp({
      store, opensky, ais, recorder, faa: null, iconPack: null,
      fetchImpl: async () => {
        throw new Error("offline test");
      },
      settingsFile: join(dir, "settings.json"), pinFile: join(dir, "pins.json"), log: () => {},
    });
    await app.app.listen({ port: 0, host: "127.0.0.1" });
    const port = (app.app.server.address() as { port: number }).port;

    const ws = new WebSocketClient(`ws://127.0.0.1:${port}/ws`);
    const states: any[] = [];
    ws.on("message", (d) => {
      const f = JSON.parse(d.toString());
      if (f.type === "timeline.state") states.push(f);
    });
    let opened = false;
    ws.on("open", () => {
      opened = true;
    });
    await waitFor(() => opened, 3000);

    ws.send(JSON.stringify({ type: "timeline.seek", time: 1000, seq: 1 }));
    ws.send(JSON.stringify({ type: "timeline.seek", time: 2000, seq: 2 }));
    await waitFor(() => states.length >= 2, 3000);
    // The fast (newer) reply lands first — seq is what lets the client drop
    // the stale one that arrives after it.
    expect(states[0]).toMatchObject({ seq: 2, time: 2000 });
    expect(states[0].craft.map((c: Craft) => c.id)).toEqual(["h2"]);
    expect(states[1]).toMatchObject({ seq: 1, time: 1000 });
    expect(states[1].craft.map((c: Craft) => c.id)).toEqual(["h1"]);

    // Wire compat: a seek without seq is answered with seq 0.
    ws.send(JSON.stringify({ type: "timeline.seek", time: 2000 }));
    await waitFor(() => states.length >= 3, 3000);
    expect(states[2]).toMatchObject({ seq: 0, time: 2000 });

    ws.close();
    await app.stop();
    await rm(dir, { recursive: true, force: true });
  });
});

describe("flight context client protocol mirror", () => {
  it("parseRadarMessage accepts well-formed flight.track and flight.context server replies; rejects malformed", () => {
    const track = {
      type: "flight.track",
      id: "ac4963",
      seq: 3,
      path: [{ t: 1000, lat: 1, lon: 2, alt: 300, onGround: false }],
      fetchedAt: 999,
      source: "both",
      budget: { autoLeft: 10, hard: false },
    };
    expect(parseRadarMessage(JSON.stringify(track))?.type).toBe("flight.track");
    expect(parseRadarMessage(JSON.stringify({ ...track, path: "nope" }))).toBeNull();
    expect(parseRadarMessage(JSON.stringify({ ...track, fetchedAt: "x" }))).toBeNull();
    expect(parseRadarMessage(JSON.stringify({ ...track, source: "bogus" }))).toBeNull();
    expect(parseRadarMessage(JSON.stringify({ ...track, budget: undefined }))).toBeNull();
    expect(parseRadarMessage(JSON.stringify({ ...track, id: 5 }))).toBeNull();

    const ctx = { type: "flight.context", id: "ac4963", seq: 2, route: { airline: "BA", dep: null, arr: null, source: "adsbdb" } };
    expect(parseRadarMessage(JSON.stringify(ctx))?.type).toBe("flight.context");
    expect(parseRadarMessage(JSON.stringify({ ...ctx, route: null }))?.type).toBe("flight.context");
    expect(parseRadarMessage(JSON.stringify({ ...ctx, route: 5 }))).toBeNull();
    expect(parseRadarMessage(JSON.stringify({ ...ctx, id: "" }))).toBeNull();
  });

  it("sendFlightTrack / sendFlightContext emit byte-exact JSON", () => {
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
      socket.sendFlightTrack("ac4963", 4, false);
      expect(frames[0]).toBe('{"type":"flight.track","id":"ac4963","seq":4,"auto":false}');
      socket.sendFlightTrack("ac4963", 5, true);
      expect(frames[1]).toBe('{"type":"flight.track","id":"ac4963","seq":5,"auto":true}');
      socket.sendFlightContext("ac4963", 6);
      expect(frames[2]).toBe('{"type":"flight.context","id":"ac4963","seq":6}');
      socket.close();
    } finally {
      globalThis.WebSocket = original;
    }
  });

  it("onFlightTrack / onFlightContext handlers fire with parsed payloads", () => {
    let trackArgs: [string, unknown, number | undefined] | null = null;
    let ctxArgs: [string, unknown, number | undefined] | null = null;
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
      const socket = new RadarSocket("ws://127.0.0.1:2001/ws", {
        onSnapshot: () => {},
        onUpdate: () => {},
        onFlightTrack: (id, reply, seq) => (trackArgs = [id, reply, seq]),
        onFlightContext: (id, route, seq) => (ctxArgs = [id, route, seq]),
      });
      socket.connect();
      const ws = (socket as any).ws;
      ws.onmessage!({
        data: JSON.stringify({
          type: "flight.track", id: "x", seq: 1, path: [{ t: 1, lat: 1, lon: 2, alt: null, onGround: false }],
          fetchedAt: 2, source: "history", budget: { autoLeft: 3, hard: false },
        }),
      });
      ws.onmessage!({ data: JSON.stringify({ type: "flight.context", id: "x", seq: 2, route: null }) });
      expect(trackArgs![0]).toBe("x");
      expect((trackArgs![1] as any).path).toHaveLength(1);
      expect(trackArgs![2]).toBe(1);
      expect(ctxArgs![0]).toBe("x");
      expect(ctxArgs![1]).toBeNull();
      expect(ctxArgs![2]).toBe(2);
      socket.close();
    } finally {
      globalThis.WebSocket = original;
    }
  });
});

describe("zones.config client protocol mirror", () => {
  it("sendZonesConfig puts the exact frame on the wire", () => {
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
      socket.sendZonesConfig(["military", "general"], 45000);
      socket.sendZonesConfig([], 30000);
      socket.close();
      expect(frames).toHaveLength(2);
      expect(JSON.parse(frames[0])).toEqual({ type: "zones.config", kinds: ["military", "general"], boostMs: 45000 });
      expect(JSON.parse(frames[1])).toEqual({ type: "zones.config", kinds: [], boostMs: 30000 });
      // The sender-side frame must survive the server validator untouched.
      expect(frames.map((f) => parseClientMessage(f)?.type)).toEqual(["zones.config", "zones.config"]);
    } finally {
      globalThis.WebSocket = original;
    }
  });

  it("drops traffic reports sent while the socket is not OPEN (never queued)", () => {
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
      const ws = (socket as any).ws;
      socket.sendTrafficReport(100);
      ws.readyState = FakeWebSocket.CLOSED;
      socket.sendTrafficReport(50);
      socket.sendTrafficWatch(true);
      ws.readyState = FakeWebSocket.OPEN;
      socket.sendTrafficReport(25);
      socket.close();
      expect(frames.map((f) => JSON.parse(f))).toEqual([
        { type: "traffic.report", down: 100 },
        { type: "traffic.report", down: 25 },
      ]);
    } finally {
      globalThis.WebSocket = original;
    }
  });

  it("parses a status frame carrying boost + hotzones (wire fields)", () => {    const raw = JSON.stringify({
      type: "status",
      feeds: {
        opensky: { lastOkAt: 1000, lastError: null, pollMs: 90000, boost: { active: true, count: 4, intervalMs: 30000, paused: null, zones: 1 } },
        ais: { connected: true, enabled: true, lastError: null, lastMessageAt: 900, flushMs: 120000 },
      },
      history,
      faa,
      serverTime: 2000,
      hotzones: [
        { center: { lon: -74, lat: 40 }, halfW: 2.5, halfH: 2, count: 4, kind: "military" },
        { center: { lon: 10, lat: -40 }, halfW: 1, halfH: 1, count: 2, kind: "general" },
      ],
    });
    const msg = parseRadarMessage(raw);
    expect(msg?.type).toBe("status");
    if (msg?.type === "status") {
      expect(msg.feeds.opensky.boost).toEqual({ active: true, count: 4, intervalMs: 30000, paused: null, zones: 1 });
      expect(msg.hotzones).toHaveLength(2);
      expect(msg.hotzones?.[0].kind).toBe("military");
      expect(msg.hotzones?.[1].kind).toBe("general");
    }
  });

  it("parses a legacy status frame with neither field", () => {
    const raw = JSON.stringify({ type: "status", feeds, history, faa, serverTime: 2000 });
    const msg = parseRadarMessage(raw);
    if (msg?.type !== "status") throw new Error("status rejected");
    expect(msg.hotzones ?? null).toBeNull();
    expect(msg.feeds.opensky.boost ?? null).toBeNull();
  });
});

describe("traffic client protocol mirror", () => {
  const trafficSample = {
    type: "traffic",
    at: 1000,
    radar: { up: 1, down: 2, upTotal: 3, downTotal: 4 },
    device: { up: 5, down: 6, upTotal: 7, downTotal: 8 },
    top: [{ proc: "Safari", bytes: 9 }],
  };

  function withFakeSocket(): { frames: string[]; restore: () => void } {
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
    return { frames, restore: () => (globalThis.WebSocket = original) };
  }

  it("sendTrafficWatch / sendTrafficReport emit byte-exact JSON that the server validator accepts", () => {
    const { frames, restore } = withFakeSocket();
    try {
      const socket = new RadarSocket("ws://127.0.0.1:2001/ws", { onSnapshot: () => {}, onUpdate: () => {} });
      socket.connect();
      socket.sendTrafficWatch(true);
      expect(frames[0]).toBe('{"type":"traffic.watch","on":true}');
      socket.sendTrafficWatch(false);
      expect(frames[1]).toBe('{"type":"traffic.watch","on":false}');
      socket.sendTrafficReport(123456);
      expect(frames[2]).toBe('{"type":"traffic.report","down":123456}');
      // The sender-side frames must survive the server validator untouched.
      expect(frames.map((f) => parseClientMessage(f)?.type)).toEqual([
        "traffic.watch",
        "traffic.watch",
        "traffic.report",
      ]);
      socket.close();
    } finally {
      restore();
    }
  });

  it("parseRadarMessage traffic gate: server-shaped sample (incl. null device/top) in, malformed out", () => {
    expect(parseRadarMessage(JSON.stringify(trafficSample))?.type).toBe("traffic");
    expect(parseRadarMessage(JSON.stringify({ ...trafficSample, device: null, top: null }))?.type).toBe("traffic");
    expect(parseRadarMessage(JSON.stringify({ type: "traffic", radar: trafficSample.radar }))).toBeNull(); // no at
    expect(parseRadarMessage(JSON.stringify({ type: "traffic", at: 1 }))).toBeNull(); // no radar
    expect(
      parseRadarMessage(JSON.stringify({ ...trafficSample, radar: { ...trafficSample.radar, down: "x" } })),
    ).toBeNull();
    expect(
      parseRadarMessage(JSON.stringify({ ...trafficSample, device: { ...trafficSample.device, upTotal: "x" } })),
    ).toBeNull();
    expect(parseRadarMessage(JSON.stringify({ ...trafficSample, top: 5 }))).toBeNull();
  });

  it("onTraffic fires once per frame with the parsed sample", () => {
    const { restore } = withFakeSocket();
    try {
      const got: unknown[] = [];
      const socket = new RadarSocket("ws://127.0.0.1:2001/ws", {
        onSnapshot: () => {},
        onUpdate: () => {},
        onTraffic: (s) => got.push(s),
      });
      socket.connect();
      const ws = (socket as any).ws;
      ws.onmessage!({ data: JSON.stringify(trafficSample) });
      expect(got).toHaveLength(1);
      expect(got[0]).toMatchObject({ at: 1000, radar: trafficSample.radar, top: [{ proc: "Safari", bytes: 9 }] });
      socket.close();
    } finally {
      restore();
    }
  });
});
