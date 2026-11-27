# Section boost implementation plan (2026-11-27)

Spec: `docs/superpowers/specs/2026-11-27-section-boost-design.md`.
Tasks 1 ∥ 3 (server-engine vs client-store), then 2 (poller+wire integration,
needs 1) ∥ 4 (UI, needs 3; wire shapes come from the spec). Full SDD
convention per task: brief → implementer → package → reviewer → live gate →
ledger with BASE.

## T1 — credit law + engine core (pure, server/shared only)
Files: shared/credits.ts (+test), server/hotzones.ts (+hotzones.test.ts).
- statesCallCost tiers (25/100/400 sq°), creditsPerDay; tests at tier edges.
- planZones opts { createMin } (clamp 2–10; default 2 pins old behavior).
- sectionActivity(section, members) pure.
- buildPollPlan({ autoZones, sections, members, auto, standdownAt }) →
  ordered PolledZone[] {id, box, cost, intervalMs, source, kind} — sections
  first (id-stable), standdown gate, costs via statesCallCost, idle sections
  ABSENT (activation gate), zoneIntervalFor still auto-only.
- Export the zone-credit table consumers so opensky.ts imports cost, never
  re-derives.

## T2 — poller + wire integration (needs T1)
Files: server/opensky.ts, server/hub.ts, server/index.ts, src/data/ws.ts,
tests (poller, hub, ws, integration).
- ZonesConfig v2 + scoped sledgehammer (auto-relevant change resets
  zoneState/auto runs; section edits reconcile Map<id,ZoneRun> only, pause
  survives unrelated edits; removed-id runs dropped before early return —
  wave-10 ordering rule).
- pollZoneOnce → buildPollPlan-driven cost-aware funding (skip vs pause
  distinction; 429 spends nothing; creditsToday += cost on success; UTC roll
  resets; idle sections never consume; budget skips when budget < cost and
  timer keeps the zone due).
- BoostStatus v2 fields + hotzones[] id/manual (manual only while active)
  through all four mirrors; hub validator matrix (v1 tolerant, v2 strict).

## T3 — client store + config assembly (parallel with T1)
Files: src/data/regions.ts, src/ui/zones-cfg.ts, new src/data/
zones-assembly.ts (pure buildZonesConfig), src/main.ts (sender only),
tests (regions, zones-cfg, zones-assembly).
- Region.boost optional {enabled, kinds, boostMs} + parseRegions round-trip
  PRESERVATION (hazard test: old rows parse, boost survives serialize →
  parse).
- zones-cfg v2: auto {enabled, createMin 2–10, standdownAt 0|1|2} — v1
  storage upgrades to defaults.
- buildZonesConfig(regions, zonesCfg): enabled ADS-B boost sections only,
  ≤6, canonical order.

## T4 — surfaces (needs T3; T2 status shapes per spec)
Files: src/ui/settings.ts, src/ui/filters.ts, src/ui/hud.ts, src/main.ts
(status consumer + wiring), src/style.css, tests (settings-drawer, hud,
filters).
- "Traffic boost" group (auto enable, Form ≥ N, auto-rate slider MOVED from
  filters, stand-down select per timeline.ts select idiom).
- Section row expand chevron (stopPropagation vs remove-click), per-section
  enable + activation kinds (never data-kind) + rate + `~X cr/day` +
  live active/idle + `Y cr today`.
- HUD ` · Boost: 2 sec · 1 auto · 143 cr` + `sections only` + paused
  tooltips; filters boost section loses slider (comment pointer).
- main: hotzones manual ids → section live state + brighter outline property;
  buildZonesConfig feeds every sendZonesConfig.

## Rulings
- Activation gating = the ONLY credit loophole (area billing law, memory
  #49); never promise per-kind discounts.
- AIS sections never boost (push feed); never in wire sections[].
- Stand-down counts boost-ENABLED sections only; default 0 = coexist.
- creditsToday memory-only (restart reset documented, not a bug).
- Auto zones stay cost-1 by construction (5°×5° cap untouched).
