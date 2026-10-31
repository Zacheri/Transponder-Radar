import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import { HistoryRecorder, type HistoryRecorderOpts } from "../server/history.js";
import type { Craft } from "../shared/craft.js";

function craft(id: string): Craft {
  return { id, domain: "air", kind: "commercial", lat: 1, lon: 2, speed: 10, heading: 90, updatedAt: 0, stale: false };
}

const BIG = 1_000_000;
const SNAPS: [number, string][] = [
  [1000, "s1"],
  [2000, "s2"],
  [3000, "s3"],
  [4000, "s4"],
];

describe("HistoryRecorder.window", () => {
  let dir: string;
  let t: number;

  beforeEach(async () => {
    t = 1000;
    dir = await mkdtemp(join(tmpdir(), "radar-win-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const rec = (extra: Partial<HistoryRecorderOpts> = {}) =>
    new HistoryRecorder({ dir, snapshotMs: 60000, maxBytes: BIG, now: () => t, ...extra });

  // 4 snapshots at t = 1000..4000, distinct craft id per snapshot.
  async function recordFour(h: HistoryRecorder): Promise<void> {
    for (const [ts, id] of SNAPS) {
      t = ts;
      await h.recordNow(() => [craft(id)]);
    }
  }

  it("stride 1 returns every snapshot, ascending ts", async () => {
    const h = rec();
    await h.init();
    await recordFour(h);
    const items = await h.window(1000, 4000, 1, BIG);
    expect(items.map((i) => i.ts)).toEqual([1000, 2000, 3000, 4000]);
  });

  it("stride 2 takes the first entry >= from, then every 2nd by position", async () => {
    const h = rec();
    await h.init();
    await recordFour(h);
    const items = await h.window(1000, 4000, 2, BIG);
    expect(items.map((i) => i.ts)).toEqual([1000, 3000]);
  });

  it("clamps from before the oldest and to after the newest", async () => {
    const h = rec();
    await h.init();
    await recordFour(h);
    const items = await h.window(0, 9999, 1, BIG);
    expect(items.map((i) => i.ts)).toEqual([1000, 2000, 3000, 4000]);
  });

  it("stops once cumulative gz bytes reach maxBytes, always keeping the first item", async () => {
    const h = rec();
    await h.init();
    await recordFour(h);
    const one = h.entries()[0].size; // all four gz files are the same size
    const items = await h.window(1000, 4000, 1, one);
    expect(items.length).toBeGreaterThanOrEqual(1);
    expect(items.length).toBeLessThanOrEqual(2);
    expect(items[0].ts).toBe(1000);
  });

  it("skips a missing file (logged) and keeps its index entry", async () => {
    const lines: string[] = [];
    const h = rec({ log: (m) => lines.push(m) });
    await h.init();
    await recordFour(h);
    await rm(join(dir, "2000.json.gz"));
    const items = await h.window(1000, 4000, 1, BIG);
    expect(items.map((i) => i.ts)).toEqual([1000, 3000, 4000]);
    expect(lines.some((l) => l.includes("2000"))).toBe(true);
    expect(h.entries().map((e) => e.ts)).toEqual([1000, 2000, 3000, 4000]); // kept
  });

  it("removes a 0-byte file from disk and index (logged)", async () => {
    const lines: string[] = [];
    const h = rec({ log: (m) => lines.push(m) });
    await h.init();
    await recordFour(h);
    await writeFile(join(dir, "3000.json.gz"), Buffer.alloc(0));
    const items = await h.window(1000, 4000, 1, BIG);
    expect(items.map((i) => i.ts)).toEqual([1000, 2000, 4000]);
    expect(lines.some((l) => l.includes("3000"))).toBe(true);
    expect(h.range()).toEqual({ from: 1000, to: 4000, snapshots: 3 });
  });

  it("returns [] for an empty history", async () => {
    const h = rec();
    await h.init();
    expect(await h.window(0, 9999, 1, BIG)).toEqual([]);
  });

  it("gz payloads round-trip to the recorded crafts", async () => {
    const h = rec();
    await h.init();
    await recordFour(h);
    const items = await h.window(1000, 4000, 1, BIG);
    expect(items.length).toBe(4);
    for (const [ts, id] of SNAPS) {
      const item = items.find((i) => i.ts === ts);
      expect(item).toBeDefined();
      expect(JSON.parse(gunzipSync(item!.gz).toString("utf8"))).toEqual([craft(id)]);
    }
  });
});
