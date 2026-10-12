# Implementation Plan: Model-Driven Aircraft Icons

- **Spec:** `docs/superpowers/specs/2026-10-11-model-aircraft-icons-design.md` (approved 2026-10-11; data corrections applied 2026-10-12 against the real FAA cache)
- **Goal:** Replace the 4 generic aircraft icons with 13 shape-family icons, resolved
  server-side from military callsigns + FAA model data, with per-kind fallbacks.
  Sea icons unchanged.
- **Architecture:** new `server/icons.ts` resolver (`resolveAirIcon`); optional
  `Craft.icon` field carries the MapLibre image name over WS; client renders
  `["get", "icon"]` with `c.icon ?? (air ? KIND_FALLBACK_ICON[kind] : kind)`.

**REQUIRED SUB-SKILL:** When executing this plan, use one of
- `superpowers:subagent-driven-development` (recommended — fresh subagent per task), or
- `superpowers:executing-plans` (inline execution in this session)

## Global Constraints

(From the spec + AGENTS.md. Every task obeys these.)

- **Gate after every task:** `npm test` → `npm run typecheck` → `npm run build`,
  all green, before moving on. `npm run lint` is broken repo-wide — NOT in the gate.
- **TDD:** behavior-changing steps write the failing test first, run it to see it
  fail, then implement. Visual assets (SVG paths) are verified by the user in
  browser; their testable surface (registry names) is tested.
- **No new runtime dependencies. No placeholder code — every code block below is
  final.**
- **SVG authoring:** 24×24 `viewBox`, top-down nose-up (icons rotate by heading),
  single `<path>` element with one fill color (multiple subpaths within one
  `d` are allowed and required for prop/rotor discs and engine ticks), no strokes.
- **Family colors:** narrowbody/widebody/turboprop `#4fc3f7`; bizjet/bizheli
  `#81d4fa`; piston/heli `#90a4ae`; fighter/attack/transport/tanker_air/isr/milheli
  `#ef5350`.
- **Commit after each task** (message given per task). Push at the end
  (Task 6) — or earlier if the user's ssh agent is loaded; if push fails with
  `Permission denied (publickey)`, ask the user to run `ssh-add ~/.ssh/id_rsa`.
- **Never print secret values** (`.env`, `credentials.json`).
- Sea vessel code paths (`server/ais.ts`, `server/normalize.ts` sea branch) are
  untouched.

### Refinements to the spec (noted at plan time, behavior-identical)

1. **`KINDS` air entries get fallback-family icon names.** `KINDS[k].icon` is
   documented as "MapLibre image name" — after deleting the 4 old air SVGs,
   `icon: "commercial"` etc. would point at nonexistent images. Update the four
   air entries to `KIND_FALLBACK_ICON` values so every `KINDS[k].icon` stays a
   registered image name. Nothing in the client reads `KINDS[k].icon` today
   (panel/filters use `.label`/`.color`), so no behavior change.
2. **Client fallback needs a TS cast.** `Craft.domain === "air"` does not narrow
   `kind` to `AirKind` (single interface, no discriminant), so the spec's
   features expression is written with an explicit
   `c.kind as AirKind` (the domain check is the runtime guard).
3. **`buildApp` glue is covered by its parts.** Integration tests inject their
   own `OpenSkyPoller`, so `buildApp`'s auto-constructed poller + resolver
   closure (≈8 lines of glue) is not directly unit-tested; `resolveAirIcon`,
   `faa.lookup`, and the poller `resolveIcon` opt are each tested, and the
   user's dev run verifies the live wiring. (Same pattern as existing
   `tokenProvider` wiring.)

---

## Task 1: Shared types — `AirKind`, `KIND_FALLBACK_ICON`, `Craft.icon?`

**Files:**
- Modify: `shared/craft.ts`
- Create: `test/shared-craft.test.ts`

**Step 1.1 — Failing test.** Create `test/shared-craft.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { KIND_FALLBACK_ICON } from "../shared/craft.js";

describe("KIND_FALLBACK_ICON", () => {
  it("maps each air kind to its approved fallback family", () => {
    expect(KIND_FALLBACK_ICON).toEqual({
      commercial: "narrowbody",
      business: "bizjet",
      military: "fighter",
      general: "piston",
    });
  });
});
```

Run: `npx vitest run test/shared-craft.test.ts`
Expect: FAIL — `KIND_FALLBACK_ICON` is not exported.

**Step 1.2 — Implement in `shared/craft.ts`.**

(a) After the `CraftKind` union (after line 17), add:

```ts
export type AirKind = Extract<CraftKind, "commercial" | "business" | "military" | "general">;
```

(b) In `interface Craft`, after `kind: CraftKind;`, add:

```ts
  // MapLibre icon image name. Air: shape family resolved server-side
  // (server/icons.ts); sea: kind name (1:1). Optional — old history
  // snapshots and runs without an FAA provider leave it unset, and the
  // client falls back (src/data/features.ts).
  icon?: string;
```

