import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { SEA_KINDS } from "../shared/craft.js";
import { sniffImageType } from "../shared/pack-transforms.js";
import { AIR_FAMILY_ICONS } from "./icons.js";
import type { IconSources } from "./iconpack-sources.js";

// Vendored aircraft icon pack (spec §3–4): three pinned upstream sources
// (pw, rk, pd) are materialized under <dir> (e.g. data/icons/) and indexed
// here. The default transport does the real download (shallow git fetch of
// the pinned shas + fetch + sha256-verified fetch for the pd files); this
// module owns verification, index build, validation, attribution, and status.

export type IconPackState = "absent" | "downloading" | "ready" | "failed";

export interface IconStatus {
  state: IconPackState;
  count: number; // resolvable icon count (index minus vetoed)
  updatedAt: number | null;
  lastError: string | null;
}

export type PackStyle = "filled" | "line" | "gapfill";

export interface PackIconEntry {
  name: string; // "pw:B737" | "rk:C130" | "pd:E3"
  source: "pw" | "rk" | "pd";
  file: string; // relative to data/icons/, e.g. "rk/C130.svg"
  style: PackStyle;
  title: string;
  license: string;
  cropTopRatio?: number; // gapfill only
}

export interface IconPackTransport {
  cloneRepo(repo: string, sha: string, destDir: string): Promise<void>;
  fetchFile(url: string, destPath: string, sha256: string): Promise<void>;
}

// Built-in MapLibre image names the pack must never collide with: the 13 air
// shape families plus the 10 sea kind icons (tanker_air is a family name).
// A collision is a curation bug — init fails rather than registering it.
const RESERVED_NAMES = new Set<string>([...AIR_FAMILY_ICONS, ...SEA_KINDS]);

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** Run a git command (no shell); resolve stdout, reject with the stderr tail on non-zero exit. */
function git(cwd: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile("git", args, { cwd, maxBuffer: 64 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) {
        const tail = String(stderr ?? "")
          .trim()
          .split("\n")
          .filter(Boolean)
          .slice(-2)
          .join(" | ");
        reject(new Error(`git ${args.slice(0, 2).join(" ")}: ${tail || err.message}`));
        return;
      }
      resolve(stdout);
    });
  });
}

// Known upstream subpaths and where each lands under destDir. The pw dirs keep
// their names under destDir; rk's "Shapes SVG" unpacks directly into destDir
// (its files ARE the rk set — spec §3 layout `rk/*.svg`).
const SUBPATH_DEST = new Map<string, (d: string) => string>([
  ["silhouettes", (d) => join(d, "silhouettes")],
  ["airframes", (d) => join(d, "airframes")],
  ["Shapes SVG", (d) => d],
]);

/**
 * Shallow-fetch the pinned `sha` of `repo` (full SHA — GitHub serves reachable
 * SHAs) and check out whichever known subpaths exist at that tree into
 * `destDir`. Throws on non-zero git exit (stderr tail) or when no known
 * subpath exists at the sha (manifest/repo drift).
 */
async function cloneRepo(repo: string, sha: string, destDir: string): Promise<void> {
  const tmp = mkdtempSync(join(tmpdir(), "iconpack-clone-"));
  try {
    await git(dirname(tmp), ["init", "-q", tmp]);
    await git(tmp, ["remote", "add", "origin", repo]);
    await git(tmp, ["fetch", "-q", "--depth", "1", "origin", sha]);
    const tree = (await git(tmp, ["ls-tree", "-d", "--name-only", "FETCH_HEAD"])).split("\n");
    const subs = [...SUBPATH_DEST.keys()].filter((s) => tree.includes(s));
    if (subs.length === 0) {
      throw new Error(`cloneRepo: no known subpath (${[...SUBPATH_DEST.keys()].join(", ")}) at ${sha.slice(0, 12)} in ${repo}`);
    }
    for (const s of subs) {
      await git(tmp, ["checkout", "-q", "FETCH_HEAD", "--", s]);
      const dest = SUBPATH_DEST.get(s)!(destDir);
      mkdirSync(dest, { recursive: true });
      cpSync(join(tmp, s), dest, { recursive: true });
    }
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

/** Fetch `url` with global fetch; verify sha256 before writing; mismatch throws. */
async function fetchFile(url: string, destPath: string, sha256: string): Promise<void> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`fetchFile ${url}: HTTP ${res.status}`);
  const bytes = Buffer.from(await res.arrayBuffer());
  const got = createHash("sha256").update(bytes).digest("hex");
  if (got !== sha256) {
    throw new Error(`fetchFile ${url}: sha256 mismatch: expected ${sha256}, got ${got}`);
  }
  mkdirSync(dirname(destPath), { recursive: true });
  writeFileSync(destPath, bytes);
}

