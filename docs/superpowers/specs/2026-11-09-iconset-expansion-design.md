# Iconset expansion — second curation wave (design)

- **Date:** 2026-11-09
- **Owner:** radar agent (long-term session)
- **Status:** draft (pending owner review)
- **Predecessor:** `2026-11-06-iconpack-gap-curation-design.md` (implemented 2026-11-07;
  plan `docs/superpowers/plans/2026-11-06-iconpack-gap-curation.md`)
- **Papertrail:** `ML_Docs/Radar/2026Nov06-1.md` (continued)

## Context / why

The 2026-11-06 wave closed the *documented* gaps. A registry-wide sweep of all
318,638 US registrations against the resolver tables (`faa-gaps3/4/5` scripts)
shows the remaining gap is **breadth, not depth**: 209,314 registrations
(58.7%) already resolve to specific art; the other 41.3% fall back to the
13 shape-family icons. The fallback population is dominated by light GA
types the tables never covered, plus several **wrong-art bugs** found during
the sweep.

This wave: (A) fix wrong/missing table wiring (no downloads), (B) curate new
`pd:` art for the highest-fleet unlinked types, (C) docs + gates. Same
policies as the 2026-11-06 wave: offline-first (sha-pinned, setup-only
downloads), PD-only where possible, no new npm packages, accuracy bar
(per-entry verification notes, catalog eyeball, wrong art → veto + record,
never shipped quietly), family icon for anything not freely/publicly
available, one `OmittedModels.md` entry per omitted variant.

## Findings that drive the scope

### Wrong-art bugs (accuracy — fixed in Phase A)

1. **E-3 AWACS art exists but is unwired.** `rk:E3CF` / `rk:E3TF`
   (E-3 Sentry, CFM/TF33 engine variants) are in the pack; both verified
   visually (707 top view + rotodome). The token rule points at the absent
   `pd:E3`, so every E-3 renders a bare `isr` family icon. Fix:
   `E3` token → `rk:E3TF` (TF33 = the historical/standard engine).
2. **Bombardier BD-700 rules serve Global Express art.**
   `^BD7002` → `rk:GL5T` (titled "Global Express 5000") and `^BD700` →
   `pw:GLEX` (a Global silhouette, verified visually). BD-700 codes are
   **Challenger 300/350** (661 ac: `BD-700-1A10` 374, `-1A11` 149, `-2A12` 138,
   plus 1 under BOMBARDIER AEROSPACE). BD-100 codes are the actual Global
   Express family (883 ac: G-IV 357, G-V 153, GV-SP(G550) 382, GVII(G500) 223,
   GVII(G600) 211, GVIII(G700) 130, G280 under IAI mfr 294) and have **no rule**
   → family fallback. Wrong art is worse than a family icon: BD-700 rules drop
   their `pack` (→ family), BD-100 gains a rule → `pw:GLEX` with a
   family-level note; specific art (Challenger 300, G280, G550) lands in
   Phase B with tests.

### Unlinked art already in the pack (wired in Phase A, no downloads)

- `pw:AN12`, `pw:AN28` (An-12/28 — rare US registrations; rules added anyway,
  closes documented gaps), `rk:AN12`/`rk:AN26` exist too — pick per registry.
- `pw:CT4` (Cirrus Citation? — title only, verify art before wiring; likely
  skip if not a US-registered type), `pw:HAWK` (verify before wiring),
  `rk:P28A` is already wired; `rk:J328` (Dornier 328 — `rk:D328` already
  wired; check `^328` vs `DO328` coverage).

### Fleet-ranked unlinked civil types (Phase B curation targets)

Registry counts are US-registered (ACFTREF-joined MASTER), 2026-11-09 sweep.
Priority = fleet × art sourceability × on-air likelihood:

| # | Type | Fleet | Art source pattern | Notes |
|---|------|-------|--------------------|-------|
| 1 | Mooney M20/R | 5,400 | vintage PD drawings | M20, M20R, M20J… |
| 2 | Bonanza V35/S35/P35/F33 | 3,697 | classic Bonanza plan views | A36 already has `pw:BE36` (verified) |
| 3 | Piper J3 Cub | 3,194 | vintage PD (J3C65 codes) | mfrs PIPER/PIPER-RHYNE/POKKI |
| 4 | Aeronca 7GC | 2,007 | vintage PD (20 codes) | |
| 5 | Cessna 185 | 1,295 | Cessna brochure | A185F codes |
| 6 | Stinson 108 | 1,097 | vintage PD (6 codes) | |
| 7 | Bellanca 7EC/17-30 | 1,230 | vintage PD | |
| 8 | Grumman AA-5 | 1,000 | vintage PD | |
| 9 | TBM 700 | 999 | Daher/press kit | SOCATA mfr |
| 10 | Bell 407 | 984 | Bell fact sheet (3-view) | bare "407" codes exist today |
| 11 | Baron 55/58 | 1,100 | vintage PD (95-B55 codes) | |
| 12 | Luscombe 8 | 1,220 | vintage PD | |
| 13 | Taylorcraft BC-12 | 1,013 | vintage PD | |
| 14 | Air Tractor 502 | 905 | AT-502 brochure | modern ag |
| 15 | Learjet 45 | 433 | Learjet brochure | L45 codes |
| 16 | Seneca 680 | 405 | Cessna brochure | 680A codes |
| 17 | Gulfstream G550 | 382 | G550 brochure | GV-SP(G550) codes |
| 18 | Gulfstream G-IV | 357 | G450/G-IV brochure | G450 art covers with note |
| 19 | Gulfstream G280 | 294 | IAI/G280 brochure | mfr IAI LTD |
| 20 | Cessna 310 | 234 | Cessna brochure | T310N/P/Q codes |
| 21 | AS350 Squirrel | 291 | Aérospatiale drawing | heli, light/bizheli |
| 22 | Cirrus SF50 | 774 | SF50 brochure | first SF50 jets |
| 23 | Ercole 415 | 1,080 | vintage PD | |

