import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTracks, HARD_DAILY_CAP, type TrackPoint, type TracksOpts, type TracksService } from "../server/tracks.js";
import type { HistoryRecorder } from "../server/history.js";
import type { TokenProvider } from "../server/opensky-auth.js";

// test/fixtures/opensky-tracks-all.json — recorded live 2026-11-21 through the
// token provider: GET /tracks/all?icao24=a3feee&time=0 (authenticated). The
// live response is the BARE track record ({icao24, callsign, startTime,
// endTime, path}) — NOT the documented {time, elapsed, data:[…]} wrapper, and
// unlike /flights/all it is not a bare array either. The server accepts all
// three shapes. Path entries (pinned from this fixture):
//   [time (epoch seconds), lat, lon, baro alt (m), true track (deg), on ground]
const FIXTURE = readFileSync(new URL("./fixtures/opensky-tracks-all.json", import.meta.url), "utf8");
const T0 = 1_795_297_546_000; // fixture path[0] in ms
const FIXTURE_P0: TrackPoint = { t: T0, lat: 41.3922, lon: -83.6343, alt: 0, onGround: false };
// Same-second entries collapse by the merge-key rule (floor(t/1000)):
const FIXTURE_UNIQ = new Set((JSON.parse(FIXTURE) as { path: number[][] }).path.map((p) => p[0])).size;

let dir: string;
let ledgerFile: string;
let clock = 0;
let calls: Array<{ url: string; init?: RequestInit }> = [];
let queue: Array<() => Response> = [];
let always: (() => Response) | null = null;

const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
  calls.push({ url: String(url), init });
  const next = queue.shift();
  const make = next ?? always;
  if (!make) throw new Error(`unexpected fetch #${calls.length} to ${String(url)}`);
  return make();
}) as unknown as typeof fetch;

const jsonRes =
  (body: string, status = 200, headers: Record<string, string> = {}) =>
  () =>
    new Response(body, { status, headers: { "content-type": "application/json", ...headers } });

// Synthetic body in the docs' wrapper shape (pins the wrapper handling and
// the merge math independently of the live bare-record fixture).
const osBody = (rows: unknown[][]) =>
  JSON.stringify({ time: 0, elapsed: 0, data: [{ icao24: "abc123", callsign: "TEST", path: rows }] });

const stubRecorder = (path: TrackPoint[]): HistoryRecorder =>
  ({ trackFor: () => Promise.resolve(path) }) as unknown as HistoryRecorder;

function fakeProvider() {
  const state = { issued: 0, invalidations: 0 };
  const provider: TokenProvider = {
    async getToken() {
      return `tok${++state.issued}`;
    },
    invalidate() {
      state.invalidations += 1;
    },
  };
  return { provider, state };
}

