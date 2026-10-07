import "dotenv/config";

function int(name: string, def: number): number {
  const v = process.env[name];
  const n = v ? Number(v) : NaN;
  return Number.isFinite(n) ? n : def;
}

export const config = {
  PORT: int("PORT", 2001),
  OPENSKY_POLL_MS: int("OPENSKY_POLL_MS", 120000),
  OPENSKY_CLIENT_ID: process.env.OPENSKY_CLIENT_ID ?? "",
  OPENSKY_CLIENT_SECRET: process.env.OPENSKY_CLIENT_SECRET ?? "",
  BATCH_MS: int("BATCH_MS", 1000),
  STALE_MS: int("STALE_MS", 120000),
  REMOVE_MS: int("REMOVE_MS", 600000),
  HISTORY_SNAPSHOT_MS: int("HISTORY_SNAPSHOT_MS", 60000),
  HISTORY_MAX_BYTES: int("HISTORY_MAX_BYTES", 10_737_418_240),
  FAA_REFRESH_MS: int("FAA_REFRESH_MS", 86400000),
  AISSTREAM_API_KEY: process.env.AISSTREAM_API_KEY ?? "",
};
