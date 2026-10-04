import { gzipSync, gunzipSync } from "node:zlib";
import { mkdir, readdir, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Craft } from "../shared/craft.js";

export interface HistoryRange {
  from: number | null;
  to: number | null;
  snapshots: number;
}

export interface HistoryRecorderOpts {
  dir: string;
  snapshotMs: number;
  maxBytes: number;
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

  constructor(private opts: HistoryRecorderOpts) {
    this.now = opts.now ?? Date.now;
  }

  async init(): Promise<void> {
    await mkdir(this.opts.dir, { recursive: true });
    this.index = [];
    for (const f of await readdir(this.opts.dir)) {
      const m = /^(\d+)\.json\.gz$/.exec(f);
      if (!m) continue;
      const st = await stat(join(this.opts.dir, f)).catch(() => null);
      if (st) this.index.push({ ts: Number(m[1]), size: st.size });
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

  private async evict(): Promise<void> {
    let total = this.index.reduce((s, m) => s + m.size, 0);
    // Always keep at least the newest snapshot, even below the cap.
    while (total > this.opts.maxBytes && this.index.length > 1) {
      const oldest = this.index.shift()!;
      total -= oldest.size;
      await unlink(join(this.opts.dir, `${oldest.ts}.json.gz`)).catch(() => {});
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
