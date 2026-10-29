// PinStore: persisted set of pinned time ranges for timeline rewind.
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { MIN_PIN_MS } from "../shared/limits.js";

export interface Pin { id: string; from: number; to: number }
export interface PinStoreOpts { file: string; log?: (msg: string) => void }

interface File { pins: Pin[] }

const valid = (p: unknown): p is Pin =>
  typeof p === "object" &&
  p !== null &&
  typeof (p as Pin).id === "string" &&
  (p as Pin).id.length > 0 &&
  typeof (p as Pin).from === "number" &&
  typeof (p as Pin).to === "number";

export class PinStore {
  private pins: Pin[] = [];

  constructor(private opts: PinStoreOpts) {}

  async init(): Promise<void> {
    this.pins = [];
    let raw: string;
    try {
      raw = readFileSync(this.opts.file, "utf8");
    } catch {
      // Missing file → empty store.
      return;
    }
    try {
      const parsed = JSON.parse(raw) as { pins?: unknown };
      const list = Array.isArray(parsed?.pins) ? parsed.pins : [];
      const kept: Pin[] = [];
      for (const entry of list) {
        if (!valid(entry)) continue;
        const { id, from, to } = entry;
        if (!Number.isFinite(from) || !Number.isFinite(to)) continue;
        if (from >= to) continue;
        if (to - from < MIN_PIN_MS) continue;
        kept.push({ id, from, to });
      }
      this.pins = kept;
    } catch {
      this.opts.log?.("pins: corrupt file using empty");
    }
  }

  all(): Pin[] {
    return [...this.pins].sort((a, b) => a.from - b.from);
  }

  add(from: number, to: number, bounds: { from: number; to: number } | null): Pin | null {
    if (from > to) [from, to] = [to, from];
    if (!Number.isFinite(from) || !Number.isFinite(to)) return null;
    if (bounds) {
      from = Math.max(bounds.from, Math.min(from, bounds.to));
      to = Math.max(bounds.from, Math.min(to, bounds.to));
    }
    if (to - from < MIN_PIN_MS) return null;
    const pin = { id: "p" + Date.now(), from, to };
    this.pins.push(pin);
    this.persist();
    return pin;
  }

  remove(id: string): Pin | null {
    const idx = this.pins.findIndex((p) => p.id === id);
    if (idx === -1) return null;
    const [pin] = this.pins.splice(idx, 1);
    this.persist();
    return pin;
  }

  contains(ts: number): boolean {
    return this.pins.some((p) => ts >= p.from && ts <= p.to);
  }

  pinnedBytes(entries: { ts: number; size: number }[]): number {
    return entries.reduce(
      (sum, e) => (this.contains(e.ts) ? sum + e.size : sum),
      0,
    );
  }

  private persist(): void {
    const data: File = { pins: this.pins };
    const target = this.opts.file;
    mkdirSync(dirname(target), { recursive: true });
    const tmp = `${target}.${Date.now()}.tmp`;
    writeFileSync(tmp, JSON.stringify(data));
    renameSync(tmp, target);
  }
}