(c) Update the four air entries in the `KINDS` record (refinement #1):

```ts
  commercial: { label: "Commercial", domain: "air", icon: "narrowbody", color: "#4fc3f7" },
  business: { label: "Business", domain: "air", icon: "bizjet", color: "#81d4fa" },
  military: { label: "Military", domain: "air", icon: "fighter", color: "#ef5350" },
  general: { label: "General", domain: "air", icon: "piston", color: "#90a4ae" },
```

(d) At the end of the file, after `SEA_KINDS`, add:

```ts
// Icon fallback when no model data exists (all non-US air, SPI-only
// military, unknown codes): kind → shape family.
export const KIND_FALLBACK_ICON: Record<AirKind, string> = {
  commercial: "narrowbody",
  business: "bizjet",
  military: "fighter",
  general: "piston",
};
```

**Step 1.3** — Run the test → PASS.
**Step 1.4** — Full gate: `npm test && npm run typecheck && npm run build`.
**Step 1.5** — Commit: `feat(shared): AirKind, Craft.icon?, KIND_FALLBACK_ICON; KINDS air icons → fallback families`

---

## Task 2: Resolver — `server/icons.ts` + `test/air-icons.test.ts`

**Files:**
- Create: `server/icons.ts`
- Create: `test/air-icons.test.ts`

**Step 2.1 — Failing test.** Create `test/air-icons.test.ts` with the complete
file below. Every row of the `it.each` tables is a spec §3.2 minimum-coverage
code or a disambiguation trap; the military table covers every §3.1 token plus
order/anchor traps.

```ts
import { describe, it, expect } from "vitest";
import { resolveAirIcon, AIR_FAMILY_ICONS, normalizeModel } from "../server/icons.js";
import type { AirKind } from "../shared/craft.js";

const air = (
  kind: AirKind,
  over: { callsign?: string; faaModel?: string | null; faaMfr?: string | null } = {},
) => resolveAirIcon({ kind, ...over });

describe("resolveAirIcon — military callsign table", () => {
  const mil = (callsign?: string) => air("military", { callsign });

  it.each([
    ["KC135", "tanker_air"], ["KC10", "tanker_air"], ["KC46", "tanker_air"], ["KCTC", "tanker_air"],
    ["CH47", "milheli"], ["CH53", "milheli"], ["UH60", "milheli"], ["UH6", "milheli"],
    ["MH60", "milheli"], ["SH60", "milheli"], ["H60", "milheli"], ["AH64", "milheli"],
    ["BLACKHAWK", "milheli"],
    ["A10", "attack"],
    ["C130", "transport"], ["C17", "transport"], ["C5", "transport"], ["C21", "transport"],
    ["A400M", "transport"], ["VC25", "transport"], ["C40", "transport"],
    ["RC135", "isr"], ["EP3", "isr"], ["E3", "isr"], ["P3", "isr"], ["U2", "isr"],
    ["TACAMO", "isr"], ["AWACS", "isr"], ["GRIFIN", "isr"], ["REAPER", "isr"],
    ["MQ9", "isr"], ["RQ4", "isr"],
    ["F15", "fighter"], ["F16", "fighter"], ["F18", "fighter"], ["F22", "fighter"], ["F35", "fighter"],
  ])("callsign %s → %s", (callsign, icon) => {
    expect(mil(callsign)).toBe(icon);
  });

  it("prefix tokens: E3G → isr, P3C → isr, U2S → isr", () => {
    expect(mil("E3G")).toBe("isr");
    expect(mil("P3C")).toBe("isr");
    expect(mil("U2S")).toBe("isr");
  });

  it("word anchors: C172, C550, F162 do not match their prefixes", () => {
    expect(mil("C172")).toBe("fighter"); // C17 anchor fails → fallback
    expect(mil("C550")).toBe("fighter"); // C5 anchor fails → fallback
    expect(mil("F162")).toBe("fighter"); // F16 anchor fails → fallback (still fighter)
  });

  it("squadron names do not map: EAGLE, RAPTOR, TIGER, BANDIT → fighter fallback", () => {
    for (const cs of ["EAGLE", "RAPTOR", "TIGER", "BANDIT"]) expect(mil(cs)).toBe("fighter");
  });

  it("no callsign / SPI → fighter fallback", () => {
    expect(mil()).toBe("fighter");
    expect(mil("")).toBe("fighter");
  });

  it("military kind ignores FAA data", () => {
    expect(air("military", { callsign: "F16", faaModel: "737-8DR", faaMfr: "BOEING" })).toBe("fighter");
  });
});

describe("resolveAirIcon — FAA model table (minimum coverage)", () => {
  const civ = (model: string, mfr?: string, kind: "commercial" | "business" | "general" = "general") =>
    air(kind, { faaModel: model, faaMfr: mfr ?? null });

  it("normalizes model text (case, spaces, hyphens)", () => {
    expect(normalizeModel("737-8DR")).toBe("7378DR");
    expect(normalizeModel("ATR 72-212A")).toBe("ATR72212A");
    expect(normalizeModel("FALCON XP")).toBe("FALCONXP");
    expect(normalizeModel(null)).toBe("");
  });

  it.each([
    // narrowbody
    ["737-8DR", "BOEING", "narrowbody"],
    ["737-9", "BOEING", "narrowbody"],
    ["737-8200", "BOEING", "narrowbody"],
    ["757-300", "BOEING", "narrowbody"],
    ["B717-200", "BOEING", "narrowbody"],
    ["A320-214", "AIRBUS", "narrowbody"],
    ["A321-271NX", "AIRBUS", "narrowbody"],
    ["A319-112", "AIRBUS INDUSTRIE", "narrowbody"],
    ["E175", "EMBRAER", "narrowbody"],
    ["E190", "EMBRAER", "narrowbody"],
    ["EMB-145LR", "EMBRAER", "narrowbody"],
    ["EMB-190", "EMBRAER", "narrowbody"],
    ["CRJ700", "BOMBARDIER INC", "narrowbody"],
    ["MD-88", "MCDONNELL DOUGLAS CORPORATION", "narrowbody"],
    ["MD-90-30", "MCDONNELL DOUGLAS", "narrowbody"],
    ["DC9-15", "DOUGLAS", "narrowbody"],
    ["146-200", "BRITISH AEROSPACE", "narrowbody"],
    ["F100", "FOKKER", "narrowbody"],
    ["F70", "FOKKER", "narrowbody"],
    ["F28F", "FOKKER", "narrowbody"],
    ["SAAB 340B", "SAAB AB", "narrowbody"],
    // widebody
    ["747-428", "BOEING", "widebody"],
    ["747-8ZV", "BOEING", "widebody"],
    ["767-300F", "BOEING", "widebody"],
    ["777-35RER", "BOEING", "widebody"],
    ["787-8", "BOEING", "widebody"],
    ["A330-941", "AIRBUS", "widebody"],
    ["A330-302", "AIRBUS", "widebody"],
    ["A380-841", "AIRBUS S A S", "widebody"],
    ["MD-11F", "MCDONNELL DOUGLAS", "widebody"],
    ["IL-96-300", "ILYUSHIN", "widebody"],
    // turboprop
    ["ATR72-212A", "AEROSPATIALE", "turboprop"],
    ["ATR 72-212", "ATR", "turboprop"],
    ["ATR42-500", "AEROSPATIALE/ATR", "turboprop"],
    ["DHC-8-400", "DEHAVILLAND", "turboprop"],
    ["DHC-6-300", "VIKING AIR", "turboprop"],
    ["TWIN OTTER", "HANGAR 9", "turboprop"],
    ["208B", "CESSNA", "turboprop"],
    ["PC-12/47E", "PILATUS AIRCRAFT LTD", "turboprop"],
    ["SAAB 2000", "SAAB-SCANIA AB", "turboprop"],
    ["B200GT", "BEECH", "turboprop"],
    ["B350", "BEECH", "turboprop"],
    ["F27", "FOKKER", "turboprop"],
    ["F27M", "FAIRCHILD", "turboprop"],
    // bizjet
    ["G150", "GULFSTREAM AEROSPACE", "bizjet"],
    ["G650", "GULFSTREAM AEROSPACE", "bizjet"],
    ["G280", "GULFSTREAM", "bizjet"],
    ["C550", "CESSNA", "bizjet"],
    ["C680", "CESSNA", "bizjet"],
    ["CJ1", null, "bizjet"],
    ["CJ-6A", null, "bizjet"],
    ["CL600-1A11", "CANADAIR LTD", "bizjet"],
    ["FALCON XP", "DASSAULT AVIATION", "bizjet"],
    ["FALCON 50", "DASSAULT", "bizjet"],
    ["F50", "DASSAULT", "bizjet"],
    ["F7X", "DASSAULT", "bizjet"],
    ["F70", "DASSAULT AVIATION", "bizjet"],
    ["MD-311", "DASSAULT", "bizjet"],
    ["L420", "LEARJET INC", "bizjet"],
    ["LJ-200-1A10", "LEARJET INC", "bizjet"],
    ["P28A", "PIPER", "bizjet"],
    ["HAWKER 800XP", "HAWKER BEECHCRAFT CORP", "bizjet"],
    ["HAWKER 900XP", "RAYTHEON", "bizjet"],
    ["HAWK 800XP", "HAWKER BEECHCRAFT CORP", "bizjet"],
    // heli
    ["R44", "ROBINSON HELICOPTER", "heli"],
    ["R44 II", "ROBINSON HELICOPTER COMPANY", "heli"],
    ["R22", "ROBINSON", "heli"],
    ["K120", null, "heli"],
    ["B206", "BELL", "heli"],
    ["EC130", "AIRBUS HELICOPTERS", "heli"],
    ["H135", "AIRBUS HELICOPTERS SAS", "heli"],
    ["280FX", "ENSTROM", "heli"],
    ["F28F", "ENSTROM HELICOPTER CORP", "heli"],
    // bizheli
    ["R66", "ROBINSON HELICOPTER CO", "bizheli"],
    ["B407", "BELL", "bizheli"],
    ["AW139", "AGUSTA", "bizheli"],
    ["S76", "SIKORSKY", "bizheli"],
    ["S202", "SIKORSKY", "bizheli"],
    ["S300", "SIKORSKY", "bizheli"],
    // piston
    ["172S", "CESSNA", "piston"],
    ["172", "CESSNA", "piston"],
    ["182T", "CESSNA", "piston"],
    ["206", "CESSNA", "piston"],
    ["310", "CESSNA", "piston"],
    ["B35", "BEECH", "piston"],
    ["B58", "BEECH", "piston"],
    ["PA-28-181", "PIPER", "piston"],
    ["DA40 D", "DIAMOND AIRCRAFT IND GMBH", "piston"],
    ["SR22", null, "piston"],
    ["SR22T", null, "piston"],
    ["L410", "LET", "piston"],
    ["ASK 21", "SCHLEICHER", "piston"],
    ["S7", "RANS", "piston"],
    ["Q200", "QUICKSILVER", "piston"],
  ])("%s (%s) → %s", (model, mfr, icon) => {
    expect(civ(model, mfr ?? undefined)).toBe(icon);
  });

  it("military heli models resolve by model only (operator MFRs in real data)", () => {
    expect(civ("UH-60A", "AAR AIRLIFT GROUP INC")).toBe("milheli");
    expect(civ("CH-47D", "MCDONNELL DOUGLAS")).toBe("milheli");
    expect(civ("AH-64", "BOEING")).toBe("milheli");
  });
});

describe("resolveAirIcon — disambiguation traps", () => {
  const civ = (model: string, mfr?: string) =>
    resolveAirIcon({ kind: "general", faaModel: model, faaMfr: mfr ?? null });
  const biz = (model: string, mfr?: string) =>
    resolveAirIcon({ kind: "business", faaModel: model, faaMfr: mfr ?? null });

  it("F70: DASSAULT → bizjet, FOKKER → narrowbody, no mfr → bizjet", () => {
    expect(civ("F70", "DASSAULT")).toBe("bizjet");
    expect(civ("F70", "FOKKER")).toBe("narrowbody");
    expect(civ("F70")).toBe("bizjet");
  });

  it("S-prefix: mfr decides; no mfr → kind fallback", () => {
    expect(civ("S202", "SIKORSKY")).toBe("bizheli");
    expect(civ("S200", "SAAB")).toBe("turboprop");
    expect(civ("S200", "SIPA")).toBe("turboprop");
    expect(civ("S7", "RANS")).toBe("piston");
    expect(civ("S7")).toBe("piston"); // general kind fallback
    expect(biz("S7")).toBe("bizjet"); // business kind fallback
  });

  it("F28F: FOKKER → narrowbody (jet), ENSTROM → heli (Enstrom 28F)", () => {
    expect(civ("F28F", "FOKKER")).toBe("narrowbody");
    expect(civ("F28F", "ENSTROM HELICOPTER CORP")).toBe("heli");
  });

  it("FALCON: DASSAULT → bizjet; FALCONAR (no DASSAULT mfr) → kind fallback", () => {
    expect(civ("FALCON XP", "DASSAULT AVIATION")).toBe("bizjet");
    expect(civ("FALCONAR F-12")).toBe("piston");
    expect(biz("FALCONAR F-12")).toBe("bizjet");
  });

  it("HAWK: HAWKER BEECHCRAFT/RAYTHEON → bizjet; CGS AVIATION glider → fallback", () => {
    expect(civ("HAWKER 800XP", "HAWKER BEECHCRAFT CORP")).toBe("bizjet");
    expect(civ("HAWKER 900XP", "RAYTHEON")).toBe("bizjet");
    expect(civ("HAWK ARROW II", "CGS AVIATION")).toBe("piston");
    expect(biz("HAWK", "CGS AVIATION")).toBe("bizjet");
  });

  it("L410 → piston; L420/LJ (LEARJET mfr) → bizjet; LJ with person mfr → fallback", () => {
    expect(civ("L410", "LET")).toBe("piston");
    expect(biz("L420", "LEARJET INC")).toBe("bizjet");
    expect(civ("LJ-3", "DART ROBERT G")).toBe("piston");
  });

  it("B35 (Bonanza) → piston; B350 (King Air) → turboprop", () => {
    expect(civ("B35", "BEECH")).toBe("piston");
    expect(civ("B350", "BEECH")).toBe("turboprop");
  });

  it("Cessna numbers without C prefix: 172S → piston, 208B → turboprop, CJ1 → bizjet", () => {
    expect(civ("172S", "CESSNA")).toBe("piston");
    expect(civ("208B", "CESSNA")).toBe("turboprop");
    expect(civ("CJ1")).toBe("bizjet");
  });

  it("K120 → heli; K1200 (KIWI) → no match → kind fallback", () => {
    expect(civ("K120", "KAISER")).toBe("heli");
    expect(civ("K1200", "KIWI TECHNOLOGIES INC")).toBe("piston");
    expect(biz("K1200", "KIWI TECHNOLOGIES INC")).toBe("bizjet");
  });
});

describe("resolveAirIcon — fallbacks and output shape", () => {
  it("unknown model → kind fallback", () => {
    expect(resolveAirIcon({ kind: "commercial", faaModel: "XYZZY", faaMfr: "ACME" })).toBe("narrowbody");
    expect(resolveAirIcon({ kind: "business", faaModel: "XYZZY" })).toBe("bizjet");
    expect(resolveAirIcon({ kind: "general", faaModel: "XYZZY" })).toBe("piston");
    expect(resolveAirIcon({ kind: "military", faaModel: "XYZZY" })).toBe("fighter");
  });

  it("no model at all → kind fallback", () => {
    expect(resolveAirIcon({ kind: "commercial", callsign: "DAL539" })).toBe("narrowbody");
    expect(resolveAirIcon({ kind: "general" })).toBe("piston");
  });

  it("never returns an unregistered name", () => {
    const names = new Set<string>([...AIR_FAMILY_ICONS]);
    for (const kind of ["commercial", "business", "military", "general"] as const) {
      for (const model of [null, "", "XYZZY", "F70", "S7", "K1200"]) {
        for (const mfr of [null, "BOEING", "FOKKER"]) {
          expect(names.has(resolveAirIcon({ kind, faaModel: model, faaMfr: mfr }))).toBe(true);
        }
      }
    }
  });
});
```

Run: `npx vitest run test/air-icons.test.ts`
Expect: FAIL — `../server/icons.js` does not exist.

**Step 2.2 — Implement `server/icons.ts`.** Create with the complete file:

```ts
import type { AirKind } from "../shared/craft.js";
import { KIND_FALLBACK_ICON } from "../shared/craft.js";

export const AIR_FAMILY_ICONS = [
  "narrowbody",
  "widebody",
  "turboprop",
  "bizjet",
  "bizheli",
  "piston",
  "heli",
  "fighter",
  "attack",
  "transport",
  "tanker_air",
  "isr",
  "milheli",
] as const;
export type AirFamilyIcon = (typeof AIR_FAMILY_ICONS)[number];

export interface ResolveAirIconArgs {
  kind: AirKind; // typed to the air union — sea kinds cannot be passed
  callsign?: string;
  faaModel?: string | null; // FaaRecord.model, e.g. "737-8DR"
  faaMfr?: string | null; // FaaRecord.mfr, e.g. "BOEING"
}

/** Uppercase, strip spaces and hyphens (737-8DR → 7378DR, FALCON XP → FALCONXP). */
export function normalizeModel(v: string | null | undefined): string {
  return (v ?? "").toUpperCase().replace(/[\s-]/g, "");
}

const normMfr = (v: string | null | undefined): string => (v ?? "").toUpperCase();

// ── Military callsign table (spec §3.1; order significant) ─────────────────
// Callsigns are uppercased before matching. Tokens are word-anchored on BOTH
// ends (\b…\b) so C5 cannot match C550 and C17 cannot match C172; the prefix
// tokens E3/P3/U2 (valid prefixes of real variants: E-3G, P-3C, U-28) keep
// the leading boundary only — hence the separate rule. No table hit →
// fighter fallback.

interface MilRule {
  re: RegExp;
  icon: AirFamilyIcon;
}

const MIL_RULES: MilRule[] = [
  { re: /\b(KC135|KC10|KC46|KCTC)\b/, icon: "tanker_air" },
  { re: /\b(CH47|CH53|UH60|UH6|MH60|SH60|H60|AH64|BLACKHAWK)\b/, icon: "milheli" },
  { re: /\bA10\b/, icon: "attack" },
  { re: /\b(C130|C17|C5|C21|A400M|VC25|C40)\b/, icon: "transport" },
  { re: /\b(RC135|EP3|TACAMO|AWACS|GRIFIN|REAPER|MQ9|RQ4)\b/, icon: "isr" },
  { re: /\b(E3|P3|U2)/, icon: "isr" }, // prefix tokens (E-3G, P-3C, U-28) — no trailing boundary
  { re: /\b(F15|F16|F18|F22|F35)\b/, icon: "fighter" },
];

function militaryIcon(callsign: string | undefined): AirFamilyIcon {
  const cs = (callsign ?? "").toUpperCase();
  for (const r of MIL_RULES) if (r.re.test(cs)) return r.icon;
  return "fighter";
}

// ── FAA model table (spec §3.2; ordered; helis before fixed-wing) ───────────
// mfr (when present) = the normalized MFR must contain at least one of the
// listed substrings. Real-data quirks encoded here: Cessna numbers carry no
// C prefix (172S, 208B); F28F is Fokker jet OR Enstrom 28F heli (mfr decides);
// FALCON/HAWKER are name-style models; military helis often carry the operator
// as MFR (match by model only).

interface FaaRule {
  mfr?: string[];
  re: RegExp;
  icon: AirFamilyIcon;
}

const FAA_RULES: FaaRule[] = [
  // helis — bizheli
  { mfr: ["ROBINSON"], re: /^R66/, icon: "bizheli" },
  { mfr: ["BELL"], re: /^B(407|429|52|76)/, icon: "bizheli" },
  { mfr: ["AGUSTA"], re: /^AW(139|169)/, icon: "bizheli" },
  { mfr: ["SIKORSKY"], re: /^S(76|92|202|300)/, icon: "bizheli" },
  // helis — light
  { mfr: ["ROBINSON"], re: /^R(22|44)/, icon: "heli" },
  { mfr: ["BELL"], re: /^B206/, icon: "heli" },
  { mfr: ["AIRBUS"], re: /^(EC120|EC130|H125|H135|H145)/, icon: "heli" },
  { re: /^K120(?!0)/, icon: "heli" }, // K120 — not K1200 (Kiwi)
  { mfr: ["ENSTROM"], re: /^F?28/, icon: "heli" }, // 28F, 280FX (coded F28F/280FX)
  // helis — defensive (civil-kind records of military types; MFR often = operator)
  { re: /^(CH47|CH53|UH60|MH60|SH60|AH64)/, icon: "milheli" },
  // bizjet
  { mfr: ["GULFSTREAM"], re: /^G(150|280|550|650)/, icon: "bizjet" },
  { mfr: ["CESSNA"], re: /^C[56]\d\d/, icon: "bizjet" }, // C500…C680
  { re: /^CJ\d/, icon: "bizjet" }, // CJ1/CJ2/CJ3 Starlet (person MFRs exist)
  { mfr: ["BOMBARDIER", "CANADAIR"], re: /^CL6/, icon: "bizjet" },
  { mfr: ["DASSAULT"], re: /^(FALCON|F50|F500|F5XR|F7X|F70|F10|MD31[123])/, icon: "bizjet" },
  { mfr: ["LEARJET", "TEXTRON"], re: /^(L420|LJ\d|L100|L200|L3\d{3})/, icon: "bizjet" },
  { mfr: ["PIPER"], re: /^P(28|35)([A-Z]|$)/, icon: "bizjet" },
  {
    mfr: ["HAWKER BEECHCRAFT", "HAWKER SIDDELEY", "RAYTHEON", "TEXTRON"],
    re: /^HAWKER[0-9A-Z]/,
    icon: "bizjet",
  },
  {
    mfr: ["HAWKER BEECHCRAFT", "HAWKER SIDDELEY", "RAYTHEON", "TEXTRON"],
    re: /^HAWK[0-9]/,
    icon: "bizjet",
  },
  // widebody
  { mfr: ["BOEING"], re: /^(747|767|777|787)/, icon: "widebody" },
  { mfr: ["AIRBUS"], re: /^A3[3-8]/, icon: "widebody" },
  { mfr: ["MCDONNELL"], re: /^MD1[01]/, icon: "widebody" },
  { re: /^(IL96|TU204|AN124)/, icon: "widebody" },
  // narrowbody
  { mfr: ["BOEING"], re: /^(737|757|717|B717)/, icon: "narrowbody" },
  { mfr: ["AIRBUS"], re: /^A3(1[89]|2[01])/, icon: "narrowbody" },
  { mfr: ["EMBRAER"], re: /^(E[12]\d\d|EMB\d)/, icon: "narrowbody" },
  { mfr: ["BOMBARDIER"], re: /^CRJ/, icon: "narrowbody" },
  { mfr: ["MCDONNELL"], re: /^MD(8\d|9\d)/, icon: "narrowbody" },
  { mfr: ["DOUGLAS", "BOEING"], re: /^DC9/, icon: "narrowbody" },
  { mfr: ["BRITISH AEROSPACE", "BAE"], re: /^146/, icon: "narrowbody" },
  { mfr: ["FOKKER"], re: /^(F100|F70|F28)/, icon: "narrowbody" },
  { re: /^F70([A-Z]|$)/, icon: "bizjet" }, // F70 without FOKKER mfr defaults to Falcon (spec trap)
  { mfr: ["SAAB"], re: /^(SAAB)?340/, icon: "narrowbody" },
  // turboprop
  { re: /^ATR/, icon: "turboprop" }, // ATR42/72 — real MFRs vary (ATR, AEROSPATIALE…)
  { re: /^(DHC6|DHC8|TWINOTTER|DASH)/, icon: "turboprop" }, // VIKING/DEHAVILLAND…
  { mfr: ["CESSNA"], re: /^(208|CARAVAN)/, icon: "turboprop" },
  { mfr: ["PILATUS"], re: /^PC12/, icon: "turboprop" },
  { mfr: ["SAAB", "SIPA"], re: /^(SAAB)?2000/, icon: "turboprop" },
  { mfr: ["SAAB", "SIPA"], re: /^S200$/, icon: "turboprop" },
  { mfr: ["BEECH", "TEXTRON"], re: /^B(200|300|350|360)/, icon: "turboprop" }, // King Air
  { mfr: ["FOKKER", "FAIRCHILD"], re: /^F27/, icon: "turboprop" },
  { re: /^(D228|YAK40)/, icon: "turboprop" },
  // piston / light
  { mfr: ["CESSNA"], re: /^[1-7]\d\d(?!\d)/, icon: "piston" }, // 172S, 182T, 206… (208 → turboprop above)
  { mfr: ["BEECH"], re: /^B(25|35|55|58|99)([A-Z]|$)/, icon: "piston" }, // B350 → King Air above
  { mfr: ["PIPER"], re: /^PA\d/, icon: "piston" },
  { mfr: ["DIAMOND"], re: /^DA\d/, icon: "piston" },
  { re: /^SR2[02]/, icon: "piston" },
  { re: /^L410/, icon: "piston" },
  { re: /^L(18|36)/, icon: "piston" },
  { mfr: ["SCHLEICHER"], re: /^(ASK|ARCUS|DUO|SECOR)/, icon: "piston" },
  { mfr: ["RANS"], re: /^S\d/, icon: "piston" }, // ultralights (S7, S20…)
  { mfr: ["QUICKSILVER"], re: /^Q200/, icon: "piston" },
];

/**
 * Resolve the MapLibre icon image name for an aircraft.
 * Order: military kind → callsign table; civil → FAA model table; then
 * kind fallback. Always returns a family name (never a kind name).
 */
export function resolveAirIcon(args: ResolveAirIconArgs): string {
  const { kind, callsign, faaModel, faaMfr } = args;
  if (kind === "military") return militaryIcon(callsign);
  const model = normalizeModel(faaModel);
  if (model !== "") {
    const mfr = normMfr(faaMfr);
    for (const r of FAA_RULES) {
      if ((r.mfr === undefined || r.mfr.some((f) => mfr.includes(f))) && r.re.test(model)) {
        return r.icon;
      }
    }
  }
  return KIND_FALLBACK_ICON[kind];
}
```

**Step 2.3** — Run `npx vitest run test/air-icons.test.ts` → PASS (all rows).
If a row fails, the bug is in the table (order or regex), not the test — fix
`FAA_RULES`/`MIL_RULES` until green; the test rows are the spec's contract.

**Step 2.4** — Full gate: `npm test && npm run typecheck && npm run build`.
**Step 2.5** — Commit: `feat(server): resolveAirIcon — 13 shape families from military callsigns + FAA model data`

---

## Task 3: Poller `resolveIcon` opt + `buildApp` wiring + integration

**Files:**
- Modify: `server/opensky.ts`
- Modify: `server/index.ts`
- Modify: `test/poller.test.ts`
- Modify: `test/integration.test.ts`

**Step 3.1 — Failing poller test.** In `test/poller.test.ts`, inside the main
`describe("OpenSkyPoller", …)` block, immediately after the
`"polls, normalizes, upserts into store"` test (after line 40), insert:

```ts
  it("applies resolveIcon to normalized crafts when configured", async () => {
    const store = new CraftStore();
    const poller = new OpenSkyPoller({
      url, pollMs: 1000, graceMs: 30000, store,
      resolveIcon: () => "narrowbody",
    });
    current = { time: 0, states: [PLANE] };
    await poller.pollOnce();
    expect(store.get("ac4963")!.icon).toBe("narrowbody");
  });

  it("leaves icon unset when no resolver is configured", async () => {
    const store = new CraftStore();
    const poller = new OpenSkyPoller({ url, pollMs: 1000, graceMs: 30000, store });
    current = { time: 0, states: [PLANE] };
    await poller.pollOnce();
    expect(store.get("ac4963")!.icon).toBeUndefined();
  });
```

Run: `npx vitest run test/poller.test.ts`
Expect: FAIL — the first new test (`icon` is undefined); the second already
passes (regression guard).

**Step 3.2 — Implement the poller opt.** In `server/opensky.ts`:

(a) Add the import after line 2 (`import { normalizeOpenSky } …`):

```ts
import type { Craft } from "../shared/craft.js";
```

(b) In `OpenSkyPollerOpts`, after `tokenProvider?: TokenProvider;`, add:

```ts
  resolveIcon?: (c: Craft) => string;
```

(c) In `pollOnce`, replace the row loop (lines 142–148):

```ts
    for (const row of rows) {
      const c = normalizeOpenSky(row, now);
      if (c) {
        const icon = this.opts.resolveIcon?.(c);
        if (icon) c.icon = icon;
        crafts.push(c);
        present.add(c.id);
      }
    }
```

**Step 3.3** — Run `npx vitest run test/poller.test.ts` → PASS.

**Step 3.4 — Wire `buildApp`.** In `server/index.ts`:

(a) Add imports (after line 15, the `FaaLookup` import):

```ts
import { resolveAirIcon } from "./icons.js";
import type { AirKind } from "../shared/craft.js";
```

(b) `faa` is declared *after* the poller today (lines 64–68) but the resolver
closure needs it. Move these two declarations (currently lines 64–68) to just
above the `const opensky = …` block (before line 30). Leave the
`if (faa) void faa.init()…` line (currently line 69) where it is:

```ts
  const faaDir = resolve(process.cwd(), "data/faa");
  const faa: FaaProvider | null =
    deps.faa === undefined
      ? new FaaLoader({ dir: faaDir, refreshMs: config.FAA_REFRESH_MS, log })
      : deps.faa;
```

(c) In the auto-constructed poller (lines 32–44), after the `tokenProvider:`
property, add:

```ts
      resolveIcon: faa
        ? (c) => {
            const rec = faa.lookup(c.id);
            return resolveAirIcon({
              kind: c.kind as AirKind, // poller is air-only
              callsign: c.callsign,
              faaModel: rec?.model ?? null,
              faaMfr: rec?.mfr ?? null,
            });
          }
        : undefined,
```

**Step 3.5 — Integration: resolver wired to fakeFaa.** In
`test/integration.test.ts`:

(a) Add imports (after line 13, the `FaaProvider` import):

```ts
import { resolveAirIcon } from "../server/icons.js";
import type { AirKind } from "../shared/craft.js";
```

(b) Extend the first poller construction (lines 65–70) with the resolver:

```ts
    const opensky = new OpenSkyPoller({
      url: `http://127.0.0.1:${hport}/states/all`,
      pollMs: 50,
      graceMs: 30000,
      store,
      resolveIcon: (c) => {
        const rec = fakeFaa.lookup(c.id);
        return resolveAirIcon({
          kind: c.kind as AirKind,
          callsign: c.callsign,
          faaModel: rec?.model ?? null,
          faaMfr: rec?.mfr ?? null,
        });
      },
    });
