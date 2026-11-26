import { describe, expect, it, vi } from "vitest";
import { createRing, createTrafficPanel, humanize, RING_CAP } from "../src/ui/traffic.js";
import type { TrafficSample } from "../src/data/ws.js";

// Node-env Vitest without jsdom: minimal DOM shim covering exactly what the
// traffic panel touches (settings-drawer.test.ts idiom), plus the canvas
// seam: getContext("2d") returns a no-op recorder that records every call.

const recorder: { calls: { m: string; a: unknown[] }[] } = { calls: [] };
const CTX_METHODS = ["clearRect", "beginPath", "moveTo", "lineTo", "stroke", "setTransform"];

type Listener = (e?: unknown) => void;

class FakeEl {
  className = "";
  children: FakeEl[] = [];
  parent: FakeEl | null = null;
  clientWidth = 0;
  clientHeight = 0;
  width = 0;
  height = 0;
  readonly style: Record<string, string> = {};
  private _textContent = "";
  private readonly listeners = new Map<string, Listener[]>();
  private readonly classes = new Set<string>();
  constructor(readonly tag: string) {
    if (tag === "canvas") {
      this.clientWidth = 240;
      this.clientHeight = 64;
    }
  }
  get textContent(): string {
    return this._textContent;
  }
  set textContent(v: string) {
    this._textContent = v;
    this.children = [];
  }
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
  replaceChildren(...cs: FakeEl[]): void {
    this.children = [];
    this.append(...cs);
  }
  setAttribute(k: string, v: string): void {
    (this as Record<string, unknown>)[`attr:${k}`] = v;
  }
  attr(k: string): string | undefined {
    return (this as Record<string, unknown>)[`attr:${k}`] as string | undefined;
  }
  addEventListener(t: string, fn: Listener): void {
    const l = this.listeners.get(t) ?? [];
    l.push(fn);
    this.listeners.set(t, l);
  }
  remove(): void {
    if (!this.parent) return;
    this.parent.children = this.parent.children.filter((c) => c !== this);
    this.parent = null;
  }
  removeEventListener(t: string, fn: Listener): void {
    this.listeners.set(t, (this.listeners.get(t) ?? []).filter((f) => f !== fn));
  }
  fire(t: string): void {
    for (const fn of [...(this.listeners.get(t) ?? [])]) fn();
  }
  getContext(kind: string): unknown {
    if (kind !== "2d") return null;
    const ctx: Record<string, unknown> = {};
    for (const m of CTX_METHODS) ctx[m] = (...a: unknown[]) => recorder.calls.push({ m, a });
    return ctx;
  }
}

Object.assign(globalThis as object, {
  document: { createElement: (tag: string) => new FakeEl(tag), activeElement: null },
});

