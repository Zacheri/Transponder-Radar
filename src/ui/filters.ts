import type { CraftKind } from "../../shared/craft.js";
import { KINDS, AIR_KINDS, SEA_KINDS } from "../../shared/craft.js";
import { clampZonesBoost, ZONES_BOOST_MAX_MS, ZONES_BOOST_MIN_MS, type ZonesCfg } from "./zones-cfg.js";

const VISIBLE_KEY = "radar.visibleKinds";
const COLLAPSED_KEY = "radar.drawerCollapsed";

function readSavedVisible(): Set<CraftKind> | null {
  try {
    const raw = localStorage.getItem(VISIBLE_KEY);
    if (!raw) return null;
    const arr: unknown = JSON.parse(raw);
    if (!Array.isArray(arr)) return null;
    for (const v of arr) {
      if (typeof v !== "string" || !Object.hasOwn(KINDS, v)) return null;
    }
    return new Set(arr as CraftKind[]);
  } catch {
    return null;
  }
}

export interface FilterColorApi {
  getColor(kind: CraftKind): string; // effective color (override ?? kind default)
  setColor(kind: CraftKind, hex: string | null): void; // null = back to default
}

export interface ZonesControlOpts {
  initial: ZonesCfg;
  onZonesChange: (cfg: ZonesCfg) => void;
}