```

(Leave the timeline test's poller — lines 186–191 — without a resolver; it
exercises hand-crafted history crafts that carry no icon.)

(c) In the first test `"streams a snapshot and updates for both domains"`,
after `expect(ship.shipName).toBe("PIPELINE SHIP");` (line 134), add:

```ts
    expect(plane.icon).toBe("narrowbody"); // fakeFaa: 737-8DR / BOEING
    expect(ship.icon).toBeUndefined(); // AIS sets no icon — client falls back
```

Run: `npx vitest run test/integration.test.ts` → PASS (before 3.5b/3.5c the
`plane.icon` assertion fails).

**Step 3.6** — Full gate: `npm test && npm run typecheck && npm run build`.
**Step 3.7** — Commit: `feat(server): poller resolveIcon opt + buildApp FAA wiring; integration icon assertions`

---

## Task 4: SVG assets (13) + `icon-urls.ts` + registry test

**Files:**
- Create: 13 files in `src/assets/icons/` (contents below)
- Delete: `src/assets/icons/commercial.svg`, `business.svg`, `military.svg`, `general.svg`
- Rewrite: `src/map/icon-urls.ts`
- Rewrite: `test/icons.test.ts`

**Step 4.1 — Failing registry test.** Rewrite `test/icons.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { ICON_URLS, ICON_NAMES } from "../src/map/icon-urls.js";
import { SEA_KINDS, KINDS, KIND_FALLBACK_ICON } from "../shared/craft.js";
import { AIR_FAMILY_ICONS } from "../server/icons.js";

