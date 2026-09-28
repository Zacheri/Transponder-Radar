import type { Craft } from "../shared/craft.js";

export class CraftStore {
  private craft = new Map<string, Craft>();
  private dirtyUpsert = new Set<string>();
  private dirtyRemove = new Set<string>();
  private airLastSeen = new Map<string, number>();

  get size(): number {
    return this.craft.size;
  }

  get(id: string): Craft | undefined {
    return this.craft.get(id);
  }

  all(): Craft[] {
    return [...this.craft.values()];
  }

  upsert(items: Craft | Craft[], now: number): void {
    const list = Array.isArray(items) ? items : [items];
    for (const c of list) {
      this.craft.set(c.id, c);
      this.dirtyUpsert.add(c.id);
      this.dirtyRemove.delete(c.id);
      if (c.domain === "air") this.airLastSeen.set(c.id, now);
    }
  }

  remove(id: string): void {
    if (this.craft.delete(id)) {
      this.dirtyRemove.add(id);
      this.dirtyUpsert.delete(id);
    }
    this.airLastSeen.delete(id);
  }

  drainDirty(): { upsert: Craft[]; remove: string[] } {
    const upsert = [...this.dirtyUpsert]
      .map((id) => this.craft.get(id))
      .filter((c): c is Craft => c != null);
    const remove = [...this.dirtyRemove];
    this.dirtyUpsert.clear();
    this.dirtyRemove.clear();
    return { upsert, remove };
  }

  sweep(now: number, staleMs: number, removeMs: number): string[] {
    const removed: string[] = [];
    for (const [id, c] of this.craft) {
      const age = now - c.updatedAt;
      if (age > removeMs) {
        this.craft.delete(id);
        this.airLastSeen.delete(id);
        this.dirtyRemove.add(id);
        this.dirtyUpsert.delete(id);
        removed.push(id);
      } else if (age > staleMs && !c.stale) {
        c.stale = true;
        this.dirtyUpsert.add(id);
        this.dirtyRemove.delete(id);
      }
    }
    return removed;
  }

  pruneAir(present: Set<string>, now: number, graceMs: number): string[] {
    const removed: string[] = [];
    for (const [id, c] of this.craft) {
      if (c.domain !== "air" || present.has(id)) continue;
      const seen = this.airLastSeen.get(id);
      if (seen != null && now - seen > graceMs) {
        this.craft.delete(id);
        this.airLastSeen.delete(id);
        this.dirtyRemove.add(id);
        this.dirtyUpsert.delete(id);
        removed.push(id);
      }
    }
    return removed;
  }
}
