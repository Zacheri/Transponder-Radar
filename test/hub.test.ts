import { describe, it, expect, afterEach, vi } from "vitest";
import { Hub, parseClientMessage, type FeedStatus } from "../server/hub.js";
import type { HistoryRange } from "../server/history.js";
import type { IconStatus } from "../server/iconpack.js";
import { CraftStore } from "../server/store.js";
import type { Craft } from "../shared/craft.js";
import { sleep, waitFor } from "./util.js";

function air(id: string): Craft {
  return { id, domain: "air", kind: "commercial", lat: 0, lon: 0, speed: null, heading: null, updatedAt: 0, stale: false };
}

function sea(id: string, lat = 0): Craft {
  return { id, domain: "sea", kind: "cargo", lat, lon: 0, speed: null, heading: null, updatedAt: 0, stale: false };
}

function fakeSocket() {
  const sent: string[] = [];
  const handlers: Record<string, Array<(...a: any[]) => void>> = {};
  return {
    sent,
    send(data: string) {
      sent.push(data);
    },
    on(event: string, cb: (...a: any[]) => void) {
      (handlers[event] ??= []).push(cb);
    },
    removeListener(event: string, cb: (...a: any[]) => void) {
      handlers[event] = (handlers[event] ?? []).filter((h) => h !== cb);
    },
    close() {},
    emit(event: string, ...args: any[]) {
      (handlers[event] ?? []).forEach((h) => h(...args));
    },
  };
}

const ICONS_STUB: IconStatus = { state: "ready", count: 0, updatedAt: null, lastError: null };

function statusFrames(sent: string[]) {
  return sent
    .map((s) => JSON.parse(s) as { type: string; feeds?: any; history?: any; serverTime?: number })
    .filter((m) => m.type === "status");
}

function updateFrames(sent: string[]) {
  return sent
    .map((s) => JSON.parse(s) as { type: string; upsert?: Craft[]; remove?: string[] })
    .filter((m) => m.type === "update") as { type: string; upsert: Craft[]; remove: string[] }[];
}