(Registry-verified mfr/model spellings per row were confirmed against
ACFTREF during research; the plan re-verifies each rule's mfr list against
raw rows before writing tests — memory #21: grep raw rows, don't trust
parsed columns.)

## Phases

### Phase A — table fixes, no downloads (TDD, resolver tests each)

1. **T1** E-3 wiring: `E3` token → `rk:E3TF`; fix the stale `pd:E3` comment;
   update the coverage-lock test (E3 leaves the open list).
2. **T2** Bombardier: `^BD100` → `pw:GLEX` (new, Global family note);
   `^BD7002`/`^BD700` drop `pack` → family (wrong-art fix, tests assert the
   family icon, not a pack name).
3. **T3** Cessna prefix extension (mfr-guarded): 172 `^[A-Z]{0,2}172`;
   182/206/210 `^[A-Z]{0,2}18x/20x/21x` **+ add mfr CESSNA/TEXTRON**
   (false-positive sweep: bare-`206` BELL/AGUSTA helis and `210` balloon/
   Airbus hits are excluded by the mfr guard); CESSNA catch
   `^[A-Z]{0,2}[1-7]\d\d(?!\d)`.
4. **T4** Bonanza A36 rule: add BEECHCRAFT + RAYTHEON to mfr (445 ac are
   registered under RAYTHEON AIRCRAFT COMPANY; NORTH AMERICAN A36A vintage
   stays excluded); new `^[A-Z]?35` and `^[A-Z]?33` Bonanza rules (art in
   Phase B, family until then); new Baron `^[A-Z]?5(5|8)` rule (family
   until art).
5. **T5** Bell: `^B?(407|429)` / `^B(52|76)` (mfr BELL) — bare "407" codes
   exist in the registry today; art in Phase B.
6. **T6** Gulfstream: mfr list += IAI; new prefix rules `^GIV`, `^GVII`,
   `^GVIII`, `^GVSP`, `^G450`, `^G(500|550|600|700)` → `pw:GLEX` family
   (prefix matches cover the parenthetical codes — `normalizeModel` strips
   only spaces/hyphens, so `GVII(G500)` matches `^GVII`); G280/G550 get
   dedicated art in Phase B.
7. **T7** Misc wiring: An-12/An-28 rules; verify `pw:CT4`/`pw:HAWK` art
   before wiring (veto + OmittedModels if wrong); any other verified
   unlinked art with US registry codes.
8. **T8** Coverage-lock test refresh + OmittedModels/AGENTS updates for
   everything Phase A moved.

Gate after each task: `npm test` → `typecheck` → `build`.

### Phase B — `pd:` curation (sourcing loop, same machinery as 2026-11-06)

For each target (priority order above; stop when marginal art quality or
sourceability drops — remaining targets go to OmittedModels, not forced):

1. Commons/press-kit search (the 2026-11-06 finding: Commons full-text
   search is unreliable — prefer the file-list + drawing-filter pattern, and
   the plan-view template pattern: dark lines on white, top view primary).
2. Inspect the candidate visually (rasterize local SVGs with `qlmanage`;
   `svgzoom.ts` for path-bbox zooms — both now in the opencode temp dir).
3. Verify license (PD / US Gov preferred; CC-BY with attribution acceptable
   per the manifest; anything else → skip).
4. Download → sha256 → `iconpack-sources.json` entry (name, title, file,
   license, attribution, sha, `crop` rectangle where needed) → table rule +
   resolver test.
5. `data/icons/` refresh (delete `index.json` + the file → server re-verify)
   or `npm run icons:setup`; catalog eyeball.

Rule wiring for types whose art lands: TBM700, Bell 407, Challenger 300
(replaces the family-only BD-700 rules), G280, G550, G-IV/G450, Learjet 45,
Bonanza (33/35), Baron (55/58), Cessna 310, Cessna 185, Piper J3, Aeronca
7GC, Stinson 108, Mooney M20, Grumman AA-5, Air Tractor 502, SF50, AS350,
Seneca 680, Luscombe 8, Taylorcraft, Ercole — as many as sourcing allows.

### Phase C — docs + handoff

- `OmittedModels.md`: one entry per type that stays family (FAA code, rule
  it lands on, reason, what was searched, date).
- `AGENTS.md` gap status refresh; coverage-lock test final state; papertrail
  `2026Nov09-1.md` (new, cave-man shorthand per AGENTS.md rule 18); final
  gate; catalog eyeball handoff (USER).

## Files touched

`server/icon-tables.ts`, `server/iconpack-sources.json`,
`test/icons.test.ts`, `test/air-icons.test.ts` (if art-level),
`test/icons-catalog.test.ts` (coverage lock), `AGENTS.md`,
`ML_Docs/Radar/OmittedModels.md`, spec/plan docs, papertrail.

## Not touched

Client pipeline (icons/pack-icons/features/filters — the color-picker work
lands independently and composes: color-keyed names work with any new base
name), `icons.ts` resolver logic, sea icons, the 13 family SVGs, `data/faa/`
(read-only research source).

## Accuracy bar (carried from 2026-11-06)

Per-entry verification note (real file, sha, crop); visual inspection of
every curated art before it is wired; wrong art → veto (`exclude.json`) +
OmittedModels entry, never shipped quietly; family icon always the fallback.
