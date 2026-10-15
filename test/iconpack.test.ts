import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { IconPack, type IconPackTransport } from "../server/iconpack.js";
import type { IconSources } from "../server/iconpack-sources.js";

const PW_SHA = "3d41c9a2f7e6b8d0a1c2b3d4e5f60718293a4b5c"; // 40-hex fixture sha
const RK_SHA = "a1b2c3d4e5f60718293a4b5c6d7e8f9012345678"; // 40-hex fixture sha
const QUX_BYTES = Buffer.from("qux-png-bytes\n");
const QUX_SHA = createHash("sha256").update(QUX_BYTES).digest("hex");

const FIXTURE_SOURCES: IconSources = {
  pw: { repo: "plane-watch/pw-silhouettes", sha: PW_SHA, license: "pw license", attribution: "pw attribution" },
  rk: { repo: "RexKramer1/AircraftShapesSVG", sha: RK_SHA, license: "rk license", attribution: "rk attribution" },
  pd: [
    {
      name: "pd:QUX",
      file: "pd/QUX.png",
      url: "https://example.com/QUX.png",
      sha256: QUX_SHA,
      title: "Qux Aircraft",
      license: "Public Domain (US Government work)",
      attribution: "Test Author",
      cropTopRatio: 0.5,
    },
  ],
  gapTargets: [],
};

function throwingTransport(): IconPackTransport {
  return {
    cloneRepo: async () => {
      throw new Error("transport should not be called");
    },
    fetchFile: async () => {
      throw new Error("transport should not be called");
    },
  };
}

/** Staging dir the fake transport "downloads" from: pw airframes+silhouettes, rk svgs, pd png. */
function makeFixture(): string {
  const fix = mkdtempSync(join(tmpdir(), "radar-iconpack-fixture-"));
  const airframes = join(fix, "plane-watch", "airframes");
  const silhouettes = join(fix, "plane-watch", "silhouettes");
  const rk = join(fix, "rk");
  const pd = join(fix, "pd");
  mkdirSync(airframes, { recursive: true });
  mkdirSync(silhouettes, { recursive: true });
  mkdirSync(rk, { recursive: true });
  mkdirSync(pd, { recursive: true });
  writeFileSync(join(airframes, "FOO.json"), JSON.stringify({ icao: { designator: "FOO" } }));
  writeFileSync(join(silhouettes, "FOO-1.svg"), "<svg><rect/></svg>");
  writeFileSync(join(airframes, "BAR.json"), JSON.stringify({ icao: { designator: "BAR" } }));
  writeFileSync(join(silhouettes, "BAR.svg"), "<svg><rect/></svg>"); // no "-1" variant
  writeFileSync(join(rk, "BAZ.svg"), "<svg><title>BAZ Title</title><rect/></svg>");
  writeFileSync(join(pd, "QUX.png"), QUX_BYTES);
  return fix;
}

function makeFakeTransport(fix: string): IconPackTransport {
  return {
    async cloneRepo(repo: string, _sha: string, destDir: string) {
      const sub = repo.includes("plane-watch") ? "plane-watch" : "rk";
      cpSync(join(fix, sub), destDir, { recursive: true });
    },
    async fetchFile(_url: string, destPath: string, sha256: string) {
      const bytes = readFileSync(join(fix, "pd/QUX.png"));
      const got = createHash("sha256").update(bytes).digest("hex");
      if (got !== sha256) throw new Error(`sha256 mismatch: expected ${sha256}, got ${got}`);
      mkdirSync(dirname(destPath), { recursive: true });
      writeFileSync(destPath, bytes);
    },
  };
}

