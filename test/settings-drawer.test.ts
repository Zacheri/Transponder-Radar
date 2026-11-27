import { describe, expect, it, vi } from "vitest";
import { createSettings } from "../src/ui/settings.js";
import type { SettingsStats } from "../src/ui/settings.js";
import type { Region } from "../src/data/regions.js";

// Node-env Vitest without jsdom: a minimal DOM shim covering exactly what
// createSettings touches (document.createElement/activeElement, classList,
// dataset, value/type/checked, child ops incl. replaceChildren and the
// textContent-clears-children idiom, listeners, window.setTimeout).

type Listener = (e?: unknown) => void;

class FakeEl {
  value = "";
  type = "";
  checked = false;
  title = "";
  children: FakeEl[] = [];
  parent: FakeEl | null = null;
  private readonly classes = new Set<string>();
  readonly dataset: Record<string, string> = {};
  readonly style: Record<string, string> = {};
  private _textContent = "";
  private readonly listeners = new Map<string, Listener[]>();
  // className and classList share one set, like the real DOM.
  get className(): string {
    return [...this.classes].join(" ");
  }
  set className(v: string) {
    this.classes.clear();
    for (const c of v.split(" ")) if (c) this.classes.add(c);
  }
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
  replaceChildren(...cs: FakeEl[]): void {
    this.children = [];
    this.append(...cs);
  }
  setAttribute(k: string, v: string): void {
    (this as Record<string, unknown>)[`attr:${k}`] = v;
  }
  addEventListener(t: string, fn: Listener): void {
    const l = this.listeners.get(t) ?? [];
    l.push(fn);
    this.listeners.set(t, l);
  }
  removeEventListener(t: string, fn: Listener): void {
    this.listeners.set(t, (this.listeners.get(t) ?? []).filter((f) => f !== fn));
  }
  fire(t: string, e?: unknown): void {
    for (const fn of [...(this.listeners.get(t) ?? [])]) fn(e);
  }
}

Object.assign(globalThis as object, {
  document: { createElement: (tag: string) => new FakeEl(tag), activeElement: null },
  window: {
    setTimeout: (fn: () => void, ms: number) => setTimeout(fn, ms),
    clearTimeout: (h: ReturnType<typeof setTimeout>) => clearTimeout(h),
  },
});

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

function byClass(root: FakeEl, cls: string): FakeEl | undefined {
  return find(root, (el) => el.className.split(" ").includes(cls));
}

function allByClass(root: FakeEl, cls: string): FakeEl[] {
  const out: FakeEl[] = [];
  const walk = (el: FakeEl): void => {
    if (el.className.split(" ").includes(cls)) out.push(el);
    for (const c of el.children) walk(c);
  };
  walk(root);
  return out;
}

const attr = (el: FakeEl, k: string): string | undefined =>
  (el as unknown as Record<string, unknown>)[`attr:${k}`] as string | undefined;

const STATS: SettingsStats = {
  storageCapGb: 10,
  ramCacheGb: 1,
  cacheUsedBytes: 0,
  usedBytes: 0,
  pinnedBytes: 0,
  pins: [],
};

// Fresh storage per drawer: boot collapse state and toggle persistence read
// this key, so it must not leak between tests.
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

function setup(motionOn = true, storage = makeStorage()) {
  const root = new FakeEl("div");
  Object.assign(globalThis as object, { localStorage: storage });
  const opts = {
    update: vi.fn(),
    removePin: vi.fn(),
    parkHome: vi.fn(),
    clearHome: vi.fn(),
    motionOn,
    setMotion: vi.fn(),
    onArmRegion: vi.fn(),
    removeRegion: vi.fn(),
  };
  const ui = createSettings(root as unknown as HTMLElement, opts);
  const park = must(
    find(root, (el) => el.tag === "button" && el.textContent.includes("Park")),
    "park button",
  );
  const clear = must(
    find(root, (el) => el.tag === "button" && el.textContent === "Clear"),
    "clear button",
  );
  const homeVal = must(byClass(root, "settings-home-value"), "home value display");
  const motion = must(
    find(root, (el) => el.tag === "input" && el.type === "checkbox"),
    "smooth-motion checkbox",
  );
  const arm = (label: string) =>
    must(find(root, (el) => el.tag === "button" && el.textContent === label), `${label} button`);
  return {
    ui,
    opts,
    root,
    storage,
    head: must(byClass(root, "drawer-head"), "drawer head"),
    cap: must(
      find(root, (el) => el.tag === "input" && el.type === "number"),
      "storage-cap input",
    ),
    park,
    clear,
    homeVal,
    motion,
    armAds: arm("+ ADS-B area"),
    armAis: arm("+ AIS area"),
    rows: () => allByClass(root, "settings-region-row"),
  };
}

