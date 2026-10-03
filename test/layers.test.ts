import { describe, it, expect } from "vitest";
import { CRAFT_SOURCE_ID, craftLayerDefs } from "../src/map/layers.js";

describe("craftLayerDefs", () => {
  it("defines the three symbol layers on the craft source", () => {
    const defs = craftLayerDefs(["all"]);
    expect(defs.map((l) => l.id)).toEqual(["craft-icons", "craft-labels", "craft-sublabels"]);
    for (const l of defs) {
      expect((l as { source?: unknown }).source).toBe(CRAFT_SOURCE_ID);
      expect(l.type).toBe("symbol");
    }
  });

  it("gives every text layer a font served by both basemap glyph sets", () => {
    const defs = craftLayerDefs(["all"]);
    const textLayers = defs.filter(
      (l) => (l.layout as Record<string, unknown> | undefined)?.["text-field"],
    );
    expect(textLayers).toHaveLength(2);
    for (const l of textLayers) {
      expect((l.layout as Record<string, unknown>)["text-font"]).toEqual(["Noto Sans Regular"]);
    }
  });
});
