import { execFile, type ChildProcess } from "node:child_process";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";

export interface TrafficSample {
  at: number;
  radar: { up: number; down: number; upTotal: number; downTotal: number };
  device: { up: number; down: number; upTotal: number; downTotal: number } | null;
  top: { proc: string; bytes: number }[] | null;
}

export interface TrafficMonitorOpts {
  now?: () => number;
  spawnImpl?: (cmd: string, args: string[]) => Promise<string>;
  dir: string;
  log?: (msg: string) => void;
}

type DayRecord = { day: string; radarUp: number; radarDown: number; devUp: number; devDown: number };
type NetstatObs = { in: number; out: number };

const NETTOP_ARGS = ["-P", "-L", "1", "-x", "-J", "bytes_in,bytes_out"];
const NETTOP_EVERY_MS = 5_000; // nettop -L 1 itself blocks ~5 s for its first sample
const TOP_N = 5;
const LOG_THROTTLE_MS = 10 * 60_000;
const HISTORY_CAP = 30;

export function dayStamp(nowMs: number): string {
  return new Date(nowMs).toISOString().slice(0, 10);
}

const errMsg = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/**
 * Sum ibytes/obytes over rows whose interface name starts with "en" and whose
 * flags column is the EXTENDED form (the billing header carries the IBYTES
 * column; per-row that is the `<Link#…>` row carrying the real counters —
 * lo0 and duplicate plain rows are excluded by construction).
 */
export function parseNetstat(out: string): NetstatObs | null {
  const lines = out.split("\n");
  const header = lines.find((l) => l.startsWith("Name"));
  if (!header) return null;
  if (!header.toUpperCase().includes("IBYTES")) return null; // EXTENDED (billing) column form
  let inB = 0;
  let outB = 0;
  let rows = 0;
  for (const line of lines) {
    const t = line.trim().split(/\s+/);
    if (t.length < 10 || !/^en\d/.test(t[0].replace(/\*+$/, ""))) continue;
    if (!t[2].startsWith("<Link#")) continue; // extended row only
    const nums = t.slice(-7); // Ipkts Ierrs Ibytes Opkts Oerrs Obytes Coll
    if (!nums.every((n) => /^\d+$/.test(n))) continue;
    inB += Number(nums[2]);
    outB += Number(nums[5]);
    rows++;
  }
  return rows ? { in: inB, out: outB } : null;
}

/** nettop CSV row name is `name.pid`; display name drops the pid, then truncates at first '.'. */
function procName(raw: string): string {
  const i = raw.lastIndexOf(".");
  const stripped = i > 0 && /^\d+$/.test(raw.slice(i + 1)) ? raw.slice(0, i) : raw;
  const dot = stripped.indexOf(".");
  return dot > 0 ? stripped.slice(0, dot) : stripped;
}

export function parseNettop(out: string): { proc: string; in: number; out: number }[] | null {
  const lines = out.split("\n");
  const header = lines[0]?.split(",") ?? [];
  const iIn = header.indexOf("bytes_in");
  const iOut = header.indexOf("bytes_out");
  if (iIn < 0 || iOut < 0) return null;
  const rows: { proc: string; in: number; out: number }[] = [];
  for (const line of lines.slice(1)) {
    if (!line.trim()) continue;
    const c = line.split(",");
    const inRaw = c[iIn] ?? "";
    const outRaw = c[iOut] ?? "";
    if (!c[0] || !/^\d+$/.test(inRaw) || !/^\d+$/.test(outRaw)) return null;
    rows.push({ proc: procName(c[0]), in: Number(inRaw), out: Number(outRaw) });
  }
  return rows.length ? rows : null;
}

/** Top-n procs by bytes_in+bytes_out delta since `prev` (per-proc totals); negatives clamp to 0. */
export function topDelta(
  prev: Map<string, number>,
  next: { proc: string; in: number; out: number }[],
  n: number,
): { top: { proc: string; bytes: number }[]; seen: Map<string, number> } {
  const totals = new Map<string, number>();
  for (const r of next) totals.set(r.proc, (totals.get(r.proc) ?? 0) + r.in + r.out);
  const deltas: { proc: string; bytes: number }[] = [];
  for (const [proc, total] of totals) {
    const d = total - (prev.get(proc) ?? 0);
    if (d > 0) deltas.push({ proc, bytes: d });
  }
  deltas.sort((a, b) => b.bytes - a.bytes || (a.proc < b.proc ? -1 : a.proc > b.proc ? 1 : 0));
  return { top: deltas.slice(0, Math.max(0, n)), seen: totals };
}

