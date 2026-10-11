import { describe, it, expect } from "vitest";
import { Hub, parseClientMessage, type FeedStatus } from "../server/hub.js";
import type { HistoryRange } from "../server/history.js";
import { CraftStore } from "../server/store.js";
import type { Craft } from "../shared/craft.js";
import { sleep, waitFor } from "./util.js";

function air(id: string): Craft {
  return { id, domain: "air", kind: "commercial", lat: 0, lon: 0, speed: null, heading: null, updatedAt: 0, stale: false };
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

function statusFrames(sent: string[]) {
  return sent
    .map((s) => JSON.parse(s) as { type: string; feeds?: any; history?: any; serverTime?: number })
    .filter((m) => m.type === "status");
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
    await sleep(80);
    const updates = sock.sent
      .map((s) => JSON.parse(s))
      .filter((m) => m.type === "update");
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
      ais: { connected: false, enabled: false, lastError: null, lastMessageAt: null },
    };
    const hub = new Hub({ store, batchMs: 20, statusPayload: () => ({ feeds, history: { from: null, to: null, snapshots: 0 }, faa: { state: "ready", updatedAt: null, aircraft: 0, lastError: null } }) });
    const sock = fakeSocket();
    hub.attach(sock);
    hub.start();
    feeds = {
      opensky: { lastOkAt: 123, lastError: null, pollMs: 120000 },
      ais: { connected: true, enabled: true, lastError: null, lastMessageAt: 456 },
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
      ais: { connected: false, enabled: false, lastError: null, lastMessageAt: null },
    };
    const hub = new Hub({ store, batchMs: 20, statusPayload: () => ({ feeds, history: { from: null, to: null, snapshots: 0 }, faa: { state: "ready", updatedAt: null, aircraft: 0, lastError: null } }) });
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
      ais: { connected: false, enabled: true, lastError: "closed 1006", lastMessageAt: null },
    };
    const hub = new Hub({ store, batchMs: 1000, statusPayload: () => ({ feeds, history: { from: null, to: null, snapshots: 0 }, faa: { state: "ready", updatedAt: null, aircraft: 0, lastError: null } }) });
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
    const feeds = { opensky: { lastOkAt: null, lastError: null, pollMs: 120000 }, ais: { connected: false, enabled: false, lastError: null, lastMessageAt: null } };
    const hub = new Hub({ store, batchMs: 20, statusPayload: () => ({ feeds, history, faa: { state: "ready", updatedAt: null, aircraft: 0, lastError: null } }) });
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