describe("Hub", () => {
  it("sends a snapshot on attach", () => {
    const store = new CraftStore();
    store.upsert(air("a1"), 0);
    const hub = new Hub({ store, batchMs: 1000 });
    const sock = fakeSocket();
    hub.attach(sock);
    expect(sock.sent).toHaveLength(1);
    const msg = JSON.parse(sock.sent[0]);
    expect(msg.type).toBe("snapshot");
    expect(msg.craft.map((c: Craft) => c.id)).toContain("a1");
  });

  it("broadcasts batched updates", async () => {
    const store = new CraftStore();
    const hub = new Hub({ store, batchMs: 30 });
    const sock = fakeSocket();
    hub.attach(sock);
    hub.start();
    store.upsert(air("a2"), 0);
    // Ticks run on the fixed 250 ms hub interval (Task 2), so wait for the
    // batched frame instead of a fixed sleep.
    await waitFor(() => updateFrames(sock.sent).some((m) => m.upsert.some((c) => c.id === "a2")));
    const updates = updateFrames(sock.sent);
    expect(updates.length).toBeGreaterThanOrEqual(1);
    expect(updates[0].upsert.map((c: Craft) => c.id)).toContain("a2");
    hub.stop();
  });

  it("removes closed clients", () => {
    const store = new CraftStore();
    const hub = new Hub({ store, batchMs: 1000 });
    const sock = fakeSocket();
    hub.attach(sock);
    expect(hub.clientCount).toBe(1);
    sock.emit("close");
    expect(hub.clientCount).toBe(0);
  });

  it("broadcasts a status frame when the feed status changes", async () => {
    const store = new CraftStore();
    let feeds: FeedStatus = {
      opensky: { lastOkAt: null, lastError: null, pollMs: 120000 },
      ais: { connected: false, enabled: false, lastError: null, lastMessageAt: null, flushMs: 1000 },
    };
    const hub = new Hub({ store, batchMs: 20, statusPayload: () => ({ feeds, history: { from: null, to: null, snapshots: 0 }, faa: { state: "ready", updatedAt: null, aircraft: 0, lastError: null }, icons: ICONS_STUB }) });
    const sock = fakeSocket();
    hub.attach(sock);
    hub.start();
    feeds = {
      opensky: { lastOkAt: 123, lastError: null, pollMs: 120000 },
      ais: { connected: true, enabled: true, lastError: null, lastMessageAt: 456, flushMs: 1000 },
    };
    await waitFor(() => statusFrames(sock.sent).length >= 2);
    const frames = statusFrames(sock.sent);
    const last = frames[frames.length - 1];
    expect(last.feeds.opensky.lastOkAt).toBe(123);
    expect(last.feeds.ais.connected).toBe(true);
    expect(last.feeds.ais.lastMessageAt).toBe(456);
    expect(typeof last.serverTime).toBe("number");
    hub.stop();
  });

  it("does not re-broadcast an unchanged feed status", async () => {
    const store = new CraftStore();
    const feeds = {
      opensky: { lastOkAt: null, lastError: null, pollMs: 120000 },
      ais: { connected: false, enabled: false, lastError: null, lastMessageAt: null, flushMs: 1000 },
    };
    const hub = new Hub({ store, batchMs: 20, statusPayload: () => ({ feeds, history: { from: null, to: null, snapshots: 0 }, faa: { state: "ready", updatedAt: null, aircraft: 0, lastError: null }, icons: ICONS_STUB }) });
    const sock = fakeSocket();
    hub.attach(sock);
    hub.start();
    await waitFor(() => statusFrames(sock.sent).length >= 2);
    const count = statusFrames(sock.sent).length;
    await sleep(80);
    expect(statusFrames(sock.sent)).toHaveLength(count);
    hub.stop();
  });

  it("attach sends the snapshot then the status", () => {
    const store = new CraftStore();
    const feeds = {
      opensky: { lastOkAt: null, lastError: "HTTP 429", pollMs: 120000 },
      ais: { connected: false, enabled: true, lastError: "closed 1006", lastMessageAt: null, flushMs: 1000 },
    };
    const hub = new Hub({ store, batchMs: 1000, statusPayload: () => ({ feeds, history: { from: null, to: null, snapshots: 0 }, faa: { state: "ready", updatedAt: null, aircraft: 0, lastError: null }, icons: ICONS_STUB }) });
    const sock = fakeSocket();
    hub.attach(sock);
    expect(sock.sent).toHaveLength(2);
    expect(JSON.parse(sock.sent[0]).type).toBe("snapshot");
    const st = JSON.parse(sock.sent[1]);
    expect(st.type).toBe("status");
    expect(st.feeds).toEqual(feeds);
    expect(typeof st.serverTime).toBe("number");
  });

  it("status frames carry history bounds", async () => {
    const store = new CraftStore();
    let history: HistoryRange = { from: null, to: null, snapshots: 0 };
    const feeds = { opensky: { lastOkAt: null, lastError: null, pollMs: 120000 }, ais: { connected: false, enabled: false, lastError: null, lastMessageAt: null, flushMs: 1000 } };
    const hub = new Hub({ store, batchMs: 20, statusPayload: () => ({ feeds, history, faa: { state: "ready", updatedAt: null, aircraft: 0, lastError: null }, icons: ICONS_STUB }) });
    const sock = fakeSocket();
    hub.attach(sock);
    const st = JSON.parse(sock.sent[1]);
    expect(st.history).toEqual({ from: null, to: null, snapshots: 0 });
    expect(st.faa.state).toBe("ready");
    history = { from: 100, to: 200, snapshots: 2 };
    hub.start();
    await waitFor(() => statusFrames(sock.sent).length >= 2);
    const last = statusFrames(sock.sent)[statusFrames(sock.sent).length - 1];
    expect(last.history).toEqual({ from: 100, to: 200, snapshots: 2 });
    hub.stop();
  });

  it("status frames carry the icons block", () => {
    const store = new CraftStore();
    const icons: IconStatus = { state: "downloading", count: 0, updatedAt: null, lastError: null };
    const hub = new Hub({
      store,
      batchMs: 1000,
      statusPayload: () => ({
        feeds: {
          opensky: { lastOkAt: null, lastError: null, pollMs: 120000 },
          ais: { connected: false, enabled: false, lastError: null, lastMessageAt: null, flushMs: 1000 },
        },
        history: { from: null, to: null, snapshots: 0 },
        faa: { state: "ready", updatedAt: null, aircraft: 0, lastError: null },
        icons,
      }),
    });
    const sock = fakeSocket();
    hub.attach(sock);
    const st = JSON.parse(sock.sent[1]);
    expect(st.type).toBe("status");
    expect(st.icons).toEqual(icons);
  });
});

