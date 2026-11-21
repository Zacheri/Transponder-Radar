import yauzl from "yauzl";
import { mkdir, readFile, readdir, rename, stat, unlink, utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Buffer } from "node:buffer";

export interface FaaRecord {
  nNumber: string;
  year: number | null;
  mfr: string | null;
  model: string | null;
  owner: string | null;
  city: string | null;
  state: string | null;
}

export interface FaaStatus {
  state: "loading" | "ready" | "stale" | "error";
  updatedAt: number | null;
  aircraft: number;
  lastError: string | null;
}

export interface FaaProvider {
  lookup(hex: string): FaaRecord | null;
  merge(hex: string, rec: FaaRecord): void;
  status(): FaaStatus;
  init(): Promise<void>;
  stop(): void;
}

/** Staleness gate: a download may start only once this much time has passed
 *  since the last successful one (persisted as the extracted files' mtime). */
export const STALENESS_GATE_MS = 24 * 3600 * 1000;
const DAY_MS = 24 * 3600 * 1000;
export const WEEKLY_KEEP = 52;
export const DAILY_KEEP = 16;
const WEEKLY_DIR = "fridays";
const DAILY_DIR = "dailies";
const SNAPSHOT_RE = /^ReleasableAircraft-(\d{4})-(\d{2})-(\d{2})\.zip$/;
const DEFAULT_ZIP_URL = "https://registry.faa.gov/database/ReleasableAircraft.zip";
const MASTER_NAME = "MASTER.txt";
const REF_NAME = "ACFTREF.txt";

/** RFC4180-lite: BOM, quoted fields, CRLF; every field is trimmed (FAA pads columns). */
export function parseCsv(text: string): string[][] {
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ",") {
      row.push(field.trim());
      field = "";
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      row.push(field.trim());
      field = "";
      if (row.length > 1 || row[0] !== "") rows.push(row);
      row = [];
    } else {
      field += ch;
    }
  }
  if (field !== "" || row.length > 0) {
    row.push(field.trim());
    if (row.length > 1 || row[0] !== "") rows.push(row);
  }
  return rows;
}

/** Fixed column layout of FAA MASTER.txt (1-based in FAA docs, 0-based here). */
const C_N = 0;
const C_MFR_MDL_CODE = 2;
const C_YEAR = 4;
const C_NAME = 6;
const C_CITY = 9;
const C_STATE = 10;
const C_MODES_HEX = 33;

export function buildIndex(masterText: string, refText: string): Map<string, FaaRecord> {
  const ref = new Map<string, { mfr: string; model: string }>();
  for (const r of parseCsv(refText).slice(1)) {
    if (r[0]) ref.set(r[0], { mfr: r[1] || "", model: r[2] || "" });
  }
  const idx = new Map<string, FaaRecord>();
  for (const r of parseCsv(masterText).slice(1)) {
    const hex = (r[C_MODES_HEX] ?? "").toUpperCase();
    const rawN = r[C_N] ?? "";
    if (!rawN || !hex) continue;
    const codeInfo = ref.get(r[C_MFR_MDL_CODE] ?? "");
    const yearRaw = r[C_YEAR] ?? "";
    idx.set(hex.toLowerCase(), {
      nNumber: (rawN.startsWith("N") ? rawN : `N${rawN}`).toUpperCase(),
      year: yearRaw && Number.isInteger(Number(yearRaw)) ? Number(yearRaw) : null,
      mfr: codeInfo?.mfr || null,
      model: codeInfo?.model || null,
      owner: r[C_NAME] || null,
      city: r[C_CITY] || null,
      state: r[C_STATE] || null,
    });
  }
  return idx;
}

function isoDay(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** The Friday 00:00 local that anchors the week (Friday -> next Thursday) containing `now`. */
export function weekFriday(now: number): Date {
  const d = new Date(now);
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() - ((d.getDay() + 2) % 7));
  return d;
}

function snapshotDates(names: string[]): Map<string, number> {
  const out = new Map<string, number>();
  for (const name of names) {
    const m = SNAPSHOT_RE.exec(name);
    if (m) out.set(name, new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])).getTime());
  }
  return out;
}

/** Dailies to delete, given a directory listing: everything dated before the most
 *  recent PAST Friday (that Friday's own copy is kept), but only once today is >= 7
 *  days past that Friday; then the newest `keep` win. Weekly snapshots are never seen here. */