describe("icon registry", () => {
  it("has exactly one icon per air family (13) + sea kind (10) = 23", () => {
    expect(ICON_NAMES).toHaveLength(23);
    for (const name of [...AIR_FAMILY_ICONS, ...SEA_KINDS]) {
      expect(ICON_NAMES, `missing icon for ${name}`).toContain(name);
      expect(typeof ICON_URLS[name], `url for ${name}`).toBe("string");
      expect(ICON_URLS[name].length, `url for ${name}`).toBeGreaterThan(0);
    }
  });

  it("no image-name collision between air families and sea kinds", () => {
    const sea = new Set<string>(SEA_KINDS);
    for (const fam of AIR_FAMILY_ICONS) {
      expect(sea.has(fam), `${fam} collides with a sea kind`).toBe(false);
    }
  });

  it("every KIND_FALLBACK_ICON value is a registered image", () => {
    for (const v of Object.values(KIND_FALLBACK_ICON)) {
      expect(ICON_NAMES, `fallback ${v} not registered`).toContain(v);
    }
  });

  it("every KINDS[k].icon is a registered image (air entries use fallback families)", () => {
    for (const k of Object.keys(KINDS) as (keyof typeof KINDS)[]) {
      expect(ICON_NAMES, `KINDS[${k}].icon not registered`).toContain(KINDS[k].icon);
    }
  });

  it("old air-kind icon names are gone", () => {
    for (const old of ["commercial", "business", "military", "general"]) {
      expect(ICON_NAMES).not.toContain(old);
    }
  });
});
```

Run: `npx vitest run test/icons.test.ts`
Expect: FAIL — the old `icon-urls.ts` has 14 kind-named entries.

**Step 4.2 — Create the 13 SVGs.** Each is one `<path>` (multiple subpaths
in `d` where discs/ticks need them), 24×24, nose up. These are initial
drawings — the user tunes shapes in browser (Step 4.6); names/registry are
final.

`src/assets/icons/narrowbody.svg`:

```svg
<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24"><path fill="#4fc3f7" d="M12 1.8c.9 0 1.4.8 1.4 2v3.6l6.8 5.2v1.8l-6.8-2.3v4.2l2.5 1.9v1.6L12 19.2l-3.9 2.6v-1.6l2.5-1.9v-4.2l-6.8 2.3v-1.8l6.8-5.2v-3.6c0-1.2.5-2 1.4-2z"/></svg>
```

`src/assets/icons/widebody.svg` (thick fuselage + four engine ticks):

```svg
<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24"><path fill="#4fc3f7" d="M12 1.5c1.2 0 1.9 1 1.9 2.5v3.4l7.2 5.4v2l-7.2-2.5v4.4l2.9 2v1.6L12 19.4l-4.8 2.9v-1.6l2.9-2v-4.4L2.9 14.8v-2l7.2-5.4V4c0-1.5.7-2.5 1.9-2.5zM6.6 10.4h1.3v2.2H6.6zM16.1 10.4h1.3v2.2h-1.3zM9.3 11.4h1.3v2.2H9.3zM13.4 11.4h1.3v2.2h-1.3z"/></svg>
```

`src/assets/icons/turboprop.svg` (straight high wing + two prop discs):

```svg
<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24"><path fill="#4fc3f7" d="M12 2c.8 0 1.3.7 1.3 1.8v3l7.2 5v1.6l-7.2-2.3v4.9l2.5 1.8v1.5L12 18.7l-3.8 2v-1.5l2.5-1.8v-4.9l-7.2 2.3V11.8l7.2-5v-3c0-1.1.5-1.8 1.3-1.8zM7.6 8.5c.8 0 1.3 1 1.3 2.3s-.5 2.3-1.3 2.3-1.3-1-1.3-2.3.5-2.3 1.3-2.3zM16.4 8.5c.8 0 1.3 1 1.3 2.3s-.5 2.3-1.3 2.3-1.3-1-1.3-2.3.5-2.3 1.3-2.3z"/></svg>
```

`src/assets/icons/bizjet.svg` (slim, long nose, small wings):

```svg
<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24"><path fill="#81d4fa" d="M12 1.5c.6 0 1 .6 1 1.5l-.1 3.6 5.4 4.6v1.3l-5.4-1.8v3.7l1.9 1.5v1.3L12 18.9l-2.8 1.8v-1.3l1.9-1.5v-3.7l-5.4 1.8v-1.3l5.4-4.6-.1-3.6c0-.9.4-1.5 1-1.5z"/></svg>
```

`src/assets/icons/bizheli.svg` (rotor disc + fuselage + boom + tail tick):

```svg
<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24"><path fill="#81d4fa" d="M12 3.2c3.2 0 5.8 2.6 5.8 5.8s-2.6 5.8-5.8 5.8-5.8-2.6-5.8-5.8 2.6-5.8 5.8-5.8zM12 7.2c1 0 1.8 1.6 1.8 3.6s-.8 3.6-1.8 3.6-1.8-1.6-1.8-3.6.8-3.6 1.8-3.6zM11.4 13.6h1.2l.5 5.6h-2.2zM10.4 19h3.2v1.1h-3.2z"/></svg>
```

`src/assets/icons/piston.svg` (prop tick + high-wing bar + fuselage/tail):

```svg
<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24"><path fill="#90a4ae" d="M11.5 1.5h1v6h-1zM3.2 6.8h17.6l-3 2.2H6.2zM12 7.5c.8 0 1.3 1 1.3 2.3v4.9l1.5 1.6v1.3L12 16.1l-2.8 1.5v-1.3l1.5-1.6v-4.9c0-1.3.5-2.3 1.3-2.3z"/></svg>
```

`src/assets/icons/heli.svg` (smaller rotor disc, light heli):

```svg
<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24"><path fill="#90a4ae" d="M12 4.2c2.6 0 4.7 2.1 4.7 4.7s-2.1 4.7-4.7 4.7-4.7-2.1-4.7-4.7 2.1-4.7 4.7-4.7zM12 7.6c.8 0 1.5 1.3 1.5 3s-.7 3-1.5 3-1.5-1.3-1.5-3 .7-3 1.5-3zM11.6 13h.8l.4 5.4h-1.6zM10.8 18.4h2.4v1h-2.4z"/></svg>
```

`src/assets/icons/fighter.svg` (delta wing, pointed nose, fin tick):

```svg
<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24"><path fill="#ef5350" d="M12 1.4l1.1 7.2 1.2 8.9-2.3 1.6-2.3-1.6 1.2-8.9zM11.3 8.2 3.4 17l7.9-1.4zM12.7 8.2l7.9 8.8-7.9-1.4zM11.6 17.8h.8v2.8h-.8z"/></svg>
```

`src/assets/icons/attack.svg` (straight trapezoid wings, stubs, twin fins):

```svg
<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24"><path fill="#ef5350" d="M12 1.8c.8 0 1.3.8 1.3 2v9.4l1.5 1.4v1.6L12 15.5l-2.8 1.7v-1.6l1.5-1.4V3.8c0-1.2.5-2 1.3-2zM11.3 7.2 2.8 10.3v1.9l8.5-2.4zM12.7 7.2l8.5 3.1v1.9l-8.5-2.4zM7.8 11.8h3.2v1.6H7.8zM13 11.8h3.2v1.6H13zM10 13.5v3.2h.9v-3.2zM13.1 13.5v3.2h.9v-3.2z"/></svg>
```

`src/assets/icons/transport.svg` (boxy fuselage, high wing, four prop ticks):

```svg
<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24"><path fill="#ef5350" d="M9.8 3.4h4.4v11.2l2 2.2v1.6L12 20l-4.2-1.6v-1.6l2-2.2zM3 8h18l-3.6 2.6H6.6zM6.2 7h1v2.6h-1zM9.4 7.8h1v2.6h-1zM13.6 7.8h1v2.6h-1zM16.8 7h1v2.6h-1z"/></svg>
```

`src/assets/icons/tanker_air.svg` (widebody + belly refueling boom — named
`tanker_air` to avoid colliding with the sea `tanker` image):

```svg
<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24"><path fill="#ef5350" d="M12 1.5c1.2 0 1.9 1 1.9 2.5v3.4l7.2 5.4v2l-7.2-2.5v4.4l2.9 2v1.6L12 19.4l-4.8 2.9v-1.6l2.9-2v-4.4L2.9 14.8v-2l7.2-5.4V4c0-1.5.7-2.5 1.9-2.5zM6.6 10.4h1.3v2.2H6.6zM16.1 10.4h1.3v2.2h-1.3zM11.6 15.6h.8l.4 6.2h-1.6z"/></svg>
```

`src/assets/icons/isr.svg` (slender fuselage + E-3 rotodome bulge + mid wings):

```svg
<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24"><path fill="#ef5350" d="M12 1.6c.9 0 1.4.8 1.4 2v2.46a2.9 2.9 0 0 1 0 5.08v6.66l2.6 2v1.4L12 19.8l-4 1.4v-1.4l2.6-2v-6.66a2.9 2.9 0 0 1 0-5.08V3.6c0-1.2.5-2 1.4-2zM10.6 12.4 4.2 15.6v1.4l6.4-1.6zM13.4 12.4l6.4 3.2v1.4l-6.4-1.6z"/></svg>
```

`src/assets/icons/milheli.svg` (heavy rotor disc, thick fuselage/boom, tail rotor):

```svg
<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24"><path fill="#ef5350" d="M12 2.8c3.1 0 5.6 2.5 5.6 5.6s-2.5 5.6-5.6 5.6-5.6-2.5-5.6-5.6 2.5-5.6 5.6-5.6zM10.9 6.6h2.2l.6 5.8c0 1.6-.6 2.8-1.7 2.8s-1.7-1.2-1.7-2.8zM11.4 14.6h1.2l.6 5.2h-2.4zM9.8 19.8h4.4v1.1H9.8z"/></svg>
```

**Step 4.3 — Delete the 4 old air SVGs:**

```sh
git rm src/assets/icons/commercial.svg src/assets/icons/business.svg src/assets/icons/military.svg src/assets/icons/general.svg
```

**Step 4.4 — Rewrite `src/map/icon-urls.ts`:**

```ts
import narrowbody from "../assets/icons/narrowbody.svg";
import widebody from "../assets/icons/widebody.svg";
import turboprop from "../assets/icons/turboprop.svg";
import bizjet from "../assets/icons/bizjet.svg";
import bizheli from "../assets/icons/bizheli.svg";
import piston from "../assets/icons/piston.svg";
import heli from "../assets/icons/heli.svg";
import fighter from "../assets/icons/fighter.svg";
import attack from "../assets/icons/attack.svg";
import transport from "../assets/icons/transport.svg";
import tanker_air from "../assets/icons/tanker_air.svg";
import isr from "../assets/icons/isr.svg";
import milheli from "../assets/icons/milheli.svg";
import cargo from "../assets/icons/cargo.svg";
import tanker from "../assets/icons/tanker.svg";
import passenger from "../assets/icons/passenger.svg";
import military_vessel from "../assets/icons/military_vessel.svg";
import fishing from "../assets/icons/fishing.svg";
import sailing from "../assets/icons/sailing.svg";
import pleasure from "../assets/icons/pleasure.svg";
import tug_work from "../assets/icons/tug_work.svg";
import service from "../assets/icons/service.svg";
import other from "../assets/icons/other.svg";