const DEFAULT_TRANSPORT: IconPackTransport = { cloneRepo, fetchFile };

/** Atomic write (tmp + rename). */
function atomicWrite(p: string, text: string): void {
  const tmp = `${p}.tmp`;
  writeFileSync(tmp, text);
  renameSync(tmp, p);
}

function fileOk(p: string): boolean {
  try {
    const s = statSync(p);
    return s.isFile() && s.size > 0;
  } catch {
    return false;
  }
}

/** File names in a directory ([] when missing). */
function listFiles(dirPath: string): string[] {
  try {
    return readdirSync(dirPath).filter((n) => fileOk(join(dirPath, n)));
  } catch {
    return [];
  }
}

export class IconPack {
  private state: IconPackState = "absent";
  private updatedAt: number | null = null;
  private lastError: string | null = null;
  private index = new Map<string, PackIconEntry>();
  private vetoed = new Set<string>();
  private now: () => number;
  private transport: IconPackTransport;

  constructor(
    private opts: {
      dir: string; // e.g. <cwd>/data/icons
      sources: IconSources;
      log?: (m: string) => void;
      transport?: IconPackTransport; // default = real git+fetch transport; tests inject fakes
      now?: () => number;
    },
  ) {
    this.now = opts.now ?? Date.now;
    this.transport = opts.transport ?? DEFAULT_TRANSPORT;
  }

  /**
   * Pins verify + all pd files present → rebuild index from files (no
   * transport). Otherwise download via transport, then build. Never throws;
   * all failures land in status() as state "failed" + lastError.
   */
  async init(): Promise<void> {
    mkdirSync(this.opts.dir, { recursive: true }); // post-build writes (index.json, pins.json) must not reject on a missing dir
    this.lastError = null;
    let downloaded = false;
    if (this.pinsVerify() && this.pdFilesComplete()) {
      this.opts.log?.("iconpack: pins verified — rebuilding index from existing files");
    } else {
      this.state = "downloading";
      try {
        for (const e of this.opts.sources.pd) {
          await this.transport.fetchFile(e.url, join(this.opts.dir, e.file), e.sha256);
        }
        await this.transport.cloneRepo(this.opts.sources.pw.repo, this.opts.sources.pw.sha, join(this.opts.dir, "plane-watch"));
        await this.transport.cloneRepo(this.opts.sources.rk.repo, this.opts.sources.rk.sha, join(this.opts.dir, "rk"));
        downloaded = true;
      } catch (e) {
        this.fail(`download failed: ${errMsg(e)}`);
        return;
      }
    }
    let entries: PackIconEntry[];
    try {
      entries = this.buildIndex();
    } catch (e) {
      this.fail(errMsg(e));
      return;
    }
    this.index = new Map(entries.map((e) => [e.name, e]));
    this.loadExcludes();
    atomicWrite(join(this.opts.dir, "index.json"), JSON.stringify(entries, null, 2) + "\n");
    if (downloaded) this.writeAttribution(); // download path only — rebuild keeps the existing file (or none)
    if (downloaded) this.writePins(); // pins written last, atomically
    this.state = "ready";
    this.updatedAt = this.now();
    this.opts.log?.(`iconpack: ready (${entries.length} entries)`);
  }

  status(): IconStatus {
    let count = 0;
    for (const n of this.index.keys()) if (!this.vetoed.has(n)) count++;
    return { state: this.state, count, updatedAt: this.updatedAt, lastError: this.lastError };
  }

  /** Resolvable names (index minus vetoed). */
  names(): ReadonlySet<string> {
    const s = new Set<string>();
    for (const n of this.index.keys()) if (!this.vetoed.has(n)) s.add(n);
    return s;
  }

  /** Full index (catalog; includes vetoed). */
  entries(): PackIconEntry[] {
    return [...this.index.values()];
  }

  entry(name: string): PackIconEntry | undefined {
    return this.index.get(name);
  }

  isVetoed(name: string): boolean {
    return this.vetoed.has(name);
  }

