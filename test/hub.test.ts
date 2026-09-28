import { describe, it, expect } from "vitest";
import { Hub } from "../server/hub.js";
import { CraftStore } from "../server/store.js";
import type { Craft } from "../shared/craft.js";
import { sleep } from "./util.js";

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
});
