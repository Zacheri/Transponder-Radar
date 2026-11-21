import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, readdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { HistoryRecorder, planCompaction, type HistoryRecorderOpts } from "../server/history.js";
import { PinStore } from "../server/pins.js";
import { SnapshotCache } from "../server/snapshot-cache.js";
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

  describe("snapshot cache + status", () => {
    it("seek warms the cache on a miss; a later seek is served from the cache", async () => {
      const cache = new SnapshotCache({ maxBytes: 1_000_000 });
      const h = rec(1_000_000, { cache });
      await h.init();
      t = 1000;
      await h.recordNow(() => [craft("s1")]);
      expect(cache.get(1000)).toEqual([craft("s1")]); // recordNow warms the cache
      cache.drop(1000); // force the seek-miss path
      expect((await h.seek(1000)).craft[0].id).toBe("s1"); // miss: read disk, warm
      expect(cache.get(1000)).toEqual([craft("s1")]);
      await rm(join(dir, "1000.json.gz"));
      expect(await h.seek(1000)).toEqual({ time: 1000, craft: [craft("s1")] }); // hit: no disk
    });

    it("recordNow warms the snapshot cache", async () => {
      const cache = new SnapshotCache({ maxBytes: 1_000_000 });
      const h = rec(1_000_000, { cache });
      await h.init();
      t = 1000;
      await h.recordNow(() => [craft("r1")]);
      expect(cache.get(1000)).toEqual([craft("r1")]);
    });

    it("snapshot is a copy: mutating the live craft after record does not change the served snapshot", async () => {
      const cache = new SnapshotCache({ maxBytes: 1_000_000 });
      const h = rec(1_000_000, { cache });
      await h.init();
      t = 1000;
      const live = [craft("s1")];
      await h.recordNow(() => live);
      live[0].stale = true; // what the store sweeper does in place
      live[0].speed = 999;
      const seen = await h.seek(1000); // cache hit — the pre-fix aliasing path
      expect(seen.craft[0].stale).toBe(false);
      expect(seen.craft[0].speed).toBe(10);
      // The on-disk snapshot was serialized from the same copy.
      cache.drop(1000);
      const fromDisk = await h.seek(1000);
      expect(fromDisk.craft[0].stale).toBe(false);
      expect(fromDisk.craft[0].speed).toBe(10);
    });

    it("status() reports pinnedBytes 0 when no pin store is configured", async () => {
      const h = rec();
      await h.init();
      t = 1000;
      await h.recordNow(() => [craft("s0")]);
      expect(h.status().pinnedBytes).toBe(0);
    });

    it("status(pins) reports range, usedBytes, pinnedBytes and snapshotMs", async () => {
      const pins = new PinStore({ file: join(dir, "pins.json") });
      await pins.init();
      const h = rec(1_000_000, { pins });
      await h.init();
      t = BASE;
      await h.recordNow(() => [craft("s0")]);
      t = BASE + 120_000; // 120 s apart so a valid pin can cover s0 but not s1
      await h.recordNow(() => [craft("s1")]);
      // contains() is inclusive and spans must be >= MIN_PIN_MS, so the pin
      // ends 1 ms before s1.
      expect(pins.add(BASE, BASE + 120_000 - 1, null)).not.toBeNull();
      const e = h.entries();
      const st = h.status();
      expect({ from: st.from, to: st.to, snapshots: st.snapshots }).toEqual({
        from: BASE,
        to: BASE + 120_000,
        snapshots: 2,
      });
      expect(st.usedBytes).toBe(e[0].size + e[1].size);
      expect(st.pinnedBytes).toBe(e[0].size);
      expect(st.snapshotMs).toBe(60000);
    });
  });

  describe("compact", () => {
    // NOW and OLD are exact COMPACT_STEP_MS multiples, so OLD's bucket ended
    // 2 h before the 48 h horizon at NOW: every OLD snapshot is compactable.
    const NOW = 1_700_000_100_000;
    const H = 3_600_000;
    const S = 60_000;
    const OLD = NOW - 50 * H;

    // Five snapshots inside one dead bucket, clock advanced to NOW.
    const seedOld = async (extra: Partial<HistoryRecorderOpts> = {}) => {
      const h = rec(1_000_000, extra);
      await h.init();
      for (let k = 0; k < 5; k++) {
        t = OLD + k * S;
        await h.recordNow(() => [craft(`s${k}`)]);
      }
      t = NOW;
      return h;
    };

    it("deletes files, index entries and cache of old snapshots; seek returns the survivor", async () => {
      const cache = new SnapshotCache({ maxBytes: 1_000_000 });
      const h = await seedOld({ cache });
      expect(h.range().snapshots).toBe(5);

      expect(await h.compact()).toBe(4);

      expect(h.range()).toEqual({ from: OLD, to: OLD, snapshots: 1 });
      expect(await readdir(dir)).toEqual([`${OLD}.json.gz`]);
      expect(cache.get(OLD)).not.toBeUndefined();
      expect(cache.get(OLD + 2 * S)).toBeUndefined();
      expect(await h.seek(OLD + 2 * S)).toEqual({ time: OLD, craft: [craft("s0")] });
    });

    it("is idempotent", async () => {
      const h = await seedOld();
      expect(await h.compact()).toBe(4);
      expect(await h.compact()).toBe(0);
    });

    it("keeps pinned snapshots and shrinks usedBytes", async () => {
      const pins = new PinStore({ file: join(dir, "pins.json") });
      await pins.init();
      const h = await seedOld({ pins });
      // Minimum-span pin over the first two snapshots: the bucket holds pins,
      // so every unpinned ts of it is deleted.
      expect(pins.add(OLD, OLD + S, null)).not.toBeNull();
      const before = h.usedBytes();

      expect(await h.compact()).toBe(3);

      expect(h.entries().map((e) => e.ts)).toEqual([OLD, OLD + S]);
      expect((await readdir(dir)).filter((f) => f.endsWith(".json.gz")).sort()).toEqual([
        `${OLD}.json.gz`,
        `${OLD + S}.json.gz`,
      ]);
      expect(h.usedBytes()).toBeLessThan(before);
      expect(h.usedBytes()).toBe(h.entries().reduce((s, e) => s + e.size, 0));
    });

    it("window() after a manual unlink of an indexed ts completes and skips it", async () => {
      const lines: string[] = [];
      const h = rec(1_000_000, { log: (m) => lines.push(m) });
      await h.init();
      t = NOW - 3 * H;
      await h.recordNow(() => [craft("w0")]);
      t = NOW - 2 * H;
      await h.recordNow(() => [craft("w1")]);
      t = NOW - H;
      await h.recordNow(() => [craft("w2")]);
      await rm(join(dir, `${NOW - 2 * H}.json.gz`));

      const items = await h.window(NOW - 4 * H, NOW, 1, 1_000_000);

      expect(items.map((i) => i.ts)).toEqual([NOW - 3 * H, NOW - H]);
      expect(lines.some((l) => l.includes(`skipping missing snapshot ${NOW - 2 * H}`))).toBe(true);
    });
  });
});