export function planDailyCleanup(names: string[], now: number, keep = DAILY_KEEP): string[] {
  const dates = snapshotDates(names);
  const today = new Date(now);
  today.setHours(0, 0, 0, 0);
  const friday = weekFriday(now);
  if (friday.getTime() === today.getTime()) friday.setDate(friday.getDate() - 7);
  const doomed: string[] = [];
  if (Math.round((today.getTime() - friday.getTime()) / DAY_MS) >= 7) {
    for (const [name, day] of dates)
      if (day < friday.getTime()) {
        doomed.push(name);
        dates.delete(name);
      }
  }
  return [...doomed, ...[...dates].sort((a, b) => b[1] - a[1]).slice(keep).map(([name]) => name)];
}

/** Weekly snapshots to delete, given a directory listing: only the newest `keep` survive. */
export function planWeeklyCleanup(names: string[], keep = WEEKLY_KEEP): string[] {
  return [...snapshotDates(names)].sort((a, b) => b[1] - a[1]).slice(keep).map(([name]) => name);
}

export interface FaaLoaderOpts {
  dir: string;
  refreshMs: number;
  zipUrl?: string;
  fetchImpl?: typeof fetch;
  now?: () => number;
  log?: (msg: string) => void;
}

export class FaaLoader implements FaaProvider {
  private index = new Map<string, FaaRecord>();
  private state: "loading" | "ready" | "stale" | "error" = "loading";
  private updatedAt: number | null = null;
  private lastError: string | null = null;
  private timer: NodeJS.Timeout | null = null;
  private now: () => number;

  constructor(private opts: FaaLoaderOpts) {
    this.now = opts.now ?? Date.now;
  }

  status(): FaaStatus {
    return { state: this.state, updatedAt: this.updatedAt, aircraft: this.index.size, lastError: this.lastError };
  }

  lookup(hex: string): FaaRecord | null {
    return this.index.get(hex.toLowerCase()) ?? null;
  }

  merge(hex: string, rec: FaaRecord): void {
    this.index.set(hex.toLowerCase(), rec);
  }

