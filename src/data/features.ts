import type { Craft } from "../../shared/craft.js";

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

function toFeature(c: Craft): CraftFeature {
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
      stale: c.stale,
      label,
      sublabel: parts.join(" "),
      speed: c.speed,
      altitude: c.altitude ?? null,
      heading: c.heading,
    },
  };
}

export function buildFeatureCollection(crafts: Craft[]): FeatureCollection {
  return { type: "FeatureCollection", features: crafts.map(toFeature) };
}
