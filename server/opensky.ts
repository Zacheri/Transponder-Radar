import type { CraftStore } from "./store.js";
import { normalizeOpenSky } from "./normalize.js";

export interface OpenSkyPollerOpts {
  url?: string;
  pollMs: number;
  graceMs: number;
  store: CraftStore;
  fetchImpl?: typeof fetch;
  now?: () => number;
  log?: (msg: string) => void;
}

export class OpenSkyPoller {
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  constructor(private opts: OpenSkyPollerOpts) {}

  start(): void {
    if (this.running) return;
    this.running = true;
    void this.pollOnce().catch((e) => this.opts.log?.(`opensky: ${e.message}`));
    this.timer = setInterval(() => {
      void this.pollOnce().catch((e) => this.opts.log?.(`opensky: ${e.message}`));
    }, this.opts.pollMs);
  }

  stop(): void {
    this.running = false;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async pollOnce(): Promise<number> {
    const now = this.opts.now?.() ?? Date.now();
    const fetchImpl = this.opts.fetchImpl ?? fetch;
    const res = await fetchImpl(this.opts.url ?? "https://opensky-network.org/api/states/all");
    if (!res.ok) throw new Error(`OpenSky HTTP ${res.status}`);
    const body = (await res.json()) as { states?: (string | number | boolean | null)[][] };
    const rows = body.states ?? [];
    const crafts = [];
    const present = new Set<string>();
    for (const row of rows) {
      const c = normalizeOpenSky(row, now);
      if (c) {
        crafts.push(c);
        present.add(c.id);
      }
    }
    this.opts.store.upsert(crafts, now);
    this.opts.store.pruneAir(present, now, this.opts.graceMs);
    return crafts.length;
  }
}
