import { describe, it, expect, afterEach, vi } from "vitest";
import { Hub, AIS_FLUSH_DEFAULT_MS, TRAFFIC_REPORT_MAX_BYTES, parseClientMessage, type FeedStatus, type StatusPayload } from "../server/hub.js";
import type { HistoryStatus } from "../server/history.js";
import type { Pin } from "../server/pins.js";
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

const SECONDARY = { enabled: false, connected: false, lastError: null, lastMessageAt: null, attributions: [] as string[] };

function historyStatus(over: Partial<HistoryStatus> = {}): HistoryStatus {
  return { from: null, to: null, snapshots: 0, usedBytes: 0, pinnedBytes: 0, snapshotMs: 60000, ...over };
}

function payload(feeds: FeedStatus, history: HistoryStatus = historyStatus(), over: Partial<StatusPayload> = {}): StatusPayload {
  return {
    feeds,
    history,
    settings: { storageCapGb: 10, ramCacheGb: 1, cacheUsedBytes: 0, homeRegion: null },
    pins: [],
    staleMs: 120000,
    faa: { state: "ready", updatedAt: null, aircraft: 0, lastError: null },
    icons: ICONS_STUB,
    hotzone: null,
    ...over,
  };
}

function statusFrames(sent: string[]) {
  return sent
    .map((s) => JSON.parse(s) as { type: string; feeds?: any; history?: any; settings?: any; pins?: any; staleMs?: number; serverTime?: number })
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
    // Ticks run on the fixed 250 ms hub interval, so wait for the
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
      ais: { connected: false, enabled: false, lastError: null, lastMessageAt: null, flushMs: 120000, secondary: SECONDARY },
    };
    const hub = new Hub({ store, batchMs: 20, statusPayload: () => payload(feeds) });
    const sock = fakeSocket();
    hub.attach(sock);
    hub.start();
    feeds = {
      opensky: { lastOkAt: 123, lastError: null, pollMs: 120000 },
      ais: { connected: true, enabled: true, lastError: null, lastMessageAt: 456, flushMs: 120000, secondary: { ...SECONDARY, enabled: true, connected: true } },
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
      ais: { connected: false, enabled: false, lastError: null, lastMessageAt: null, flushMs: 120000, secondary: SECONDARY },
    };
    const hub = new Hub({ store, batchMs: 20, statusPayload: () => payload(feeds) });
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
      ais: { connected: false, enabled: true, lastError: "closed 1006", lastMessageAt: null, flushMs: 120000, secondary: { ...SECONDARY, enabled: true } },
    };
    const hub = new Hub({ store, batchMs: 1000, statusPayload: () => payload(feeds) });
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
    let history: HistoryStatus = historyStatus();
    const feeds = { opensky: { lastOkAt: null, lastError: null, pollMs: 120000 }, ais: { connected: false, enabled: false, lastError: null, lastMessageAt: null, flushMs: 120000, secondary: SECONDARY } };
    const hub = new Hub({ store, batchMs: 20, statusPayload: () => payload(feeds, history) });
    const sock = fakeSocket();
    hub.attach(sock);
    const st = JSON.parse(sock.sent[1]);
    expect(st.history).toEqual({ from: null, to: null, snapshots: 0, usedBytes: 0, pinnedBytes: 0, snapshotMs: 60000 });
    expect(st.faa.state).toBe("ready");
    history = historyStatus({ from: 100, to: 200, snapshots: 2 });
    hub.start();
    await waitFor(() => statusFrames(sock.sent).length >= 2);
    const last = statusFrames(sock.sent)[statusFrames(sock.sent).length - 1];
    expect(last.history).toEqual({ from: 100, to: 200, snapshots: 2, usedBytes: 0, pinnedBytes: 0, snapshotMs: 60000 });
    hub.stop();
  });

  it("status frames carry the icons block", () => {
    const store = new CraftStore();
    const icons: IconStatus = { state: "downloading", count: 0, updatedAt: null, lastError: null };
    const feeds = {
      opensky: { lastOkAt: null, lastError: null, pollMs: 120000 },
      ais: { connected: false, enabled: false, lastError: null, lastMessageAt: null, flushMs: 120000, secondary: SECONDARY },
    };
    const hub = new Hub({ store, batchMs: 1000, statusPayload: () => ({ ...payload(feeds), icons }) });
    const sock = fakeSocket();
    hub.attach(sock);
    const st = JSON.parse(sock.sent[1]);
    expect(st.type).toBe("status");
    expect(st.icons).toEqual(icons);
  });

  it("status frame carries the settings, pins, and staleMs fields", () => {
    const store = new CraftStore();
    const feeds: FeedStatus = {
      opensky: { lastOkAt: null, lastError: null, pollMs: 120000 },
      ais: { connected: false, enabled: false, lastError: null, lastMessageAt: null, flushMs: 120000, secondary: SECONDARY },
    };
    const hub = new Hub({ store, batchMs: 1000, statusPayload: () => payload(feeds) });
    const sock = fakeSocket();
    hub.attach(sock);
    const st = JSON.parse(sock.sent[1]);
    expect(st.settings).toEqual({ storageCapGb: 10, ramCacheGb: 1, cacheUsedBytes: 0, homeRegion: null });
    expect(st.pins).toEqual([]);
    expect(st.staleMs).toBe(120000);
    expect(st.history).toEqual({ from: null, to: null, snapshots: 0, usedBytes: 0, pinnedBytes: 0, snapshotMs: 60000 });
  });

  it("tick re-broadcasts only when the payload changes (new fields included)", async () => {
    const store = new CraftStore();
    const feeds: FeedStatus = {
      opensky: { lastOkAt: null, lastError: null, pollMs: 120000 },
      ais: { connected: false, enabled: false, lastError: null, lastMessageAt: null, flushMs: 120000, secondary: SECONDARY },
    };
    let pins: Pin[] = [];
    const hub = new Hub({ store, batchMs: 1000, statusPayload: () => payload(feeds, historyStatus(), { pins }) });
    const sock = fakeSocket();
    hub.attach(sock);
    hub.start();
    // Attach frame + first tick (the dedupe key starts unset) = 2 frames.
    await waitFor(() => statusFrames(sock.sent).length >= 2);
    const before = statusFrames(sock.sent).length;
    pins = [{ id: "p1", from: 100, to: 200 }];
    await waitFor(() => statusFrames(sock.sent).length > before);
    const last = statusFrames(sock.sent)[statusFrames(sock.sent).length - 1];
    expect(last.pins).toEqual([{ id: "p1", from: 100, to: 200 }]);
    const count = statusFrames(sock.sent).length;
    await sleep(80);
    expect(statusFrames(sock.sent)).toHaveLength(count);
    hub.stop();
  });
});

