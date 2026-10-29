import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, readdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { HistoryRecorder, type HistoryRecorderOpts } from "../server/history.js";
import { PinStore } from "../server/pins.js";
import { MIN_PIN_MS } from "../shared/limits.js";
import type { Craft } from "../shared/craft.js";

function craft(id: string): Craft {
  return { id, domain: "air", kind: "commercial", lat: 1, lon: 2, speed: 10, heading: 90, updatedAt: 0, stale: false };
}

// Real-scale epoch base for pin-aware tests: pin spans must be >= MIN_PIN_MS,
// so snapshots are MIN_PIN_MS apart (snapshot filename integers are otherwise
// arbitrary).
const BASE = 1_700_000_000_000;

// setCap's evict is fire-and-forget: it removes entries from the index
// synchronously but unlinks their files asynchronously, so the index can be
// stable while an unlink is still in flight. Settle until BOTH the index
// length and the on-disk snapshot count are stable across two consecutive
// macrotasks; bounded, throws on timeout.
async function settle(h: HistoryRecorder, dir: string, limitMs = 2000): Promise<void> {
  let prevIndex = -1;
  let prevDisk = -1;
  const start = Date.now();
  while (Date.now() - start < limitMs) {
    await new Promise((r) => setImmediate(r));
    const indexLen = h.entries().length;
    const diskCount = (await readdir(dir)).filter((f) => f.endsWith(".json.gz")).length;
    if (indexLen === prevIndex && diskCount === prevDisk) return;
    prevIndex = indexLen;
    prevDisk = diskCount;
  }
  throw new Error("settle: index/disk did not stabilize");
}

