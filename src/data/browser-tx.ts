// Browser WAN-down harvest (spec 2026-11-25 §B/R2): cross-origin
// resource-timing entries are the browser's WAN DOWNLOADS; same-origin
// (local server, page assets) never counts. Deltas ride traffic.report.

export interface ResourceEntryLike {
  name: string;
  startTime: number;
  transferSize?: number;
}

const SEEN_CAP = 5000; // dedupe LRU, Map insertion order

const entryOrigin = (name: string): string | null => {
  try {
    return new URL(name).origin;
  } catch {
    return null; // never proven same-origin → counts
  }
};

/**
 * Sum WAN-down bytes for cross-origin entries not yet in `seen`, marking
 * them. Same-origin is strict origin-string equality (127.0.0.1 ≠
 * localhost); an origin serializing to "null" (opaque: data:/blob:/sandboxed)
 * never carries WAN info and is skipped. Bytes are `transferSize || 0` —
 * WAN-exact (spec R2 R-A: an encodedBodySize fallback would bill cache hits
 * as downloads; hidden/0 sizes count 0, the sanctioned honest undercount).
 * `seen` is a bounded LRU keyed `name|startTime`; start() caps the timing
 * buffer at SEEN_CAP and clears it on overflow, so a caller feeding
 * `performance` can never surface an entry whose key was evicted.
 */
export function harvest(entries: ResourceEntryLike[], seen: Map<string, true>, origin: string): number {
  let down = 0;
  for (const e of entries) {
    const src = entryOrigin(e.name);
    if ((src !== null && src === origin) || src === "null") continue;
    const key = `${e.name}|${e.startTime}`;
    if (seen.has(key)) continue;
    seen.set(key, true);
    if (seen.size > SEEN_CAP) {
      const oldest = seen.keys().next();
      if (!oldest.done) seen.delete(oldest.value);
    }
    down += e.transferSize || 0;
  }
  return down;
}

export interface BrowserTxOpts {
  getEntries?: () => ResourceEntryLike[];
  send: (down: number) => void;
  intervalMs?: number;
  origin?: string;
}

export function createBrowserTx(opts: BrowserTxOpts): { start(): void; stop(): void } {
  const getEntries =
    opts.getEntries ??
    (() =>
      typeof performance !== "undefined" ? (performance.getEntriesByType("resource") as ResourceEntryLike[]) : []);
  const intervalMs = opts.intervalMs ?? 5000;
  const origin = opts.origin ?? (typeof location !== "undefined" ? location.origin : "");
  const seen = new Map<string, true>();
  let timer: ReturnType<typeof setInterval> | null = null;

  // Buffer starvation guard: a full resource-timing buffer stops accepting
  // entries SILENTLY, so an uncleared full buffer starves the harvest blind.
  // Cap the buffer at SEEN_CAP and clear on the full event — while started,
  // the visible set never exceeds the dedupe LRU (the no-resurface invariant
  // the harvest tests pin). Feature-existence-guarded for non-browser hosts.
  const onBufferFull = (): void => {
    if (typeof performance !== "undefined" && typeof performance.clearResourceTimings === "function") {
      performance.clearResourceTimings();
    }
  };
  const armBuffer = (): void => {
    if (typeof performance === "undefined") return;
    if (typeof performance.setResourceTimingBufferSize === "function") {
      performance.setResourceTimingBufferSize(SEEN_CAP);
    }
    performance.addEventListener?.("resourcetimingbufferfull", onBufferFull);
  };

  return {
    start() {
      if (timer) return;
      armBuffer();
      timer = setInterval(() => {
        const down = harvest(getEntries(), seen, origin);
        if (down > 0) opts.send(down); // zero-delta ticks stay silent; a delta
        // whose send no-ops (socket closed — RadarSocket.send drops it) is
        // ruled dropped, not accumulated: undercount ethos, R-B.
      }, intervalMs);
    },
    stop() {
      if (timer) {
        clearInterval(timer);
        timer = null;
      }
      if (typeof performance !== "undefined") {
        performance.removeEventListener?.("resourcetimingbufferfull", onBufferFull);
      }
    },
  };
}