describe("per-feed flush windows", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("air flushes on batchMs, sea held until its window", () => {
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
    expect(hub.aisFlushMs).toBe(AIS_FLUSH_DEFAULT_MS); // default, not batchMs
    const sock = fakeSocket();
    hub.attach(sock);
    hub.start();
    vi.advanceTimersByTime(500); // t=500
    // In-bounds live change: 60 s (min). If the set were ignored, the default
    // 120 s window would not have elapsed by t=60000 and no frame would arrive.
    hub.setAisFlushMs(60000);
    vi.advanceTimersByTime(100); // t=600
    store.upsert(sea("S"), 600);
    vi.advanceTimersByTime(59150); // t=59750: 60000 window (from t0) not yet due
    expect(updateFrames(sock.sent)).toHaveLength(0);
    vi.advanceTimersByTime(250); // t=60000: due
    const frames = updateFrames(sock.sent);
    expect(frames).toHaveLength(1);
    expect(frames[0].upsert.map((c) => c.id)).toEqual(["S"]);
    hub.stop();
  });

  it("setAisFlushMs clamps to [60000, 600000]", () => {
    const store = new CraftStore();
    const hub = new Hub({ store, batchMs: 1000 });
    hub.setAisFlushMs(10);
    expect(hub.aisFlushMs).toBe(60000);
    hub.setAisFlushMs(999999);
    expect(hub.aisFlushMs).toBe(600000);
    hub.setAisFlushMs(120000);
    expect(hub.aisFlushMs).toBe(120000);
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

  it("accepts the new control frames", () => {
    expect(parseClientMessage(JSON.stringify({ type: "settings.update", patch: { storageCapGb: 4 } }))).toEqual({ type: "settings.update", patch: { storageCapGb: 4 } });
    expect(parseClientMessage(JSON.stringify({ type: "settings.update", patch: { storageCapGb: 4, ramCacheGb: 2 } }))).toEqual({ type: "settings.update", patch: { storageCapGb: 4, ramCacheGb: 2 } });
    expect(parseClientMessage(JSON.stringify({ type: "settings.update", patch: {} }))).toEqual({ type: "settings.update", patch: {} });
    expect(parseClientMessage(JSON.stringify({ type: "pin.add", from: 100, to: 200 }))).toEqual({ type: "pin.add", from: 100, to: 200 });
    expect(parseClientMessage(JSON.stringify({ type: "pin.remove", id: "p123" }))).toEqual({ type: "pin.remove", id: "p123" });
    expect(parseClientMessage(JSON.stringify({ type: "timeline.window", seq: 7, from: 100, to: 200, stride: 2, maxBytes: 1 << 20 }))).toEqual({ type: "timeline.window", seq: 7, from: 100, to: 200, stride: 2, maxBytes: 1 << 20 });
  });

  it("accepts an inverted pin.add (from > to — normalization is the handler's job)", () => {
    expect(parseClientMessage(JSON.stringify({ type: "pin.add", from: 200, to: 100 }))).toEqual({ type: "pin.add", from: 200, to: 100 });
  });

  it("rejects malformed new frames", () => {
    expect(parseClientMessage(JSON.stringify({ type: "settings.update", patch: "x" }))).toBeNull();
    expect(parseClientMessage(JSON.stringify({ type: "settings.update", patch: [1] }))).toBeNull();
    expect(parseClientMessage(JSON.stringify({ type: "settings.update" }))).toBeNull();
    // NaN serializes to null on the wire; either form must be rejected.
    expect(parseClientMessage(JSON.stringify({ type: "pin.add", from: 100, to: NaN }))).toBeNull();
    expect(parseClientMessage(JSON.stringify({ type: "pin.add", to: 200 }))).toBeNull();
    expect(parseClientMessage(JSON.stringify({ type: "pin.remove", id: "" }))).toBeNull();
    expect(parseClientMessage(JSON.stringify({ type: "timeline.window", seq: 7, from: 100, to: 200, stride: 0, maxBytes: 1 << 20 }))).toBeNull();
    expect(parseClientMessage(JSON.stringify({ type: "timeline.window", seq: 1.5, from: 100, to: 200, stride: 1, maxBytes: 1 << 20 }))).toBeNull();
    expect(parseClientMessage(JSON.stringify({ type: "timeline.window", seq: 7, from: 100, to: 200, stride: 1, maxBytes: -1 }))).toBeNull();
    expect(parseClientMessage(JSON.stringify({ type: "timeline.window", seq: 7, from: 100, stride: 1, maxBytes: 1 << 20 }))).toBeNull();
  });
});

describe("parseClientMessage (flight context)", () => {
  it("accepts well-formed flight.track / flight.context frames", () => {
    expect(parseClientMessage(JSON.stringify({ type: "flight.track", id: "abc" }))).toEqual({ type: "flight.track", id: "abc" });
    expect(parseClientMessage(JSON.stringify({ type: "flight.track", id: "abc", seq: 4, auto: false }))).toEqual({
      type: "flight.track",
      id: "abc",
      seq: 4,
      auto: false,
    });
    expect(parseClientMessage(JSON.stringify({ type: "flight.track", id: "abc", auto: true }))).toEqual({
      type: "flight.track",
      id: "abc",
      auto: true,
    });
    expect(parseClientMessage(JSON.stringify({ type: "flight.context", id: "abc", seq: 0 }))).toEqual({
      type: "flight.context",
      id: "abc",
      seq: 0,
    });
  });

  it("rejects missing/empty id and bad seq/auto", () => {
    expect(parseClientMessage(JSON.stringify({ type: "flight.track" }))).toBeNull();
    expect(parseClientMessage(JSON.stringify({ type: "flight.track", id: "" }))).toBeNull();
    expect(parseClientMessage(JSON.stringify({ type: "flight.track", id: "abc", seq: "7" }))).toBeNull();
    expect(parseClientMessage(JSON.stringify({ type: "flight.track", id: "abc", seq: NaN }))).toBeNull();
    expect(parseClientMessage(JSON.stringify({ type: "flight.track", id: "abc", seq: 1.5 }))).toBeNull();
    expect(parseClientMessage(JSON.stringify({ type: "flight.track", id: "abc", seq: -1 }))).toBeNull();
    expect(parseClientMessage(JSON.stringify({ type: "flight.track", id: "abc", auto: "yes" }))).toBeNull();
    expect(parseClientMessage(JSON.stringify({ type: "flight.context" }))).toBeNull();
    expect(parseClientMessage(JSON.stringify({ type: "flight.context", id: 5 }))).toBeNull();
    expect(parseClientMessage(JSON.stringify({ type: "flight.context", id: "abc", seq: -1 }))).toBeNull();
  });
});

describe("parseClientMessage (ais.tile)", () => {
  it("accepts finite viewport centers", () => {
    expect(parseClientMessage(JSON.stringify({ type: "ais.tile", lat: 40.5, lon: -73.9 }))).toEqual({ type: "ais.tile", lat: 40.5, lon: -73.9 });
    expect(parseClientMessage(JSON.stringify({ type: "ais.tile", lat: 0, lon: 0 }))).toEqual({ type: "ais.tile", lat: 0, lon: 0 });
    // Finite-but-invalid lat/lon passes: clamping is the tile composer's job.
    expect(parseClientMessage(JSON.stringify({ type: "ais.tile", lat: 1000, lon: -1000 }))).toEqual({ type: "ais.tile", lat: 1000, lon: -1000 });
  });

  it("drops frames with non-finite or missing coordinates", () => {
    // NaN/Infinity serialize to null on the wire; either form must be dropped.
    expect(parseClientMessage(JSON.stringify({ type: "ais.tile", lat: NaN, lon: 5 }))).toBeNull();
    expect(parseClientMessage(JSON.stringify({ type: "ais.tile", lat: Infinity, lon: 5 }))).toBeNull();
    expect(parseClientMessage(JSON.stringify({ type: "ais.tile", lat: 40 }))).toBeNull();
    expect(parseClientMessage(JSON.stringify({ type: "ais.tile", lon: 5 }))).toBeNull();
    expect(parseClientMessage(JSON.stringify({ type: "ais.tile", lat: "40", lon: 5 }))).toBeNull();
    expect(parseClientMessage(JSON.stringify({ type: "ais.tile" }))).toBeNull();
  });

  it("passes settings.update homeRegion through (field checks live in the handler)", () => {
    expect(parseClientMessage(JSON.stringify({ type: "settings.update", patch: { homeRegion: { lat: 35, lon: 139 } } }))).toEqual({ type: "settings.update", patch: { homeRegion: { lat: 35, lon: 139 } } });
    expect(parseClientMessage(JSON.stringify({ type: "settings.update", patch: { homeRegion: null } }))).toEqual({ type: "settings.update", patch: { homeRegion: null } });
  });
});

describe("parseClientMessage (zones.config)", () => {
  it("accepts air-kind sets verbatim (dedup and boostMs clamping live in the poller)", () => {
    expect(parseClientMessage(JSON.stringify({ type: "zones.config", kinds: ["military"], boostMs: 30000 }))).toEqual({ type: "zones.config", kinds: ["military"], boostMs: 30000 });
    // Empty set is a valid (full-replace) config: inactive kinds = no zone.
    expect(parseClientMessage(JSON.stringify({ type: "zones.config", kinds: [], boostMs: 30000 }))).toEqual({ type: "zones.config", kinds: [], boostMs: 30000 });
    // Full air set.
    expect(parseClientMessage(JSON.stringify({ type: "zones.config", kinds: ["commercial", "business", "military", "general"], boostMs: 10000 }))).toEqual({ type: "zones.config", kinds: ["commercial", "business", "military", "general"], boostMs: 10000 });
    // Duplicates pass through untouched — the poller owns dedup.
    expect(parseClientMessage(JSON.stringify({ type: "zones.config", kinds: ["military", "military"], boostMs: 30000 }))).toEqual({ type: "zones.config", kinds: ["military", "military"], boostMs: 30000 });
    // Finite-but-odd boostMs is accepted: the [10000, 120000] clamp is pinned
    // to the poller layer in test/poller.test.ts.
    expect(parseClientMessage(JSON.stringify({ type: "zones.config", kinds: ["general"], boostMs: 5 }))).toEqual({ type: "zones.config", kinds: ["general"], boostMs: 5 });
  });

  it("drops the whole frame on any invalid kind or non-finite boostMs", () => {
    // One sea member kills the frame (dedup/poller never sees a partial set).
    expect(parseClientMessage(JSON.stringify({ type: "zones.config", kinds: ["cargo"], boostMs: 30000 }))).toBeNull();
    expect(parseClientMessage(JSON.stringify({ type: "zones.config", kinds: ["military", "cargo"], boostMs: 30000 }))).toBeNull();
    expect(parseClientMessage(JSON.stringify({ type: "zones.config", kinds: "military", boostMs: 30000 }))).toBeNull();
    expect(parseClientMessage(JSON.stringify({ type: "zones.config", boostMs: 30000 }))).toBeNull();
    expect(parseClientMessage(JSON.stringify({ type: "zones.config", kinds: ["military", 1], boostMs: 30000 }))).toBeNull();
    expect(parseClientMessage(JSON.stringify({ type: "zones.config", kinds: [null], boostMs: 30000 }))).toBeNull();
    expect(parseClientMessage(JSON.stringify({ type: "zones.config", kinds: ["military"] }))).toBeNull();
    expect(parseClientMessage(JSON.stringify({ type: "zones.config", kinds: ["military"], boostMs: "30000" }))).toBeNull();
    // NaN/Infinity serialize to null on the wire; either form is dropped.
    expect(parseClientMessage(JSON.stringify({ type: "zones.config", kinds: ["military"], boostMs: NaN }))).toBeNull();
    expect(parseClientMessage(JSON.stringify({ type: "zones.config", kinds: ["military"], boostMs: Infinity }))).toBeNull();
  });
});

describe("Hub (legacy status shape)", () => {
  it("still broadcasts a payload stripped of boost/hotzone (new status blocks are additive)", async () => {
    const store = new CraftStore();
    // Hand-built pre-hot-zone shape: no boost on opensky, no hotzone field
    // (cast — the type now REQUIRES hotzone, this pins old producers).
    const legacy = {
      feeds: {
        opensky: { lastOkAt: null, lastError: null, pollMs: 120000 },
        ais: { connected: false, enabled: false, lastError: null, lastMessageAt: null, flushMs: 120000, secondary: SECONDARY },
      },
      history: historyStatus(),
      settings: { storageCapGb: 10, ramCacheGb: 1, cacheUsedBytes: 0, homeRegion: null },
      pins: [],
      staleMs: 120000,
      faa: { state: "ready", updatedAt: null, aircraft: 0, lastError: null },
      icons: ICONS_STUB,
    } as unknown as StatusPayload;
    const hub = new Hub({ store, batchMs: 1000, statusPayload: () => legacy });
    const sock = fakeSocket();
    hub.attach(sock);
    hub.start();
    await waitFor(() => statusFrames(sock.sent).length >= 2);
    for (const raw of sock.sent.map((s) => JSON.parse(s) as { type: string; [k: string]: any })) {
      if (raw.type !== "status") continue;
      expect(raw.hotzone).toBeUndefined();
      expect(raw.feeds.opensky.boost).toBeUndefined();
      expect(raw.feeds.opensky.pollMs).toBe(120000);
    }
    hub.stop();
  });
});

describe("parseClientMessage — traffic frames", () => {
  it("traffic.watch: boolean on only", () => {
    expect(parseClientMessage(JSON.stringify({ type: "traffic.watch", on: true }))).toEqual({ type: "traffic.watch", on: true });
    expect(parseClientMessage(JSON.stringify({ type: "traffic.watch", on: false }))).toEqual({ type: "traffic.watch", on: false });
    expect(parseClientMessage(JSON.stringify({ type: "traffic.watch" }))).toBeNull();
    expect(parseClientMessage(JSON.stringify({ type: "traffic.watch", on: "yes" }))).toBeNull();
    expect(parseClientMessage(JSON.stringify({ type: "traffic.watch", on: null }))).toBeNull();
    expect(parseClientMessage(JSON.stringify({ type: "traffic.watch", on: 1 }))).toBeNull();
  });

  it("traffic.report: finite, ≥ 0, ≤ 50 MB", () => {
    expect(parseClientMessage(JSON.stringify({ type: "traffic.report", down: 0 }))).toEqual({ type: "traffic.report", down: 0 });
    expect(parseClientMessage(JSON.stringify({ type: "traffic.report", down: 123456 }))).toEqual({ type: "traffic.report", down: 123456 });
    expect(parseClientMessage(JSON.stringify({ type: "traffic.report", down: TRAFFIC_REPORT_MAX_BYTES }))).toEqual({
      type: "traffic.report",
      down: TRAFFIC_REPORT_MAX_BYTES,
    });
    expect(parseClientMessage(JSON.stringify({ type: "traffic.report", down: TRAFFIC_REPORT_MAX_BYTES + 1 }))).toBeNull();
    expect(parseClientMessage(JSON.stringify({ type: "traffic.report", down: -1 }))).toBeNull();
    expect(parseClientMessage(JSON.stringify({ type: "traffic.report", down: "1000" }))).toBeNull();
    expect(parseClientMessage(JSON.stringify({ type: "traffic.report" }))).toBeNull();
    expect(parseClientMessage('{"type":"traffic.report","down":1e999}')).toBeNull(); // Infinity literal
  });
});
