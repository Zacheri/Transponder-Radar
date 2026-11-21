import { describe, expect, it, vi } from "vitest";
import { createTimeline, type TimelineApi } from "../src/ui/timeline.js";
import { formatSelectedTime } from "../src/ui/format.js";
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
    return { left: 0, width: this.rectWidth } as DOMRect;
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

function setup(opts: { markAdd?: (from: number, to: number) => void; markRemove?: (id: string) => void } = {}) {
  winListeners.clear();
  const root = new FakeEl("div");
  const api: TimelineApi = createTimeline(root as unknown as HTMLElement, {
    seek: vi.fn(),
    goLive: vi.fn(),
    ...opts,
  });
  const slider = must(find(root, (el) => el.attrs["aria-label"] === "Timeline scrubber"), "slider");
  const sel = must(find(root, (el) => el.className === "timeline-sel"), "selection label");
  const markBtn = find(root, (el) => el.className === "timeline-mark");
  return { api, slider, sel, markBtn };
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
    const { api, slider, markBtn } = setup({ markAdd, markRemove });
    api.setRange(FROM, TO);
    must(markBtn, "mark button").fire("click");
    slider.rectWidth = 1000;
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
