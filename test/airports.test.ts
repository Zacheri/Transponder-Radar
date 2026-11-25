import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAirports } from "../server/airports.js";

// Fixture: a REAL head-slice of the pinned airports.dat (URL + full-file
// sha256 pinned in server/airports.ts), captured 2026-11-21 via
// `curl -sL <url> -o f && head -c 4000 f`, then trimmed back to the last
// newline so every line is a complete CSV row (OpenFlights ids 1–26).
// The slice's own sha256 (used by the download test) is eeaef4f180a3e2313db52c04ff6e3c447bf1a774d5198780a3e5dbe1bf0ebc29.
const FIXTURE_URL = new URL("./fixtures/airports-sample.dat", import.meta.url);

const sha256 = (bytes: Uint8Array | string): string =>
  createHash("sha256").update(bytes).digest("hex");

// Hand-noted expected records from the fixture slice (row 1, row 16, row 22).
const GOROKA = {
  icao: "AYGA",
  iata: "GKA",
  name: "Goroka Airport",
  city: "Goroka",
  country: "Papua New Guinea",
  lat: -6.081689834590001,
  lon: 145.391998291,
};

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "airports-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const fetcher = (impl: (url: string) => Promise<Response>) => impl as unknown as typeof fetch;

describe("createAirports — init from an existing file", () => {
  it("loads the fixture and looks airports up by ICAO and IATA", async () => {
    await writeFile(join(dir, "airports.dat"), await readFile(FIXTURE_URL));
    const a = createAirports({ dir });
    await a.init();

    expect(a.status()).toEqual({ loaded: true, count: 26, lastError: null });
    expect(a.lookup("AYGA")).toEqual(GOROKA);
    expect(a.lookup("GKA")).toEqual(GOROKA);
    expect(a.lookup("BIKF")?.name).toBe("Keflavik International Airport");
    expect(a.lookup("KEF")?.name).toBe("Keflavik International Airport");
  });

  it("normalizes lookups by trim + uppercase", async () => {
    await writeFile(join(dir, "airports.dat"), await readFile(FIXTURE_URL));
    const a = createAirports({ dir });
    await a.init();

    expect(a.lookup("  gKa ")).toEqual(GOROKA);
    expect(a.lookup("ayga\t")).toEqual(GOROKA);
  });

  it("misses return null", async () => {
    await writeFile(join(dir, "airports.dat"), await readFile(FIXTURE_URL));
    const a = createAirports({ dir });
    await a.init();

    expect(a.lookup("ZZZZ")).toBeNull();
    expect(a.lookup("")).toBeNull();
    expect(a.lookup("   ")).toBeNull();
  });

  it("treats \\N IATA as absent but keeps the row under its ICAO", async () => {
    await writeFile(join(dir, "airports.dat"), await readFile(FIXTURE_URL));
    const a = createAirports({ dir });
    await a.init();

    const winnipeg = a.lookup("CYAV");
    expect(winnipeg).not.toBeNull();
    expect(winnipeg?.iata).toBeNull();
    expect(winnipeg?.name).toBe("Winnipeg / St. Andrews Airport");
  });

  it("keeps rows whose type is blank or 'airport' and drops the rest", async () => {
    // In the real 14-column row the type column is index 12 (every row of
    // the pinned file is "airport"); blank/\N and "airport" are kept, other
    // OpenFlights row types (rail/ferry "station") are dropped.
    const extra = [
      `27,"Rail Station","Town","Land",\\N,"ZZZA",1,2,0,0,"U","X","station","OurAirports"`,
      `28,"Blank Type Airport","Nowhere","Land",\\N,"ZZZB",3,4,0,0,"U","X",\\N,"OurAirports"`,
      `29,"Quoted Blank","","",\\N,"ZZZC",5,6,0,0,"U","X","","OurAirports"`,
    ].join("\n");
    await writeFile(join(dir, "airports.dat"), `${await readFile(FIXTURE_URL, "utf8")}${extra}\n`);
    const a = createAirports({ dir });
    await a.init();

    expect(a.lookup("ZZZA")).toBeNull();
    expect(a.lookup("ZZZB")?.name).toBe("Blank Type Airport");
    expect(a.lookup("ZZZC")?.name).toBe("Quoted Blank");
  });

  it("drops rows whose coordinates are blank or non-numeric", async () => {
    // Guards against Number("")===0 sneaking a (0,0) airport into the map.
    const extra = [
      `27,"No Coords","Nowhere","Land",\\N,"ZZZA",,,0,0,"U","X","airport","OurAirports"`,
      `28,"Bad Coords","Nowhere","Land",\\N,"ZZZB","x","y",0,0,"U","X","airport","OurAirports"`,
    ].join("\n");
    await writeFile(join(dir, "airports.dat"), `${await readFile(FIXTURE_URL, "utf8")}${extra}\n`);
    const a = createAirports({ dir });
    await a.init();

    expect(a.lookup("ZZZA")).toBeNull();
    expect(a.lookup("ZZZB")).toBeNull();
  });

  it("ICAO collisions keep the first row; ICAO beats an IATA collision", async () => {
    const extra = [
      `27,"First Same Icao","A","L",\\N,"ZZZA",1,2,0,0,"U","X","airport","OurAirports"`,
      `28,"Second Same Icao","B","L","ZZZA","ZZZA",3,4,0,0,"U","X","airport","OurAirports"`,
      `29,"Iata Hitting Icao","C","L",\\N,"ZZZB",5,6,0,0,"U","X","airport","OurAirports"`,
      `30,"Owner Of Abc","D","L","ZZZA",\\N,7,8,0,0,"U","X","airport","OurAirports"`,
    ].join("\n");
    await writeFile(join(dir, "airports.dat"), `${await readFile(FIXTURE_URL, "utf8")}${extra}\n`);
    const a = createAirports({ dir });
    await a.init();

    expect(a.lookup("ZZZA")?.name).toBe("First Same Icao");
    expect(a.lookup("ZZZB")?.name).toBe("Iata Hitting Icao");
  });
});

