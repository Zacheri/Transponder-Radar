import { AIR_KINDS, type AirKind } from "./craft.js";

// Shared silhouette transforms for the vendored aircraft icon pack (pw / rk
// SVGs under data/icons/). Consumed by the server-side icon catalog and the
// browser icon loader — pure string/byte surgery (no DOM, no XML parser), so
// it is Node-testable.

export const PACK_COLORS = { military: "#ef5350", civil: "#4fc3f7" } as const;

/** True when `kind` is one of the four air kinds (AIR_KINDS). */
function isAirKind(kind: string): kind is AirKind {
  return (AIR_KINDS as readonly string[]).includes(kind);
}

/**
 * Pack domain color for a craft kind: military air → red, everything else
 * (other air + all sea — sea never gets a pack icon; kept total so callers
 * don't need a domain check) → light blue.
 */
export function domainColor(kind: string): string {
  if (kind === "military" && isAirKind(kind)) return PACK_COLORS.military;
  return PACK_COLORS.civil;
}

/**
 * In-place recolor for a rasterized silhouette (RGBA, row-major, premultiplied
 * or not — only the channels are touched): every pixel with alpha > 0 and
 * r,g,b ALL >= 200 (the pack's white/near-white silhouette body) gets `rgb`;
 * alpha is preserved; every other pixel is untouched (keeps the author's
 * black hairline and any detail colors).
 */
export function recolorPixels(data: Uint8ClampedArray, rgb: [number, number, number]): void {
  const [r, g, b] = rgb;
  for (let i = 0; i + 3 < data.length; i += 4) {
    if (data[i + 3] > 0 && data[i] >= 200 && data[i + 1] >= 200 && data[i + 2] >= 200) {
      data[i] = r;
      data[i + 1] = g;
      data[i + 2] = b;
    }
  }
}

/**
 * "image/png" | "image/jpeg" from magic bytes. The pd gap-fill files are
 * stored as .png, but two of the four (c5, kc10) are actually JPEGs — their
 * Commons sources are .jpg. Unknown bytes fall back to "image/png".
 */