export function createFilters(
  root: HTMLElement,
  initial: Set<CraftKind>,
  onChange: (v: Set<CraftKind>) => void,
  color?: FilterColorApi,
  zones?: ZonesControlOpts,
): { setCounts(counts: Map<CraftKind, number>): void } {
  const el = document.createElement("aside");
  el.className = "drawer";
  const head = document.createElement("div");
  head.className = "drawer-head";
  head.setAttribute("role", "button");
  head.setAttribute("tabindex", "0");
  const title = document.createElement("span");
  title.textContent = "Filters";
  const chevron = document.createElement("span");
  chevron.className = "drawer-chevron";
  chevron.textContent = "▾";
  head.append(title, chevron);
  const body = document.createElement("div");
  body.className = "drawer-body";
  el.append(head, body);
  root.appendChild(el);

  const saved = readSavedVisible();
  let visible = new Set<CraftKind>(saved ?? initial);

  const countsEl = new Map<CraftKind, HTMLElement>();

  function group(title: string, kinds: CraftKind[]): void {
    const h = document.createElement("div");
    h.className = "drawer-group";
    h.textContent = title;
    body.appendChild(h);
    for (const k of kinds) {
      const label = document.createElement("label");
      label.className = "drawer-item";
      const cb = document.createElement("input");
      cb.type = "checkbox";
      cb.checked = visible.has(k);
      cb.dataset.kind = k;
      cb.addEventListener("change", () => {
        const next = new Set(visible);
        if (cb.checked) next.add(k);
        else next.delete(k);
        apply(next);
      });
      const sw = document.createElement("span");
      sw.className = "swatch";
      const txt = document.createElement("span");
      txt.className = "drawer-label";
      txt.textContent = KINDS[k].label;
      const n = document.createElement("span");
      n.className = "drawer-count";
      n.textContent = "(0)";
      countsEl.set(k, n);
      label.append(cb, sw, txt, n);
      if (color) {
        const pick = document.createElement("input");
        pick.type = "color";
        pick.className = "drawer-color";
        pick.title = "Map icon color";
        pick.value = color.getColor(k);
        const reset = document.createElement("button");
        reset.type = "button";
        reset.className = "drawer-color-reset";
        reset.textContent = "×";
        reset.title = "Reset to default";
        const syncSwatch = (): void => {
          sw.style.background = color.getColor(k);
          pick.value = color.getColor(k);
          reset.style.display = color.getColor(k) === KINDS[k].color ? "none" : "";
        };
        pick.addEventListener("input", () => {
          color.setColor(k, pick.value);
          syncSwatch();
        });
        reset.addEventListener("click", () => {
          color.setColor(k, null);
          syncSwatch();
        });
        syncSwatch();
        label.append(pick, reset);
      }
      body.appendChild(label);
    }
  }

  function apply(v: Set<CraftKind>): void {
    visible = new Set(v);
    // [data-kind] scopes to the filter rows: the boost checkboxes (data-zkind)
    // must survive All/None/Air-only/Sea-only untouched.
    body.querySelectorAll<HTMLInputElement>("input[type=checkbox][data-kind]").forEach((cb) => {
      cb.checked = visible.has(cb.dataset.kind as CraftKind);
    });
    try {
      localStorage.setItem(VISIBLE_KEY, JSON.stringify([...visible]));
    } catch {
      // storage unavailable
    }
    onChange(visible);
  }

  const actions = document.createElement("div");
  actions.className = "drawer-actions";
  const actionDefs: Array<[string, CraftKind[]]> = [
    ["All", [...AIR_KINDS, ...SEA_KINDS]],
    ["None", []],
    ["Air-only", AIR_KINDS],
    ["Sea-only", SEA_KINDS],
  ];
  for (const [name, kinds] of actionDefs) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "drawer-action";
    b.textContent = name;
    b.addEventListener("click", () => apply(new Set(kinds)));
    actions.appendChild(b);
  }
  body.prepend(actions);

  group("Air", AIR_KINDS);
  group("Sea", SEA_KINDS);

  if (zones) {
    const zc = zones;
    const h = document.createElement("div");
    h.className = "drawer-group";
    h.textContent = "Boost zones";
    body.appendChild(h);
    const zChecked = new Set<CraftKind>(zc.initial.kinds);
    let zBoostMs = clampZonesBoost(zc.initial.boostMs);
    const zval = document.createElement("span");
    zval.className = "drawer-count";
    function emitZones(): void {
      // Spread initial so the auto block rides through untouched (the drawer
      // does not own it; T4 moves rate/auto editing to settings).
      zc.onZonesChange({ ...zc.initial, kinds: AIR_KINDS.filter((k) => zChecked.has(k)), boostMs: zBoostMs });
    }
    function renderZval(): void {
      zval.textContent = `${zBoostMs / 1000} s`;
    }
    for (const k of AIR_KINDS) {
      const label = document.createElement("label");
      label.className = "drawer-item";
      const cb = document.createElement("input");
      cb.type = "checkbox";
      cb.checked = zChecked.has(k);
      cb.dataset.zkind = k;
      // Tint via the color api (kind overrides included), no new hex literals.
      if (color) cb.style.accentColor = color.getColor(k);
      cb.addEventListener("change", () => {
        if (cb.checked) zChecked.add(k);
        else zChecked.delete(k);
        emitZones();
      });
      const sw = document.createElement("span");
      sw.className = "swatch";
      if (color) sw.style.background = color.getColor(k);
      const txt = document.createElement("span");
      txt.className = "drawer-label";
      txt.textContent = KINDS[k].label;
      label.append(cb, sw, txt);
      body.appendChild(label);
    }
    const row = document.createElement("label");
    row.className = "drawer-item";
    const rl = document.createElement("span");
    rl.textContent = "Interval";
    const slider = document.createElement("input");
    slider.type = "range";
    slider.min = String(ZONES_BOOST_MIN_MS);
    slider.max = String(ZONES_BOOST_MAX_MS);
    slider.step = "5000";
    slider.value = String(zBoostMs);
    slider.setAttribute("aria-label", "Boost interval");
    slider.addEventListener("input", () => {
      // Self-clamping (a programmatic out-of-range value must not leak out).
      zBoostMs = clampZonesBoost(Number(slider.value));
      slider.value = String(zBoostMs);
      renderZval();
      emitZones();
    });
    renderZval();
    row.append(rl, slider, zval);
    body.appendChild(row);
  }

  let collapsed = false;
  try {
    collapsed = localStorage.getItem(COLLAPSED_KEY) === "1";
  } catch {
    collapsed = false;
  }
  el.classList.toggle("collapsed", collapsed);
  head.setAttribute("aria-expanded", String(!collapsed));
  function toggle(): void {
    collapsed = !collapsed;
    el.classList.toggle("collapsed", collapsed);
    head.setAttribute("aria-expanded", String(!collapsed));
    try {
      localStorage.setItem(COLLAPSED_KEY, collapsed ? "1" : "0");
    } catch {
      // storage unavailable
    }
  }
  head.addEventListener("click", toggle);
  head.addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === " ") {
      if (e.key === " ") e.preventDefault();
      toggle();
    }
  });

  function setCounts(counts: Map<CraftKind, number>): void {
    for (const k of Object.keys(KINDS) as CraftKind[]) {
      const c = countsEl.get(k);
      if (c) c.textContent = `(${(counts.get(k) ?? 0).toLocaleString("en-US")})`;
    }
  }

  if (saved) onChange(visible);

  return { setCounts };
}
