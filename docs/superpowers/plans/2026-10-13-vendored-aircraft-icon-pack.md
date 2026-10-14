# Vendored Aircraft Icon Pack — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the hand-drawn 13 family silhouettes as the *primary* aircraft
icon source with a vendored ~250–270-type per-model silhouette pack (downloaded
once at first server start into `data/icons/`), keeping the family icons as the
fallback layer.

**Architecture:** A committed source manifest (`server/iconpack-sources.json`,
pinned commits + a public-domain gap-fill file list) drives an `IconPack`
server class that downloads/verifies/Indexes the three sources into gitignored
`data/icons/` and serves them over `GET /icons/*`. The existing resolver
(`server/icons.ts`) gains an optional pack-name set and emits namespaced pack
names (`pw:`/`rk:`/`pd:`) where the table says to; everything else falls back
to the 13 family icons exactly as today. The client lazily registers pack
icons on demand (fetch → in-memory transform → fixed 96×96 raster →
`addImage`), with a failed-set fallback in the feature builder. A catalog
page is the browser-verification surface.

**Tech Stack:** Node (tsx) server, Fastify, vanilla TS client, MapLibre GL
JS v4. No new npm packages (git CLI + Node builtins only). Vitest.

**Spec:** `docs/superpowers/specs/2026-10-13-vendored-aircraft-icon-pack-design.md`

## Global Constraints

- **Gate after every task:** `npm test` → `npm run typecheck` →
  `npm run build`, all green. (`npm run lint` is broken repo-wide — NOT in
  the gate. The maplibre-gl >500 kB chunk warning is the accepted build
  exception.)
- **No new npm packages** (runtime or dev). Git CLI allowed (repo dependency).
  Node builtins only for download (`node:fs`, `node:crypto`,
  `node:child_process`, global `fetch`).
- **Offline-first (user constraint, 2026-10-14):** the app must run on slow /
  spotty internet. **Zero third-party network access at runtime.** The icon
  pack is downloaded only at setup (first start, or `npm run icons:setup` for
  a deliberate pre-warm), pinned in `server/iconpack-sources.json`, then
  served from `data/icons/` by the local server — the browser only ever
  fetches `/icons/*` from the local backend. A failed download keeps the
  last-good state (family icons when none) and retries on every subsequent
  start until it succeeds. The same rule already governs the FAA bulk
  database (local cache, `FAA_REFRESH_MS` cadence — daily default, weekly
  optional via the env var; documented in Task 10).
- **Vendored source files are never modified on disk** (spec R3). All
  transforms (line→fill, crop+binarize, recolor) happen in memory at
  rasterization time.
- **Never commit** `data/` (incl. `data/icons/`) or secret values.
- **The ~150 existing resolver tests in `test/icons.test.ts` keep passing
  unmodified** (no `pack` argument ≡ today's behavior).
- **Browser-only code** (canvas/WebGL/DOM fetch) is NOT unit-tested; the
  catalog page + the user's browser are the verification surface (repo
  convention).
- **TDD:** every task red → green → gate → commit. No placeholder code.
- Icon names: pack names are namespaced `pw:<D>`, `rk:<D>`, `pd:<X>`
  (spec R2); the 13 family names and 10 sea kind names stay bare.

## Review Focus

Failure modes the spec implies but no single test fully exercises — each is
pinned to the task that owns the code:

1. **rk line-art SVG whose outline layer has open or multiple paths**
   (VTOL, biplane, unusual airframes) → fill transform produces a garbled
   shape. Expected: catalog shows the artifact; curator vetoes via
   `exclude.json`; the craft renders its family icon. Pinned in Task 7
   (route test: vetoed name → 404) + Task 9 (features fallback test).
2. **pw SVG with non-white painted details** (rotor blades, cockpit glass)
   → `recolorPixels` recolors only near-white pixels, leaving detail colors.
   Expected: acceptable; catalog surfaces it; limitation documented in
   AGENTS.md. Pinned in Task 4 (recolorPixels unit test asserts only
   R,G,B ≥ 200 pixels change; a colored pixel is untouched).
3. **pd two-view PNG whose top view is not exactly the top half** → wrong
   crop. Expected: per-file `cropTopRatio` in the manifest (curator sets it
   after inspecting each image). Pinned in Task 1 (schema test) + Task 7
   (catalog honors the ratio in the crop rect).
4. **Timeline-rewound snapshot referencing a pack name that is since
   vetoed/missing** → no broken icon. Expected: family fallback. Pinned in
   Task 9 (features test: `iconRegistered` set without the name → family
   icon property).
5. **Concurrent first-frame `ensure()` for the same name** (a snapshot with
   100 C-172s) → one fetch, one registration. Browser-only; verified by the
   user in-browser via catalog + live map. In-flight dedupe map is required
   in Task 8 (code requirement, not unit-tested).

---

### Task 1: Source manifest + pack-name helpers (curation)

**Files:**
- Create: `server/iconpack-sources.json` (committed pins + pd manifest)
- Create: `server/iconpack-sources.ts` (typed loader)
- Modify: `shared/craft.ts` (add `PACK_NAME_PREFIXES`, `isPackIconName`)
- Test: `test/iconpack-sources.test.ts` (new), `test/shared-craft.test.ts`
  (extend)

**Interfaces:**
- Consumes: existing `KINDS`, `AIR_KINDS`, `SEA_KINDS`, `KIND_FALLBACK_ICON`
  from `shared/craft.ts` (for the collision checks).
- Produces:

```ts
// shared/craft.ts (new exports)
export const PACK_NAME_PREFIXES = ["pw:", "rk:", "pd:"] as const;
export function isPackIconName(name: string): boolean; // true iff a prefix matches

// server/iconpack-sources.ts
export interface PdSourceEntry {
  name: string;            // "pd:E3"
  file: string;            // "pd/e3.png" (relative to data/icons/)
  url: string;             // direct Commons file URL
  sha256: string;          // 64-char lowercase hex
  title: string;           // "Boeing E-3 Sentry"
  license: string;         // "Public Domain (US Government work)" etc.
  attribution: string;     // author/creator string
  cropTopRatio: number;    // 0 < r <= 1: fraction of image height that is the top view (0.5 for standard two-views)
}
export interface IconSources {
  pw: { repo: string; sha: string; license: string; attribution: string };
  rk: { repo: string; sha: string; license: string; attribution: string };
  pd: PdSourceEntry[];
  gapTargets: { designator: string; title: string }[]; // desired military types for the catalog gap list (covered or not)
}
export function loadIconSources(path?: string): IconSources; // default: server/iconpack-sources.json next to this file; throws on malformed JSON/shape
export function writeIconSources(s: IconSources, path?: string): void; // atomic write (tmp + rename) — repin helper
```

**Curation work (this task is mostly finding real values):**

