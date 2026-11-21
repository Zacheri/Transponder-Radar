import { createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { parseCsv } from "./faa.js";

export interface Airport {
  icao: string | null;
  iata: string | null;
  name: string;
  city: string | null;
  country: string | null;
  lat: number;
  lon: number;
}

export interface AirportsStatus {
  loaded: boolean;
  count: number; // distinct airport records parsed
  lastError: string | null;
}

export interface Airports {
  init(): Promise<void>;
  lookup(code: string): Airport | null;
  status(): AirportsStatus;
}

export interface AirportsOpts {
  dir: string;
  fetchImpl?: typeof fetch;
  log?: (m: string) => void;
  url?: string;
  sha256?: string;
}

// Pin: OpenFlights airports.dat (GitHub raw, master), fetched 2026-11-21;
// sha256 of the full 7,698-row file (computed with `shasum -a 256`).
// One-time download into <dir>; an existing file is never re-verified.
const AIRPORTS_URL = "https://raw.githubusercontent.com/jpatokal/openflights/master/data/airports.dat";
const AIRPORTS_SHA256 = "9387cdb38df5bd664da823f8ccb69fdd9b33a1888f5b7cca09c34a3cd9ff59f9";

const FILE_NAME = "airports.dat";
const NULL_MARKER = "\\N";

// Columns (0-based) of the 14-field OpenFlights row; the type column (12)
// is "airport" for every row of the pinned file — other OpenFlights exports
// add "station" (rail/ferry) rows, so anything non-blank and non-airport
// is dropped.
const COL_NAME = 1;
const COL_CITY = 2;
const COL_COUNTRY = 3;
const COL_IATA = 4;
const COL_ICAO = 5;
const COL_LAT = 6;
const COL_LON = 7;
const COL_TYPE = 12;

const ATTRIBUTION = [
  "# airports.dat",
  "",
  "OpenFlights airports database (`airports.dat`), licensed ODbL 1.0.",
  "Source: https://openflights.org/data.html",
  "",
].join("\n");

function cell(v: string | undefined): string | null {
  const s = (v ?? "").trim();
  return s === "" || s === NULL_MARKER ? null : s;
}

export function parseAirports(text: string): Airport[] {
  const list: Airport[] = [];
  for (const r of parseCsv(text)) {
    const type = cell(r[COL_TYPE])?.toUpperCase() ?? "";
    if (type !== "" && type !== "AIRPORT") continue;
    const latRaw = cell(r[COL_LAT]);
    const lonRaw = cell(r[COL_LON]);
    if (latRaw === null || lonRaw === null) continue;
    const lat = Number(latRaw);
    const lon = Number(lonRaw);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
    const icao = cell(r[COL_ICAO])?.toUpperCase() ?? null;
    const iata = cell(r[COL_IATA])?.toUpperCase() ?? null;
    if (!icao && !iata) continue;
    list.push({ icao, iata, name: r[COL_NAME] ?? "", city: cell(r[COL_CITY]), country: cell(r[COL_COUNTRY]), lat, lon });
  }
  return list;
}

/** Keyed by ICAO and IATA (uppercase). ICAO first-wins; ICAO beats IATA. */
export function buildAirportMap(list: Airport[]): Map<string, Airport> {
  const map = new Map<string, Airport>();
  for (const a of list) if (a.icao && !map.has(a.icao)) map.set(a.icao, a);
  for (const a of list) if (a.iata && !map.has(a.iata)) map.set(a.iata, a);
  return map;
}

export function createAirports(opts: AirportsOpts): Airports {
  const url = opts.url ?? AIRPORTS_URL;
  const sha256 = opts.sha256 ?? AIRPORTS_SHA256;
  const log = opts.log ?? (() => {});
  let map = new Map<string, Airport>();
  let loaded = false;
  let count = 0;
  let lastError: string | null = null;

  async function download(): Promise<void> {
    const fetchImpl = opts.fetchImpl ?? fetch;
    const res = await fetchImpl(url);
    if (!res.ok) throw new Error(`airports: HTTP ${res.status} from ${url}`);
    const bytes = Buffer.from(await res.arrayBuffer());
    const got = createHash("sha256").update(bytes).digest("hex");
    if (got !== sha256) throw new Error(`airports: sha256 mismatch: expected ${sha256}, got ${got}`);
    await mkdir(opts.dir, { recursive: true });
    const tmp = join(opts.dir, `${FILE_NAME}.tmp`);
    await writeFile(tmp, bytes);
    await rename(tmp, join(opts.dir, FILE_NAME));
    await writeFile(join(opts.dir, "ATTRIBUTION.md"), ATTRIBUTION);
  }

  return {
    async init(): Promise<void> {
      try {
        const file = join(opts.dir, FILE_NAME);
        let text: string;
        try {
          text = await readFile(file, "utf8");
        } catch {
          log("airports: cache missing, downloading");
          await download();
          text = await readFile(file, "utf8");
        }
        const list = parseAirports(text);
        map = buildAirportMap(list);
        count = list.length;
        loaded = true;
        lastError = null;
        log(`airports: loaded ${count} airports (${map.size} codes)`);
      } catch (e) {
        map = new Map();
        loaded = false;
        count = 0;
        lastError = e instanceof Error ? e.message : String(e);
        log(`airports: ${lastError}`);
      }
    },
    lookup(code: string): Airport | null {
      const key = code.trim().toUpperCase();
      return key === "" ? null : map.get(key) ?? null;
    },
    status(): AirportsStatus {
      return { loaded, count, lastError };
    },
  };
}
