import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { Craft } from "../shared/craft.js";
import { N_NUMBER_RE } from "./classify.js";
import type { FaaProvider, FaaRecord } from "./faa.js";

const DEFAULT_INQUIRY_URL = "https://registry.faa.gov/aircraftinquiry/Search/NNumberInquiry";
const DEFAULT_RESULT_URL = "https://registry.faa.gov/aircraftinquiry/Search/NNumberResult";
// Browser-like UA: the registry validates plain clients aggressively.
const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36";
const DEFAULT_NEGATIVE_TTL_MS = 3_600_000;

function stripTags(html: string): string {
  return html
    .replace(/<[^>]+>/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}

/** Parse an FAA N-Number Inquiry Results page. Null when no usable record. */
export function parseNResult(html: string): FaaRecord | null {
  if (!html.includes("Inquiry Results")) return null;
  if (/\bis Deregistered\b/i.test(html)) return null;
  if (!/\bis Assigned\b|\bhas Assigned\/Multiple Records\b/i.test(html)) return null;
  const pair = (label: string): string | null => {
    const re = new RegExp(`<td[^>]*>\\s*${label}\\s*</td>\\s*<td[^>]*>(.*?)</td>`, "is");
    const m = re.exec(html);
    if (!m) return null;
    const v = stripTags(m[1]);
    return v === "" || /^none$/i.test(v) ? null : v;
  };
  const entered = html.match(/N-Number Entered:\s*([A-Za-z0-9]+)/i);
  if (!entered) return null;
  const yearRaw = pair("MFR Year");
  return {
    nNumber: "N" + entered[1].toUpperCase(),
    year: yearRaw && Number.isInteger(Number(yearRaw)) ? Number(yearRaw) : null,
    mfr: pair("Manufacturer Name"),
    model: pair("Model"),
    owner: pair("Name"),
    city: pair("City"),
    state: pair("State"),
  };
}

interface CacheEntry {
  foundAt: number;
  negative?: boolean;
  record?: FaaRecord;
}

export interface FaaLookupOpts {
  cacheFile: string;
  fetchImpl?: typeof fetch;
  now?: () => number;
  log?: (msg: string) => void;
  negativeTtlMs?: number;
  inquiryUrl?: string;
  resultUrl?: string;
}

export class FaaLookup {
  private cache = new Map<string, CacheEntry>();
  private inflight = new Map<string, Promise<(FaaRecord & { source: "live" }) | null>>();
  private now: () => number;

  constructor(private provider: FaaProvider, private opts: FaaLookupOpts) {
    this.now = opts.now ?? Date.now;
  }

  async init(): Promise<void> {
    try {
      const raw = await readFile(this.opts.cacheFile, "utf8");
      for (const [hex, entry] of Object.entries(JSON.parse(raw) as Record<string, CacheEntry>)) {
        this.cache.set(hex.toLowerCase(), entry);
      }
    } catch {
      /* first run */
    }
  }

  stop(): void {
    /* nothing to clean up */
  }

  async lookup(craft: Craft): Promise<(FaaRecord & { source: "live" }) | null> {
    const hex = craft.id.toLowerCase();
    const t = this.now();
    const entry = this.cache.get(hex);
    if (entry?.record) return { ...entry.record, source: "live" };
    if (entry?.negative && t - entry.foundAt < (this.opts.negativeTtlMs ?? DEFAULT_NEGATIVE_TTL_MS)) return null;
    const n = this.nNumberFor(craft);
    if (!n) return null;
    const key = n.toUpperCase();
    const existing = this.inflight.get(key);
    if (existing) return existing;
    const p = this.fetchRecord(n)
      .then((rec) => {
        this.inflight.delete(key);
        if (rec) {
          this.provider.merge(hex, rec);
          this.setCache(hex, { foundAt: t, record: rec });
        } else {
          this.setCache(hex, { foundAt: t, negative: true });
        }
        return rec ? { ...rec, source: "live" as const } : null;
      })
      .catch((e) => {
        this.inflight.delete(key);
        this.opts.log?.(`faa-lookup: ${e instanceof Error ? e.message : String(e)}`);
        this.setCache(hex, { foundAt: t, negative: true });
        return null;
      });
    this.inflight.set(key, p);
    return p;
  }

  private nNumberFor(craft: Craft): string | null {
    const cs = (craft.callsign ?? "").trim().toUpperCase();
    return N_NUMBER_RE.test(cs) ? cs : null;
  }

  private async fetchRecord(n: string): Promise<FaaRecord | null> {
    const fetchImpl = this.opts.fetchImpl ?? fetch;
    const page = await fetchImpl(this.opts.inquiryUrl ?? DEFAULT_INQUIRY_URL, { headers: { "user-agent": UA } });
    if (!page.ok) throw new Error(`FAA inquiry page HTTP ${page.status}`);
    const pageHtml = await page.text();
    const token = pageHtml.match(/name="__RequestVerificationToken"[^>]*value="([^"]+)"/)?.[1];
    if (!token) throw new Error("FAA inquiry page: CSRF token not found");
    const cookie = (page.headers.get("set-cookie") ?? "").split(";")[0];
    const body = new URLSearchParams({ NNumbertxt: n, __RequestVerificationToken: token });
    const res = await fetchImpl(this.opts.resultUrl ?? DEFAULT_RESULT_URL, {
      method: "POST",
      headers: {
        "user-agent": UA,
        "content-type": "application/x-www-form-urlencoded",
        ...(cookie ? { cookie } : {}),
      },
      body: body.toString(),
    });
    if (!res.ok) throw new Error(`FAA result HTTP ${res.status}`);
    const rec = parseNResult(await res.text());
    if (!rec) return null;
    rec.nNumber = n.toUpperCase();
    return rec;
  }

  private setCache(hex: string, entry: CacheEntry): void {
    this.cache.set(hex.toLowerCase(), entry);
    void this.persist();
  }

  private async persist(): Promise<void> {
    try {
      await mkdir(dirname(this.opts.cacheFile), { recursive: true });
      await writeFile(this.opts.cacheFile, JSON.stringify(Object.fromEntries(this.cache), null, 1));
    } catch (e) {
      this.opts.log?.(`faa-lookup: cache persist failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
}
