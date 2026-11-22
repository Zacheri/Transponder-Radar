import { afterAll, describe, expect, it, vi } from "vitest";
import { createHud } from "../src/ui/hud.js";
import type { FeedStatus } from "../src/data/ws.js";

// Node-env Vitest without jsdom: a minimal DOM shim covering exactly what
// createHud touches (document.createElement, classList, dataset, child ops
// incl. the textContent-clears-children idiom, listeners).

type Listener = () => void;

class FakeEl {
  className = "";
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
  document: { createElement: (tag: string) => new FakeEl(tag) },
});

// createHud keeps a wall-clock redraw alive; stub it out and restore after.
vi.stubGlobal("setInterval", () => 0);
vi.stubGlobal("clearInterval", () => {});
afterAll(() => vi.unstubAllGlobals());

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

function makeFeeds(ais: Partial<FeedStatus["ais"]>): FeedStatus {
  return {
    opensky: { lastOkAt: 1000, lastError: null, pollMs: 90000 },
    ais: {
      connected: true,
      enabled: true,
      lastError: null,
      lastMessageAt: 1000,
      flushMs: 120000,
      secondary: { enabled: false, connected: false, lastError: null, lastMessageAt: null, attributions: [] },
      ...ais,
    },
  };
}

function setup(): { setFeeds: (f: FeedStatus, t: number) => void; fill: FakeEl; feeds: FakeEl } {
  const root = new FakeEl("div");
  const hud = createHud(root as unknown as HTMLElement);
  return {
    setFeeds: hud.setFeeds,
    fill: must(find(root, (el) => el.className === "hud-fill"), "fill line"),
    feeds: must(find(root, (el) => el.className === "hud-feeds"), "feeds line"),
  };
}

describe("hud ais-fill line", () => {
  it("is empty until the fill feed is enabled and connected", () => {
    const { setFeeds, fill } = setup();
    expect(fill.textContent).toBe("");
    setFeeds(makeFeeds({}), 1000);
    expect(fill.textContent).toBe("");
  });

  it("shows up to 3 attributions joined by ' · ' when enabled and connected", () => {
    const { setFeeds, fill } = setup();
    setFeeds(
      makeFeeds({ secondary: { enabled: true, connected: true, lastError: null, lastMessageAt: 1000, attributions: ["AISHub", "NLOD", "Faro"] } }),
      1000,
    );
    expect(fill.textContent).toBe("AIS fill: AISHub · NLOD · Faro");
  });

  it("cuts to 3 attributions and adds a (+N) tail", () => {
    const { setFeeds, fill } = setup();
    setFeeds(
      makeFeeds({ secondary: { enabled: true, connected: true, lastError: null, lastMessageAt: 1000, attributions: ["A", "B", "C", "D", "E"] } }),
      1000,
    );
    expect(fill.textContent).toBe("AIS fill: A · B · C (+2)");
  });

  it("hides again when the fill feed drops (connected false)", () => {
    const { setFeeds, fill } = setup();
    setFeeds(
      makeFeeds({ secondary: { enabled: true, connected: true, lastError: null, lastMessageAt: 1000, attributions: ["AISHub"] } }),
      1000,
    );
    expect(fill.textContent).toBe("AIS fill: AISHub");
    setFeeds(
      makeFeeds({ secondary: { enabled: true, connected: false, lastError: "boom", lastMessageAt: 1000, attributions: ["AISHub"] } }),
      1000,
    );
    expect(fill.textContent).toBe("");
  });

  it("leaves the primary AIS text untouched and survives a legacy frame without secondary", () => {
    const { setFeeds, fill, feeds } = setup();
    const legacy = makeFeeds({}) as { ais: { secondary?: unknown } } & FeedStatus;
    delete (legacy.ais as { secondary?: unknown }).secondary;
    setFeeds(legacy, 1000);
    expect(fill.textContent).toBe("");
    expect(feeds.textContent).toContain("AIS: ok");
  });
});
