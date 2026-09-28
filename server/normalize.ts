import type { Craft } from "../shared/craft.js";
import { classifyAir } from "./classify.js";

export const MS_TO_KNOTS = 1.94384;
export const M_TO_FT = 3.28084;
export const MS_TO_FPM = 196.850;

type Field = string | number | boolean | null;

export function normalizeOpenSky(state: Field[], now: number): Craft | null {
  const [
    icao24,
    callsign,
    origin_country,
    time_position,
    , // 4 last_contact
    longitude,
    latitude,
    baro_altitude,
    on_ground,
    velocity,
    true_track,
    vertical_rate,
    , // 12 sensors
    geo_altitude,
    squawk,
    spi,
  ] = state;

  if (!icao24 || longitude == null || latitude == null) return null;

  const altM = geo_altitude ?? baro_altitude;
  const cs = typeof callsign === "string" ? callsign.trim() : "";

  return {
    id: String(icao24),
    domain: "air",
    kind: classifyAir({ callsign: cs || undefined, spi: Boolean(spi) }),
    lat: Number(latitude),
    lon: Number(longitude),
    speed: velocity != null ? Number(velocity) * MS_TO_KNOTS : null,
    heading: true_track != null ? Number(true_track) : null,
    callsign: cs || undefined,
    altitude: altM != null ? Number(altM) * M_TO_FT : null,
    verticalRate: vertical_rate != null ? Number(vertical_rate) * MS_TO_FPM : null,
    squawk: squawk != null ? String(squawk) : null,
    onGround: Boolean(on_ground),
    spi: Boolean(spi),
    originCountry: origin_country ? String(origin_country) : undefined,
    updatedAt: time_position != null ? Number(time_position) * 1000 : now,
    stale: false,
  };
}
