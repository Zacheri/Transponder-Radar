# Icon Pack Gap Curation — Design

- **Status:** draft (pending owner review)
- **Date:** 2026-11-06
- **Follow-up to:** `docs/superpowers/specs/2026-10-13-vendored-aircraft-icon-pack-design.md`
  (implemented 2026-10-25). Supersedes nothing; extends the vendored pack.

## Goal

Push the aircraft icon pack to variant-level precision as far as freely and
publicly available art allows:

1. Fix the two pack references that point at art that was never curated in.
2. Wire existing pack art that has no resolver rule.
3. Curate new `pd:` gap-fill entries for types with no art in any source.
4. Document every model/sub-variant that stays on the family fallback, so a
   future agent can re-search for its art.

Owner requirement (2026-11-06): icons must be accurate, precise, and correct.
Types whose art is not freely and publicly available use the aircraft family
icon and are recorded in `OmittedModels.md`.

## Current state (verified 2026-11-06)

- Pack: 281 entries (`pw:` 96, `rk:` 182, `pd:` 3). Both pins sit at upstream
  HEAD (`pw` `338826d` 2026-09-28; `rk` `0743718` 2023-10-07) —
  `npm run icons:repin` gains zero new art.
- Two table references point at absent art: `pd:E3` (the E-3 Sentry / AWACS
  rule) and `pd:CH47` (two CH-47 rules). Emission is gated on pack membership,
  so both currently render as plain family icons.
- 117 pack entries have art but no resolver rule. Part of the documented
  "no-art" gap list in `server/icon-tables.ts` is stale — art exists for
  An-12/28, Fokker F-100, F-50, B-1, A330-700/800, the newer E-Jets
  (E190-E2/E290/E390), Agusta A140/A148/A158, Hawker, Il-62, Tu-204, Tornado,
  Lynx, T-38, PC-21, C-295, C-160, and derivative mappings (C-21/C-40 →
  737-700 art, VC-25 → 747-8 art, EP-3 → P-3 art, GRIFIN → RQ-4 art,
  KCTC → R135 art).
- No art in any source (needs new `pd:` curation): E-3, CH-47, B-2, F-14,
  F-117, E-4, CH-53, E-6 (TACAMO), MQ-9; civil MD-8x/9x, DC-9, Challenger
  600/850, ATR-72-200/212, L-410, King Air 200/300/360, Fokker F-70,
  737-600, 737 MAX 7.

## Requirements

**R1 — Scope.** Three work classes (per-type detail lives in the plan):

- **A — resolver rules for existing art** (`server/icon-tables.ts` only,
  ~25 candidate rules). Each candidate is checked against the entry `title`
  in `data/icons/index.json` before wiring; only titles that confirm the
  intended model get a rule.
- **B — new `pd:` curation** (`server/iconpack-sources.json` + table rules)
  for the no-art list, bounded by R2.
- **C — docs**: `OmittedModels.md` (R5), refresh the stale gap-list comment
  in `icon-tables.ts`, update AGENTS.md.

**R2 — Curation policy.** Art must be freely and publicly available: Public
Domain preferred; Creative Commons (BY/BY-SA) acceptable with per-file
license + attribution in the manifest (existing `pd:` schema). No
all-rights-reserved or unlicensed art. Form: clean top-down (plan-view)
silhouette — no photos, no 3/4 views. A type with no sourceable art keeps
the family fallback and is recorded per R5. No new art sources: the three
pinned sources plus the `pd:` file list remain the only sources
(offline-first, 2026-10-13 spec R10).

**R3 — Accuracy bar.** Every icon wired or curated must depict the correct
model/variant (engine count, wing shape, rotodisk/tail, distinguishing
features). Mechanism:

- manifest `title` = the exact model/variant name;
- the plan carries a per-entry verification note (what distinguishes the
  type, what was checked against the fetched file — dimensions, view,
  features);
- a `pd:` entry is added only after its file was fetched and inspected
  during planning (sha256 + `cropTopRatio` come from the real file, never
  estimated);
- the catalog page (`GET /icons/catalog`) is the eyeball handoff surface;
  wrong art is vetoed via `exclude.json` and recorded per R5 — never shipped
  quietly.

Ambiguous art (a drawing shared by two variants) wires to the nearest
confirmed variant; the unconfirmed remainder is recorded per R5.

**R4 — Fallback.** Unchanged: missing art, vetoed names, or pack failure →
the 13 family icons. Resolver logic (`server/icons.ts`), the client
pipeline, and sea icons are not modified by this work.

**R5 — OmittedModels.md.** New file at
`~/Documents/BCP/ML/ML_Docs/Radar/OmittedModels.md` (outside this repo —
never committed). One entry per model/sub-variant that remains on the family
fallback after this work, so a future agent can revisit it:

- model name in FAA code form (e.g. `737-7M2`) and human name;
- the resolver rule/catch it lands on and the fallback family;
- reason: no freely and publicly available plan-view art;
- what was searched (source + queries, best candidate found and why it was
  rejected, if any);
- date.

Created during execution; updated whenever a type ends unsourced.

**R6 — Not changed.** WS protocol, `/icons/*` routes, client
feature/layer pipeline, the 13 family SVGs, sea icons, and the iconpack
download/verify mechanism — new `pd:` entries ride the existing sha-pinned
setup download.

**R7 — Testing and gate.** TDD: a resolver test per new/changed rule
(`test/icons.test.ts`); the sources schema test covers every new `pd:`
entry (title/license/attribution non-empty, `cropTopRatio` in (0,1], 64-hex
sha256). The ~150 existing resolver tests pass unmodified. Gate after every
task: `npm test` → `npm run typecheck` → `npm run build`.

**R8 — Docs.** The catalog gap list and the AGENTS.md aircraft-icon sections
are updated to post-curation reality: wired types, curated `pd:` entries,
and the remaining gap list (= the `OmittedModels.md` list).

## Out of scope

- The per-category map color picker (separate bounded design, approved
  separately).
- New art sources or pipelines; upstream repin (verified zero gain);
  server-side icon colors; sea icon art.
- Modifying vendored source files on disk (2026-10-13 spec R3).

## Handoff (browser verification)

1. `npm run dev` → HUD `Icons:` count rises by the number of new `pd:`
   entries after setup.
2. `GET /icons/catalog` — eyeball every new/changed icon (the accuracy
   surface per R3).
3. Live map spot-check: the wired military list (AWACS/E-3, CH-47, B-1,
   Tornado, Lynx, …) and the civil gap list (MD-8x, Challenger 600,
   ATR-72-212, L-410, King Air 200/300, …).
4. `OmittedModels.md` complete for every variant that stayed on a family
   icon.
