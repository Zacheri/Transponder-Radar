import { describe, it, expect } from "vitest";
import {
  addRegion,
  MIN_DEG,
  normalizeBox,
  parseRegions,
  regionLabel,
  REGION_COLORS,
  removeRegion,
  serializeRegions,
  sizeDeg,
  type Region,
} from "../src/data/regions.js";

const region = (id: string, kind: "adsb" | "ais" = "adsb"): Region => ({
  id,
  kind,
  b: [
    [10, 20],
    [30, 40],
  ],
});

describe("parseRegions / serializeRegions", () => {
  it("round-trips a two-kind list through the wire string", () => {
    const list = [region("a"), region("b", "ais")];
    expect(parseRegions(serializeRegions(list))).toEqual(list);
  });

  it("total garbage yields []", () => {
    for (const raw of [null, "", "not json", "{}", "5", '"adsb"', "null"]) {
      expect(parseRegions(raw)).toEqual([]);
    }
  });

  it("drops boxes with |lon| > 180 on either corner", () => {
    const raw = JSON.stringify([
      { id: "w", kind: "adsb", b: [[0, 181], [1, 185]] },
      { id: "x", kind: "adsb", b: [[0, -190], [1, -185]] },
      { id: "y", kind: "adsb", b: [[0, 175], [1, 190]] },
      { id: "ok", kind: "adsb", b: [[0, -180], [1, 180]] },
    ]);
    expect(parseRegions(raw).map((r) => r.id)).toEqual(["ok"]);
  });

  it("drops bad entries and keeps the valid ones", () => {
    const raw = JSON.stringify([
      region("ok"),
      { id: "x" },
      { id: "", kind: "adsb", b: [[0, 0], [1, 1]] },
      { id: "k", kind: "military", b: [[0, 0], [1, 1]] },
      { id: "s", kind: "adsb", b: [[0, 0], [1]] },
      { id: "t", kind: "adsb", b: [[0, 0], ["1", 1]] },
      { id: "u", kind: "adsb", b: [[91, 0], [92, 1]] },
      { id: "v", kind: "adsb", b: [[30, 40], [10, 20]] },
      "junk",
      null,
      region("ok2", "ais"),
    ]);
    expect(parseRegions(raw).map((r) => r.id)).toEqual(["ok", "ok2"]);
  });
});

describe("normalizeBox", () => {
  it("normalizes from all four drag directions", () => {
    const a = { lat: 10, lon: 20 };
    const b = { lat: 30, lon: 40 };
    const want: [[number, number], [number, number]] = [
      [10, 20],
      [30, 40],
    ];
    expect(normalizeBox(a, b)).toEqual(want);
    expect(normalizeBox(b, a)).toEqual(want);
    expect(normalizeBox({ lat: 10, lon: 40 }, { lat: 30, lon: 20 })).toEqual(want);
    expect(normalizeBox({ lat: 30, lon: 20 }, { lat: 10, lon: 40 })).toEqual(want);
  });
});

describe("addRegion", () => {
  it("appends a normalized region with the injected id", () => {
    const before: Region[] = [];
    const { list, region: added } = addRegion(before, "ais", { lat: 42, lon: -73 }, { lat: 40, lon: -75 }, () => "r1");
    expect(added).toEqual({
      id: "r1",
      kind: "ais",
      b: [
        [40, -75],
        [42, -73],
      ],
    });
    expect(list).toEqual([added]);
    expect(before).toHaveLength(0);
  });

  it("normalizes regardless of corner order", () => {
    const { region: a } = addRegion([], "adsb", { lat: 40, lon: -75 }, { lat: 42, lon: -73 }, () => "1");
    const { region: b } = addRegion([], "adsb", { lat: 42, lon: -73 }, { lat: 40, lon: -75 }, () => "2");
    expect(b?.b).toEqual(a?.b);
  });

  it("rejects degenerate and out-of-bounds drags, list unchanged", () => {
    const tiny = MIN_DEG / 2;
    const cases: [string, { lat: number; lon: number }, { lat: number; lon: number }][] = [
      ["zero area", { lat: 40, lon: 40 }, { lat: 40, lon: 40 }],
      ["sub-MIN_DEG lat", { lat: 40, lon: 40 }, { lat: 40 + tiny, lon: 41 }],
      ["sub-MIN_DEG lon", { lat: 40, lon: 40 }, { lat: 41, lon: 40 + tiny }],
      ["lat > 90", { lat: 40, lon: 40 }, { lat: 95, lon: 41 }],
      ["lat < −90", { lat: -91, lon: 40 }, { lat: 0, lon: 41 }],
      ["lon > 180 (corner b)", { lat: 40, lon: 40 }, { lat: 41, lon: 185 }],
      ["lon < −180 (corner a)", { lat: -40, lon: -181 }, { lat: 0, lon: 0 }],
      ["NaN corner", { lat: NaN, lon: 40 }, { lat: 41, lon: 41 }],
    ];
    for (const [what, a, b] of cases) {
      const list: Region[] = [region("keep")];
      const res = addRegion(list, "adsb", a, b, () => "x");
      expect(res.region, what).toBeNull();
      expect(res.list, what).toBe(list);
    }
  });

  it("accepts a span of exactly MIN_DEG and keeps prior entries", () => {
    const list = [region("keep")];
    const { list: next, region: added } = addRegion(
      list,
      "adsb",
      { lat: 0, lon: 0 },
      { lat: MIN_DEG, lon: 5 },
      () => "n",
    );
    expect(added).not.toBeNull();
    expect(next.map((r) => r.id)).toEqual(["keep", "n"]);
    expect(list).toHaveLength(1);
  });
});