export const ICON_URLS: Record<string, string> = {
  narrowbody,
  widebody,
  turboprop,
  bizjet,
  bizheli,
  piston,
  heli,
  fighter,
  attack,
  transport,
  tanker_air,
  isr,
  milheli,
  cargo,
  tanker,
  passenger,
  military_vessel,
  fishing,
  sailing,
  pleasure,
  tug_work,
  service,
  other,
};

export const ICON_NAMES: string[] = Object.keys(ICON_URLS);
```

**Step 4.5** — Run `npx vitest run test/icons.test.ts` → PASS.
**Step 4.6** — Full gate: `npm test && npm run typecheck && npm run build`
(the build compiles all 23 SVG imports; `registerIcons` in
`src/map/icons.ts` is generic over `ICON_URLS` — no change needed there).
**Step 4.7** — Commit: `feat(icons): 13 shape-family aircraft SVGs; delete 4 old air icons; registry test`

---

## Task 5: Client — `icon` feature property + `icon-image` layer

**Files:**
- Modify: `src/data/features.ts`
- Modify: `src/map/layers.ts`
- Modify: `test/features.test.ts`

**Step 5.1 — Failing test.** In `test/features.test.ts`, add the import:

```ts
import { KIND_FALLBACK_ICON } from "../shared/craft.js";
```

and a new describe block at the end of the file:

```ts
describe("icon property", () => {
  it("uses the server-set icon when present", () => {
    const fc = buildFeatureCollection([air({ icon: "widebody" }), sea({ icon: "passenger" })]);
    expect(fc.features[0].properties.icon).toBe("widebody");
    expect(fc.features[1].properties.icon).toBe("passenger");
  });

  it("falls back per kind when icon is absent (air → family, sea → kind)", () => {
    const fc = buildFeatureCollection([air(), air({ kind: "business" }), sea({ kind: "sailing" })]);
    expect(fc.features[0].properties.icon).toBe(KIND_FALLBACK_ICON.commercial); // "narrowbody"
    expect(fc.features[1].properties.icon).toBe(KIND_FALLBACK_ICON.business); // "bizjet"
    expect(fc.features[2].properties.icon).toBe("sailing");
  });
});
```

Run: `npx vitest run test/features.test.ts`
Expect: FAIL — `properties.icon` is undefined / type error.

**Step 5.2 — Implement.** In `src/data/features.ts`:

(a) Replace the import (line 1):

```ts
import { KIND_FALLBACK_ICON, type AirKind, type Craft } from "../../shared/craft.js";
```

(b) In the `CraftFeature` interface, after `kind: string;`, add:

```ts
    icon: string;