describe("IconPack", () => {
  let fix: string;
  let dir: string;

  beforeEach(() => {
    fix = makeFixture();
    dir = mkdtempSync(join(tmpdir(), "radar-iconpack-"));
  });

  afterEach(() => {
    rmSync(fix, { recursive: true, force: true });
    rmSync(dir, { recursive: true, force: true });
  });

  it("absent before init; ready after download; names/status correct", async () => {
    const pack = new IconPack({ dir, sources: FIXTURE_SOURCES, transport: makeFakeTransport(fix) });
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

  it("verified dir re-uses files without transport", async () => {
    const pack = new IconPack({ dir, sources: FIXTURE_SOURCES, transport: makeFakeTransport(fix) });
    await pack.init();
    expect(pack.status().state).toBe("ready");
    // pins.json pins exactly the sources it was downloaded from
    const pins = JSON.parse(readFileSync(join(dir, "pins.json"), "utf8")) as {
      pw: { repo: string; sha: string };
      rk: { repo: string; sha: string };
      pd: Record<string, string>;
      writtenAt: number;
    };
    expect(pins.pw).toEqual({ repo: FIXTURE_SOURCES.pw.repo, sha: PW_SHA });
    expect(pins.rk).toEqual({ repo: FIXTURE_SOURCES.rk.repo, sha: RK_SHA });
    expect(pins.pd).toEqual({ "pd:QUX": QUX_SHA });
    expect(typeof pins.writtenAt).toBe("number");
    // index.json is a build artifact: deleting it must not force a re-download
    rmSync(join(dir, "index.json"));
    const pack2 = new IconPack({ dir, sources: FIXTURE_SOURCES, transport: throwingTransport() });
    await pack2.init();
    expect(pack2.status().state).toBe("ready");
    expect(pack2.status().count).toBe(4);
  });

  it("collision with a family/sea name fails init", async () => {
    writeFileSync(
      join(fix, "plane-watch", "airframes", "tanker.json"),
      JSON.stringify({ icao: { designator: "TANKER" } }),
    );
    writeFileSync(join(fix, "plane-watch", "silhouettes", "tanker-1.svg"), "<svg><rect/></svg>");
    const pack = new IconPack({ dir, sources: FIXTURE_SOURCES, transport: makeFakeTransport(fix) });
    await pack.init();
    const s = pack.status();
    expect(s.state).toBe("failed");
    expect(s.lastError ?? "").toMatch(/collision/);
    expect(pack.names().size).toBe(0);
  });

  it("duplicate name fails init", async () => {
    const sources: IconSources = {
      ...FIXTURE_SOURCES,
      pd: [FIXTURE_SOURCES.pd[0], { ...FIXTURE_SOURCES.pd[0], file: "pd/QUX2.png" }],
    };
    writeFileSync(join(fix, "pd", "QUX2.png"), QUX_BYTES);
    const pack = new IconPack({ dir, sources, transport: makeFakeTransport(fix) });
    await pack.init();
    expect(pack.status().state).toBe("failed");
    expect(pack.status().lastError ?? "").toMatch(/duplicate/);
    expect(pack.names().size).toBe(0);
  });

  it("transport failure → failed state, no throw, names empty", async () => {
    const pack = new IconPack({
      dir,
      sources: FIXTURE_SOURCES,
      transport: {
        cloneRepo: async () => {
          throw new Error("clone exploded");
        },
        fetchFile: async () => {
          throw new Error("clone exploded");
        },
      },
    });
    await expect(pack.init()).resolves.toBeUndefined();
    expect(pack.status().state).toBe("failed");
    expect(pack.status().lastError).toContain("clone exploded");
    expect(pack.names().size).toBe(0);
  });

  it("exclude.json vetoes names but entries() keeps them", async () => {
    writeFileSync(
      join(dir, "exclude.json"),
      JSON.stringify({ vetoed: ["rk:BAZ"], reasons: { "rk:BAZ": "test veto" } }),
    );
    const pack = new IconPack({ dir, sources: FIXTURE_SOURCES, transport: makeFakeTransport(fix) });
    await pack.init();
    expect(pack.status().state).toBe("ready");
    expect(pack.names().size).toBe(3);
    expect(pack.status().count).toBe(3);
    expect(pack.fileBytes("rk:BAZ")).toBeNull();
    expect(pack.isVetoed("rk:BAZ")).toBe(true);
    expect(pack.entries().length).toBe(4);
    expect(pack.entry("rk:BAZ")?.name).toBe("rk:BAZ");
  });

  it("sha256 mismatch in fetchFile surfaces as failed", async () => {
    const bad: IconSources = {
      ...FIXTURE_SOURCES,
      pd: [{ ...FIXTURE_SOURCES.pd[0], sha256: "0".repeat(64) }],
    };
    const pack = new IconPack({ dir, sources: bad, transport: makeFakeTransport(fix) });
    await pack.init();
    expect(pack.status().state).toBe("failed");
    expect(pack.status().lastError ?? "").toMatch(/sha256/);
    expect(pack.names().size).toBe(0);
  });
});

// --- default transport (real git fetch + fetch) --------------------------------
// Runs the real transport (no injection) against a tiny local git fixture repo
// (file:// URL) and an ephemeral node:http server for the pd file. The fixture
// repos set uploadpack.allowReachableSHA1InWant — mirroring GitHub, which
// allows fetching reachable full SHAs (how the pinned download works).

const PD_BYTES = Buffer.from("default-transport pd bytes\n");
const PD_SHA = createHash("sha256").update(PD_BYTES).digest("hex");

function gitCmd(cwd: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile("git", args, { cwd }, (err, stdout, stderr) => {
      if (err) reject(new Error(`git ${args.slice(0, 2).join(" ")}: ${String(stderr).trim() || err.message}`));
      else resolve(stdout);
    });
  });
}