describe("removeRegion", () => {
  it("drops the matching id and returns a new array", () => {
    const list = [region("a"), region("b"), region("c", "ais")];
    const next = removeRegion(list, "b");
    expect(next.map((r) => r.id)).toEqual(["a", "c"]);
    expect(list).toHaveLength(3);
    expect(removeRegion(list, "zzz")).toHaveLength(3);
  });
});

describe("labels, colors, size", () => {
  it("kinds map to their row labels and colors", () => {
    expect(regionLabel("adsb")).toBe("ADS-B area");
    expect(regionLabel("ais")).toBe("AIS area");
    expect(REGION_COLORS).toEqual({ adsb: "#4fc3f7", ais: "#4db6ac" });
  });

  it("sizeDeg reports the corner spans", () => {
    expect(sizeDeg(region("a"))).toEqual({ lon: 20, lat: 20 });
  });
});

describe("Region.boost round-trip (hazard 3)", () => {
  const rawWithBoost = JSON.stringify([
    {
      id: "a",
      kind: "adsb",
      b: [
        [0, 0],
        [1, 1],
      ],
      boost: { enabled: true, kinds: ["military", "general"], boostMs: 15000 },
    },
    {
      id: "b",
      kind: "ais",
      b: [
        [2, 3],
        [4, 5],
      ],
    },
  ]);

  it("parse → serialize → parse preserves boost (identity)", () => {
    const once = parseRegions(rawWithBoost);
    expect(once[0].boost).toEqual({ enabled: true, kinds: ["military", "general"], boostMs: 15000 });
    expect(once[1].boost).toBeUndefined();
    const again = parseRegions(serializeRegions(once));
    expect(again).toEqual(once);
    expect(serializeRegions(again)).toBe(serializeRegions(once));
  });

  it("old rows (no boost) parse unchanged — no boost key", () => {
    const [r] = parseRegions(JSON.stringify([{ id: "a", kind: "adsb", b: [[0, 0], [1, 1]] }]));
    expect(Object.prototype.hasOwnProperty.call(r, "boost")).toBe(false);
  });

  it("garbage boost drops the boost but keeps the entry", () => {
    for (const boost of [5, "x", null, [], {}, { boostMs: NaN }, { boostMs: "15000" }]) {
      const list = parseRegions(JSON.stringify([{ id: "a", kind: "adsb", b: [[0, 0], [1, 1]], boost }]));
      expect(list).toHaveLength(1);
      expect(list[0].id).toBe("a");
      expect(list[0].boost).toBeUndefined();
    }
  });

  it("kinds are filtered to AIR_KINDS, deduped and canonically ordered; enabled defaults false", () => {
    const [r] = parseRegions(
      JSON.stringify([
        {
          id: "a",
          kind: "adsb",
          b: [[0, 0], [1, 1]],
          boost: { kinds: ["general", "military", "military", "cargo", 1], boostMs: 30000 },
        },
      ]),
    );
    expect(r.boost).toEqual({ enabled: false, kinds: ["military", "general"], boostMs: 30000 });
  });

  it("non-array kinds coerce to []; boostMs is stored verbatim (assembly clamps)", () => {
    const [r] = parseRegions(
      JSON.stringify([
        { id: "a", kind: "adsb", b: [[0, 0], [1, 1]], boost: { kinds: "military", boostMs: 500000 } },
      ]),
    );
    expect(r.boost).toEqual({ enabled: false, kinds: [], boostMs: 500000 });
  });
});