```

(c) In `toFeature`, in the `properties` object after `kind: c.kind,`, add:

```ts
      icon: c.icon ?? (c.domain === "air" ? KIND_FALLBACK_ICON[c.kind as AirKind] : c.kind),
```

(The `as AirKind` is refinement #2 — the domain check is the runtime guard.)

In `src/map/layers.ts`, in the `craft-icons` layer layout (line 18):

```ts
        "icon-image": ["get", "icon"],
```

(replacing `"icon-image": ["get", "kind"],`).

**Step 5.3** — Run `npx vitest run test/features.test.ts` → PASS.
**Step 5.4** — Full gate: `npm test && npm run typecheck && npm run build`.
`test/style-validation.test.ts` is untouched and still validates the craft
layers — `["get", "icon"]` is expression-valid; a failure here would mean the
layer change broke style validation.
**Step 5.5** — Commit: `feat(client): icon feature property (server icon ?? kind fallback); icon-image from icon`

---

## Task 6: Docs + final gate + push + handoff

**Files:**
- Modify: `AGENTS.md`

**Step 6.1 — AGENTS.md.**

(a) "What this is" paragraph: after "click-to-open detail panel (FAA
type/year/owner for US-registered aircraft)", append "model-driven aircraft
shape-family icons (see Aircraft icons below)".

(b) In "Architecture at a glance":
- `shared/craft.ts` bullet: append `Craft.icon?` (MapLibre image name),
  `AirKind`, `KIND_FALLBACK_ICON`.
- `server/` list: add after the `faa-lookup.ts` entry:
  `icons.ts` (resolveAirIcon: military callsign table → FAA model table →
  kind fallback; 13 shape families).
- `src/` list: change the `icon-urls.ts` description to "13 air family +
  10 sea SVG imports = 23 entries".

(c) Add a new section after the "MapLibre GL JS v4 (gotchas…)" section:

```md
### Aircraft icons (`server/icons.ts`)

