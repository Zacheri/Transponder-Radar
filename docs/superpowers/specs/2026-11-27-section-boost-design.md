# Section boost + tunable auto hot-zones — design (2026-11-27)

Origin: user wants algorithmic high-frequency tracking (esp. military) with
settings control, AND user-drawn sections to become real boost targets with
per-section kinds + rate + live credit accounting ("data-loving maximalist").

Approved rulings (user): activation gating is the credit loophole (a skipped
poll is the only cheap poll — OpenSky bills by AREA, contents are never
filterable and never cheaper); sections and auto zones **coexist by default**
(stand-down dial, default 0 = never); every zone shows estimated AND actual
credits.

## A. Shared credit law (`shared/credits.ts`, new, pure, both sides)

`statesCallCost(wDeg, hDeg): 1|2|3|4` — OpenSky /states table:
area ≤25 → 1, ≤100 → 2, ≤400 → 3, else 4. `creditsPerDay(w,h,intervalMs)`
estimate helper. Tests pin the tier edges. Server imports it (replaces the
globe-only `GLOBE_CALL_COST=4` constant usages that stay for the globe call
itself, which this now derives as >400 → 4).

## B. Engine (server/hotzones.ts)

- `planZones(members, nowMs, prev, opts?: { createMin?: number })` — the
  hardcoded `count < 2` create rule becomes `createMin` (clamp 2–10,
  default 2). Everything else (slots, drift, TTL, ≤2 zones, 1-credit caps)
  unchanged — auto zones stay cost-1 by construction.
- Manual zones do NOT flow through planZones (no hysteresis/slots — the user
  drew the box; it is the box). New pure helper `sectionActivity(section,
  members): { active: boolean; count: number }` — any member with
  `kind ∈ section.kinds` inside the rect.
- `ZonePlan` assembly (pure, in hotzones.ts): given auto zones + section
  configs + members + standdown rule, emit ordered `PolledZone[]`:
  `{ id: string; box; cost: statesCallCost(...); due-by interval; source:
  "section"|"auto"; kind }`. Order: sections (stable id order) then auto
  (slot order). Standdown rule: `auto.enabled && (standdownAt === 0 ||
  boostedSectionCount < standdownAt)` gates whether auto zones appear at all
  — `boostedSectionCount` = wire sections (enabled boost only; plain
  highlights never affect the auto engine).

## C. Poller (server/opensky.ts)

- `ZonesConfig` v2: `{ kinds; boostMs; auto: { enabled; createMin;
  standdownAt }; sections: ZoneSection[] }` where `ZoneSection = { id;
  kinds: AirKind[]; boostMs; b: RegionBox; enabled }`. `setZonesConfig`
  reconciles: auto-relevant change (kinds/boostMs/auto) resets `zoneState`
  + auto runs (old sledgehammer, scoped); **section edits never touch auto
  state** — section runs live in a `Map<id, ZoneRun>` reconciled by id
  (removed ids dropped; per-run 429 pause survives unrelated edits).
- Funding loop (pollZoneOnce) becomes cost-aware: budget = surplus credits;
  iterate PolledZone order; a zone is due per its own interval; skip (not
  pause) when `budget < cost`; `budget -= cost` on send; success adds `cost`
  to `zoneCreditsToday` (UTC-day counter, memory-only — restart resets,
  documented); a zone 429 pauses only that zone (existing rule), cost of the
  failed call was NOT consumed by OpenSky (429 = no credit spent).
- `zoneIntervalFor` stretch applies ONLY to auto zones (they're the
  self-budgeting citizens); manual zones poll at the user's chosen interval
  or not at all (skipped by budget) — pause-first rule stands for the
  aggregate status but a skipped-but-due section keeps its timer, so it
  resumes when budget returns.
- Idle sections (activation gate false) are not polled, cost 0, and don't
  count toward due/skip bookkeeping.
- `feedStatus.boost` v2: `{ active, count, intervalMs, paused:
  "credits"|"standdown"|null, zones, sectionsActive, sectionsIdle,
  creditsToday }` (legacy fields keep semantics: count = craft across live
  polled zones incl. active sections; intervalMs = auto cadence or null).

## D. Wire (four mirrors as usual)

