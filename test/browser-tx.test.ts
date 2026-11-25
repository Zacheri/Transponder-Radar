import { afterEach, describe, expect, it, vi } from "vitest";
import { createBrowserTx, harvest, type ResourceEntryLike } from "../src/data/browser-tx.js";

const entry = (name: string, startTime: number, over: Partial<ResourceEntryLike> = {}): ResourceEntryLike => ({
  name,
  startTime,
  transferSize: 100,
  ...over,
});

afterEach(() => {
  vi.useRealTimers();
});

describe("harvest", () => {
  it("skips same-origin entries and counts every cross-origin one", () => {
    const seen = new Map<string, true>();
    expect(
      harvest(
        [entry("http://localhost:1738/app.js", 1), entry("http://localhost:1738/icons/x", 2)],
        seen,
        "http://localhost:1738",
      ),
    ).toBe(0);
    // Same-origin means SAME origin string: 127.0.0.1 ≠ localhost by the
    // URL spec, so a 127.0.0.1 resource is WAN for a localhost page.
    expect(harvest([entry("http://127.0.0.1:1738/tile.png", 3)], seen, "http://localhost:1738")).toBe(100);
    // Unparseable names count as cross-origin (never proven local).
    expect(harvest([entry("not-a-url", 4)], seen, "http://localhost:1738")).toBe(100);
  });

  it("bytes per entry: transferSize wins, then encodedBodySize, both missing → 0", () => {
    const seen = new Map<string, true>();
    const down = harvest(
      [
        entry("https://a.test/1", 1, { transferSize: 10, encodedBodySize: 5 }),
        entry("https://a.test/2", 2, { transferSize: 0, encodedBodySize: 7 }),
        entry("https://a.test/3", 3, { transferSize: 0, encodedBodySize: 0 }),
        entry("https://a.test/4", 4, { transferSize: undefined, encodedBodySize: undefined }),
      ],
      seen,
      "http://app.test",
    );
    expect(down).toBe(17);
  });

  it("dedupes across harvests: repeats never re-count, new entries do", () => {
    const seen = new Map<string, true>();
    const batch = [entry("https://tile.test/a.png", 1), entry("https://tile.test/b.png", 2)];
    expect(harvest(batch, seen, "http://app.test")).toBe(200);
    expect(harvest(batch, seen, "http://app.test")).toBe(0);
    expect(harvest([...batch, entry("https://tile.test/c.png", 3)], seen, "http://app.test")).toBe(100);
  });

  it("LRU cap 5000 evicts the oldest key; a reappearance after eviction re-counts once", () => {
    // Documented tolerance: dedupe memory is bounded, so an entry whose key
    // was evicted counts again if the caller still surfaces it — bounded
    // overcount, never silent loss. The browser's resource buffer (a few
    // hundred entries) is far below the cap, so evicted keys belong to
    // entries the caller can no longer surface; the re-count path only fires
    // for callers with oversized backlogs.
    const seen = new Map<string, true>();
    const fill = Array.from({ length: 5000 }, (_, i) => entry(`https://t.test/${i}.png`, i));
    expect(harvest(fill, seen, "http://app.test")).toBe(5000 * 100);
    expect(seen.size).toBe(5000);
    // One new entry evicts t/0's key (Map insertion order = oldest first)…
    expect(harvest([...fill, entry("https://t.test/last.png", 9999)], seen, "http://app.test")).toBe(100);
    expect(seen.size).toBe(5000);
    // …so t/0 re-counts exactly once on reappearance, then sticks again.
    expect(harvest([entry("https://t.test/0.png", 0)], seen, "http://app.test")).toBe(100);
    expect(harvest([entry("https://t.test/0.png", 0)], seen, "http://app.test")).toBe(0);
  });
});

describe("createBrowserTx", () => {
  it("ticks every intervalMs, sends positive deltas only (zero-delta ticks silent)", () => {
    vi.useFakeTimers();
    const sent: number[] = [];
    let entries: ResourceEntryLike[] = [entry("https://t.test/a.png", 1)];
    const tx = createBrowserTx({
      getEntries: () => entries,
      send: (down) => sent.push(down),
      intervalMs: 1000,
      origin: "http://app.test",
    });
    tx.start();
    vi.advanceTimersByTime(3000); // tick 1 sends 100; ticks 2–3 dedupe to 0
    expect(sent).toEqual([100]);
    entries = [...entries, entry("https://t.test/b.png", 2)];
    vi.advanceTimersByTime(1000);
    expect(sent).toEqual([100, 100]);
    tx.stop();
    entries = [...entries, entry("https://t.test/c.png", 3)];
    vi.advanceTimersByTime(3000);
    expect(sent).toHaveLength(2);
  });

  it("default interval is 5000 ms; start/stop are idempotent", () => {
    vi.useFakeTimers();
    const sent: number[] = [];
    const tx = createBrowserTx({
      getEntries: () => [entry("https://t.test/x.png", 1)],
      send: (down) => sent.push(down),
      origin: "http://app.test",
    });
    tx.start();
    tx.start();
    vi.advanceTimersByTime(4999);
    expect(sent).toHaveLength(0);
    vi.advanceTimersByTime(1);
    expect(sent).toHaveLength(1);
    tx.stop();
    tx.stop();
    vi.advanceTimersByTime(20000);
    expect(sent).toHaveLength(1);
  });
});