13 shape-family air icons (24×24 top-down nose-up SVGs in
`src/assets/icons/`), colored by family: narrowbody/widebody/turboprop
`#4fc3f7`, bizjet/bizheli `#81d4fa`, piston/heli `#90a4ae`,
fighter/attack/transport/tanker_air/isr/milheli `#ef5350`. Color follows the
shape family, NOT the kind (a business-kind C172 renders the gray `piston`
silhouette). Sea icons are 1:1 with kind and unchanged.

Resolution order in `resolveAirIcon({ kind, callsign, faaModel, faaMfr })`:
military kind → callsign token table (word-anchored; `KC135` → tanker_air
before transport; `E3`/`P3`/`U2` are prefix matches; squadrons like EAGLE
fall back to `fighter`); civil → ordered FAA model table (normalize:
uppercase, strip spaces/hyphens; `{ mfr?: string[], re, icon }` rules, helis
first); then `KIND_FALLBACK_ICON`. Real-data traps the table encodes: Cessna
numbers have no C prefix (`172S`, `208B`); `F28F` is Fokker jet vs Enstrom
28F heli (mfr decides); `S`-prefix needs mfr (SIKORSKY heli / SAAB turboprop
/ RANS ultralight); `FALCON` needs DASSAULT mfr (FALCONAR is an ultralight);
`B350` King Air (turboprop) vs `B35` Bonanza (piston); `K120` but not
`K1200`. Image name `tanker_air` (not `tanker`) avoids colliding with the
sea tanker kind — the registry test asserts no air/sea name collision.

