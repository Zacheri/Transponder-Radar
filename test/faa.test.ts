import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdir, mkdtemp, readFile, readdir, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  parseCsv,
  buildIndex,
  FaaLoader,
  STALENESS_GATE_MS,
  WEEKLY_KEEP,
  DAILY_KEEP,
  weekFriday,
  planDailyCleanup,
  planWeeklyCleanup,
} from "../server/faa.js";

function masterRow(n: string, code: string, year: string, name: string, city: string, state: string, hex: string): string {
  const f = new Array<string>(35).fill("");
  f[0] = n;
  f[2] = code;
  f[4] = year;
  f[6] = name;
  f[9] = city;
  f[10] = state;
  f[33] = hex;
  return f.join(",");
}

const MASTER = [
  "N-NUMBER,SERIAL NUMBER,MFR MDL CODE,ENG MFR MDL,YEAR MFR,TYPE REGISTRANT,NAME,STREET,STREET2,CITY,STATE,ZIP CODE,REGION,COUNTY,COUNTRY,LAST ACTION DATE,CERT ISSUE DATE,CERTIFICATION,TYPE AIRCRAFT,TYPE ENGINE,STATUS CODE,MODE S CODE,FRACT OWNER,AIR WORTH DATE,OTHER NAMES(1),OTHER NAMES(2),OTHER NAMES(3),OTHER NAMES(4),OTHER NAMES(5),EXPIRATION DATE,UNIQUE ID,KIT MFR, KIT MODEL,MODE S CODE HEX,",
  masterRow("100GX", "4500304", "2007", "BRULECREEK AVIATION LLC", "PARK CITY", "UT", "A00560"),
  masterRow("1234A", "9999999", "", "HIDDEN OWNER", "TULSA", "OK", "A1B2C3"),
  masterRow("5678B", "1382529", "2019", "", "DENVER", "CO", "DEADBEEF"),
].join("\n");

const REF = [
  "CODE,MFR,MODEL,TYPE-ACFT,TYPE-ENG,AC-CAT,BUILD-CERT-IND,NO-ENG,NO-SEATS,AC-WEIGHT,SPEED,TC-DATA-SHEET,TC-DATA-HOLDER,",
  "4500304,ISRAEL AIRCRAFT INDUSTRIES,GULFSTREAM G150,5,5,1,0,02,149,CLASS 3,0000,,",
  "1382529,BOEING,737-8DR,5,5,1,0,02,149,CLASS 3,0000,,",
].join("\n");

/** A second aircraft (hex C0FFEE) so a successful refresh is observable through lookup(). */
const MASTER_V2 = `${MASTER}\n${masterRow("999Z", "1382529", "2020", "SECOND ROW CO", "BOISE", "ID", "C0FFEE")}`;

// Minimal stored-entry zip writer (yauzl reads it; no deps).
const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function makeZip(files: Record<string, string>): Buffer {
  const DOS_TIME = 0;
  const DOS_DATE = ((2026 - 1980) << 9) | (11 << 5) | 1;
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const [name, text] of Object.entries(files)) {
    const data = Buffer.from(text, "utf8");
    const nm = Buffer.from(name, "utf8");
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(DOS_TIME, 10);
    local.writeUInt16LE(DOS_DATE, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nm.length, 26);
    locals.push(local, nm, data);
    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0);
    cd.writeUInt16LE(20, 4);
    cd.writeUInt16LE(20, 6);
    cd.writeUInt16LE(DOS_TIME, 12);
    cd.writeUInt16LE(DOS_DATE, 14);
    cd.writeUInt32LE(crc, 16);
    cd.writeUInt32LE(data.length, 20);
    cd.writeUInt32LE(data.length, 24);
    cd.writeUInt16LE(nm.length, 28);
    cd.writeUInt32LE(offset, 42);
    centrals.push(cd, nm);
    offset += local.length + nm.length + data.length;
  }
  const central = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(Object.keys(files).length, 8);
  eocd.writeUInt16LE(Object.keys(files).length, 10);
  eocd.writeUInt32LE(central.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, central, eocd]);
}

