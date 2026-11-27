import { describe, it, expect, vi } from "vitest";
import { createFilters } from "../src/ui/filters.js";
import {
  DEFAULT_ZONES_AUTO,
  parseZonesCfg,
  serializeZonesCfg,
  ZONES_CFG_KEY,
  type ZonesCfg,
} from "../src/ui/zones-cfg.js";
import type { CraftKind } from "../shared/craft.js";

// Node-env Vitest without jsdom: a DOM shim covering exactly what
// createFilters touches (incl. the apply() querySelectorAll scoping the
// boost checkboxes must escape) plus a fake localStorage.

type Listener = () => void;

class FakeEl {
  className = "";
  type = "";
  value = "";
  checked = false;
  children: FakeEl[] = [];
  parent: FakeEl | null = null;
  readonly dataset: Record<string, string> = {};
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
  prepend(c: FakeEl): void {
    c.parent = this;
    this.children.unshift(c);
  }
  append(...cs: FakeEl[]): void {
    for (const c of cs) this.appendChild(c);
  }
  // Only the exact selector filters.ts uses (the boost-row scoping guard).
  querySelectorAll(sel: string): FakeEl[] {
    if (sel !== "input[type=checkbox][data-kind]") throw new Error(`unsupported selector: ${sel}`);
    const out: FakeEl[] = [];
    const walk = (el: FakeEl): void => {
      if (el.tag === "input" && el.dataset.kind !== undefined) out.push(el);
      for (const c of el.children) walk(c);
    };
    walk(this);
    return out;
  }
  setAttribute(k: string, v: string): void {
    (this as Record<string, unknown>)[`attr:${k}`] = v;
  }
  addEventListener(t: string, fn: Listener): void {
    const l = this.listeners.get(t) ?? [];
    l.push(fn);
    this.listeners.set(t, l);
  }
  fire(t: string): void {
    for (const fn of [...(this.listeners.get(t) ?? [])]) fn();
  }
}

class FakeStorage {
  private m = new Map<string, string>();
  getItem(k: string): string | null {
    return this.m.has(k) ? this.m.get(k)! : null;
  }
  setItem(k: string, v: string): void {
    this.m.set(k, String(v));
  }
  removeItem(k: string): void {
    this.m.delete(k);
  }
}