Server sets `Craft.icon` post-normalization (poller `resolveIcon` opt wired
to `FaaProvider.lookup` in `buildApp`); AIS sets no icon. Client:
`features.ts` property `icon: c.icon ?? (air ? KIND_FALLBACK_ICON[kind] :
kind)`; `layers.ts` `"icon-image": ["get", "icon"]`. SVGs are browser-
verified only (no canvas in unit tests) — tune paths in
`src/assets/icons/` and re-run the gate; names are the contract.
```

(d) WS protocol paragraph: after the `snapshot`/`update` frame descriptions,
note that craft objects carry an optional `icon` (air shape family / sea
kind / absent pre-icon snapshots).

(e) Test counts line: run `npx vitest run 2>&1 | tail -3`, read the actual
file/test totals (expected: 22 files — was 20, +`shared-craft.test.ts`,
+`air-icons.test.ts`), and update the "20 files, 128 tests" numbers with the
real values.

**Step 6.2** — Full gate: `npm test && npm run typecheck && npm run build`.
**Step 6.3** — Commit: `docs: AGENTS.md — model-driven aircraft icons (resolver, tables, traps)`
**Step 6.4** — Push: `git push origin main`. If `Permission denied
(publickey)`: ask the user to run `ssh-add ~/.ssh/id_rsa`, then retry.
**Step 6.5** — Handoff to the user (browser verification — the only visual
path): run `npm run dev`; on the map, check aircraft across kinds:
US civil aircraft should show model-driven families (737 → narrowbody,
C172 → piston, Cessna 208 → turboprop, Gulfstream → bizjet), non-US aircraft
kind fallbacks, military callsigns (KC130/KC135 → tanker_air, C130 →
transport, F16 → fighter); vessels unchanged. Expect a shape-tuning round —
adjust the SVG `d` paths in `src/assets/icons/`, re-run the gate, commit.
