import { describe, it, expect } from "vitest";
import {
  PACK_COLORS,
  domainColor,
  hexToRgb,
  lineSvgToFill,
  recolorPixels,
  sniffImageType,
} from "../shared/pack-transforms.js";

// Mini rk line-art (C130-style): inkscape root, namedview + metadata,
// first top-level layer = Outline (one closed path, fill:none + black
// stroke), second layer = Accent (open path).
const rkFixture = `<?xml version="1.0" encoding="UTF-8" standalone="no"?>
<svg
   width="80mm"
   height="80mm"
   viewBox="-31 -32 80 80"
   version="1.1"
   id="svg1542"
   inkscape:version="1.2.1"
   sodipodi:docname="C130.svg"
   xmlns:inkscape="http://www.inkscape.org/namespaces/inkscape"
   xmlns:sodipodi="http://sodipodi.sourceforge.net/DTD/sodipodi-0.dtd"
   xmlns="http://www.w3.org/2000/svg">
  <sodipodi:namedview
     id="base"
     pagecolor="#ffffff"
     inkscape:current-layer="layer2" />
  <metadata
     id="metadata1539">
    <dc:title>C130 Hercules</dc:title>
  </metadata>
  <g
     inkscape:groupmode="layer"
     id="layer2"
     inkscape:label="Outline"
     style="display:inline">
    <path
       id="path1418"
       style="fill:none;stroke:#000000;stroke-width:0.264583px"
       d="M 0,0 L 80,0 L 40,80 Z" />
  </g>
  <g
     inkscape:groupmode="layer"
     id="layer3"
     inkscape:label="Accent"
     style="display:inline">
    <path
       id="path1449"
       style="fill:none;stroke:#000000;stroke-width:0.264583px"
       d="M 10,10 L 70,10" />
  </g>
</svg>
`;

// Mini pw filled art (A109-1-style): first top-level layer is the hidden
// Reference Artwork (display:none, base64 <image>), second = visible
// Outline (white fill + black stroke).
const pwFixture = `<?xml version="1.0" encoding="UTF-8" standalone="no"?>
<!-- Created with Inkscape (http://www.inkscape.org/) -->
<svg
   width="70"
   height="70"
   viewBox="0 0 18.520833 18.520833"
   version="1.1"
   id="svg1"
   xml:space="preserve"
   sodipodi:docname="A109-1.svg"
   xmlns:inkscape="http://www.inkscape.org/namespaces/inkscape"
   xmlns:sodipodi="http://sodipodi.sourceforge.net/DTD/sodipodi-0.dtd"
   xmlns:xlink="http://www.w3.org/1999/xlink"
   xmlns="http://www.w3.org/2000/svg"><sodipodi:namedview
     id="namedview1"
     pagecolor="#505050"
     inkscape:current-layer="layer2" /><defs
     id="defs1" /><g
     inkscape:label="Reference Artwork"
     inkscape:groupmode="layer"
     id="layer1"
     style="display:none;opacity:0.4"
     transform="matrix(0,0.0785014,-0.0785014,0,10.257384,8.4296098)"
     sodipodi:insensitive="true"><image
       width="198.96666"
       height="271.99167"
       preserveAspectRatio="none"
       xlink:href="data:image/png;base64,iVBORw0KGgoAAAAB" /></g><g
     inkscape:groupmode="layer"
     id="layer2"
     inkscape:label="Outline"
     style="display:inline"><path
       id="path1"
       style="fill:#ffffff;stroke:#000000;stroke-width:0.26458333"
       d="M 1,1 L 10,1 L 5,9 Z" /></g></svg>
`;

describe("PACK_COLORS", () => {
  it("pins the two domain colors", () => {
    expect(PACK_COLORS).toEqual({ military: "#ef5350", civil: "#4fc3f7" });
  });
});

