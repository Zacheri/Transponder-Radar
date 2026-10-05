import type { CraftStore } from "./store.js";
import { normalizeOpenSky } from "./normalize.js";
import type { TokenProvider } from "./opensky-auth.js";

export const BACKOFF_CAP_MS = 300000;
export const POLL_MIN_MS = 15000;
export const POLL_MAX_MS = 3600000;

export interface OpenSkyPollerOpts {
  url?: string;
  pollMs: number;
  graceMs: number;
  store: CraftStore;
  fetchImpl?: typeof fetch;
  now?: () => number;
  log?: (msg: string) => void;
  timeoutMs?: number;
  tokenProvider?: TokenProvider;
}

export interface PollResult {
  upserted: number;
  nextDelayMs: number;
}

export class OpenSkyPoller {
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private consecutiveErrors = 0;
  private lastOkAt: number | null = null;
  private lastError: string | null = null;

  constructor(private opts: OpenSkyPollerOpts) {}

  get feedStatus(): { lastOkAt: number | null; lastError: string | null; pollMs: number } {
    return { lastOkAt: this.lastOkAt, lastError: this.lastError, pollMs: this.opts.pollMs };
  }

  setPollInterval(ms: number): void {
    const n = Math.round(ms);
    if (Number.isFinite(n)) {
      this.opts.pollMs = Math.min(POLL_MAX_MS, Math.max(POLL_MIN_MS, n));
    }
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    void this.loop();
  }

  stop(): void {
    this.running = false;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  private async loop(): Promise<void> {
    if (!this.running) return;
    let nextDelayMs: number;
    try {
      nextDelayMs = (await this.pollOnce()).nextDelayMs;
    } catch (e) {
      this.opts.log?.(`opensky: ${e instanceof Error ? e.message : String(e)}`);
      nextDelayMs = this.backoffDelay();
    }
    this.schedule(nextDelayMs);
  }

  private schedule(delayMs: number): void {
    if (!this.running) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.loop();
    }, delayMs);
  }

  private backoffDelay(): number {
    this.consecutiveErrors += 1;
    return Math.min(BACKOFF_CAP_MS, this.opts.pollMs * 2 ** this.consecutiveErrors);
  }

  async pollOnce(): Promise<PollResult> {
    const now = this.opts.now?.() ?? Date.now();
    const fetchImpl = this.opts.fetchImpl ?? fetch;
    const url = this.opts.url ?? "https://opensky-network.org/api/states/all";
    const signal = AbortSignal.timeout(this.opts.timeoutMs ?? 10000);
    const provider = this.opts.tokenProvider;
    const doFetch = async (): Promise<Response> => {
      const headers: Record<string, string> = {};
      if (provider) headers["Authorization"] = "Bearer " + (await provider.getToken());
      return fetchImpl(url, { headers, signal });
    };
    let res: Response;
    try {
      res = await doFetch();
      if (res.status === 401 && provider) {
        // Token rejected (expired/revoked) — force a refresh and retry once.
        provider.invalidate();
        res = await doFetch();
      }
    } catch (e) {
      const nextDelayMs = this.backoffDelay();
      const msg = e instanceof Error ? e.message : String(e);
      this.lastError = msg;
      this.opts.log?.(`opensky: ${msg} — backing off ${nextDelayMs}ms`);
      return { upserted: 0, nextDelayMs };
    }
    if (res.status === 429) {
      this.consecutiveErrors += 1;
      const retryAfterRaw = res.headers.get("retry-after");
      const nextDelayMs =
        retryAfterRaw !== null && Number.isFinite(Number(retryAfterRaw))
          ? Math.min(BACKOFF_CAP_MS, Math.max(this.opts.pollMs, Number(retryAfterRaw) * 1000))
          : Math.min(BACKOFF_CAP_MS, this.opts.pollMs * 2 ** this.consecutiveErrors);
      this.lastError = "HTTP 429";
      this.opts.log?.(`opensky: 429 — backing off ${nextDelayMs}ms`);
      return { upserted: 0, nextDelayMs };
    }
    if (!res.ok) {
      const nextDelayMs = this.backoffDelay();
      this.lastError = `HTTP ${res.status}`;
      this.opts.log?.(`opensky: HTTP ${res.status} — backing off ${nextDelayMs}ms`);
      return { upserted: 0, nextDelayMs };
    }
    let body: { states?: unknown };
    try {
      body = (await res.json()) as { states?: unknown };
    } catch {
      this.lastError = "malformed body";
      this.opts.log?.("opensky: malformed body — skipping poll");
      return { upserted: 0, nextDelayMs: this.opts.pollMs };
    }
    if (!Array.isArray(body.states)) {
      this.lastError = "malformed body";
      this.opts.log?.("opensky: malformed body — skipping poll");
      return { upserted: 0, nextDelayMs: this.opts.pollMs };
    }
    const rows = body.states as (string | number | boolean | null)[][];
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
    this.consecutiveErrors = 0;
    this.lastOkAt = now;
    this.lastError = null;
    return { upserted: crafts.length, nextDelayMs: this.opts.pollMs };
  }
}
