import { describe, expect, it, vi } from "vitest";
import { createSettings } from "../src/ui/settings.js";
import type { SettingsStats } from "../src/ui/settings.js";
import { DEFAULT_ZONES_AUTO, type ZonesCfg } from "../src/ui/zones-cfg.js";
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

const findInputs = (root: FakeEl): FakeEl[] => {
  const out: FakeEl[] = [];
  const walk = (el: FakeEl): void => {
    if (el.tag === "input") out.push(el);
    for (const c of el.children) walk(c);
  };
  walk(root);
  return out;
};

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

const DEFAULT_CFG: ZonesCfg = { kinds: [], boostMs: 30000, auto: DEFAULT_ZONES_AUTO };

function setup(motionOn = true, storage = makeStorage(), zonesInitial: ZonesCfg = DEFAULT_CFG) {
  const root = new FakeEl("div");
  Object.assign(globalThis as object, { localStorage: storage });
  // Live-config holder: getZones() reads it, and tests mutate it to prove
  // every emit merges onto the CURRENT config (the auto-clobber guard).
  let live: ZonesCfg = zonesInitial;
  const opts = {
    update: vi.fn(),
    removePin: vi.fn(),
    parkHome: vi.fn(),
    clearHome: vi.fn(),
    motionOn,
    setMotion: vi.fn(),
    onArmRegion: vi.fn(),
    removeRegion: vi.fn(),
    zonesInitial,
    getZones: () => live,
    onZonesChange: vi.fn(),
    onRegionBoost: vi.fn(),
    kindColor: (k: string) => (k === "military" ? "#ff1122" : "#223344"),
  };
  const ui = createSettings(root as unknown as HTMLElement, opts);
  const setLive = (cfg: ZonesCfg): void => {
    live = cfg;
  };
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
    find(root, (el) => el.tag === "input" && el.type === "checkbox" && attr(el, "aria-label") === "Smooth motion"),
    "smooth-motion checkbox",
  );
  const arm = (label: string) =>
    must(find(root, (el) => el.tag === "button" && el.textContent === label), `${label} button`);
  const byAria = (label: string, tag?: string) =>
    must(
      find(root, (el) => attr(el, "aria-label") === label && (tag === undefined || el.tag === tag)),
      `${label} control`,
    );
  return {
    ui,
    opts,
    root,
    storage,
    setLive,
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
    autoCb: () => byAria("Auto hot zones", "input"),
    minSlider: () => byAria("Auto zone formation minimum", "input"),
    rateSlider: () => byAria("Auto poll interval", "input"),
    standdown: () => byAria("Auto stand-down", "select"),
    today: () => must(byClass(root, "settings-boost-today"), "cr-today span"),
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

// spec 2026-11-27 §F: the Traffic boost group (auto knobs + moved rate
// slider) sits above Map sections, and EVERY emit merges onto the live
// config — the auto-clobber guard (T3 warning).
const LIVE_CFG: ZonesCfg = {
  kinds: ["military"],
  boostMs: 45000,
  auto: { enabled: true, createMin: 4, standdownAt: 1 },
};

describe("settings Traffic boost group", () => {
  it("renders above Map sections with auto, form-≥N, rate and stand-down controls", () => {
    const { root } = setup();
    const titles = allByClass(root, "settings-group-title").map((t) => t.textContent);
    expect(titles).toContain("Traffic boost");
    expect(titles.indexOf("Traffic boost")).toBeLessThan(titles.indexOf("Map sections"));
  });

  it("auto checkbox change emits auto.enabled merged onto the LIVE config", () => {
    const { opts, setLive, autoCb } = setup();
    setLive(LIVE_CFG);
    autoCb().checked = false;
    autoCb().fire("change");
    expect(opts.onZonesChange).toHaveBeenCalledTimes(1);
    expect(opts.onZonesChange.mock.calls[0][0]).toEqual({
      kinds: ["military"],
      boostMs: 45000,
      auto: { enabled: false, createMin: 4, standdownAt: 1 },
    });
  });

  it("form-≥N slider emits a rounded createMin, rewrites its value, updates the span", () => {
    const { opts, setLive, minSlider } = setup(true, undefined, {
      ...DEFAULT_CFG,
      auto: { enabled: true, createMin: 4, standdownAt: 0 },
    });
    setLive({ ...DEFAULT_CFG, auto: { enabled: true, createMin: 4, standdownAt: 0 } });
    const s = minSlider();
    s.value = "7";
    s.fire("input");
    expect((opts.onZonesChange.mock.calls.at(-1)![0] as ZonesCfg).auto.createMin).toBe(7);
    // Out-of-range programmatic values self-heal (clamp 2–10, round).
    s.value = "12.6";
    s.fire("input");
    expect(s.value).toBe("10");
    expect((opts.onZonesChange.mock.calls.at(-1)![0] as ZonesCfg).auto.createMin).toBe(10);
    const val = must(find(s.parent!, (el) => el.className.split(" ").includes("settings-value")), "N span");
    expect(val.textContent).toBe("10");
  });

  it("form-≥N slider is disabled with aria-disabled while auto is off, live on toggle", () => {
    const { minSlider, autoCb } = setup(true, undefined, {
      ...DEFAULT_CFG,
      auto: { enabled: false, createMin: 2, standdownAt: 0 },
    });
    expect((minSlider() as unknown as { disabled?: boolean }).disabled).toBe(true);
    expect(attr(minSlider(), "aria-disabled")).toBe("true");
    const row = must(minSlider().parent ?? undefined, "form row");
    expect(row.className.split(" ")).toContain("settings-row-disabled");
    autoCb().checked = true;
    autoCb().fire("change");
    expect((minSlider() as unknown as { disabled?: boolean }).disabled).toBe(false);
    expect(attr(minSlider(), "aria-disabled")).toBe("false");
  });

  it("auto poll rate slider (moved from filters) emits a clamped boostMs", () => {
    const { opts, setLive, rateSlider } = setup();
    setLive({ ...LIVE_CFG, boostMs: 30000 });
    const s = rateSlider();
    s.value = "5000";
    s.fire("input");
    expect((opts.onZonesChange.mock.calls.at(-1)![0] as ZonesCfg).boostMs).toBe(10000);
    expect(s.value).toBe("10000");
    s.value = "500000";
    s.fire("input");
    expect((opts.onZonesChange.mock.calls.at(-1)![0] as ZonesCfg).boostMs).toBe(120000);
    expect(s.value).toBe("120000");
    // Kinds and auto are NOT this control's to change: they ride through.
    expect(opts.onZonesChange.mock.calls.at(-1)![0]).toEqual({
      kinds: ["military"],
      boostMs: 120000,
      auto: LIVE_CFG.auto,
    });
  });

  it("stand-down select maps its three options to 0/1/2", () => {
    const { opts, setLive, standdown } = setup();
    setLive(LIVE_CFG);
    const sel = standdown();
    const options = sel.children.map((o) => [o.value, o.textContent]);
    expect(options).toEqual([
      ["0", "never"],
      ["1", "after 1 boosted section"],
      ["2", "after 2 boosted sections"],
    ]);
    sel.value = "2";
    sel.fire("change");
    expect((opts.onZonesChange.mock.calls.at(-1)![0] as ZonesCfg).auto.standdownAt).toBe(2);
  });

  it("group header shows 'N cr today' from stats and hides at zero/absent", () => {
    const { ui, today } = setup();
    ui.setStats({ ...STATS, boostCreditsToday: 143 });
    expect(today().textContent).toBe("143 cr today");
    ui.setStats({ ...STATS, boostCreditsToday: 0 });
    expect(today().textContent).toBe("");
    ui.setStats(STATS);
    expect(today().textContent).toBe("");
  });
});

// Section boost editors (spec §F): chevron vs remove-click split, per-section
// enable/kinds/rate, and the money readout from shared/credits.
const BOOST_SEED: Region[] = [
  { id: "a", kind: "adsb", b: [[10, 100], [17, 112]] }, // 12° × 7° → cost 2
  { id: "b", kind: "adsb", b: [[0, 0], [4, 4]], boost: { enabled: true, kinds: ["military"], boostMs: 30000 } },
  { id: "c", kind: "ais", b: [[1, 1], [2, 2]] },
];

const chevrons = (row: FakeEl) =>
  row.children.filter((el) => el.className.split(" ").includes("settings-region-expand"));

const clickEvt = () => {
  let stopped = false;
  return { evt: { stopPropagation: () => (stopped = true) }, wasStopped: () => stopped };
};

describe("settings section boost editor", () => {
  it("ADS-B rows get a chevron (aria-expanded), AIS rows do not", () => {
    const { ui, rows } = setup();
    ui.setRegions(BOOST_SEED);
    const r = rows();
    expect(chevrons(r[0]).length).toBe(1);
    expect(chevrons(r[1]).length).toBe(1);
    expect(chevrons(r[2]).length).toBe(0);
    expect(attr(chevrons(r[0])[0], "aria-expanded")).toBe("false");
  });

  it("chevron click stops propagation, expands the editor, and never removes", () => {
    const { ui, opts, rows, root } = setup();
    ui.setRegions(BOOST_SEED);
    const { evt, wasStopped } = clickEvt();
    chevrons(rows()[0])[0].fire("click", evt);
    expect(wasStopped()).toBe(true);
    expect(opts.removeRegion).not.toHaveBeenCalled();
    expect(attr(chevrons(rows()[0])[0], "aria-expanded")).toBe("true");
    expect(byClass(root, "settings-region-editor")).toBeDefined();
    // Row click still removes.
    rows()[0].fire("click");
    expect(opts.removeRegion).toHaveBeenCalledWith("a");
  });

  it("editor shows enable, air-kind checkboxes (data-boost-kind, tinted, never data-kind) and rate", () => {
    const { ui, root, rows } = setup();
    ui.setRegions(BOOST_SEED);
    chevrons(rows()[0])[0].fire("click", clickEvt().evt);
    const ed = must(byClass(root, "settings-region-editor"), "editor");
    const cbs = findInputs(ed).filter((el) => el.type === "checkbox");
    const enable = cbs.find((el) => attr(el, "aria-label") === "Enable boost");
    expect(enable).toBeDefined();
    expect(enable!.checked).toBe(false);
    const kindCbs = cbs.filter((el) => el.dataset.boostKind !== undefined);
    expect(kindCbs.map((el) => el.dataset.boostKind)).toEqual(["commercial", "business", "military", "general"]);
    for (const el of cbs) expect(el.dataset.kind).toBeUndefined();
    expect(kindCbs.find((el) => el.dataset.boostKind === "military")!.style.accentColor).toBe("#ff1122");
    const slider = must(find(ed, (el) => el.tag === "input" && el.type === "range"), "rate slider");
    expect(attr(slider, "aria-label")).toBe("Section boost interval");
    // The stored-boost row seeds checked/enabled state from Region.boost.
    chevrons(rows()[1])[0].fire("click", clickEvt().evt);
    const eds = allByClass(root, "settings-region-editor");
    const ed2 = eds[eds.length - 1];
    const enable2 = must(find(ed2, (el) => attr(el, "aria-label") === "Enable boost"), "enable cb");
    expect(enable2.checked).toBe(true);
    const mil2 = must(find(ed2, (el) => el.dataset.boostKind === "military"), "military cb");
    expect(mil2.checked).toBe(true);
  });

  it("enable change emits {enabled:true, kinds:[], boostMs:30000} via onRegionBoost", () => {
    const { ui, opts, root, rows } = setup();
    ui.setRegions(BOOST_SEED);
    chevrons(rows()[0])[0].fire("click", clickEvt().evt);
    const ed = must(byClass(root, "settings-region-editor"), "editor");
    const enable = must(find(ed, (el) => attr(el, "aria-label") === "Enable boost"), "enable cb");
    enable.checked = true;
    enable.fire("change");
    expect(opts.onRegionBoost).toHaveBeenCalledWith("a", { enabled: true, kinds: [], boostMs: 30000 });
  });

  it("kind checkbox change emits canonical-order kinds preserving enable + rate", () => {
    const { ui, opts, root, rows } = setup();
    ui.setRegions(BOOST_SEED);
    chevrons(rows()[1])[0].fire("click", clickEvt().evt);
    const eds = allByClass(root, "settings-region-editor");
    const ed = eds[eds.length - 1];
    const gen = must(find(ed, (el) => el.dataset.boostKind === "general"), "general cb");
    gen.checked = true;
    gen.fire("change");
    const last = opts.onRegionBoost.mock.calls.at(-1)!;
    expect(last[0]).toBe("b");
    expect(last[1]).toEqual({ enabled: true, kinds: ["military", "general"], boostMs: 30000 });
  });

  it("rate slider emits a clamped boostMs and updates the ~cr/day readout", () => {
    const { ui, opts, root, rows } = setup();
    ui.setRegions(BOOST_SEED);
    chevrons(rows()[0])[0].fire("click", clickEvt().evt);
    const ed = must(byClass(root, "settings-region-editor"), "editor");
    const readout = must(byClass(ed, "settings-region-readout"), "readout");
    const cr = readout.children[0]; // shim: a parent's own textContent excludes children
    // 12° × 7° → area 84 → cost 2; 86 400 000/30 000 × 2 = 5 760.
    expect(cr.textContent).toBe("~5,760 cr/day");
    const slider = must(find(ed, (el) => el.tag === "input" && el.type === "range"), "rate slider");
    slider.value = "15000";
    slider.fire("input");
    expect(opts.onRegionBoost).toHaveBeenLastCalledWith("a", { enabled: false, kinds: [], boostMs: 15000 });
    expect(cr.textContent).toBe("~11,520 cr/day");
    slider.value = "900000";
    slider.fire("input");
    expect((opts.onRegionBoost.mock.calls.at(-1)![1] as { boostMs: number }).boostMs).toBe(120000);
  });

  it("setRegionActivity badges boosted ADS-B rows active/idle; unknown until first call", () => {
    const { ui, root, rows } = setup();
    ui.setRegions(BOOST_SEED);
    chevrons(rows()[1])[0].fire("click", clickEvt().evt);
    let lives = allByClass(root, "settings-region-live");
    expect(lives[lives.length - 1].textContent).toBe(""); // legacy frames: idle-unknown
    ui.setRegionActivity(new Set(["zz"]));
    lives = allByClass(root, "settings-region-live");
    expect(lives[lives.length - 1].textContent).toBe("idle");
    ui.setRegionActivity(new Set(["b"]));
    lives = allByClass(root, "settings-region-live");
    expect(lives[lives.length - 1].textContent).toBe("active");
  });

  it("setStats creditsToday does not disturb the editor's expansion", () => {
    const { ui, rows, root } = setup();
    ui.setRegions(BOOST_SEED);
    chevrons(rows()[0])[0].fire("click", clickEvt().evt);
    expect(byClass(root, "settings-region-editor")).toBeDefined();
    ui.setRegions(BOOST_SEED); // re-render path keeps the component-local set
    expect(byClass(root, "settings-region-editor")).toBeDefined();
    expect(byClass(root, "settings-boost-today")).toBeDefined();
  });
});
