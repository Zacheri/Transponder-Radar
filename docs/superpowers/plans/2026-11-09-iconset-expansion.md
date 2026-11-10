# Plan — iconset expansion (second wave)

Spec: `../specs/2026-11-09-iconset-expansion-design.md`. TDD throughout; gate
after every task: `npm test` → `npm run typecheck` → `npm run build`.
Resolver tests go in `test/icons.test.ts` (follow the existing
`resolveAirIcon`/token patterns; assert the emitted icon name).

## Phase A — table fixes (no downloads)

- **T1 E-3 wiring** — `server/icon-tables.ts`: token rule `E3` →
  `pack: "rk:E3TF"` (was absent `pd:E3`); fix the stale comment.
  Test: `{ kind: "military", callsign: "E3" }` → `rk:E3TF`; also a
  word-anchored check that `E33`-style callsigns don't match (token table is
  word-anchored — verify existing anchor behavior). Coverage-lock test:
  `E3` moves out of the open list (`test/icons-catalog.test.ts`).
- **T2 Bombardier** — `^BD100` (mfr BOMBARDIER) NEW → `pw:GLEX`
  narrowbody (family-level note: generic Global silhouette); `^BD7002` and
  `^BD700` → drop `pack` (family). Tests: BD-100-1A10 code → `pw:GLEX`;
  BD-700-1A10 / BD-700-2A12 → `narrowbody` (family name, not a pack name).
- **T3 Cessna prefixes + mfr guards** — 172: `^[A-Z]{0,2}172` (mfr already
  CESSNA/TEXTRON); 182: `^[A-Z]{0,2}182` + mfr CESSNA/TEXTRON (NEW);
  206: `^[A-Z]{0,2}206` + mfr CESSNA/TEXTRON (NEW); 210: `^[A-Z]{0,2}210`
  + mfr CESSNA/TEXTRON (NEW); CESSNA catch: `^[A-Z]{0,2}[1-7]\d\d(?!\d)`.
  Tests: R182/T206/U206D/P210N/F172G → their arts; BELL "206" → `pw:B06`
  (heli rule still wins — order preserved); "A210322" (Airbus) → NOT the
  Cessna 210 art.
- **T4 Bonanza/Baron** — A36 rule mfr += BEECHCRAFT, RAYTHEON; NEW
  `^[A-Z]?35` (mfr BEECH/BEECHCRAFT) family piston; NEW `^[A-Z]?33`
  (mfr BEECH/BEECHCRAFT) family piston; NEW Baron `^[A-Z]?5(5|8)([A-Z0-9-].*)?`
  — careful: normalized `95B55` must match (Baron 55 codes are "95-B55"),
  and `^[A-Z]?5(5|8)` on BARE "55"/"58"/"58P" too. Tests: V35A, S35, P35,
  F33A, 35B33 → piston family (art pending); 95B55, 58P → piston family;
  RAYTHEON A36 → `pw:BE36`; NORTH AMERICAN A36A → NOT `pw:BE36`.
- **T5 Bell 407** — mfr BELL: `^B?(407|429)` + keep `^B(52|76)` (one rule
  or split per existing style). Tests: "407" (BELL) → bizheli family
  (art pending B407 curation); "B407" same; "525" unchanged.
- **T6 Gulfstream** — mfr list += IAI; NEW `^GIV`, `^GVII`, `^GVIII`,
  `^GVSP`, `^G450`, `^G(500|550|600|700)` (mfr GULFSTREAM/IAI) → `pw:GLEX`
  bizjet (family-level note). Existing `^G(150|280|550|650)` rule: G280/
  G550 will gain dedicated art in Phase B — for now `^G280`/`^G550` may
  stay on the existing rule. Order: specific before catch. Tests: G-IV,
  GVSP(G550) normalized `GVSP(G550)` → `pw:GLEX`; GVII(G500) → `pw:GLEX`;
  IAI G280 → (existing rule) family/bizjet.
- **T7 Misc wiring** — An-12 (`^AN12`, mfr-agnostic like the ATR catch;
  verify registry mfr spelling) → `pw:AN12`; An-28 → `pw:AN28`; visually
  verify `pw:CT4` and `pw:HAWK` before any wiring (veto + OmittedModels if
  the art isn't what the name implies); skip non-US types (CT4, AJ27, AS50,
  AS55, DHC5, SW3, SW4, H25A, A124 — none in US ACFTREF per research).
- **T8 Phase-A docs** — coverage-lock test final state; `OmittedModels.md`
  entries (BD-700 family-only with the wrong-art note, Bonanza 33/35
  pending art, Baron pending art, Bell 407 pending art, G280/G550/G-IV
  pending art — "art pending curation" entries get superseded in Phase B);
  AGENTS.md gap status note.

## Phase B — pd: curation (fleet priority, stop at marginal quality)

Per target (spec §Phase B loop): search → visual inspect (qlmanage /
svgzoom) → license → download → sha256 → manifest entry (name, title,
file, license, attribution, sha, crop) → table rule + test → index rebuild
→ catalog eyeball. Order: TBM700, Bell 407, Challenger 300, G280, G550,
G-IV/G450, Learjet 45, Bonanza, Baron, Cessna 310, Cessna 185, Piper J3,
Aeronca 7GC, Stinson 108, Mooney M20, Grumman AA-5, Air Tractor 502, SF50,
AS350, Seneca 680, Luscombe 8, Taylorcraft BC-12, Ercole 415.
Each failure → OmittedModels entry (code, rule, reason, searched, date).

## Phase C — docs + handoff

OmittedModels final; AGENTS gap status final; papertrail `2026Nov09-1.md`;
full gate; catalog eyeball handoff (USER runs the browser check).
