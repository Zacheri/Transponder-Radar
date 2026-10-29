// SnapshotCache: a byte-capped LRU cache of decoded history snapshots
// (arrays of Craft). Map insertion order IS the LRU order — a `get` hit
// re-inserts at the end (MRU); trim/presize drop from the front (LRU).
// rawBytes is the caller-provided size proxy for each snapshot.
import type { Craft } from "../shared/craft.js";

export interface SnapshotCacheOpts { maxBytes: number; log?: (msg: string) => void }

interface Entry { crafts: Craft[]; size: number }

export class SnapshotCache {
  private map = new Map<number, Entry>();
  private maxBytes: number;
  private used = 0;

  constructor(opts: SnapshotCacheOpts) {
    this.maxBytes = opts.maxBytes;
  }

  get(ts: number): Craft[] | undefined {
    const entry = this.map.get(ts);
    if (!entry) return undefined;
    // Hit → move to MRU end (delete then re-set preserves size/count).
    this.map.delete(ts);
    this.map.set(ts, entry);
    return entry.crafts;
  }

  set(ts: number, crafts: Craft[], rawBytes: number): void {
    if (this.maxBytes <= 0) return; // disabled (resize(0))
    const existing = this.map.get(ts);
    if (existing) {
      this.used -= existing.size; // release prior bytes before recounting
      this.map.delete(ts);
    }
    this.map.set(ts, { crafts, size: rawBytes });
    this.used += rawBytes;
    this.trim();
  }

  drop(ts: number): void {
    const entry = this.map.get(ts);
    if (entry) {
      this.used -= entry.size;
      this.map.delete(ts);
    }
  }

  resize(maxBytes: number): void {
    this.maxBytes = maxBytes;
    if (maxBytes <= 0) {
      this.map.clear();
      this.used = 0;
      return;
    }
    this.trim();
  }

  usedBytes(): number {
    return this.used;
  }

  private trim(): void {
    while (this.used > this.maxBytes && this.map.size > 0) {
      const lru = this.map.keys().next().value;
      if (lru === undefined) break;
      const entry = this.map.get(lru)!;
      this.used -= entry.size;
      this.map.delete(lru);
    }
  }
}