Object.assign(globalThis as object, {
  document: { createElement: (tag: string) => new FakeEl(tag) },
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

const boostCb = (root: FakeEl, kind: string) => must(find(root, (el) => el.dataset.zkind === kind), `boost ${kind}`);
const filterCb = (root: FakeEl, kind: string) => must(find(root, (el) => el.dataset.kind === kind), `filter ${kind}`);

const DEFAULT_CFG: ZonesCfg = { kinds: [], boostMs: 30000, auto: DEFAULT_ZONES_AUTO };

function setup(opts?: { initial?: ZonesCfg; live?: ZonesCfg; color?: boolean }) {
  const root = new FakeEl("div");
  const onZonesChange = vi.fn();
  const initial = opts?.initial;
  // getLive is what emitZones merges onto; `live` lets a test model an
  // out-of-drawer edit (e.g. settings changing auto) and pin the merge.
  const live = opts?.live ?? initial;
  const zones = initial
    ? { initial, getLive: () => live!, onZonesChange }
    : undefined;
  const color = opts?.color
    ? {
        getColor: (k: CraftKind) => (k === "military" ? "#ff1122" : "#223344"),
        setColor: () => {},
      }
    : undefined;
  createFilters(root as unknown as HTMLElement, new Set<CraftKind>(["commercial"]), () => {}, color, zones);
  return { root, onZonesChange };
}

describe("filters drawer zones section", () => {
  it("renders nothing zones-related when the 5th arg is omitted", () => {
    Object.assign(globalThis as object, { localStorage: new FakeStorage() });
    const { root } = setup();
    expect(find(root, (el) => el.textContent === "Boost zones")).toBeUndefined();
    expect(find(root, (el) => el.dataset.zkind !== undefined)).toBeUndefined();
  });

  it("a restored config seeds the checkboxes and the pointer hint renders (no slider here anymore)", () => {
    const storage = new FakeStorage();
    storage.setItem(ZONES_CFG_KEY, serializeZonesCfg({ kinds: ["military"], boostMs: 45000, auto: DEFAULT_ZONES_AUTO }));
    Object.assign(globalThis as object, { localStorage: storage });
    const initial = parseZonesCfg(storage.getItem(ZONES_CFG_KEY));
    expect(initial).not.toBeNull();
    const { root } = setup({ initial: initial! });
    expect(boostCb(root, "military").checked).toBe(true);
    expect(boostCb(root, "general").checked).toBe(false);
    expect(find(root, (el) => el.textContent === "rate + options: Settings → Traffic boost")).toBeTruthy();
    // The rate slider MOVED to Settings → Traffic boost: no range input left.
    expect(find(root, (el) => el.tag === "input" && el.type === "range")).toBeUndefined();
  });

  it("checkbox change emits the checked kinds in AIR_KINDS order", () => {
    Object.assign(globalThis as object, { localStorage: new FakeStorage() });
    const { root, onZonesChange } = setup({ initial: DEFAULT_CFG });
    const mil = boostCb(root, "military");
    mil.checked = true;
    mil.fire("change");
    const gen = boostCb(root, "general");
    gen.checked = true;
    gen.fire("change");
    expect(onZonesChange.mock.calls.map((c) => (c[0] as ZonesCfg).kinds)).toEqual([
      ["military"],
      ["military", "general"],
    ]);
    expect((onZonesChange.mock.calls[0][0] as ZonesCfg).boostMs).toBe(30000);
  });

  it("checkbox change merges kinds onto the LIVE config — auto edits from settings survive", () => {
    Object.assign(globalThis as object, { localStorage: new FakeStorage() });
    // The T3 clobber hazard: emitZones used to spread a creation-time
    // snapshot, so a kinds edit after an auto change reverted it.
    const live: ZonesCfg = {
      kinds: [],
      boostMs: 45000,
      auto: { enabled: false, createMin: 7, standdownAt: 2 },
    };
    const { root, onZonesChange } = setup({ initial: DEFAULT_CFG, live });
    const gen = boostCb(root, "general");
    gen.checked = true;
    gen.fire("change");
    expect(onZonesChange).toHaveBeenCalledTimes(1);
    expect(onZonesChange.mock.calls[0][0]).toEqual({
      kinds: ["general"],
      boostMs: 45000,
      auto: { enabled: false, createMin: 7, standdownAt: 2 },
    });
  });

  it("filter actions (All/Sea-only/…) leave the boost checkboxes alone", () => {
    Object.assign(globalThis as object, { localStorage: new FakeStorage() });
    const { root } = setup({ initial: { kinds: ["military"], boostMs: 30000, auto: DEFAULT_ZONES_AUTO } });
    const seaOnly = must(find(root, (el) => el.tag === "button" && el.textContent === "Sea-only"), "Sea-only");
    seaOnly.fire("click");
    expect(boostCb(root, "military").checked).toBe(true);
    expect(filterCb(root, "cargo").checked).toBe(true);
    expect(filterCb(root, "commercial").checked).toBe(false);
  });

  it("boost checkboxes are tinted through the color api", () => {
    Object.assign(globalThis as object, { localStorage: new FakeStorage() });
    const { root } = setup({ initial: DEFAULT_CFG, color: true });
    const mil = boostCb(root, "military");
    expect(mil.style.accentColor).toBe("#ff1122");
    const sw = must(mil.parent?.children.find((c) => c.className === "swatch"), "military swatch");
    expect(sw.style.background).toBe("#ff1122");
  });
});
