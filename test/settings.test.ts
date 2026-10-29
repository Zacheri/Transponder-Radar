import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GB } from "../shared/limits.js";
import {
  loadSettingsDoc,
  persistSettingsDoc,
  toRuntime,
} from "../server/settings.js";

const envDefaults = { storageCapBytes: 10 * GB, ramCacheBytes: 1 * GB };

describe("settings store", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "radar-settings-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const file = () => join(dir, "settings.json");

  const write = (json: unknown) =>
    writeFile(file(), typeof json === "string" ? json : JSON.stringify(json), "utf8");

  it("file absent builds the doc from envDefaults (bytes → GB, 2dp)", async () => {
    const doc = await loadSettingsDoc({ file: file(), envDefaults });
    expect(doc).toEqual({ storageCapGb: 10, ramCacheGb: 1 });
  });

  it("file present wins over envDefaults", async () => {
    await write({ storageCapGb: 4, ramCacheGb: 2 });
    const doc = await loadSettingsDoc({ file: file(), envDefaults });
    expect(doc).toEqual({ storageCapGb: 4, ramCacheGb: 2 });
  });

  it("corrupt file → defaults and does not throw", async () => {
    await write("{ not valid json ");
    const doc = await loadSettingsDoc({ file: file(), envDefaults });
    expect(doc).toEqual({ storageCapGb: 10, ramCacheGb: 1 });
  });

  it("clamps out-of-range known keys", async () => {
    await write({ storageCapGb: 99_999, ramCacheGb: -3 });
    const doc = await loadSettingsDoc({ file: file(), envDefaults });
    expect(doc).toEqual({ storageCapGb: 1000, ramCacheGb: 0 });
  });

  it("preserves unknown keys through load → persist → reload", async () => {
    await write({ storageCapGb: 4, ramCacheGb: 2, timelineZoom: 2.5 });
    const doc = await loadSettingsDoc({ file: file(), envDefaults });
    expect(doc.timelineZoom).toBe(2.5);
    await persistSettingsDoc({ file: file(), envDefaults }, doc);
    const reloaded = await loadSettingsDoc({ file: file(), envDefaults });
    expect(reloaded.timelineZoom).toBe(2.5);
  });

  it("persist writes atomically-valid JSON with no .tmp remnant", async () => {
    const doc = await loadSettingsDoc({ file: file(), envDefaults });
    await persistSettingsDoc({ file: file(), envDefaults }, doc);
    expect(readdirSync(dir).some((f) => f.endsWith(".tmp"))).toBe(false);
    expect(JSON.parse(readFileSync(file(), "utf8"))).toEqual(doc);
  });

  it("toRuntime converts GB → bytes", () => {
    expect(toRuntime({ storageCapGb: 2.5, ramCacheGb: 1 })).toEqual({
      storageCapBytes: 2.5 * GB,
      ramCacheBytes: GB,
    });
  });
});
