// Shared, pure great-circle geometry: consumed by the server (ETA) and the
// browser (predicted paths). Degrees in/out, distances in meters; spherical
// earth. No I/O, no dependencies.

export type LonLat = { lon: number; lat: number };

const EARTH_RADIUS_M = 6_371_000;
export const MS_PER_KNOT = 1852 / 3600;

const toRad = (deg: number): number => (deg * Math.PI) / 180;
const toDeg = (rad: number): number => (rad * 180) / Math.PI;
const wrapLon = (lon: number): number => ((lon + 540) % 360) - 180;

function unit(p: LonLat): [number, number, number] {
  const lat = toRad(p.lat);
  const lon = toRad(p.lon);
  return [Math.cos(lat) * Math.cos(lon), Math.cos(lat) * Math.sin(lon), Math.sin(lat)];
}

export function haversineMeters(a: LonLat, b: LonLat): number {
  const dLat = toRad(b.lat - a.lat);
  const dLon = toRad(b.lon - a.lon);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(h)));
}

// Slerp on unit vectors. Longitudes are unwrapped to the shortest delta from
// the previous point, so a dateline crossing keeps |Δlon| small and |lon| may
// grow past 180. Endpoints are returned verbatim (no float drift).
export function greatCircle(a: LonLat, b: LonLat, points = 64): LonLat[] {
  if (a.lon === b.lon && a.lat === b.lat) return [a];
  const n = Math.max(2, Math.floor(points));
  const [x1, y1, z1] = unit(a);
  const [x2, y2, z2] = unit(b);
  const omega = Math.acos(Math.min(1, Math.max(-1, x1 * x2 + y1 * y2 + z1 * z2)));
  const sinOmega = Math.sin(omega);
  if (sinOmega < 1e-12) return [a, b];

  const out: LonLat[] = [];
  let prevLon = a.lon;
  for (let i = 0; i < n; i++) {
    let lon: number;
    let lat: number;
    if (i === 0) {
      lon = a.lon;
      lat = a.lat;
    } else if (i === n - 1) {
      lon = b.lon;
      lat = b.lat;
    } else {
      const t = i / (n - 1);
      const w1 = Math.sin((1 - t) * omega) / sinOmega;
      const w2 = Math.sin(t * omega) / sinOmega;
      const x = w1 * x1 + w2 * x2;
      const y = w1 * y1 + w2 * y2;
      const z = w1 * z1 + w2 * z2;
      const len = Math.hypot(x, y, z);
      lon = toDeg(Math.atan2(y, x));
      lat = toDeg(Math.asin(z / len));
    }
    const k = Math.round((prevLon - lon) / 360);
    prevLon = lon + 360 * k;
    out.push({ lon: prevLon, lat });
  }
  return out;
}

export function destinationPoint(from: LonLat, bearingDeg: number, meters: number): LonLat {
  const ang = meters / EARTH_RADIUS_M; // angular distance, radians
  const brg = toRad(bearingDeg);
  const lat1 = toRad(from.lat);
  const lon1 = toRad(from.lon);
  const lat2 = Math.asin(
    Math.min(1, Math.max(-1, Math.sin(lat1) * Math.cos(ang) + Math.cos(lat1) * Math.sin(ang) * Math.cos(brg))),
  );
  const lon2 =
    lon1 +
    Math.atan2(
      Math.sin(brg) * Math.sin(ang) * Math.cos(lat1),
      Math.cos(ang) - Math.sin(lat1) * Math.sin(lat2),
    );
  return { lon: wrapLon(toDeg(lon2)), lat: toDeg(lat2) };
}

export function initialBearingDeg(a: LonLat, b: LonLat): number {
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const dLon = toRad(b.lon - a.lon);
  const y = Math.sin(dLon) * Math.cos(lat2);
  const x = Math.cos(lat1) * Math.sin(lat2) - Math.sin(lat1) * Math.cos(lat2) * Math.cos(dLon);
  return (toDeg(Math.atan2(y, x)) + 360) % 360;
}

// Craft.speed is knots repo-wide; converted here.
export function etaMs(
  from: LonLat,
  to: LonLat,
  speedKnots: number | null | undefined,
  now: number,
): number | null {
  if (speedKnots == null || speedKnots <= 0) return null;
  return now + (haversineMeters(from, to) / (speedKnots * MS_PER_KNOT)) * 1000;
}
