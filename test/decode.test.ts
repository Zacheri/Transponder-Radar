import { describe, it, expect } from "vitest";
import { gzipSync } from "node:zlib";
import type { Craft } from "../shared/craft.js";
import { decodeGz } from "../src/data/decode.worker.js";
import {
  decodeSupported,
  createDecodePool,
  type DecodePool,
  type PoolWorker,
} from "../src/data/decode.js";

// Minimal valid Craft shape (see test/history.test.ts).
function craft(id: string): Craft {
  return {
    id,
    domain: "air",
    kind: "commercial",
    lat: 1,
    lon: 2,
    speed: 10,
    heading: 90,
    updatedAt: 0,
    stale: false,
  };
}

// Exact-sized, independent ArrayBuffer (avoid Node's pooled Buffer .buffer,
// which can have a non-zero byteOffset that reads pool padding on decode).
function gzBuffer(items: Craft[]): ArrayBuffer {
  const gz = gzipSync(Buffer.from(JSON.stringify(items)));
  return new Uint8Array(gz).buffer;
}

// A PoolWorker that handles exactly one message at a time (serial queue);
// replies by deferring onmessage by a microtask, and records peak in-flight.
function makeFakeWorker(opts: { failFirst?: boolean } = {}) {
  let handler: null | ((ev: {
    data: { id: number; crafts?: Craft[]; error?: string };
  }) => void) = null;
  let inFlight = 0;
  let maxConcurrency = 0;
  let firstMessage = true;
  const queue: { id: number; buf: ArrayBuffer }[] = [];
  let busy = false;

  const pump = (): void => {
    if (busy || queue.length === 0) return;
    const msg = queue.shift();
    if (!msg) return;
    busy = true;
    inFlight++;
    maxConcurrency = Math.max(maxConcurrency, inFlight);
    Promise.resolve().then(() => {
      inFlight--;
      handler?.({
        data:
          opts.failFirst && firstMessage
            ? { id: msg.id, error: "boom" }
            : { id: msg.id, crafts: [craft(String(msg.id))] },
      });
      firstMessage = false;
      busy = false;
      pump();
    });
  };

  const worker: PoolWorker = {
    onmessage: null,
    postMessage(msg: { id: number; buf: ArrayBuffer }): void {
      queue.push(msg);
      pump();
    },
  };

  Object.defineProperty(worker, "onmessage", {
    configurable: true,
    get: () => handler,
    set: (v: typeof handler) => {
      handler = v;
    },
  });

  return { worker, stats: { get maxConcurrency() { return maxConcurrency; } } };
}

describe("decodeGz", () => {
  it("decompresses gzip JSON to the exact craft array", async () => {
    const out = await decodeGz(gzBuffer([craft("a"), craft("b")]));
    expect(out).toEqual([craft("a"), craft("b")]);
  });

  it("rejects on non-gzip bytes", async () => {
    const bad = new TextEncoder().encode("not gzip").buffer;
    await expect(decodeGz(bad)).rejects.toThrow();
  });
});

describe("decodeSupported", () => {
  it("is true on Node 26", () => {
    expect(decodeSupported()).toBe(true);
  });
});

describe("createDecodePool", () => {
  it("routes each decode to the correct slot and caps concurrency at pool size", async () => {
    const fakes = [makeFakeWorker(), makeFakeWorker()];
    let spawned = 0;
    const spawn = (): PoolWorker => fakes[spawned++].worker;
    const pool: DecodePool = createDecodePool(2, spawn);

    const gzs = [0, 1, 2, 3, 4].map(() => gzBuffer([craft("x")]));
    const results = await Promise.all(gzs.map((gz) => pool.decode(gz)));

    results.forEach((out, i) => {
      expect(out).toHaveLength(1);
      // id is embedded in the craft to catch mis-routing.
      expect(out[0].id).toBe(String(i));
    });

    expect(fakes[0].stats.maxConcurrency).toBe(1);
    expect(fakes[1].stats.maxConcurrency).toBe(1);
    expect(fakes[0].stats.maxConcurrency + fakes[1].stats.maxConcurrency).toBeLessThanOrEqual(2);
  });

  it("rejects pending decodes and respawns the slot when a worker fails to load (onerror)", async () => {
    const workers: PoolWorker[] = [];
    const spawn = (): PoolWorker => {
      const first = workers.length === 0; // first worker: load failure (never answers)
      const w: PoolWorker = {
        onmessage: null,
        postMessage(msg: { id: number; buf: ArrayBuffer }): void {
          if (!first) w.onmessage?.({ data: { id: msg.id, crafts: [craft("respawned")] } });
        },
      };
      workers.push(w);
      return w;
    };
    const pool: DecodePool = createDecodePool(1, spawn);

    const p = pool.decode(gzBuffer([craft("x")])); // stays pending: the fake never answers
    expect(workers).toHaveLength(1);
    expect(typeof workers[0].onerror).toBe("function"); // pool attached the load-failure handler
    workers[0].onerror!(undefined);

    await expect(p).rejects.toThrow("decode worker died");

    const out = await pool.decode(gzBuffer([craft("x")]));
    expect(workers).toHaveLength(2); // the killed slot respawned a fresh worker
    expect(out).toEqual([craft("respawned")]);
  });

  it("rejects a decode when a worker errors and replaces it so subsequent decodes succeed", async () => {
    let spawns = 0;
    const spawn = (): PoolWorker => {
      const failFirst = spawns === 0; // first spawned worker faults
      spawns++;
      return makeFakeWorker({ failFirst }).worker;
    };
    const pool: DecodePool = createDecodePool(1, spawn);

    await expect(pool.decode(gzBuffer([craft("x")]))).rejects.toThrow("boom");

    const out = await pool.decode(gzBuffer([craft("x")]));
    expect(out[0].id).toBe("1"); // second dispatch uses id 1
    expect(spawns).toBe(2); // the dead worker was replaced
  });
});
