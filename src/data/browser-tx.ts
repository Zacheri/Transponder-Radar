// Browser WAN-down harvest (spec 2026-11-25 §B/R2): cross-origin
// resource-timing entries are the browser's WAN DOWNLOADS; same-origin
// (local server, page assets) never counts. Deltas ride traffic.report.

export interface ResourceEntryLike {
  name: string;
  startTime: number;
  transferSize?: number;
  encodedBodySize?: number;
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
 * them. Same-origin is strict origin-string equality (127.0.0.1 ≠ localhost).
 * Per-entry bytes are `transferSize || encodedBodySize || 0` — exact-or-0 per
 * spec (cross-origin responses without Timing-Allow-Origin hide both sizes;
 * honest undercount). `seen` is a bounded LRU keyed `name|startTime`: entries
 * outliving their key's eviction re-count once — documented tolerance, the
 * alternative is unbounded memory.
 */
export function harvest(entries: ResourceEntryLike[], seen: Map<string, true>, origin: string): number {
  let down = 0;
  for (const e of entries) {
    const src = entryOrigin(e.name);
    if (src !== null && src === origin) continue;
    const key = `${e.name}|${e.startTime}`;
    if (seen.has(key)) continue;
    seen.set(key, true);
    if (seen.size > SEEN_CAP) {
      const oldest = seen.keys().next();
      if (!oldest.done) seen.delete(oldest.value);
    }
    down += e.transferSize || e.encodedBodySize || 0;
  }
  return down;
}

export interface BrowserTxOpts {
  // Accepted for interface symmetry with the tick-driven factories; unused —
  // dedupe keys carry the entry's own startTime.
  now?: () => number;
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
  return {
    start() {
      if (timer) return;
      timer = setInterval(() => {
        const down = harvest(getEntries(), seen, origin);
        if (down > 0) opts.send(down); // zero-delta ticks stay silent
      }, intervalMs);
    },
    stop() {
      if (timer) {
        clearInterval(timer);
        timer = null;
      }
    },
  };
}
