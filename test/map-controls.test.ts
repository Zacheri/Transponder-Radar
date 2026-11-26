import { describe, expect, it, vi } from "vitest";
import { applyStoredProjection, createMapControls, type ControlMap } from "../src/map/controls.js";
import type { StorageLike } from "../src/data/icon-colors.js";

// Node-env Vitest without jsdom: minimal DOM shim (traffic-panel.test.ts
// idiom) plus a map stub capturing setStyle/zoomIn/zoomOut/easeTo/getStyle
// and dispatching move/load listeners.

type Listener = (e?: unknown) => void;

class FakeEl {
  className = "";
  children: FakeEl[] = [];
  parent: FakeEl | null = null;
  readonly style: Record<string, string> = {};
  private _textContent = "";
  private readonly listeners = new Map<string, Listener[]>();
  private readonly classes = new Set<string>();
  constructor(readonly tag: string) {}
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
}

Object.assign(globalThis as object, {
  document: { createElement: (tag: string) => new FakeEl(tag), activeElement: null },
});

function makeStorage(initial: Record<string, string> = {}): StorageLike & { map: Map<string, string> } {
  const map = new Map(Object.entries(initial));
  return {
    map,
    getItem: (k) => map.get(k) ?? null,
    setItem: (k, v) => void map.set(k, v),
    removeItem: (k) => void map.delete(k),
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

// 4.7.1 fidelity: Style#serialize NEVER round-trips projection, and
// getStyle() reads undefined until the style has loaded (style.load flips
// it). loaded() additionally requires every visible tile — false nearly
// always on slow connections — so the controls must gate on
// isStyleLoaded(), exercised below with tiles deliberately never loaded.
function stubMap(opts: { styleLoaded?: boolean } = {}) {
  const listeners = new Map<string, Listener[]>();
  const onceListeners = new Map<string, Listener[]>();
  const bearing = { value: 0 };
  const state = { styleLoaded: opts.styleLoaded ?? false, tilesLoaded: false };
  const add = (m: Map<string, Listener[]>, t: string, fn: Listener) => {
    const l = m.get(t) ?? [];
    l.push(fn);
    m.set(t, l);
  };
  const map = {
    bearing,
    state,
    zoomIn: vi.fn(),
    zoomOut: vi.fn(),
    easeTo: vi.fn(),
    getBearing: vi.fn(() => bearing.value),
    getStyle: vi.fn(() => (state.styleLoaded ? { version: 8, layers: [], sources: {} } : undefined)),
    setStyle: vi.fn(),
    loaded: vi.fn(() => state.styleLoaded && state.tilesLoaded),
    isStyleLoaded: vi.fn(() => state.styleLoaded),
    once: vi.fn((t: string, fn: Listener) => add(onceListeners, t, fn)),
    on: vi.fn((t: string, fn: Listener) => add(listeners, t, fn)),
    off: vi.fn((t: string, fn: Listener) => {
      listeners.set(t, (listeners.get(t) ?? []).filter((f) => f !== fn));
    }),
    fire(t: string): void {
      if (t === "style.load") state.styleLoaded = true;
      if (t === "load") state.tilesLoaded = true;
      for (const fn of [...(listeners.get(t) ?? [])]) fn();
      const armed = onceListeners.get(t) ?? [];
      onceListeners.set(t, []);
      for (const fn of armed) fn();
    },
  };
  return map;
}

type StubMap = ReturnType<typeof stubMap>;

function setup(opts: { storage?: Record<string, string>; map?: StubMap } = {}) {
  const storage = makeStorage(opts.storage ?? {});
  const map = opts.map ?? stubMap();
  const root = new FakeEl("div");
  const control = createMapControls(storage);
  const el = control.onAdd(map as unknown as ControlMap) as unknown as FakeEl;
  root.appendChild(el);
  const buttons = ((): FakeEl[] => {
    const out: FakeEl[] = [];
    const walk = (n: FakeEl): void => {
      if (n.tag === "button") out.push(n);
      for (const c of n.children) walk(c);
    };
    walk(el);
    return out;
  })();
  const projBtn = byClass(el, "map-control-projection");
  return { storage, map, root, el, control, buttons, projBtn };
}

describe("control row structure", () => {
  it("renders four aria-labelled buttons in one group, in order", () => {
    const { el, buttons } = setup();
    expect(byClass(el, "map-control-row").className).toContain("maplibregl-ctrl");
    expect(buttons.map((b) => b.className)).toEqual([
      "map-control-zoom-out",
      "map-control-zoom-in",
      "map-control-compass",
      "map-control-projection",
    ]);
    for (const b of buttons) {
      expect(b.attr("aria-label")).toBeTruthy();
      expect((b as unknown as { title: string }).title).toBe(b.attr("aria-label"));
      expect(b.attr("type")).toBe("button");
    }
  });
  it("onRemove unregisters the move listener and drops the element", () => {
    const { control, root, el, map } = setup();
    control.onRemove(map as unknown as ControlMap);
    expect(map.off).toHaveBeenCalledWith("move", expect.any(Function));
    expect(root.children).toEqual([]);
    expect(el.parent).toBe(null);
  });
});

describe("zoom and compass buttons", () => {
  it("zoom out/in drive zoomOut/zoomIn", () => {
    const { map, buttons } = setup();
    buttons[0].fire("click");
    buttons[1].fire("click");
    expect(map.zoomOut).toHaveBeenCalledTimes(1);
    expect(map.zoomIn).toHaveBeenCalledTimes(1);
  });
  it("compass click resets bearing AND pitch in one easeTo", () => {
    const { map, buttons } = setup();
    buttons[2].fire("click");
    expect(map.easeTo).toHaveBeenCalledTimes(1);
    expect(map.easeTo.mock.calls[0]?.[0]).toEqual({ bearing: 0, pitch: 0 });
  });
  it("the compass arrow reflects the bearing and tracks the move event", () => {
    const { map, el } = setup();
    const arrow = byClass(el, "map-control-compass-arrow");
    expect(map.getBearing).toHaveBeenCalled();
    expect(arrow.style.transform).toBe("rotate(0deg)");
    map.bearing.value = 42;
    map.fire("move");
    expect(arrow.style.transform).toBe("rotate(-42deg)");
  });
});

describe("projection toggle", () => {
  it("reflects the stored projection on add (absent = globe pressed, click goes flat)", () => {
    const { projBtn } = setup();
    expect(projBtn.attr("aria-pressed")).toBe("true");
    expect(projBtn.textContent).toBe("\u{1F310}");
    expect(projBtn.attr("aria-label")).toBe("Flat view");
  });
  it("a stored mercator boots unpressed with the flat icon", () => {
    const { projBtn } = setup({ storage: { "radar.projection": "mercator" } });
    expect(projBtn.attr("aria-pressed")).toBe("false");
    expect(projBtn.textContent).toBe("\u25A6");
    expect(projBtn.attr("aria-label")).toBe("Globe view");
  });
  it("is a no-op before the style loads (getStyle would serialize nothing)", () => {
    const { map, storage, projBtn } = setup({ storage: { "radar.projection": "mercator" } });
    projBtn.fire("click");
    expect(map.setStyle).not.toHaveBeenCalled();
    expect(storage.map.get("radar.projection")).toBe("mercator");
    expect(projBtn.attr("aria-pressed")).toBe("false");
  });
  it("toggles with tiles still loading (loaded() is false on slow links)", () => {
    const { map, projBtn } = setup({
      storage: { "radar.projection": "mercator" },
      map: stubMap({ styleLoaded: true }),
    });
    expect(map.loaded()).toBe(false); // tiles deliberately never arrive
    projBtn.fire("click");
    expect(map.setStyle).toHaveBeenCalledTimes(1);
  });
  it("toggle rebuilds the serialized style with the projection (diff:false), persists, flips aria-pressed/icon/label", () => {
    const { map, storage, projBtn } = setup({
      storage: { "radar.projection": "mercator" },
      map: stubMap({ styleLoaded: true }),
    });
    projBtn.fire("click");
    expect(map.setStyle).toHaveBeenCalledTimes(1);
    expect(map.setStyle.mock.calls[0]?.[0]).toEqual({
      version: 8,
      layers: [],
      sources: {},
      projection: { type: "globe" },
    });
    expect(map.setStyle.mock.calls[0]?.[1]).toEqual({ diff: false });
    expect(storage.map.get("radar.projection")).toBe("globe");
    expect(projBtn.attr("aria-pressed")).toBe("true");
    expect(projBtn.textContent).toBe("\u{1F310}");
    expect(projBtn.attr("aria-label")).toBe("Flat view");
    expect((projBtn as unknown as { title: string }).title).toBe("Flat view");
    projBtn.fire("click");
    expect(map.setStyle.mock.calls[1]?.[0]).toMatchObject({ projection: { type: "mercator" } });
    expect(storage.map.get("radar.projection")).toBe("mercator");
    expect(projBtn.attr("aria-pressed")).toBe("false");
    expect(projBtn.textContent).toBe("\u25A6");
    expect(projBtn.attr("aria-label")).toBe("Globe view");
  });
});

describe("applyStoredProjection (style-URL basemaps only)", () => {
  it("applies globe once when loaded, as a full rebuild", () => {
    const { map, storage } = setup({ map: stubMap({ styleLoaded: true }) });
    storage.map.clear();
    applyStoredProjection(map as unknown as ControlMap, storage);
    expect(map.setStyle).toHaveBeenCalledTimes(1);
    expect(map.setStyle.mock.calls[0]?.[0]).toEqual({
      version: 8,
      layers: [],
      sources: {},
      projection: { type: "globe" },
    });
    expect(map.setStyle.mock.calls[0]?.[1]).toEqual({ diff: false });
  });
  it("stored mercator matches the projection-less style default: no setStyle", () => {
    const { map, storage } = setup({ map: stubMap({ styleLoaded: true }) });
    storage.map.set("radar.projection", "mercator");
    applyStoredProjection(map as unknown as ControlMap, storage);
    expect(map.setStyle).not.toHaveBeenCalled();
  });
  it("before style load, waits for the first style.load and applies exactly once", () => {
    const map = stubMap();
    const storage = makeStorage(); // absent → globe, vs the mercator style default
    applyStoredProjection(map as unknown as ControlMap, storage);
    expect(map.setStyle).not.toHaveBeenCalled();
    map.fire("style.load");
    map.fire("style.load");
    expect(map.setStyle).toHaveBeenCalledTimes(1);
    expect(map.setStyle.mock.calls[0]?.[0]).toMatchObject({ projection: { type: "globe" } });
  });
  it("reads storage at fire time, so a mercator saved pre-load is honored", () => {
    const map = stubMap();
    const storage = makeStorage();
    applyStoredProjection(map as unknown as ControlMap, storage);
    storage.map.set("radar.projection", "mercator");
    map.fire("style.load");
    expect(map.setStyle).not.toHaveBeenCalled();
  });
});