1. `git ls-remote https://github.com/plane-watch/pw-silhouettes main` and
   `git ls-remote https://github.com/RexKramer1/AircraftShapesSVG main` →
   pin both HEAD shas (2026-10-13 recon: both repos, `main` branch).
2. Clone both repos (shallow) into a scratch dir OUTSIDE the repo (e.g. the
   session temp dir). Enumerate: pw `airframes/*.json` base names vs
   `silhouettes/*.svg` files (expect 108 airframes; silhouette file for
   `<X>` is `silhouettes/<X>-1.svg` if present else `silhouettes/<X>.svg`);
   rk `Shapes SVG/*.svg` base names (182).
3. Gap-fill curation — for each of `E3, B2, F14, F117, C5, C141, E4, KC10,
   AH64, CH47` (military types absent from both sets; `gapTargets` in the
   manifest = these plus the rk-covered names below, all with titles):
   search Wikimedia Commons for a **top-view-inclusive two-view silhouette**
   (prefer Greg Goebel "… two-view silhouette.png" files / US Government
   public-domain material). For each file found: record direct file URL,
   license (must be Public Domain or equivalent — verify per file),
   attribution, `cropTopRatio` (0.5 for standard two-views; adjust after
   inspecting the image), and compute sha256 of the downloaded bytes. Files
   not found in PD form → leave as gaps (no hand-drawn art — spec R5).
4. `gapTargets` full list: the 10 above (covered-or-gap) plus the rk-covered
   military designators with titles (C130, C17, H60, K35E, KC2, KC46, A10,
   B52, F15, F16, F18, F22, F35, P1, P3, P8, Q4, R135, S61, U2, UH1, V22,
   A400, SB39, E8, NH90, MI24) so the catalog's gap list is the full desired
   military set, covered names filtered out.
