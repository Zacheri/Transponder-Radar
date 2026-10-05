import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseNResult, FaaLookup } from "../server/faa-lookup.js";
import type { FaaRecord, FaaProvider } from "../server/faa.js";
import type { Craft } from "../shared/craft.js";

const INQUIRY_HTML = readFileSync(new URL("./fixtures/faa-inquiry.html", import.meta.url), "utf8");
const POSITIVE_HTML = readFileSync(new URL("./fixtures/faa-nresult.html", import.meta.url), "utf8");
const DEREG_HTML = readFileSync(new URL("./fixtures/faa-nresult-dereg.html", import.meta.url), "utf8");

function craft(overrides: Partial<Craft> = {}): Craft {
  return { id: "a1b2c3", domain: "air", kind: "business", lat: 0, lon: 0, speed: null, heading: null, callsign: "N100GX", updatedAt: 0, stale: false, ...overrides };
}

function fakeProvider(): FaaProvider & { merged: Array<[string, FaaRecord]> } {
  const merged: Array<[string, FaaRecord]> = [];
  return {
    merged,
    lookup: () => null,
    merge: (hex: string, rec: FaaRecord) => {
      merged.push([hex, rec]);
    },
    status: () => ({ state: "ready", updatedAt: null, aircraft: 0, lastError: null }),
    init: async () => {},
    stop: () => {},
  };
}

function seqFetchImpl(responses: Array<() => Response>): { fetchImpl: typeof fetch; calls: { current: number } } {
  const calls = { current: 0 };
  const fetchImpl = (async () => {
    const fn = responses[calls.current];
    calls.current++;
    return fn();
  }) as typeof fetch;
  return { fetchImpl, calls };
}

const inquiryResponse = () =>
  new Response(INQUIRY_HTML, { status: 200, headers: { "set-cookie": "ASP.NET_SessionId=abc123" } });

async function readWhenExists(path: string): Promise<string> {
  for (let i = 0; i < 200; i++) {
    try {
      return await readFile(path, "utf8");
    } catch {
      await new Promise((r) => setTimeout(r, 10));
    }
  }
  throw new Error(`file never appeared: ${path}`);
}

describe("parseNResult", () => {
  it("parses a positive N-number result page", () => {
    expect(parseNResult(POSITIVE_HTML)).toEqual({
      nNumber: "N100GX",
      year: 2007,
      mfr: "ISRAEL AIRCRAFT INDUSTRIES",
      model: "GULFSTREAM G150",
      owner: "BRULECREEK AVIATION LLC",
      city: "PARK CITY",
      state: "UTAH",
    });
  });

  it("returns null for a deregistered result", () => {
    expect(parseNResult(DEREG_HTML)).toBeNull();
  });

  it("returns null for a validation-error page (no results section)", () => {
    expect(parseNResult("<html><body><form>N-Number:</form></body></html>")).toBeNull();
  });
});