export function sniffImageType(bytes: Uint8Array): "image/png" | "image/jpeg" {
  if (bytes.length > 3 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return "image/png";
  if (bytes.length > 2 && bytes[0] === 0xff && bytes[1] === 0xd8) return "image/jpeg";
  return "image/png";
}

/** "#ef5350" (or "#e30" shorthand) → [239, 83, 80]. Throws on anything else. */
export function hexToRgb(hex: string): [number, number, number] {
  let h = hex.trim().replace(/^#/, "");
  if (h.length === 3) h = h.split("").map((c) => c + c).join("");
  if (!/^[0-9a-fA-F]{6}$/.test(h)) throw new Error(`hexToRgb: bad hex "${hex}"`);
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
}

// --- SVG string surgery (no XML parser) -------------------------------------
//
// The inkscape-authored pack SVGs have one reliable shape: a root <svg> with
// inkscape/sodipodi namespace soup, top-level <g inkscape:groupmode="layer">
// layers in document order, each a closed <g>…</g> block (empty layers may be
// self-closing <g …/>). Nested <g>s occur inside layers, so a top-level block
// is found by depth counting <g / </g> (comments are skipped so a commented-
// out tag cannot skew the count). No d-attribute or other value in the pack
// contains a raw '<' or '>', so indexOf('>') ends a tag.

/** One attribute of a tag: name + unquoted value. */
interface TagAttr {
  name: string;
  value: string;
}

/** Attribute name="value" pairs from the inside of a tag (between name and '>'). */
function parseAttrs(raw: string): TagAttr[] {
  const attrs: TagAttr[] = [];
  const re = /([A-Za-z_:][A-Za-z0-9_.:-]*)\s*=\s*(["'])([\s\S]*?)\2/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(raw)) !== null) attrs.push({ name: m[1], value: m[3] });
  return attrs;
}

function escapeAttrValue(v: string): string {
  return v.replace(/"/g, "&quot;");
}

/**
 * Pack recolor of one CSS style value: the fill declaration becomes
 * `fill:<color>` (any value — line art's `fill:none` and filled art's
 * `fill:#ffffff` both become the silhouette body color); every stroke /
 * stroke-* declaration is dropped (the filled body needs no hairline); the
 * rest (display, opacity, fill-rule, fill-opacity, …) is kept. Tolerates
 * arbitrary spaces/newlines around ';' and ':'.
 */
function restyle(style: string, color: string): string {
  const out: string[] = [];
  let hasFill = false;
  for (const decl of style.split(";")) {
    const ci = decl.indexOf(":");
    if (ci === -1) continue;
    const prop = decl.slice(0, ci).trim().toLowerCase();
    if (prop === "") continue;
    const value = decl.slice(ci + 1).trim();
    if (prop === "fill") {
      out.push(`fill:${color}`);
      hasFill = true;
    } else if (prop === "stroke" || prop.startsWith("stroke-")) {
      continue; // drop
    } else {
      out.push(`${prop}:${value}`);
    }
  }
  if (!hasFill) out.unshift(`fill:${color}`);
  return out.join(";");
}

// Elements whose default fill is "black": if one appears in the kept layer
// without a style attribute, give it the domain color. (In the current pack
// every shape carries a style, so this is a safety net.)
const SHAPE_ELEMENTS = new Set(["path", "polygon", "polyline", "rect", "circle", "ellipse"]);

/**
 * Re-emit one opening tag for the standalone output: drop namespaced
 * (prefix-qualified) attributes — inkscape:*, sodipodi:*, xlink:* — which
 * would be undeclared XML prefixes once the root's namespace soup is gone;
 * recolor its style= (or add one to a bare shape); normalize whitespace.
 * Self-closing form is preserved.
 */
function cleanTag(tag: string, color: string): string {
  const m = /^<([A-Za-z][A-Za-z0-9]*)([\s\S]*?)(\/?)>$/.exec(tag);
  if (!m) return tag;
  const name = m[1];
  const selfClose = m[3] === "/";
  const out: TagAttr[] = [];
  let style: string | null = null;
  for (const a of parseAttrs(m[2])) {
    if (a.name.includes(":")) continue;
    if (a.name === "style") style = a.value;
    else out.push(a);
  }
  if (style !== null) out.push({ name: "style", value: restyle(style, color) });
  else if (SHAPE_ELEMENTS.has(name)) out.push({ name: "style", value: `fill:${color}` });
  const attrStr = out.map((a) => `${a.name}="${escapeAttrValue(a.value)}"`).join(" ");
  return `<${name}${attrStr ? " " + attrStr : ""}${selfClose ? " /" : ""}>`;
}

/**
 * Walk a kept layer's inside, re-emitting every opening tag through
 * cleanTag; text, closing tags, and comments pass through untouched
 * (comments are skipped as whole spans so a tag-looking example inside one
 * is never "cleaned").
 */
function cleanInner(inner: string, color: string): string {
  let out = "";
  let pos = 0;
  while (pos < inner.length) {
    const lt = inner.indexOf("<", pos);
    if (lt === -1) {
      out += inner.slice(pos);
      break;
    }
    out += inner.slice(pos, lt);
    if (inner.startsWith("<!--", lt)) {
      const end = inner.indexOf("-->", lt + 4);
      const stop = end === -1 ? inner.length : end + 3;
      out += inner.slice(lt, stop);
      pos = stop;
    } else if (inner[lt + 1] === "/" || inner[lt + 1] === "?") {
      // closing tag or processing instruction: pass through verbatim
      const end = inner.indexOf(">", lt);
      const stop = end === -1 ? inner.length : end + 1;
      out += inner.slice(lt, stop);
      pos = stop;
    } else {
      const end = inner.indexOf(">", lt);
      if (end === -1) {
        out += inner.slice(lt);
        break;
      }
      out += cleanTag(inner.slice(lt, end + 1), color);
      pos = end + 1;
    }
  }
  return out;
}

/** A top-level <g> block: its opening tag and the content up to the matching </g>. */
interface GroupBlock {
  open: string;
  inner: string;
}

/**
 * Top-level <g>…</g> blocks of `body`, in document order, by depth counting
 * (a nested <g> increments the depth before its </g> can close the outer
 * one). Self-closing <g …/> (Inkscape's empty layers) carry no content and
 * are skipped; comments are skipped as whole spans.
 */
function topGroups(body: string): GroupBlock[] {
  const groups: GroupBlock[] = [];
  let pos = 0;
  let depth = 0;
  let curOpen = "";
  let curStart = -1;
  while (pos < body.length) {
    const open = body.indexOf("<g", pos);
    const close = body.indexOf("</g>", pos);
    const comment = body.indexOf("<!--", pos);
    let next = -1;
    let kind: "" | "open" | "close" | "comment" = "";
    if (open !== -1 && (next === -1 || open < next)) {
      next = open;
      kind = "open";
    }
    if (close !== -1 && (next === -1 || close < next)) {
      next = close;
      kind = "close";
    }
    if (comment !== -1 && (next === -1 || comment < next)) {
      next = comment;
      kind = "comment";
    }
    if (next === -1) break;
    if (kind === "comment") {
      const end = body.indexOf("-->", next);
      pos = end === -1 ? body.length : end + 3;
      continue;
    }
    if (kind === "close") {
      if (depth === 0) {
        pos = next + 4; // stray close; not in the pack, but don't hang
        continue;
      }
      depth--;
      if (depth === 0) {
        groups.push({ open: curOpen, inner: body.slice(curStart, next) });
        curStart = -1;
      }
      pos = next + 4;
      continue;
    }
    // "<g" must be a real tag start, not e.g. "<glyph".
    const c = body[next + 2];
    if (c !== " " && c !== "\t" && c !== "\n" && c !== "\r" && c !== ">" && c !== "/") {
      pos = next + 1;
      continue;
    }
    const tagEnd = body.indexOf(">", next);
    if (tagEnd === -1) break;
    const tag = body.slice(next, tagEnd + 1);
    if (tag.endsWith("/>")) {
      pos = tagEnd + 1; // self-closing empty layer: nothing to keep
      continue;
    }
    if (depth === 0) {
      depth = 1;
      curOpen = tag;
      curStart = tagEnd + 1;
    } else {
      depth++;
    }
    pos = tagEnd + 1;
  }
  return groups;
}

/** True for a layer whose own style hides it (pw's Reference Artwork). */
function isHiddenLayer(openTag: string): boolean {
  const m = /style\s*=\s*(["'])([\s\S]*?)\1/.exec(openTag);
  return m !== null && /display\s*:\s*none/i.test(m[2]);
}

/** True for an Inkscape layer group (<g inkscape:groupmode="layer">). */
function isLayer(openTag: string): boolean {
  return /inkscape:groupmode\s*=\s*(["'])layer\1/.test(openTag);
}

/**
 * Vendored line-art (rk) or filled silhouette (pw) → a clean filled SVG in
 * `color`: keep ONLY the first visible top-level <g> — in practice the
 * Outline layer. "Visible" = own style has no "display:none" (pw's Reference
 * Artwork layer is display:none and is skipped). "First" is document order
 * among top-level <g inkscape:groupmode="layer"> layers (a stray visible
 * non-layer <g> earlier in the document — e.g. converted text art in
 * pw B190D-1/2 — is not a silhouette and is skipped); if a file has no
 * inkscape layer at all, the first visible top-level <g> wins (keeps the
 * function total for non-inkscape SVGs). Empty self-closing layers carry no
 * content and are skipped. Every other top-level sibling is dropped
 * (<defs>, <metadata>, <sodipodi:namedview>, accent layers, …); in the kept
 * layer every element is filled with `color` and all stroke/stroke-*
 * declarations are dropped (also on the layer group itself — it can carry
 * `stroke:#000000`, which would otherwise be inherited by every path); emit
 * a bare root <svg xmlns width/height/viewBox> (the inkscape/sodipodi
 * namespace soup is stripped — the browser only needs xmlns + geometry, and
 * undeclared prefixes are a fatal XML parse error in <img> rasterization).
 *
 * Returns the input unchanged when it has no <svg> root or no visible
 * top-level layer.
 */
export function lineSvgToFill(svg: string, color: string): string {
  const svgStart = svg.indexOf("<svg");
  if (svgStart === -1) return svg;
  const c = svg[svgStart + 4];
  if (c !== undefined && !/[\s>]/.test(c)) return svg;
  const rootTagEnd = svg.indexOf(">", svgStart);
  if (rootTagEnd === -1) return svg;
  const rootTag = svg.slice(svgStart, rootTagEnd + 1);
  const closeStart = svg.lastIndexOf("</svg>");
  const body = svg.slice(rootTagEnd + 1, closeStart === -1 ? svg.length : closeStart);

  const groups = topGroups(body);
  const kept =
    groups.find((g) => isLayer(g.open) && !isHiddenLayer(g.open)) ??
    groups.find((g) => !isHiddenLayer(g.open));
  if (!kept) return svg;

  const rootParts = [`xmlns="http://www.w3.org/2000/svg"`];
  const rootAttrs = parseAttrs(rootTag.slice(4));
  for (const name of ["width", "height", "viewBox"]) {
    const v = rootAttrs.find((a) => a.name === name)?.value;
    if (v !== undefined) rootParts.push(`${name}="${escapeAttrValue(v)}"`);
  }
  return `<svg ${rootParts.join(" ")}>${cleanTag(kept.open, color)}${cleanInner(kept.inner, color)}</g></svg>`;
}
