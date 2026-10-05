import type { CraftKind } from "../shared/craft.js";

export function classifySea(aisType: number | null | undefined): CraftKind {
  if (aisType == null) return "other";
  const t = aisType;
  if (t >= 70 && t <= 79) return "cargo";
  if (t >= 80 && t <= 86) return "tanker";
  if ((t >= 44 && t <= 47) || (t >= 60 && t <= 63)) return "passenger";
  if (t === 30 || t === 54 || t === 57) return "military_vessel";
  if (t === 32) return "fishing";
  if (t === 31 || t === 36) return "sailing";
  if (t === 37) return "pleasure";
  if (t === 33 || t === 34 || t === 35 || t === 50 || t === 51 || t === 52 || t === 59) return "tug_work";
  if (t === 38 || t === 39 || t === 40 || t === 41 || t === 42 || t === 43 || t === 53 || t === 55 || t === 56 || t === 58) return "service";
  return "other";
}

const BIZ_PREFIXES = new Set([
  "EJA", "GTF", "LEG", "RJS", "FGE", "N7B", "CFS", "MTE", "JBP", "BEE",
]);

const MILITARY_RE =
  /\b(USAF|USN|USMC|USCG|NATO|RAF|VQ|RQ|P3|P-3|C130|C-130|C17|C-17|KC135|KC-135|B52|B-52|F16|F-16|F15|F-15|A10|A-10|E3|E4|U2|U-2|RC135|RC-135|AWACS|TACAMO|GRIFFIN|REAPER|HORNET|FALCON|TIGER|EAGLE|RAPTOR|STEALTH|BLACKHAWK|GHOST|PHANTOM|SHADOW|RAIDEN|STRIKER|WARRIOR|BANDIT)/i;

export const N_NUMBER_RE = /^N\d{1,5}[A-Z]{0,3}$/;
const AIRLINE_RE = /^[A-Z]{2,3}\d{1,4}$/;

export function classifyAir(input: { callsign?: string; spi?: boolean }): CraftKind {
  if (input.spi) return "military";
  const cs = (input.callsign ?? "").toUpperCase().trim();
  if (!cs) return "general";
  if (MILITARY_RE.test(cs)) return "military";
  if (N_NUMBER_RE.test(cs)) return "business";
  if (BIZ_PREFIXES.has(cs.slice(0, 3))) return "business";
  if (AIRLINE_RE.test(cs)) return "commercial";
  return "general";
}