  async init(): Promise<void> {
    try {
      await mkdir(this.opts.dir, { recursive: true });
      if (await this.downloadAllowed()) {
        await this.refresh();
      } else {
        try {
          await this.loadFromDisk();
          this.state = this.index.size ? "ready" : "error";
        } catch {
          this.state = "error";
        }
      }
      await this.pruneSnapshots();
      this.timer = setInterval(() => {
        this.check().catch((e) => this.opts.log?.(`faa: refresh failed: ${e instanceof Error ? e.message : String(e)}`));
      }, this.opts.refreshMs);
    } catch (e) {
      this.state = "error";
      this.lastError = e instanceof Error ? e.message : String(e);
      throw e;
    }
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** Periodic tick: download only when the staleness gate has opened; prune every time. */
  async check(): Promise<void> {
    if (await this.downloadAllowed()) await this.refresh();
    await this.pruneSnapshots();
  }

  /** Last successful download = oldest mtime of the extracted files (failed downloads
   *  never touch them, so the gate clock never moves on failure). 0 = no usable data. */
  private async lastDownloadMs(): Promise<number> {
    let oldest = Number.POSITIVE_INFINITY;
    for (const name of [MASTER_NAME, REF_NAME]) {
      const st = await stat(join(this.opts.dir, name)).catch(() => null);
      if (!st) return 0;
      oldest = Math.min(oldest, st.mtimeMs);
    }
    return oldest;
  }

  private async downloadAllowed(): Promise<boolean> {
    return this.now() - (await this.lastDownloadMs()) >= STALENESS_GATE_MS;
  }

  /** Loads + parses disk data. Does NOT set `state` — the caller decides
   *  ready (fresh) vs stale (fallback after a failed download). */
  private async loadFromDisk(): Promise<void> {
    const master = await readFile(join(this.opts.dir, MASTER_NAME), "utf8");
    const ref = await readFile(join(this.opts.dir, REF_NAME), "utf8");
    this.index = buildIndex(master, ref);
    this.updatedAt = this.now();
  }

  /** Download + install the bulk database. Un-gated: the staleness gate is the caller's decision. */
  async refresh(): Promise<void> {
    let downloaded = false;
    try {
      await this.downloadAndExtract();
      downloaded = true;
    } catch (e) {
      this.lastError = e instanceof Error ? e.message : String(e);
    }
    try {
      await this.loadFromDisk();
    } catch {
      if (!this.lastError) this.lastError = "no disk data";
    }
    this.state = downloaded ? "ready" : this.index.size ? "stale" : "error";
  }

  private async downloadAndExtract(): Promise<void> {
    const fetchImpl = this.opts.fetchImpl ?? fetch;
    const res = await fetchImpl(this.opts.zipUrl ?? DEFAULT_ZIP_URL);
    if (!res.ok) throw new Error(`FAA download HTTP ${res.status}`);
    const buf = Buffer.from(await res.arrayBuffer());
    const zipPath = join(this.opts.dir, "ReleasableAircraft.zip");
    await writeFile(zipPath, buf);
    await this.snapshot(buf);
    try {
      const entries = await this.extractEntries(zipPath, [MASTER_NAME, REF_NAME]);
      for (const name of [MASTER_NAME, REF_NAME]) {
        const tmp = join(this.opts.dir, `${name}.tmp`);
        await writeFile(tmp, entries[name]);
        await rename(tmp, join(this.opts.dir, name));
      }
      // Persist the gate clock: the extracted files' mtime is the last successful download.
      const when = new Date(this.now());
      for (const name of [MASTER_NAME, REF_NAME]) await utimes(join(this.opts.dir, name), when, when);
    } finally {
      await unlink(zipPath).catch(() => {});
    }
  }

  /** Keep the raw zip bytes: one copy per day, plus one for the first download of each
   *  Friday-anchored week. Redundancy only — a snapshot failure never fails the download. */
  private async snapshot(buf: Buffer): Promise<void> {
    try {
      const now = this.now();
      await mkdir(join(this.opts.dir, DAILY_DIR), { recursive: true });
      await mkdir(join(this.opts.dir, WEEKLY_DIR), { recursive: true });
      const daily = `ReleasableAircraft-${isoDay(new Date(now))}.zip`;
      await writeFile(join(this.opts.dir, DAILY_DIR, daily), buf);
      this.opts.log?.(`faa: snapshot ${DAILY_DIR}/${daily}`);
      const friday = isoDay(weekFriday(now));
      const weeklyName = `ReleasableAircraft-${friday}.zip`;
      const weekly = join(this.opts.dir, WEEKLY_DIR, weeklyName);
      if (!(await stat(weekly).catch(() => null))) {
        await writeFile(weekly, buf);
        this.opts.log?.(`faa: snapshot ${WEEKLY_DIR}/${weeklyName}`);
      }
    } catch (e) {
      this.opts.log?.(`faa: snapshot failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  /** Apply the retention plans to both snapshot directories (init + every check tick). */
  private async pruneSnapshots(): Promise<void> {
    await this.pruneDir(WEEKLY_DIR, (names) => planWeeklyCleanup(names));
    await this.pruneDir(DAILY_DIR, (names) => planDailyCleanup(names, this.now()));
  }

  private async pruneDir(sub: string, plan: (names: string[]) => string[]): Promise<void> {
    const dir = join(this.opts.dir, sub);
    let names: string[];
    try {
      names = await readdir(dir);
    } catch {
      return;
    }
    for (const name of plan(names)) {
      try {
        await unlink(join(dir, name));
        this.opts.log?.(`faa: pruned ${sub}/${name}`);
      } catch {
        // vanished concurrently; next tick re-plans
      }
    }
  }

  private extractEntries(zipPath: string, names: string[]): Promise<Record<string, Buffer>> {
    return new Promise((resolve, reject) => {
      yauzl.open(zipPath, { lazyEntries: true }, (err, zip) => {
        if (err || !zip) return reject(err ?? new Error("yauzl: open failed"));
        const out: Record<string, Buffer> = {};
        const wanted = new Set(names);
        zip.readEntry();
        zip.on("entry", (entry: yauzl.Entry) => {
          if (!wanted.has(entry.fileName)) {
            zip.readEntry();
            return;
          }
          zip.openReadStream(entry, (err, rs) => {
            if (err) {
              zip.close();
              return reject(err);
            }
            const chunks: Buffer[] = [];
            rs.on("data", (c: Buffer) => chunks.push(c));
            rs.on("end", () => {
              out[entry.fileName] = Buffer.concat(chunks);
              zip.readEntry();
            });
            rs.on("error", (e) => {
              zip.close();
              reject(e);
            });
          });
        });
        zip.on("end", () => {
          if (names.every((n) => out[n])) resolve(out);
          else reject(new Error("yauzl: missing expected entry"));
        });
        zip.on("error", reject);
      });
    });
  }
}
