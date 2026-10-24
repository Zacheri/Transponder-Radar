import { lineSvgToFill, PACK_COLORS } from "../shared/pack-transforms.js";
import { CIVIL_RULES, MILITARY_RULES } from "./icon-tables.js";
import type { PackStyle } from "./iconpack.js";

// Human-facing catalog for the vendored aircraft icon pack (served at
// /icons/catalog): one dark-themed HTML grid of every pack entry (with
// recolored previews), the built-in 13 air-family + 10 sea icons, and the
// unresolved gapTargets list. renderCatalog is pure (pre-colored cells in,
// HTML out) so it is Node-testable; the route layer (server/index.ts) does
// the fs reads, the file bytes, and the ruling-P7 color assignment.

export interface CatalogCell {
  name: string;
  title: string;
  license: string;
  style: PackStyle;
  svg?: string; // raw pw/rk svg text
  pngDataUrl?: string; // pd, "data:<mime>;base64,…"
  color: string; // on-map color (ruling P7: follows resolver assignment)
  vetoed: boolean;
  cropTopRatio?: number;
}

const MILITARY_PACKS = new Set(MILITARY_RULES.flatMap((r) => (r.pack ? [r.pack] : [])));
const CIVIL_PACKS = new Set(CIVIL_RULES.flatMap((r) => (r.pack ? [r.pack] : [])));

/**
 * Ruling P7: the pack icon color follows the RESOLVER's assignment (military
 * identity wins), not the art's file source:
 *  - name referenced by any MILITARY_RULES entry → military, even when a
 *    civil rule also points at it (the crossing cases: CH-47, H-60 — the
 *    silhouette is the same art, and a military type never renders blue)
 *  - referenced by CIVIL_RULES only → civil
 *  - unassigned (extra coverage beyond both tables) → source-based:
 *    pw → civil, rk/pd → military
 */
export function packColor(name: string, source: string): string {
  if (MILITARY_PACKS.has(name)) return PACK_COLORS.military;
  if (CIVIL_PACKS.has(name)) return PACK_COLORS.civil;
  return source === "pw" ? PACK_COLORS.civil : PACK_COLORS.military;
}

// gapTarget designators whose covering art carries a DIFFERENT local name
// than the designator itself. Explicit map, NOT prefix matching: a prefix
// would false-cover designator C17 via the Cessna rule's local name C172
// (strict \bC17\b exists precisely so C172 ≠ C17).
const DESIGNATOR_ALIASES: Record<string, string[]> = {
  V22: ["V22 fast"], // rk file name carries a space
  F18: ["F18S"], // art is the F-18S variant
  AH64: ["H64"], // art file is H64 (civil defensive rule)
};

/**
 * Local names (pack name minus the pw/rk/pd: prefix) the resolver can
 * actually emit from a given pack index — the union of BOTH tables, plus
 * the aliased designators (see DESIGNATOR_ALIASES). Drives the catalog gap
 * list (gapTargets minus this set): a designator is covered when some rule
 * points at a pack name that is present in the index.
 */
export function coveredDesignators(packNames: ReadonlySet<string>): Set<string> {
  const locals = new Set<string>();
  for (const r of [...MILITARY_RULES, ...CIVIL_RULES]) {
    if (r.pack && packNames.has(r.pack)) locals.add(r.pack.slice(r.pack.indexOf(":") + 1));
  }
  const covered = new Set<string>(locals);
  for (const [designator, names] of Object.entries(DESIGNATOR_ALIASES)) {
    if (names.some((n) => locals.has(n))) covered.add(designator);
  }
  return covered;
}

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

