import { describe, expect, it, vi } from "vitest";
import { createSettings } from "../src/ui/settings.js";
import type { SettingsStats } from "../src/ui/settings.js";

// Node-env Vitest without jsdom: a minimal DOM shim covering exactly what
// createSettings touches (document.createElement/activeElement, classList,
// dataset, child ops incl. replaceChildren and the textContent-clears-
// children idiom, listeners, window.setTimeout).

type Listener = () => void;

class FakeEl {
  className = "";
  value = "";
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
  fire(t: string): void {
    for (const fn of [...(this.listeners.get(t) ?? [])]) fn();
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

const STATS: SettingsStats = {
  storageCapGb: 10,
  ramCacheGb: 1,
  cacheUsedBytes: 0,
  usedBytes: 0,
  pinnedBytes: 0,
  pins: [],
};

function setup() {
  const root = new FakeEl("div");
  const opts = {
    update: vi.fn(),
    removePin: vi.fn(),
    parkHome: vi.fn(),
    clearHome: vi.fn(),
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
  return { ui, opts, park, clear, homeVal };
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
