# Live Transponder Map — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a local, browser-based live world map of aircraft (ADS-B via OpenSky) and vessels (AIS via aisstream.io) with per-kind icons, a click-to-open detail panel, and a kind filter drawer.

**Architecture:** A single Node backend (Fastify + `ws`) owns both feeds, normalizes them into one `Craft` model, keeps an in-memory store, and pushes a snapshot + batched deltas to the browser over WebSocket. The browser (Vite + vanilla TS + MapLibre GL JS) renders all craft as a GeoJSON source with data-driven icon/label layers, a detail panel, and a filter drawer. A shared `shared/craft.ts` is imported by both sides.

**Tech Stack:** Node 18+, TypeScript (strict), Fastify 4, `@fastify/websocket`, `ws`, `dotenv`, Vite 5, MapLibre GL JS 4, Vitest, tsx, concurrently.

**Spec:** `docs/superpowers/specs/2026-09-27-transponder-map-design.md`

## Global Constraints

- **ESM everywhere:** `package.json` has `"type": "module"`. All relative imports in `server/`, `shared/`, and `test/` use explicit `.js` extensions (Node/tsx ESM). `src/` (Vite) imports may omit extensions.
- **TypeScript strict:** `tsconfig.json` has `strict: true`; `npm run typecheck` (`tsc --noEmit`) must pass before any commit.
- **Ports:** backend `8787`, Vite dev `5173` (Vite proxies `/ws` + `/health` → `8787`).
- **Thresholds (exact):** `STALE_MS = 120000`, `REMOVE_MS = 600000`, `OPENSKY_POLL_MS = 5000`, `BATCH_MS = 1000`, air fast-path grace `30000` ms.
- **Unit conversions (exact):** m/s→knots `×1.94384`; m→ft `×3.28084`; m/s→fpm `×196.850`.
- **Stable IDs:** air = `icao24` (hex string); sea = `MMSI` (decimal string).
- **Secrets:** `AISSTREAM_API_KEY` lives only in `.env` (git-ignored). Never import it into `src/`.
- **14 craft kinds** (exact): air `commercial, business, military, general`; sea `cargo, tanker, passenger, military_vessel, fishing, sailing, pleasure, tug_work, service, other`.
- **Graceful degradation:** a dead feed never crashes the process; it dims (stale) then empties, with a HUD warning.
- **Run mode (primary, tested):** `npm run dev` (concurrently: backend `:8787` + Vite `:5173`). `npm run build` (→ `dist/`) and `npm start` (backend API + WS on `:8787`) are provided; the built frontend is NOT auto-served (out of scope for this local tool) — the dev flow is the verified deliverable.
- **Commit style:** conventional commits (`feat:`, `test:`, `chore:`, `docs:`).

---

## File Structure

```
Radar/
  package.json              ESM, scripts, deps
  tsconfig.json             strict, ES2022 + DOM + node types
  vite.config.ts            dev proxy + vitest config
  .env.example              AISSTREAM_API_KEY + tuning knobs
  index.html                Vite entry (created Task 12)
  shared/
    craft.ts                Craft, CraftKind, Domain, KINDS, AIR/SEA_KINDS  (Task 1)
  server/
    config.ts               env loading                                  (Task 1)
    classify.ts             classifyAir / classifySea (pure)             (Tasks 2,3)
    normalize.ts            normalizeOpenSky / normalizeAis (pure)       (Tasks 4,5)
    store.ts                CraftStore (in-memory + dirty set)           (Task 6)
    opensky.ts              OpenSkyPoller                                (Task 7)
    ais.ts                  AisClient (aisstream.io WS)                  (Task 8)
    hub.ts                  Hub (browser WS snapshot/update)             (Task 9)
    index.ts                bootstrap: fastify + ws + pollers + sweeper  (Task 10)
  src/
    main.ts                 bootstrap wiring (built up Tasks 12-18)
    style.css               base styles
    map/
      map.ts                map init + Carto dark basemap                (Task 12)
      icons.ts              register 14 per-kind SVGs                    (Task 12)
      layers.ts             craft source + icon/label layers + zoom      (Task 13)
    data/
      store.ts              ClientStore                                  (Task 11)
      ws.ts                 RadarSocket (WS client + reconnect)          (Task 11)
      features.ts           buildFeatureCollection (pure)                (Task 11)
      filter.ts             buildIconFilter (pure)                       (Task 11)
    ui/
      panel.ts              detail panel                                 (Task 15)
      filters.ts            filter drawer                                (Task 16)
      hud.ts                status HUD + reconnect banner                (Task 17)
    assets/icons/*.svg      14 hand-authored icons                       (Task 12)
  test/
    classify.test.ts        classifySea + classifyAir                    (Tasks 2,3)
    normalize.test.ts       normalizeOpenSky + normalizeAis              (Tasks 4,5)
    store.test.ts           CraftStore + ClientStore                     (Tasks 6,11)
    features.test.ts        buildFeatureCollection + buildIconFilter     (Task 11)
    poller.test.ts          OpenSkyPoller vs local HTTP stub             (Task 7)
    ais.test.ts             AisClient vs local WS stub                   (Task 8)
    hub.test.ts             Hub snapshot + broadcast                     (Task 9)
    integration.test.ts     full pipeline (stub feeds → hub)             (Task 10)
```

---

# Phase A — Backend (Node.js)

### Task 1: Scaffolding + shared Craft model

**Files:**
- Create: `package.json`, `tsconfig.json`, `vite.config.ts`, `.env.example`, `shared/craft.ts`, `server/config.ts`
- Test: (none yet — verified by typecheck)

**Interfaces:**
- Produces:
  - `shared/craft.ts`: `type Domain = "air" | "sea"`; `type CraftKind` (14 members); `interface Craft`; `interface KindMeta { label, domain, icon, color }`; `const KINDS: Record<CraftKind, KindMeta>`; `const AIR_KINDS: CraftKind[]`; `const SEA_KINDS: CraftKind[]`.
  - `server/config.ts`: `const config: { PORT, OPENSKY_POLL_MS, BATCH_MS, STALE_MS, REMOVE_MS: number; AISSTREAM_API_KEY: string }`.

`Craft` fields (exact): `id: string; domain: Domain; kind: CraftKind; lat: number; lon: number; speed: number | null; heading: number | null; callsign?: string; altitude?: number | null; verticalRate?: number | null; squawk?: string | null; onGround?: boolean; spi?: boolean; originCountry?: string; shipName?: string; imo?: number | null; callSign?: string; destination?: string; navStatus?: number | null; aisType?: number | null; updatedAt: number; stale: boolean`.

- [ ] **Step 1: Write `package.json`**

```json
{
  "name": "transponder-radar",
  "private": true,
  "version": "0.1.0",
  "type": "module",
  "scripts": {
    "dev": "concurrently -n server,web -c blue,green \"npm:dev:server\" \"npm:dev:web\"",
    "dev:server": "tsx watch server/index.ts",
    "dev:web": "vite",
    "build": "vite build",
    "start": "NODE_ENV=production tsx server/index.ts",
    "test": "vitest run",
    "test:watch": "vitest",
    "typecheck": "tsc --noEmit",
    "lint": "eslint .",
    "format": "prettier --write ."
  },
  "dependencies": {
    "@fastify/static": "^7.0.4",
    "@fastify/websocket": "^10.0.1",
    "dotenv": "^16.4.5",
    "fastify": "^4.28.1",
    "maplibre-gl": "^4.5.2",
    "ws": "^8.18.0"
  },
  "devDependencies": {
    "@types/node": "^20.14.10",
    "@types/ws": "^8.5.10",
    "concurrently": "^8.2.2",
    "eslint": "^9.6.0",
    "prettier": "^3.3.2",
    "tsx": "^4.16.2",
    "typescript": "^5.5.3",
    "vite": "^5.3.3",
    "vitest": "^2.0.2"
  }
}
```

- [ ] **Step 2: Write `tsconfig.json`**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "lib": ["ES2022", "DOM", "DOM.Iterable"],
    "types": ["node", "vite/client"],
    "strict": true,
    "noUnusedLocals": true,
    "noUnusedParameters": true,
    "noFallthroughCasesInSwitch": true,
    "forceConsistentCasingInFileNames": true,
    "skipLibCheck": true,
    "noEmit": true,
    "resolveJsonModule": true,
    "isolatedModules": true
  },
  "include": ["shared", "server", "src", "test"]
}
```

- [ ] **Step 3: Write `vite.config.ts`**

```ts
import { defineConfig } from "vitest/config";

export default defineConfig({
  server: {
    port: 5173,
    proxy: {
      "/ws": { target: "ws://127.0.0.1:8787", ws: true },
      "/health": { target: "http://127.0.0.1:8787" },
    },
  },
  test: {
    environment: "node",
    include: ["test/**/*.test.ts"],
  },
});
```

- [ ] **Step 4: Write `.env.example`**

```
# Free key from https://aisstream.io/account (GitHub sign-in). Shown once.
AISSTREAM_API_KEY=
PORT=8787
OPENSKY_POLL_MS=5000
BATCH_MS=1000
STALE_MS=120000
REMOVE_MS=600000
```

- [ ] **Step 5: Write `shared/craft.ts`**

```ts
export type Domain = "air" | "sea";

export type CraftKind =
  | "commercial"
  | "business"
  | "military"
  | "general"
  | "cargo"
  | "tanker"
  | "passenger"
  | "military_vessel"
  | "fishing"
  | "sailing"
  | "pleasure"
  | "tug_work"
  | "service"
  | "other";

export interface Craft {
  id: string;
  domain: Domain;
  kind: CraftKind;
  lat: number;
  lon: number;
  speed: number | null;
  heading: number | null;
  // air (OpenSky)
  callsign?: string;
  altitude?: number | null;
  verticalRate?: number | null;
  squawk?: string | null;
  onGround?: boolean;
  spi?: boolean;
  originCountry?: string;
  // sea (aisstream.io)
  shipName?: string;
  imo?: number | null;
  callSign?: string;
  destination?: string;
  navStatus?: number | null;
  aisType?: number | null;
  updatedAt: number;
  stale: boolean;
}

export interface KindMeta {
  label: string;
  domain: Domain;
  icon: string; // MapLibre image name (=== kind, 1:1)
  color: string; // fallback dot color
}

export const KINDS: Record<CraftKind, KindMeta> = {
  commercial: { label: "Commercial", domain: "air", icon: "commercial", color: "#4fc3f7" },
  business: { label: "Business", domain: "air", icon: "business", color: "#81d4fa" },
  military: { label: "Military", domain: "air", icon: "military", color: "#ef5350" },
  general: { label: "General", domain: "air", icon: "general", color: "#90a4ae" },
  cargo: { label: "Cargo", domain: "sea", icon: "cargo", color: "#ffb74d" },
  tanker: { label: "Tanker", domain: "sea", icon: "tanker", color: "#ff8a65" },
  passenger: { label: "Passenger", domain: "sea", icon: "passenger", color: "#4dd0e1" },
  military_vessel: { label: "Military", domain: "sea", icon: "military_vessel", color: "#e57373" },
  fishing: { label: "Fishing", domain: "sea", icon: "fishing", color: "#aed581" },
  sailing: { label: "Sailing", domain: "sea", icon: "sailing", color: "#ba68c8" },
  pleasure: { label: "Pleasure", domain: "sea", icon: "pleasure", color: "#f06292" },
  tug_work: { label: "Tug / Work", domain: "sea", icon: "tug_work", color: "#fff176" },
  service: { label: "Service", domain: "sea", icon: "service", color: "#a1887f" },
  other: { label: "Other", domain: "sea", icon: "other", color: "#b0bec5" },
};

export const AIR_KINDS: CraftKind[] = ["commercial", "business", "military", "general"];
export const SEA_KINDS: CraftKind[] = [
  "cargo",
  "tanker",
  "passenger",
  "military_vessel",
  "fishing",
  "sailing",
  "pleasure",
  "tug_work",
  "service",
  "other",
];
```

- [ ] **Step 6: Write `server/config.ts`**

```ts
import "dotenv/config";

function int(name: string, def: number): number {
  const v = process.env[name];
  const n = v ? Number(v) : NaN;
  return Number.isFinite(n) ? n : def;
}

export const config = {
  PORT: int("PORT", 8787),
  OPENSKY_POLL_MS: int("OPENSKY_POLL_MS", 5000),
  BATCH_MS: int("BATCH_MS", 1000),
  STALE_MS: int("STALE_MS", 120000),
  REMOVE_MS: int("REMOVE_MS", 600000),
  AISSTREAM_API_KEY: process.env.AISSTREAM_API_KEY ?? "",
};
```

- [ ] **Step 7: Install dependencies**

Run: `npm install`
Expected: completes, `node_modules/` created, no peer-dep errors.

- [ ] **Step 8: Typecheck**

Run: `npm run typecheck`
Expected: PASS (no errors).

- [ ] **Step 9: Commit**

```bash
git add package.json tsconfig.json vite.config.ts .env.example shared/craft.ts server/config.ts package-lock.json
git commit -m "chore: scaffold ESM TS project + shared Craft model"
```

---

### Task 2: classifySea (AIS vessel-type → kind)

**Files:**
- Create: `server/classify.ts`
- Test: `test/classify.test.ts`

**Interfaces:**
- Consumes: `CraftKind` from `shared/craft.js`.
- Produces: `function classifySea(aisType: number | null | undefined): CraftKind`.

- [ ] **Step 1: Write the failing test**

Create `test/classify.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { classifySea } from "../server/classify.js";