const make = (over: Partial<TracksOpts> = {}): TracksService =>
  createTracks({ ledgerFile, now: () => clock, fetchImpl, ...over });

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "radar-tracks-"));
  ledgerFile = join(dir, "ledger.json");
  clock = Date.parse("2026-11-21T05:00:00.000Z");
  calls = [];
  queue = [];
  always = null;
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("createTracks — sources and merge", () => {
  it("merges history under OpenSky, dedupes same-second points (OpenSky wins), ascending", async () => {
    const T = 1_795_000_000_000;
    always = jsonRes(osBody([
      [T / 1000 + 4, 1.5, 2.5, 100, 90, false],
      [T / 1000 + 60, 3.5, 4.5, null, 95, true],
      [T / 1000 + 120, null, 5, 10, 0, false], // non-finite lat → dropped
    ]));
    const svc = make({
      recorder: stubRecorder([
        { t: T + 4000, lat: 8, lon: 8, alt: null, onGround: false },
        { t: T + 60_000, lat: 9, lon: 9, alt: 5, onGround: true },
      ]),
    });

    const reply = await svc.get("abc123", true);
    expect(reply.source).toBe("both");
    expect(reply.path).toEqual([
      { t: T + 4000, lat: 1.5, lon: 2.5, alt: 100, onGround: false },
      { t: T + 60_000, lat: 3.5, lon: 4.5, alt: null, onGround: true },
    ]);
    expect(reply.fetchedAt).toBe(clock);
    expect(reply.budget).toEqual({ autoLeft: 298, hard: false }); // gate: 299 - 1 used
  });

  it("maps the recorded fixture exactly (index map, ms times, bare-record shape)", async () => {
    always = jsonRes(FIXTURE);
    const svc = make({ recorder: null });

    const reply = await svc.get("a3feee", true);
    expect(reply.source).toBe("opensky");
    expect(reply.path.length).toBe(FIXTURE_UNIQ);
    expect(reply.path[0]).toEqual(FIXTURE_P0);
    expect(reply.path[FIXTURE_UNIQ - 1]).toEqual({ t: 1_795_299_948_000, lat: 41.2826, lon: -83.5078, alt: 609, onGround: false });
  });

  it("history-only when OpenSky answers HTTP 500 (failure logged)", async () => {
    queue = [jsonRes("{}", 500)];
    const lines: string[] = [];
    const svc = make({ recorder: stubRecorder([{ t: T0, lat: 1, lon: 2, alt: null, onGround: false }]), log: (m) => lines.push(m) });

    const reply = await svc.get("abc123", true);
    expect(reply.source).toBe("history");
    expect(reply.path).toEqual([{ t: T0, lat: 1, lon: 2, alt: null, onGround: false }]);
    expect(lines.some((l) => l.includes("HTTP 500"))).toBe(true);
  });

  it("never throws when OpenSky transport-fails", async () => {
    always = () => {
      throw new Error("socket hangup");
    };
    const svc = make({ recorder: stubRecorder([{ t: T0, lat: 1, lon: 2, alt: null, onGround: false }]) });
    expect((await svc.get("abc123", true)).source).toBe("history");
  });

  it("none when both sources are empty", async () => {
    always = jsonRes(osBody([]));
    const svc = make({ recorder: stubRecorder([]) });
    const reply = await svc.get("abc123", true);
    expect(reply.path).toEqual([]);
    expect(reply.source).toBe("none");
  });

  it("calls anonymously (no Authorization) when no tokenProvider is configured; id trimmed and lowercased", async () => {
    // no tokenProvider: still one anonymous call (no Authorization header)
    always = jsonRes(FIXTURE);
    const svc = make({ recorder: null });
    const reply = await svc.get(" A3FEEE ", true);
    expect(reply.source).toBe("opensky");
    expect(calls.length).toBe(1);
    expect(calls[0].url).toContain("icao24=a3feee");
    expect(calls[0].url).toContain("time=0");
    expect((calls[0].init?.headers as Record<string, string>).Authorization).toBeUndefined();
  });

  it("authenticates and does 401-invalidate-retry-once", async () => {
    const { provider, state } = fakeProvider();
    queue = [jsonRes("{}", 401), jsonRes(FIXTURE)];
    const svc = make({ tokenProvider: provider });

    const reply = await svc.get("a3feee", true);
    expect(state.invalidations).toBe(1);
    expect(calls.length).toBe(2);
    expect((calls[0].init?.headers as Record<string, string>).Authorization).toBe("Bearer tok1");
    expect((calls[1].init?.headers as Record<string, string>).Authorization).toBe("Bearer tok2");
    expect(reply.source).toBe("opensky");
  });
});

describe("createTracks — cache", () => {
  it("serves per-icao24 for 10 s, then re-calls", async () => {
    always = jsonRes(FIXTURE);
    const svc = make();

    const a = await svc.get("a3feee", true);
    const b = await svc.get("a3feee", true);
    expect(calls.length).toBe(1);
    expect(b).toEqual(a);
    clock += 11_000;
    await svc.get("a3feee", true);
    expect(calls.length).toBe(2);
  });

  it("caches per icao24 (another craft is not served from it)", async () => {
    always = jsonRes(FIXTURE);
    const svc = make();
    await svc.get("a3feee", true);
    await svc.get("aaa000", true);
    expect(calls.length).toBe(2);
  });
});