const HOUR = 3600000;
/** 2026-11: the 6th, 13th, 20th are Fridays; the 21st is a Saturday. Local midday. */
const at = (day: number) => new Date(2026, 10, day, 12).getTime();
const iso = (d: Date) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
const weeklyNames = (count: number) =>
  Array.from({ length: count }, (_, i) => {
    const d = new Date(2026, 10, 20);
    d.setDate(d.getDate() - 7 * i);
    return `ReleasableAircraft-${iso(d)}.zip`;
  });

describe("parseCsv", () => {
  it("handles BOM, padding, and quoted fields", () => {
    const rows = parseCsv('\ufeff"O\'BRIEN & SONS",  TULSA ,');
    expect(rows).toEqual([["O'BRIEN & SONS", "TULSA", ""]]);
  });
});

describe("buildIndex", () => {
  const idx = buildIndex(MASTER, REF);

  it("joins master + ref on MFR MDL CODE, keyed by lowercased hex", () => {
    expect(idx.get("a00560")).toEqual({
      nNumber: "N100GX",
      year: 2007,
      mfr: "ISRAEL AIRCRAFT INDUSTRIES",
      model: "GULFSTREAM G150",
      owner: "BRULECREEK AVIATION LLC",
      city: "PARK CITY",
      state: "UT",
    });
  });

  it("nulls missing year and unknown model code; keeps owner", () => {
    expect(idx.get("a1b2c3")).toEqual({
      nNumber: "N1234A",
      year: null,
      mfr: null,
      model: null,
      owner: "HIDDEN OWNER",
      city: "TULSA",
      state: "OK",
    });
  });

  it("nulls redacted owners (blank NAME)", () => {
    expect(idx.get("deadbeef")?.owner).toBeNull();
    expect(idx.get("deadbeef")?.model).toBe("737-8DR");
  });
});

describe("retention planning", () => {
  it("weekFriday anchors Friday -> Thursday weeks (local)", () => {
    expect(weekFriday(at(18))).toEqual(new Date(2026, 10, 13)); // Wed -> that week's Friday
    expect(weekFriday(at(20))).toEqual(new Date(2026, 10, 20)); // Fri -> itself
    expect(weekFriday(at(21))).toEqual(new Date(2026, 10, 20)); // Sat -> previous Friday
  });

  it("planWeeklyCleanup keeps the newest 52 and evicts older ones", () => {
    expect(planWeeklyCleanup(weeklyNames(WEEKLY_KEEP))).toEqual([]);
    expect(planWeeklyCleanup(weeklyNames(WEEKLY_KEEP + 1))).toEqual([weeklyNames(WEEKLY_KEEP + 1)[WEEKLY_KEEP]]);
  });

  it("planDailyCleanup keeps dailies through the week after the prior Friday, then purges", () => {
    const n03 = "ReleasableAircraft-2026-11-03.zip";
    const n06 = "ReleasableAircraft-2026-11-06.zip";
    const n12 = "ReleasableAircraft-2026-11-12.zip";
    const names = [n03, n06, n12];
    expect(planDailyCleanup(names, at(12))).toEqual([]); // Thu: 6 days past Nov 6 -> nothing dated before it goes
    expect(planDailyCleanup(names, at(13))).toEqual([n03]); // Fri: 7 days past Nov 6 -> pre-Nov-6 goes, Nov 6 stays
    expect(planDailyCleanup(names, at(19))).toEqual([]); // Thu: 6 days past Nov 13
    expect(planDailyCleanup(names, at(20)).sort()).toEqual([n03, n06, n12].sort()); // Fri: pre-Nov-13 goes
  });

  it("planDailyCleanup caps at 16 regardless of the Friday rule", () => {
    const names = Array.from(
      { length: DAILY_KEEP + 4 },
      (_, i) => `ReleasableAircraft-2026-11-${String(i + 1).padStart(2, "0")}.zip`,
    );
    const doomed = planDailyCleanup(names, at(21)); // Sat: prior Friday 1 day ago, so the cap alone bites
    expect(doomed.sort()).toEqual(names.slice(0, 4).sort());
  });
});

