import type { Craft } from "../shared/craft.js";
import { classifyAir, classifySea } from "./classify.js";

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

export interface AisStatic {
  mmsi: string;
  shipName?: string;
  imo?: number | null;
  callSign?: string;
  destination?: string;
  aisType?: number | null;
}

function num(v: unknown): number | null {
  if (v == null || v === "") return null;
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}

function str(v: unknown): string | undefined {
  if (v == null) return undefined;
  const s = String(v).trim();
  return s ? s : undefined;
}

function pickMmsi(env: any): string | null {
  const m =
    env?.MMSI ?? env?.mmsi ?? env?.metaData?.mmsi ??
    env?.Message?.PositionReport?.UserID ?? env?.Message?.ShipStaticData?.UserID;
  return m != null ? String(m) : null;
}

export function normalizeShipStaticData(env: any): AisStatic | null {
  const mmsi = pickMmsi(env);
  if (mmsi == null) return null;
  const sd = env?.Message?.ShipStaticData ?? env?.ShipStaticData ?? env?.Message ?? {};
  return {
    mmsi,
    shipName: str(sd.Name) ?? str(sd.ShipName),
    imo: num(sd.ImoNumber) ?? num(sd.Imo) ?? null,
    callSign: str(sd.CallSign),
    destination: str(sd.Destination),
    aisType: num(sd.Type) ?? null,
  };
}

export function normalizePositionReport(env: any, staticData: AisStatic | undefined, now: number): Craft | null {
  const mmsi = pickMmsi(env);
  const pr = env?.Message?.PositionReport ?? env?.PositionReport ?? env?.Message ?? {};
  const lat = num(pr.Latitude);
  const lon = num(pr.Longitude);
  if (mmsi == null || lat == null || lon == null) return null;

  const sog = num(pr.Sog) ?? num(pr.SpeedOverGround);
  const cog = num(pr.Cog) ?? num(pr.CourseOverGround);
  const th = num(pr.TrueHeading);

  return {
    id: mmsi,
    domain: "sea",
    kind: classifySea(staticData?.aisType),
    lat,
    lon,
    speed: sog,
    heading: cog ?? th,
    shipName: staticData?.shipName,
    imo: staticData?.imo ?? null,
    callSign: staticData?.callSign,
    destination: staticData?.destination,
    navStatus: num(pr.NavigationalStatus),
    aisType: staticData?.aisType ?? null,
    updatedAt: now,
    stale: false,
  };
}
