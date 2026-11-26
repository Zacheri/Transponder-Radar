import { loadProjection, saveProjection, type ProjectionKind } from "../data/projection-cfg.js";
import type { StorageLike } from "../data/icon-colors.js";

// Custom top-right control row (Wave 11): ONE horizontal group — zoom out,
// zoom in, compass (click resets bearing AND pitch; the arrow reflects the
// current bearing), and a globe/flat toggle. Stock NavigationControl is a
// vertical stack with no projection toggle, so this replaces it.
//
// 4.7.1 exposes no zoomBy/resetPitch, so zoom uses the public zoomIn/
// zoomOut and the compass resets via one easeTo({bearing: 0, pitch: 0}).
// There is also no public map.setProjection(), and switching it through a
// style-diff is a trap: the diff EMITS a setProjection command but
// Style#setState has no applier for it, so applying it throws (caught
// TypeError), surfacing as an "Unable to perform style diff" warning and a
// full style rebuild.
// The toggle therefore requests that rebuild directly with diff:false
// (verified against the installed maplibre-gl 4.7.1: setStyle routes
// straight to _updateStyle, no diff attempted, deterministic and silent)
// — see toggleProjection.

const GLOBE_ICON = "\u{1F310}"; // 🌐
const FLAT_ICON = "\u25A6"; // ▦

export type ControlStyle = { projection?: { type?: string }; [key: string]: unknown };

/** The map surface this module touches (the real Map satisfies it). */
export type ControlMap = {
  zoomIn(): unknown;
  zoomOut(): unknown;
  easeTo(options: { bearing: number; pitch: number }): unknown;
  getBearing(): number;
  // Style#serialize returns undefined before the style is loaded and never
  // includes `projection` — hence the closure-tracked state below.
  getStyle(): ControlStyle | undefined;
  setStyle(style: ControlStyle | string | null, options?: { diff?: boolean }): unknown;
  loaded(): boolean;
  once(type: "load", fn: () => void): unknown;
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
    // aria-pressed reflect the current projection.
    const sync = (): void => {
      if (!projBtn) return;
      const label = projection === "globe" ? "Flat view" : "Globe view";
      projBtn.textContent = projection === "globe" ? GLOBE_ICON : FLAT_ICON;
      projBtn.setAttribute("aria-pressed", projection === "globe" ? "true" : "false");
      projBtn.setAttribute("aria-label", label);
      projBtn.title = label;
    };
    const toggleProjection = (): void => {
      // Pre-load getStyle() serializes nothing, so a toggle there would
      // apply setStyle to an undefined style and brick the map.
      if (!map.loaded()) return;
      const style = map.getStyle();
      if (!style) return;
      const next: ProjectionKind = projection === "globe" ? "mercator" : "globe";
      // Full rebuild with the projection set on a copy of the serialized
      // style (sources/layers come along); diff:false takes the direct
      // route — the same rebuild the failed diff falls back to, minus the
      // warning (see header). main.ts re-adds every custom layer/source on
      // the resulting style.load, and both icon registrars re-add images.
      map.setStyle({ ...style, projection: { type: next } }, { diff: false });
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
 * touched before the map fetches it, so apply it once after the first full
 * load. Style#serialize never round-trips projection, so the live style
 * cannot be read back and compared — a projection-less style renders
 * mercator, and only a globe wish needs the one-time full rebuild.
 */
export function applyStoredProjection(map: ControlMap, storage: StorageLike): void {
  const apply = (): void => {
    const want = loadProjection(storage);
    const style = map.getStyle();
    if (want === "mercator" || !style) return;
    map.setStyle({ ...style, projection: { type: "globe" } }, { diff: false });
  };
  if (map.loaded()) {
    apply();
    return;
  }
  map.once("load", apply);
}