function makeStorage(initial: Record<string, string> = {}): {
  getItem: (k: string) => string | null;
  setItem: (k: string, v: string) => void;
  map: Map<string, string>;
} {
  const map = new Map(Object.entries(initial));
  return {
    getItem: (k) => map.get(k) ?? null,
    setItem: (k, v) => {
      map.set(k, v);
    },
    map,
  };
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

function byClass(root: FakeEl, cls: string): FakeEl {
  return must(find(root, (el) => el.className.split(" ").includes(cls)), cls);
}

/** The value cell (right span) of a two-cell traffic row. */
function val(root: FakeEl, cls: string): string {
  const row = byClass(root, cls);
  const cell = must(find(row, (el) => el.className.split(" ").includes("traffic-v")), "traffic-v");
  return cell.textContent;
}

function setup(o: { storage?: ReturnType<typeof makeStorage>; collapsed?: boolean; dpr?: number } = {}) {
  const root = new FakeEl("div");
  recorder.calls = [];
  const watch = vi.fn();
  const storage = o.storage ?? makeStorage(); // always fresh: no leakage between tests
  Object.assign(globalThis as object, { localStorage: storage });
  const ui = createTrafficPanel(root as unknown as HTMLElement, {
    watch,
    ...(o.collapsed === undefined ? {} : { collapsed: o.collapsed }),
    devicePixelRatio: o.dpr ?? 1,
    ResizeObserverCtor: null,
  });
  const head = byClass(root, "drawer-head");
  const canvas = must(find(root, (el) => el.tag === "canvas"), "canvas");
  return { ui, root, watch, head, canvas };
}

const SAMPLE: TrafficSample = {
  at: 1_700_000_000_000,
  radar: { up: 200, down: 100_000, upTotal: 999, downTotal: 40_000_000 },
  device: { up: 1500, down: 2_300_000, upTotal: 2_300_000, downTotal: 1_020_000_000 },
  top: null,
};

describe("humanize (ruling-2 pinned strings)", () => {
  it("renders the four pinned strings exactly", () => {
    expect(humanize(999)).toBe("999 B");
    expect(humanize(1500)).toBe("1.5 KB");
    expect(humanize(2_300_000)).toBe("2.3 MB");
    expect(humanize(1_020_000_000)).toBe("1.02 GB");
    expect(humanize(999_600)).toBe("1 MB");
  });
  it("stays consistent around the edges: 1000 base, trailing zeros trimmed", () => {
    expect(humanize(0)).toBe("0 B");
    expect(humanize(1000)).toBe("1 KB");
    expect(humanize(1050)).toBe("1.05 KB");
    expect(humanize(-5)).toBe("0 B");
    expect(humanize(Number.NaN)).toBe("0 B");
  });
});

describe("ring buffer", () => {
  it("pins 600 samples (10 min at the 1 Hz sample)", () => {
    expect(RING_CAP).toBe(600);
  });
  it("drops the oldest at the 601st push", () => {
    const r = createRing<number>(RING_CAP);
    for (let i = 1; i <= 601; i++) r.push(i);
    expect(r.size).toBe(600);
    const a = r.toArray();
    expect(a[0]).toBe(2);
    expect(a[a.length - 1]).toBe(601);
  });
  it("wraps a small ring in order", () => {
    const r = createRing<number>(4);
    for (let i = 1; i <= 5; i++) r.push(i);
    expect(r.toArray()).toEqual([2, 3, 4, 5]);
  });
});

describe("traffic panel persistence (radar.trafficPanel)", () => {
  it("absent storage starts collapsed; the watch still fires (compact readout)", () => {
    const s = makeStorage();
    const { root, watch } = setup({ storage: s });
    expect(byClass(root, "traffic-panel").classList.contains("collapsed")).toBe(true);
    expect(byClass(root, "drawer-head").attr("aria-expanded")).toBe("false");
    expect(watch).toHaveBeenCalledTimes(1);
    expect(watch).toHaveBeenCalledWith(true);
  });
  it('"0" and corrupt values are collapsed too', () => {
    for (const v of ["0", "garbage", "true"]) {
      const { root } = setup({ storage: makeStorage({ "radar.trafficPanel": v }) });
      expect(byClass(root, "traffic-panel").classList.contains("collapsed")).toBe(true);
    }
  });
  it('"1" restores expanded and fires watch(true) at boot', () => {
    const { root, watch, head } = setup({ storage: makeStorage({ "radar.trafficPanel": "1" }) });
    expect(byClass(root, "traffic-panel").classList.contains("collapsed")).toBe(false);
    expect(head.attr("aria-expanded")).toBe("true");
    expect(watch).toHaveBeenCalledTimes(1);
    expect(watch).toHaveBeenCalledWith(true);
  });
  it("toggling persists 1 for expanded and 0 for collapsed", () => {
    const s = makeStorage();
    const { head } = setup({ storage: s });
    head.fire("click");
    expect(s.map.get("radar.trafficPanel")).toBe("1");
    head.fire("click");
    expect(s.map.get("radar.trafficPanel")).toBe("0");
  });
});

describe("traffic panel watch lifecycle (panel-lifetime, 2026-11-26 ruling)", () => {
  it("creation fires watch(true) once; toggling never re-fires", () => {
    const { head, watch } = setup();
    expect(watch).toHaveBeenCalledTimes(1);
    head.fire("click");
    head.fire("click");
    head.fire("click");
    expect(watch).toHaveBeenCalledTimes(1);
    expect(watch).toHaveBeenCalledWith(true);
  });
  it("a collapsed panel still holds the watch (feeds the compact readout)", () => {
    const { watch, ui } = setup();
    ui.update(SAMPLE);
    ui.update(SAMPLE);
    expect(watch).toHaveBeenCalledTimes(1);
  });
  it("destroy releases the watch", () => {
    const { watch, ui } = setup();
    ui.destroy();
    expect(watch).toHaveBeenCalledTimes(2);
    expect(watch).toHaveBeenLastCalledWith(false);
  });
});

describe("traffic panel rendering", () => {
  it("bands render rate + today total per source and direction (value cells)", () => {
    const { ui, root } = setup({ collapsed: false });
    ui.update(SAMPLE);
    expect(val(root, "traffic-up-device")).toBe("1.5 KB/s · 2.3 MB");
    expect(val(root, "traffic-up-radar")).toBe("200 B/s · 999 B");
    expect(val(root, "traffic-down-device")).toBe("2.3 MB/s · 1.02 GB");
    expect(val(root, "traffic-down-radar")).toBe("100 KB/s · 40 MB");
  });
  it("totals rows show now/today/session from the device superset", () => {
    const { ui, root } = setup({ collapsed: false });
    ui.update(SAMPLE);
    expect(val(root, "traffic-total-now")).toBe("↑1.5 KB/s ↓2.3 MB/s");
    expect(val(root, "traffic-total-today")).toBe("↑2.3 MB ↓1.02 GB");
    expect(val(root, "traffic-total-session")).toMatch(/^↑.+ ↓.+/u);
  });
  it("null device degrades the device rows and switches totals to radar", () => {
    const { ui, root } = setup({ collapsed: false });
    ui.update({ ...SAMPLE, device: null });
    expect(val(root, "traffic-up-device")).toBe("—");
    expect(val(root, "traffic-down-device")).toBe("—");
    expect(val(root, "traffic-total-today")).toBe("↑999 B ↓40 MB");
  });
  it("collapsed updates keep the canvas cold but refresh the compact readout", () => {
    const { ui, root } = setup(); // collapsed at boot
    ui.update(SAMPLE);
    expect(recorder.calls.length).toBe(0);
    expect(byClass(root, "traffic-compact").textContent).toBe("u:1.5 KB/s d:2.3 MB/s");
    ui.update({ ...SAMPLE, device: null });
    expect(byClass(root, "traffic-compact").textContent).toBe("u:200 B/s d:100 KB/s");
  });
  it("top rows truncate to 3 and a null/absent top renders nothing", () => {
    const { ui, root } = setup({ collapsed: false });
    const top = [
      { proc: "alpha", bytes: 1_200_000 },
      { proc: "bravo", bytes: 800_000 },
      { proc: "charlie", bytes: 500_000 },
      { proc: "delta", bytes: 100_000 },
      { proc: "echo", bytes: 50_000 },
    ];
    ui.update({ ...SAMPLE, top });
    const topEl = byClass(root, "traffic-top");
    const rows = topEl.children.filter((c) => c.className.split(" ").includes("traffic-top-row"));
    expect(rows.length).toBe(3);
    const cells = (row: FakeEl) => row.children.map((c) => c.textContent);
    expect(cells(rows[0])).toEqual(["alpha", "1.2 MB"]);
    expect((rows[0] as unknown as { title: string }).title).toBe("alpha — 1.2 MB in the last 5 s");
    expect(rows.map((r) => r.textContent).join("")).not.toContain("delta");
    ui.update({ ...SAMPLE, top: null });
    expect(byClass(root, "traffic-top").children.length).toBe(0);
  });
});

describe("traffic panel a11y", () => {
  it("root is a labelled complementary landmark; the graph is hidden from AT", () => {
    const { root, canvas } = setup();
    const panel = byClass(root, "traffic-panel");
    expect(panel.attr("role")).toBe("complementary");
    expect(panel.attr("aria-label")).toBe("Network traffic");
    expect(canvas.attr("aria-hidden")).toBe("true");
  });
});

describe("traffic panel canvas", () => {
  it("update while collapsed buffers but draws nothing; expanding draws", () => {
    const { ui, root, head } = setup(); // collapsed at boot
    ui.update(SAMPLE);
    ui.update(SAMPLE);
    expect(recorder.calls.length).toBe(0);
    head.fire("click");
    expect(recorder.calls.some((c) => c.m === "clearRect")).toBe(true);
    expect(byClass(root, "traffic-panel").classList.contains("collapsed")).toBe(false);
    expect(val(root, "traffic-up-device")).toBe("1.5 KB/s · 2.3 MB");
  });
  it("the ring caps drawing at 600 points (601 samples → 599 segments per series)", () => {
    const { ui, head } = setup();
    for (let i = 0; i < 601; i++) ui.update(SAMPLE);
    head.fire("click");
    const lineTos = recorder.calls.filter((c) => c.m === "lineTo").length;
    expect(lineTos).toBe((RING_CAP - 1) * 2);
  });
  it("sizes the backing store by devicePixelRatio", () => {
    const { ui, canvas } = setup({ collapsed: false, dpr: 2 });
    ui.update(SAMPLE);
    expect(canvas.width).toBe(480);
    expect(canvas.height).toBe(128);
  });
  it("destroy removes the panel element and leaves the root intact", () => {
    const { ui, root } = setup({ collapsed: false });
    const sibling = new FakeEl("div");
    root.appendChild(sibling);
    ui.destroy();
    expect(root.children).toEqual([sibling]);
    ui.update(SAMPLE); // post-destroy updates are inert, must not throw
  });
});
