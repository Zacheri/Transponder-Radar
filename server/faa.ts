import yauzl from "yauzl";
import { mkdir, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
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

export const FRESHNESS_MS = 20 * 3600 * 1000;
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
      if (await this.diskFresh()) {
        try {
          await this.loadFromDisk();
          this.state = this.index.size ? "ready" : "error";
        } catch {
          this.state = "error";
        }
      } else {
        await this.refresh();
      }
      this.timer = setInterval(() => {
        this.refresh().catch((e) => this.opts.log?.(`faa: refresh failed: ${e instanceof Error ? e.message : String(e)}`));
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

  private async diskFresh(): Promise<boolean> {
    for (const name of [MASTER_NAME, REF_NAME]) {
      const st = await stat(join(this.opts.dir, name)).catch(() => null);
      if (!st || this.now() - st.mtimeMs > FRESHNESS_MS) return false;
    }
    return true;
  }

  /** Loads + parses disk data. Does NOT set `state` — the caller decides
   *  ready (fresh) vs stale (fallback after a failed download). */
  private async loadFromDisk(): Promise<void> {
    const master = await readFile(join(this.opts.dir, MASTER_NAME), "utf8");
    const ref = await readFile(join(this.opts.dir, REF_NAME), "utf8");
    this.index = buildIndex(master, ref);
    this.updatedAt = this.now();
  }

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
    try {
      const entries = await this.extractEntries(zipPath, [MASTER_NAME, REF_NAME]);
      for (const name of [MASTER_NAME, REF_NAME]) {
        const tmp = join(this.opts.dir, `${name}.tmp`);
        await writeFile(tmp, entries[name]);
        await rename(tmp, join(this.opts.dir, name));
      }
    } finally {
      await unlink(zipPath).catch(() => {});
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
