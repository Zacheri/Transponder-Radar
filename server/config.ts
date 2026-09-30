import "dotenv/config";

function int(name: string, def: number): number {
  const v = process.env[name];
  const n = v ? Number(v) : NaN;
  return Number.isFinite(n) ? n : def;
}

export const config = {
  PORT: int("PORT", 8787),
  OPENSKY_POLL_MS: int("OPENSKY_POLL_MS", 36000),
  OPENSKY_USERNAME: process.env.OPENSKY_USERNAME ?? "",
  OPENSKY_PASSWORD: process.env.OPENSKY_PASSWORD ?? "",
  BATCH_MS: int("BATCH_MS", 1000),
  STALE_MS: int("STALE_MS", 120000),
  REMOVE_MS: int("REMOVE_MS", 600000),
  AISSTREAM_API_KEY: process.env.AISSTREAM_API_KEY ?? "",
};