async function commitAll(repo: string, msg: string): Promise<string> {
  await gitCmd(repo, ["add", "-A"]);
  await gitCmd(repo, ["commit", "-q", "-m", msg]);
  return (await gitCmd(repo, ["rev-parse", "HEAD"])).trim();
}

async function initFixtureRepo(repo: string): Promise<void> {
  await gitCmd(repo, ["init", "-q"]);
  await gitCmd(repo, ["config", "user.email", "test@radar.local"]);
  await gitCmd(repo, ["config", "user.name", "Radar Test"]);
  await gitCmd(repo, ["config", "uploadpack.allowReachableSHA1InWant", "true"]);
}

/** pw-style fixture: commit 1 = airframe A only; commit 2 changes A and adds B. */
async function makePwRepo(): Promise<{ url: string; sha1: string; dir: string }> {
  const repo = mkdtempSync(join(tmpdir(), "radar-iconpack-pwrepo-"));
  mkdirSync(join(repo, "airframes"), { recursive: true });
  mkdirSync(join(repo, "silhouettes"), { recursive: true });
  await initFixtureRepo(repo);
  writeFileSync(join(repo, "airframes", "A.json"), JSON.stringify({ icao: { designator: "A-one" } }));
  writeFileSync(join(repo, "silhouettes", "A-1.svg"), "<svg>A-1</svg>");
  const sha1 = await commitAll(repo, "c1");
  writeFileSync(join(repo, "airframes", "A.json"), JSON.stringify({ icao: { designator: "A-two" } }));
  writeFileSync(join(repo, "airframes", "B.json"), JSON.stringify({ icao: { designator: "B" } }));
  writeFileSync(join(repo, "silhouettes", "B-1.svg"), "<svg>B-1</svg>");
  await commitAll(repo, "c2");
  return { url: pathToFileURL(repo).href, sha1, dir: repo };
}

/** rk-style fixture: one commit, SVGs under "Shapes SVG" (incl. a spaced name). */
async function makeRkRepo(): Promise<{ url: string; sha: string; dir: string }> {
  const repo = mkdtempSync(join(tmpdir(), "radar-iconpack-rkrepo-"));
  mkdirSync(join(repo, "Shapes SVG"), { recursive: true });
  await initFixtureRepo(repo);
  writeFileSync(join(repo, "Shapes SVG", "C.svg"), "<svg><title>C Title</title></svg>");
  writeFileSync(join(repo, "Shapes SVG", "D space.svg"), "<svg></svg>");
  const sha = await commitAll(repo, "c1");
  return { url: pathToFileURL(repo).href, sha, dir: repo };
}

