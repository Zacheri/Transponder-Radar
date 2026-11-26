import { describe, expect, it, vi } from "vitest";
import { createTimeline, type TimelineApi } from "../src/ui/timeline.js";
import { formatSelectedTime, VIEW_PRESETS } from "../src/ui/format.js";
import type { ViewSel } from "../src/ui/format.js";
import { MIN_PIN_MS } from "../shared/limits.js";
import type { Pin } from "../src/data/ws.js";

// Node-env Vitest without jsdom: a minimal DOM shim covering exactly what
// createTimeline touches (document.createElement, classList, child ops,
// listeners, getBoundingClientRect, window add/removeEventListener).

type Ev = { clientX?: number; preventDefault?: () => void };
type Listener = (ev: Ev) => void;

class FakeEl {
  className = "";
  textContent = "";
  value = "";
  disabled = false;
  rectWidth = 0;
  rectLeft = 0;
  children: FakeEl[] = [];
  parent: FakeEl | null = null;
  readonly style: Record<string, string> = {};
  readonly attrs: Record<string, string> = {};
  private readonly listeners = new Map<string, Listener[]>();
  private readonly classes = new Set<string>();
  constructor(readonly tag: string) {}
  readonly classList = {
    add: (c: string) => {
      this.classes.add(c);
    },
    remove: (c: string) => {
      this.classes.delete(c);
    },
    toggle: (c: string, force?: boolean) => {
      const on = force ?? !this.classes.has(c);
      if (on) this.classes.add(c);
      else this.classes.delete(c);
    },
    contains: (c: string) => this.classes.has(c),
  };
  appendChild(c: FakeEl): FakeEl {
    c.parent = this;
    this.children.push(c);
    return c;
  }
  append(...cs: FakeEl[]): void {
    for (const c of cs) this.appendChild(c);
  }
  insertBefore(c: FakeEl, ref: FakeEl): FakeEl {
    c.parent = this;
    const i = this.children.indexOf(ref);
    this.children.splice(i < 0 ? this.children.length : i, 0, c);
    return c;
  }
  remove(): void {
    if (!this.parent) return;
    const i = this.parent.children.indexOf(this);
    if (i >= 0) this.parent.children.splice(i, 1);
    this.parent = null;
  }
  setAttribute(k: string, v: string): void {
    this.attrs[k] = v;
  }
  addEventListener(t: string, fn: Listener): void {
    const l = this.listeners.get(t) ?? [];
    l.push(fn);
    this.listeners.set(t, l);
  }
  removeEventListener(t: string, fn: Listener): void {
    this.listeners.set(t, (this.listeners.get(t) ?? []).filter((f) => f !== fn));
  }
  getBoundingClientRect() {
    return { left: this.rectLeft, width: this.rectWidth } as DOMRect;
  }
  fire(t: string, ev: Ev = {}): void {
    for (const fn of [...(this.listeners.get(t) ?? [])]) fn(ev);
  }
}

const winListeners = new Map<string, Listener[]>();
const fakeWindow = {
  addEventListener(t: string, fn: Listener) {
    const l = winListeners.get(t) ?? [];
    l.push(fn);
    winListeners.set(t, l);
  },
  removeEventListener(t: string, fn: Listener) {
    winListeners.set(t, (winListeners.get(t) ?? []).filter((f) => f !== fn));
  },
  setTimeout(fn: () => void, ms: number) {
    return setTimeout(fn, ms);
  },
  clearTimeout(h: ReturnType<typeof setTimeout>) {
    clearTimeout(h);
  },
};

Object.assign(globalThis as object, {
  document: { createElement: (tag: string) => new FakeEl(tag) },
  window: fakeWindow,
});

function fireWindow(t: string, ev: Ev = {}): void {
  for (const fn of [...(winListeners.get(t) ?? [])]) fn(ev);
}

function find(root: FakeEl, pred: (el: FakeEl) => boolean): FakeEl | undefined {
  if (pred(root)) return root;
  for (const c of root.children) {
    const hit = find(c, pred);
    if (hit) return hit;
  }
  return undefined;
}

function must(el: FakeEl | undefined, what: string): FakeEl {
  if (!el) throw new Error(`missing ${what}`);
  return el;
}