  /** File bytes for a resolvable name; null for unknown or vetoed. */
  fileBytes(name: string): { bytes: Buffer; contentType: string } | null {
    const e = this.index.get(name);
    if (!e || this.vetoed.has(name)) return null;
    try {
      const bytes = readFileSync(join(this.opts.dir, e.file));
      if (bytes.length === 0) return null;
      // The .png extension lies: pd c5/kc10 are JPEGs (Commons .jpg sources) —
      // sniff the magic bytes instead of trusting the name.
      const contentType = e.file.endsWith(".svg") ? "image/svg+xml" : sniffImageType(bytes);
      return { bytes, contentType };
    } catch {
      return null;
    }
  }

  // --- internals -----------------------------------------------------------

  private fail(msg: string): void {
    this.state = "failed";
    this.lastError = msg;
    this.opts.log?.(`iconpack: failed: ${msg}`);
  }

  /** pins.json exists and pins exactly the current sources. */
  private pinsVerify(): boolean {
    let pins: { pw?: { repo?: unknown; sha?: unknown }; rk?: { repo?: unknown; sha?: unknown }; pd?: unknown };
    try {
      pins = JSON.parse(readFileSync(join(this.opts.dir, "pins.json"), "utf8"));
    } catch {
      return false;
    }
    if (typeof pins !== "object" || pins === null) return false;
    if (pins.pw?.repo !== this.opts.sources.pw.repo || pins.pw?.sha !== this.opts.sources.pw.sha) return false;
    if (pins.rk?.repo !== this.opts.sources.rk.repo || pins.rk?.sha !== this.opts.sources.rk.sha) return false;
    if (typeof pins.pd !== "object" || pins.pd === null || Array.isArray(pins.pd)) return false;
    const pd = pins.pd as Record<string, unknown>;
    if (Object.keys(pd).length !== this.opts.sources.pd.length) return false;
    for (const e of this.opts.sources.pd) {
      if (pd[e.name] !== e.sha256) return false;
    }
    return true;
  }

  private pdFilesComplete(): boolean {
    return this.opts.sources.pd.every((e) => fileOk(join(this.opts.dir, e.file)));
  }

  private writePins(): void {
    const pd: Record<string, string> = {};
    for (const e of this.opts.sources.pd) pd[e.name] = e.sha256;
    const pins = {
      pw: { repo: this.opts.sources.pw.repo, sha: this.opts.sources.pw.sha },
      rk: { repo: this.opts.sources.rk.repo, sha: this.opts.sources.rk.sha },
      pd,
      writtenAt: this.now(),
    };
    atomicWrite(join(this.opts.dir, "pins.json"), JSON.stringify(pins, null, 2) + "\n");
  }

  /**
   * ATTRIBUTION.md (spec §2) — written into dir on the download path only:
   * per source license/attribution/repo/pinned sha, per pd file
   * title/license/attribution/URL, plus the standing re-licensing note.
   */
  private writeAttribution(): void {
    const s = this.opts.sources;
    const lines: string[] = [
      "# Icon pack attribution",
      "",
      `Generated ${new Date(this.now()).toISOString()} by the icon pack setup download.`,
      "Regenerated on each (re)download; the exact pins are in pins.json.",
      "",
      "## Sources",
      "",
      `### pw — ${s.pw.repo}`,
      `- License: ${s.pw.license}`,
      `- Attribution: ${s.pw.attribution}`,
      `- Repo: ${s.pw.repo} @ ${s.pw.sha}`,
      "",
      `### rk — ${s.rk.repo}`,
      `- License: ${s.rk.license}`,
      `- Attribution: ${s.rk.attribution}`,
      `- Repo: ${s.rk.repo} @ ${s.rk.sha}`,
      "",
      "## Public-domain files (Wikimedia Commons)",
      "",
    ];
    for (const e of s.pd) {
      lines.push(`- **${e.name}** — ${e.title}`);
      lines.push(`  - License: ${e.license}`);
      lines.push(`  - Attribution: ${e.attribution}`);
      lines.push(`  - URL: ${e.url}`);
    }
    lines.push(
      "",
      "## Note",
      "",
      "This app is local, non-distributed, and non-commercial, so the licenses above",
      "impose ~0 practical obligations here (GPL-3.0 triggers on distribution;",
      "CC BY-NC-SA restricts commercial use). Distribution or productization of this",
      "repo would require re-licensing or replacing these assets.",
    );
    atomicWrite(join(this.opts.dir, "ATTRIBUTION.md"), lines.join("\n") + "\n");
  }