describe("settings drawer AIS fill home controls", () => {
  it("park and clear buttons invoke their opt callbacks", () => {
    const { opts, park, clear } = setup();
    park.fire("click");
    expect(opts.parkHome).toHaveBeenCalledTimes(1);
    expect(opts.clearHome).not.toHaveBeenCalled();
    clear.fire("click");
    expect(opts.clearHome).toHaveBeenCalledTimes(1);
  });

  it("setStats shows the parked home coords", () => {
    const { ui, homeVal } = setup();
    ui.setStats({ ...STATS, homeRegion: { lat: 35.5, lon: -139.25 } });
    expect(homeVal.textContent).toBe("35.50, -139.25");
  });

  it("setStats shows 'not parked' for a null or absent homeRegion", () => {
    const { ui, homeVal } = setup();
    ui.setStats({ ...STATS, homeRegion: null });
    expect(homeVal.textContent).toBe("not parked");
    ui.setStats(STATS);
    expect(homeVal.textContent).toBe("not parked");
  });
});

describe("settings drawer smooth-motion row", () => {
  it("renders checked per the motionOn opt", () => {
    expect(setup(true).motion.checked).toBe(true);
    expect(setup(false).motion.checked).toBe(false);
  });

  it("change fires setMotion with the new checked value", () => {
    const { opts, motion } = setup(true);
    motion.checked = false; // a real browser flips checked before firing change
    motion.fire("change");
    expect(opts.setMotion).toHaveBeenCalledTimes(1);
    expect(opts.setMotion).toHaveBeenCalledWith(false);
    motion.checked = true;
    motion.fire("change");
    expect(opts.setMotion).toHaveBeenCalledTimes(2);
    expect(opts.setMotion).toHaveBeenLastCalledWith(true);
  });
});

describe("settings drawer park-button no-key state", () => {
  // createSettings sets `disabled` on a real HTMLButtonElement; the shim
  // carries it as a plain property.
  const disabledOf = (el: FakeEl) => (el as unknown as { disabled?: boolean }).disabled;

  it("disables and relabels the park button when secondaryEnabled is false", () => {
    const { ui, park } = setup();
    expect(disabledOf(park)).toBeFalsy();
    ui.setStats({ ...STATS, secondaryEnabled: false });
    expect(disabledOf(park)).toBe(true);
    expect(park.textContent).toBe("Needs AISCAST_API_KEY");
  });

  it("restores enabled + text when secondaryEnabled flips true", () => {
    const { ui, park } = setup();
    ui.setStats({ ...STATS, secondaryEnabled: false });
    ui.setStats({ ...STATS, secondaryEnabled: true });
    expect(disabledOf(park)).toBe(false);
    expect(park.textContent).toBe("Park AIS fill tile here");
  });

  it("treats a legacy frame without secondaryEnabled as enabled", () => {
    const { ui, park } = setup();
    ui.setStats({ ...STATS, secondaryEnabled: false });
    ui.setStats(STATS);
    expect(disabledOf(park)).toBe(false);
    expect(park.textContent).toBe("Park AIS fill tile here");
  });
});

// spec 2026-11-26 §B: rows render from caller data; armed state is pushed
// back in from main (it can flip from map-side events), so clicks forward
// and setRegionArmed is the single re-render path.
const SEED: Region[] = [
  { id: "a", kind: "adsb", b: [[10, 100], [17, 112]] },
  { id: "b", kind: "ais", b: [[34.5, -120.25], [40, -115]] },
];

