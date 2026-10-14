import { fileURLToPath } from "node:url";
import { readFileSync, renameSync, writeFileSync } from "node:fs";

// Pinned upstream sources for the vendored aircraft icon pack (Task 2's
// IconPack downloads from these). pd[] = curated public-domain gap-fill
// files from Wikimedia Commons (sha256 of the exact bytes at url).

export interface PdSourceEntry {
  name: string; // "pd:E3"
  file: string; // "pd/e3.png" (relative to data/icons/)
  url: string; // direct Commons file URL
  sha256: string; // 64-char lowercase hex
  title: string; // "Boeing E-3 Sentry"
  license: string; // "Public Domain (US Government work)" etc.
  attribution: string; // author/creator string
  cropTopRatio: number; // 0 < r <= 1: fraction of image height that is the top view (0.5 for standard two-views)
}

export interface IconSources {
  pw: { repo: string; sha: string; license: string; attribution: string };
  rk: { repo: string; sha: string; license: string; attribution: string };
  pd: PdSourceEntry[];
  gapTargets: { designator: string; title: string }[]; // desired military types for the catalog gap list (covered or not)
}

function isStr(v: unknown): v is string {
  return typeof v === "string";
}

function repoShape(key: string, v: unknown): void {
  if (typeof v !== "object" || v === null) throw new Error(`iconpack-sources: ${key} must be an object`);
  const r = v as Record<string, unknown>;
  for (const f of ["repo", "sha", "license", "attribution"] as const) {
    if (!isStr(r[f])) throw new Error(`iconpack-sources: ${key}.${f} must be a string`);
  }
  const sha = r.sha;
  if (!isStr(sha) || !/^[0-9a-f]{40}$/.test(sha)) {
    throw new Error(`iconpack-sources: ${key}.sha is not a 40-hex commit sha`);
  }
}

function pdEntryShape(v: unknown, i: number): void {
  if (typeof v !== "object" || v === null) throw new Error(`iconpack-sources: pd[${i}] must be an object`);
  const e = v as Record<string, unknown>;
  for (const f of ["name", "file", "url", "sha256", "title", "license", "attribution"] as const) {
    if (!isStr(e[f])) throw new Error(`iconpack-sources: pd[${i}].${f} must be a string`);
  }
  const sha256 = e.sha256;
  if (!isStr(sha256) || !/^[0-9a-f]{64}$/.test(sha256)) {
    throw new Error(`iconpack-sources: pd[${i}].sha256 is not 64-hex`);
  }
  const cropTopRatio = e.cropTopRatio;
  if (typeof cropTopRatio !== "number" || !(cropTopRatio > 0 && cropTopRatio <= 1)) {
    throw new Error(`iconpack-sources: pd[${i}].cropTopRatio must be in (0, 1]`);
  }
}

/** Read + shape-check the committed manifest. Throws with the offending key. */
export function loadIconSources(path?: string): IconSources {
  const p = path ?? fileURLToPath(new URL("./iconpack-sources.json", import.meta.url));
  const s = JSON.parse(readFileSync(p, "utf8")) as unknown;
  if (typeof s !== "object" || s === null) throw new Error("iconpack-sources: root must be an object");
  const m = s as Record<string, unknown>;
  for (const key of ["pw", "rk", "pd", "gapTargets"] as const) {
    if (!(key in m)) throw new Error(`iconpack-sources: missing key "${key}"`);
  }
  repoShape("pw", m.pw);
  repoShape("rk", m.rk);
  if (!Array.isArray(m.pd)) throw new Error('iconpack-sources: "pd" must be an array');
  m.pd.forEach(pdEntryShape);
  if (!Array.isArray(m.gapTargets)) throw new Error('iconpack-sources: "gapTargets" must be an array');
  (m.gapTargets as unknown[]).forEach((g, i) => {
    if (typeof g !== "object" || g === null) throw new Error(`iconpack-sources: gapTargets[${i}] must be an object`);
    const gt = g as Record<string, unknown>;
    if (!isStr(gt.designator)) throw new Error(`iconpack-sources: gapTargets[${i}].designator must be a string`);
    if (!isStr(gt.title)) throw new Error(`iconpack-sources: gapTargets[${i}].title must be a string`);
  });
  return s as IconSources;
}

/** Atomic write (tmp + rename) — repin helper for manifest updates. */
export function writeIconSources(s: IconSources, path?: string): void {
  const p = path ?? fileURLToPath(new URL("./iconpack-sources.json", import.meta.url));
  const tmp = `${p}.tmp`;
  writeFileSync(tmp, JSON.stringify(s, null, 2) + "\n");
  renameSync(tmp, p);
}