describe("HistoryRecorder", () => {
  let dir: string;
  let t = 1_000_000_000;

  beforeEach(async () => {
    t = 1_000_000_000;
    dir = await mkdtemp(join(tmpdir(), "radar-hist-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const rec = (maxBytes = 1_000_000, extra: Partial<HistoryRecorderOpts> = {}) =>
    new HistoryRecorder({ dir, snapshotMs: 60000, maxBytes, now: () => t, ...extra });

  it("starts empty; seek returns null time", async () => {
    const h = rec();
    await h.init();
    expect(h.range()).toEqual({ from: null, to: null, snapshots: 0 });
    expect(await h.seek(t)).toEqual({ time: null, craft: [] });
  });

  it("records gzipped snapshots that round-trip to the exact craft list", async () => {
    const h = rec();
    await h.init();
    const crafts = [craft("a1"), craft("a2")];
    await h.recordNow(() => crafts);
    expect(await readdir(dir)).toEqual([`${t}.json.gz`]);
    expect(h.range()).toEqual({ from: t, to: t, snapshots: 1 });
    expect(await h.seek(t)).toEqual({ time: t, craft: crafts });
  });

  it("seek picks the newest snapshot <= t, clamping early and late", async () => {
    const h = rec();
    await h.init();
    t = 1000;
    await h.recordNow(() => [craft("s1")]);
    t = 2000;
    await h.recordNow(() => [craft("s2")]);
    expect((await h.seek(1500)).time).toBe(1000);
    expect((await h.seek(500)).time).toBe(1000); // clamped to oldest
    expect((await h.seek(99999)).time).toBe(2000); // clamped to newest
    expect((await h.seek(99999)).craft[0].id).toBe("s2");
  });

  it("evicts oldest snapshots first beyond maxBytes", async () => {
    const h = rec(1); // any real snapshot exceeds 1 byte → keep only the newest
    await h.init();
    t = 1000;
    await h.recordNow(() => [craft("s1")]);
    t = 2000;
    await h.recordNow(() => [craft("s2")]);
    t = 3000;
    await h.recordNow(() => [craft("s3")]);
    expect(await readdir(dir)).toEqual([`${3000}.json.gz`]);
    expect(h.range()).toEqual({ from: 3000, to: 3000, snapshots: 1 });
  });

  it("rebuilds the index from disk on init (restart)", async () => {
    const h1 = rec();
    await h1.init();
    t = 1000;
    await h1.recordNow(() => [craft("s1")]);
    t = 2000;
    await h1.recordNow(() => [craft("s2")]);
    const h2 = rec();
    await h2.init();
    expect(h2.range()).toEqual({ from: 1000, to: 2000, snapshots: 2 });
    expect((await h2.seek(1500)).craft[0].id).toBe("s1");
  });

  describe("pin-aware eviction", () => {
    it("pinned snapshots survive eviction (unpinned older ones are dropped)", async () => {
      const pins = new PinStore({ file: join(dir, "pins.json") });
      await pins.init();
      const h = rec(1_000_000, { pins });
      await h.init();
      t = BASE;
      await h.recordNow(() => [craft("s0")]);
      t = BASE + MIN_PIN_MS;
      await h.recordNow(() => [craft("s1")]);
      t = BASE + 2 * MIN_PIN_MS;
      await h.recordNow(() => [craft("s2")]);
      t = BASE + 3 * MIN_PIN_MS;
      await h.recordNow(() => [craft("s3")]);
      // Pin s0+s1 (inclusive both ends); 1-byte cap; the final recordNow's
      // awaited evict finishes the job (keep-newest shields s3 until s4 lands).
      expect(pins.add(BASE, BASE + MIN_PIN_MS, null)).not.toBeNull();
      h.setCap(1);
      await settle(h, dir);
      t = BASE + 4 * MIN_PIN_MS;
      await h.recordNow(() => [craft("s4")]);
      const files = (await readdir(dir)).filter((f) => f.endsWith(".json.gz")).sort();
      expect(files).toEqual([
        `${BASE}.json.gz`,
        `${BASE + MIN_PIN_MS}.json.gz`,
        `${BASE + 4 * MIN_PIN_MS}.json.gz`,
      ]);
      expect(h.range()).toEqual({ from: BASE, to: BASE + 4 * MIN_PIN_MS, snapshots: 3 });
    });

    it("keeps pinned-only snapshots even when they exceed the cap", async () => {
      const pins = new PinStore({ file: join(dir, "pins.json") });
      await pins.init();
      const h = rec(1_000_000, { pins });
      await h.init();
      t = BASE;
      await h.recordNow(() => [craft("s0")]);
      t = BASE + MIN_PIN_MS;
      await h.recordNow(() => [craft("s1")]);
      expect(pins.add(BASE, BASE + MIN_PIN_MS, null)).not.toBeNull();
      h.setCap(1);
      await settle(h, dir);
      const files = (await readdir(dir)).filter((f) => f.endsWith(".json.gz")).sort();
      expect(files).toEqual([`${BASE}.json.gz`, `${BASE + MIN_PIN_MS}.json.gz`]);
      expect(h.usedBytes()).toBeGreaterThan(1);
      expect(h.entries().length).toBe(2); // loop terminated; overshoot is legal
    });

    it("setCap lowers the cap live and evicts down to the newest", async () => {
      const h = rec();
      await h.init();
      t = BASE;
      await h.recordNow(() => [craft("s0")]);
      t = BASE + MIN_PIN_MS;
      await h.recordNow(() => [craft("s1")]);
      t = BASE + 2 * MIN_PIN_MS;
      await h.recordNow(() => [craft("s2")]);
      h.setCap(1);
      await settle(h, dir);
      expect((await readdir(dir)).filter((f) => f.endsWith(".json.gz")).sort()).toEqual([
        `${BASE + 2 * MIN_PIN_MS}.json.gz`,
      ]);
      expect(h.range()).toEqual({ from: BASE + 2 * MIN_PIN_MS, to: BASE + 2 * MIN_PIN_MS, snapshots: 1 });
      expect(h.usedBytes()).toBe(h.entries()[0].size);
    });

    it("without pins, entries() is a consistent copy and usedBytes() sums the index", async () => {
      const h = rec();
      await h.init();
      t = BASE;
      await h.recordNow(() => [craft("s0")]);
      t = BASE + MIN_PIN_MS;
      await h.recordNow(() => [craft("s1")]);
      t = BASE + 2 * MIN_PIN_MS;
      await h.recordNow(() => [craft("s2")]);
      expect(h.entries().map((e) => e.ts)).toEqual([BASE, BASE + MIN_PIN_MS, BASE + 2 * MIN_PIN_MS]);
      expect(h.usedBytes()).toBe(h.entries().reduce((s, e) => s + e.size, 0));
      // entries() returns a copy — mutating it must not affect the recorder.
      h.entries().push({ ts: 999, size: 1 });
      expect(h.entries().length).toBe(3);

      // 1-byte cap (fresh dir): evicts down to the newest.
      const dir2 = await mkdtemp(join(tmpdir(), "radar-hist-"));
      try {
        const h2 = new HistoryRecorder({ dir: dir2, snapshotMs: 60000, maxBytes: 1, now: () => t });
        await h2.init();
        t = BASE;
        await h2.recordNow(() => [craft("a")]);
        t = BASE + MIN_PIN_MS;
        await h2.recordNow(() => [craft("b")]);
        t = BASE + 2 * MIN_PIN_MS;
        await h2.recordNow(() => [craft("c")]);
        expect(h2.entries().length).toBe(1);
        expect(h2.usedBytes()).toBe(h2.entries()[0].size);
      } finally {
        await rm(dir2, { recursive: true, force: true });
      }
    });

    it("init() unlinks 0-byte snapshots (logged) and leaves other files untouched", async () => {
      const pinsJson = JSON.stringify({ pins: [{ id: "p1", from: BASE, to: BASE + MIN_PIN_MS }] });
      await writeFile(join(dir, "1000.json.gz"), Buffer.alloc(0));
      await writeFile(join(dir, "2000.json.gz"), gzipSync(Buffer.from(JSON.stringify([craft("s2")]))));
      await writeFile(join(dir, "pins.json"), pinsJson);

      const pins = new PinStore({ file: join(dir, "pins.json") });
      await pins.init();
      const lines: string[] = [];
      const h = rec(1_000_000, { pins, log: (m) => lines.push(m) });
      await h.init();

      expect((await readdir(dir)).sort()).toEqual(["2000.json.gz", "pins.json"]);
      expect(await readFile(join(dir, "pins.json"), "utf8")).toBe(pinsJson);
      expect(h.range()).toEqual({ from: 2000, to: 2000, snapshots: 1 });
      expect(lines.some((l) => l.includes("1000.json.gz"))).toBe(true);
    });
  });
});