describe("createTracks — daily ledger", () => {
  it("auto-refuses the request that would hit the 300 cap, keeps serving cache; manual still allowed", async () => {
    always = jsonRes(FIXTURE);
    const svc = make({ cacheMs: 0 }); // no freshness caching: every get reaches the ledger

    for (let i = 0; i < 299; i++) {
      const reply = await svc.get("a3feee", true);
      expect(calls.length).toBe(i + 1);
      // autoLeft agrees with the gate (auto refused at count + 1 >= 300):
      // after the (i+1)-th call, 299 - (i + 1) auto calls remain accepted.
      expect(reply.budget.autoLeft).toBe(299 - (i + 1));
    }
    // 300th auto: refused, served the (any-age) cached path, no call.
    const refused = await svc.get("a3feee", true);
    expect(calls.length).toBe(299);
    expect(refused.budget).toEqual({ autoLeft: 0, hard: false });
    expect(refused.path.length).toBe(FIXTURE_UNIQ);
    // Manual is allowed.
    await svc.get("a3feee", false);
    expect(calls.length).toBe(300);
  });

  it("autoLeft reads the gate: 1 at 298 used, 0 at 299, never negative", async () => {
    always = jsonRes(osBody([]));
    await writeFile(ledgerFile, JSON.stringify({ day: "2026-11-21", count: 297 }));
    const svc = make({ cacheMs: 0 });

    // autoLeft = auto calls the gate still accepts (refused at count + 1 >= 300),
    // so the budget note never promises a request the gate would deny.
    // 297→298 used: one auto poll still accepted.
    expect((await svc.get("a3feee", true)).budget).toEqual({ autoLeft: 1, hard: false });
    // 298→299 used: the next auto is refused, so 0.
    expect((await svc.get("a3feee", true)).budget).toEqual({ autoLeft: 0, hard: false });
    // Auto at 299: refused, reports 0, spends nothing (no request, no bump).
    expect((await svc.get("a3feee", true)).budget).toEqual({ autoLeft: 0, hard: false });
    expect(calls.length).toBe(2);
    expect(JSON.parse(await readFile(ledgerFile, "utf8")).count).toBe(299);
    // Manual still rides: 299→300, and max(0, 299 - 300) stays 0.
    expect((await svc.get("a3feee", false)).budget.autoLeft).toBe(0);
    expect(calls.length).toBe(3);
  });

  it("budget() reads the live gate without spending", async () => {
    await writeFile(ledgerFile, JSON.stringify({ day: "2026-11-21", count: 299 }));
    const svc = make();

    // Unknown-id track echoes report this same live budget (index.ts): honest
    // at count=299 (0, not the cap), and side-effect-free.
    expect(await svc.budget()).toEqual({ autoLeft: 0, hard: false });
    expect(calls.length).toBe(0);
    expect(JSON.parse(await readFile(ledgerFile, "utf8")).count).toBe(299);
  });

  it("hard-refuses everything past 800/day, even manual, and empty-craft refusals have no cache to serve", async () => {
    always = jsonRes(FIXTURE);
    const svc = make({ cacheMs: 0 });
    const n = HARD_DAILY_CAP;

    for (let i = 0; i < n - 1; i++) {
      await svc.get("a3feee", false);
      expect(calls.length).toBe(i + 1);
    }
    const hard = await svc.get("a3feee", false);
    expect(calls.length).toBe(n - 1);
    expect(hard.budget).toEqual({ autoLeft: 0, hard: true });
    // A refusal for a craft never fetched has no cache: empty "none" reply.
    const cold = await svc.get("deadbe", true);
    expect(cold.path).toEqual([]);
    expect(cold.source).toBe("none");
    expect(cold.budget.hard).toBe(true);
  });

  it("persists the ledger as {day, count} write-through", async () => {
    always = jsonRes(osBody([]));
    const svc = make({ cacheMs: 0 });
    await svc.get("a3feee", true);
    await svc.get("a3feee", true);
    expect(JSON.parse(await readFile(ledgerFile, "utf8"))).toEqual({ day: "2026-11-21", count: 2 });
  });

  it("resets the count at UTC midnight", async () => {
    always = jsonRes(osBody([]));
    const svc = make({ cacheMs: 0, autoDailyCap: 2, hardDailyCap: 50 });

    expect((await svc.get("a3feee", true)).path).toEqual([]); // count 0 → 1
    const refused = await svc.get("a3feee", true); // would be 2 → refused
    expect(refused.budget).toEqual({ autoLeft: 0, hard: false });
    expect(calls.length).toBe(1);

    clock += 24 * 3_600_000; // next UTC day
    await svc.get("a3feee", true);
    expect(calls.length).toBe(2);
    expect(JSON.parse(await readFile(ledgerFile, "utf8")).day).toBe("2026-11-22");
  });

  it("starts fresh from a corrupt ledger (logged once) and from another day's counts", async () => {
    await writeFile(ledgerFile, "{not json");
    const lines: string[] = [];
    always = jsonRes(osBody([]));
    const svc = make({ log: (m) => lines.push(m) });
    await svc.get("a3feee", true);
    expect(calls.length).toBe(1);
    expect(lines.filter((l) => l.includes("corrupt")).length).toBe(1);

    await writeFile(ledgerFile, JSON.stringify({ day: "2020-01-01", count: 9999 }));
    const svc2 = make({ autoDailyCap: 2 });
    await svc2.get("a3feee", true); // other day's 9999 must not count
    expect(calls.length).toBe(2);
  });

  it("counts OpenSky track response bytes into the traffic monitor", async () => {
    const body = osBody([[1_795_000_100, 1, 2, 3, 0, false]]);
    const counted: Array<{ dir: "in" | "out"; bytes: number }> = [];
    always = jsonRes(body);
    const svc = make({
      recorder: null,
      traffic: { count: (dir, bytes) => counted.push({ dir, bytes }) },
    });
    const reply = await svc.get("abc123", true);
    expect(reply.source).toBe("opensky");
    expect(counted).toEqual([{ dir: "in", bytes: Buffer.byteLength(body) }]);
  });
});