describe("FaaLookup", () => {
  let dir: string;
  let t: number;

  beforeEach(async () => {
    t = 1_000_000_000;
    dir = await mkdtemp(join(tmpdir(), "radar-faalk-"));
  });
  afterEach(async () => {
    // a fire-and-forget persist may still be mid tmp→rename; retry until it settles
    for (let i = 0; i < 100; i++) {
      try {
        await rm(dir, { recursive: true, force: true });
        return;
      } catch {
        await new Promise((r) => setTimeout(r, 10));
      }
    }
    await rm(dir, { recursive: true, force: true });
  });

  const cacheFile = () => join(dir, "enrichment.json");

  it("resolves a DB-miss aircraft via live lookup, merges and caches it", async () => {
    const provider = fakeProvider();
    const { fetchImpl, calls } = seqFetchImpl([inquiryResponse, () => new Response(POSITIVE_HTML, { status: 200 })]);
    const lookup = new FaaLookup(provider, { cacheFile: cacheFile(), fetchImpl, now: () => t });
    await lookup.init();
    const rec = await lookup.lookup(craft());
    expect(rec?.source).toBe("live");
    expect(rec?.nNumber).toBe("N100GX");
    expect(provider.merged).toHaveLength(1);
    expect(provider.merged[0][0]).toBe("a1b2c3");
    expect(calls.current).toBe(2);
    const cached = JSON.parse(await readWhenExists(cacheFile())) as Record<string, unknown>;
    expect(cached["a1b2c3"]).toBeDefined();
  });

  it("reloads a persisted cache on restart and serves it without fetching", async () => {
    const provider = fakeProvider();
    const { fetchImpl, calls } = seqFetchImpl([inquiryResponse, () => new Response(POSITIVE_HTML, { status: 200 })]);
    const lookup = new FaaLookup(provider, { cacheFile: cacheFile(), fetchImpl, now: () => t });
    await lookup.init();
    const rec = await lookup.lookup(craft());
    expect(rec?.nNumber).toBe("N100GX");
    expect(calls.current).toBe(2);
    await readWhenExists(cacheFile()); // let the fire-and-forget persist land
    const lookup2 = new FaaLookup(provider, { cacheFile: cacheFile(), fetchImpl, now: () => t });
    await lookup2.init();
    const again = await lookup2.lookup(craft());
    expect(again?.nNumber).toBe("N100GX");
    expect(again?.source).toBe("live");
    expect(calls.current).toBe(2); // no new fetches on the reloaded instance
  });

  it("serves repeat lookups from the positive cache without fetching", async () => {
    const provider = fakeProvider();
    const { fetchImpl, calls } = seqFetchImpl([inquiryResponse, () => new Response(POSITIVE_HTML, { status: 200 })]);
    const lookup = new FaaLookup(provider, { cacheFile: cacheFile(), fetchImpl, now: () => t });
    await lookup.init();
    await lookup.lookup(craft());
    t += 60_000;
    const again = await lookup.lookup(craft());
    expect(again?.nNumber).toBe("N100GX");
    expect(calls.current).toBe(2); // no extra fetches
  });

  it("negative-caches deregistered results: no re-fetch within TTL, re-fetch after", async () => {
    const provider = fakeProvider();
    const { fetchImpl, calls } = seqFetchImpl([
      inquiryResponse,
      () => new Response(DEREG_HTML, { status: 200 }), // 1st attempt → negative
      inquiryResponse,
      () => new Response(POSITIVE_HTML, { status: 200 }), // 2nd attempt (past TTL) → positive
    ]);
    const lookup = new FaaLookup(provider, { cacheFile: cacheFile(), fetchImpl, now: () => t, negativeTtlMs: 3_600_000 });
    await lookup.init();
    expect(await lookup.lookup(craft())).toBeNull();
    expect(calls.current).toBe(2);
    await lookup.lookup(craft());
    expect(calls.current).toBe(2); // negative cache hit, no fetch
    t += 3_700_000; // past TTL → re-fetch allowed
    expect((await lookup.lookup(craft()))?.nNumber).toBe("N100GX");
    expect(calls.current).toBe(4);
  });

  it("returns null immediately when no N-number is derivable", async () => {
    const provider = fakeProvider();
    const { fetchImpl, calls } = seqFetchImpl([inquiryResponse]);
    const lookup = new FaaLookup(provider, { cacheFile: cacheFile(), fetchImpl, now: () => t });
    await lookup.init();
    expect(await lookup.lookup(craft({ callsign: "UAL123" }))).toBeNull();
    expect(calls.current).toBe(0);
  });

  it("deduplicates concurrent lookups for the same N-number", async () => {
    const provider = fakeProvider();
    const { fetchImpl, calls } = seqFetchImpl([inquiryResponse, () => new Response(POSITIVE_HTML, { status: 200 })]);
    const lookup = new FaaLookup(provider, { cacheFile: cacheFile(), fetchImpl, now: () => t });
    await lookup.init();
    const [a, b] = await Promise.all([lookup.lookup(craft()), lookup.lookup(craft())]);
    expect(a?.nNumber).toBe("N100GX");
    expect(b?.nNumber).toBe("N100GX");
    expect(calls.current).toBe(2);
  });
});