describe("settings drawer Map sections list", () => {
  it("renders a row per region: chip color, label, size caption, title", () => {
    const { ui, rows } = setup();
    ui.setRegions(SEED);
    const r = rows();
    expect(r.length).toBe(2);
    expect(must(byClass(r[0], "settings-region-chip"), "chip").style.backgroundColor).toBe("#4fc3f7");
    expect(must(byClass(r[0], "settings-region-name"), "name").textContent).toBe("ADS-B area");
    expect(must(byClass(r[0], "settings-region-size"), "size").textContent).toBe("12° × 7°");
    expect(r[0].title).toBe("ADS-B area — click to remove");
    expect(must(byClass(r[1], "settings-region-chip"), "chip").style.backgroundColor).toBe("#4db6ac");
    expect(must(byClass(r[1], "settings-region-name"), "name").textContent).toBe("AIS area");
    expect(must(byClass(r[1], "settings-region-size"), "size").textContent).toBe("5.3° × 5.5°");
    expect(r[1].title).toBe("AIS area — click to remove");
  });

  it("shows the empty hint at boot and again when the list empties", () => {
    const { ui, root, rows } = setup();
    expect(rows().length).toBe(0);
    const hint = must(byClass(root, "settings-region-empty"), "empty hint");
    expect(hint.textContent).toBe("No sections yet — add one, then drag on the map.");
    ui.setRegions(SEED);
    expect(byClass(root, "settings-region-empty")).toBeUndefined();
    ui.setRegions([]);
    expect(rows().length).toBe(0);
    expect(byClass(root, "settings-region-empty")).toBeDefined();
  });

  it("clicking a row removes that region by id", () => {
    const { ui, opts, rows } = setup();
    ui.setRegions(SEED);
    rows()[0].fire("click");
    expect(opts.removeRegion).toHaveBeenCalledTimes(1);
    expect(opts.removeRegion).toHaveBeenCalledWith("a");
    rows()[1].fire("click");
    expect(opts.removeRegion).toHaveBeenLastCalledWith("b");
  });
});

describe("settings drawer Map sections arm buttons", () => {
  it("arm forwards the kind; re-click forwards null; the other kind switches", () => {
    const { ui, opts, armAds, armAis } = setup();
    armAds.fire("click");
    expect(opts.onArmRegion).toHaveBeenCalledTimes(1);
    expect(opts.onArmRegion).toHaveBeenCalledWith("adsb");
    ui.setRegionArmed("adsb"); // main echoes the armed state back
    armAds.fire("click");
    expect(opts.onArmRegion).toHaveBeenLastCalledWith(null);
    armAis.fire("click");
    expect(opts.onArmRegion).toHaveBeenLastCalledWith("ais");
  });

  it("setRegionArmed marks exactly one button (aria-pressed + class)", () => {
    const { ui, armAds, armAis } = setup();
    expect(attr(armAds, "aria-pressed")).toBe("false");
    ui.setRegionArmed("ais");
    expect(attr(armAis, "aria-pressed")).toBe("true");
    expect(armAis.className.split(" ")).toContain("settings-btn-armed");
    expect(attr(armAds, "aria-pressed")).toBe("false");
    ui.setRegionArmed(null);
    expect(attr(armAis, "aria-pressed")).toBe("false");
    expect(armAis.className.split(" ")).not.toContain("settings-btn-armed");
  });
});

