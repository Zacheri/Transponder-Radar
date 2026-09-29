import type { CraftKind } from "../../shared/craft.js";
import { KINDS, AIR_KINDS, SEA_KINDS } from "../../shared/craft.js";

export function createFilters(
  root: HTMLElement,
  initial: Set<CraftKind>,
  onChange: (v: Set<CraftKind>) => void,
): { setVisible(v: Set<CraftKind>): void } {
  const el = document.createElement("aside");
  el.className = "drawer";
  const head = document.createElement("div");
  head.className = "drawer-head";
  head.textContent = "Filters";
  const body = document.createElement("div");
  body.className = "drawer-body";
  el.append(head, body);
  root.appendChild(el);

  let visible = new Set<CraftKind>(initial);

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
        visible = next;
        onChange(next);
      });
      const sw = document.createElement("span");
      sw.className = "swatch";
      sw.style.background = KINDS[k].color;
      const txt = document.createElement("span");
      txt.className = "drawer-label";
      txt.textContent = KINDS[k].label;
      label.append(cb, sw, txt);
      body.appendChild(label);
    }
  }

  group("Air", AIR_KINDS);
  group("Sea", SEA_KINDS);

  function setVisible(v: Set<CraftKind>): void {
    visible = new Set(v);
    body.querySelectorAll<HTMLInputElement>("input[type=checkbox]").forEach((cb) => {
      cb.checked = visible.has(cb.dataset.kind as CraftKind);
    });
  }

  return { setVisible };
}
