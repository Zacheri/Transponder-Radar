// SettingsStore: runtime settings persisted to data/settings.json.
//
// The file is authoritative at runtime. envDefaults apply only when the
// file is absent or unparseable. Each known key is validated as finite and
// clamped; unknown keys are left untouched so a settings.update can edit one
// knob while preserving forward-compatible keys (load → persist → reload).
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { clampRamCacheGb, clampStorageCapGb, GB } from "../shared/limits.js";

export interface RuntimeSettings {
  storageCapBytes: number;
  ramCacheBytes: number;
}

export interface SettingsDoc {
  storageCapGb: number;
  ramCacheGb: number;
  [k: string]: unknown;
}

export interface SettingsOpts {
  file: string;
  envDefaults: RuntimeSettings;
  log?: (msg: string) => void;
}

// bytes → GB, rounded to 2 decimals (a display/storage-friendly number).
const bytesToGb = (bytes: number): number => Math.round((bytes / GB) * 100) / 100;

// The doc written when no persisted file exists yet.
const defaultsDoc = (env: RuntimeSettings): SettingsDoc => ({
  storageCapGb: bytesToGb(env.storageCapBytes),
  ramCacheGb: bytesToGb(env.ramCacheBytes),
});

// One known key: a finite value is clamped; a missing/non-finite value falls
// back to the env-derived default (not the clamp floor) so a partial file
// still resolves sensibly.
const normKnown = (
  value: unknown,
  clamp: (gb: number) => number,
  fallback: number,
): number =>
  typeof value === "number" && Number.isFinite(value) ? clamp(value) : fallback;

export async function loadSettingsDoc(opts: SettingsOpts): Promise<SettingsDoc> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(opts.file, "utf8"));
  } catch {
    // Missing or corrupt → rebuild from envDefaults.
    opts.log?.("settings: file missing or corrupt, using env defaults");
    return defaultsDoc(opts.envDefaults);
  }
  const obj = (parsed && typeof parsed === "object") ? parsed : {};
  const doc = { ...(obj as SettingsDoc) };
  const env = opts.envDefaults;
  doc.storageCapGb = normKnown(doc.storageCapGb, clampStorageCapGb, bytesToGb(env.storageCapBytes));
  doc.ramCacheGb = normKnown(doc.ramCacheGb, clampRamCacheGb, bytesToGb(env.ramCacheBytes));
  return doc;
}

export async function persistSettingsDoc(
  opts: SettingsOpts,
  doc: SettingsDoc,
): Promise<void> {
  const target = opts.file;
  mkdirSync(dirname(target), { recursive: true });
  const tmp = `${target}.tmp`;
  writeFileSync(tmp, JSON.stringify(doc, null, 2));
  renameSync(tmp, target);
}

export function toRuntime(doc: SettingsDoc): RuntimeSettings {
  return {
    storageCapBytes: doc.storageCapGb * GB,
    ramCacheBytes: doc.ramCacheGb * GB,
  };
}
