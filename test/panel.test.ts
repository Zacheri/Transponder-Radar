import { describe, expect, it, vi } from "vitest";
import { createPanel } from "../src/ui/panel.js";
import type { AirportRef, FlightRoute } from "../src/data/ws.js";
import type { Craft } from "../shared/craft.js";
import { haversineMeters, MS_PER_KNOT } from "../shared/geo.js";

// Node-env Vitest without jsdom: a minimal DOM shim covering exactly what
// createPanel touches (document.createElement, classList, dataset, child ops
// incl. the textContent-clears-children idiom, listeners, querySelector).

type Listener = () => void;

class FakeEl {
  className = "";
  value = "";
  open = false;
  readonly dataset: Record<string, string> = {};
  readonly style: Record<string, string> = {};
  children: FakeEl[] = [];
  parent: FakeEl | null = null;
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
  querySelector(sel: string): FakeEl | undefined {
    const cls = sel.startsWith(".") ? sel.slice(1) : sel;
    for (const c of this.children) {
      if (c.className === cls) return c;
      const hit = c.querySelector(sel);
      if (hit) return hit;
    }
    return undefined;
  }
  fire(t: string): void {
    for (const fn of [...(this.listeners.get(t) ?? [])]) fn();
  }
}

Object.assign(globalThis as object, {
  document: { createElement: (tag: string) => new FakeEl(tag) },
  window: {
    setInterval: () => 1,
    clearInterval: () => {},
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

function findAll(root: FakeEl, pred: (el: FakeEl) => boolean): FakeEl[] {
  const out: FakeEl[] = [];
  const walk = (el: FakeEl): void => {
    if (pred(el)) out.push(el);
    for (const c of el.children) walk(c);
  };
  walk(root);
  return out;
}

// Value cell of the panel-row whose key reads `label` ("—" renders as such).
function rowValue(root: FakeEl, label: string): string | undefined {
  const hit = findAll(root, (el) => el.className === "panel-row").find(
    (r) => r.children[0]?.textContent === label,
  );
  return hit?.children[1]?.textContent;
}

function allText(el: FakeEl): string {
  return el.textContent + el.children.map(allText).join(" ");
}

const AIR: Craft = {
  id: "a00560",
  domain: "air",
  kind: "commercial",
  lat: 37.6,
  lon: -122.4,
  speed: 450,
  heading: 90,
  callsign: "UAL1",
  updatedAt: 1,
  stale: false,
};

const SEA: Craft = {
  id: "367000000",
  domain: "sea",
  kind: "cargo",
  lat: 40,
  lon: -74,
  speed: 12,
  heading: null,
  shipName: "TEST CARRIER",
  updatedAt: 1,
  stale: false,
};

const DEP: AirportRef = {
  code: "KSFO",
  icao: "KSFO",
  iata: "SFO",
  name: "San Francisco Intl",
  city: "San Francisco",
  country: "US",
  lat: 37.62,
  lon: -122.38,
};

const ARR: AirportRef = {
  code: "KJFK",
  icao: "KJFK",
  iata: "JFK",
  name: "John F. Kennedy Intl",
  city: "New York",
  country: "US",
  lat: 40.64,
  lon: -73.78,
};

const ROUTE: FlightRoute = { airline: "UA", dep: DEP, arr: ARR, source: "adsbdb" };

type Hooks = Parameters<typeof createPanel>[1];

function setup(hooks: Hooks = {}) {
  const root = new FakeEl("div");
  const panel = createPanel(root as unknown as HTMLElement, hooks);
  return { panel, root };
}

describe("panel route chips", () => {
  it("renders dep+arr chips labeled IATA · city", () => {
    const { panel, root } = setup({ getRoute: () => ROUTE });
    panel.show(AIR);
    expect(must(byClass(root, "panel-chip-dep"), "dep chip").textContent).toBe("SFO · San Francisco");
    expect(must(byClass(root, "panel-chip-arr"), "arr chip").textContent).toBe("JFK · New York");
  });

  it("falls back to icao/code when no IATA", () => {
    const { panel, root } = setup({
      getRoute: () => ({
        ...ROUTE,
        dep: { ...DEP, iata: null },
        arr: { ...ARR, iata: null, icao: null, city: null },
      }),
    });
    panel.show(AIR);
    expect(must(byClass(root, "panel-chip-dep"), "dep chip").textContent).toBe("KSFO · San Francisco");
    expect(must(byClass(root, "panel-chip-arr"), "arr chip").textContent).toBe("KJFK");
  });

  it("null route renders the no-route-data row", () => {
    const { panel, root } = setup({ getRoute: () => null });
    panel.show(AIR);
    expect(allText(root)).toContain("no route data");
    expect(byClass(root, "panel-chip-dep")).toBeUndefined();
  });

  it("unknown route renders the pending placeholder", () => {
    const { panel, root } = setup({ getRoute: () => undefined });
    panel.show(AIR);
    expect(byClass(root, "panel-chip-arr")).toBeUndefined();
    expect(allText(root)).toContain("Route …");
  });

  it("chip click with coords fires onDestClick with name and coords", () => {
    const onDestClick = vi.fn();
    const { panel, root } = setup({ getRoute: () => ROUTE, onDestClick });
    panel.show(AIR);
    must(byClass(root, "panel-chip-arr"), "arr chip").fire("click");
    expect(onDestClick).toHaveBeenCalledWith({ name: "John F. Kennedy Intl", lat: 40.64, lon: -73.78 });
    must(byClass(root, "panel-chip-dep"), "dep chip").fire("click");
    expect(onDestClick).toHaveBeenLastCalledWith({ name: "San Francisco Intl", lat: 37.62, lon: -122.38 });
  });

  it("chip without coords renders inert", () => {
    const onDestClick = vi.fn();
    const { panel, root } = setup({
      getRoute: () => ({ ...ROUTE, arr: { ...ARR, lat: null, lon: null } }),
      onDestClick,
    });
    panel.show(AIR);
    must(byClass(root, "panel-chip-arr"), "arr chip").fire("click");
    expect(onDestClick).not.toHaveBeenCalled();
  });

  it("vessels render no chips, trail button or notes", () => {
    const { panel, root } = setup({ getRoute: () => ROUTE, getBudget: () => ({ autoLeft: 0, hard: false }) });
    panel.show(SEA);
    expect(byClass(root, "panel-chips")).toBeUndefined();
    expect(byClass(root, "panel-trail-refresh")).toBeUndefined();
    expect(byClass(root, "panel-note")).toBeUndefined();
  });
});

describe("panel trail budget", () => {
  it("autoLeft 0 renders the paused note row", () => {
    const { panel, root } = setup({ getRoute: () => null, getBudget: () => ({ autoLeft: 0, hard: false }) });
    panel.show(AIR);
    expect(must(byClass(root, "panel-note"), "note").textContent).toBe(
      "trail auto-refresh paused (daily limit)",
    );
  });

  it("hard renders the fetch-limit note instead", () => {
    const { panel, root } = setup({ getRoute: () => null, getBudget: () => ({ autoLeft: 0, hard: true }) });
    panel.show(AIR);
    const note = must(byClass(root, "panel-note"), "note").textContent;
    expect(note).toBe("daily trail fetch limit reached");
    expect(note).not.toContain("auto-refresh paused");
  });

  it("healthy budget renders no note", () => {
    const { panel, root } = setup({ getRoute: () => null, getBudget: () => ({ autoLeft: 240, hard: false }) });
    panel.show(AIR);
    expect(byClass(root, "panel-note")).toBeUndefined();
  });

  it("the trail button fires requestTrail with the selected id", () => {
    const requestTrail = vi.fn();
    const { panel, root } = setup({ getRoute: () => null, requestTrail });
    panel.show(AIR);
    must(byClass(root, "panel-trail-refresh"), "refresh button").fire("click");
    expect(requestTrail).toHaveBeenCalledWith(AIR.id);
  });
});

describe("panel flight-context round-trip (setInfo idiom)", () => {
  it("showContext re-renders only for the selected id", () => {
    let route: FlightRoute | null | undefined;
    const { panel, root } = setup({ getRoute: () => route });
    panel.show(AIR);
    route = ROUTE;
    panel.showContext("other-id", ROUTE);
    expect(byClass(root, "panel-chip-arr")).toBeUndefined();
    panel.showContext(AIR.id, ROUTE);
    expect(must(byClass(root, "panel-chip-arr"), "arr chip").textContent).toBe("JFK · New York");
  });

  it("showTrack surfaces the budget only for the selected id", () => {
    let budget: { autoLeft: number; hard: boolean } | undefined;
    const { panel, root } = setup({ getRoute: () => null, getBudget: () => budget });
    panel.show(AIR);
    budget = { autoLeft: 0, hard: false };
    panel.showTrack("other-id", budget);
    expect(byClass(root, "panel-note")).toBeUndefined();
    panel.showTrack(AIR.id, budget);
    expect(byClass(root, "panel-note")).toBeDefined();
  });

  it("update on a different craft leaves the flight rows alone", () => {
    const { panel, root } = setup({ getRoute: () => ROUTE });
    panel.show(AIR);
    panel.update({ ...SEA, id: "999" });
    expect(byClass(root, "panel-chip-arr")).toBeDefined();
  });

  it("keeps the info request-once idiom alongside", () => {
    const requestInfo = vi.fn();
    const { panel, root } = setup({ getInfo: () => undefined, requestInfo });
    panel.show(AIR);
    panel.update(AIR);
    expect(requestInfo).toHaveBeenCalledTimes(1);
    expect(requestInfo).toHaveBeenCalledWith(AIR.id);
    expect(allText(root)).toContain("Type …");
  });
});

describe("panel ETA row", () => {
  const NOW = Date.parse("2026-11-21T12:00:00.000Z");

  // Fakes Date.now and pins the local zone so expected values can be derived
  // with the UTC getters — independent of the implementation's local getters.
  function withClock(fn: () => void): void {
    const tz = process.env.TZ;
    process.env.TZ = "UTC";
    vi.useFakeTimers({ now: NOW, toFake: ["Date"] });
    try {
      fn();
    } finally {
      vi.useRealTimers();
      if (tz === undefined) delete process.env.TZ;
      else process.env.TZ = tz;
    }
  }

  function etaLocal(baseMs: number, from: number): string {
    const d = new Date(from + baseMs);
    const p2 = (n: number): string => String(n).padStart(2, "0");
    return `~${p2(d.getHours())}:${p2(d.getMinutes())}`;
  }

  const flightMs = (craft: Craft): number =>
    (haversineMeters(
      { lon: craft.lon, lat: craft.lat },
      { lon: ARR.lon ?? 0, lat: ARR.lat ?? 0 },
    ) /
      ((craft.speed ?? 0) * MS_PER_KNOT)) *
    1000;

  it("renders ~HH:MM local for an airborne craft with speed and a destination", () => {
    withClock(() => {
      const { panel, root } = setup({ getRoute: () => ROUTE });
      panel.show(AIR);
      expect(rowValue(root, "ETA")).toBe(etaLocal(flightMs(AIR), NOW));
    });
  });

  it("blanks the ETA when airborne, speed or destination coords are missing", () => {
    withClock(() => {
      const cases: Array<{ craft: Craft; route: FlightRoute }> = [
        { craft: { ...AIR, onGround: true }, route: ROUTE },
        { craft: { ...AIR, speed: null }, route: ROUTE },
        { craft: AIR, route: { ...ROUTE, arr: { ...ARR, lat: null, lon: null } } },
      ];
      for (const { craft, route } of cases) {
        const { panel, root } = setup({ getRoute: () => route });
        panel.show(craft);
        expect(rowValue(root, "ETA")).toBe("—");
      }
    });
  });

  it("renders no ETA row while the route is pending or absent", () => {
    for (const route of [undefined, null]) {
      const { panel, root } = setup({ getRoute: () => route });
      panel.show(AIR);
      expect(rowValue(root, "ETA")).toBeUndefined();
    }
  });

  it("recomputes the ETA on every update instead of going stale", () => {
    withClock(() => {
      const { panel, root } = setup({ getRoute: () => ROUTE });
      panel.show(AIR);
      const before = rowValue(root, "ETA");
      vi.setSystemTime(NOW + 3_600_000);
      panel.update(AIR);
      const after = rowValue(root, "ETA");
      expect(after).toBe(etaLocal(flightMs(AIR), NOW + 3_600_000));
      expect(after).not.toBe(before);
    });
  });
});
