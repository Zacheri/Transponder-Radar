import { describe, it, expect } from "vitest";
import {
  formatBytes,
  formatRangeLabel,
  formatPinRange,
  formatSelectedTime,
  formatReplayClock,
  dayTicks,
  formatSpeed,
} from "../src/ui/format.js";

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
