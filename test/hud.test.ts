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
    // Like the real DOM, a parent's text is its own text plus descendants'
    // (the boost-paused segment is a titled child span).
    return this._textContent + this.children.map((c) => c.textContent).join("");
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

describe("hud boost segment", () => {
  // Full-shape fixtures (wave-10 Boost): the HUD renders count/interval/
  // paused; zones rides along unrendered.
  type Boost = NonNullable<FeedStatus["opensky"]["boost"]>;

  function withBoost(boost?: Boost | null) {
    const { setFeeds, feeds } = setup();
    const f = makeFeeds({}) as FeedStatus;
    const os = f.opensky as { boost?: Boost | null };
    if (boost === undefined) delete os.boost;
    else os.boost = boost;
    setFeeds(f, 1000);
    return feeds.textContent;
  }

  it("appends count + effective interval when active with an interval", () => {
    const t = withBoost({ active: true, count: 4, intervalMs: 30000, paused: null, zones: 1 });
    expect(t).toMatch(/^OpenSky: ok · AIS: ok · Boost: 4 @30s$/);
  });

  it("shows a stretched interval verbatim (65s)", () => {
    const t = withBoost({ active: true, count: 2, intervalMs: 65000, paused: null, zones: 1 });
    expect(t).toContain(" · Boost: 2 @65s");
  });

  it("shows paused (no count) when active and paused, even if an interval lingers", () => {
    expect(withBoost({ active: true, count: 4, intervalMs: null, paused: "credits", zones: 1 })).toContain(" · Boost paused");
    expect(withBoost({ active: true, count: 4, intervalMs: 30000, paused: "credits", zones: 2 })).toContain(" · Boost paused");
  });

  it("shows nothing while active but not yet ticking (no interval, no pause)", () => {
    const t = withBoost({ active: true, count: 0, intervalMs: null, paused: null, zones: 1 });
    expect(t).not.toContain("Boost");
  });

  it("shows nothing for inactive, null, or a legacy frame without the field", () => {
    expect(withBoost({ active: false, count: 0, intervalMs: null, paused: null, zones: 0 })).not.toContain("Boost");
    expect(withBoost(null)).not.toContain("Boost");
    const t = withBoost(undefined);
    expect(t).toBe("OpenSky: ok · AIS: ok");
  });
});

describe("hud boost-paused tooltip", () => {
  const PAUSE_TITLE = "Slow the Aircraft-poll slider to fund zone polling";
  type Boost = NonNullable<FeedStatus["opensky"]["boost"]>;

  function withBoost(boost: Boost) {
    const { setFeeds, feeds } = setup();
    const f = makeFeeds({}) as FeedStatus;
    (f.opensky as { boost?: Boost }).boost = boost;
    setFeeds(f, 1000);
    return feeds;
  }

  const titled = (el: FakeEl) =>
    find(el, (e) => (e as unknown as Record<string, unknown>)["attr:title"] != null);

  it("carries the guidance title on the paused segment, text unchanged", () => {
    const feeds = withBoost({ active: true, count: 4, intervalMs: 30000, paused: "credits", zones: 1 });
    expect(feeds.textContent).toBe("OpenSky: ok · AIS: ok · Boost paused");
    const seg = must(titled(feeds), "titled paused segment");
    expect((seg as unknown as Record<string, unknown>)["attr:title"]).toBe(PAUSE_TITLE);
    expect(seg.textContent).toContain("Boost paused");
  });

  it("adds no title while boosting on a real interval, or with no boost", () => {
    const running = withBoost({ active: true, count: 4, intervalMs: 30000, paused: null, zones: 1 });
    expect(running.textContent).toBe("OpenSky: ok · AIS: ok · Boost: 4 @30s");
    expect(titled(running)).toBeUndefined();
    const idle = withBoost({ active: false, count: 0, intervalMs: null, paused: null, zones: 0 });
    expect(idle.textContent).toBe("OpenSky: ok · AIS: ok");
    expect(titled(idle)).toBeUndefined();
  });
});