describe("default transport", () => {
  let dir: string;
  let pw: { url: string; sha1: string; dir: string };
  let rk: { url: string; sha: string; dir: string };
  let fixture: { url: (p: string) => string; close: () => Promise<void> };

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "radar-iconpack-dt-"));
    pw = await makePwRepo();
    rk = await makeRkRepo();
    const server = http.createServer((req, res) => {
      if (req.url === "/pd/E3.png") {
        res.writeHead(200, { "content-type": "application/octet-stream" });
        res.end(PD_BYTES);
      } else {
        res.writeHead(404);
        res.end();
      }
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    const addr = server.address();
    const port = typeof addr === "object" && addr ? addr.port : 0;
    fixture = {
      url: (p: string) => `http://127.0.0.1:${port}${p}`,
      close: () => new Promise<void>((r) => server.close(() => r())),
    };
  });

  afterEach(async () => {
    await fixture.close();
    rmSync(dir, { recursive: true, force: true });
    rmSync(pw.dir, { recursive: true, force: true });
    rmSync(rk.dir, { recursive: true, force: true });
  });

  it("cloneRepo fetches the pinned sha into destDir layout", async () => {
    const sources: IconSources = {
      pw: { repo: pw.url, sha: pw.sha1, license: "pw license", attribution: "pw attribution" },
      rk: { repo: rk.url, sha: rk.sha, license: "rk license", attribution: "rk attribution" },
      pd: [],
      gapTargets: [],
    };
    const pack = new IconPack({ dir, sources });
    await pack.init();
    expect(pack.status().state).toBe("ready");
    // pw subpaths land under plane-watch/<name>; pinned to commit 1, not main
    expect(readFileSync(join(dir, "plane-watch", "airframes", "A.json"), "utf8")).toContain("A-one");
    expect(existsSync(join(dir, "plane-watch", "airframes", "B.json"))).toBe(false);
    expect(existsSync(join(dir, "plane-watch", "silhouettes", "A-1.svg"))).toBe(true);
    // rk "Shapes SVG" contents land directly in rk/ (base names preserved)
    expect(existsSync(join(dir, "rk", "C.svg"))).toBe(true);
    expect(existsSync(join(dir, "rk", "D space.svg"))).toBe(true);
    expect(existsSync(join(dir, "rk", "Shapes SVG"))).toBe(false);
  });

  it("fetchFile verifies sha256 and writes bytes", async () => {
    const sources: IconSources = {
      pw: { repo: "file:///does-not-exist-pw", sha: PW_SHA, license: "pw license", attribution: "pw attribution" },
      rk: { repo: "file:///does-not-exist-rk", sha: RK_SHA, license: "rk license", attribution: "rk attribution" },
      pd: [
        {
          name: "pd:E3",
          file: "pd/e3.png",
          url: fixture.url("/pd/E3.png"),
          sha256: PD_SHA,
          title: "E3",
          license: "Public Domain (test)",
          attribution: "Test Author",
          cropTopRatio: 0.5,
        },
      ],
      gapTargets: [],
    };
    const pack = new IconPack({ dir, sources });
    await pack.init();
    // download fails at the pw clone (bad repo), but the pd file was already
    // fetched, verified, and written (into a parent dir that did not exist)
    expect(pack.status().state).toBe("failed");
    expect(pack.status().lastError ?? "").not.toMatch(/sha256/);
    expect(readFileSync(join(dir, "pd", "e3.png"))).toEqual(PD_BYTES);
    // wrong sha → reject, nothing written
    const bad: IconSources = { ...sources, pd: [{ ...sources.pd[0], sha256: "0".repeat(64) }] };
    const dir2 = mkdtempSync(join(tmpdir(), "radar-iconpack-dt-"));
    const pack2 = new IconPack({ dir: dir2, sources: bad });
    await pack2.init();
    expect(pack2.status().state).toBe("failed");
    expect(pack2.status().lastError ?? "").toMatch(/sha256/);
    expect(existsSync(join(dir2, "pd", "e3.png"))).toBe(false);
    rmSync(dir2, { recursive: true, force: true });
  });

  it("init with default transport writes ATTRIBUTION.md (download path only)", async () => {
    const sources: IconSources = {
      pw: { repo: pw.url, sha: pw.sha1, license: "pw license", attribution: "pw attribution" },
      rk: { repo: rk.url, sha: rk.sha, license: "rk license", attribution: "rk attribution" },
      pd: [
        {
          name: "pd:E3",
          file: "pd/e3.png",
          url: fixture.url("/pd/E3.png"),
          sha256: PD_SHA,
          title: "Boeing E-3 Sentry",
          license: "Public Domain (test)",
          attribution: "Test Author",
          cropTopRatio: 0.5,
        },
      ],
      gapTargets: [],
    };
    const pack = new IconPack({ dir, sources });
    await pack.init();
    expect(pack.status().state).toBe("ready");
    expect(pack.status().count).toBe(4); // pw:A, rk:C, rk:D space, pd:E3
    const attr = readFileSync(join(dir, "ATTRIBUTION.md"), "utf8");
    expect(attr).toContain("pw license");
    expect(attr).toContain("rk license");
    expect(attr).toContain("Public Domain (test)");
    expect(attr).toContain("Boeing E-3 Sentry");
    expect(attr).toMatch(/re-licens/i);
    // verified re-init skips the download — must NOT rewrite ATTRIBUTION.md
    rmSync(join(dir, "ATTRIBUTION.md"));
    const pack2 = new IconPack({ dir, sources });
    await pack2.init();
    expect(pack2.status().state).toBe("ready");
    expect(existsSync(join(dir, "ATTRIBUTION.md"))).toBe(false);
  });
});
