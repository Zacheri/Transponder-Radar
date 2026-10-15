import { join } from "node:path";
import { IconPack } from "../server/iconpack.js";
import { loadIconSources } from "../server/iconpack-sources.js";

// Offline-first pre-warm (spec §2): a deliberate one-shot download of the
// pinned icon pack into data/icons/ — identical to what first server start
// does. Run on good Wi-Fi before a spotty connection. No args.
//   npm run icons:setup
const dir = join(process.cwd(), "data", "icons");
const sources = loadIconSources();
const pack = new IconPack({ dir, sources, log: (m) => console.log(m) });
await pack.init();
const s = pack.status();
console.log(`icons:setup: state=${s.state} count=${s.count} lastError=${s.lastError ?? "none"}`);
if (s.state !== "ready") process.exitCode = 1;