// User report 2026-11-27: the storage cap auto-applied mid-typing ("it
// applied the first digit"). The input now commits on Enter only; Escape and
// blur restore; the display reformats only on a committed Enter.
describe("settings storage-cap commits on Enter", () => {
  it("typing posts nothing; Enter posts one settings.update", () => {
    const { ui, opts, cap } = setup();
    ui.setStats({ ...STATS, storageCapGb: 10 });
    expect(cap.value).toBe("10");
    cap.value = "1";
    cap.fire("input");
    cap.value = "12";
    cap.fire("input");
    expect(opts.update).not.toHaveBeenCalled();
    cap.fire("keydown", { key: "Enter" });
    expect(opts.update).toHaveBeenCalledTimes(1);
    expect(opts.update).toHaveBeenCalledWith({ storageCapGb: 12 });
    expect(cap.value).toBe("12");
  });

  it("the display reformats only on commit: '012.50' commits 12.5 and rewrites", () => {
    const { ui, opts, cap } = setup();
    ui.setStats({ ...STATS, storageCapGb: 10 });
    cap.value = "012.50";
    expect(cap.value).toBe("012.50");
    expect(opts.update).not.toHaveBeenCalled();
    cap.fire("keydown", { key: "Enter" });
    expect(opts.update).toHaveBeenCalledWith({ storageCapGb: 12.5 });
    expect(cap.value).toBe("12.5");
  });

  it("Escape posts nothing and restores the committed value", () => {
    const { ui, opts, cap } = setup();
    ui.setStats({ ...STATS, storageCapGb: 10 });
    cap.value = "1099";
    cap.fire("keydown", { key: "Escape" });
    expect(opts.update).not.toHaveBeenCalled();
    expect(cap.value).toBe("10");
  });

  it("blur restores without posting; a later Enter still commits", () => {
    const { ui, opts, cap } = setup();
    ui.setStats({ ...STATS, storageCapGb: 10 });
    cap.value = "7";
    cap.fire("blur");
    expect(opts.update).not.toHaveBeenCalled();
    expect(cap.value).toBe("10");
    cap.value = "8";
    cap.fire("keydown", { key: "Enter" });
    expect(opts.update).toHaveBeenCalledTimes(1);
    expect(opts.update).toHaveBeenCalledWith({ storageCapGb: 8 });
  });

  it("Enter on empty or non-numeric input posts nothing and keeps the text", () => {
    const { ui, opts, cap } = setup();
    ui.setStats({ ...STATS, storageCapGb: 10 });
    cap.value = "";
    cap.fire("keydown", { key: "Enter" });
    cap.value = "abc";
    cap.fire("keydown", { key: "Enter" });
    expect(opts.update).not.toHaveBeenCalled();
    expect(cap.value).toBe("abc");
  });

  it("setStats does not overwrite a focused input mid-typing", () => {
    const { ui, cap } = setup();
    ui.setStats({ ...STATS, storageCapGb: 10 });
    const doc = globalThis.document as unknown as { activeElement: unknown };
    doc.activeElement = cap;
    cap.value = "4";
    ui.setStats({ ...STATS, storageCapGb: 10 });
    expect(cap.value).toBe("4");
    doc.activeElement = null;
  });
});

// Item 2 regression pin: the settings drawer collapses from the same header
// bar that opened it (filters-drawer idiom), with aria-expanded round-tripping.
describe("settings drawer header toggle", () => {
  const isCollapsed = (root: FakeEl) =>
    must(byClass(root, "drawer-settings"), "drawer").className.split(" ").includes("collapsed");

  it("header click expands and collapses from the same area, round-tripping aria-expanded", () => {
    const { root, head, storage } = setup();
    expect(attr(head, "aria-expanded")).toBe("false"); // boot: collapsed
    expect(isCollapsed(root)).toBe(true);
    head.fire("click");
    expect(isCollapsed(root)).toBe(false);
    expect(attr(head, "aria-expanded")).toBe("true");
    expect(storage.map.get("radar.settingsCollapsed")).toBe("0");
    head.fire("click");
    expect(isCollapsed(root)).toBe(true);
    expect(attr(head, "aria-expanded")).toBe("false");
    expect(storage.map.get("radar.settingsCollapsed")).toBe("1");
  });

  it("Enter and Space toggle on the header; other keys do not", () => {
    const { root, head } = setup();
    head.fire("keydown", { key: "x" });
    expect(isCollapsed(root)).toBe(true);
    head.fire("keydown", { key: "Enter" });
    expect(isCollapsed(root)).toBe(false);
    head.fire("keydown", { key: " ", preventDefault: () => {} });
    expect(isCollapsed(root)).toBe(true);
  });
});
