import { KIND_FALLBACK_ICON, isPackIconName, type AirKind, type Craft } from "../../shared/craft.js";

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
 */
function iconFor(c: Craft, registered: ReadonlySet<string> | undefined): string {
  const base = c.icon ?? (c.domain === "air" ? KIND_FALLBACK_ICON[c.kind as AirKind] : c.kind);
  if (c.icon !== undefined && isPackIconName(c.icon) && registered !== undefined && !registered.has(c.icon)) {
    if (c.domain === "air") return KIND_FALLBACK_ICON[c.kind as AirKind];
  }
  return base;
}

function toFeature(c: Craft, registered: ReadonlySet<string> | undefined): CraftFeature {
  const label = c.domain === "air" ? c.callsign ?? c.id : c.shipName ?? c.id;
  const parts: string[] = [];
  if (c.speed != null) parts.push(`${Math.round(c.speed)}kn`);
  if (c.domain === "air" && c.altitude != null) parts.push(`${Math.round(c.altitude)}ft`);
  if (c.heading != null) parts.push(`${Math.round(c.heading)}°`);
  return {
    type: "Feature",
    id: c.id,
    geometry: { type: "Point", coordinates: [c.lon, c.lat] },
    properties: {
      id: c.id,
      domain: c.domain,
      kind: c.kind,
      icon: iconFor(c, registered),
      stale: c.stale,
      label,
      sublabel: parts.join(" "),
      speed: c.speed,
      altitude: c.altitude ?? null,
      heading: c.heading,
    },
  };
}

export function buildFeatureCollection(crafts: Craft[], opts?: { iconRegistered?: ReadonlySet<string> }): FeatureCollection {
  return { type: "FeatureCollection", features: crafts.map((c) => toFeature(c, opts?.iconRegistered)) };
}
