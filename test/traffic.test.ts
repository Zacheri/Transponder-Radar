import { readFileSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createTrafficMonitor,
  dayStamp,
  parseNetstat,
  parseNettop,
  topDelta,
  type TrafficMonitorOpts,
} from "../server/traffic.js";

const NETSTAT_FIXTURE = readFileSync(new URL("./fixtures/netstat-ib.txt", import.meta.url), "utf8");
const NETTOP_FIXTURE = readFileSync(new URL("./fixtures/nettop-p.txt", import.meta.url), "utf8");

/** Real-format (macOS `netstat -ib`) synthetic output with chosen en0 counters. */
function nsOut(ibytes: number, obytes: number): string {
  return [
    "Name       Mtu   Network       Address            Ipkts Ierrs     Ibytes    Opkts Oerrs     Obytes  Coll",
    "lo0        16384 <Link#1>                      23520720     0 25520625077 23520720     0 25520625077     0",
    `en0        1500  <Link#14>   2e:1f:6d:ee:d3:9a 52587232     0      ${ibytes} 19467598     0      ${obytes}     0`,
    "en0        1500  192.168.1     mac             52587232     -      99999999 19467598     -      99999999     -",
    "",
  ].join("\n");
}

// ---------------------------------------------------------------- parsers

describe("parseNetstat", () => {
  it("sums en* extended rows on the recorded fixture (plain dupes and lo0 excluded)", () => {
    // Hand-derived: extended rows starting "en" are en1 (0/0), en0 (47986448939/3557239547),
    // en8 (0/0); lo0/utun/ap1/awdl0/gif0* rows are excluded by name; the three
    // plain en0 rows are excluded as non-extended.
    expect(parseNetstat(NETSTAT_FIXTURE)).toEqual({ in: 47986448939, out: 3557239547 });
  });

  it("ignores plain (non-extended) rows even when they carry numbers", () => {
    const withoutExtendedEn0 = NETSTAT_FIXTURE.split("\n")
      .filter((l) => !l.includes("<Link#14>"))
      .join("\n");
    expect(parseNetstat(withoutExtendedEn0)).toEqual({ in: 0, out: 0 });
  });

  it("does not count extended non-en interfaces", () => {
    // utun0's extended row carries Obytes 100; a name-matching-only rule would add it.
    const noEn = NETSTAT_FIXTURE.split("\n")
      .filter((l) => !/^(en\d|Name)/.test(l))
      .join("\n");
    expect(parseNetstat(noEn)).toBeNull();
  });

  it("null on empty/garbage/non-billing output", () => {
    expect(parseNetstat("")).toBeNull();
    expect(parseNetstat("garbage\nrows\n")).toBeNull();
    expect(
      parseNetstat(
        "Name       Mtu   Network       Address            Ipkts Ierrs    Opkts Oerrs     Coll\nlo0        16384 <Link#1>                      23441303     0 23441303     0     0\n",
      ),
    ).toBeNull();
  });
});

describe("parseNettop", () => {
  it("parses the recorded fixture with pid stripped and proc truncated at first dot", () => {
    expect(parseNettop(NETTOP_FIXTURE)).toEqual([
      { proc: "syslogd", in: 0, out: 58672 },
      { proc: "apsd", in: 8864515, out: 7208627 },
      { proc: "airportd", in: 0, out: 0 },
      { proc: "mDNSResponder", in: 75042712, out: 12313625 },
      { proc: "openvpn", in: 2329450, out: 2241042 },
      { proc: "opencode", in: 0, out: 0 },
      { proc: "opencode", in: 16249442, out: 30862825 },
      { proc: "SRStreamerDaemo", in: 37048, out: 32055 },
      { proc: "Slack Helper", in: 546020, out: 178697 },
      { proc: "opencode", in: 87983739, out: 21694263 },
      { proc: "python3", in: 0, out: 0 },
      { proc: "oMLX", in: 3154041, out: 841634 },
      { proc: "python3", in: 841634, out: 3154041 },
    ]);
  });

  it("null on non-csv or missing columns", () => {
    expect(parseNettop("")).toBeNull();
    expect(parseNettop("bytes,traffic\nfoo,1\n")).toBeNull();
  });

  it("null when any row is malformed", () => {
    expect(parseNettop(",bytes_in,bytes_out,\nfoo.1,x,2,\n")).toBeNull();
  });
});