export function renderCatalog(opts: {
  cells: CatalogCell[];
  staticIcons: { name: string; svg: string; color: string | null }[]; // the 13 families + 10 sea, read from src/assets/icons
  gaps: { designator: string; title: string }[];
}): string {
  const { cells, staticIcons, gaps } = opts;

  const cellPreview = (c: CatalogCell): string => {
    if (c.style === "gapfill") {
      if (!c.pngDataUrl) return "";
      // Crop rect: the top view is the top `cropTopRatio` of the file; scale
      // the image so that portion exactly fills the 84px box height (the
      // scan is paper + ink — shown as-is, the on-map color is a chip).
      const style =
        c.cropTopRatio && c.cropTopRatio < 1 ? ` style="height:calc(84px / ${c.cropTopRatio})"` : "";
      return `<span class="pd"${style}><img src="${c.pngDataUrl}" alt=""></span>`;
    }
    if (!c.svg) return "";
    // filled (pw) and line (rk) share the clean-fill transform: keep only
    // the first visible top-level layer (the silhouette — pw's display:none
    // "Reference Artwork" layer is skipped), recolor the body, and strip the
    // inkscape namespace soup. This keeps the page a few MB instead of the
    // ~40 MB the raw pw files would inline. If a file has no visible
    // top-level <g>, lineSvgToFill returns it unchanged (preview still
    // renders, just untransformed).
    return lineSvgToFill(c.svg, c.color);
  };

  const cellHtml = (c: CatalogCell): string =>
    `<div class="cell${c.vetoed ? " vetoed" : ""}">` +
    `<div class="prev">${cellPreview(c)}</div>` +
    `<div class="nm">${esc(c.name)}</div>` +
    `<div class="tt">${esc(c.title)}</div>` +
    `<div class="lc">${esc(c.license)}</div>` +
    (c.vetoed ? `<div class="bd">vetoed</div>` : "") +
    `</div>`;

  const staticHtml = (s: { name: string; svg: string; color: string | null }): string =>
    `<div class="cell">` +
    `<div class="prev">${s.svg}</div>` +
    `<div class="nm">${esc(s.name)}</div>` +
    (s.color ? `<div class="sw" style="background:${s.color}"></div>` : "") +
    `</div>`;

  return `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Aircraft icon catalog</title>
<style>
body { background:#0b0e14; color:#e6e9f0; font:14px/1.45 system-ui, -apple-system, sans-serif; margin:0; padding:24px; }
h1 { font-size:20px; margin:0 0 8px; }
h2 { font-size:14px; margin:36px 0 12px; color:#8b93a7; text-transform:uppercase; letter-spacing:.08em; }
.meta { color:#8b93a7; margin:0 0 4px; }
.note { color:#8b93a7; max-width:960px; margin:8px 0 0; font-size:13px; }
.grid { display:grid; grid-template-columns:repeat(auto-fill, minmax(160px, 1fr)); gap:12px; }
.cell { background:#11151f; border:1px solid #232838; border-radius:8px; padding:10px; position:relative; }
.prev { display:flex; align-items:center; justify-content:center; height:84px; }
.prev svg { max-width:100%; max-height:84px; }
.pd { display:block; width:84px; height:84px; overflow:hidden; }
.pd img { display:block; width:84px; height:84px; max-width:none; }
.nm { font-size:12px; font-weight:600; margin-top:8px; word-break:break-all; }
.tt { font-size:11px; color:#8b93a7; }
.lc { font-size:10px; color:#5c6478; }
.sw { width:10px; height:10px; border-radius:2px; margin-top:6px; }
.cell.vetoed { opacity:.45; }
.bd { position:absolute; top:6px; right:6px; background:#ef5350; color:#fff; font-size:10px; padding:1px 6px; border-radius:4px; }
.gaps { display:flex; flex-wrap:wrap; gap:8px; }
.gap { background:#11151f; border:1px solid #232838; border-radius:6px; padding:6px 10px; font-size:12px; }
.gap b { color:#ef5350; }
</style>
</head>
<body>
<h1>Aircraft icon catalog</h1>
<p class="meta">${cells.length} pack icons · ${staticIcons.length} built-in · ${gaps.length} gaps</p>
<p class="note">Color follows the resolver's assignment: types in the military table render ${PACK_COLORS.military}, civil-only types ${PACK_COLORS.civil}; unassigned extra coverage previews by art source (pw → civil, rk/pd → military). Final on-map color follows the craft's kind.</p>
<h2>Pack icons</h2>
<div class="grid">${cells.map(cellHtml).join("")}</div>
<h2>Built-in icons</h2>
<div class="grid">${staticIcons.map(staticHtml).join("")}</div>
<h2>Gaps — wanted, no art</h2>
<div class="gaps">${gaps.map((g) => `<div class="gap"><b>${esc(g.designator)}</b> ${esc(g.title)}</div>`).join("")}</div>
</body>
</html>`;
}