5. Write `server/iconpack-sources.json` with the real values. Licenses:
   pw = "CC BY-NC-SA 4.0", attribution "Plane Watch Contributors";
   rk = "GPL-3.0", attribution "RexKramer1" (per each repo's LICENSE/README).

- [ ] **Step 1: Write the failing tests**

`test/iconpack-sources.test.ts`:

```ts
import { loadIconSources } from "../server/iconpack-sources.js";

describe("iconpack-sources manifest", () => {
  const s = loadIconSources(); // committed file

  test("repos pinned with 40-hex shas and license/attribution", () => {
    for (const src of [s.pw, s.rk]) {
      expect(src.repo).toMatch(/^https:\/\/github\.com\//);
      expect(src.sha).toMatch(/^[0-9a-f]{40}$/);
      expect(src.license.length).toBeGreaterThan(0);
      expect(src.attribution.length).toBeGreaterThan(0);
    }
  });

  test("pd entries well-formed and unique", () => {
    expect(new Set(s.pd.map((e) => e.name)).size).toBe(s.pd.length);
    for (const e of s.pd) {
      expect(e.name).toMatch(/^pd:[A-Z0-9]+$/);
      expect(e.file).toMatch(/^pd\/.+\.png$/);
      expect(e.sha256).toMatch(/^[0-9a-f]{64}$/);
      expect(e.url).toMatch(/^https:\/\/(commons\.wikimedia\.org|upload\.wikimedia\.org)\//);
      expect(e.title.length).toBeGreaterThan(0);
      expect(e.license.length).toBeGreaterThan(0);
      expect(e.attribution.length).toBeGreaterThan(0);
      expect(e.cropTopRatio).toBeGreaterThan(0);
      expect(e.cropTopRatio).toBeLessThanOrEqual(1);
    }
  });

  test("gapTargets non-empty, unique designators", () => {
    expect(s.gapTargets.length).toBeGreaterThanOrEqual(10);
    expect(new Set(s.gapTargets.map((g) => g.designator)).size).toBe(s.gapTargets.length);
  });

  test("gapTargets designators are uppercase alphanumeric (ICAO-style)", () => {
    for (const g of s.gapTargets) expect(g.designator).toMatch(/^[A-Z0-9]{2,6}$/);
  });
  // (full collision validation — family/sea/tanker_air — lives in IconPack
  // index build, pinned in test/iconpack.test.ts Task 2.)
});
```

Extend `test/shared-craft.test.ts`:

```ts
test("isPackIconName matches exactly the documented prefixes", () => {
  for (const p of PACK_NAME_PREFIXES) expect(isPackIconName(p + "X")).toBe(true);
  expect(isPackIconName("pw")).toBe(false);
  expect(isPackIconName("narrowbody")).toBe(false);
  expect(isPackIconName("cargo")).toBe(false);
  expect(isPackIconName("")).toBe(false);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/iconpack-sources.test.ts test/shared-craft.test.ts`
Expected: FAIL — `server/iconpack-sources.ts` does not exist;
`isPackIconName` is not exported.

- [ ] **Step 3: Implement**

- `shared/craft.ts`: add the two exports (prefix check via
  `PACK_NAME_PREFIXES.some((p) => name.startsWith(p))`).
- `server/iconpack-sources.ts`: interfaces above; `loadIconSources` reads
  the JSON (default path via `new URL("./iconpack-sources.json",
  import.meta.url)`), parses, and shape-checks (missing key / bad sha shape
  → throw with the offending key); `writeIconSources` = `JSON.stringify(…,
  null, 2)` to a temp file + `renameSync`.
- `server/iconpack-sources.json`: the curated values from the curation work
  above (real shas, real pd URLs/sha256s, real gapTargets).

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/iconpack-sources.test.ts test/shared-craft.test.ts`
Expected: PASS.

- [ ] **Step 5: Gate + commit**

Run: `npm test && npm run typecheck && npm run build` — all green.

```bash
git add shared/craft.ts server/iconpack-sources.json server/iconpack-sources.ts test/iconpack-sources.test.ts test/shared-craft.test.ts
git commit -m "feat(iconpack): pinned source manifest + pack-name helpers"
```

---

### Task 2: IconPack core — verify, load, index, status, excludes

**Files:**
- Create: `server/iconpack.ts`
- Test: `test/iconpack.test.ts` (new)

**Interfaces:**
- Consumes: `IconSources`, `loadIconSources` (Task 1); `isPackIconName`,
  `KINDS`, `SEA_KINDS`, `KIND_FALLBACK_ICON` (`shared/craft.ts`).
- Produces (used by Tasks 3, 5, 7, 9):

```ts
export type IconPackState = "absent" | "downloading" | "ready" | "failed";
export interface IconStatus {
  state: IconPackState;
  count: number;          // resolvable icon count (index minus vetoed)
  updatedAt: number | null;
  lastError: string | null;
}
export type PackStyle = "filled" | "line" | "gapfill";
export interface PackIconEntry {
  name: string;           // "pw:B737" | "rk:C130" | "pd:E3"
  source: "pw" | "rk" | "pd";
  file: string;           // relative to data/icons/, e.g. "rk/C130.svg"
  style: PackStyle;
  title: string;
  license: string;
  cropTopRatio?: number;  // gapfill only
}
export interface IconPackTransport {
  cloneRepo(repo: string, sha: string, destDir: string): Promise<void>;
  fetchFile(url: string, destPath: string, sha256: string): Promise<void>;
}
export class IconPack {
  constructor(opts: {
    dir: string;                 // e.g. <cwd>/data/icons
    sources: IconSources;
    log?: (m: string) => void;
    transport?: IconPackTransport; // default wired in Task 3; tests inject fakes
    now?: () => number;
  });
  init(): Promise<void>;                    // never throws; failures land in status()
  status(): IconStatus;
  names(): ReadonlySet<string>;             // resolvable (index minus vetoed)
  entries(): PackIconEntry[];               // full index (catalog; includes vetoed)
  entry(name: string): PackIconEntry | undefined;
  isVetoed(name: string): boolean;
  fileBytes(name: string): { bytes: Buffer; contentType: "image/svg+xml" | "image/png" } | null; // null: unknown or vetoed
}
```

Behavior (spec §3–4):
- **Index build** (from a materialized dir): pw — for each
  `plane-watch/airframes/<X>.json`: svg = `plane-watch/silhouettes/<X>-1.svg`
  else `<X>.svg` (missing both → skip + log); name `pw:<X>`, style
  `filled`, title = `icao.designator` from the JSON (fallback `X`), license
  from `sources.pw`. rk — each `rk/<X>.svg`: name `rk:<X>`, style `line`,
  title from the SVG `<title>` element (fallback `X`). pd — from the
  manifest (style `gapfill`, `cropTopRatio`).
- **Validation:** names unique and prefix-consistent with source; referenced
  file exists and is non-empty (missing → skip + log); **any collision with
  the 13 family names, 10 sea names, or `tanker_air` → init fails**
  (curation bug, spec §3).
- **State machine:** `init()`: if `pins.json` present, its shas equal
  `sources`, and all index files exist → build index → `ready`. Else
  `downloading` → `transport` populates the dir → rebuild → `ready`.
  Transport error → `failed` (lastError = message). Before `init()` runs,
  status is `absent`. If pins verify but `index.json` is missing → rebuild
  from files without downloading.
- **Files:** `pins.json` =
  `{ pw: {repo, sha}, rk: {repo, sha}, pd: { [name]: sha256 }, writtenAt }`
  — written **last**, atomically (tmp + rename). `index.json` written on
  every successful build. `exclude.json` =
  `{ vetoed: string[], reasons?: Record<string, string> }` (optional;
  `names()`/`fileBytes()` honor it, `entries()` includes vetoed with a flag
  via a separate `isVetoed(name)` accessor).
- **`ATTRIBUTION.md`** generation is Task 3 (needs the real download path);
  Task 2 leaves it to the transport layer.

- [ ] **Step 1: Write the failing tests**

`test/iconpack.test.ts` — fixture helper: build a temp dir (pattern:
`test/faa.test.ts` — `fs.mkdtempSync(join(os.tmpdir(), …))`) containing:
`plane-watch/airframes/FOO.json` (`{ "icao": { "designator": "FOO" } }`),
`plane-watch/silhouettes/FOO-1.svg` (`<svg><rect/></svg>`),
`plane-watch/airframes/BAR.json`, `plane-watch/silhouettes/BAR.svg` (no
`-1`), `rk/BAZ.svg` (with `<title>BAZ Title</title>`), `pd/QUX.png`
(non-empty bytes), matching a fixture `IconSources` (pd entry
`pd:QUX` → `pd/QUX.png`, sha256 of those bytes). Fake transport:
`cloneRepo` copies the fixture pw/rk subtrees into `destDir`; `fetchFile`
copies `pd/QUX.png` (verifying sha256 like the real one).

```ts
test("absent before init; ready after download; names/status correct", async () => {
  const pack = new IconPack({ dir, sources: fixture, transport: fake });
  expect(pack.status().state).toBe("absent");
  await pack.init();
  expect(pack.status().state).toBe("ready");
  expect([...pack.names()].sort()).toEqual(["pd:QUX", "pw:BAR", "pw:FOO", "rk:BAZ"]);
  expect(pack.status().count).toBe(4);
  expect(pack.entry("rk:BAZ")?.title).toBe("BAZ Title");
  expect(pack.entry("pw:FOO")?.style).toBe("filled");
  expect(pack.entry("pd:QUX")?.cropTopRatio).toBe(0.5);
  expect(pack.fileBytes("rk:BAZ")?.contentType).toBe("image/svg+xml");
  expect(pack.fileBytes("nope")).toBeNull();
});

test("verified dir re-uses files without transport", async () => {
  // run init once (downloads); delete index.json; new IconPack with a
  // transport that THROWS if called → init still ready (rebuild from files)
});

test("collision with a family/sea name fails init", async () => {
  // fixture with airframes/tanker.json + silhouettes/tanker-1.svg
  // → status() state "failed", lastError mentions collision, names() empty
});

test("duplicate name fails init", async () => { /* pw:B737 and a pd entry named pw:B737… use a pd name colliding with an rk name is impossible (prefix); duplicate via two pd entries same name */ });

test("transport failure → failed state, no throw, names empty", async () => { /* fake throws; init resolves */ });

test("exclude.json vetoes names but entries() keeps them", async () => {
  // write exclude.json { vetoed: ["rk:BAZ"] } → names() size 3,
  // fileBytes("rk:BAZ") null, isVetoed("rk:BAZ") true, entries() length 4
});

test("sha256 mismatch in fetchFile surfaces as failed", async () => {
  // pd manifest sha256 wrong → fake fetchFile throws → init failed
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/iconpack.test.ts`
Expected: FAIL — module does not exist.

- [ ] **Step 3: Implement `server/iconpack.ts`** per the behavior block
  (state machine, index build, validation, pins/index/exclude files,
  `fileBytes`). No download implementation yet: default `transport` throws
  `"no transport"` (Task 3 replaces it).

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/iconpack.test.ts`
Expected: PASS.

- [ ] **Step 5: Gate + commit**

```bash
npm test && npm run typecheck && npm run build
git add server/iconpack.ts test/iconpack.test.ts
git commit -m "feat(iconpack): pack index, verification, status, excludes"
```

---

### Task 3: Real download transport, attribution, repin script

**Files:**
- Modify: `server/iconpack.ts` (default transport)
- Create: `scripts/repin-icons.ts`
- Create: `scripts/setup-icons.ts`
- Test: `test/iconpack.test.ts` (extend)

**Interfaces:**
- Consumes: Task 2 `IconPack`, `IconPackTransport`; Task 1
  `loadIconSources`/`writeIconSources`.
- Produces: default transport (no new exported surface); `npm run icons:repin`
  and `npm run icons:setup` scripts.

Default transport (real):
- `cloneRepo(repo, sha, destDir)`: `git init -q <tmp>` →
  `git -C <tmp> remote add origin <repo>` →
  `git -C <tmp> fetch -q --depth 1 origin <sha>` →
  `git -C <tmp> checkout -q FETCH_HEAD -- <subpath>` into `destDir` (pw
  subpath `silhouettes`, `airframes` → `destDir/plane-watch/…`; rk subpath
  `Shapes SVG` → `destDir/rk/` with spaces stripped from file names is NOT
  needed — copy preserving base names only). Use
  `node:child_process.execFile` with `cwd`; non-zero exit → throw with the
  stderr tail.
- `fetchFile(url, destPath, sha256)`: global `fetch` → `arrayBuffer` →
  `createHash("sha256")` → mismatch throws → `writeFileSync`.
- On successful init after download: write `ATTRIBUTION.md` into the dir —
  per source: license name, attribution, repo + pinned sha, URL; per pd
  file: title, license, attribution, URL; plus the standing note that
  distribution/productization would require re-licensing (spec §2).

`scripts/repin-icons.ts` (dev tool, run via tsx): read current shas via
`git ls-remote <repo> main` (execFile), update the pw/rk shas in
`server/iconpack-sources.json` (via `loadIconSources` + `writeIconSources`),
print the old→new shas, then instantiate `IconPack` with
`dir: data/icons` and `await init()` (fresh download), print the name-set
diff (previous `index.json` names vs new). No args.

`scripts/setup-icons.ts` (offline-first pre-warm): instantiate `IconPack`
with `dir: data/icons`, `await init()`, print the resulting `status()`
(state + count + lastError) — a deliberate one-shot download to run on good
Wi‑Fi before a spotty connection; identical to what first server start does.
No args.

Add to `package.json` scripts: `"icons:repin": "tsx scripts/repin-icons.ts"`,
`"icons:setup": "tsx scripts/setup-icons.ts"`.

- [ ] **Step 1: Write the failing tests** (extend `test/iconpack.test.ts`)

```ts
describe("default transport", () => {
  // real git clone of a TINY local repo fixture (init + commit 2 tiny files
  // in os.tmpdir) with a fake remote: use file:// URL of the local repo.
  test("cloneRepo fetches the pinned sha into destDir layout", async () => {
    // build local git repo in tmp with two files at two commits;
    // cloneRepo(repo=file://…, sha=<first commit sha>, destDir)
    // → expected files present in destDir
  });
  test("fetchFile verifies sha256 and writes bytes", async () => {
    // serve nothing: use a file:// URL? fetch does not support file:// —
    // spin up a node:http server on an ephemeral port serving one file
    // (pattern: test/faa.test.ts if it uses one, else http.createServer inline)
    // → correct sha writes; wrong sha → reject
  });
  test("init with default transport + ATTRIBUTION.md", async () => {
    // local git fixture repo (file://) + http fixture server for the pd file;
    // full init from empty dir → ready; ATTRIBUTION.md exists and contains
    // both license strings + the re-licensing note
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/iconpack.test.ts`
Expected: FAIL — default transport throws "no transport".

- [ ] **Step 3: Implement** the default transport + ATTRIBUTION.md in
  `server/iconpack.ts`; write `scripts/repin-icons.ts` + `scripts/setup-icons.ts`;
  add both package.json scripts.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/iconpack.test.ts`
Expected: PASS.

- [ ] **Step 5: Materialize the real pack on this machine** (setup, not
  tested): delete `data/icons/` if present, run `npm run icons:setup`,
  confirm `data/icons/index.json` exists and `ls data/icons` shows the three
  source dirs. Log the resolved name count. If the real download fails
  (network), record the error and stop — do NOT fake the manifest values.

- [ ] **Step 6: Gate + commit**

```bash
npm test && npm run typecheck && npm run build
git add server/iconpack.ts scripts/repin-icons.ts scripts/setup-icons.ts package.json test/iconpack.test.ts
git commit -m "feat(iconpack): pinned download transport, attribution, setup/repin scripts"
```

---

### Task 4: Shared icon transforms (pure, Node-testable)

**Files:**
- Create: `shared/pack-transforms.ts`
- Test: `test/pack-transforms.test.ts` (new)

**Interfaces:**
- Consumes: `AirKind` (`shared/craft.ts`).
- Produces (Task 7 catalog + Task 8 client):

```ts
export const PACK_COLORS = { military: "#ef5350", civil: "#4fc3f7" } as const;
export function domainColor(kind: string): string; // kind in AIR_KINDS && kind === "military" → military; other air → civil; sea → civil (sea never gets pack icons; kept total)

export function recolorPixels(data: Uint8ClampedArray, rgb: [number, number, number]): void;
// in place; for every pixel with alpha > 0 and r,g,b ALL >= 200: set rgb; alpha unchanged; all other pixels untouched (keeps the author's black hairline and any detail colors)

export function hexToRgb(hex: string): [number, number, number];

export function lineSvgToFill(svg: string, color: string): string;
// rk line-art → filled: keep ONLY the first visible top-level <g> (the Outline
// layer; layers are <g inkscape:groupmode="layer"> in document order, skip any
// with style containing "display:none"); drop all other <g>s, <defs>,
// <metadata>, <sodipodi:namedview>; on kept paths: "fill:none" →
// "fill:<color>", drop every "stroke:<anything>;stroke-width:<n>" pair and
// stroke-* presentation attrs; preserve the root <svg> viewBox/width/height
// (strip inkscape/sodipodi namespaces from the root tag output is fine — the
// browser only needs xmlns + viewBox)
```

- [ ] **Step 1: Write the failing tests**

`test/pack-transforms.test.ts` — fixtures: a mini C130-style SVG (root with
viewBox, `<sodipodi:namedview>`, `<metadata>`, first `<g>` Outline with one
closed path `style="fill:none;stroke:#000000;stroke-width:0.264583px"`,
second `<g>` Accent with an open path), a mini pw-style SVG (hidden
Reference layer `display:none` with a base64 `<image>`, visible Outline layer
`fill:#ffffff;stroke:#000000`).

```ts
test("domainColor", () => {
  expect(domainColor("military")).toBe("#ef5350");
  for (const k of ["commercial", "business", "general"]) expect(domainColor(k)).toBe("#4fc3f7");
  expect(domainColor("cargo")).toBe("#4fc3f7");
});

test("recolorPixels recolors near-white, keeps alpha, keeps black + colored pixels", () => {
  const d = new Uint8ClampedArray([
    255, 255, 255, 255, // white → recolor
    240, 240, 240, 128, // near-white, half alpha → recolor, alpha kept
    0, 0, 0, 255,       // black hairline → untouched
    120, 60, 200, 255,  // colored detail → untouched (g,b < 200)
    201, 201, 201, 1,   // faint white edge → recolor
    255, 255, 255, 0,   // transparent white → untouched (alpha 0)
  ]);
  recolorPixels(d, [239, 83, 80]);
  expect(Array.from(d.slice(0, 4))).toEqual([239, 83, 80, 255]);
  expect(Array.from(d.slice(4, 8))).toEqual([239, 83, 80, 128]);
  expect(Array.from(d.slice(8, 12))).toEqual([0, 0, 0, 255]);
  expect(Array.from(d.slice(12, 16))).toEqual([120, 60, 200, 255]);
  expect(Array.from(d.slice(16, 20))).toEqual([239, 83, 80, 1]);
  expect(Array.from(d.slice(20, 24))).toEqual([255, 255, 255, 0]);
});

test("lineSvgToFill keeps only the outline layer, fills, drops stroke + metadata + accent", () => {
  const out = lineSvgToFill(rkFixture, "#ef5350");
  expect(out).toContain("viewBox");
  expect(out).toContain("fill:#ef5350");
  expect(out).not.toContain("stroke:#000000");
  expect(out).not.toContain("Accent");
  expect(out).not.toContain("<metadata");
  expect(out.match(/<path/g)?.length).toBe(1); // outline path only
});

test("lineSvgToFill passes through a pw-style svg unchanged in layer count but still fills", () => {
  // pw SVG has a display:none layer that must be skipped: first VISIBLE g wins
  const out = lineSvgToFill(pwFixture, "#4fc3f7");
  expect(out).toContain("fill:#4fc3f7");
  expect(out).not.toContain("display:none");
});

test("hexToRgb", () => { expect(hexToRgb("#ef5350")).toEqual([239, 83, 80]); });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/pack-transforms.test.ts`
Expected: FAIL — module does not exist.

- [ ] **Step 3: Implement `shared/pack-transforms.ts`** (string surgery on
  SVG: split top-level `<g …>…</g>` blocks by depth counting — no XML
  parser; regex the path `style=` attributes).

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/pack-transforms.test.ts`
Expected: PASS.

- [ ] **Step 5: Gate + commit**

```bash
npm test && npm run typecheck && npm run build
git add shared/pack-transforms.ts test/pack-transforms.test.ts
git commit -m "feat(iconpack): shared silhouette transforms (recolor, line-to-fill)"
```

---

### Task 5: Resolver pack emission + military table curation

**Files:**
- Create: `server/icon-tables.ts` (tables moved out of `server/icons.ts` + extended)
- Modify: `server/icons.ts` (`resolveAirIcon` gains `pack?`)
- Modify: `server/index.ts` (`buildApp` wiring — `pack` set passed)
- Test: `test/icons.test.ts` (extend — existing tests untouched and green)

**Interfaces:**
- Consumes: `isPackIconName` (Task 1); `IconPack.names()` (Task 2).
- Produces:

```ts
// server/icons.ts
export function resolveAirIcon(args: {
  kind: AirKind;
  callsign: string | null;
  faaModel: string | null;
  faaMfr: string | null;
  pack?: ReadonlySet<string>;   // pack names; undefined/empty ≡ today's behavior
}): string
// rule for both tables: table entry { …, pack?: string, family: string }
// → if args.pack && entry.pack && args.pack.has(entry.pack) return entry.pack
// → else entry.family  (identical to today when pack is absent/misses)
```

Military table curation (values): for every military designator in
`gapTargets` that is covered (rk: or pd:), add a `pack` name to the
corresponding existing token entry (or a new entry where the token table has
none). Examples (curation fills the full set against the real
`data/icons/index.json` name list from Task 3): `C130\b` → `pack: "rk:C130"`,
`U?H?60\w*` → `pack: "rk:H60"` (fixes the parked letter-suffix minor:
`UH60A`/`MH60` now match), `E3\w*` (prefix rule, as today) →
`pack: "pd:E3"` if pd:E3 was found else keep family-only, `KC135\w*` →
`"rk:R135"`, `AH64\w*` → pack if found, `CH47\w*` → pack if found,
`B52\w*` → `"rk:B52"`, `F16\w*` → `"rk:F16"` (or `pw:F16` if curation
prefers the filled art — curation call, recorded in a comment), `MQ9|Q4\w*`
→ `"rk:Q4"`, `A400\w*` → `"rk:A400"`, `V22\w*` → `"rk:V22"`,
`C17\w*` → `"rk:C17"`, `P3\w*` → `"rk:P3"`, `U2\w*` → `"rk:U2"`, etc.
**Existing word-anchoring and prefix rules are preserved** — only `pack`
fields and the letter-suffix anchors change.

`server/icon-tables.ts` exports (moved verbatim from `server/icons.ts`,
then extended):

```ts
export interface MilitaryRule { re: RegExp; anchor: "word" | "prefix"; pack?: string; family: string; }
export interface CivilRule { mfr?: string[]; re: RegExp; pack?: string; family: string; }
export const MILITARY_RULES: MilitaryRule[];  // existing military token table
export const CIVIL_RULES: CivilRule[];        // existing ordered FAA model table (Task 6 adds pack names)
```

`buildApp` wiring (server/index.ts): `resolveIcon: (c) => { …
resolveAirIcon({ …, pack: iconPack?.names() }) }` — `iconPack` is added to
`buildApp` deps/default construction in **Task 7** (this task wires the
parameter path with a local `const iconPack = deps.iconPack` placeholder
interface so the code compiles; Task 7 completes the wiring).

- [ ] **Step 1: Write the failing tests** (extend `test/icons.test.ts`; do
  NOT edit existing test cases)

```ts
describe("resolver pack emission", () => {
  const pack = new Set(["rk:C130", "rk:H60", "pd:E3", "rk:R135"]);

  test("military token emits pack name when present", () => {
    expect(resolveAirIcon({ kind: "military", callsign: "C130", faaModel: null, faaMfr: null, pack })).toBe("rk:C130");
    expect(resolveAirIcon({ kind: "military", callsign: "UH60A", faaModel: null, faaMfr: null, pack })).toBe("rk:H60");
    expect(resolveAirIcon({ kind: "military", callsign: "E3", faaModel: null, faaMfr: null, pack })).toBe("pd:E3");
  });

  test("pack name absent from set → family fallback (today's behavior)", () => {
    expect(resolveAirIcon({ kind: "military", callsign: "C130", faaModel: null, faaMfr: null, pack: new Set() })).toBe("transport");
    expect(resolveAirIcon({ kind: "military", callsign: "C130", faaModel: null, faaMfr: null })).toBe("transport"); // no pack arg at all
  });

  // civil pack emission is curation-dependent → pinned in Task 6's tests

  test("military without callsign → family fallback (unchanged)", () => {
    expect(resolveAirIcon({ kind: "military", callsign: null, faaModel: null, faaMfr: null, pack })).toBe("fighter");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/icons.test.ts`
Expected: NEW tests FAIL (pack arg not supported / table has no pack names);
existing tests still PASS.

- [ ] **Step 3: Implement** — move tables to `server/icon-tables.ts`
  (verbatim), add `pack` fields per curation, add the `pack?` param + rule
  to `resolveAirIcon`, update the `buildApp` call site (placeholder wiring).

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/icons.test.ts test/integration.test.ts`
Expected: ALL PASS (existing ~150 untouched + new).

- [ ] **Step 5: Gate + commit**

```bash
npm test && npm run typecheck && npm run build
git add server/icon-tables.ts server/icons.ts server/index.ts test/icons.test.ts
git commit -m "feat(iconpack): resolver emits pack names for covered military types"
```

---

### Task 6: Civil table curation (data-driven pack designators)

**Files:**
- Modify: `server/icon-tables.ts` (CIVIL_RULES pack names)
- Test: `test/icons.test.ts` (extend)

**Curation work:** with `data/icons/index.json` (Task 3) and
`data/faa/ACFTREF.txt` available on this machine (if `data/faa` is absent,
run the server once to warm the FAA cache first — log a `Ruling:` if the
cache had to be warmed): for each `pw:`/`rk:` name in the index, find the
FAA MFR MDL CODE(s) it covers (ACFTREF subvariant strings, e.g. `737-8DR`),
and set `pack` on the matching CIVIL_RULE (creating the rule where the
family table has none — ordered helis-first, most-specific-first, per the
existing table's documented ordering). Prefer `pw:` art for types present in
both. Rules with no covered pack type are untouched. Target: ≥ 150
CIVIL_RULES carry a `pack` name (log the actual count in the commit
message).

- [ ] **Step 1: Write the failing tests** (extend `test/icons.test.ts`)

A table-driven case: for ≥ 25 representative civil models (curation picks
across families: `737-800`→B738 pw, `A320-214`→A320 pw, `744-4H6`→B744
rk-or-pw per curation, `172S`→C172 pw, `208B`→C208, `PC-12/47`→PC12 pw,
`DH-8-100`→DH8D per curation, `G-VII`→C72R per curation, `A22-100`→A20N per
curation, one heli: `R44`→R44 pw-or-rk, one bizjet: `G-650`→C560 per
curation, …), assert the exact expected pack name against a fixture pack set
containing those names. Format per row: `{ model, mfr, expected }` —
`expected` is the pack name the curation work (above) chose for that rule;
the tests are written from that choice, so they fail while the rules carry
no `pack` field (red) and pin the curation against drift (the regression
lock).

- [ ] **Step 2: Run tests to verify they fail** — new rows FAIL (pack not
  set), existing PASS.

- [ ] **Step 3: Implement** the `pack` names per curation.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/icons.test.ts`
Expected: ALL PASS.

- [ ] **Step 5: Gate + commit** (commit message includes the count of rules
  carrying pack names, e.g. `feat(iconpack): civil resolver pack names (172 rules)`)

```bash
npm test && npm run typecheck && npm run build
git add server/icon-tables.ts test/icons.test.ts
git commit -m "feat(iconpack): civil resolver pack names (<N> rules)"
```

---

### Task 7: Server routes, catalog page, status frame

**Files:**
- Create: `server/icons-catalog.ts`
- Modify: `server/index.ts` (IconPack construction + routes + statusPayload +
  complete the `resolveIcon` pack wiring from Task 5)
- Modify: `server/hub.ts` (`StatusPayload` gains `icons`)
- Modify: `vite.config.ts` (proxy `/icons`)
- Test: `test/icons-catalog.test.ts` (new), `test/integration.test.ts`
  (extend), `test/hub.test.ts` (extend for the status field)

**Interfaces:**
- Consumes: `IconPack` (Tasks 2–3), `loadIconSources` (Task 1),
  `lineSvgToFill`, `PACK_COLORS` (Task 4).
- Produces:

```ts
// server/icons-catalog.ts
export interface CatalogCell {
  name: string; title: string; license: string; style: PackStyle;
  svg?: string;          // pw/rk raw svg text
  pngDataUrl?: string;   // pd, "data:image/png;base64,…"
  color: string;         // source-based preview color: pw → civil, rk/pd → military (page header notes final on-map color follows craft kind)
  vetoed: boolean;
  cropTopRatio?: number;
}
export function renderCatalog(opts: {
  cells: CatalogCell[];
  staticIcons: { name: string; svg: string; color: string | null }[]; // the 13 families + 10 sea, read from src/assets/icons
  gaps: { designator: string; title: string }[];
}): string
// one dark-themed grid; per cell: inline preview (pw: fill #ffffff→color
// string-replace keeping stroke; rk: lineSvgToFill(svg,color); pd: <img>
// with the CSS single-colorize filter + cropTopRatio crop rect), name,
// title, license; vetoed cells dimmed + "vetoed" badge; gaps section lists
// gaps (gapTargets minus covered names) with designator + title; header
// shows counts + the color-note
```

`server/hub.ts`:

```ts
export interface StatusPayload {
  feeds: FeedStatus;
  history: HistoryRange;
  faa: FaaStatus;
  icons: IconStatus;        // import type from ./iconpack.js
}
```
(`StatusMessage` in `src/data/ws.ts` gets the mirror in Task 9.)

`server/index.ts` `buildApp`: `const iconPack = deps.iconPack ?? new
IconPack({ dir: resolve(process.cwd(), "data/icons"), sources:
loadIconSources(), log })`; `if (deps.iconPack === undefined)
void iconPack.init().catch((e) => log(\`iconpack: init failed — family icons only (\${e instanceof Error ? e.message : String(e)})\`))`;
`ServerDeps` gains `iconPack?: IconPack`; `statusPayload` adds
`icons: iconPack.status()`; `resolveIcon` passes `pack: iconPack.names()`
(replacing the Task 5 placeholder); routes (registered **before** the
`fastifyStatic` dist fallback):

```ts
// color is source-based: pw → PACK_COLORS.civil, rk/pd → PACK_COLORS.military
// (imported from shared/pack-transforms.js); the catalog header notes the
// final on-map color follows the craft's kind
app.get("/icons/list", async () => ({
  entries: iconPack.entries().map(({ name, style, cropTopRatio, source }) => ({
    name, style, cropTopRatio,
    color: source === "pw" ? PACK_COLORS.civil : PACK_COLORS.military,
  })),
}));
app.get("/icons/catalog", async () => renderCatalog({ …read cells from iconPack.entries() + fs… }));
app.get("/icons/:name", async (req, reply) => {
  const f = iconPack.fileBytes(req.params.name as string);
  if (!f) return reply.code(404).send({ error: "unknown icon" });
  return reply.type(f.contentType).send(f.bytes);
});
```

`vite.config.ts`: add `"/icons": { target: "http://127.0.0.1:2001" }` to the
proxy map.

- [ ] **Step 1: Write the failing tests**

`test/icons-catalog.test.ts` (pure):

```ts
test("catalog contains every cell, static icons, gaps, and veto badges", () => {
  const html = renderCatalog({
    cells: [
      { name: "pw:B737", title: "B737", license: "CC BY-NC-SA 4.0", style: "filled", svg: "<svg><path style=\"fill:#ffffff\"/></svg>", color: "#4fc3f7", vetoed: false },
      { name: "rk:C130", title: "C-130", license: "GPL-3.0", style: "line", svg: rkMini, color: "#ef5350", vetoed: true },
      { name: "pd:E3", title: "E-3", license: "Public Domain", style: "gapfill", pngDataUrl: "data:image/png;base64,AAAA", color: "#ef5350", vetoed: false, cropTopRatio: 0.5 },
    ],
    staticIcons: [{ name: "narrowbody", svg: "<svg></svg>", color: "#4fc3f7" }],
    gaps: [{ designator: "E4", title: "Boeing E-4" }],
  });
  expect(html).toContain("pw:B737");
  expect(html).toContain("fill:#4fc3f7");            // filled cell recolored
  expect(html).toContain("rk:C130");
  expect(html).toContain("vetoed");
  expect(html).toContain("fill:#ef5350");            // line cell transformed
  expect(html).toContain("data:image/png;base64,AAAA");
  expect(html).toContain("Boeing E-4");
  expect(html).toContain("narrowbody");
});
```

Extend `test/integration.test.ts` (buildApp with injected fixture IconPack —
same fixture-dir pattern as `test/faa.test.ts`; add `deps.iconPack`):

```ts
test("GET /icons/list returns entries; /icons/:name serves bytes or 404s", async () => {
  // fixture pack ready in tmp dir
  const { app } = await buildApp({ iconPack: fixturePack, /* other deps as in existing tests */ });
  expect((await app.inject({ url: "/icons/list" })).json().entries.length).toBeGreaterThan(0);
  expect((await app.inject({ url: "/icons/rk:BAZ" })).statusCode).toBe(200); // URL-encode the colon in inject
  expect((await app.inject({ url: "/icons/nope" })).statusCode).toBe(404);
});
test("GET /icons/catalog is 200 text/html and lists names", async () => { … });
test("status frame carries icons block", async () => {
  // attach a fake ws client, capture the status frame JSON → .icons.state === "ready", .icons.count matches fixture
});
```

Extend `test/hub.test.ts`: `statusPayload` now requires `icons` — update the
existing payload builders with an `icons: { state: "ready", count: 0, updatedAt: null, lastError: null }` stub (mechanical); add one test asserting the status frame the hub sends includes the `icons` key.

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/icons-catalog.test.ts test/integration.test.ts test/hub.test.ts`
Expected: new tests FAIL; hub tests may FAIL on the new required field (expected — implement).

- [ ] **Step 3: Implement** per the Interfaces block.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/icons-catalog.test.ts test/integration.test.ts test/hub.test.ts`
Expected: PASS.

- [ ] **Step 5: Gate + commit**

```bash
npm test && npm run typecheck && npm run build
git add server/icons-catalog.ts server/index.ts server/hub.ts vite.config.ts test/icons-catalog.test.ts test/integration.test.ts test/hub.test.ts
git commit -m "feat(iconpack): /icons routes, catalog page, status frame"
```

---

### Task 8: Client pack loader (browser-only)

**Files:**
- Create: `src/map/pack-icons.ts`

No unit tests (canvas/DOM/fetch — repo convention; the catalog page from
Task 7 + the user's browser are the verification surface, Review Focus #1/#2/#5).

**Interfaces:**
- Consumes: `lineSvgToFill`, `recolorPixels`, `hexToRgb` (Task 4);
  `isPackIconName` (Task 1); the `/icons/list` entry's `color` field
  (Task 7 Step 2) — the loader does not compute colors itself.
- Produces (Task 9):

```ts
export interface PackIconLoader {
  ensure(names: Iterable<string>): Promise<ReadonlySet<string>>; // pack names successfully registered (incl. already-registered); non-pack names ignored
  failed(): ReadonlySet<string>;
}
export function createPackIconLoader(map: maplibregl.Map, opts?: { fetchImpl?: typeof fetch }): PackIconLoader;
```

Behavior:
- `ensure()`: for each pack name not `map.hasImage(name)` and not in the
  in-flight map: fetch `GET /icons/list` once (cached) to learn
  `style`/`cropTopRatio`; fetch `/icons/<name>`; transform per style —
  `line`: `lineSvgToFill(text, domainColor-by-source… see below)`;
  `filled`: raw svg; `gapfill`: PNG → canvas.
- Color per craft domain is unknown at registration (same icon can serve any
  domain? no — a pack name maps to one aircraft type; its domain is fixed by
  the resolver: military types red, civil types blue). The loader gets color
  from `/icons/list` — **add `color` to the list entry in Task 7's response**
  (server computes it: `pd`/`rk` sources default military, `pw` default
  civil — curation can override via the manifest later; for now source-based,
  matching the catalog). Rasterize every icon into a **fixed 96×96 canvas**
  (SVG: `img` decode at natural size, `drawImage` centered into 96×96 with
  preserveAspectRatio; gapfill PNG: draw the crop rect
  `[0, 0, w, h*cropTopRatio]` scaled into 96×96, then threshold
  `lum = 0.2126r + 0.7152g + 0.0722b` → `alpha = lum < 128 ? 255 : 0`).
  Then `recolorPixels` (near-white → color; for gapfill every opaque pixel is
  black → set all opaque rgb to color directly).
- `map.addImage(name, imageData, { pixelRatio: 2 })`; cache
  `Map<name, ImageData>`; **in-flight dedupe** `Map<name, Promise>` (Review
  Focus #5). First successful `ensure()` registers
  `map.on("style.load", re-add all cached names)` once (guard `hasImage`).
- Any per-name failure (404/decode/empty raster) → name into the failed set;
  `ensure()` never rejects.

- [ ] **Step 1: Implement `src/map/pack-icons.ts`** per the behavior block
  (no tests by convention).

- [ ] **Step 2: Verify the list endpoint carries color**

Task 7's `/icons/list` already emits `color` per entry — extend the Task 7
integration test assertion (one red→green cycle: assert
`entries[0].color ∈ {PACK_COLORS.civil, PACK_COLORS.military}` first, watch
it fail if the field is missing from a stale worktree, confirm green).

- [ ] **Step 3: Gate**

Run: `npm test && npm run typecheck && npm run build`
Expected: green (this task is browser-verified later, not unit-verified).

- [ ] **Step 4: Commit**

```bash
git add src/map/pack-icons.ts server/index.ts test/integration.test.ts
git commit -m "feat(iconpack): client pack-icon loader (lazy, 96px, re-register on style load)"
```

---

### Task 9: Client wiring — features fallback, refresh, HUD, status type

**Files:**
- Modify: `src/data/features.ts` (`iconRegistered` opt)
- Modify: `src/data/ws.ts` (`StatusMessage.icons`; client `IconStatus` mirror)
- Modify: `src/ui/hud.ts` (`setIcons`)
- Modify: `src/main.ts` (pack loader in `refresh`, status wiring, HUD)
- Test: `test/features.test.ts` (extend)

**Interfaces:**
- Consumes: `PackIconLoader` (Task 8); `isPackIconName` (Task 1);
  `KIND_FALLBACK_ICON` (existing).
- Produces:

```ts
// src/data/features.ts
export function buildFeatureCollection(crafts: Craft[], opts?: { iconRegistered?: ReadonlySet<string> }): FeatureCollection
// icon property: c.icon ?? familyFallback, EXCEPT when isPackIconName(c.icon)
// and (opts.iconRegistered === undefined || opts.iconRegistered.has(c.icon)):
//   pack name present & registered (or opt omitted) → c.icon
//   pack name present & NOT in the set → KIND_FALLBACK_ICON[kind as AirKind]
// sea icons and family names pass through unchanged

// src/ui/hud.ts
setIcons(i: IconStatus | null): void;
// new span .hud-icons: null → hidden; ready → `Icons: ${count}`;
// downloading → "Icons: …"; failed → "Icons: offline"; absent → hidden
```

- [ ] **Step 1: Write the failing tests** (extend `test/features.test.ts`)

```ts
test("pack icon registered → passes through", () => {
  const fc = buildFeatureCollection([airCraft({ icon: "rk:C130" })], { iconRegistered: new Set(["rk:C130"]) });
  expect(fc.features[0].properties.icon).toBe("rk:C130");
});
test("pack icon not registered → family fallback (Review Focus #4)", () => {
  const fc = buildFeatureCollection([airCraft({ icon: "rk:C130", kind: "military" })], { iconRegistered: new Set() });
  expect(fc.features[0].properties.icon).toBe("fighter");
});
test("opt omitted → pack names pass through (back-compat)", () => {
  const fc = buildFeatureCollection([airCraft({ icon: "pw:B737" })]);
  expect(fc.features[0].properties.icon).toBe("pw:B737");
});
test("non-pack icons and sea craft unaffected by the opt", () => { … "narrowbody" passes; sea icon "cargo" passes … });
```

- [ ] **Step 2: Run tests to verify they fail** — new tests FAIL; existing
  PASS.

- [ ] **Step 3: Implement** the `features.ts` rule; `ws.ts`
  `StatusMessage` gains `icons: IconStatus` (interface mirrored from
  `server/iconpack.ts` — re-declare in ws.ts like the other server types,
  do NOT import server code); `hud.ts` `setIcons`; `main.ts`:
  - after `registerIcons(map)`: `const packLoader = createPackIconLoader(map);`
  - `refresh()` becomes `async () => { const crafts = store.all();
    const packNames = new Set(crafts.map((c) => c.icon).filter((n): n is string => Boolean(n) && isPackIconName(n)));
    const registered = await packLoader.ensure(packNames);
    setCraftData(map, buildFeatureCollection(crafts, { iconRegistered: registered }));
    …rest unchanged… }`; `store.subscribe(() => { void refresh(); });`
  - `onStatus`: `hud.setIcons(s.icons);` (alongside `hud.setFeeds`).

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/features.test.ts`
Expected: PASS.

- [ ] **Step 5: Gate + commit**

```bash
npm test && npm run typecheck && npm run build
git add src/data/features.ts src/data/ws.ts src/ui/hud.ts src/main.ts test/features.test.ts
git commit -m "feat(iconpack): client wiring — lazy registration, fallback, HUD"
```

---

### Task 10: Registry test, docs, final gate

**Files:**
- Modify: `test/air-icons.test.ts` (registry test)
- Modify: `AGENTS.md`
- Modify: spec + this plan (status → implemented)

- [ ] **Step 1: Extend the registry test** (`test/air-icons.test.ts`):
  keep the existing 23-name assertions; add: `isPackIconName` round-trip for
  the three prefixes; an index-collision assertion using a small inline
  fixture `PackIconEntry[]` (one colliding with a sea name → expect the
  IconPack validation to reject — call `IconPack` with a fixture transport
  like Task 2, or assert the pure validation helper if factored out —
  implementer's choice, pinned by the test written first).

- [ ] **Step 2: Update `AGENTS.md`**:
  - Architecture: add `server/iconpack.ts` / `server/icon-tables.ts` /
    `server/icons-catalog.ts` / `src/map/pack-icons.ts` /
    `shared/pack-transforms.ts` to the module list.
  - New "Icon pack" section: the three sources + licenses + the
    open-source/productization constraint note; `data/icons/` layout
    (gitignored — delete to force re-download); setup is automatic at first
    start (`npm run icons:setup` for a deliberate pre-warm on good Wi‑Fi,
    `npm run icons:repin` to move the pins forward); **offline-first: no
    third-party network access at runtime — icons are served from
    `data/icons/` by the local server; a failed setup download retries on
    each start and degrades to family icons**; `GET /icons/catalog` (the
    eyeball surface) + `exclude.json` vetoes; recolor limit (near-white
    pixels only); namespaced names; degradation = family icons.
  - Offline-first note near the FAA section: the FAA bulk DB is the same
    pattern — local cache, cadence via `FAA_REFRESH_MS` (daily default;
    weekly = `604800000` for spotty connections).
  - WS protocol: `status` frame gains `icons: {state,count,updatedAt,lastError}`.
  - "Aircraft icons" section: repoint the primary art to the pack (families
    are the fallback layer); the 13 air SVGs stay committed.
  - Commands table: add `npm run icons:repin`.

- [ ] **Step 3: Update spec/plan status** to "implemented (pending browser
  verification)" with today's date.

- [ ] **Step 4: Full gate**

Run: `npm test && npm run typecheck && npm run build`
Expected: green; log the final test count.

- [ ] **Step 5: Commit + browser handoff**

```bash
git add test/air-icons.test.ts AGENTS.md docs/superpowers/specs/2026-10-13-vendored-aircraft-icon-pack-design.md docs/superpowers/plans/2026-10-13-vendored-aircraft-icon-pack.md
git commit -m "docs(iconpack): AGENTS.md, registry test, spec status"
```

Handoff to the user (browser-only verification):
1. `npm run dev` → HUD should show `Icons: N` (N ≈ 250–270) after a few
   seconds (or `Icons: offline` if the network is down — families still work).
2. Open `http://127.0.0.1:2001/icons/catalog` — eyeball the full set; name
   anything that renders wrong → it goes in `data/icons/exclude.json`
   (`{ "vetoed": ["rk:XYZ"] }`) and restart.
3. Live map: spot-check the named military list (AWACS/E-3 if covered,
   C-130, C-17, UH-60, KC-135, F-16, MQ-9) — distinct silhouettes, red;
   civil (737/A320/C172) blue; long-tail types on family icons as before.
4. Timeline rewind still works (old snapshots → family icons).
