import { describe, it, expect } from "vitest";
import {
  formatBytes,
  formatRangeLabel,
  formatPinRange,
  formatSelectedTime,
  formatReplayClock,
  dayTicks,
  formatSpeed,
  VIEW_PRESETS,
  DEFAULT_VIEW_SEL,
  computeViewWindow,
  parseViewSel,
} from "../src/ui/format.js";
import { HISTORY_WINDOW_MS } from "../shared/limits.js";

describe("formatBytes (1024-based, 1 decimal, .0 trimmed)", () => {
  it("formats the documented cases", () => {
    expect(formatBytes(0)).toBe("0 B");
    expect(formatBytes(1024)).toBe("1 KB");
    expect(formatBytes(1536)).toBe("1.5 KB");
    expect(formatBytes(1_048_576)).toBe("1 MB");
    expect(formatBytes(9 * 1024 ** 3)).toBe("9 GB");
    expect(formatBytes(9_600_000_000)).toBe("8.9 GB");
  });
});

describe("formatRangeLabel", () => {
  it("same local day shows only times", () => {
    expect(
      formatRangeLabel(
        new Date(2026, 9, 20, 9, 12).getTime(),
        new Date(2026, 9, 20, 14, 40).getTime(),
      ),
    ).toBe("09:12 – 14:40");
  });

  it("cross-day span is fully dated", () => {
    expect(
      formatRangeLabel(
        new Date(2026, 9, 20, 9, 12).getTime(),
        new Date(2026, 9, 26, 9, 12).getTime(),
      ),
    ).toBe("Oct 20 09:12 – Oct 26 09:12");
  });

  it("spans the year boundary", () => {
    expect(
      formatRangeLabel(
        new Date(2026, 11, 31, 23, 0).getTime(),
        new Date(2027, 0, 1, 1, 0).getTime(),
      ),
    ).toBe("Dec 31 23:00 – Jan 1 01:00");
  });
});

describe("formatPinRange", () => {
  it("dates the start and shows only the end time", () => {
    expect(
      formatPinRange(
        new Date(2026, 9, 20, 9, 12).getTime(),
        new Date(2026, 9, 20, 14, 40).getTime(),
      ),
    ).toBe("Oct 20 09:12 – 14:40");
  });

  it("still dates the start when the span crosses a day", () => {
    expect(
      formatPinRange(
        new Date(2026, 9, 20, 23, 30).getTime(),
        new Date(2026, 9, 21, 0, 15).getTime(),
      ),
    ).toBe("Oct 20 23:30 – 00:15");
  });
});

describe("formatSelectedTime (always dated)", () => {
  it("shows month/day + HH:MM:SS", () => {
    expect(formatSelectedTime(new Date(2026, 9, 26, 9, 12, 34).getTime())).toBe(
      "Oct 26 09:12:34",
    );
  });
});

describe("formatReplayClock", () => {
  it("same local day as now shows HH:MM:SS", () => {
    expect(
      formatReplayClock(
        new Date(2026, 9, 24, 14, 32, 5).getTime(),
        new Date(2026, 9, 24, 15, 0).getTime(),
      ),
    ).toBe("14:32:05");
  });

  it("different local day from now is dated HH:MM", () => {
    expect(
      formatReplayClock(
        new Date(2026, 9, 24, 14, 32, 0).getTime(),
        new Date(2026, 9, 25, 8, 0).getTime(),
      ),
    ).toBe("Oct 24 14:32");
  });

  it("omitted `now` defaults to actual now (non-today t is dated)", () => {
    const d = new Date();
    d.setDate(d.getDate() - 2);
    expect(formatReplayClock(d.getTime())).toBe(
      `${d.toLocaleDateString([], { month: "short", day: "numeric" })} ${d.toLocaleTimeString([], { hour12: false, hour: "2-digit", minute: "2-digit" })}`,
    );
  });
});

describe("dayTicks (local-midnight epochs strictly within (from, to])", () => {
  it("returns the two interior midnights for an Oct 20→Oct 22 span", () => {
    expect(
      dayTicks(
        new Date(2026, 9, 20, 9, 0).getTime(),
        new Date(2026, 9, 22, 10, 0).getTime(),
      ),
    ).toEqual([new Date(2026, 9, 21).getTime(), new Date(2026, 9, 22).getTime()]);
  });

  it("returns [] for a same-day span", () => {
    expect(
      dayTicks(
        new Date(2026, 9, 20, 9, 0).getTime(),
        new Date(2026, 9, 20, 15, 0).getTime(),
      ),
    ).toEqual([]);
  });

  it("includes `to` when it lands exactly on a local midnight", () => {
    expect(
      dayTicks(
        new Date(2026, 9, 20, 9, 0).getTime(),
        new Date(2026, 9, 22, 0, 0).getTime(),
      ),
    ).toEqual([new Date(2026, 9, 21).getTime(), new Date(2026, 9, 22).getTime()]);
  });

  it("excludes `from` when it lands exactly on a local midnight", () => {
    expect(
      dayTicks(
        new Date(2026, 9, 21, 0, 0).getTime(),
        new Date(2026, 9, 23, 10, 0).getTime(),
      ),
    ).toEqual([new Date(2026, 9, 22).getTime(), new Date(2026, 9, 23).getTime()]);
  });
});