// Mini pw file (B190D-style): a stray VISIBLE non-layer <g> (converted text
// art) precedes the inkscape layers; the silhouette is the first visible
// inkscape:groupmode="layer" layer, not the stray group.
const strayGroupFixture = `<?xml version="1.0" encoding="UTF-8" standalone="no"?>
<svg
   width="70"
   height="70"
   viewBox="0 0 18.520833 18.520833"
   xmlns:inkscape="http://www.inkscape.org/namespaces/inkscape"
   xmlns="http://www.w3.org/2000/svg"><g
     id="g52"><path
       d="M 9,9 L 90,9" /></g><g
     inkscape:groupmode="layer"
     id="layer1"
     inkscape:label="Reference Artwork"
     style="display:none;opacity:0.4"><image
       xlink:href="data:image/png;base64,iVBORw0KGgoAAAAB" /></g><g
     inkscape:groupmode="layer"
     id="layer2"
     inkscape:label="Outline"><path
       id="path1"
       style="fill:#ffffff;stroke:#000000"
       d="M 1,1 L 10,1 L 5,9 Z" /></g></svg>
`;

describe("pack-transforms", () => {
  it("domainColor", () => {
    expect(domainColor("military")).toBe("#ef5350");
    for (const k of ["commercial", "business", "general"]) expect(domainColor(k)).toBe("#4fc3f7");
    expect(domainColor("cargo")).toBe("#4fc3f7");
  });

  it("recolorPixels recolors near-white, keeps alpha, keeps black + colored pixels", () => {
    const d = new Uint8ClampedArray([
      255, 255, 255, 255, // white → recolor
      240, 240, 240, 128, // near-white, half alpha → recolor, alpha kept
      0, 0, 0, 255, // black hairline → untouched
      120, 60, 200, 255, // colored detail → untouched (g,b < 200)
      201, 201, 201, 1, // faint white edge → recolor
      255, 255, 255, 0, // transparent white → untouched (alpha 0)
    ]);
    recolorPixels(d, [239, 83, 80]);
    expect(Array.from(d.slice(0, 4))).toEqual([239, 83, 80, 255]);
    expect(Array.from(d.slice(4, 8))).toEqual([239, 83, 80, 128]);
    expect(Array.from(d.slice(8, 12))).toEqual([0, 0, 0, 255]);
    expect(Array.from(d.slice(12, 16))).toEqual([120, 60, 200, 255]);
    expect(Array.from(d.slice(16, 20))).toEqual([239, 83, 80, 1]);
    expect(Array.from(d.slice(20, 24))).toEqual([255, 255, 255, 0]);
  });

  it("lineSvgToFill keeps only the outline layer, fills, drops stroke + metadata + accent", () => {
    const out = lineSvgToFill(rkFixture, "#ef5350");
    expect(out).toContain("viewBox");
    expect(out).toContain("fill:#ef5350");
    expect(out).not.toContain("stroke:#000000");
    expect(out).not.toContain("Accent");
    expect(out).not.toContain("<metadata");
    expect(out.match(/<path/g)?.length).toBe(1); // outline path only
  });

  it("lineSvgToFill passes through a pw-style svg unchanged in layer count but still fills", () => {
    // pw SVG has a display:none layer that must be skipped: first VISIBLE g wins
    const out = lineSvgToFill(pwFixture, "#4fc3f7");
    expect(out).toContain("fill:#4fc3f7");
    expect(out).not.toContain("display:none");
  });

  it("lineSvgToFill skips a stray visible non-layer <g> before the layers (B190D shape)", () => {
    const out = lineSvgToFill(strayGroupFixture, "#4fc3f7");
    expect(out).toContain("fill:#4fc3f7");
    expect(out).toContain("M 1,1 L 10,1 L 5,9 Z"); // Outline path kept
    expect(out).not.toContain("M 9,9 L 90,9"); // stray text-art path dropped
    expect(out).not.toContain("g52");
    expect(out.match(/<g[\s>]/g)?.length).toBe(1); // Outline only, no nesting
  });

  it("hexToRgb", () => {
    expect(hexToRgb("#ef5350")).toEqual([239, 83, 80]);
  });

  it("sniffImageType detects PNG and JPEG by magic bytes (pd c5/kc10 are JPEGs named .png)", () => {
    expect(sniffImageType(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))).toBe("image/png");
    expect(sniffImageType(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]))).toBe("image/jpeg");
    expect(sniffImageType(Buffer.from("qux-png-bytes\n"))).toBe("image/png"); // fallback
  });
});
