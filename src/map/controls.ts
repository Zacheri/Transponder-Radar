import { loadProjection, saveProjection, type ProjectionKind } from "../data/projection-cfg.js";
import type { StorageLike } from "../data/icon-colors.js";

// Custom top-right control row (Wave 11): ONE horizontal group — zoom out,
// zoom in, compass (click resets bearing AND pitch; the arrow reflects the
// current bearing), and a globe/flat toggle. Stock NavigationControl is a
// vertical stack with no projection toggle, so this replaces it.
//
// 4.7.1 exposes no zoomBy/resetPitch, so zoom uses the public zoomIn/
// zoomOut and the compass resets via one easeTo({bearing: 0, pitch: 0}).
// There is also no public map.setProjection(); the toggle applies
// map.setStyle({ ...map.getStyle(), projection }) — setStyle diffs by
// default (options.diff !== false) and the style-diff emits a setProjection
// command, so camera, sources, layers and registered images survive.

const GLOBE_ICON = "\u{1F310}"; // 🌐
const FLAT_ICON = "\u25A6"; // ▦

export type ControlStyle = { projection?: { type?: string }; [key: string]: unknown };

/** The map surface this module touches (the real Map satisfies it). */
export type ControlMap = {
  zoomIn(): unknown;
  zoomOut(): unknown;
  easeTo(options: { bearing: number; pitch: number }): unknown;
  getBearing(): number;
  getStyle(): ControlStyle;
  setStyle(style: ControlStyle | string | null): unknown;
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

    const sync = (): void => {
      if (!projBtn) return;
      projBtn.textContent = projection === "globe" ? GLOBE_ICON : FLAT_ICON;
      projBtn.setAttribute("aria-pressed", projection === "globe" ? "true" : "false");
    };
    const toggleProjection = (): void => {
      projection = projection === "globe" ? "mercator" : "globe";
      map.setStyle({ ...map.getStyle(), projection: { type: projection } });
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
 * Apply the remembered projection exactly once — synchronously when the
 * style is already loaded, else on first load. Storage is read at fire time
 * and compared to the live style, so the diff never clobbers a toggle made
 * before load and never runs twice.
 */
export function applyStoredProjection(map: ControlMap, storage: StorageLike): void {
  let applied = false;
  const apply = (): void => {
    if (applied) return;
    applied = true;
    const want = loadProjection(storage);
    const style = map.getStyle();
    if ((style.projection?.type ?? "mercator") === want) return;
    map.setStyle({ ...style, projection: { type: want } });
  };
  if (map.loaded()) {
    apply();
    return;
  }
  map.once("load", apply);
}
