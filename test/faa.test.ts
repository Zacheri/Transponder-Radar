import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseCsv, buildIndex, FaaLoader, FRESHNESS_MS } from "../server/faa.js";

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
    await writeFile(join(dir, "MASTER.txt"), MASTER);
    await writeFile(join(dir, "ACFTREF.txt"), REF);
    if (ageMs > 0) {
      const when = new Date(t - ageMs);
      await utimes(join(dir, "MASTER.txt"), when, when);
      await utimes(join(dir, "ACFTREF.txt"), when, when);
    }
  };

  it("loads fresh files from disk without fetching", async () => {
    await writeFiles(0);
    const loader = new FaaLoader({ dir, refreshMs: 3600000, now: () => t, fetchImpl: (async () => { fetchCalls++; throw new Error("no network in this test"); }) as typeof fetch });
    await loader.init();
    expect(fetchCalls).toBe(0);
    expect(loader.status().state).toBe("ready");
    expect(loader.status().aircraft).toBe(3);
    expect(loader.lookup("a00560")?.nNumber).toBe("N100GX");
    loader.stop();
  });

  it("falls back to stale disk data when a refresh download fails", async () => {
    await writeFiles(FRESHNESS_MS + 60000);
    const loader = new FaaLoader({ dir, refreshMs: 3600000, now: () => t, fetchImpl: (async () => { fetchCalls++; throw new Error("net down"); }) as typeof fetch });
    await loader.init();
    expect(loader.status().state).toBe("stale");
    expect(loader.lookup("a00560")?.nNumber).toBe("N100GX");
    loader.stop();
  });

  it("reports error when download fails and no disk data exists", async () => {
    const loader = new FaaLoader({ dir, refreshMs: 3600000, now: () => t, fetchImpl: (async () => { fetchCalls++; throw new Error("net down"); }) as typeof fetch });
    await loader.init();
    expect(loader.status().state).toBe("error");
    expect(loader.status().lastError).toBe("net down");
    expect(loader.lookup("a00560")).toBeNull();
    loader.stop();
  });

  it("refresh timer fires additional refreshes after init", async () => {
    const loader = new FaaLoader({ dir, refreshMs: 50, now: () => t, fetchImpl: (async () => { fetchCalls++; throw new Error("net down"); }) as typeof fetch });
    await loader.init();
    await new Promise((r) => setTimeout(r, 150));
    expect(fetchCalls).toBeGreaterThanOrEqual(2);
    loader.stop();
  });

  it("reports error state when the data directory cannot be created", async () => {
    const blocker = join(dir, "blocker");
    await writeFile(blocker, "x");
    const loader = new FaaLoader({ dir: join(blocker, "sub"), refreshMs: 3600000, now: () => t, fetchImpl: (async () => { throw new Error("no network in this test"); }) as typeof fetch });
    await expect(loader.init()).rejects.toThrow();
    expect(loader.status().state).toBe("error");
    expect(loader.status().lastError).not.toBeNull();
    expect(loader.lookup("a00560")).toBeNull();
    loader.stop();
  });
});