describe("FaaLoader", () => {
  let dir: string;
  let t: number;
  let fetchCalls: number;

  beforeEach(async () => {
    t = Date.now();
    fetchCalls = 0;
    dir = await mkdtemp(join(tmpdir(), "radar-faa-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const writeFiles = async (ageMs = 0) => {
    const when = new Date(t - ageMs);
    await writeFile(join(dir, "MASTER.txt"), MASTER);
    await writeFile(join(dir, "ACFTREF.txt"), REF);
    await utimes(join(dir, "MASTER.txt"), when, when);
    await utimes(join(dir, "ACFTREF.txt"), when, when);
  };

  const fakeFetch = (next: () => Buffer | Error) =>
    (async () => {
      fetchCalls++;
      const r = next();
      if (r instanceof Error) throw r;
      return {
        ok: true,
        status: 200,
        arrayBuffer: async () => r.buffer.slice(r.byteOffset, r.byteOffset + r.byteLength),
      } as unknown as Response;
    }) as unknown as typeof fetch;

  const zipV1 = makeZip({ "MASTER.txt": MASTER, "ACFTREF.txt": REF });
  const zipV2 = makeZip({ "MASTER.txt": MASTER_V2, "ACFTREF.txt": REF });

  it("loads fresh files from disk without fetching", async () => {
    await writeFiles(0);
    const loader = new FaaLoader({ dir, refreshMs: 3600000, now: () => t, fetchImpl: fakeFetch(() => new Error("no network in this test")) });
    await loader.init();
    expect(fetchCalls).toBe(0);
    expect(loader.status().state).toBe("ready");
    expect(loader.status().aircraft).toBe(3);
    expect(loader.lookup("a00560")?.nNumber).toBe("N100GX");
    loader.stop();
  });

  it("falls back to stale disk data when a refresh download fails", async () => {
    await writeFiles(STALENESS_GATE_MS + 60000);
    const loader = new FaaLoader({ dir, refreshMs: 3600000, now: () => t, fetchImpl: fakeFetch(() => new Error("net down")) });
    await loader.init();
    expect(loader.status().state).toBe("stale");
    expect(loader.lookup("a00560")?.nNumber).toBe("N100GX");
    loader.stop();
  });

  it("reports error when download fails and no disk data exists", async () => {
    const loader = new FaaLoader({ dir, refreshMs: 3600000, now: () => t, fetchImpl: fakeFetch(() => new Error("net down")) });
    await loader.init();
    expect(loader.status().state).toBe("error");
    expect(loader.status().lastError).toBe("net down");
    expect(loader.lookup("a00560")).toBeNull();
    loader.stop();
  });

  it("the staleness gate blocks a refresh until 24 h after the last success, then opens", async () => {
    t = at(20);
    await writeFiles(HOUR); // last download: Nov 20 11:00
    const loader = new FaaLoader({ dir, refreshMs: 3600000, now: () => t, fetchImpl: fakeFetch(() => new Error("net down")) });
    await loader.init();
    expect(fetchCalls).toBe(0); // fresh at init -> disk only
    expect(loader.status().state).toBe("ready");

    t = at(20) - HOUR + STALENESS_GATE_MS - 1; // 1 ms short of 24 h
    await loader.check();
    expect(fetchCalls).toBe(0);

    t += 1; // gate opens at exactly 24 h
    await loader.check();
    expect(fetchCalls).toBe(1);
    expect(loader.status().state).toBe("stale"); // download failed, disk still serves
    expect(loader.lookup("a00560")?.nNumber).toBe("N100GX");
    loader.stop();
  });

  it("a failed download serves the old index and does not retry until the next check respects the gate", async () => {
    t = at(20);
    await writeFiles(STALENESS_GATE_MS + 60000); // 25 h old -> gate open at init
    let fail = true;
    const loader = new FaaLoader({ dir, refreshMs: 3600000, now: () => t, fetchImpl: fakeFetch(() => (fail ? new Error("net down") : zipV2)) });
    await loader.init();
    expect(fetchCalls).toBe(1);
    expect(loader.status().state).toBe("stale");
    expect(loader.lookup("a00560")?.nNumber).toBe("N100GX");
    expect(loader.lookup("c0ffee")).toBeNull();

    await new Promise((r) => setTimeout(r, 50)); // timer interval is 1 h: no immediate retry happened
    expect(fetchCalls).toBe(1);

    fail = false;
    t += 4 * HOUR;
    await loader.check(); // next check: gate still open -> retry succeeds
    expect(fetchCalls).toBe(2);
    expect(loader.status().state).toBe("ready");
    expect(loader.lookup("c0ffee")?.nNumber).toBe("N999Z");

    t += HOUR; // success reset the gate: still only 1 h in
    await loader.check();
    expect(fetchCalls).toBe(2);
    loader.stop();
  });

  it("snapshots each Friday week once from the zip bytes, plus a daily copy", async () => {
    t = new Date(2026, 10, 18, 10).getTime(); // Wed
    let zip = zipV1;
    const loader = new FaaLoader({ dir, refreshMs: 3600000, now: () => t, fetchImpl: fakeFetch(() => zip) });
    await loader.init();
    expect(loader.status().state).toBe("ready");
    await expect(readFile(join(dir, "fridays", "ReleasableAircraft-2026-11-13.zip"))).resolves.toEqual(zipV1);
    await expect(readFile(join(dir, "dailies", "ReleasableAircraft-2026-11-18.zip"))).resolves.toEqual(zipV1);

    zip = zipV2;
    t = new Date(2026, 10, 21, 10).getTime(); // first download of a Saturday -> week anchored Fri Nov 20
    await loader.check();
    await expect(readFile(join(dir, "fridays", "ReleasableAircraft-2026-11-20.zip"))).resolves.toEqual(zipV2);
    await expect(readFile(join(dir, "fridays", "ReleasableAircraft-2026-11-13.zip"))).resolves.toEqual(zipV1); // one weekly per week
    await expect(readFile(join(dir, "dailies", "ReleasableAircraft-2026-11-21.zip"))).resolves.toEqual(zipV2);
    expect(await readdir(join(dir, "dailies"))).toHaveLength(2);
    loader.stop();
  });

  it("evicts the oldest weekly snapshot beyond 52", async () => {
    t = at(20);
    await writeFiles(HOUR);
    await mkdir(join(dir, "fridays"), { recursive: true });
    const names = weeklyNames(WEEKLY_KEEP + 1);
    for (const n of names) await writeFile(join(dir, "fridays", n), "x");
    const loader = new FaaLoader({ dir, refreshMs: 3600000, now: () => t, fetchImpl: fakeFetch(() => new Error("nope")) });
    await loader.init();
    const left = await readdir(join(dir, "fridays"));
    expect(left).toHaveLength(WEEKLY_KEEP);
    expect(left).not.toContain(names[WEEKLY_KEEP]); // oldest gone
    expect(left).toContain(names[0]); // newest kept
    loader.stop();
  });

  it("prunes old dailies at init", async () => {
    t = at(20); // Fri: dailies before last Friday (Nov 13) go
    await writeFiles(HOUR);
    await mkdir(join(dir, "dailies"), { recursive: true });
    const stale = "ReleasableAircraft-2026-11-03.zip";
    const kept = ["ReleasableAircraft-2026-11-13.zip", "ReleasableAircraft-2026-11-19.zip"];
    for (const n of [stale, ...kept]) await writeFile(join(dir, "dailies", n), "x");
    const loader = new FaaLoader({ dir, refreshMs: 3600000, now: () => t, fetchImpl: fakeFetch(() => new Error("nope")) });
    await loader.init();
    const left = await readdir(join(dir, "dailies"));
    expect(left).toHaveLength(kept.length);
    for (const n of kept) expect(left).toContain(n);
    expect(left).not.toContain(stale);
    loader.stop();
  });

  it("check timer fires additional downloads after init", async () => {
    const loader = new FaaLoader({ dir, refreshMs: 50, now: () => t, fetchImpl: fakeFetch(() => new Error("net down")) });
    await loader.init();
    await new Promise((r) => setTimeout(r, 150));
    expect(fetchCalls).toBeGreaterThanOrEqual(2); // no disk data -> gate open on every tick
    loader.stop();
  });

  it("reports error state when the data directory cannot be created", async () => {
    const blocker = join(dir, "blocker");
    await writeFile(blocker, "x");
    const loader = new FaaLoader({ dir: join(blocker, "sub"), refreshMs: 3600000, now: () => t, fetchImpl: fakeFetch(() => new Error("no network in this test")) });
    await expect(loader.init()).rejects.toThrow();
    expect(loader.status().state).toBe("error");
    expect(loader.status().lastError).not.toBeNull();
    expect(loader.lookup("a00560")).toBeNull();
    loader.stop();
  });
});
