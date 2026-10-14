import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createHash } from "node:crypto";
import { cpSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
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