describe("classifySea", () => {
  it("maps each AIS code bucket to the right kind", () => {
    const cases: Array<[number, string]> = [
      [70, "cargo"], [79, "cargo"],
      [80, "tanker"], [86, "tanker"],
      [44, "passenger"], [47, "passenger"], [60, "passenger"], [63, "passenger"],
      [30, "military_vessel"], [54, "military_vessel"], [57, "military_vessel"],
      [32, "fishing"],
      [31, "sailing"], [36, "sailing"],
      [37, "pleasure"],
      [33, "tug_work"], [35, "tug_work"], [50, "tug_work"], [52, "tug_work"], [59, "tug_work"],
      [38, "service"], [43, "service"], [53, "service"], [56, "service"], [58, "service"],
      [0, "other"], [90, "other"], [99, "other"],
    ];
    for (const [code, kind] of cases) expect(classifySea(code), `code ${code}`).toBe(kind);
  });

  it("returns other for null/undefined", () => {
    expect(classifySea(null)).toBe("other");
    expect(classifySea(undefined)).toBe("other");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/classify.test.ts`
Expected: FAIL — `Cannot find module '../server/classify.js'` (or `classifySea is not a function`).

- [ ] **Step 3: Write minimal implementation**

Create `server/classify.ts`:

```ts
import type { CraftKind } from "../shared/craft.js";

export function classifySea(aisType: number | null | undefined): CraftKind {
  if (aisType == null) return "other";
  const t = aisType;
  if (t >= 70 && t <= 79) return "cargo";
  if (t >= 80 && t <= 86) return "tanker";
  if ((t >= 44 && t <= 47) || (t >= 60 && t <= 63)) return "passenger";
  if (t === 30 || t === 54 || t === 57) return "military_vessel";
  if (t === 32) return "fishing";
  if (t === 31 || t === 36) return "sailing";
  if (t === 37) return "pleasure";
  if (t === 33 || t === 34 || t === 35 || t === 50 || t === 51 || t === 52 || t === 59) return "tug_work";
  if (t === 38 || t === 39 || t === 40 || t === 41 || t === 42 || t === 43 || t === 53 || t === 55 || t === 56 || t === 58) return "service";
  return "other";
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/classify.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/classify.ts test/classify.test.ts
git commit -m "feat: classifySea maps AIS vessel-type codes to craft kind"
```

---

### Task 3: classifyAir (callsign + SPI → kind)

**Files:**
- Modify: `server/classify.ts`
- Test: `test/classify.test.ts` (append)

**Interfaces:**
- Consumes: `CraftKind` from `shared/craft.js`.
- Produces: `function classifyAir(input: { callsign?: string; spi?: boolean }): CraftKind`.

- [ ] **Step 1: Write the failing test**

Append to `test/classify.test.ts`:

```ts
import { classifyAir } from "../server/classify.js";

describe("classifyAir", () => {
  it("SPI flag → military regardless of callsign", () => {
    expect(classifyAir({ spi: true, callsign: "WHATEVER" })).toBe("military");
  });

  it("airline designator + number → commercial", () => {
    for (const cs of ["DAL539", "AAL2174", "UAL1716", "BAW123", "UAE24"]) {
      expect(classifyAir({ callsign: cs }), cs).toBe("commercial");
    }
  });

  it("US N-number → business", () => {
    for (const cs of ["N759SG", "N123AB", "N4567"]) {
      expect(classifyAir({ callsign: cs }), cs).toBe("business");
    }
  });

  it("known biz-jet prefix → business", () => {
    for (const cs of ["EJA123", "GTF456", "LEG789", "RJS101", "FGE202"]) {
      expect(classifyAir({ callsign: cs }), cs).toBe("business");
    }
  });

  it("military callsign pattern → military", () => {
    for (const cs of ["USAF700", "NATOLIFT", "REAPER1"]) {
      expect(classifyAir({ callsign: cs }), cs).toBe("military");
    }
  });

  it("everything else → general", () => {
    for (const cs of ["HELLO", "", undefined]) {
      expect(classifyAir({ callsign: cs }), String(cs)).toBe("general");
    }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/classify.test.ts`
Expected: FAIL — `classifyAir is not a function`.

- [ ] **Step 3: Write minimal implementation**

Append to `server/classify.ts`:

```ts
const BIZ_PREFIXES = new Set([
  "EJA", "GTF", "LEG", "RJS", "FGE", "N7B", "CFS", "VIPS", "MTE", "JBP", "BEE",
]);

const MILITARY_RE =
  /\b(USAF|USN|USMC|USCG|NATO|RAF|VQ|RQ|P3|P-3|C130|C-130|C17|C-17|KC135|KC-135|B52|B-52|F16|F-16|F15|F-15|A10|A-10|E3|E4|U2|U-2|RC135|RC-135|AWACS|TACAMO|GRIFFIN|REAPER|HORNET|FALCON|TIGER|EAGLE|RAPTOR|STEALTH|BLACKHAWK|GHOST|PHANTOM|SHADOW|RAIDEN|STRIKER|WARRIOR|BANDIT)/i;

const N_NUMBER_RE = /^N\d{1,5}[A-Z]{0,3}$/;
const AIRLINE_RE = /^[A-Z]{2,3}\d{1,4}$/;

export function classifyAir(input: { callsign?: string; spi?: boolean }): CraftKind {
  if (input.spi) return "military";
  const cs = (input.callsign ?? "").toUpperCase().trim();
  if (!cs) return "general";
  if (MILITARY_RE.test(cs)) return "military";
  if (N_NUMBER_RE.test(cs)) return "business";
  if (BIZ_PREFIXES.has(cs.slice(0, 3))) return "business";
  if (AIRLINE_RE.test(cs)) return "commercial";
  return "general";
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/classify.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/classify.ts test/classify.test.ts
git commit -m "feat: classifyAir maps callsign + SPI to air craft kind"
```

---

### Task 4: normalizeOpenSky (state vector → Craft)

**Files:**
- Create: `server/normalize.ts`
- Test: `test/normalize.test.ts`

**Interfaces:**
- Consumes: `Craft` from `shared/craft.js`; `classifyAir` from `./classify.js`.
- Produces:
  - `const MS_TO_KNOTS = 1.94384; const M_TO_FT = 3.28084; const MS_TO_FPM = 196.850;`
  - `function normalizeOpenSky(state: (string | number | boolean | null)[], now: number): Craft | null`.

- [ ] **Step 1: Write the failing test**

Create `test/normalize.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { normalizeOpenSky } from "../server/normalize.js";

// 17-field OpenSky state vector
function vec(over: Partial<Record<number, string | number | boolean | null>> = {}): (string | number | boolean | null)[] {
  const base: (string | number | boolean | null)[] = [
    "ac4963", "DAL539", "United States", 1700000000, 1700000000,
    -73.7, 40.6, 10000, false, 250, 90, 10, null, 10050, "1200", false, 2,
  ];
  return base.map((v, i) => (i in over ? over[i as number] : v));
}

describe("normalizeOpenSky", () => {
  it("maps fields and converts units", () => {
    const c = normalizeOpenSky(vec(), 1700000000000)!;
    expect(c.id).toBe("ac4963");
    expect(c.domain).toBe("air");
    expect(c.kind).toBe("commercial");
    expect(c.lat).toBeCloseTo(40.6);
    expect(c.lon).toBeCloseTo(-73.7);
    expect(c.speed).toBeCloseTo(250 * 1.94384); // m/s -> kn
    expect(c.heading).toBe(90);
    expect(c.altitude).toBeCloseTo(10050 * 3.28084); // geo alt m -> ft
    expect(c.verticalRate).toBeCloseTo(10 * 196.850); // m/s -> fpm
    expect(c.squawk).toBe("1200");
    expect(c.onGround).toBe(false);
    expect(c.spi).toBe(false);
    expect(c.originCountry).toBe("United States");
    expect(c.callsign).toBe("DAL539");
    expect(c.updatedAt).toBe(1700000000000);
    expect(c.stale).toBe(false);
  });

  it("prefers geo altitude, falls back to baro", () => {
    const geo = normalizeOpenSky(vec({ 13: 10050 }), 0)!;
    const baro = normalizeOpenSky(vec({ 13: null }), 0)!;
    expect(geo.altitude).toBeCloseTo(10050 * 3.28084);
    expect(baro.altitude).toBeCloseTo(10000 * 3.28084);
  });

  it("SPI → military kind", () => {
    const c = normalizeOpenSky(vec({ 15: true, 1: "USAF1" }), 0)!;
    expect(c.kind).toBe("military");
    expect(c.spi).toBe(true);
  });

  it("nulls speed/heading/altitude when missing", () => {
    const c = normalizeOpenSky(vec({ 9: null, 10: null, 7: null, 13: null, 11: null }), 0)!;
    expect(c.speed).toBeNull();
    expect(c.heading).toBeNull();
    expect(c.altitude).toBeNull();
    expect(c.verticalRate).toBeNull();
  });

  it("returns null when icao24 or position missing", () => {
    expect(normalizeOpenSky(vec({ 0: null }), 0)).toBeNull();
    expect(normalizeOpenSky(vec({ 5: null }), 0)).toBeNull();
    expect(normalizeOpenSky(vec({ 6: null }), 0)).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/normalize.test.ts`
Expected: FAIL — `Cannot find module '../server/normalize.js'`.

- [ ] **Step 3: Write minimal implementation**

Create `server/normalize.ts`:

```ts
import type { Craft } from "../shared/craft.js";
import { classifyAir } from "./classify.js";

export const MS_TO_KNOTS = 1.94384;
export const M_TO_FT = 3.28084;
export const MS_TO_FPM = 196.850;

type Field = string | number | boolean | null;

export function normalizeOpenSky(state: Field[], now: number): Craft | null {
  const [
    icao24,
    callsign,
    origin_country,
    time_position,
    , // 4 last_contact
    longitude,
    latitude,
    baro_altitude,
    on_ground,
    velocity,
    true_track,
    vertical_rate,
    , // 12 sensors
    geo_altitude,
    squawk,
    spi,
  ] = state;

  if (!icao24 || longitude == null || latitude == null) return null;

  const altM = geo_altitude ?? baro_altitude;
  const cs = typeof callsign === "string" ? callsign.trim() : "";

  return {
    id: String(icao24),
    domain: "air",
    kind: classifyAir({ callsign: cs || undefined, spi: Boolean(spi) }),
    lat: Number(latitude),
    lon: Number(longitude),
    speed: velocity != null ? Number(velocity) * MS_TO_KNOTS : null,
    heading: true_track != null ? Number(true_track) : null,
    callsign: cs || undefined,
    altitude: altM != null ? Number(altM) * M_TO_FT : null,
    verticalRate: vertical_rate != null ? Number(vertical_rate) * MS_TO_FPM : null,
    squawk: squawk != null ? String(squawk) : null,
    onGround: Boolean(on_ground),
    spi: Boolean(spi),
    originCountry: origin_country ? String(origin_country) : undefined,
    updatedAt: time_position != null ? Number(time_position) * 1000 : now,
    stale: false,
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/normalize.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/normalize.ts test/normalize.test.ts
git commit -m "feat: normalizeOpenSky maps state vectors to Craft with unit conversion"
```

---

### Task 5: normalizeAis (aisstream frames → Craft / static)

**Files:**
- Modify: `server/normalize.ts`
- Test: `test/normalize.test.ts` (append)

**Interfaces:**
- Consumes: `Craft` from `shared/craft.js`; `classifySea` from `./classify.js`.
- Produces:
  - `interface AisStatic { mmsi: string; shipName?: string; imo?: number | null; callSign?: string; destination?: string; aisType?: number | null }`
  - `function normalizeShipStaticData(env: any): AisStatic | null`
  - `function normalizePositionReport(env: any, staticData: AisStatic | undefined, now: number): Craft | null`

- [ ] **Step 1: Write the failing test**

Append to `test/normalize.test.ts`:

```ts
import { normalizePositionReport, normalizeShipStaticData } from "../server/normalize.js";

const POS_ENV = {
  MessageType: "PositionReport",
  MMSI: 368207620,
  Message: {
    PositionReport: {
      Latitude: 51.5, Longitude: -0.1, Sog: 12.5, Cog: 90,
      TrueHeading: 92, NavigationalStatus: 0, Timestamp: 1700000000,
    },
  },
};

const STATIC_ENV = {
  MessageType: "ShipStaticData",
  MMSI: 368207620,
  Message: {
    ShipStaticData: {
      Name: "EXAMPLE VESSEL", Type: 70, ImoNumber: 123456789,
      CallSign: "ABCDE", Destination: "ROTTERDAM",
    },
  },
};

describe("normalizeShipStaticData", () => {
  it("extracts static fields", () => {
    const s = normalizeShipStaticData(STATIC_ENV)!;
    expect(s.mmsi).toBe("368207620");
    expect(s.shipName).toBe("EXAMPLE VESSEL");
    expect(s.aisType).toBe(70);
    expect(s.imo).toBe(123456789);
    expect(s.callSign).toBe("ABCDE");
    expect(s.destination).toBe("ROTTERDAM");
  });

  it("returns null without an mmsi", () => {
    expect(normalizeShipStaticData({ Message: { ShipStaticData: { Name: "X" } } })).toBeNull();
  });
});

describe("normalizePositionReport", () => {
  it("builds a sea Craft, kind=other without static data", () => {
    const c = normalizePositionReport(POS_ENV, undefined, 1700000000000)!;
    expect(c.id).toBe("368207620");
    expect(c.domain).toBe("sea");
    expect(c.kind).toBe("other");
    expect(c.lat).toBeCloseTo(51.5);
    expect(c.lon).toBeCloseTo(-0.1);
    expect(c.speed).toBeCloseTo(12.5); // Sog already knots
    expect(c.heading).toBe(90);
    expect(c.navStatus).toBe(0);
    expect(c.updatedAt).toBe(1700000000000);
  });

  it("joins cached static data (kind, name, destination, imo)", () => {
    const sd = normalizeShipStaticData(STATIC_ENV)!;
    const c = normalizePositionReport(POS_ENV, sd, 1700000000000)!;
    expect(c.kind).toBe("cargo"); // Type 70
    expect(c.shipName).toBe("EXAMPLE VESSEL");
    expect(c.destination).toBe("ROTTERDAM");
    expect(c.imo).toBe(123456789);
    expect(c.aisType).toBe(70);
  });

  it("falls back to TrueHeading when Cog missing", () => {
    const env = {
      MessageType: "PositionReport", MMSI: 1,
      Message: { PositionReport: { Latitude: 1, Longitude: 2, TrueHeading: 120 } },
    };
    expect(normalizePositionReport(env, undefined, 0)!.heading).toBe(120);
  });

  it("returns null without lat/lon or mmsi", () => {
    expect(normalizePositionReport({ Message: { PositionReport: { Sog: 5 } } }, undefined, 0)).toBeNull();
    expect(normalizePositionReport({ MessageType: "PositionReport", Message: { PositionReport: { Latitude: 1, Longitude: 2 } } }, undefined, 0)).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/normalize.test.ts`
Expected: FAIL — `normalizePositionReport is not a function`.

- [ ] **Step 3: Write minimal implementation**

Append to `server/normalize.ts`:

```ts
import { classifySea } from "./classify.js";

export interface AisStatic {
  mmsi: string;
  shipName?: string;
  imo?: number | null;
  callSign?: string;
  destination?: string;
  aisType?: number | null;
}

function num(v: unknown): number | null {
  if (v == null || v === "") return null;
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}

function str(v: unknown): string | undefined {
  if (v == null) return undefined;
  const s = String(v).trim();
  return s ? s : undefined;
}

function pickMmsi(env: any): string | null {
  const m =
    env?.MMSI ?? env?.mmsi ?? env?.metaData?.mmsi ??
    env?.Message?.PositionReport?.UserID ?? env?.Message?.ShipStaticData?.UserID;
  return m != null ? String(m) : null;
}

export function normalizeShipStaticData(env: any): AisStatic | null {
  const mmsi = pickMmsi(env);
  if (mmsi == null) return null;
  const sd = env?.Message?.ShipStaticData ?? env?.ShipStaticData ?? env?.Message ?? {};
  return {
    mmsi,
    shipName: str(sd.Name) ?? str(sd.ShipName),
    imo: num(sd.ImoNumber) ?? num(sd.Imo) ?? null,
    callSign: str(sd.CallSign),
    destination: str(sd.Destination),
    aisType: num(sd.Type) ?? null,
  };
}

export function normalizePositionReport(env: any, staticData: AisStatic | undefined, now: number): Craft | null {
  const mmsi = pickMmsi(env);
  const pr = env?.Message?.PositionReport ?? env?.PositionReport ?? env?.Message ?? {};
  const lat = num(pr.Latitude);
  const lon = num(pr.Longitude);
  if (mmsi == null || lat == null || lon == null) return null;

  const sog = num(pr.Sog) ?? num(pr.SpeedOverGround);
  const cog = num(pr.Cog) ?? num(pr.CourseOverGround);
  const th = num(pr.TrueHeading);
  const ts = num(pr.Timestamp);

  return {
    id: mmsi,
    domain: "sea",
    kind: classifySea(staticData?.aisType),
    lat,
    lon,
    speed: sog,
    heading: cog ?? th,
    shipName: staticData?.shipName,
    imo: staticData?.imo ?? null,
    callSign: staticData?.callSign,
    destination: staticData?.destination,
    navStatus: num(pr.NavigationalStatus),
    aisType: staticData?.aisType ?? null,
    updatedAt: ts != null ? (ts < 1e12 ? ts * 1000 : ts) : now,
    stale: false,
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/normalize.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/normalize.ts test/normalize.test.ts
git commit -m "feat: normalizeAis parses aisstream frames + static-data join"
```

---

### Task 6: CraftStore (in-memory store + dirty set + sweep + air prune)

**Files:**
- Create: `server/store.ts`
- Test: `test/store.test.ts`

**Interfaces:**
- Consumes: `Craft` from `shared/craft.js`.
- Produces: `class CraftStore` with:
  - `upsert(items: Craft | Craft[], now: number): void`
  - `remove(id: string): void`
  - `drainDirty(): { upsert: Craft[]; remove: string[] }`
  - `all(): Craft[]`
  - `get(id: string): Craft | undefined`
  - `get size(): number`
  - `sweep(now: number, staleMs: number, removeMs: number): string[]`
  - `pruneAir(present: Set<string>, now: number, graceMs: number): string[]`

- [ ] **Step 1: Write the failing test**

Create `test/store.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { CraftStore } from "../server/store.js";
import type { Craft } from "../shared/craft.js";

function air(id: string, updatedAt: number): Craft {
  return { id, domain: "air", kind: "commercial", lat: 0, lon: 0, speed: null, heading: null, updatedAt, stale: false };
}
function sea(id: string, updatedAt: number): Craft {
  return { id, domain: "sea", kind: "cargo", lat: 0, lon: 0, speed: null, heading: null, updatedAt, stale: false };
}

describe("CraftStore", () => {
  it("upserts single + array, tracks size", () => {
    const s = new CraftStore();
    s.upsert(air("a1", 1000), 1000);
    s.upsert([sea("b1", 1000), air("a2", 1000)], 1000);
    expect(s.size).toBe(3);
    expect(s.get("a1")!.kind).toBe("commercial");
  });

  it("drainDirty returns upsert + remove, then empties", () => {
    const s = new CraftStore();
    s.upsert(air("a1", 1000), 1000);
    s.upsert(sea("b1", 1000), 1000);
    s.remove("a1");
    let d = s.drainDirty();
    expect(d.upsert.map((c) => c.id)).toEqual(["b1"]);
    expect(d.remove).toEqual(["a1"]);
    d = s.drainDirty();
    expect(d.upsert).toEqual([]);
    expect(d.remove).toEqual([]);
  });

  it("sweep marks stale, then removes", () => {
    const s = new CraftStore();
    s.upsert(air("a1", 0), 0);
    s.sweep(130000, 120000, 600000);
    expect(s.get("a1")!.stale).toBe(true);
    const removed = s.sweep(601000, 120000, 600000);
    expect(removed).toContain("a1");
    expect(s.size).toBe(0);
  });

  it("pruneAir removes air absent from snapshot after grace, keeps present", () => {
    const s = new CraftStore();
    s.upsert(air("a1", 0), 0);
    s.upsert(air("a2", 0), 0);
    expect(s.pruneAir(new Set(["a1"]), 1000, 30000)).toEqual([]); // grace not elapsed
    const removed = s.pruneAir(new Set(["a1"]), 31000, 30000);
    expect(removed).toContain("a2");
    expect(s.get("a1")).toBeDefined();
    expect(s.get("a2")).toBeUndefined();
  });

  it("pruneAir never touches sea craft", () => {
    const s = new CraftStore();
    s.upsert(sea("b1", 0), 0);
    expect(s.pruneAir(new Set(), 100000, 30000)).toEqual([]);
    expect(s.get("b1")).toBeDefined();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/store.test.ts`
Expected: FAIL — `Cannot find module '../server/store.js'`.

- [ ] **Step 3: Write minimal implementation**

Create `server/store.ts`:

```ts
import type { Craft } from "../shared/craft.js";

export class CraftStore {
  private craft = new Map<string, Craft>();
  private dirtyUpsert = new Set<string>();
  private dirtyRemove = new Set<string>();
  private airLastSeen = new Map<string, number>();

  get size(): number {
    return this.craft.size;
  }

  get(id: string): Craft | undefined {
    return this.craft.get(id);
  }

  all(): Craft[] {
    return [...this.craft.values()];
  }

  upsert(items: Craft | Craft[], now: number): void {
    const list = Array.isArray(items) ? items : [items];
    for (const c of list) {
      this.craft.set(c.id, c);
      this.dirtyUpsert.add(c.id);
      this.dirtyRemove.delete(c.id);
      if (c.domain === "air") this.airLastSeen.set(c.id, now);
    }
  }

  remove(id: string): void {
    if (this.craft.delete(id)) {
      this.dirtyRemove.add(id);
      this.dirtyUpsert.delete(id);
    }
    this.airLastSeen.delete(id);
  }

  drainDirty(): { upsert: Craft[]; remove: string[] } {
    const upsert = [...this.dirtyUpsert]
      .map((id) => this.craft.get(id))
      .filter((c): c is Craft => c != null);
    const remove = [...this.dirtyRemove];
    this.dirtyUpsert.clear();
    this.dirtyRemove.clear();
    return { upsert, remove };
  }

  sweep(now: number, staleMs: number, removeMs: number): string[] {
    const removed: string[] = [];
    for (const [id, c] of this.craft) {
      const age = now - c.updatedAt;
      if (age > removeMs) {
        this.craft.delete(id);
        this.airLastSeen.delete(id);
        this.dirtyRemove.add(id);
        this.dirtyUpsert.delete(id);
        removed.push(id);
      } else if (age > staleMs && !c.stale) {
        c.stale = true;
        this.dirtyUpsert.add(id);
        this.dirtyRemove.delete(id);
      }
    }
    return removed;
  }

  pruneAir(present: Set<string>, now: number, graceMs: number): string[] {
    const removed: string[] = [];
    for (const [id, c] of this.craft) {
      if (c.domain !== "air" || present.has(id)) continue;
      const seen = this.airLastSeen.get(id);
      if (seen != null && now - seen > graceMs) {
        this.craft.delete(id);
        this.airLastSeen.delete(id);
        this.dirtyRemove.add(id);
        this.dirtyUpsert.delete(id);
        removed.push(id);
      }
    }
    return removed;
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/store.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/store.ts test/store.test.ts
git commit -m "feat: CraftStore in-memory store with dirty set, sweep, air prune"
```

---

### Task 7: OpenSkyPoller

**Files:**
- Create: `server/opensky.ts`
- Test: `test/poller.test.ts`

**Interfaces:**
- Consumes: `CraftStore` from `./store.js`; `normalizeOpenSky` from `./normalize.js`.
- Produces:
  - `interface OpenSkyPollerOpts { url?: string; pollMs: number; graceMs: number; store: CraftStore; fetchImpl?: typeof fetch; now?: () => number; log?: (msg: string) => void }`
  - `class OpenSkyPoller { start(): void; stop(): void; pollOnce(): Promise<number> }`

- [ ] **Step 1: Write the failing test**

Create `test/poller.test.ts`:

```ts
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import http from "node:http";
import { OpenSkyPoller } from "../server/opensky.js";
import { CraftStore } from "../server/store.js";

const PLANE: (string | number | boolean | null)[] = [
  "ac4963", "DAL539", "United States", 1700000000, 1700000000,
  -73.7, 40.6, 10000, false, 250, 90, 10, null, 10050, "1200", false, 2,
];

describe("OpenSkyPoller", () => {
  let server: http.Server;
  let url: string;
  let current: { data: (string | number | boolean | null)[][] } = { data: [] };

  beforeAll(async () => {
    server = http.createServer((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(current));
    });
    await new Promise<void>((r) => server.listen(0, () => r()));
    const addr = server.address();
    const port = typeof addr === "object" && addr ? addr.port : 0;
    url = `http://127.0.0.1:${port}/states/all`;
  });
  afterAll(async () => {
    await new Promise<void>((r) => server.close(() => r()));
  });

  it("polls, normalizes, upserts into store", async () => {
    current = { data: [PLANE] };
    const store = new CraftStore();
    const poller = new OpenSkyPoller({ url, pollMs: 1000, graceMs: 30000, store });
    const count = await poller.pollOnce();
    expect(count).toBe(1);
    expect(store.get("ac4963")!.kind).toBe("commercial");
  });

  it("prunes air absent from a later snapshot after grace", async () => {
    const store = new CraftStore();
    let t = 0;
    const poller = new OpenSkyPoller({ url, pollMs: 1000, graceMs: 30000, store, now: () => t });
    current = { data: [PLANE] };
    t = 0;
    await poller.pollOnce();
    expect(store.size).toBe(1);
    current = { data: [] };
    t = 1000;
    await poller.pollOnce(); // within grace
    expect(store.size).toBe(1);
    t = 31000;
    await poller.pollOnce(); // past grace
    expect(store.size).toBe(0);
  });

  it("does not prune on a failed poll", async () => {
    const store = new CraftStore();
    let t = 0;
    const good = new OpenSkyPoller({ url, pollMs: 1000, graceMs: 30000, store, now: () => t });
    current = { data: [PLANE] };
    t = 0;
    await good.pollOnce();
    expect(store.size).toBe(1);
    const dead = new OpenSkyPoller({ url: "http://127.0.0.1:1", pollMs: 1000, graceMs: 30000, store, now: () => t });
    t = 999999;
    await expect(dead.pollOnce()).rejects.toThrow();
    expect(store.size).toBe(1); // unchanged — a failed poll must not prune
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/poller.test.ts`
Expected: FAIL — `Cannot find module '../server/opensky.js'`.

- [ ] **Step 3: Write minimal implementation**

Create `server/opensky.ts`:

```ts
import type { CraftStore } from "./store.js";
import { normalizeOpenSky } from "./normalize.js";

export interface OpenSkyPollerOpts {
  url?: string;
  pollMs: number;
  graceMs: number;
  store: CraftStore;
  fetchImpl?: typeof fetch;
  now?: () => number;
  log?: (msg: string) => void;
}

export class OpenSkyPoller {
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  constructor(private opts: OpenSkyPollerOpts) {}

  start(): void {
    if (this.running) return;
    this.running = true;
    void this.pollOnce().catch((e) => this.opts.log?.(`opensky: ${e.message}`));
    this.timer = setInterval(() => {
      void this.pollOnce().catch((e) => this.opts.log?.(`opensky: ${e.message}`));
    }, this.opts.pollMs);
  }

  stop(): void {
    this.running = false;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async pollOnce(): Promise<number> {
    const now = this.opts.now?.() ?? Date.now();
    const fetchImpl = this.opts.fetchImpl ?? fetch;
    const res = await fetchImpl(this.opts.url ?? "https://opensky-network.org/api/states/all");
    if (!res.ok) throw new Error(`OpenSky HTTP ${res.status}`);
    const body = (await res.json()) as { data?: (string | number | boolean | null)[][] };
    const rows = body.data ?? [];
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
    return crafts.length;
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/poller.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/opensky.ts test/poller.test.ts
git commit -m "feat: OpenSkyPoller polls states/all, upserts + prunes air"
```

---

### Task 8: AisClient (aisstream.io WebSocket)

**Files:**
- Create: `server/ais.ts`, `test/util.ts`
- Test: `test/ais.test.ts`

**Interfaces:**
- Consumes: `CraftStore` from `./store.js`; `normalizePositionReport`, `normalizeShipStaticData`, `AisStatic` from `./normalize.js`.
- Produces:
  - `interface AisClientOpts { url?: string; apiKey: string; store: CraftStore; wsImpl?: typeof import("ws").WebSocket; now?: () => number; log?: (msg: string) => void }`
  - `class AisClient { start(): void; stop(): void; handleMessage(raw: string): void }`
  - `test/util.ts`: `sleep(ms)`, `waitFor(predicate, timeoutMs?, intervalMs?)`.

- [ ] **Step 1: Write the failing test**

Create `test/util.ts`:

```ts
export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export async function waitFor(
  predicate: () => boolean,
  timeoutMs = 2000,
  intervalMs = 25,
): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error("waitFor timed out");
    await sleep(intervalMs);
  }
}
```

Create `test/ais.test.ts`:

```ts
import { describe, it, expect, afterAll } from "vitest";
import WebSocket, { WebSocketServer } from "ws";
import { AisClient } from "../server/ais.js";
import { CraftStore } from "../server/store.js";
import { waitFor } from "./util.js";

const servers: WebSocketServer[] = [];

afterAll(async () => {
  for (const s of servers) await new Promise<void>((r) => s.close(() => r()));
});

describe("AisClient.handleMessage", () => {
  it("caches static data and joins it into position reports", () => {
    const store = new CraftStore();
    const client = new AisClient({ apiKey: "k", store });
    client.handleMessage(JSON.stringify({
      MessageType: "ShipStaticData", MMSI: 368207620,
      Message: { ShipStaticData: { Name: "EXAMPLE", Type: 70, ImoNumber: 123, CallSign: "ABCDE", Destination: "RTM" } },
    }));
    client.handleMessage(JSON.stringify({
      MessageType: "PositionReport", MMSI: 368207620,
      Message: { PositionReport: { Latitude: 51.5, Longitude: -0.1, Sog: 12.5, Cog: 90, NavigationalStatus: 0 } },
    }));
    const c = store.get("368207620")!;
    expect(c.kind).toBe("cargo");
    expect(c.shipName).toBe("EXAMPLE");
    expect(c.destination).toBe("RTM");
    expect(c.speed).toBeCloseTo(12.5);
  });

  it("ignores malformed JSON", () => {
    const store = new CraftStore();
    const client = new AisClient({ apiKey: "k", store });
    expect(() => client.handleMessage("not json")).not.toThrow();
    expect(store.size).toBe(0);
  });
});

describe("AisClient connection", () => {
  it("connects, receives frames, updates store", async () => {
    const wss = new WebSocketServer({ port: 0 });
    servers.push(wss);
    await new Promise<void>((r) => wss.once("listening", () => r()));
    const port = (wss.address() as { port: number }).port;
    wss.on("connection", (socket) => {
      socket.send(JSON.stringify({
        MessageType: "ShipStaticData", MMSI: 111,
        Message: { ShipStaticData: { Name: "SHIP", Type: 70 } },
      }));
      socket.send(JSON.stringify({
        MessageType: "PositionReport", MMSI: 111,
        Message: { PositionReport: { Latitude: 10, Longitude: 20, Sog: 5, Cog: 45 } },
      }));
    });

    const store = new CraftStore();
    const client = new AisClient({ url: `ws://127.0.0.1:${port}`, apiKey: "k", store });
    client.start();

    await waitFor(() => store.size === 1, 3000);
    expect(store.get("111")!.kind).toBe("cargo");
    expect(store.get("111")!.shipName).toBe("SHIP");

    client.stop();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/ais.test.ts`
Expected: FAIL — `Cannot find module '../server/ais.js'`.

- [ ] **Step 3: Write minimal implementation**

Create `server/ais.ts`:

```ts
import WebSocket from "ws";
import type { CraftStore } from "./store.js";
import {
  normalizePositionReport,
  normalizeShipStaticData,
  type AisStatic,
} from "./normalize.js";

export interface AisClientOpts {
  url?: string;
  apiKey: string;
  store: CraftStore;
  wsImpl?: typeof WebSocket;
  now?: () => number;
  log?: (msg: string) => void;
}

export class AisClient {
  private staticMap = new Map<string, AisStatic>();
  private ws: WebSocket | null = null;
  private closed = false;
  private retry: NodeJS.Timeout | null = null;
  private attempts = 0;

  constructor(private opts: AisClientOpts) {}

  start(): void {
    this.closed = false;
    this.connect();
  }

  stop(): void {
    this.closed = true;
    if (this.retry) clearTimeout(this.retry);
    this.retry = null;
    if (this.ws) {
      try {
        this.ws.close();
      } catch {
        /* ignore */
      }
      this.ws = null;
    }
  }

  private connect(): void {
    if (this.closed) return;
    const WSImpl = this.opts.wsImpl ?? WebSocket;
    const url = this.opts.url ?? "wss://stream.aisstream.io/v0/stream";
    const ws = new WSImpl(url, {
      headers: {
        APIKey: this.opts.apiKey,
        FilterMessageTypes: "PositionReport,ShipStaticData",
      },
    });
    this.ws = ws;
    ws.on("open", () => {
      this.attempts = 0;
      this.opts.log?.("ais: connected");
    });
    ws.on("message", (data: WebSocket.RawData) => {
      this.handleMessage(data.toString());
    });
    ws.on("close", () => this.scheduleReconnect());
    ws.on("error", (err: Error) => this.opts.log?.(`ais: error ${err.message}`));
  }

  private scheduleReconnect(): void {
    if (this.closed) return;
    const delay = Math.min(30000, 1000 * 2 ** this.attempts++);
    this.opts.log?.(`ais: reconnect in ${delay}ms`);
    this.retry = setTimeout(() => this.connect(), delay);
  }

  handleMessage(raw: string): void {
    let env: any;
    try {
      env = JSON.parse(raw);
    } catch {
      return;
    }
    const now = this.opts.now?.() ?? Date.now();
    const type = env?.MessageType;
    if (type === "ShipStaticData") {
      const sd = normalizeShipStaticData(env);
      if (sd) this.staticMap.set(sd.mmsi, sd);
      return;
    }
    if (type === "PositionReport") {
      const mmsi = String(
        env?.MMSI ?? env?.metaData?.mmsi ?? env?.Message?.PositionReport?.UserID ?? "",
      );
      const sd = mmsi ? this.staticMap.get(mmsi) : undefined;
      const c = normalizePositionReport(env, sd, now);
      if (c) this.opts.store.upsert(c, now);
    }
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/ais.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/ais.ts test/ais.test.ts test/util.ts
git commit -m "feat: AisClient connects to aisstream.io, joins static + position by MMSI"
```

---

### Task 9: Hub (browser WebSocket snapshot + batched updates)

**Files:**
- Create: `server/hub.ts`
- Test: `test/hub.test.ts`

**Interfaces:**
- Consumes: `CraftStore` from `./store.js`.
- Produces:
  - `interface WsLike { send(data: string): void; on(event: string, cb: (...args: any[]) => void): void; removeListener(event: string, cb: (...args: any[]) => void): void; close(): void }`
  - `interface HubOpts { store: CraftStore; batchMs: number; log?: (msg: string) => void }`
  - `class Hub { attach(socket: WsLike): void; start(): void; stop(): void; get clientCount(): number }`

- [ ] **Step 1: Write the failing test**

Create `test/hub.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { Hub } from "../server/hub.js";
import { CraftStore } from "../server/store.js";
import type { Craft } from "../shared/craft.js";
import { sleep } from "./util.js";

function air(id: string): Craft {
  return { id, domain: "air", kind: "commercial", lat: 0, lon: 0, speed: null, heading: null, updatedAt: 0, stale: false };
}

function fakeSocket() {
  const sent: string[] = [];
  const handlers: Record<string, Array<(...a: any[]) => void>> = {};
  return {
    sent,
    send(data: string) {
      sent.push(data);
    },
    on(event: string, cb: (...a: any[]) => void) {
      (handlers[event] ??= []).push(cb);
    },
    removeListener(event: string, cb: (...a: any[]) => void) {
      handlers[event] = (handlers[event] ?? []).filter((h) => h !== cb);
    },
    close() {},
    emit(event: string, ...args: any[]) {
      (handlers[event] ?? []).forEach((h) => h(...args));
    },
  };
}

describe("Hub", () => {
  it("sends a snapshot on attach", () => {
    const store = new CraftStore();
    store.upsert(air("a1"), 0);
    const hub = new Hub({ store, batchMs: 1000 });
    const sock = fakeSocket();
    hub.attach(sock);
    expect(sock.sent).toHaveLength(1);
    const msg = JSON.parse(sock.sent[0]);
    expect(msg.type).toBe("snapshot");
    expect(msg.craft.map((c: Craft) => c.id)).toContain("a1");
  });

  it("broadcasts batched updates", async () => {
    const store = new CraftStore();
    const hub = new Hub({ store, batchMs: 30 });
    const sock = fakeSocket();
    hub.attach(sock);
    hub.start();
    store.upsert(air("a2"), 0);
    await sleep(80);
    const updates = sock.sent
      .map((s) => JSON.parse(s))
      .filter((m) => m.type === "update");
    expect(updates.length).toBeGreaterThanOrEqual(1);
    expect(updates[0].upsert.map((c: Craft) => c.id)).toContain("a2");
    hub.stop();
  });

  it("removes closed clients", () => {
    const store = new CraftStore();
    const hub = new Hub({ store, batchMs: 1000 });
    const sock = fakeSocket();
    hub.attach(sock);
    expect(hub.clientCount).toBe(1);
    sock.emit("close");
    expect(hub.clientCount).toBe(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/hub.test.ts`
Expected: FAIL — `Cannot find module '../server/hub.js'`.

- [ ] **Step 3: Write minimal implementation**

Create `server/hub.ts`:

```ts
import type { CraftStore } from "./store.js";

export interface WsLike {
  send(data: string): void;
  on(event: string, cb: (...args: any[]) => void): void;
  removeListener(event: string, cb: (...args: any[]) => void): void;
  close(): void;
}

export interface HubOpts {
  store: CraftStore;
  batchMs: number;
  log?: (msg: string) => void;
}

export class Hub {
  private clients = new Set<WsLike>();
  private timer: NodeJS.Timeout | null = null;

  constructor(private opts: HubOpts) {}

  get clientCount(): number {
    return this.clients.size;
  }

  attach(socket: WsLike): void {
    this.clients.add(socket);
    const onClose = () => this.detach(socket);
    socket.on("close", onClose);
    socket.on("error", onClose);
    socket.send(JSON.stringify({ type: "snapshot", craft: this.opts.store.all() }));
  }

  private detach(socket: WsLike): void {
    this.clients.delete(socket);
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => this.tick(), this.opts.batchMs);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    for (const c of this.clients) {
      try {
        c.close();
      } catch {
        /* ignore */
      }
    }
    this.clients.clear();
  }

  private tick(): void {
    const { upsert, remove } = this.opts.store.drainDirty();
    if (upsert.length === 0 && remove.length === 0) return;
    const payload = JSON.stringify({ type: "update", upsert, remove });
    for (const c of this.clients) {
      try {
        c.send(payload);
      } catch {
        /* ignore */
      }
    }
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/hub.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/hub.ts test/hub.test.ts
git commit -m "feat: Hub sends snapshot on connect + batched WS updates"
```

---

### Task 10: Server bootstrap + full-pipeline integration test

**Files:**
- Create: `server/index.ts`
- Test: `test/integration.test.ts`

**Interfaces:**
- Consumes: `config` from `./config.js`; `CraftStore`; `OpenSkyPoller`; `AisClient`; `Hub`.
- Produces:
  - `interface ServerDeps { store?: CraftStore; hub?: Hub; opensky?: OpenSkyPoller; ais?: AisClient; log?: (msg: string) => void }`
  - `async function buildApp(deps?: ServerDeps): Promise<{ app: FastifyInstance; stop: () => Promise<void>; store: CraftStore; hub: Hub; opensky: OpenSkyPoller; ais: AisClient }>`
  - `function main(): void` (runs only when executed directly).

- [ ] **Step 1: Write the failing integration test**

Create `test/integration.test.ts`:

```ts
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import http from "node:http";
import WebSocket, { WebSocketServer } from "ws";
import { buildApp } from "../server/index.js";
import { CraftStore } from "../server/store.js";
import { OpenSkyPoller } from "../server/opensky.js";
import { AisClient } from "../server/ais.js";
import { Hub } from "../server/hub.js";
import { waitFor } from "./util.js";

const PLANE: (string | number | boolean | null)[] = [
  "ac4963", "DAL539", "United States", 1700000000, 1700000000,
  -73.7, 40.6, 10000, false, 250, 90, 10, null, 10050, "1200", false, 2,
];

describe("full pipeline (stub feeds -> hub)", () => {
  let httpServer: http.Server;
  let wsServer: WebSocketServer;
  let server: Awaited<ReturnType<typeof buildApp>>;
  let port: number;
  let current: { data: (string | number | boolean | null)[][] } = { data: [] };

  beforeAll(async () => {
    httpServer = http.createServer((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(current));
    });
    await new Promise<void>((r) => httpServer.listen(0, () => r()));
    const hport = (httpServer.address() as { port: number }).port;

    wsServer = new WebSocketServer({ port: 0 });
    await new Promise<void>((r) => wsServer.once("listening", () => r()));
    const wport = (wsServer.address() as { port: number }).port;
    wsServer.on("connection", (socket) => {
      socket.send(JSON.stringify({
        MessageType: "ShipStaticData", MMSI: 999,
        Message: { ShipStaticData: { Name: "PIPELINE SHIP", Type: 70 } },
      }));
      socket.send(JSON.stringify({
        MessageType: "PositionReport", MMSI: 999,
        Message: { PositionReport: { Latitude: 50, Longitude: 5, Sog: 8, Cog: 180 } },
      }));
    });

    const store = new CraftStore();
    const hub = new Hub({ store, batchMs: 50 });
    const opensky = new OpenSkyPoller({
      url: `http://127.0.0.1:${hport}/states/all`,
      pollMs: 50,
      graceMs: 30000,
      store,
    });
    const ais = new AisClient({ url: `ws://127.0.0.1:${wport}`, apiKey: "test", store });

    server = await buildApp({ store, hub, opensky, ais });
    await server.app.listen({ port: 0, host: "127.0.0.1" });
    port = (server.app.server.address() as { port: number }).port;
  });

  afterAll(async () => {
    await server.stop();
    await new Promise<void>((r) => httpServer.close(() => r()));
    await new Promise<void>((r) => wsServer.close(() => r()));
  });

  it("streams a snapshot and updates for both domains", async () => {
    current = { data: [PLANE] };
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    const messages: any[] = [];
    ws.on("message", (d) => messages.push(JSON.parse(d.toString())));

    await waitFor(() => messages.length > 0, 3000);
    expect(messages[0].type).toBe("snapshot");

    await waitFor(() => {
      const all = messages.flatMap((m) => m.upsert ?? (m.type === "snapshot" ? m.craft : []));
      return all.some((c: any) => c.id === "ac4963") && all.some((c: any) => c.id === "999");
    }, 3000);

    const all = messages.flatMap((m) => m.upsert ?? (m.type === "snapshot" ? m.craft : []));
    const plane = all.find((c: any) => c.id === "ac4963");
    const ship = all.find((c: any) => c.id === "999");
    expect(plane.domain).toBe("air");
    expect(ship.domain).toBe("sea");
    expect(ship.kind).toBe("cargo");
    expect(ship.shipName).toBe("PIPELINE SHIP");
    ws.close();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/integration.test.ts`
Expected: FAIL — `Cannot find module '../server/index.js'`.

- [ ] **Step 3: Write minimal implementation**

Create `server/index.ts`:

```ts
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import Fastify from "fastify";
import websocket from "@fastify/websocket";
import { config } from "./config.js";
import { CraftStore } from "./store.js";
import { OpenSkyPoller } from "./opensky.js";
import { AisClient } from "./ais.js";
import { Hub } from "./hub.js";

export interface ServerDeps {
  store?: CraftStore;
  hub?: Hub;
  opensky?: OpenSkyPoller;
  ais?: AisClient;
  log?: (msg: string) => void;
}

export async function buildApp(deps: ServerDeps = {}) {
  const log = deps.log ?? ((m: string) => console.log(`[radar] ${m}`));
  const store = deps.store ?? new CraftStore();
  const hub = deps.hub ?? new Hub({ store, batchMs: config.BATCH_MS, log });
  const opensky =
    deps.opensky ??
    new OpenSkyPoller({ pollMs: config.OPENSKY_POLL_MS, graceMs: 30000, store, log });
  const ais = deps.ais ?? new AisClient({ apiKey: config.AISSTREAM_API_KEY, store, log });

  const app = Fastify({ logger: false });
  await app.register(websocket);

  app.get("/ws", { websocket: true }, (socket) => {
    hub.attach(socket as any);
  });

  app.get("/health", async () => ({
    ok: true,
    craft: store.size,
    clients: hub.clientCount,
  }));

  const sweeper = setInterval(() => {
    store.sweep(Date.now(), config.STALE_MS, config.REMOVE_MS);
  }, 5000);

  hub.start();
  opensky.start();
  if (deps.ais || config.AISSTREAM_API_KEY) ais.start();
  else log("ais: AISSTREAM_API_KEY not set — vessel feed disabled");

  const stop = async () => {
    clearInterval(sweeper);
    hub.stop();
    opensky.stop();
    ais.stop();
    await app.close();
  };

  return { app, stop, store, hub, opensky, ais };
}

export function main(): void {
  buildApp()
    .then(({ app }) =>
      app.listen({ port: config.PORT, host: "127.0.0.1" }).then(() => {
        console.log(`[radar] backend on :${config.PORT}`);
      }),
    )
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
  const shutdown = () => process.exit(0);
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

const isMain =
  process.argv[1] != null && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (isMain) main();
```

- [ ] **Step 4: Run integration test to verify it passes**

Run: `npx vitest run test/integration.test.ts`
Expected: PASS.

- [ ] **Step 5: Run the full test suite + typecheck**

Run: `npm test && npm run typecheck`
Expected: ALL PASS.

- [ ] **Step 6: Commit**

```bash
git add server/index.ts test/integration.test.ts
git commit -m "feat: server bootstrap (fastify + ws) + full-pipeline integration test"
```

---

# Phase B — Frontend (Vite + MapLibre)

> Rendering tasks (12-14) are verified by `npm run typecheck` + `npm run build` (compile-time) plus the live smoke test in Task 18, since a real map needs a browser. Pure data tasks (11) get full unit tests.

### Task 11: Frontend data layer (ClientStore, RadarSocket, features, filter)

**Files:**
- Create: `src/data/store.ts`, `src/data/ws.ts`, `src/data/features.ts`, `src/data/filter.ts`
- Test: `test/features.test.ts`, `test/client-store.test.ts`

**Interfaces:**
- Consumes: `Craft`, `CraftKind` from `shared/craft.js`.
- Produces:
  - `src/data/store.ts`: `class ClientStore { applySnapshot(crafts: Craft[]): void; applyUpdate(upsert: Craft[], remove: string[]): void; all(): Craft[]; get(id: string): Craft | undefined; get size(): number; subscribe(fn: () => void): () => void }`
  - `src/data/ws.ts`: `type RadarMessage = { type: "snapshot"; craft: Craft[] } | { type: "update"; upsert: Craft[]; remove: string[] }`; `function parseRadarMessage(raw: string): RadarMessage | null`; `class RadarSocket { connect(): void; close(): void }`
  - `src/data/features.ts`: `function buildFeatureCollection(crafts: Craft[]): FeatureCollection` (GeoJSON, `[lon, lat]`)
  - `src/data/filter.ts`: `function buildIconFilter(visible: Set<CraftKind>): any` (user kind filter + zoom-based tiny-craft hiding)

- [ ] **Step 1: Write the failing tests**

Create `test/features.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { buildFeatureCollection } from "../src/data/features.js";
import { buildIconFilter } from "../src/data/filter.js";
import type { Craft } from "../shared/craft.js";

function air(over: Partial<Craft> = {}): Craft {
  return {
    id: "ac4963", domain: "air", kind: "commercial", lat: 40.6, lon: -73.7,
    speed: 486, heading: 90, callsign: "DAL539", altitude: 33000, updatedAt: 0, stale: false, ...over,
  };
}
function sea(over: Partial<Craft> = {}): Craft {
  return {
    id: "368207620", domain: "sea", kind: "cargo", lat: 51.5, lon: -0.1,
    speed: 12.5, heading: 90, shipName: "EXAMPLE", updatedAt: 0, stale: false, ...over,
  };
}

describe("buildFeatureCollection", () => {
  it("emits [lon, lat] points with label + sublabel", () => {
    const fc = buildFeatureCollection([air(), sea()]);
    expect(fc.type).toBe("FeatureCollection");
    expect(fc.features).toHaveLength(2);
    const [a, s] = fc.features;
    expect(a.geometry.coordinates).toEqual([-73.7, 40.6]);
    expect(a.properties.label).toBe("DAL539");
    expect(a.properties.kind).toBe("commercial");
    expect(a.properties.sublabel).toContain("kn");
    expect(a.properties.sublabel).toContain("ft");
    expect(s.geometry.coordinates).toEqual([-0.1, 51.5]);
    expect(s.properties.label).toBe("EXAMPLE");
    expect(s.properties.sublabel).not.toContain("ft"); // sea has no altitude
  });

  it("falls back to id when no callsign/shipName", () => {
    const fc = buildFeatureCollection([air({ callsign: undefined }), sea({ shipName: undefined })]);
    expect(fc.features[0].properties.label).toBe("ac4963");
    expect(fc.features[1].properties.label).toBe("368207620");
  });
});

describe("buildIconFilter", () => {
  it("includes the user kind list and a zoom-based tiny-craft clause", () => {
    const f: any = buildIconFilter(new Set(["commercial", "cargo"]));
    expect(f[0]).toBe("all");
    // user kind membership
    expect(JSON.stringify(f[1])).toContain("commercial");
    expect(JSON.stringify(f[1])).toContain("cargo");
    // zoom clause present
    expect(JSON.stringify(f[2])).toContain("zoom");
  });
});
```

Create `test/client-store.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { ClientStore } from "../src/data/store.js";
import { parseRadarMessage } from "../src/data/ws.js";
import type { Craft } from "../shared/craft.js";

function air(id: string): Craft {
  return { id, domain: "air", kind: "commercial", lat: 0, lon: 0, speed: null, heading: null, updatedAt: 0, stale: false };
}

describe("ClientStore", () => {
  it("applies snapshot then updates", () => {
    const s = new ClientStore();
    s.applySnapshot([air("a1"), air("a2")]);
    expect(s.size).toBe(2);
    s.applyUpdate([air("a3")], ["a1"]);
    expect(s.size).toBe(2);
    expect(s.get("a1")).toBeUndefined();
    expect(s.get("a3")).toBeDefined();
  });

  it("notifies subscribers on change, not on no-op", () => {
    const s = new ClientStore();
    let calls = 0;
    s.subscribe(() => calls++);
    s.applyUpdate([], []); // no-op
    expect(calls).toBe(0);
    s.applyUpdate([air("a1")], []);
    expect(calls).toBe(1);
  });
});

describe("parseRadarMessage", () => {
  it("parses snapshot + update", () => {
    expect(parseRadarMessage(JSON.stringify({ type: "snapshot", craft: [air("a1")] }))).toMatchObject({ type: "snapshot" });
    expect(parseRadarMessage(JSON.stringify({ type: "update", upsert: [air("a1")], remove: [] }))).toMatchObject({ type: "update" });
  });
  it("returns null on bad input", () => {
    expect(parseRadarMessage("nope")).toBeNull();
    expect(parseRadarMessage(JSON.stringify({ type: "bogus" }))).toBeNull();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/features.test.ts test/client-store.test.ts`
Expected: FAIL — `Cannot find module '../src/data/features.js'` (and siblings).

- [ ] **Step 3: Write minimal implementations**

Create `src/data/features.ts`:

```ts
import type { Craft } from "../../shared/craft.js";

export interface PointGeometry {
  type: "Point";
  coordinates: [number, number];
}

export interface CraftFeature {
  type: "Feature";
  id: string;
  geometry: PointGeometry;
  properties: {
    id: string;
    domain: "air" | "sea";
    kind: string;
    stale: boolean;
    label: string;
    sublabel: string;
    speed: number | null;
    altitude: number | null;
    heading: number | null;
  };
}

export interface FeatureCollection {
  type: "FeatureCollection";
  features: CraftFeature[];
}

function toFeature(c: Craft): CraftFeature {
  const label = c.domain === "air" ? c.callsign ?? c.id : c.shipName ?? c.id;
  const parts: string[] = [];
  if (c.speed != null) parts.push(`${Math.round(c.speed)}kn`);
  if (c.domain === "air" && c.altitude != null) parts.push(`${Math.round(c.altitude)}ft`);
  if (c.heading != null) parts.push(`${Math.round(c.heading)}°`);
  return {
    type: "Feature",
    id: c.id,
    geometry: { type: "Point", coordinates: [c.lon, c.lat] },
    properties: {
      id: c.id,
      domain: c.domain,
      kind: c.kind,
      stale: c.stale,
      label,
      sublabel: parts.join(" "),
      speed: c.speed,
      altitude: c.altitude ?? null,
      heading: c.heading,
    },
  };
}

export function buildFeatureCollection(crafts: Craft[]): FeatureCollection {
  return { type: "FeatureCollection", features: crafts.map(toFeature) };
}
```

Create `src/data/filter.ts`:

```ts
import type { CraftKind } from "../../shared/craft.js";

const TINY_KINDS: CraftKind[] = ["pleasure", "sailing", "general"];
const TINY_ZOOM = 5;

export function buildIconFilter(visible: Set<CraftKind>): any {
  return [
    "all",
    ["in", ["get", "kind"], ["literal", [...visible]]],
    ["any", [">=", ["zoom"], TINY_ZOOM], ["not", ["in", ["get", "kind"], ["literal", TINY_KINDS]]]],
  ];
}
```

Create `src/data/store.ts`:

```ts
import type { Craft } from "../../shared/craft.js";

export class ClientStore {
  private crafts = new Map<string, Craft>();
  private listeners = new Set<() => void>();

  get size(): number {
    return this.crafts.size;
  }

  get(id: string): Craft | undefined {
    return this.crafts.get(id);
  }

  all(): Craft[] {
    return [...this.crafts.values()];
  }

  applySnapshot(crafts: Craft[]): void {
    this.crafts = new Map(crafts.map((c) => [c.id, c]));
    this.emit();
  }

  applyUpdate(upsert: Craft[], remove: string[]): void {
    let changed = false;
    for (const c of upsert) {
      this.crafts.set(c.id, c);
      changed = true;
    }
    for (const id of remove) {
      if (this.crafts.delete(id)) changed = true;
    }
    if (changed) this.emit();
  }

  subscribe(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  }

  private emit(): void {
    for (const fn of this.listeners) fn();
  }
}
```

Create `src/data/ws.ts`:

```ts
import type { Craft } from "../../shared/craft.js";

export type RadarMessage =
  | { type: "snapshot"; craft: Craft[] }
  | { type: "update"; upsert: Craft[]; remove: string[] };

export function parseRadarMessage(raw: string): RadarMessage | null {
  try {
    const msg = JSON.parse(raw) as RadarMessage;
    if (msg.type === "snapshot" || msg.type === "update") return msg;
    return null;
  } catch {
    return null;
  }
}

export interface RadarSocketHandlers {
  onSnapshot: (craft: Craft[]) => void;
  onUpdate: (upsert: Craft[], remove: string[]) => void;
  onStatus?: (status: "connecting" | "open" | "closed") => void;
}

export class RadarSocket {
  private ws: WebSocket | null = null;
  private closed = false;
  private retry: number | null = null;
  private attempts = 0;

  constructor(private url: string, private handlers: RadarSocketHandlers) {}

  connect(): void {
    this.closed = false;
    this.open();
  }

  close(): void {
    this.closed = true;
    if (this.retry != null) {
      clearTimeout(this.retry);
      this.retry = null;
    }
    this.ws?.close();
    this.ws = null;
  }

  private open(): void {
    if (this.closed) return;
    this.handlers.onStatus?.("connecting");
    const ws = new WebSocket(this.url);
    this.ws = ws;
    ws.onopen = () => {
      this.attempts = 0;
      this.handlers.onStatus?.("open");
    };
    ws.onmessage = (ev) => {
      const msg = parseRadarMessage(ev.data as string);
      if (!msg) return;
      if (msg.type === "snapshot") this.handlers.onSnapshot(msg.craft);
      else this.handlers.onUpdate(msg.upsert, msg.remove);
    };
    ws.onclose = () => {
      this.handlers.onStatus?.("closed");
      this.scheduleReconnect();
    };
    ws.onerror = () => {
      /* onclose follows */
    };
  }

  private scheduleReconnect(): void {
    if (this.closed) return;
    const delay = Math.min(15000, 500 * 2 ** this.attempts++);
    this.retry = window.setTimeout(() => this.open(), delay);
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/features.test.ts test/client-store.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/data test/features.test.ts test/client-store.test.ts
git commit -m "feat: frontend data layer (ClientStore, RadarSocket, features, filter)"
```

---

### Task 12: Map init + Carto dark basemap + 14 per-kind SVG icons

**Files:**
- Create: `index.html`, `src/style.css`, `src/main.ts`, `src/map/map.ts`, `src/map/icon-urls.ts`, `src/map/icons.ts`, `src/assets/icons/{commercial,business,military,general,cargo,tanker,passenger,military_vessel,fishing,sailing,pleasure,tug_work,service,other}.svg`
- Test: `test/icons.test.ts`

**Interfaces:**
- Produces:
  - `src/map/map.ts`: `function createMap(container: HTMLElement): maplibregl.Map`
  - `src/map/icon-urls.ts`: `const ICON_URLS: Record<string, string>`; `const ICON_NAMES: string[]`
  - `src/map/icons.ts`: `function registerIcons(map: maplibregl.Map): Promise<void>`

- [ ] **Step 1: Write the failing test**

Create `test/icons.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { ICON_URLS, ICON_NAMES } from "../src/map/icon-urls.js";
import { AIR_KINDS, SEA_KINDS } from "../shared/craft.js";

describe("icon registry", () => {
  it("has exactly one icon per craft kind (14)", () => {
    expect(ICON_NAMES).toHaveLength(14);
    const allKinds = [...AIR_KINDS, ...SEA_KINDS];
    for (const k of allKinds) {
      expect(ICON_NAMES, `missing icon for ${k}`).toContain(k);
      expect(typeof ICON_URLS[k], `url for ${k}`).toBe("string");
      expect(ICON_URLS[k].length).toBeGreaterThan(0);
    }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/icons.test.ts`
Expected: FAIL — `Cannot find module '../src/map/icon-urls.js'`.

- [ ] **Step 3: Write `index.html`**

```html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Transponder Radar</title>
    <link rel="stylesheet" href="/src/style.css" />
  </head>
  <body>
    <div id="app">
      <div id="map"></div>
    </div>
    <script type="module" src="/src/main.ts"></script>
  </body>
</html>
```

- [ ] **Step 4: Write `src/style.css`**

```css
:root {
  color-scheme: dark;
  --bg: #0b0e14;
  --panel: rgba(17, 20, 28, 0.92);
  --border: #232838;
  --text: #e6e9f0;
  --muted: #8b93a7;
  --accent: #4fc3f7;
}

* {
  box-sizing: border-box;
}

html,
body,
#app,
#map {
  height: 100%;
  margin: 0;
}

body {
  background: var(--bg);
  color: var(--text);
  font-family: system-ui, -apple-system, "Segoe UI", sans-serif;
  overflow: hidden;
}

.maplibregl-canvas {
  outline: none;
}
```

- [ ] **Step 5: Write `src/map/map.ts`**

```ts
import maplibregl from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";

export function createMap(container: HTMLElement): maplibregl.Map {
  const map = new maplibregl.Map({
    container,
    style: {
      version: 8,
      sources: {
        carto: {
          type: "raster",
          tiles: [
            "https://a.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}.png",
            "https://b.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}.png",
            "https://c.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}.png",
            "https://d.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}.png",
          ],
          tileSize: 256,
          attribution: "© OpenStreetMap contributors © CARTO",
        },
      },
      layers: [{ id: "carto", type: "raster", source: "carto" }],
    },
    center: [10, 30],
    zoom: 1.5,
    attributionControl: false,
  });
  map.addControl(new maplibregl.NavigationControl(), "top-right");
  map.addControl(new maplibregl.AttributionControl({ compact: true }), "bottom-right");
  return map;
}
```

- [ ] **Step 6: Write the 14 SVG icons** (24×24, `viewBox="0 0 24 24"`, fill = kind color)

Create each file under `src/assets/icons/`:

`commercial.svg`:
```svg
<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24"><path fill="#4fc3f7" d="M12 2c.7 0 1.2.6 1.2 1.4v4.2l7.3 4.1v2l-7.3-2.1v4.6l2.3 1.6v1.6L12 18.6l-3.5 1.8v-1.6l2.3-1.6v-4.6L3.5 13.7v-2l7.3-4.1V3.4C10.8 2.6 11.3 2 12 2z"/></svg>
```

`business.svg`:
```svg
<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24"><path fill="#81d4fa" d="M12 4c.6 0 1 .5 1 1.1v3.4l6 3.3v1.6l-6-1.7v3.6l1.8 1.3v1.4L12 18.4l-2.8 1.6v-1.4l1.8-1.3v-3.6l-6 1.7v-1.6l6-3.3V5.1C11 4.5 11.4 4 12 4z"/></svg>
```

`military.svg`:
```svg
<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24"><path fill="#ef5350" d="M12 2l1.5 7 6.5 3-6.5 1.5L13 20l1 3h-4l1-3-1-6.5L3 11l6.5-3z"/></svg>
```

`general.svg`:
```svg
<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24"><path fill="#90a4ae" d="M12 3l2 7h5l-4 4 1.5 7L12 17l-4.5 4L9 14l-4-4h5z"/></svg>
```

`cargo.svg`:
```svg
<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24"><path fill="#ffb74d" d="M9 3h6l3 14-3 4H9l-3-4z"/><rect x="10" y="6" width="4" height="2" fill="#00000055"/><rect x="10" y="9" width="4" height="2" fill="#00000055"/></svg>
```

`tanker.svg`:
```svg
<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24"><path fill="#ff8a65" d="M10 3h4l2.5 15-2.5 3h-4l-2.5-3z"/><circle cx="12" cy="9" r="1.6" fill="#00000055"/><circle cx="12" cy="13" r="1.6" fill="#00000055"/></svg>
```

`passenger.svg`:
```svg
<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24"><path fill="#4dd0e1" d="M8 4h8l3 13-3 3H8l-3-3z"/><rect x="9" y="7" width="6" height="3" rx="1" fill="#00000055"/><rect x="9.5" y="11" width="5" height="2" rx="1" fill="#00000055"/></svg>
```

`military_vessel.svg`:
```svg
<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24"><path fill="#e57373" d="M12 2l4 4 1 12-5 4-5-4 1-12z"/><rect x="10.5" y="8" width="3" height="5" fill="#00000055"/></svg>
```

`fishing.svg`:
```svg
<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24"><path fill="#aed581" d="M9 5h6l2 12-2 2H9l-2-2z"/><line x1="12" y1="3" x2="12" y2="9" stroke="#aed581" stroke-width="1.5"/><path d="M12 4l4 3-4 1z" fill="#aed581"/></svg>
```

`sailing.svg`:
```svg
<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24"><path fill="#ba68c8" d="M12 2l6 14H6z"/><path fill="#ba68c8" d="M7 18h10l-1.5 3h-7z"/></svg>
```

`pleasure.svg`:
```svg
<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24"><path fill="#f06292" d="M8 6h8l2 10-2 2H8l-2-2z"/><circle cx="12" cy="10" r="1.5" fill="#00000055"/></svg>
```

`tug_work.svg`:
```svg
<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24"><path fill="#fff176" d="M8 7h8l1.5 9-1.5 2H8l-1.5-2z"/><rect x="10" y="9" width="4" height="3" fill="#00000055"/></svg>
```

`service.svg`:
```svg
<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24"><path fill="#a1887f" d="M9 5h6l2 12-2 2H9l-2-2z"/><rect x="10.5" y="8" width="3" height="4" fill="#00000055"/></svg>
```

`other.svg`:
```svg
<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24"><path fill="none" stroke="#b0bec5" stroke-width="1.5" d="M9 5h6l2 12-2 2H9l-2-2z"/></svg>
```

- [ ] **Step 7: Write `src/map/icon-urls.ts`**

```ts
import commercial from "../assets/icons/commercial.svg";
import business from "../assets/icons/business.svg";
import military from "../assets/icons/military.svg";
import general from "../assets/icons/general.svg";
import cargo from "../assets/icons/cargo.svg";
import tanker from "../assets/icons/tanker.svg";
import passenger from "../assets/icons/passenger.svg";
import military_vessel from "../assets/icons/military_vessel.svg";
import fishing from "../assets/icons/fishing.svg";
import sailing from "../assets/icons/sailing.svg";
import pleasure from "../assets/icons/pleasure.svg";
import tug_work from "../assets/icons/tug_work.svg";
import service from "../assets/icons/service.svg";
import other from "../assets/icons/other.svg";

export const ICON_URLS: Record<string, string> = {
  commercial,
  business,
  military,
  general,
  cargo,
  tanker,
  passenger,
  military_vessel,
  fishing,
  sailing,
  pleasure,
  tug_work,
  service,
  other,
};

export const ICON_NAMES: string[] = Object.keys(ICON_URLS);
```

- [ ] **Step 8: Write `src/map/icons.ts`**

```ts
import type maplibregl from "maplibre-gl";
import { ICON_URLS } from "./icon-urls.js";

export function registerIcons(map: maplibregl.Map): Promise<void> {
  return Promise.all(
    Object.entries(ICON_URLS).map(
      ([name, url]) =>
        new Promise<void>((resolve, reject) => {
          map.loadImage(url, (err, image) => {
            if (err || !image) {
              reject(err ?? new Error(`failed to load icon ${name}`));
              return;
            }
            if (!map.hasImage(name)) map.addImage(name, image);
            resolve();
          });
        }),
    ),
  );
}
```

- [ ] **Step 9: Write initial `src/main.ts`**

```ts
import { createMap } from "./map/map.js";
import { registerIcons } from "./map/icons.js";

const container = document.getElementById("map");
if (container) {
  const map = createMap(container);
  map.on("load", () => {
    registerIcons(map).catch((e) => console.error("icon load failed", e));
  });
}
```

- [ ] **Step 10: Run test + typecheck + build**

Run: `npx vitest run test/icons.test.ts && npm run typecheck && npm run build`
Expected: test PASS, typecheck PASS, `vite build` succeeds (emits `dist/`).

- [ ] **Step 11: Commit**

```bash
git add index.html src/style.css src/main.ts src/map src/assets test/icons.test.ts
git commit -m "feat: map init + Carto dark basemap + 14 per-kind SVG icons"
```

---

### Task 13: Craft source + icon/label/sublabel layers + zoom tiers

**Files:**
- Create: `src/map/layers.ts`

**Interfaces:**
- Produces:
  - `const CRAFT_SOURCE_ID = "craft"`
  - `function addCraftSource(map: maplibregl.Map): void`
  - `function setCraftData(map: maplibregl.Map, data: FeatureCollection): void`
  - `function addCraftLayers(map: maplibregl.Map, filter: any): void`

Zoom tiers (via paint/layout expressions, no JS zoom handlers):
- zoom 0-4: icon-size ~0.5, labels hidden (opacity 0), tiny kinds (pleasure/sailing/general) hidden by filter
- zoom 5-8: icon-size ramps to ~1.1, name/callsign labels fade in (opacity 0→1 over zoom 4→6)
- zoom 9+: speed/alt/heading sublabel fades in (opacity 0→1 over zoom 8→10)

- [ ] **Step 1: Write `src/map/layers.ts`**

```ts
import type maplibregl from "maplibre-gl";
import type { FeatureCollection } from "../data/features.js";

export const CRAFT_SOURCE_ID = "craft";

export function addCraftSource(map: maplibregl.Map): void {
  if (map.getSource(CRAFT_SOURCE_ID)) return;
  map.addSource(CRAFT_SOURCE_ID, {
    type: "geojson",
    data: { type: "FeatureCollection", features: [] },
  });
}

export function setCraftData(map: maplibregl.Map, data: FeatureCollection): void {
  const src = map.getSource(CRAFT_SOURCE_ID) as maplibregl.GeoJSONSource | undefined;
  src?.setData(data as any);
}

export function addCraftLayers(map: maplibregl.Map, filter: any): void {
  if (map.getLayer("craft-icons")) return;

  map.addLayer({
    id: "craft-icons",
    type: "symbol",
    source: CRAFT_SOURCE_ID,
    filter,
    layout: {
      "icon-image": ["get", "kind"],
      "icon-size": ["interpolate", ["linear"], ["zoom"], 0, 0.5, 9, 1.1],
      "icon-allow-overlap": true,
      "icon-ignore-placement": true,
    },
    paint: {
      "icon-opacity": ["case", ["get", "stale"], 0.3, 1],
    },
  });

  map.addLayer({
    id: "craft-labels",
    type: "symbol",
    source: CRAFT_SOURCE_ID,
    filter,
    layout: {
      "text-field": ["get", "label"],
      "text-size": 11,
      "text-offset": [0, 1.3],
      "text-allow-overlap": false,
      "text-ignore-placement": false,
    },
    paint: {
      "text-color": "#e6e9f0",
      "text-halo-color": "#000000",
      "text-halo-width": 1,
      "text-opacity": ["interpolate", ["linear"], ["zoom"], 4, 0, 6, 1],
    },
  });

  map.addLayer({
    id: "craft-sublabels",
    type: "symbol",
    source: CRAFT_SOURCE_ID,
    filter,
    layout: {
      "text-field": ["get", "sublabel"],
      "text-size": 10,
      "text-offset": [0, 2.4],
      "text-allow-overlap": false,
      "text-ignore-placement": true,
    },
    paint: {
      "text-color": "#90caf9",
      "text-halo-color": "#000000",
      "text-halo-width": 1,
      "text-opacity": ["interpolate", ["linear"], ["zoom"], 8, 0, 10, 1],
    },
  });
}
```

- [ ] **Step 2: Typecheck + build**

Run: `npm run typecheck && npm run build`
Expected: PASS (compile-time verification of layer specs).

- [ ] **Step 3: Commit**

```bash
git add src/map/layers.ts
git commit -m "feat: craft source + icon/label/sublabel layers with zoom tiers"
```

---

### Task 14: Wire WS → store → layers (live data on the map)

**Files:**
- Modify: `src/main.ts`

**Interfaces:**
- Consumes: `createMap`, `registerIcons`, `addCraftSource`, `addCraftLayers`, `setCraftData`, `ClientStore`, `RadarSocket`, `buildFeatureCollection`, `buildIconFilter`, `AIR_KINDS`, `SEA_KINDS`.
- Produces: a fully wired app — map renders live craft from the backend WS.

- [ ] **Step 1: Rewrite `src/main.ts`**

```ts
import { createMap } from "./map/map.js";
import { registerIcons } from "./map/icons.js";
import { addCraftSource, addCraftLayers, setCraftData } from "./map/layers.js";
import { ClientStore } from "./data/store.js";
import { RadarSocket } from "./data/ws.js";
import { buildFeatureCollection } from "./data/features.js";
import { buildIconFilter } from "./data/filter.js";
import { AIR_KINDS, SEA_KINDS } from "../shared/craft.js";
import type { CraftKind } from "../shared/craft.js";

const container = document.getElementById("map");
if (!container) throw new Error("#map missing");

const map = createMap(container);
const store = new ClientStore();
const visible = new Set<CraftKind>([...AIR_KINDS, ...SEA_KINDS]);

function refresh(): void {
  setCraftData(map, buildFeatureCollection(store.all()));
}

const wsUrl = `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws`;

map.on("load", async () => {
  await registerIcons(map);
  addCraftSource(map);
  addCraftLayers(map, buildIconFilter(visible));
  refresh();

  const socket = new RadarSocket(wsUrl, {
    onSnapshot: (crafts) => {
      store.applySnapshot(crafts);
      refresh();
    },
    onUpdate: (upsert, remove) => {
      store.applyUpdate(upsert, remove);
      refresh();
    },
  });
  socket.connect();
  store.subscribe(refresh);
});
```

- [ ] **Step 2: Typecheck + build**

Run: `npm run typecheck && npm run build`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add src/main.ts
git commit -m "feat: wire WS -> ClientStore -> map layers (live craft rendering)"
```

---

### Task 15: Detail panel (click a craft → per-domain fields)

**Files:**
- Create: `src/ui/panel.ts`
- Modify: `src/style.css` (append panel styles), `src/main.ts` (wire click)

**Interfaces:**
- Consumes: `Craft`, `KINDS` from `shared/craft.js`; `ClientStore`.
- Produces: `function createPanel(root: HTMLElement): { show(craft: Craft): void; hide(): void }`

- [ ] **Step 1: Write `src/ui/panel.ts`**

```ts
import type { Craft } from "../../shared/craft.js";
import { KINDS } from "../../shared/craft.js";

function row(label: string, value: string | number | null | undefined): HTMLDivElement {
  const d = document.createElement("div");
  d.className = "panel-row";
  const k = document.createElement("span");
  k.className = "panel-key";
  k.textContent = label;
  const v = document.createElement("span");
  v.className = "panel-val";
  v.textContent = value == null || value === "" ? "—" : String(value);
  d.append(k, v);
  return d;
}

export function createPanel(root: HTMLElement): { show(craft: Craft): void; hide(): void } {
  const el = document.createElement("aside");
  el.className = "panel";
  const head = document.createElement("div");
  head.className = "panel-head";
  const kindEl = document.createElement("span");
  kindEl.className = "panel-kind";
  const closeBtn = document.createElement("button");
  closeBtn.className = "panel-close";
  closeBtn.setAttribute("aria-label", "Close");
  closeBtn.textContent = "×";
  head.append(kindEl, closeBtn);
  const body = document.createElement("div");
  body.className = "panel-body";
  el.append(head, body);
  root.appendChild(el);

  function show(craft: Craft): void {
    kindEl.textContent = KINDS[craft.kind].label;
    kindEl.dataset.domain = craft.domain;
    body.textContent = "";
    if (craft.domain === "air") {
      body.append(
        row("Callsign", craft.callsign),
        row("Altitude", craft.altitude != null ? `${Math.round(craft.altitude)} ft` : null),
        row("Speed", craft.speed != null ? `${Math.round(craft.speed)} kn` : null),
        row("Heading", craft.heading != null ? `${Math.round(craft.heading)}°` : null),
        row("Vertical rate", craft.verticalRate != null ? `${Math.round(craft.verticalRate)} fpm` : null),
        row("Squawk", craft.squawk),
        row("On ground", craft.onGround ? "yes" : "no"),
        row("SPI (military)", craft.spi ? "yes" : "no"),
        row("Origin", craft.originCountry),
      );
    } else {
      body.append(
        row("Name", craft.shipName),
        row("MMSI", craft.id),
        row("IMO", craft.imo != null ? String(craft.imo) : null),
        row("Call sign", craft.callSign),
        row("Destination", craft.destination),
        row("Speed", craft.speed != null ? `${Math.round(craft.speed)} kn` : null),
        row("Heading", craft.heading != null ? `${Math.round(craft.heading)}°` : null),
        row("Nav status", craft.navStatus != null ? String(craft.navStatus) : null),
      );
    }
    el.classList.add("open");
  }

  function hide(): void {
    el.classList.remove("open");
  }

  closeBtn.addEventListener("click", hide);
  return { show, hide };
}
```

- [ ] **Step 2: Append panel styles to `src/style.css`**

```css
.panel {
  position: absolute;
  top: 12px;
  right: 12px;
  width: 280px;
  max-height: calc(100% - 24px);
  overflow: auto;
  background: var(--panel);
  border: 1px solid var(--border);
  border-radius: 10px;
  backdrop-filter: blur(8px);
  transform: translateX(120%);
  transition: transform 0.2s ease;
  z-index: 10;
}
.panel.open {
  transform: translateX(0);
}
.panel-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 10px 12px;
  border-bottom: 1px solid var(--border);
}
.panel-kind {
  font-weight: 600;
  font-size: 14px;
}
.panel-kind[data-domain="air"] {
  color: var(--accent);
}
.panel-kind[data-domain="sea"] {
  color: #ffb74d;
}
.panel-close {
  background: none;
  border: none;
  color: var(--muted);
  font-size: 18px;
  cursor: pointer;
  line-height: 1;
}
.panel-body {
  padding: 8px 12px 12px;
}
.panel-row {
  display: flex;
  justify-content: space-between;
  gap: 8px;
  padding: 4px 0;
  font-size: 13px;
  border-bottom: 1px solid rgba(255, 255, 255, 0.04);
}
.panel-key {
  color: var(--muted);
}
.panel-val {
  text-align: right;
  word-break: break-word;
}
```

- [ ] **Step 3: Wire the click in `src/main.ts`**

Add after `const store = new ClientStore();`:
```ts
const panel = createPanel(document.getElementById("app") as HTMLElement);
```
Add the import at top: `import { createPanel } from "./ui/panel.js";`
Add after `store.subscribe(refresh);` inside `map.on("load", ...)`:
```ts
map.on("click", "craft-icons", (e) => {
  const f = e.features?.[0];
  if (!f) return;
  const craft = store.get(f.properties.id as string);
  if (craft) panel.show(craft);
});
map.on("mouseenter", "craft-icons", () => {
  map.getCanvas().style.cursor = "pointer";
});
map.on("mouseleave", "craft-icons", () => {
  map.getCanvas().style.cursor = "";
});
```

- [ ] **Step 4: Typecheck + build**

Run: `npm run typecheck && npm run build`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/ui/panel.ts src/style.css src/main.ts
git commit -m "feat: detail panel with per-domain fields on craft click"
```

---

### Task 16: Filter drawer (toggle kinds, live layer filter)

**Files:**
- Create: `src/ui/filters.ts`
- Modify: `src/style.css` (append drawer styles), `src/main.ts` (change `const visible` → `let visible`, wire drawer)

**Interfaces:**
- Consumes: `CraftKind`, `KINDS`, `AIR_KINDS`, `SEA_KINDS` from `shared/craft.js`; `buildIconFilter`.
- Produces: `function createFilters(root: HTMLElement, initial: Set<CraftKind>, onChange: (v: Set<CraftKind>) => void): { setVisible(v: Set<CraftKind>): void }`

- [ ] **Step 1: Write `src/ui/filters.ts`**

```ts
import type { CraftKind } from "../../shared/craft.js";
import { KINDS, AIR_KINDS, SEA_KINDS } from "../../shared/craft.js";

const ORDER: CraftKind[] = [...AIR_KINDS, ...SEA_KINDS];

export function createFilters(
  root: HTMLElement,
  initial: Set<CraftKind>,
  onChange: (v: Set<CraftKind>) => void,
): { setVisible(v: Set<CraftKind>): void } {
  const el = document.createElement("aside");
  el.className = "drawer";
  const head = document.createElement("div");
  head.className = "drawer-head";
  head.textContent = "Filters";
  const body = document.createElement("div");
  body.className = "drawer-body";
  el.append(head, body);
  root.appendChild(el);

  let visible = new Set<CraftKind>(initial);

  function group(title: string, kinds: CraftKind[]): void {
    const h = document.createElement("div");
    h.className = "drawer-group";
    h.textContent = title;
    body.appendChild(h);
    for (const k of kinds) {
      const label = document.createElement("label");
      label.className = "drawer-item";
      const cb = document.createElement("input");
      cb.type = "checkbox";
      cb.checked = visible.has(k);
      cb.dataset.kind = k;
      cb.addEventListener("change", () => {
        const next = new Set(visible);
        if (cb.checked) next.add(k);
        else next.delete(k);
        visible = next;
        onChange(next);
      });
      const sw = document.createElement("span");
      sw.className = "swatch";
      sw.style.background = KINDS[k].color;
      const txt = document.createElement("span");
      txt.className = "drawer-label";
      txt.textContent = KINDS[k].label;
      label.append(cb, sw, txt);
      body.appendChild(label);
    }
  }

  group("Air", AIR_KINDS);
  group("Sea", SEA_KINDS);

  function setVisible(v: Set<CraftKind>): void {
    visible = new Set(v);
    body.querySelectorAll<HTMLInputElement>("input[type=checkbox]").forEach((cb) => {
      cb.checked = visible.has(cb.dataset.kind as CraftKind);
    });
  }

  return { setVisible };
}
```

- [ ] **Step 2: Append drawer styles to `src/style.css`**

```css
.drawer {
  position: absolute;
  top: 12px;
  left: 12px;
  width: 200px;
  max-height: calc(100% - 24px);
  overflow: auto;
  background: var(--panel);
  border: 1px solid var(--border);
  border-radius: 10px;
  backdrop-filter: blur(8px);
  z-index: 10;
}
.drawer-head {
  padding: 10px 12px;
  font-weight: 600;
  font-size: 13px;
  letter-spacing: 0.04em;
  text-transform: uppercase;
  color: var(--muted);
  border-bottom: 1px solid var(--border);
}
.drawer-body {
  padding: 8px 12px 12px;
}
.drawer-group {
  font-size: 11px;
  text-transform: uppercase;
  letter-spacing: 0.05em;
  color: var(--muted);
  margin: 8px 0 4px;
}
.drawer-item {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 3px 0;
  font-size: 13px;
  cursor: pointer;
}
.drawer-item input {
  accent-color: var(--accent);
}
.swatch {
  width: 10px;
  height: 10px;
  border-radius: 3px;
  flex: none;
}
.drawer-label {
  flex: 1;
}
```

- [ ] **Step 3: Wire the drawer in `src/main.ts`**

- Change `const visible = new Set<CraftKind>([...AIR_KINDS, ...SEA_KINDS]);` to `let visible = ...`.
- Add import: `import { createFilters } from "./ui/filters.js";`
- Add after `store.subscribe(refresh);` inside `map.on("load", ...)`:
```ts
createFilters(document.getElementById("app") as HTMLElement, visible, (v) => {
  visible = v;
  const f = buildIconFilter(v);
  map.setFilter("craft-icons", f);
  map.setFilter("craft-labels", f);
  map.setFilter("craft-sublabels", f);
});
```

- [ ] **Step 4: Typecheck + build**

Run: `npm run typecheck && npm run build`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/ui/filters.ts src/style.css src/main.ts
git commit -m "feat: filter drawer toggles craft kinds via live layer filter"
```

---

### Task 17: Status HUD + reconnect banner

**Files:**
- Create: `src/ui/hud.ts`
- Modify: `src/style.css` (append HUD styles), `src/main.ts` (feed counts + status)

**Interfaces:**
- Produces: `function createHud(root: HTMLElement): { setCounts(air: number, sea: number): void; setStatus(s: "connecting" | "open" | "closed"): void }`

- [ ] **Step 1: Write `src/ui/hud.ts`**

```ts
export type ConnStatus = "connecting" | "open" | "closed";

export function createHud(root: HTMLElement): {
  setCounts(air: number, sea: number): void;
  setStatus(s: ConnStatus): void;
} {
  const el = document.createElement("div");
  el.className = "hud";
  const dot = document.createElement("span");
  dot.className = "hud-dot";
  const status = document.createElement("span");
  status.className = "hud-status";
  status.textContent = "connecting";
  const counts = document.createElement("span");
  counts.className = "hud-counts";
  el.append(dot, status, counts);
  root.appendChild(el);

  function setCounts(air: number, sea: number): void {
    counts.textContent = `${air} air · ${sea} sea`;
  }

  function setStatus(s: ConnStatus): void {
    status.textContent = s;
    dot.dataset.state = s;
  }

  return { setCounts, setStatus };
}
```

- [ ] **Step 2: Append HUD styles to `src/style.css`**

```css
.hud {
  position: absolute;
  bottom: 12px;
  left: 50%;
  transform: translateX(-50%);
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 12px;
  background: var(--panel);
  border: 1px solid var(--border);
  border-radius: 999px;
  backdrop-filter: blur(8px);
  font-size: 12px;
  z-index: 10;
}
.hud-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: #ffb300;
}
.hud-dot[data-state="open"] {
  background: #66bb6a;
}
.hud-dot[data-state="closed"] {
  background: #ef5350;
}
.hud-status {
  color: var(--muted);
}
.hud-counts {
  color: var(--text);
}
```

- [ ] **Step 3: Feed the HUD in `src/main.ts`**

- Add import: `import { createHud } from "./ui/hud.js";`
- Add after `const panel = ...`: `const hud = createHud(document.getElementById("app") as HTMLElement);`
- Update `refresh()` to also set counts:
```ts
function refresh(): void {
  setCraftData(map, buildFeatureCollection(store.all()));
  let air = 0;
  let sea = 0;
  for (const c of store.all()) {
    if (c.domain === "air") air++;
    else sea++;
  }
  hud.setCounts(air, sea);
}
```
- Add `onStatus` to the `RadarSocket` handlers: `onStatus: (s) => hud.setStatus(s),`

- [ ] **Step 4: Typecheck + build**

Run: `npm run typecheck && npm run build`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/ui/hud.ts src/style.css src/main.ts
git commit -m "feat: status HUD with live counts + connection state"
```

---

### Task 18: Polish + README + live smoke test

**Files:**
- Create: `README.md`
- Modify: `src/style.css` (final polish), `.env.example` (verify)

**Interfaces:**
- Produces: a documented, runnable app; verified end-to-end.

- [ ] **Step 1: Write `README.md`**

```md
# Transponder Radar

A local, browser-based live world map of **aircraft** (ADS-B via OpenSky) and
**vessels** (AIS via aisstream.io). Per-kind icons, a click-to-open detail
panel, and a kind filter drawer.

## Setup

1. `npm install`
2. Create a free AIS key: <https://aisstream.io/account> (GitHub sign-in; the
   key is shown once — copy it now).
3. `cp .env.example .env` and paste your key into `AISSTREAM_API_KEY`.
   (Aircraft work without a key; vessels need it.)
4. `npm run dev`
5. Open <http://127.0.0.1:5173>.

## Scripts

| Command             | What it does                              |
| ------------------- | ----------------------------------------- |
| `npm run dev`       | Backend (`:8787`) + frontend (`:5173`)    |
| `npm test`          | Unit + integration tests (Vitest)         |
| `npm run typecheck` | `tsc --noEmit`                            |
| `npm run build`     | Production frontend build → `dist/`       |
| `npm start`         | Backend API + WS on `:8787` (prod)        |

## How it works

A single Node backend (Fastify + `ws`) polls OpenSky and subscribes to
aisstream.io, normalizes both into one `Craft` model, keeps an in-memory store,
and pushes a snapshot + ~1Hz deltas to the browser over WebSocket. The browser
(Vite + vanilla TS + MapLibre GL JS) renders all craft as a GeoJSON source with
data-driven icon/label layers.

- **Aircraft** = ADS-B (OpenSky `states/all`, free, no key).
- **Vessels** = AIS (aisstream.io, free key).
- Stale craft dim after 2 min; removed after 10 min. Air craft missing from a
  fresh OpenSky snapshot are pruned after a 30 s grace.

## Layout

- `shared/craft.ts` — the `Craft` model + 14 kinds (imported by both sides).
- `server/` — config, classify, normalize, store, opensky, ais, hub, bootstrap.
- `src/` — map, data (store/ws/features/filter), ui (panel/filters/hud), icons.
- `test/` — Vitest unit + integration (stub feeds → full pipeline).
```

- [ ] **Step 2: Verify `.env.example` matches config knobs**

Confirm `.env.example` contains `AISSTREAM_API_KEY`, `PORT`, `OPENSKY_POLL_MS`, `BATCH_MS`, `STALE_MS`, `REMOVE_MS`. (Created in Task 1.)

- [ ] **Step 3: Run the full test suite + typecheck + build**

Run: `npm test && npm run typecheck && npm run build`
Expected: ALL PASS.

- [ ] **Step 4: Live smoke test (backend)**

Run: `npm run dev` (leave running in a background terminal).
Then:
```bash
curl -s http://127.0.0.1:8787/health
```
Expected: `{"ok":true,"craft":N,"clients":0}` with `N` growing over ~10 s (OpenSky polling). If `AISSTREAM_API_KEY` is set, vessel craft also appear.

- [ ] **Step 5: Live smoke test (frontend, manual)**

Open <http://127.0.0.1:5173> in a browser and verify:
- [ ] Dark world map renders (Carto basemap).
- [ ] Aircraft icons appear and move; zoom in → labels, then sublabels.
- [ ] (With AIS key) vessel icons appear.
- [ ] Click a craft → detail panel shows the right per-domain fields.
- [ ] Filter drawer toggles kinds on/off live.
- [ ] HUD shows connection state + air/sea counts.
- [ ] Kill the backend, confirm HUD dot turns red ("closed"), restart backend, confirm it reconnects and turns green ("open").

- [ ] **Step 6: Commit**

```bash
git add README.md src/style.css .env.example
git commit -m "docs: README + setup; polish styles"
```

---

## Plan Self-Review

**Spec coverage:**
- Live world map, aircraft + vessels, per-kind icons, detail panel, filter drawer → Tasks 12-17. ✔
- Backend aggregator (mandatory due to CORS + AIS key) → Tasks 1-10. ✔
- One `Craft` model, 14 kinds, air/sea discriminators → Task 1. ✔
- Classification (air callsign/SPI, sea AIS type) → Tasks 2-3. ✔
- Normalization + unit conversion → Tasks 4-5. ✔
- In-memory store, stale/remove thresholds, air fast-path prune → Task 6. ✔
- OpenSky poller (5 s), AIS client (WS, static join, reconnect) → Tasks 7-8. ✔
- WS hub: snapshot on connect + ~1 Hz batched deltas → Task 9. ✔
- Graceful degradation (dead feed dims then empties, no crash) → Tasks 7-8 (poll catch, reconnect) + Task 17 (HUD). ✔
- MapLibre + Carto dark basemap + zoom tiers → Tasks 12-13. ✔
- Vite + vanilla TS, shared model imported by both sides → Tasks 1, 11-14. ✔
- Ports 8787/5173, Vite proxy → Tasks 1, 14. ✔
- Secrets in `.env` (git-ignored) → Tasks 1, 18. ✔
- Non-goals respected (no auth/DB/replay/airframe-type) → none introduced. ✔

**Type consistency (checked across tasks):**
- `Craft` fields identical in `shared/craft.ts` (Task 1) and all consumers. ✔
- `CraftKind` 14 members match `KINDS`, `AIR_KINDS`, `SEA_KINDS`, icon files, and filter `TINY_KINDS`. ✔
- WS wire types `{type:"snapshot",craft}` / `{type:"update",upsert,remove}` match `Hub` (Task 9) and `parseRadarMessage` (Task 11). ✔
- `buildIconFilter` (Task 11) returns the expression consumed by `addCraftLayers` (Task 13) and `map.setFilter` (Task 16). ✔
- `FeatureCollection` from `features.ts` (Task 11) is the type `setCraftData` (Task 13) accepts. ✔

**No placeholders:** every task has complete file contents and exact commands. Rendering tasks (12-14, 15-17) are verified by `typecheck` + `build` + the Task 18 live smoke, since they require a browser.

**Execution note:** Tasks 1-10 are strictly sequential (each builds on prior modules). Tasks 11-14 are sequential (11 → 12 → 13 → 14). Tasks 15-17 are sequential (each edits `main.ts`). Task 18 is last. A single implementer subagent can run them in order; a fresh reviewer subagent verifies each task's diff + tests before the next begins.