- `zones.config` v2 (full replace, old-shape-tolerant): new optional fields
  `auto` + `sections` (≤6; each section id non-empty string, kinds ⊆
  AIR_KINDS, boostMs finite, b = valid box — any bad member drops the whole
  frame, matching existing validator style). Old client ⇒ server defaults
  `{ enabled: true, createMin: 2, standdownAt: 0, sections: [] }` = today.
- `status.hotzones[]` gains optional `id?: string` and `manual?: boolean`
  (auto elements unchanged). **Manual zones ship ONLY while active** —
  the array means "being polled right now"; clients render active sections
  with a brighter tint. Legacy clients keep working (extra fields ignored).

## E. Client

- `radar.regions` Region gains optional `boost?: { enabled: boolean; kinds:
  AirKind[]; boostMs: number }` — **fix the parseRegions round-trip drop**
  (survey hazard 3): parse/serialize must preserve it (validated only when
  present; absent = boost-off default). AIS-kind sections: boost controls
  hidden entirely (AIS is push — no poll to fund; spec-literal: only
  "ADS-B area" sections can boost; AIS boost stays backlog).
- `radar.zonesCfg` v2 parse: existing fields + `auto { enabled, createMin
  (2–10, default 2), standdownAt (0|1|2, default 0) }`; corrupt → full
  defaults as today.
- main.ts: one `buildZonesConfig(regions, zonesCfg)` pure helper (tested):
  sections = enabled ADS-B boosted regions' `boost` + box. Sent on every
  change + on every socket open (existing lifecycle).
- Status: hotzones manual-active ids drive section-row live state
  (row shows `active · polling` / `idle` / `paused`) and a brighter section
  outline (feature property on region layers by id-set from status —
  client-side cosmetic, never inferred).

## F. UI

- Settings new group **"Traffic boost"** (above Map sections):
  - Auto: enable checkbox; "Form when ≥ N" slider 2–10; auto-rate slider
    10–120 s (MOVED from filters drawer — filters keeps the air-kind
    checkboxes as the auto tracker selectors; one-line drawer-group
    comment points here); stand-down `<select>`: "never" / "after 1
    boosted section" / "after 2".
  - Each ADS-B section row gets an expand chevron (stopPropagation vs
    remove-row click): enable checkbox, air-kind checkboxes (activation
    set), rate slider, and the money readout: `~X cr/day` (from
    shared/credits estimate) + live `active/idle` + `Y cr today` (from
    status when the row's id is in hotzones).
- HUD boost line: ` · Boost: 2 sec · 1 auto · 143 cr` (compact); paused
  variants keep the tooltip idiom; `paused:"standdown"` renders
  ` · Boost: sections only`.
- Filters drawer: boost section loses the slider; All/None scoping stays
  (checkboxes keep `data-zkind`, never `data-kind`).

## G. Failure modes

No sections + defaults ⇒ byte-identical wave-7/10 behavior. Server old,
client new: unknown fields ignored → auto-only (no crash — hub validator
only checks defined fields). Client old, server new: v1 frames keep working.
Section budget starvation never touches globe (surplus math unchanged).
creditsToday is best-effort (memory-only; restart resets to 0 — documented
in AGENTS.md). AIS sections never appear in the wire sections[] (client
filters) — server would poll them pointlessly otherwise.

## H. Testing

Server: cost table (shared), createMin wiring, sectionActivity matrix,
ordering + cost-aware funding (section cost 3 starves later zones, skip vs
pause distinction), standdown gate, per-zone pause survives section edits,
auto state survives section-only edits (scoped sledgehammer), creditsToday
accumulates cost not 1, wire validator matrix (v1 shape, v2 good, v2 bad
member → whole-frame drop), hotzones manual-only-while-active. Client:
parseRegions boost round-trip (the hazard test), buildZonesConfig assembly,
zones-cfg v2 parse matrix, settings group rendering (auto controls +
expandable rows + credit readout), HUD new strings. Browser-verify: military
box → idle at quiet hours, poll resumes on entry (user-side, documented).

## I. Explicitly NOT in this wave

Walls (fill-extrusion) + offline tile cache (queued); AIS-section data
aiming (aiscast tile steering by sections) stays backlog; per-kind cost
reduction (impossible by credit law — documented, never silently promised);
persisting creditsToday across restarts.
