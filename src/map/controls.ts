import { loadProjection, saveProjection, type ProjectionKind } from "../data/projection-cfg.js";
import type { StorageLike } from "../data/icon-colors.js";

// Custom top-right control row (Wave 11): ONE horizontal group — zoom out,
// zoom in, compass (click resets bearing AND pitch; the arrow reflects the
// current bearing), and a globe/flat toggle. Stock NavigationControl is a
// vertical stack with no projection toggle, so this replaces it.
//
// 4.7.1 exposes no zoomBy/resetPitch, so zoom uses the public zoomIn/
// zoomOut and the compass resets via one easeTo({bearing: 0, pitch: 0}).
//
// Projection switching is the in-place public API (maplibre-gl 5.x):
// map.setProjection({type}) swaps the live projection, migrates the
// camera, and reloads tiles — sources, layers and registered images
// survive untouched and no style.load re-fires. (4.7.1 had no public
// setProjection and no style-diff applier for it, so the toggle there
// needed a full setStyle rebuild. The style.load-idempotence guards in
// main.ts, the region repaint insurance and the socket-outside-style-
// events wiring stay as cheap insurance against any future style swap.)
// — see toggleProjection.

const GLOBE_ICON = "\u{1F310}"; // 🌐
const FLAT_ICON = "\u25A6"; // ▦

/** The map surface this module touches (the real Map satisfies it). */
export type ControlMap = {
  zoomIn(): unknown;
  zoomOut(): unknown;
  easeTo(options: { bearing: number; pitch: number }): unknown;
  getBearing(): number;
  // Declared unknown so the real setProjection(projection:
  // ProjectionSpecification) (whose `type` may be an expression in
  // style-spec 24) stays structurally assignable.
  setProjection(projection: unknown): unknown;
  // isStyleLoaded(), NOT loaded(): Style#setProjection _checkLoaded()s
  // and THROWS before the style has finished applying (verified against
  // the 5.24.1 source), and a toggle click must never throw. loaded()
  // additionally requires every visible tile, which on slow connections
  // is almost never true and silently no-oped every toggle click (user
  // report 2026-11-26); isStyleLoaded covers exactly what setProjection
  // needs — a fully applied style. The gate predates v5; v5 is the
  // reason it MUST stay.
  isStyleLoaded(): boolean | void;
  once(type: "style.load", fn: () => void): unknown;
  on(type: string, fn: () => void): unknown;
  off(type: string, fn: () => void): unknown;
};

function makeButton(className: string, icon: string, label: string, onClick: () => void): HTMLButtonElement {
  const btn = document.createElement("button");
  btn.className = className;
  btn.textContent = icon;
  btn.setAttribute("type", "button");
  btn.setAttribute("aria-label", label);
  btn.title = label;
  btn.addEventListener("click", onClick);
  return btn;
}

export type MapControlRow = {
  onAdd(map: ControlMap): HTMLElement;
  onRemove(map: ControlMap): void;
  getDefaultPosition(): "top-right";
};

export function createMapControls(storage: StorageLike = globalThis.localStorage): MapControlRow {
  let projection: ProjectionKind = loadProjection(storage);
  let container: HTMLElement | null = null;
  let moveHandler: (() => void) | null = null;

  function onAdd(map: ControlMap): HTMLElement {
    let projBtn: HTMLButtonElement | null = null;

    // aria-label/title name what a click switches TO; the icon and
    // aria-pressed reflect the current projection. The closure-tracked
    // `projection` is the button truth: it holds the wanted projection
    // even before the style applies (map.getProjection() serializes
    // nothing until then), and every mutation site updates it.
    const sync = (): void => {
      if (!projBtn) return;
      const label = projection === "globe" ? "Flat view" : "Globe view";
      projBtn.textContent = projection === "globe" ? GLOBE_ICON : FLAT_ICON;
      projBtn.setAttribute("aria-pressed", projection === "globe" ? "true" : "false");
      projBtn.setAttribute("aria-label", label);
      projBtn.title = label;
    };
    const toggleProjection = (): void => {
      if (!map.isStyleLoaded()) return;
      const next: ProjectionKind = projection === "globe" ? "mercator" : "globe";
      // One in-place call; camera migration and tile reload are internal.
      map.setProjection({ type: next });
      projection = next;
      saveProjection(projection, storage);
      sync();
    };

    const row = document.createElement("div");
    row.className = "maplibregl-ctrl map-control-row";
    const zoomOut = makeButton("map-control-zoom-out", "\u2212", "Zoom out", () => map.zoomOut());
    const zoomIn = makeButton("map-control-zoom-in", "+", "Zoom in", () => map.zoomIn());
    const compass = makeButton("map-control-compass", "", "Reset bearing and pitch", () => {
      map.easeTo({ bearing: 0, pitch: 0 });
    });
    const arrow = document.createElement("span");
    arrow.className = "map-control-compass-arrow";
    arrow.textContent = "\u25B2"; // ▲
    compass.appendChild(arrow);
    projBtn = makeButton("map-control-projection", "", "Globe view", toggleProjection);
    row.append(zoomOut, zoomIn, compass, projBtn);

    moveHandler = () => {
      arrow.style.transform = `rotate(${-map.getBearing()}deg)`;
    };
    map.on("move", moveHandler);
    moveHandler();
    sync();

    container = row;
    return row;
  }

  function onRemove(map: ControlMap): void {
    if (moveHandler) map.off("move", moveHandler);
    moveHandler = null;
    container?.remove();
    container = null;
  }

  return { onAdd, onRemove, getDefaultPosition: () => "top-right" };
}

/**
 * Style-URL basemap fallback only: an inline style object carries the
 * remembered projection at creation (map.ts), but a style URL cannot be
 * touched before the map fetches it, so apply it once after the first
 * load with a single in-place setProjection (no rebuild — v5). Applied
 * unconditionally: setProjection on a style that already has that
 * projection is a documented no-op (5.24.1 Style#setProjection returns
 * early when the name matches), so a globe-declaring remote style is
 * overridden when the user wants flat, and vice versa, for free.
 */
export function applyStoredProjection(map: ControlMap, storage: StorageLike): void {
  const apply = (): void => {
    map.setProjection({ type: loadProjection(storage) });
  };
  if (map.isStyleLoaded()) {
    apply();
    return;
  }
  map.once("style.load", apply);
}