function setup(
  opts: {
    markAdd?: (from: number, to: number) => void;
    markRemove?: (id: string) => void;
    viewSelect?: (sel: ViewSel | null) => void;
  } = {},
) {
  winListeners.clear();
  const root = new FakeEl("div");
  const api: TimelineApi = createTimeline(root as unknown as HTMLElement, {
    seek: vi.fn(),
    goLive: vi.fn(),
    ...opts,
  });
  const slider = must(find(root, (el) => el.attrs["aria-label"] === "Timeline scrubber"), "slider");
  const overlay = find(root, (el) => el.className === "timeline-overlay");
  const sel = must(find(root, (el) => el.className === "timeline-sel"), "selection label");
  const markBtn = find(root, (el) => el.className === "timeline-mark");
  const view = find(root, (el) => el.className === "timeline-view");
  const presetSel = find(root, (el) => el.className === "timeline-view-preset");
  const custom = find(root, (el) => el.className === "timeline-view-custom");
  const fromInput = find(root, (el) => el.className === "timeline-view-from");
  const toInput = find(root, (el) => el.className === "timeline-view-to");
  const applyBtn = find(root, (el) => el.className === "timeline-view-apply");
  const resetBtn = find(root, (el) => el.className === "timeline-view-reset");
  return { api, root, slider, overlay, sel, markBtn, view, presetSel, custom, fromInput, toInput, applyBtn, resetBtn };
}

function pickOption(sel: FakeEl, label: string): FakeEl {
  return must(sel.children.find((o) => o.textContent === label), `option ${label}`);
}

// Range [0, 100000] with rect width 1000 maps clientX -> time = clientX * 100.
const FROM = 0;
const TO = 100_000;

function drag(slider: FakeEl, fromX: number, toX: number): void {
  slider.fire("mousedown", { clientX: fromX, preventDefault: () => {} });
  fireWindow("mouseup", { clientX: toX });
}

describe("timeline cursor vs. status-frame setRange (B4)", () => {
  it("setRange tracks live while no cursor has been set", () => {
    const { api, slider, sel } = setup();
    api.setRange(FROM, TO);
    expect(slider.value).toBe(String(TO));
    expect(sel.textContent).toBe("live");
    api.setRange(FROM, TO + 20_000);
    expect(slider.value).toBe(String(TO + 20_000));
    expect(sel.textContent).toBe("live");
  });

  it("keeps the playback cursor and time label through later setRange calls", () => {
    const { api, slider, sel } = setup();
    api.setRange(FROM, TO);
    api.setCursor(40_000);
    expect(slider.value).toBe("40000");
    api.setRange(FROM, TO + 20_000);
    expect(slider.value).toBe("40000");
    expect(sel.textContent).toBe(formatSelectedTime(40_000));
  });

  it("setLive clears the rewound state so setRange tracks live again", () => {
    const { api, slider, sel } = setup();
    api.setRange(FROM, TO);
    api.setCursor(40_000);
    api.setLive();
    expect(slider.value).toBe(String(TO));
    expect(sel.textContent).toBe("live");
    api.setRange(FROM, TO + 20_000);
    expect(slider.value).toBe(String(TO + 20_000));
    expect(sel.textContent).toBe("live");
  });
});

describe("timeline mark rounding (B9)", () => {
  function markSetup() {
    const markAdd = vi.fn();
    const markRemove = vi.fn();
    const { api, slider, overlay, markBtn } = setup({ markAdd, markRemove });
    api.setRange(FROM, TO);
    must(markBtn, "mark button").fire("click");
    // Click math lives in the overlay's rect (the as-drawn pin/tick space);
    // default it to the slider's rect unless a test pins an inset overlay.
    slider.rectWidth = 1000;
    const ov = must(overlay, "overlay");
    ov.rectWidth = 1000;
    return { api, slider, markAdd, markRemove };
  }

  it("creates the mark when second-rounding lifts the span to MIN_PIN_MS", () => {
    const { slider, markAdd, markRemove } = markSetup();
    drag(slider, 1, 596); // 100 ms -> 59,600 ms; rounds to [0, 60000]
    expect(markAdd).toHaveBeenCalledWith(0, MIN_PIN_MS);
    expect(markRemove).not.toHaveBeenCalled();
  });

  it("passes second-aligned bounds for a raw span of MIN_PIN_MS", () => {
    const { slider, markAdd } = markSetup();
    drag(slider, 6, 606); // 600 ms -> 60,600 ms; rounds to [1000, 61000]
    expect(markAdd).toHaveBeenCalledWith(1000, 61_000);
  });

  it("treats a short click inside a pin as removal, not a mark", () => {
    const { api, slider, markAdd, markRemove } = markSetup();
    const pins: Pin[] = [{ id: "p1", from: 10_000, to: 70_000 }];
    api.setPins(pins);
    drag(slider, 200, 200); // 20,000 ms, inside p1
    expect(markAdd).not.toHaveBeenCalled();
    expect(markRemove).toHaveBeenCalledWith("p1");
  });

  it("treats a short click outside any pin as nothing", () => {
    const { api, slider, markAdd, markRemove } = markSetup();
    api.setPins([{ id: "p1", from: 10_000, to: 70_000 }]);
    drag(slider, 800, 800); // 80,000 ms, outside p1
    expect(markAdd).not.toHaveBeenCalled();
    expect(markRemove).not.toHaveBeenCalled();
  });
});

