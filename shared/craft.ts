export type Domain = "air" | "sea";

export type CraftKind =
  | "commercial"
  | "business"
  | "military"
  | "general"
  | "cargo"
  | "tanker"
  | "passenger"
  | "military_vessel"
  | "fishing"
  | "sailing"
  | "pleasure"
  | "tug_work"
  | "service"
  | "other";

export interface Craft {
  id: string;
  domain: Domain;
  kind: CraftKind;
  lat: number;
  lon: number;
  speed: number | null;
  heading: number | null;
  // air (OpenSky)
  callsign?: string;
  altitude?: number | null;
  verticalRate?: number | null;
  squawk?: string | null;
  onGround?: boolean;
  spi?: boolean;
  originCountry?: string;
  // sea (aisstream.io)
  shipName?: string;
  imo?: number | null;
  callSign?: string;
  destination?: string;
  navStatus?: number | null;
  aisType?: number | null;
  updatedAt: number;
  stale: boolean;
}

export interface KindMeta {
  label: string;
  domain: Domain;
  icon: string; // MapLibre image name (=== kind, 1:1)
  color: string; // fallback dot color
}

export const KINDS: Record<CraftKind, KindMeta> = {
  commercial: { label: "Commercial", domain: "air", icon: "commercial", color: "#4fc3f7" },
  business: { label: "Business", domain: "air", icon: "business", color: "#81d4fa" },
  military: { label: "Military", domain: "air", icon: "military", color: "#ef5350" },
  general: { label: "General", domain: "air", icon: "general", color: "#90a4ae" },
  cargo: { label: "Cargo", domain: "sea", icon: "cargo", color: "#ffb74d" },
  tanker: { label: "Tanker", domain: "sea", icon: "tanker", color: "#ff8a65" },
  passenger: { label: "Passenger", domain: "sea", icon: "passenger", color: "#4dd0e1" },
  military_vessel: { label: "Military", domain: "sea", icon: "military_vessel", color: "#e57373" },
  fishing: { label: "Fishing", domain: "sea", icon: "fishing", color: "#aed581" },
  sailing: { label: "Sailing", domain: "sea", icon: "sailing", color: "#ba68c8" },
  pleasure: { label: "Pleasure", domain: "sea", icon: "pleasure", color: "#f06292" },
  tug_work: { label: "Tug / Work", domain: "sea", icon: "tug_work", color: "#fff176" },
  service: { label: "Service", domain: "sea", icon: "service", color: "#a1887f" },
  other: { label: "Other", domain: "sea", icon: "other", color: "#b0bec5" },
};

export const AIR_KINDS: CraftKind[] = ["commercial", "business", "military", "general"];
export const SEA_KINDS: CraftKind[] = [
  "cargo",
  "tanker",
  "passenger",
  "military_vessel",
  "fishing",
  "sailing",
  "pleasure",
  "tug_work",
  "service",
  "other",
];