describe("topDelta", () => {
  it("computes per-proc deltas (same-proc pids summed), caps at n, returns seen totals", () => {
    const rows = [
      { proc: "a", in: 10, out: 10 },
      { proc: "b", in: 5, out: 5 },
      { proc: "a", in: 1, out: 1 },
    ];
    const r1 = topDelta(new Map(), rows, 5);
    expect(r1.top).toEqual([
      { proc: "a", bytes: 22 },
      { proc: "b", bytes: 10 },
    ]);
    expect(r1.seen).toEqual(new Map([["a", 22], ["b", 10]]));
    expect(topDelta(new Map(), rows, 1).top).toEqual([{ proc: "a", bytes: 22 }]);
  });

  it("zeroes negative deltas (proc restart) and drops idle procs from top", () => {
    const prev = new Map([
      ["a", 22],
      ["b", 10],
    ]);
    const r = topDelta(prev, [{ proc: "a", in: 10, out: 5 }], 5); // a total 15 < 22
    expect(r.top).toEqual([]);
    expect(r.seen).toEqual(new Map([["a", 15]])); // vanished "b" not carried
  });
});

describe("dayStamp", () => {
  it("is the UTC calendar day", () => {
    expect(dayStamp(Date.UTC(2026, 10, 24, 23, 59, 59))).toBe("2026-11-24");
    expect(dayStamp(Date.UTC(2026, 10, 25, 0, 0, 0))).toBe("2026-11-25");
  });
});

// ---------------------------------------------------------------- monitor

const DAY1 = Date.parse("2026-11-24T10:00:00.000Z");
const MIN = 60_000;

let dir: string;
let clock: number;
let logs: string[];

beforeEach(async () => {
  clock = DAY1;
  logs = [];
  dir = await mkdtemp(join(tmpdir(), "traffic-"));
});

afterEach(async () => {
  await settle(); // drain the monitor's write chain before removing the dir
  await rm(dir, { recursive: true, force: true });
});

function monitor(overrides: Partial<TrafficMonitorOpts> = {}) {
  return createTrafficMonitor({
    dir,
    now: () => clock,
    log: (msg) => logs.push(msg),
    ...overrides,
  });
}

function okSpawn(netstatOut = () => NETSTAT_FIXTURE, nettopOut = () => NETTOP_FIXTURE) {
  return async (cmd: string, _args: string[]): Promise<string> => {
    if (cmd === "netstat") return netstatOut();
    if (cmd === "nettop") return nettopOut();
    throw new Error(`unexpected spawn: ${cmd}`);
  };
}

/** Let spawned promises and the chained fs writes settle. */
async function settle(): Promise<void> {
  for (let i = 0; i < 12; i++) await new Promise((r) => setTimeout(r, 0));
}