describe("per-feed flush windows", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("air flushes on batchMs, sea held until its window (default = batchMs)", () => {
    vi.useFakeTimers();
    const store = new CraftStore();
    const hub = new Hub({ store, batchMs: 1000, aisFlushMs: 2000 });
    const sock = fakeSocket();
    hub.attach(sock);
    store.upsert(air("A"), 0);
    store.upsert(sea("S"), 0);
    hub.start();
    vi.advanceTimersByTime(1000);
    let frames = updateFrames(sock.sent);
    expect(frames).toHaveLength(1);
    expect(frames[0].upsert.map((c) => c.id)).toEqual(["A"]);
    vi.advanceTimersByTime(1000);
    frames = updateFrames(sock.sent);
    expect(frames).toHaveLength(2);
    expect(frames[1].upsert.map((c) => c.id)).toEqual(["S"]);
    hub.stop();
  });

  it("air and sea due together → single combined frame", () => {
    vi.useFakeTimers();
    const store = new CraftStore();
    const hub = new Hub({ store, batchMs: 1000, aisFlushMs: 1000 });
    const sock = fakeSocket();
    hub.attach(sock);
    store.upsert(air("A"), 0);
    store.upsert(sea("S"), 0);
    hub.start();
    vi.advanceTimersByTime(1000);
    const frames = updateFrames(sock.sent);
    expect(frames).toHaveLength(1);
    expect(frames[0].upsert.map((c) => c.id).sort()).toEqual(["A", "S"]);
    expect(frames[0].remove).toEqual([]);
    hub.stop();
  });

  it("setAisFlushMs changes the sea window live", () => {
    vi.useFakeTimers();
    const store = new CraftStore();
    const hub = new Hub({ store, batchMs: 1000 });
    expect(hub.aisFlushMs).toBe(1000); // default = batchMs
    const sock = fakeSocket();
    hub.attach(sock);
    hub.start();
    vi.advanceTimersByTime(500); // t=500
    hub.setAisFlushMs(3000);
    vi.advanceTimersByTime(100); // t=600
    store.upsert(sea("S"), 600);
    vi.advanceTimersByTime(1400); // t=2000
    expect(updateFrames(sock.sent)).toHaveLength(0);
    vi.advanceTimersByTime(1000); // t=3000
    const frames = updateFrames(sock.sent);
    expect(frames).toHaveLength(1);
    expect(frames[0].upsert.map((c) => c.id)).toEqual(["S"]);
    hub.stop();
  });

  it("setAisFlushMs clamps to [500, 15000]", () => {
    const store = new CraftStore();
    const hub = new Hub({ store, batchMs: 1000 });
    hub.setAisFlushMs(10);
    expect(hub.aisFlushMs).toBe(500);
    hub.setAisFlushMs(99999);
    expect(hub.aisFlushMs).toBe(15000);
    hub.setAisFlushMs(7000);
    expect(hub.aisFlushMs).toBe(7000);
  });

  it("unflushed sea craft stays fresh in the store", () => {
    vi.useFakeTimers();
    const store = new CraftStore();
    const hub = new Hub({ store, batchMs: 1000, aisFlushMs: 10000 });
    const sock = fakeSocket();
    hub.attach(sock);
    store.upsert(sea("S", 0), 0);
    hub.start();
    vi.advanceTimersByTime(1000); // t=1000: sea window (10000) not due
    store.upsert(sea("S", 5), 1000);
    expect(store.get("S")?.lat).toBe(5);
    // stream untouched: nothing has been flushed to the wire yet
    expect(updateFrames(sock.sent)).toHaveLength(0);
    hub.stop();
  });
});

describe("parseClientMessage", () => {
  it("accepts well-formed control frames", () => {
    expect(parseClientMessage(JSON.stringify({ type: "feed.rate", feed: "opensky", ms: 60000 }))).toEqual({ type: "feed.rate", feed: "opensky", ms: 60000 });
    expect(parseClientMessage(JSON.stringify({ type: "timeline.seek", time: 123 }))).toEqual({ type: "timeline.seek", time: 123 });
    expect(parseClientMessage(JSON.stringify({ type: "timeline.live" }))).toEqual({ type: "timeline.live" });
    expect(parseClientMessage(JSON.stringify({ type: "aircraft.info", id: "ac4963" }))).toEqual({ type: "aircraft.info", id: "ac4963" });
  });

  it("rejects malformed frames", () => {
    expect(parseClientMessage("not json")).toBeNull();
    expect(parseClientMessage(JSON.stringify({ type: "feed.rate" }))).toBeNull();
    expect(parseClientMessage(JSON.stringify({ type: "feed.rate", feed: "opensky" }))).toBeNull();
    expect(parseClientMessage(JSON.stringify({ type: "feed.rate", feed: "opensky", ms: -5 }))).toBeNull();
    expect(parseClientMessage(JSON.stringify({ type: "feed.rate", feed: "opensky", ms: "60000" }))).toBeNull();
    expect(parseClientMessage(JSON.stringify({ type: "feed.rate", feed: "nope", ms: 60000 }))).toBeNull();
    expect(parseClientMessage(JSON.stringify({ type: "poll.rate", ms: 60000 }))).toBeNull();
    expect(parseClientMessage(JSON.stringify({ type: "timeline.seek" }))).toBeNull();
    expect(parseClientMessage(JSON.stringify({ type: "aircraft.info", id: "" }))).toBeNull();
    expect(parseClientMessage(JSON.stringify({ type: "bogus" }))).toBeNull();
  });
});