describe("planCompaction", () => {
  // NOW is an exact multiple of COMPACT_STEP_MS, so buckets align with whole
  // hours of NOW: NOW - 49 h is a bucket start, NOW - 48 h is a bucket end.
  const NOW = 1_700_000_100_000;
  const H = 3_600_000;
  const S = 60_000;
  const B0 = NOW - 49 * H; // first ts of a dead bucket (its end is < NOW - 48 h)

  const idx = (...ts: number[]) => ts.map((t) => ({ ts: t }));

  it("keeps every snapshot newer than the horizon", () => {
    const got = planCompaction(idx(NOW - H, NOW - 10 * H, NOW - 47 * H), NOW, () => false);
    expect(got).toEqual([]);
  });

  it("prunes a dead bucket to its earliest snapshot", () => {
    const ts = [B0, B0 + S, B0 + 2 * S, B0 + 3 * S, B0 + 4 * S];
    expect(planCompaction(idx(...ts), NOW, () => false)).toEqual(ts.slice(1));
  });

  it("never deletes a pinned earliest snapshot", () => {
    const ts = [B0, B0 + S, B0 + 2 * S, B0 + 3 * S, B0 + 4 * S];
    expect(planCompaction(idx(...ts), NOW, (t) => t === B0)).toEqual(ts.slice(1));
  });

  it("deletes every unpinned ts of a bucket that holds a pinned one", () => {
    const ts = [B0, B0 + S, B0 + 2 * S, B0 + 3 * S, B0 + 4 * S];
    const got = planCompaction(idx(...ts), NOW, (t) => t === B0 + 2 * S);
    expect(got).toEqual([B0, B0 + S, B0 + 3 * S, B0 + 4 * S]);
  });

  it("keeps a bucket that spans the horizon", () => {
    // NOW-aligned buckets put this bucket's end exactly on the horizon, so it
    // is not strictly older than it and the whole bucket stays.
    const got = planCompaction(idx(NOW - 48 * H - 4 * S, NOW - 48 * H - 2 * S), NOW, () => false);
    expect(got).toEqual([]);
  });

  it("handles an empty index", () => {
    expect(planCompaction([], NOW, () => false)).toEqual([]);
  });

  it("honours custom horizonMs and stepMs", () => {
    // horizon 10 s, step 2 s, now 100 s: a bucket dies once its end is < 90 s.
    // 1_000 survives as earliest of its dead bucket; 90_000's bucket (end 92 s)
    // is alive. With the default 48 h horizon nothing here would be old enough.
    const got = planCompaction(idx(1_000, 1_500, 90_000), 100_000, () => false, 10_000, 2_000);
    expect(got).toEqual([1_500]);
  });
});
