import type { CraftKind } from "../../shared/craft.js";
import { KINDS, AIR_KINDS, SEA_KINDS } from "../../shared/craft.js";

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

export function createFilters(
  root: HTMLElement,
  initial: Set<CraftKind>,
  onChange: (v: Set<CraftKind>) => void,
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
      sw.style.background = KINDS[k].color;
      const txt = document.createElement("span");
      txt.className = "drawer-label";
      txt.textContent = KINDS[k].label;
      const n = document.createElement("span");
      n.className = "drawer-count";
      n.textContent = "(0)";
      countsEl.set(k, n);
      label.append(cb, sw, txt, n);
      body.appendChild(label);
    }
  }

  function apply(v: Set<CraftKind>): void {
    visible = new Set(v);
    body.querySelectorAll<HTMLInputElement>("input[type=checkbox]").forEach((cb) => {
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
