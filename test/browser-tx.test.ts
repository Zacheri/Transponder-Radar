import { afterEach, describe, expect, it, vi } from "vitest";
import { createBrowserTx, harvest, type ResourceEntryLike } from "../src/data/browser-tx.js";

// `over` types encodedBodySize on purpose: harvest must IGNORE it (R-A),
// and the cast keeps that a compile-checked claim, not an interface member.
const entry = (name: string, startTime: number, over: { transferSize?: number; encodedBodySize?: number } = {}): ResourceEntryLike =>
  ({ name, startTime, transferSize: 100, ...over }) as ResourceEntryLike;

const realPerformance = globalThis.performance;

afterEach(() => {
  vi.useRealTimers();
  globalThis.performance = realPerformance;
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

  it("skips opaque-origin entries (origin serializes to the string 'null')", () => {
    const seen = new Map<string, true>();
    expect(harvest([entry("data:image/png;base64,AAAA", 1)], seen, "http://app.test")).toBe(0);
    // Still skipped when re-surfaced (never counted, never evicted-for-nothing).
    expect(harvest([entry("data:image/png;base64,AAAA", 1)], seen, "http://app.test")).toBe(0);
  });

  it("WAN-exact size rule: transferSize || 0; encodedBodySize never used", () => {
    // R-A (spec §R2): an encodedBodySize fallback bills cache hits as WAN —
    // the sanctioned posture is exact-or-0 instead.
    const seen = new Map<string, true>();
    const down = harvest(
      [
        entry("https://a.test/1", 1, { transferSize: 10, encodedBodySize: 9999 }),
        entry("https://a.test/2", 2, { transferSize: 0, encodedBodySize: 4000 }), // cached tile: 0, NOT 4000
        entry("https://a.test/3", 3, { transferSize: undefined, encodedBodySize: undefined }),
      ],
      seen,
      "http://app.test",
    );
    expect(down).toBe(10);
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
    // overcount, never silent loss. Unreachable at runtime: start() caps the
    // timing buffer at SEEN_CAP and a buffer-full handler clears it, so the
    // caller can never surface an entry older than the newest 5000.
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
  function fakePerformance() {
    const reg = { listeners: new Map<string, (() => void)[]>() };
    const calls = { bufSizes: [] as number[], clears: 0 };
    const p = {
      setResourceTimingBufferSize: (n: number) => void calls.bufSizes.push(n),
      clearResourceTimings: () => void calls.clears++,
      addEventListener: (t: string, h: () => void) => {
        const a = reg.listeners.get(t) ?? [];
        a.push(h);
        reg.listeners.set(t, a);
      },
      removeEventListener: (t: string, h: () => void) => {
        const a = reg.listeners.get(t) ?? [];
        reg.listeners.set(t, a.filter((x) => x !== h));
      },
    };
    const fire = (t: string) => {
      for (const h of reg.listeners.get(t) ?? []) h();
    };
    return { p, reg, calls, fire };
  }

  it("start() sizes the timing buffer to the dedupe cap and clears it on buffer-full; stop() detaches", () => {
    const { p, reg, calls, fire } = fakePerformance();
    globalThis.performance = p as unknown as Performance;
    let entries: ResourceEntryLike[] = [];
    const tx = createBrowserTx({ getEntries: () => entries, send: () => {}, origin: "http://app.test" });
    tx.start();
    expect(calls.bufSizes).toEqual([5000]); // cap == SEEN_CAP: the no-resurface
    // invariant (LRU test above) provably holds while started.
    expect(reg.listeners.get("resourcetimingbufferfull") ?? []).toHaveLength(1);
    fire("resourcetimingbufferfull");
    expect(calls.clears).toBe(1);
    // Without the clear, a full buffer silently starves: new resources would
    // never enter the timing list, so the harvest would go blind. The fake
    // models that: entries stop being surfaced once cleared is NOT called —
    // clearing is what keeps the harvest fed.
    entries = [entry("https://t.test/after-full.png", 1)];
    fire("resourcetimingbufferfull");
    expect(calls.clears).toBe(2);
    tx.stop();
    expect(reg.listeners.get("resourcetimingbufferfull") ?? []).toHaveLength(0);
    fire("resourcetimingbufferfull");
    expect(calls.clears).toBe(2);
  });

  it("start/stop tolerate a performance object without the buffer API", () => {
    globalThis.performance = {} as Performance;
    const tx = createBrowserTx({ getEntries: () => [], send: () => {}, origin: "http://app.test" });
    tx.start();
    tx.stop();
  });

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

  it("dropped-while-closed: a delta whose send no-ops is gone, never re-sent (R-B)", () => {
    // main.ts wires send as `(down) => socket?.sendTrafficReport(down)`; this
    // pins that seam's ruled semantics (undercount ethos): RadarSocket.send
    // no-ops while the socket is not OPEN, the delta was already deduped,
    // and the harvest never accumulates or retries.
    vi.useFakeTimers();
    const captured: number[] = [];
    let socket: { sendTrafficReport: (d: number) => void } | null = { sendTrafficReport: (d) => captured.push(d) };
    let entries: ResourceEntryLike[] = [entry("https://t.test/a.png", 1)];
    const tx = createBrowserTx({
      getEntries: () => entries,
      send: (down) => socket?.sendTrafficReport(down),
      intervalMs: 1000,
      origin: "http://app.test",
    });
    tx.start();
    vi.advanceTimersByTime(1000);
    expect(captured).toEqual([100]);
    socket = null; // socket closed
    entries = [...entries, entry("https://t.test/b.png", 2)];
    vi.advanceTimersByTime(1000); // send fires once, lands nowhere
    socket = { sendTrafficReport: (d) => captured.push(d) }; // reopen
    vi.advanceTimersByTime(3000); // and is never re-sent
    expect(captured).toEqual([100]);
    tx.stop();
  });
});