describe("timeline view controls", () => {
  it("renders the controls row only when viewSelect is wired, before the track", () => {
    expect(setup().view).toBeUndefined();

    const { root, view, presetSel } = setup({ viewSelect: vi.fn() });
    const row = must(view, "view row");
    const labels = must(presetSel, "preset select").children.map((o) => o.textContent);
    expect(labels).toEqual([...VIEW_PRESETS.map((p) => p.label), "Custom…"]);
    const el = must(root.children[0], "timeline element");
    const track = must(find(el, (c) => c.className === "timeline-track"), "track");
    expect(el.children.indexOf(row)).toBeLessThan(el.children.indexOf(track));
  });

  it("choosing a preset option fires viewSelect with the table value", () => {
    const viewSelect = vi.fn();
    const { presetSel } = setup({ viewSelect });
    const sel = must(presetSel, "preset select");
    for (const preset of VIEW_PRESETS) {
      sel.value = pickOption(sel, preset.label).value;
      sel.fire("change");
      expect(viewSelect).toHaveBeenLastCalledWith({ mode: "preset", ms: preset.ms });
    }
    expect(viewSelect).toHaveBeenCalledTimes(VIEW_PRESETS.length);
  });

  it("Custom… reveals the inputs and apply fires the custom selection", () => {
    const viewSelect = vi.fn();
    const { presetSel, custom, fromInput, toInput, applyBtn } = setup({ viewSelect });
    const row = must(custom, "custom row");
    expect(row.style.display).toBe("none");

    const sel = must(presetSel, "preset select");
    sel.value = pickOption(sel, "Custom…").value;
    expect(sel.value).toBe("custom");
    sel.fire("change");
    expect(viewSelect).not.toHaveBeenCalled();
    expect(row.style.display).not.toBe("none");

    must(fromInput, "from input").value = "2026-11-01T10:00";
    must(toInput, "to input").value = "2026-11-02T10:00";
    must(applyBtn, "apply button").fire("click");
    expect(viewSelect).toHaveBeenCalledWith({
      mode: "custom",
      from: Date.parse("2026-11-01T10:00"),
      to: Date.parse("2026-11-02T10:00"),
    });
  });

  it("apply stays silent until both inputs parse to dates", () => {
    const viewSelect = vi.fn();
    const { fromInput, toInput, applyBtn } = setup({ viewSelect });
    const apply = must(applyBtn, "apply button");
    apply.fire("click");
    must(fromInput, "from input").value = "2026-11-01T10:00";
    apply.fire("click");
    must(toInput, "to input").value = "not a date";
    apply.fire("click");
    expect(viewSelect).not.toHaveBeenCalled();
  });

  it("reset restores the 14 d preset and fires viewSelect(null)", () => {
    const viewSelect = vi.fn();
    const { presetSel, custom, resetBtn } = setup({ viewSelect });
    const sel = must(presetSel, "preset select");
    sel.value = pickOption(sel, "24 h").value;
    sel.fire("change");
    must(resetBtn, "reset button").fire("click");
    expect(viewSelect).toHaveBeenLastCalledWith(null);
    expect(sel.value).toBe(pickOption(sel, "14 d").value);
    expect(must(custom, "custom row").style.display).toBe("none");
  });

  it("setViewSel mirrors the select display without firing viewSelect", () => {
    const viewSelect = vi.fn();
    const { api, presetSel } = setup({ viewSelect });
    const sel = must(presetSel, "preset select");
    api.setViewSel({ mode: "custom", from: 1, to: 2 });
    expect(sel.value).toBe(pickOption(sel, "Custom…").value);
    api.setViewSel({ mode: "preset", ms: 86_400_000 });
    expect(sel.value).toBe(pickOption(sel, "24 h").value);
    api.setViewSel(null);
    expect(sel.value).toBe(pickOption(sel, "14 d").value);
    expect(viewSelect).not.toHaveBeenCalled();
  });

  it("setViewSel(custom) reveals the custom row and prefills the inputs in local time", () => {
    const viewSelect = vi.fn();
    const { api, presetSel, custom, fromInput, toInput } = setup({ viewSelect });
    // 23:37/00:03 local straddle a UTC date boundary: UTC formatting
    // (toISOString) would put different strings in the datetime-local inputs.
    const from = new Date(2026, 10, 18, 23, 37).getTime();
    const to = new Date(2026, 10, 19, 0, 3).getTime();
    api.setViewSel({ mode: "custom", from, to });
    expect(must(presetSel, "preset select").value).toBe("custom");
    expect(must(custom, "custom row").style.display).toBe("flex");
    expect(must(fromInput, "from input").value).toBe("2026-11-18T23:37");
    expect(must(toInput, "to input").value).toBe("2026-11-19T00:03");
    expect(viewSelect).not.toHaveBeenCalled();
  });
});

