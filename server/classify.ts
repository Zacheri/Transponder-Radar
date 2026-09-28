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