describe("createAirports — first-start download", () => {
  it("downloads once, verifies sha256, writes file + attribution", async () => {
    const bytes = await readFile(FIXTURE_URL);
    let requested = "";
    const a = createAirports({
      dir,
      url: "https://example.test/airports.dat",
      sha256: sha256(bytes),
      fetchImpl: fetcher(async (url) => {
        requested = url;
        return new Response(bytes);
      }),
    });
    await a.init();

    expect(requested).toBe("https://example.test/airports.dat");
    expect(a.status().loaded).toBe(true);
    expect(a.lookup("AYGA")).toEqual(GOROKA);
    expect(await readFile(join(dir, "airports.dat"))).toEqual(bytes);
    const attribution = await readFile(join(dir, "ATTRIBUTION.md"), "utf8");
    expect(attribution).toContain("ODbL");
    expect(attribution).toContain("openflights");
  });

  it("does not re-download when the file already exists", async () => {
    let calls = 0;
    await writeFile(join(dir, "airports.dat"), await readFile(FIXTURE_URL));
    const a = createAirports({
      dir,
      fetchImpl: fetcher(async () => {
        calls++;
        return new Response("nope");
      }),
    });
    await a.init();
    expect(calls).toBe(0);
    expect(a.status().loaded).toBe(true);
  });

  it("sha256 mismatch: loaded false, lastError set, no file written, no throw", async () => {
    const a = createAirports({
      dir,
      sha256: "0".repeat(64),
      fetchImpl: fetcher(async () => new Response(await readFile(FIXTURE_URL))),
    });
    await a.init();

    expect(a.status().loaded).toBe(false);
    expect(a.status().lastError).toContain("sha256");
    expect(a.lookup("AYGA")).toBeNull();
    await expect(readFile(join(dir, "airports.dat"), "utf8")).rejects.toThrow();
  });

  it("404: loaded false, lastError set, no throw", async () => {
    const a = createAirports({
      dir,
      fetchImpl: fetcher(async () => new Response("nope", { status: 404 })),
    });
    await a.init();

    expect(a.status().loaded).toBe(false);
    expect(a.status().lastError).toContain("404");
    expect(a.lookup("AYGA")).toBeNull();
  });

  it("network error: loaded false, lastError set, no throw", async () => {
    const a = createAirports({
      dir,
      fetchImpl: fetcher(async () => {
        throw new Error("boom");
      }),
    });
    await a.init();

    expect(a.status().loaded).toBe(false);
    expect(a.status().lastError).toContain("boom");
  });

  it("empty map before init: lookups are null, status not loaded", () => {
    const a = createAirports({ dir });
    expect(a.lookup("AYGA")).toBeNull();
    expect(a.status()).toEqual({ loaded: false, count: 0, lastError: null });
  });
});

describe("createAirports — traffic counting", () => {
  it("counts download bytes once sha256 verification passes", async () => {
    const bytes = await readFile(FIXTURE_URL);
    const counted: number[] = [];
    const a = createAirports({
      dir,
      sha256: sha256(bytes),
      fetchImpl: fetcher(async () => new Response(bytes)),
      traffic: { count: (_dir, n) => counted.push(n) },
    });
    await a.init();
    expect(counted).toEqual([bytes.length]);
  });

  it("counts nothing when the sha256 check fails", async () => {
    const counted: number[] = [];
    const a = createAirports({
      dir,
      sha256: "0".repeat(64),
      fetchImpl: fetcher(async () => new Response(await readFile(FIXTURE_URL))),
      traffic: { count: (_dir, n) => counted.push(n) },
    });
    await a.init();
    expect(a.status().loaded).toBe(false);
    expect(counted).toEqual([]);
  });
});
