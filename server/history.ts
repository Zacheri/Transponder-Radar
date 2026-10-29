import { gzipSync, gunzipSync } from "node:zlib";
import { mkdir, readdir, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Craft } from "../shared/craft.js";
import type { PinStore } from "./pins.js";
import type { SnapshotCache } from "./snapshot-cache.js";

export interface HistoryRange {
  from: number | null;
  to: number | null;
  snapshots: number;
}

export interface HistoryRecorderOpts {
  dir: string;
  snapshotMs: number;
  maxBytes: number;
  pins?: PinStore;            // omit = no pin awareness (legacy behavior)
  cache?: SnapshotCache;      // used in Task 7
  now?: () => number;
  log?: (msg: string) => void;
}

interface Meta {
  ts: number;
  size: number;
}

export class HistoryRecorder {
  private timer: NodeJS.Timeout | null = null;
  private index: Meta[] = []; // ascending ts
  private now: () => number;
  private maxBytes: number; // live cap (setCap updates it)

  constructor(private opts: HistoryRecorderOpts) {
    this.now = opts.now ?? Date.now;
    this.maxBytes = opts.maxBytes;
  }

  async init(): Promise<void> {
    await mkdir(this.opts.dir, { recursive: true });
    this.index = [];
    for (const f of await readdir(this.opts.dir)) {
      const m = /^(\d+)\.json\.gz$/.exec(f);
      if (!m) continue; // non-snapshot files (e.g. pins.json) stay untouched
      const st = await stat(join(this.opts.dir, f)).catch(() => null);
      if (!st) continue;
      if (st.size === 0) {
        // 0-byte snapshot (interrupted write): drop it — a seek onto one
        // would bounce to LIVE.
        await unlink(join(this.opts.dir, f)).catch(() => {});
        this.opts.log?.(`history: removed 0-byte snapshot ${f}`);
        continue;
      }
      this.index.push({ ts: Number(m[1]), size: st.size });
    }
    this.index.sort((a, b) => a.ts - b.ts);
    await this.evict();
  }

  start(getCrafts: () => Craft[]): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      this.recordNow(getCrafts).catch((e) =>
        this.opts.log?.(`history: ${e instanceof Error ? e.message : String(e)}`),
      );
    }, this.opts.snapshotMs);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async recordNow(getCrafts: () => Craft[]): Promise<void> {
    const ts = this.now();
    const buf = gzipSync(Buffer.from(JSON.stringify(getCrafts())));
    const final = join(this.opts.dir, `${ts}.json.gz`);
    await writeFile(join(this.opts.dir, `${ts}.json.gz.tmp`), buf);
    await rename(join(this.opts.dir, `${ts}.json.gz.tmp`), final);
    this.index.push({ ts, size: buf.length });
    this.index.sort((a, b) => a.ts - b.ts);
    await this.evict();
  }

  /** Update the live cap and fire an async evict (errors logged). */
  setCap(bytes: number): void {
    this.maxBytes = bytes;
    this.evict().catch((e) =>
      this.opts.log?.(`history: evict failed: ${e instanceof Error ? e.message : String(e)}`),
    );
  }

  /** Copy of the index, ascending ts. */
  entries(): { ts: number; size: number }[] {
    return this.index.map((m) => ({ ts: m.ts, size: m.size }));
  }

  /** Sum of ALL index sizes (pinned + unpinned). */
  usedBytes(): number {
    return this.index.reduce((s, m) => s + m.size, 0);
  }

  get snapshotMs(): number {
    return this.opts.snapshotMs;
  }

  private async evict(): Promise<void> {
    for (;;) {
      // Recompute from the LIVE index every iteration: a concurrent evict
      // (setCap / recordNow / init) may have removed entries since we started.
      const unpinned = this.index.filter((m) => !this.opts.pins?.contains(m.ts));
      const total = unpinned.reduce((s, m) => s + m.size, 0);
      if (total <= this.maxBytes || unpinned.length === 0) break;
      const candidate = unpinned[0]; // oldest unpinned (index is ascending)
      // Keep-newest invariant: never evict the newest snapshot, even above cap.
      if (unpinned.length === 1 && candidate.ts === this.index[this.index.length - 1].ts) break;
      // Idempotent removal by ts (a concurrent evict may have removed it already).
      this.index = this.index.filter((m) => m.ts !== candidate.ts);
      // The file may already be gone — ignore the error.
      await unlink(join(this.opts.dir, `${candidate.ts}.json.gz`)).catch(() => {});
    }
  }

  range(): HistoryRange {
    const n = this.index.length;
    return { from: n ? this.index[0].ts : null, to: n ? this.index[n - 1].ts : null, snapshots: n };
  }

  /** Newest snapshot with ts <= time; clamps to oldest/newest; null time when empty. */
  async seek(time: number): Promise<{ time: number | null; craft: Craft[] }> {
    if (this.index.length === 0) return { time: null, craft: [] };
    let pick = this.index[0];
    for (const m of this.index) {
      if (m.ts <= time) pick = m;
      else break;
    }
    const raw = await readFile(join(this.opts.dir, `${pick.ts}.json.gz`));
    const craft = JSON.parse(gunzipSync(raw).toString("utf8")) as Craft[];
    return { time: pick.ts, craft };
  }
}