describe("timeline out-of-window pins and cursor (review focus)", () => {
  it("clamps a fully out-of-window pin to the track edge and keeps it removable", () => {
    const markRemove = vi.fn();
    const { api, slider, overlay, markBtn, root } = setup({ markAdd: vi.fn(), markRemove });
    api.setRange(FROM, TO);
    api.setPins([{ id: "p1", from: 10_000, to: 70_000 }]);
    expect(() => api.setRange(200_000, 300_000)).not.toThrow();

    const pin = must(find(root, (el) => el.className === "timeline-pin"), "pin element");
    const left = Number.parseFloat(pin.style.left);
    const width = Number.parseFloat(pin.style.width);
    expect(left).toBe(0); // clamped to the left edge
    expect(width).toBeGreaterThanOrEqual(0);
    expect(width).toBeLessThanOrEqual(100);

    must(markBtn, "mark button").fire("click");
    slider.rectWidth = 1000;
    const ov = must(overlay, "overlay");
    ov.rectWidth = 1000;
    drag(slider, 0, 0); // click on the clamped edge position
    expect(markRemove).toHaveBeenCalledWith("p1");
  });

  it("clips a straddling pin to its visible span and removes it on an in-view click", () => {
    const markRemove = vi.fn();
    const { api, slider, overlay, markBtn, root } = setup({ markAdd: vi.fn(), markRemove });
    api.setRange(200_000, 300_000);
    api.setPins([{ id: "p1", from: 50_000, to: 250_000 }]);

    const pin = must(find(root, (el) => el.className === "timeline-pin"), "pin element");
    expect(Number.parseFloat(pin.style.left)).toBe(0);
    expect(Number.parseFloat(pin.style.width)).toBe(50); // visible span 200k–250k

    must(markBtn, "mark button").fire("click");
    slider.rectWidth = 1000;
    const ov = must(overlay, "overlay");
    ov.rectWidth = 1000;
    drag(slider, 250, 250); // 225,000 ms, inside the visible span
    expect(markRemove).toHaveBeenCalledWith("p1");
  });

  it("hits an end pin when clicking its drawn position on the inset overlay", () => {
    const markRemove = vi.fn();
    const { api, slider, overlay, markBtn } = setup({ markAdd: vi.fn(), markRemove });
    api.setRange(FROM, TO);
    api.setPins([{ id: "pe", from: FROM - 5_000, to: FROM }]); // clamps to 0%
    slider.rectWidth = 1000;
    // .timeline-overlay is inset 0 2px, so the 0% pin's drawn sliver sits at
    // x∈[2,4] — the click→time space must be the overlay's rect, not the
    // slider's full-width one (wave-4 "hit on the as-drawn span" invariant).
    const ov = must(overlay, "overlay");
    ov.rectLeft = 2;
    ov.rectWidth = 996;

    must(markBtn, "mark button").fire("click");
    drag(slider, 2, 2); // click on the drawn sliver's position
    expect(markRemove).toHaveBeenCalledWith("pe");
  });

  it("keeps the cursor label through a later window that excludes the cursor", () => {
    const { api, sel } = setup();
    api.setRange(FROM, TO);
    api.setCursor(40_000);
    expect(() => api.setRange(500_000, 600_000)).not.toThrow();
    expect(sel.textContent).toBe(formatSelectedTime(40_000));
    expect(sel.textContent).not.toBe("live");
  });
});
