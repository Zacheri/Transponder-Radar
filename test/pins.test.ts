import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PinStore } from "../server/pins.js";
import { MIN_PIN_MS } from "../shared/limits.js";

// Scaled epochs (real-time ms) so every pin span is >= MIN_PIN_MS.
const BASE = 1_700_000_000_000;

describe("PinStore", () => {
  let dir: string;
  let logs: string[];
  const open = (file: string) =>
    new PinStore({ file, log: (m) => logs.push(m) });

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "radar-pins-"));
    logs = [];
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  // 1. Starts empty; init() with no file; all() = [].
  it("starts empty with no file on disk", async () => {
    const s = open(join(dir, "pins.json"));
    await s.init();
    expect(s.all()).toEqual([]);
  });

  // 2. add writes the file; a second instance on the same file + init() sees the pin.
  it("persists a pin across a fresh instance on the same file", async () => {
    const s = open(join(dir, "pins.json"));
    await s.init();
    const pin = s.add(BASE, BASE + MIN_PIN_MS, null)!;
    expect(pin.from).toBe(BASE);
    expect(pin.to).toBe(BASE + MIN_PIN_MS);

    const again = open(join(dir, "pins.json"));
    await again.init();
    expect(again.all()).toEqual([pin]);
  });

  // 3. Inverted range normalizes.
  it("normalizes an inverted range", () => {
    const s = open(join(dir, "pins.json"));
    const pin = s.add(BASE + MIN_PIN_MS, BASE, null)!;
    expect(pin).toMatchObject({ from: BASE, to: BASE + MIN_PIN_MS });
  });

  // 4. Below-min span rejected; file unchanged.
  it("rejects a below-min span and leaves the file unchanged", async () => {
    const file = join(dir, "pins.json");
    const s = open(file);
    await s.init();
    await writeFile(file, JSON.stringify({ pins: [] }));
    const before = await readFile(file, "utf8");
    const pin = s.add(BASE, BASE + MIN_PIN_MS - 1, null);
    expect(pin).toBeNull();
    expect(await readFile(file, "utf8")).toBe(before);
  });

  // 5. Clamping to bounds.
  it("clamps a span into bounds", () => {
    const s = open(join(dir, "pins.json"));
    const pin = s.add(
      BASE - 180_000,
      BASE + 240_000,
      { from: BASE, to: BASE + 120_000 },
    )!;
    expect(pin).toMatchObject({ from: BASE, to: BASE + 120_000 });
  });

  it("rejects a clamped span below min", () => {
    const s = open(join(dir, "pins.json"));
    const pin = s.add(
      BASE - 90_000,
      BASE + 45_000,
      { from: BASE, to: BASE + MIN_PIN_MS - 1 },
    );
    expect(pin).toBeNull();
  });

  // 6. Non-finite rejected.
  it("rejects a non-finite bound", () => {
    const s = open(join(dir, "pins.json"));
    expect(s.add(NaN, BASE + 50_000, null)).toBeNull();
  });

  // 7. remove returns the pin, persists the empty list; unknown id → null.
  it("removes a pin, persists the empty list, and tolerates unknown ids", async () => {
    const file = join(dir, "pins.json");
    const s = open(file);
    await s.init();
    const pin = s.add(BASE, BASE + MIN_PIN_MS, null)!;

    const removed = s.remove(pin.id);
    expect(removed).toEqual(pin);
    expect(s.all()).toEqual([]);
    expect(JSON.parse(await readFile(file, "utf8"))).toEqual({ pins: [] });
    expect(s.remove("nope")).toBeNull();
  });

  // 8. contains true inside, false outside (inclusive bounds).
  it("contains is inclusive of the bounds", () => {
    const s = open(join(dir, "pins.json"));
    s.add(BASE, BASE + MIN_PIN_MS, null);
    expect(s.contains(BASE)).toBe(true);
    expect(s.contains(BASE + MIN_PIN_MS)).toBe(true);
    expect(s.contains(BASE - 1)).toBe(false);
    expect(s.contains(BASE + MIN_PIN_MS + 1)).toBe(false);
  });

  // 9. pinnedBytes: sum of size for entries where contains(ts).
  it("sums the size of entries inside a pin", () => {
    const s = open(join(dir, "pins.json"));
    s.add(BASE, BASE + MIN_PIN_MS, null);
    const bytes = s.pinnedBytes([
      { ts: BASE + 30_000, size: 10 },
      { ts: BASE + 90_000, size: 7 },
    ]);
    expect(bytes).toBe(10);
  });

  // 10. Corrupt file → empty + does not throw.
  it("recovers from a corrupt file", async () => {
    const file = join(dir, "pins.json");
    await writeFile(file, "{not json");
    const s = open(file);
    await expect(s.init()).resolves.toBeUndefined();
    expect(s.all()).toEqual([]);
    expect(logs.some((l) => /corrupt/i.test(l))).toBe(true);
  });

  // 11. Overlapping pins both kept.
  it("keeps overlapping pins", () => {
    const s = open(join(dir, "pins.json"));
    s.add(BASE, BASE + MIN_PIN_MS, null);
    s.add(BASE + 30_000, BASE + 90_000, null);
    expect(s.all()).toHaveLength(2);
  });
});
