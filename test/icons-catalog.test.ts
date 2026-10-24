import { describe, it, expect } from "vitest";
import {
  coveredDesignators,
  packColor,
  renderCatalog,
} from "../server/icons-catalog.js";
import { PACK_COLORS } from "../shared/pack-transforms.js";

// Mini rk-style line SVG with a visible top-level <g>: lineSvgToFill keeps
// only the first visible top-level group and returns the input UNCHANGED
// when there is none, so the fixture must carry one.
const rkMini = '<svg viewBox="0 0 24 24"><g><path d="M0 0"/></g></svg>';

describe("renderCatalog", () => {
  it("catalog contains every cell, static icons, gaps, and veto badges", () => {
    const html = renderCatalog({
      cells: [
        { name: "pw:B737", title: "B737", license: "CC BY-NC-SA 4.0", style: "filled", svg: '<svg><path style="fill:#ffffff"/></svg>', color: "#4fc3f7", vetoed: false },
        { name: "rk:C130", title: "C-130", license: "GPL-3.0", style: "line", svg: rkMini, color: "#ef5350", vetoed: true },
        { name: "pd:E3", title: "E-3", license: "Public Domain", style: "gapfill", pngDataUrl: "data:image/png;base64,AAAA", color: "#ef5350", vetoed: false, cropTopRatio: 0.5 },
      ],
      staticIcons: [{ name: "narrowbody", svg: "<svg></svg>", color: "#4fc3f7" }],
      gaps: [{ designator: "E4", title: "Boeing E-4" }],
    });
    expect(html).toContain("pw:B737");
    expect(html).toContain("fill:#4fc3f7"); // filled cell recolored
    expect(html).toContain("rk:C130");
    expect(html).toContain("vetoed");
    expect(html).toContain("fill:#ef5350"); // line cell transformed
    expect(html).toContain("data:image/png;base64,AAAA");
    expect(html).toContain("Boeing E-4");
    expect(html).toContain("narrowbody");
  });

  it("cells without art still render their name", () => {
    const html = renderCatalog({
      cells: [{ name: "pd:EMPTY", title: "Empty", license: "PD", style: "gapfill", color: "#ef5350", vetoed: false }],
      staticIcons: [],
      gaps: [],
    });
    expect(html).toContain("pd:EMPTY");
  });

  it("static icons render raw svg (already colored by author)", () => {
    const html = renderCatalog({
      cells: [],
      staticIcons: [{ name: "cargo", svg: '<svg><path fill="#ffb74d"/></svg>', color: null }],
      gaps: [],
    });
    expect(html).toContain('<path fill="#ffb74d"/>');
  });
});

describe("packColor (ruling P7: color follows resolver assignment, not file source)", () => {
  it("military-table name → military", () => {
    expect(packColor("pd:KC10", "pd")).toBe(PACK_COLORS.military); // military table only
  });

  it("name in BOTH tables → military (military identity wins)", () => {
    expect(packColor("pd:CH47", "pd")).toBe(PACK_COLORS.military);
    expect(packColor("rk:H60", "rk")).toBe(PACK_COLORS.military);
  });

  it("civil-only name → civil", () => {
    expect(packColor("pw:A109", "pw")).toBe(PACK_COLORS.civil);
  });

  it("unassigned (extra coverage) → source-based: pw → civil, rk/pd → military", () => {
    expect(packColor("pw:ZZZZ", "pw")).toBe(PACK_COLORS.civil);
    expect(packColor("rk:ZZZZ", "rk")).toBe(PACK_COLORS.military);
    expect(packColor("pd:ZZZZ", "pd")).toBe(PACK_COLORS.military);
  });
});

describe("coveredDesignators (catalog gap list is resolver-based, both tables)", () => {
  it("collects the local names of rules whose pack is in the index", () => {
    const cov = coveredDesignators(new Set(["pd:CH47", "pw:A109"]));
    expect(cov.has("CH47")).toBe(true); // referenced by both tables
    expect(cov.has("A109")).toBe(true); // civil table
    expect(cov.has("KC10")).toBe(false); // pd:KC10 not in the given index
    expect(cov.has("E4")).toBe(false); // no art exists
  });

  it("empty index → no coverage", () => {
    expect(coveredDesignators(new Set()).size).toBe(0);
  });
});
