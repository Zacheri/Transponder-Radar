import type { Craft, Domain } from "../shared/craft.js";

export class CraftStore {
  private craft = new Map<string, Craft>();
  private dirtyUpsert = new Set<string>();
  private dirtyRemove = new Set<string>();
  // Domain of every craft recorded in dirtyRemove. A removed id may no longer
  // be in the craft map, so its domain must be tracked at removal time or the
  // per-domain drain would drop it or send it under the wrong domain.
  private removeDomain = new Map<string, Domain>();
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
      this.removeDomain.delete(c.id);
      if (c.domain === "air") this.airLastSeen.set(c.id, now);
    }
  }

  remove(id: string): void {
    const c = this.craft.get(id);
    if (c) this.removeDomain.set(id, c.domain);
    if (this.craft.delete(id)) {
      this.dirtyRemove.add(id);
      this.dirtyUpsert.delete(id);
    }
    this.airLastSeen.delete(id);
  }

  drainDirty(domain: Domain): { upsert: Craft[]; remove: string[] } {
    const upsert: Craft[] = [];
    for (const id of this.dirtyUpsert) {
      const c = this.craft.get(id);
      if (c != null && c.domain === domain) upsert.push(c);
    }
    const remove: string[] = [];
    for (const id of this.dirtyRemove) {
      if (this.removeDomain.get(id) === domain) remove.push(id);
    }
    for (const c of upsert) this.dirtyUpsert.delete(c.id);
    for (const id of remove) {
      this.dirtyRemove.delete(id);
      this.removeDomain.delete(id);
    }
    return { upsert, remove };
  }

  // Air craft with a stale time_position are also swept here (intentional overlap with the pruneAir grace path).
  sweep(now: number, staleMs: number, removeMs: number): string[] {
    const removed: string[] = [];
    for (const [id, c] of this.craft) {
      const age = now - c.updatedAt;
      if (age > removeMs) {
        this.craft.delete(id);
        this.airLastSeen.delete(id);
        this.dirtyRemove.add(id);
        this.dirtyUpsert.delete(id);
        this.removeDomain.set(id, c.domain);
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
        this.removeDomain.set(id, c.domain);
        removed.push(id);
      }
    }
    return removed;
  }
}
