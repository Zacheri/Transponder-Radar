import type { Craft } from "../../shared/craft.js";

export class ClientStore {
  private crafts = new Map<string, Craft>();
  private listeners = new Set<() => void>();

  get size(): number {
    return this.crafts.size;
  }

  get(id: string): Craft | undefined {
    return this.crafts.get(id);
  }

  all(): Craft[] {
    return [...this.crafts.values()];
  }

  applySnapshot(crafts: Craft[]): void {
    this.crafts = new Map(
      crafts.filter((c) => c && typeof c.id === "string").map((c) => [c.id, c]),
    );
    this.emit();
  }

  applyUpdate(upsert: Craft[], remove: string[]): void {
    let changed = false;
    for (const c of upsert) {
      if (!c || typeof c.id !== "string") continue;
      this.crafts.set(c.id, c);
      changed = true;
    }
    for (const id of remove) {
      if (this.crafts.delete(id)) changed = true;
    }
    if (changed) this.emit();
  }

  subscribe(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  }

  private emit(): void {
    for (const fn of this.listeners) fn();
  }
}
