import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HistoryRecorder } from "../server/history.js";
import type { Craft } from "../shared/craft.js";

function craft(id: string): Craft {
  return { id, domain: "air", kind: "commercial", lat: 1, lon: 2, speed: 10, heading: 90, updatedAt: 0, stale: false };
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

  const rec = (maxBytes = 1_000_000) =>
    new HistoryRecorder({ dir, snapshotMs: 60000, maxBytes, now: () => t });

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
});