  private loadExcludes(): void {
    const p = join(this.opts.dir, "exclude.json");
    if (!existsSync(p)) {
      this.vetoed = new Set();
      return;
    }
    try {
      const v = JSON.parse(readFileSync(p, "utf8")) as { vetoed?: unknown };
      const arr = Array.isArray(v?.vetoed) ? v.vetoed : [];
      this.vetoed = new Set(arr.filter((n): n is string => typeof n === "string"));
    } catch (e) {
      this.vetoed = new Set();
      this.opts.log?.(`iconpack: exclude.json ignored: ${errMsg(e)}`);
    }
  }

  /**
   * Scan the materialized dir and build the index. Skips (log only): pw
   * airframe with neither silhouette candidate, referenced file missing or
   * empty, unparseable airframe JSON. Throws (init fails): name prefix
   * mismatch, collision with a reserved built-in icon name, duplicate name.
   */
  private buildIndex(): PackIconEntry[] {
    const dir = this.opts.dir;
    const entries: PackIconEntry[] = [];
    const seen = new Set<string>();

    const add = (entry: PackIconEntry): void => {
      const prefix = `${entry.source}:`;
      if (!entry.name.startsWith(prefix)) {
        throw new Error(`iconpack: name ${entry.name} does not match source prefix "${prefix}"`);
      }
      const local = entry.name.slice(prefix.length);
      if (RESERVED_NAMES.has(local)) {
        throw new Error(`iconpack: name collision: ${entry.name} — "${local}" is a reserved built-in icon name`);
      }
      if (seen.has(entry.name)) {
        throw new Error(`iconpack: duplicate pack name: ${entry.name}`);
      }
      if (!fileOk(join(dir, entry.file))) {
        this.opts.log?.(`iconpack: skip ${entry.name} — missing or empty file ${entry.file}`);
        return;
      }
      seen.add(entry.name);
      entries.push(entry);
    };

    // pw — plane-watch/airframes/<X>.json → plane-watch/silhouettes/<X>-1.svg
    // else <X>.svg (missing both → skip + log); title = icao.designator.
    const airframesDir = join(dir, "plane-watch", "airframes");
    const silhouettesDir = join(dir, "plane-watch", "silhouettes");
    for (const n of listFiles(airframesDir)) {
      if (!n.endsWith(".json")) continue;
      const x = n.slice(0, -".json".length);
      const svg = fileOk(join(silhouettesDir, `${x}-1.svg`))
        ? `${x}-1.svg`
        : fileOk(join(silhouettesDir, `${x}.svg`))
          ? `${x}.svg`
          : null;
      if (!svg) {
        this.opts.log?.(`iconpack: skip pw:${x} — no silhouette (tried ${x}-1.svg, ${x}.svg)`);
        continue;
      }
      let title = x;
      try {
        const j = JSON.parse(readFileSync(join(airframesDir, n), "utf8")) as { icao?: { designator?: unknown } };
        if (typeof j?.icao?.designator === "string" && j.icao.designator !== "") title = j.icao.designator;
      } catch (e) {
        this.opts.log?.(`iconpack: skip pw:${x} — unparseable airframe json: ${errMsg(e)}`);
        continue;
      }
      add({
        name: `pw:${x}`,
        source: "pw",
        file: `plane-watch/silhouettes/${svg}`,
        style: "filled",
        title,
        license: this.opts.sources.pw.license,
      });
    }

    // rk — each rk/<X>.svg; title from the SVG <title> element.
    const rkDir = join(dir, "rk");
    for (const n of listFiles(rkDir)) {
      if (!n.endsWith(".svg")) continue;
      const x = n.slice(0, -".svg".length);
      const text = readFileSync(join(rkDir, n), "utf8");
      const m = /<title[^>]*>([^<]*)<\/title>/.exec(text);
      add({
        name: `rk:${x}`,
        source: "rk",
        file: `rk/${n}`,
        style: "line",
        title: m && m[1] !== "" ? m[1] : x,
        license: this.opts.sources.rk.license,
      });
    }

    // pd — curated public-domain gap-fill, straight from the manifest.
    for (const e of this.opts.sources.pd) {
      add({
        name: e.name,
        source: "pd",
        file: e.file,
        style: "gapfill",
        title: e.title,
        license: e.license,
        cropTopRatio: e.cropTopRatio,
      });
    }

    return entries;
  }
}