export function createTrafficMonitor(opts: TrafficMonitorOpts): {
  count(dir: "in" | "out", bytes: number): void;
  addBrowserDown(bytes: number): void;
  sample(): TrafficSample;
  watch(on: boolean): void;
  watchers(): number;
  start(): void;
  stop(): void;
} {
  const now = opts.now ?? (() => Date.now());
  const log = opts.log ?? (() => {});
  const live = new Set<ChildProcess>();
  const spawn =
    opts.spawnImpl ??
    ((cmd: string, args: string[]): Promise<string> =>
      new Promise((resolve, reject) => {
        const child = execFile(cmd, args, { maxBuffer: 4 * 1024 * 1024 }, (err, stdout) => {
          live.delete(child);
          if (err) reject(new Error(`${cmd}: ${errMsg(err)}`));
          else resolve(stdout);
        });
        live.add(child);
      }));

  const fresh = (): DayRecord => ({ day: dayStamp(now()), radarUp: 0, radarDown: 0, devUp: 0, devDown: 0 });
  let dayRec: DayRecord = fresh();
  let dUp = 0;
  let dDown = 0;
  let dBrowser = 0;
  let lastAt = 0;
  let watcherCount = 0;
  let started = false;
  let stopped = false;
  let devRates = { up: 0, down: 0 };
  let devObs: (NetstatObs & { at: number }) | null = null;
  let nettopPrev = new Map<string, number>();
  let lastTop: TrafficSample["top"] = null;
  let netstatBusy = false;
  let nettopBusy = false;
  let lastNettopAt = 0;
  const lastLogAt = new Map<string, number>();
  let chain: Promise<void> = Promise.resolve();

  const throttleLog = (key: string, msg: string): void => {
    const t = now();
    if (t - (lastLogAt.get(key) ?? Number.NEGATIVE_INFINITY) < LOG_THROTTLE_MS) return;
    lastLogAt.set(key, t);
    log(msg);
  };

  const validDay = (v: unknown): v is DayRecord => {
    const r = v as DayRecord;
    return (
      !!r &&
      typeof r.day === "string" &&
      [r.radarUp, r.radarDown, r.devUp, r.devDown].every((n) => Number.isFinite(n) && n >= 0)
    );
  };

  const appendHistory = (rec: DayRecord): Promise<void> =>
    (async () => {
      let arr: DayRecord[] = [];
      try {
        const parsed = JSON.parse(await readFile(join(opts.dir, "history.json"), "utf8"));
        if (Array.isArray(parsed)) arr = parsed.filter(validDay).filter((e) => e.day !== rec.day);
      } catch {
        // no/corrupt history file: start fresh
      }
      arr.push(rec);
      if (arr.length > HISTORY_CAP) arr = arr.slice(-HISTORY_CAP);
      const tmp = join(opts.dir, "history.json.tmp");
      await writeFile(tmp, JSON.stringify(arr));
      await rename(tmp, join(opts.dir, "history.json"));
    })();

  const enqueue = (fn: () => Promise<void>, label: string): void => {
    chain = chain
      .then(async () => {
        await mkdir(opts.dir, { recursive: true });
        await fn();
      })
      .catch((e) => throttleLog(`write:${label}`, `traffic: ${label} write failed: ${errMsg(e)}`));
  };

  // Day-load reads day.json directly (not via the write chain) so a fresh
  // monitor's first sample sees the totals. Bytes counted while the read is
  // in flight merge into a same-day file; with a stale file they are kept
  // (today stays fresh — the rollover on the next sample archives the file).
  // Stale-day window (crash restart after midnight): the kept bytes win and
  // the stale file's totals are DROPPED — the next rollover archives the
  // in-memory day, never the discarded file.
  const loadDay = (): void => {
    const counted = { ...dayRec };
    void (async () => {
      try {
        const parsed = JSON.parse(await readFile(join(opts.dir, "day.json"), "utf8"));
        if (!validDay(parsed)) return;
        const inc = (k: "radarUp" | "radarDown" | "devUp" | "devDown") => dayRec[k] - counted[k];
        const stale = parsed.day !== dayRec.day;
        const dirty = inc("radarUp") || inc("radarDown") || inc("devUp") || inc("devDown");
        if (stale && dirty) return;
        dayRec = stale
          ? parsed
          : {
              day: parsed.day,
              radarUp: parsed.radarUp + inc("radarUp"),
              radarDown: parsed.radarDown + inc("radarDown"),
              devUp: parsed.devUp + inc("devUp"),
              devDown: parsed.devDown + inc("devDown"),
            };
      } catch {
        // no/corrupt day file: start fresh
      }
    })();
  };

  const rollIfNeeded = (today: string): void => {
    if (dayRec.day === today) return;
    const prev = dayRec;
    dayRec = { day: today, radarUp: 0, radarDown: 0, devUp: 0, devDown: 0 };
    enqueue(() => appendHistory(prev), "history");
  };

  const writeDay = (): void => {
    const snap = { ...dayRec };
    enqueue(async () => {
      const tmp = join(opts.dir, "day.json.tmp");
      await writeFile(tmp, JSON.stringify(snap));
      await rename(tmp, join(opts.dir, "day.json"));
    }, "day");
  };

  const fireNetstat = (): void => {
    if (netstatBusy) return;
    netstatBusy = true;
    spawn("netstat", ["-ib"])
      .then((out) => {
        if (stopped) return;
        const obs = parseNetstat(out);
        if (!obs) {
          devRates = { up: 0, down: 0 };
          throttleLog("netstat-parse", "traffic: netstat output could not be parsed");
          return;
        }
        const t = now();
        if (!devObs) {
          devObs = { ...obs, at: t }; // first observation seeds: rate 0
          return;
        }
        const dIn = obs.in - devObs.in;
        const dOut = obs.out - devObs.out;
        const dt = t - devObs.at;
        devObs = { ...obs, at: t };
        if (dIn < 0 || dOut < 0) {
          devRates = { up: 0, down: 0 };
          throttleLog("netstat-wrap", "traffic: device counter wrap/reset — delta treated as 0");
          return;
        }
        dayRec.devDown += dIn;
        dayRec.devUp += dOut;
        devRates = dt > 0 ? { up: dOut / (dt / 1000), down: dIn / (dt / 1000) } : { up: 0, down: 0 };
      })
      .catch((e: unknown) => {
        if (stopped) return;
        devRates = { up: 0, down: 0 };
        throttleLog("netstat-spawn", `traffic: netstat failed: ${errMsg(e)}`);
      })
      .finally(() => {
        netstatBusy = false;
      });
  };

  const fireNettop = (at: number): void => {
    if (nettopBusy) return;
    nettopBusy = true;
    lastNettopAt = at;
    spawn("nettop", NETTOP_ARGS)
      .then((out) => {
        if (stopped) return;
        const rows = parseNettop(out);
        if (!rows) {
          lastTop = null;
          throttleLog("nettop-parse", "traffic: nettop output could not be parsed");
          return;
        }
        const { top, seen } = topDelta(nettopPrev, rows, TOP_N);
        nettopPrev = seen;
        lastTop = top;
      })
      .catch((e: unknown) => {
        if (stopped) return;
        lastTop = null;
        throttleLog("nettop-spawn", `traffic: nettop failed: ${errMsg(e)}`);
      })
      .finally(() => {
        nettopBusy = false;
      });
  };

  return {
    count(dir, bytes) {
      if (!Number.isFinite(bytes) || bytes < 0) return;
      if (dir === "out") {
        dayRec.radarUp += bytes;
        dUp += bytes;
      } else {
        dayRec.radarDown += bytes;
        dDown += bytes;
      }
    },
    addBrowserDown(bytes) {
      if (!Number.isFinite(bytes) || bytes < 0) return;
      dayRec.radarDown += bytes;
      dBrowser += bytes;
    },
    sample() {
      const at = now();
      rollIfNeeded(dayStamp(at));
      if (!stopped) {
        fireNetstat();
        if (at - lastNettopAt >= NETTOP_EVERY_MS) fireNettop(at);
      }
      const elapsed = lastAt > 0 ? at - lastAt : 0;
      lastAt = at;
      const sec = elapsed > 0 ? elapsed / 1000 : 0;
      const up = sec > 0 ? dUp / sec : 0;
      const down = sec > 0 ? (dDown + dBrowser) / sec : 0;
      dUp = 0;
      dDown = 0;
      dBrowser = 0;
      writeDay();
      return {
        at,
        radar: { up, down, upTotal: dayRec.radarUp, downTotal: dayRec.radarDown },
        device: devObs
          ? { up: devRates.up, down: devRates.down, upTotal: dayRec.devUp, downTotal: dayRec.devDown }
          : null,
        top: lastTop,
      };
    },
    watch(on) {
      watcherCount = Math.max(0, watcherCount + (on ? 1 : -1));
    },
    watchers() {
      return watcherCount;
    },
    start() {
      if (started) return;
      started = true;
      stopped = false;
      lastAt = now();
      loadDay();
      fireNetstat();
    },
    stop() {
      stopped = true;
      // Clear `started` too so a later start() re-arms the monitor.
      started = false;
      for (const child of live) child.kill("SIGKILL");
      live.clear();
    },
  };
}
