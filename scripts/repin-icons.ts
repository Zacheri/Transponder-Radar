import { execFile } from "node:child_process";
import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { IconPack } from "../server/iconpack.js";
import { loadIconSources, writeIconSources, type IconSources } from "../server/iconpack-sources.js";

// Dev tool (deliberate, logged action — never run automatically): re-pin pw/rk
// to their `main` heads, update server/iconpack-sources.json, re-download the
// pack fresh into data/icons/, and print the name-set diff. No args.
//   npm run icons:repin

const dir = join(process.cwd(), "data", "icons");

/** HEAD of <repo>'s main branch via `git ls-remote` (no clone needed). */
function lsRemoteMainHead(repo: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile("git", ["ls-remote", repo, "main"], { timeout: 30000 }, (err, stdout, stderr) => {
      if (err) return reject(new Error(`git ls-remote ${repo} main: ${String(stderr).trim() || err.message}`));
      const line = String(stdout)
        .trim()
        .split("\n")
        .find((l) => l.trim() !== "");
      const sha = line?.split(/\s+/)[0] ?? "";
      if (!/^[0-9a-f]{40}$/.test(sha)) return reject(new Error(`git ls-remote ${repo} main: no main head found`));
      resolve(sha);
    });
  });
}

let exitCode = 0;
try {
  const sources = loadIconSources();

  // Previous index.json names (if any) — for the name-set diff after re-download.
  const prevNames: Set<string> | null = (() => {
    try {
      return new Set(
        (JSON.parse(readFileSync(join(dir, "index.json"), "utf8")) as { name: string }[]).map((e) => e.name),
      );
    } catch {
      return null; // first run — no previous index
    }
  })();

  const pwNew = await lsRemoteMainHead(sources.pw.repo);
  const rkNew = await lsRemoteMainHead(sources.rk.repo);
  for (const [label, src, next] of [
    ["pw", sources.pw, pwNew],
    ["rk", sources.rk, rkNew],
  ] as const) {
    console.log(next === src.sha ? `repin: ${label} ${src.repo} unchanged at ${src.sha}` : `repin: ${label} ${src.repo}: ${src.sha} -> ${next}`);
  }

  const updated: IconSources = {
    ...sources,
    pw: { ...sources.pw, sha: pwNew },
    rk: { ...sources.rk, sha: rkNew },
  };
  if (updated.pw.sha !== sources.pw.sha || updated.rk.sha !== sources.rk.sha) {
    writeIconSources(updated);
    console.log("repin: server/iconpack-sources.json updated");
  }

  // Fresh download: a re-pin replaces the pack wholesale so stale files from
  // the old sha cannot linger in the index.
  rmSync(dir, { recursive: true, force: true });
  const pack = new IconPack({ dir, sources: updated, log: (m) => console.log(m) });
  await pack.init();
  const s = pack.status();
  console.log(`repin: state=${s.state} count=${s.count} lastError=${s.lastError ?? "none"}`);
  if (s.state !== "ready") {
    exitCode = 1;
  } else {
    const newNames = new Set(pack.entries().map((e) => e.name));
    if (prevNames === null) {
      console.log(`repin: no previous index — ${newNames.size} names`);
    } else {
      const added = [...newNames].filter((n) => !prevNames.has(n)).sort();
      const removed = [...prevNames].filter((n) => !newNames.has(n)).sort();
      console.log(`repin: name-set diff: +${added.length} added, -${removed.length} removed (${newNames.size} total)`);
      for (const n of added) console.log(`  + ${n}`);
      for (const n of removed) console.log(`  - ${n}`);
    }
  }
} catch (e) {
  console.error(`repin failed: ${e instanceof Error ? e.message : String(e)}`);
  exitCode = 1;
}
process.exitCode = exitCode;
