import { KIND_FALLBACK_ICON, colorKey, isPackIconName, type AirKind, type Craft, type CraftKind } from "../../shared/craft.js";
import { effectivePosition } from "../map/motion.js";

export interface FeatureBuildOpts {
  iconRegistered?: ReadonlySet<string>;
  colorFor?: (kind: CraftKind) => string;
  /** Live frames only: coordinates dead-reckoned to one shared nowMs (R2: position only). */
  motion?: { nowMs: number };
}

export interface PointGeometry {
  type: "Point";
  coordinates: [number, number];
}

export interface CraftFeature {
  type: "Feature";
  id: string;
  geometry: PointGeometry;
  properties: {
    id: string;
    domain: "air" | "sea";
    kind: string;
    icon: string;
    stale: boolean;
    label: string;
    sublabel: string;
    speed: number | null;
    altitude: number | null;
    heading: number | null;
  };
}

export interface FeatureCollection {
  type: "FeatureCollection";
  features: CraftFeature[];
}

/**
 * MapLibre image name for a craft. Pack icon names (pw:/rk:/pd:) only
 * render when the loader has actually registered them — otherwise the map
 * would draw nothing (Review Focus #4), so they fall back to the kind's
 * family silhouette until the image lands. `iconRegistered` undefined
 * (opt omitted) keeps the old pass-through for back-compat. Sea craft never
 * carry pack icons; their kind name passes through unchanged.
 *
 * Colors are baked into the rasterized registration, so the emitted name is
 * color-keyed (`base@hex`) via `colorFor` when given — the loader registers
 * one image per (base, color) pair. The registered check is on the keyed
 * name, so a not-yet-downloaded pack icon at the CURRENT color falls back
 * to the (always registered) keyed family silhouette.
 */
function iconFor(c: Craft, registered: ReadonlySet<string> | undefined, colorFor: ((kind: CraftKind) => string) | undefined): string {
  const base = c.icon ?? (c.domain === "air" ? KIND_FALLBACK_ICON[c.kind as AirKind] : c.kind);
  const color = colorFor ? colorFor(c.kind) : undefined;
  const key = (n: string): string => (color !== undefined ? colorKey(n, color) : n);
  if (c.icon !== undefined && isPackIconName(c.icon) && registered !== undefined && !registered.has(key(c.icon))) {
    if (c.domain === "air") return key(KIND_FALLBACK_ICON[c.kind as AirKind]);
  }
  return key(base);
}

function toFeature(c: Craft, registered: ReadonlySet<string> | undefined, colorFor: ((kind: CraftKind) => string) | undefined, motion: { nowMs: number } | undefined): CraftFeature {
  const label = c.domain === "air" ? c.callsign ?? c.id : c.shipName ?? c.id;
  const parts: string[] = [];
  if (c.speed != null) parts.push(`${Math.round(c.speed)}kn`);
  if (c.domain === "air" && c.altitude != null) parts.push(`${Math.round(c.altitude)}ft`);
  if (c.heading != null) parts.push(`${Math.round(c.heading)}°`);
  const pos = motion !== undefined ? effectivePosition(c, motion.nowMs) : undefined;
  return {
    type: "Feature",
    id: c.id,
    geometry: { type: "Point", coordinates: pos ? [pos.lon, pos.lat] : [c.lon, c.lat] },
    properties: {
      id: c.id,
      domain: c.domain,
      kind: c.kind,
      icon: iconFor(c, registered, colorFor),
      stale: c.stale,
      label,
      sublabel: parts.join(" "),
      speed: c.speed,
      altitude: c.altitude ?? null,
      heading: c.heading,
    },
  };
}

export function buildFeatureCollection(crafts: Craft[], opts?: FeatureBuildOpts): FeatureCollection {
  return { type: "FeatureCollection", features: crafts.map((c) => toFeature(c, opts?.iconRegistered, opts?.colorFor, opts?.motion)) };
}