describe("formatSpeed", () => {
  it("labels the step scale in min/s (0.5 → 60), d/s above a day", () => {
    expect(formatSpeed(30)).toBe("0.5 min/s");
    expect(formatSpeed(60)).toBe("1 min/s");
    expect(formatSpeed(90)).toBe("1.5 min/s");
    expect(formatSpeed(180)).toBe("3 min/s");
    expect(formatSpeed(300)).toBe("5 min/s");
    expect(formatSpeed(3_300)).toBe("55 min/s");
    expect(formatSpeed(3_600)).toBe("60 min/s");
    expect(formatSpeed(86_400)).toBe("1 d/s");
  });
});

const HOUR = 3_600_000;
const DAY = 86_400_000;
// A fixed history window; pure math, so absolute values do not matter.
const H0 = 1_700_000_000_000;
const H30D = H0 + 30 * DAY;

describe("VIEW_PRESETS / DEFAULT_VIEW_SEL", () => {
  it("is the 24 h / 3 d / 7 d / 14 d / All table in order", () => {
    expect(VIEW_PRESETS).toEqual([
      { label: "24 h", ms: 86_400_000 },
      { label: "3 d", ms: 259_200_000 },
      { label: "7 d", ms: 604_800_000 },
      { label: "14 d", ms: 1_209_600_000 },
      { label: "All", ms: null },
    ]);
  });

  it("defaults to the 14 d preset (== HISTORY_WINDOW_MS)", () => {
    expect(DEFAULT_VIEW_SEL).toEqual({ mode: "preset", ms: HISTORY_WINDOW_MS });
  });
});

describe("computeViewWindow", () => {
  it("returns null when history is missing (either end, or both)", () => {
    const sel = DEFAULT_VIEW_SEL;
    expect(computeViewWindow(null, null, sel)).toBeNull();
    expect(computeViewWindow(H0, null, sel)).toBeNull();
    expect(computeViewWindow(null, H30D, sel)).toBeNull();
  });

  it("preset 24 h over 30 d of history cuts exactly histTo − 24 h", () => {
    expect(computeViewWindow(H0, H30D, { mode: "preset", ms: DAY })).toEqual({
      from: H30D - DAY,
      to: H30D,
    });
  });

  it("preset larger than history clamps to histFrom", () => {
    const h3 = H0 + 3 * HOUR;
    expect(computeViewWindow(H0, h3, { mode: "preset", ms: DAY })).toEqual({
      from: H0,
      to: h3,
    });
  });

  it("preset ms null is the full range", () => {
    expect(computeViewWindow(H0, H30D, { mode: "preset", ms: null })).toEqual({
      from: H0,
      to: H30D,
    });
  });

  it("custom fully inside is passed through", () => {
    const sel = { mode: "custom" as const, from: H0 + DAY, to: H30D - DAY };
    expect(computeViewWindow(H0, H30D, sel)).toEqual({ from: sel.from, to: sel.to });
  });

  it("custom partially outside is intersected", () => {
    expect(
      computeViewWindow(H0, H30D, { mode: "custom", from: H0 - DAY, to: H0 + 2 * DAY }),
    ).toEqual({ from: H0, to: H0 + 2 * DAY });
  });

  it("custom fully outside clamps to a zero-width window at the near edge", () => {
    expect(
      computeViewWindow(H0, H30D, { mode: "custom", from: H30D + DAY, to: H30D + 2 * DAY }),
    ).toEqual({ from: H30D, to: H30D });
    expect(
      computeViewWindow(H0, H30D, { mode: "custom", from: H0 - 2 * DAY, to: H0 - DAY }),
    ).toEqual({ from: H0, to: H0 });
  });

  it("custom with from > to collapses at clamped to without swapping", () => {
    expect(
      computeViewWindow(H0, H30D, { mode: "custom", from: H0 + 3 * DAY, to: H0 + DAY }),
    ).toEqual({ from: H0 + DAY, to: H0 + DAY });
    expect(
      computeViewWindow(H0, H30D, { mode: "custom", from: H0 + 3 * DAY, to: H0 - DAY }),
    ).toEqual({ from: H0, to: H0 });
  });

  it("custom inverted with BOTH ends far outside collapses at clamped to", () => {
    expect(
      computeViewWindow(H0, H30D, { mode: "custom", from: H30D + 10 * DAY, to: H0 - 10 * DAY }),
    ).toEqual({ from: H0, to: H0 });
  });
});

describe("parseViewSel", () => {
  it("null input → null", () => {
    expect(parseViewSel(null)).toBeNull();
  });

  it("round-trips both modes", () => {
    for (const sel of [
      { mode: "preset", ms: DAY },
      { mode: "preset", ms: null },
      { mode: "custom", from: H0, to: H30D },
    ]) {
      expect(parseViewSel(JSON.stringify(sel))).toEqual(sel);
    }
  });

  it("rejects corrupt, non-object, malformed and out-of-domain values", () => {
    for (const raw of [
      "{bad",
      "[]",
      "null",
      '"preset"',
      "{}",
      '{"mode":"nope"}',
      '{"mode":"preset","ms":-5}',
      '{"mode":"preset","ms":0}',
      '{"mode":"preset","ms":"86400000"}',
      '{"mode":"preset"}',
      '{"mode":"custom","from":"x","to":1}',
      '{"mode":"custom","from":1}',
      '{"mode":"custom","from":0,"to":1}',
    ]) {
      expect(parseViewSel(raw), raw).toBeNull();
    }
  });
});