describe("createTrafficMonitor", () => {
  it("radar rates come from bytes counted since the previous sample", () => {
    const m = monitor({ spawnImpl: async () => NETSTAT_FIXTURE });
    m.start();
    const s0 = m.sample(); // first tick: no previous => rates 0
    expect(s0.radar).toEqual({ up: 0, down: 0, upTotal: 0, downTotal: 0 });
    m.count("out", 1500);
    m.count("in", 500);
    clock += 1000;
    const s1 = m.sample();
    expect(s1.radar).toEqual({ up: 1500, down: 500, upTotal: 1500, downTotal: 500 });
    clock += 1000;
    const s2 = m.sample(); // nothing new: rates fall to 0
    expect(s2.radar).toEqual({ up: 0, down: 0, upTotal: 1500, downTotal: 500 });
  });

  it("ignores non-finite or negative counts", () => {
    const m = monitor({ spawnImpl: async () => NETSTAT_FIXTURE });
    m.start();
    m.count("out", Number.NaN);
    m.count("out", Number.POSITIVE_INFINITY);
    m.count("out", -500);
    m.addBrowserDown(Number.NaN);
    m.addBrowserDown(-1);
    const s = m.sample();
    expect(s.radar).toEqual({ up: 0, down: 0, upTotal: 0, downTotal: 0 });
  });

  it("folds browser bytes into radar down (rate and total)", () => {
    const m = monitor({ spawnImpl: async () => NETSTAT_FIXTURE });
    m.start();
    m.sample();
    m.addBrowserDown(300);
    clock += 1000;
    const s = m.sample();
    expect(s.radar.down).toBe(300);
    expect(s.radar.up).toBe(0);
    expect(s.radar.downTotal).toBe(300);
  });

  it("zero rates when the clock has not advanced between samples", () => {
    const m = monitor({ spawnImpl: async () => NETSTAT_FIXTURE });
    m.start();
    m.count("out", 400);
    m.sample();
    const s = m.sample(); // same millisecond
    expect(s.radar.up).toBe(0);
    expect(s.radar.upTotal).toBe(400);
  });

  it("seeds the device on the first netstat ok (non-null, rate 0), then deltas per observation", async () => {
    let ib = 5000;
    let ob = 2000;
    const m = monitor({ spawnImpl: okSpawn(() => nsOut(ib, ob)) });
    m.start();
    await settle(); // seed observation lands
    const s0 = m.sample(); // fires a second netstat (same counters)
    await settle();
    expect(s0.device).toEqual({ up: 0, down: 0, upTotal: 0, downTotal: 0 });
    ib = 6000;
    ob = 2500;
    clock += 1000;
    m.sample(); // fires the third netstat (bumped counters)
    await settle(); // delta computed over 1 s
    clock += 1000;
    const s1 = m.sample();
    expect(s1.device).toEqual({ up: 500, down: 1000, upTotal: 500, downTotal: 1000 });
  });

  it("zeroes counter-wrap deltas and logs at most once per 10 minutes", async () => {
    let ib = 5000;
    let ob = 2000;
    const m = monitor({ spawnImpl: okSpawn(() => nsOut(ib, ob)) });
    m.start();
    await settle(); // seed 5000/2000
    clock += 1000;
    m.sample(); // second observation (same counters)
    await settle();
    ib = 10;
    ob = 10;
    clock += 1000;
    m.sample(); // third observation: lower counters -> wrap
    await settle();
    clock += 1000;
    expect(m.sample().device?.upTotal).toBe(0);
    await settle();
    expect(logs.filter((l) => /wrap|reset/i.test(l))).toHaveLength(1);
    // Same counters again: no new wrap log while the throttle window is open.
    clock += 1000;
    m.sample();
    await settle();
    expect(logs.filter((l) => /wrap|reset/i.test(l))).toHaveLength(1);
    // 11 minutes later the throttle window has passed and a new wrap logs again.
    ib = 2;
    ob = 2;
    clock += 11 * MIN;
    m.sample();
    await settle();
    expect(logs.filter((l) => /wrap|reset/i.test(l))).toHaveLength(2);
  });

  it("nets netstat + nettop through the exported cadence: top from 5s, empty on idle 5s", async () => {
    const m = monitor({ spawnImpl: okSpawn() });
    m.start();
    await settle();
    expect(m.sample().top).toBeNull(); // nothing parsed yet
    clock += 1000;
    m.sample(); // fires nettop
    await settle();
    const s = m.sample();
    expect(s.top).toEqual([
      { proc: "opencode", bytes: 156790269 },
      { proc: "mDNSResponder", bytes: 87356337 },
      { proc: "apsd", bytes: 16073142 },
      { proc: "openvpn", bytes: 4570492 },
      { proc: "oMLX", bytes: 3995675 }, // ties with python3; lower proc name wins
    ]);
    clock += 4000;
    m.sample(); // fires the second nettop (5 s after the first)
    await settle();
    expect(m.sample().top).toEqual([]); // identical counters: no deltas
  });

  it("top is null when nettop fails to parse, and never kills the sample", async () => {
    let ntBroken = false;
    const m = monitor({
      spawnImpl: okSpawn(
        () => nsOut(1, 1),
        () => {
          if (ntBroken) return "not,csv\n";
          return NETTOP_FIXTURE;
        },
      ),
    });
    m.start();
    await settle();
    clock += 1000;
    m.sample();
    await settle();
    expect(m.sample().top).toHaveLength(5);
    ntBroken = true;
    clock += 5000;
    m.sample();
    await settle();
    const s = m.sample();
    expect(s.top).toBeNull();
    expect(s.device).not.toBeNull();
  });

  it("degrades: spawn rejections leave device null and radar working", async () => {
    const m = monitor({
      spawnImpl: async () => {
        throw new Error("ENOENT netstat");
      },
    });
    m.start();
    await settle();
    m.count("in", 1234);
    clock += 1000;
    const s = m.sample();
    expect(s.device).toBeNull();
    expect(s.radar.down).toBe(1234);
    expect(logs.length).toBeGreaterThan(0);
  });

  it("device goes non-null but rate 0 once netstat succeeds then starts failing", async () => {
    let ok = true;
    const m = monitor({
      spawnImpl: async (cmd, args) => {
        if (cmd !== "netstat") return NETTOP_FIXTURE;
        if (!ok) throw new Error("netstat died");
        void args;
        return NETSTAT_FIXTURE;
      },
    });
    m.start();
    await settle(); // seed ok
    ok = false;
    clock += 1000;
    m.sample();
    await settle();
    const s = m.sample();
    expect(s.device).toEqual({ up: 0, down: 0, upTotal: 0, downTotal: 0 });
  });

  it("skips spawns while a netstat or nettop is still in flight", async () => {
    const seen: string[] = [];
    let release: (() => void) | null = null;
    const gate = new Promise<void>((r) => (release = r));
    const m = monitor({
      spawnImpl: async (cmd) => {
        seen.push(cmd);
        await gate;
        return cmd === "netstat" ? NETSTAT_FIXTURE : NETTOP_FIXTURE;
      },
    });
    m.start(); // seeds netstat (in flight forever until release)
    m.sample();
    m.sample();
    expect(seen.filter((c) => c === "netstat")).toHaveLength(1);
    expect(seen.filter((c) => c === "nettop")).toHaveLength(1); // nettop only ever fired once
    release!();
    await settle();
  });

  it("watch counts never go below zero", () => {
    const m = monitor({ spawnImpl: async () => NETSTAT_FIXTURE });
    expect(m.watchers()).toBe(0);
    m.watch(true);
    m.watch(true);
    expect(m.watchers()).toBe(2);
    m.watch(false);
    m.watch(false);
    m.watch(false);
    expect(m.watchers()).toBe(0);
  });

  it("stops spawning after stop(), and stop() is idempotent", async () => {
    const seen: string[] = [];
    const m = monitor({
      spawnImpl: async (cmd) => {
        seen.push(cmd);
        return cmd === "netstat" ? NETSTAT_FIXTURE : NETTOP_FIXTURE;
      },
    });
    m.start();
    await settle();
    m.stop();
    m.stop();
    m.sample();
    await settle();
    expect(seen.filter((c) => c === "netstat")).toHaveLength(1); // seed only
  });

  it("persists day.json every sample and reloads it in a fresh monitor", async () => {
    const m = monitor({ spawnImpl: async () => NETSTAT_FIXTURE });
    m.start();
    m.count("in", 1234);
    m.addBrowserDown(111);
    m.sample();
    await settle();
    const dayFile = JSON.parse(await readFile(join(dir, "day.json"), "utf8"));
    expect(dayFile).toEqual({
      day: "2026-11-24",
      radarUp: 0,
      radarDown: 1345,
      devUp: 0,
      devDown: 0,
    });

    const m2 = monitor({ spawnImpl: async () => NETSTAT_FIXTURE });
    m2.start();
    await settle();
    const s = m2.sample();
    expect(s.radar.downTotal).toBe(1345);
    expect(s.radar.upTotal).toBe(0);
  });

  it("rolls the day: previous day appended to history.json, day.json reset", async () => {
    const m = monitor({ spawnImpl: okSpawn() });
    m.start();
    await settle();
    m.count("out", 1000);
    m.sample();
    await settle();
    clock = Date.parse("2026-11-25T00:00:05.000Z");
    const s = m.sample();
    await settle();
    expect(s.radar.upTotal).toBe(0);
    expect(s.at).toBe(clock);
    const history = JSON.parse(await readFile(join(dir, "history.json"), "utf8"));
    expect(history).toEqual([{ day: "2026-11-24", radarUp: 1000, radarDown: 0, devUp: 0, devDown: 0 }]);
    const dayFile = JSON.parse(await readFile(join(dir, "day.json"), "utf8"));
    expect(dayFile.day).toBe("2026-11-25");
  });

  it("caps history at 30 entries, dropping the oldest", async () => {
    const seeded = Array.from({ length: 30 }, (_, i) => ({
      day: `2026-10-${String(i + 1).padStart(2, "0")}`,
      radarUp: i,
      radarDown: 0,
      devUp: 0,
      devDown: 0,
    }));
    await writeFile(join(dir, "history.json"), JSON.stringify(seeded));
    const m = monitor({ spawnImpl: async () => NETSTAT_FIXTURE });
    m.start();
    m.count("out", 7);
    m.sample();
    await settle();
    clock = Date.parse("2026-11-25T00:00:05.000Z");
    m.sample();
    await settle();
    const history = JSON.parse(await readFile(join(dir, "history.json"), "utf8"));
    expect(history).toHaveLength(30);
    expect(history[0].day).toBe("2026-10-02");
    expect(history.at(-1)).toEqual({ day: "2026-11-24", radarUp: 7, radarDown: 0, devUp: 0, devDown: 0 });
  });

  it("merges bytes counted during the day-file read into the loaded totals", async () => {
    await writeFile(join(dir, "day.json"), JSON.stringify({ day: "2026-11-24", radarUp: 100, radarDown: 0, devUp: 0, devDown: 0 }));
    const m = monitor({ spawnImpl: async () => NETSTAT_FIXTURE });
    m.start();
    m.count("out", 5); // counted while the day-file read is still in flight
    await settle();
    expect(m.sample().radar.upTotal).toBe(105);
  });

  it("adopts a same-day day.json written earlier (restart), ignores a corrupt one", async () => {    await writeFile(join(dir, "day.json"), JSON.stringify({ day: "2026-11-24", radarUp: 42, radarDown: 0, devUp: 0, devDown: 0 }));
    const m = monitor({ spawnImpl: async () => NETSTAT_FIXTURE });
    m.start();
    await settle();
    expect(m.sample().radar.upTotal).toBe(42);

    await writeFile(join(dir, "day.json"), "{nope");
    const m2 = monitor({ spawnImpl: async () => NETSTAT_FIXTURE });
    m2.start();
    await settle();
    expect(m2.sample().radar.upTotal).toBe(0);
  });
});
