# Timeline range windows + tiered retention — implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Compact history older than 48 h to 5-min resolution (pins exempt) and give the scrubber a client-side view window (presets + custom, default 14 d) that drives display and playback bounds.

**Architecture:** Server gains a pure `planCompaction()` planner + `compact()` applier in `HistoryRecorder`, scheduled hourly in `index.ts`. Client gains pure view-window math in `src/ui/format.ts`, a controls row in `timeline.ts`, and wiring in `main.ts` that persists the selection and feeds it to the scrubber and playback engine. No wire-protocol changes.

**Tech Stack:** TypeScript, Vitest (node env, fake timers), Fastify server, vanilla-DOM UI.

**Spec:** `docs/superpowers/specs/2026-11-21-timeline-range-retention-design.md`

## Global constraints

- No new npm packages. Comments minimal; never reference tickets/tasks in comments.
- Full gate after every task: `npm test` → `npm run typecheck` → `npm run build` (build must succeed; the maplibre >500 kB chunk warning is the accepted exception).
- Never touch `data/`; browser-only behavior is user-verified (spec R6).
- `HistoryRecorder` invariants hold: keep-newest on deletes; pinned snapshots never deleted; `evict()` untouched.

## Review Focus

1. A snapshot file deleted by compaction while a playback `window()` read is in flight → the window request completes, skipping the missing item (never throws). Task 2 pins it.
2. The view window changing while a playback cursor sits outside it → scrubber re-renders without crash, no phantom "live" state. Task 4 pins the no-crash half; Task 5's manual note covers playback.
3. Custom range picked with `from` after `to` → treated as the degenerate clamped window, no crash, no swap. Task 3 pins it.
4. `localStorage` holding valid JSON of the wrong shape (`ms: -5`, `from: "x"`) → restored as the default window. Task 3 pins it via `parseViewSel`.
5. A pin partially or fully outside the view window → rendered clamped to track edges and still removable in-view. Task 4 pins it.

---

### Task 1: Compaction constants + pure planner

**Files:**
- Modify: `shared/limits.ts`
- Modify: `server/history.ts` (export planner only)
- Test: `test/limits.test.ts`, `test/history.test.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces: `HISTORY_WINDOW_MS`, `FULL_RES_AGE_MS`, `COMPACT_STEP_MS` (ms numbers) from `shared/limits.js`;
  `planCompaction(index: { ts: number }[], now: number, pinned: (ts: number) => boolean, horizonMs?: number, stepMs?: number): number[]` from `server/history.js` (defaults = the two new constants).

- [ ] **Step 1: Write failing constant tests** in `test/limits.test.ts`: exact values `336 * 3600_000`, `48 * 3600_000`, `5 * 60_000`.
- [ ] **Step 2: Run** `npx vitest run test/limits.test.ts` — fail on missing exports.
- [ ] **Step 3: Add the three exports** to `shared/limits.ts` under a `// Tiered history retention.` comment (style matches the file).
- [ ] **Step 4: Write failing planner tests** in `test/history.test.ts`, describe "planCompaction", with a fixed `NOW` and short aliases (`H = 3600_000`, `S = 60_000`):
  - young untouched: all ts newer than the horizon → `[]`.
  - old bucket pruned: 5 snapshots inside one dead bucket (e.g. `NOW - 49*H` ± 2 min, horizon 48 h) with `pinned = () => false` → all but the earliest returned.
  - pinned survivor: same bucket, `pinned` true for the earliest → the other four returned, earliest never.
  - bucket with a pinned member: `pinned` true for a middle ts → the pinned ts is excluded from the result (never deleted) and no unpinned survivor is kept alongside it — every unpinned ts of that bucket is returned.
  - bucket spanning the horizon (bucket-end newer than `now - horizonMs`) → `[]`.
  - empty index → `[]`; custom `horizonMs`/`stepMs` override respected.
- [ ] **Step 5: Run** `npx vitest run test/history.test.ts` — planner tests fail.
- [ ] **Step 6: Implement `planCompaction`** in `server/history.ts`: collect ts whose bucket end `((b + 1) * stepMs)` is `< now - horizonMs`; group by bucket `Math.floor(ts / stepMs)` over the index **in its given order** (index is ascending); within each dead bucket delete every unpinned ts except the earliest unpinned one, and if the bucket holds any pinned ts keep no unpinned survivor. Return the delete list ascending.
- [ ] **Step 7: Run tests** — pass. Full gate.
- [ ] **Step 8: Commit** `git add shared/limits.ts server/history.ts test/limits.test.ts test/history.test.ts && git commit -m "feat(history): compaction planner + retention constants"`

### Task 2: `compact()` applier + scheduling

**Files:**
- Modify: `server/history.ts`
- Modify: `server/index.ts` (recorder boot/shutdown block)
- Test: `test/history.test.ts`

**Interfaces:**
- Consumes: `planCompaction` (Task 1).
- Produces: `HistoryRecorder.compact(): Promise<number>` (deleted count).

- [ ] **Step 1: Write failing tests** in `test/history.test.ts`, describe "compact": seed a temp-dir recorder (pattern: existing tests) with `now` injected; write snapshots, advance `now` past the horizon, then:
  - deletes files + index + cache: `compact()` returns N; `range().snapshots` shrank; the deleted ts's file is gone; `seek(deletedTs)` returns the bucket survivor, not an error.
  - idempotent: second `compact()` → 0.
  - pinned intact: pinned old snapshots survive; `usedBytes()` reflects the deletions.
  - Review Focus 1: `window()` after a manual `unlink` of an indexed ts completes and skips the missing item (logs contain the skip line).
- [ ] **Step 2: Run** `npx vitest run test/history.test.ts` — fail.
- [ ] **Step 3: Implement `compact()`** on `HistoryRecorder`: plan from `this.index`, `this.now()`, `this.opts.pins`; for each ts apply the existing delete mechanism from `evict()` (index filter, `cache?.drop`, `unlink().catch(() => {})`) then log once `history: compacted N snapshots older than <FULL_RES_AGE_MS/H> h` only when N > 0.
- [ ] **Step 4: Schedule in `server/index.ts`** where the recorder is started: after `await recorder.init()` succeeds fire-and-forget `recorder.compact().catch(log)`; add `const compactTimer = setInterval(() => { recorder.compact().catch(log); }, 3600_000)` and clear it in the existing shutdown sequence beside the other timers.
- [ ] **Step 5: Run tests** — pass; full gate (boot path change is covered by `test/integration.test.ts`).
- [ ] **Step 6: Commit** `git commit -am "feat(history): hourly compaction pass"` (stage new files first)

### Task 3: View-window math + persistence parsing

**Files:**
- Modify: `src/ui/format.ts`
- Test: `test/format.test.ts`

**Interfaces:**
- Consumes: `HISTORY_WINDOW_MS` from `shared/limits.js`.
- Produces: from `src/ui/format.js`:
  `type ViewSel = { mode: "preset"; ms: number | null } | { mode: "custom"; from: number; to: number }`,
  `const VIEW_PRESETS: { label: string; ms: number | null }[]` (24 h / 3 d / 7 d / 14 d / All-null),
  `const DEFAULT_VIEW_SEL: ViewSel` (`{ mode: "preset", ms: HISTORY_WINDOW_MS }`),
  `computeViewWindow(histFrom: number | null, histTo: number | null, sel: ViewSel): { from: number; to: number } | null`,
  `parseViewSel(raw: string | null): ViewSel | null`.

- [ ] **Step 1: Write failing tests** in `test/format.test.ts`:
  - `computeViewWindow` — null history → null; preset 24 h with 30 d of history → exactly `histTo - 86400000`; preset with only 3 h of history → clamps to `histFrom`; preset `ms: null` → full range; custom fully inside → exact bounds; custom partial → intersected; custom fully outside → degenerate window clamped at the nearest history edge (`from === to`, equal to `histTo` when later, `histFrom` when earlier); **Review Focus 3**: custom with `from > to` → same degenerate-clamped result (no swap, no throw).
  - **Review Focus 4**: `parseViewSel(null)` → null; valid JSON round-trips both modes; `"{bad"`, `"[]"`, `'{"mode":"preset","ms":-5}'`, `'{"mode":"custom","from":"x","to":1}'`, `'{"mode":"nope"}'` → null.
- [ ] **Step 2: Run** `npx vitest run test/format.test.ts` — fail.
- [ ] **Step 3: Implement** in `src/ui/format.ts` (imports `HISTORY_WINDOW_MS`): `computeViewWindow` preset → `from = Math.max(histFrom, histTo - ms)` (`ms === null` → full), `to = histTo`; custom → `from = min(max(sel.from, histFrom), histTo)`, `to = min(max(sel.to, histFrom), histTo)` — the clamps give the degenerate/outside cases for free. `parseViewSel` accepts exactly the two valid shapes with finite-positive numbers, else null. (No label helper: `setRange` already renders the window via `formatRangeLabel`.)
- [ ] **Step 4: Run tests** — pass; full gate.
- [ ] **Step 5: Commit** `git commit -am "feat(timeline): view-window math + persisted-selection parsing"`

### Task 4: Timeline controls row

**Files:**
- Modify: `src/ui/timeline.ts`
- Test: `test/timeline.test.ts`

**Interfaces:**
- Consumes: `ViewSel`, `VIEW_PRESETS` (Task 3).
- Produces: `createTimeline` opts gains `viewSelect?: (sel: ViewSel | null) => void` (null = back to default preset); controls render only when `viewSelect` is wired; `setRange` signature unchanged.

- [ ] **Step 1: Write failing tests** in `test/timeline.test.ts` (existing minimal-DOM-shim pattern):
  - controls rendered iff `viewSelect` wired; select contains the preset labels.
  - choosing a preset option calls `viewSelect({ mode: "preset", ms })` with the table value; "All" → `ms: null`.
  - custom apply: fill the two `datetime-local` inputs, click apply → `{ mode: "custom", from, to }` with `Date.parse` of the input values.
  - reset control → `viewSelect(null)`.
  - Review Focus 5: `setRange` to a window that excludes a pin → no throw, pin element still in DOM clamped to a track edge (left/width within 0–100%), click on it still calls `markRemove`.
  - Review Focus 2: `setCursor(t)` then `setRange` to a later window that excludes `t` → no throw, label not forced to "live".
- [ ] **Step 2: Run** `npx vitest run test/timeline.test.ts` — fail.
- [ ] **Step 3: Implement** the controls row in `src/ui/timeline.ts`: `<select>` (presets + `Custom…` sentinel value) + two `datetime-local` inputs + apply + reset buttons, in a div rendered above the track (`el.insertBefore` before the track) so it can never overlap the slider; preset change with a real preset fires immediately; `Custom…` only reveals/uses the apply button; reset restores the select to the 14 d entry and fires `viewSelect(null)`. Class names: `timeline-view`, `timeline-view-preset`, `timeline-view-from`, `timeline-view-to`, `timeline-view-apply`, `timeline-view-reset`; add minimal rules to the stylesheet used by the other timeline classes (match existing dark theme, no overlap).
- [ ] **Step 4: Run tests** — pass; full gate.
- [ ] **Step 5: Commit** `git commit -am "feat(timeline): range preset + custom window controls"`

### Task 5: Wire the view into main.ts (+ docs)

**Files:**
- Modify: `src/main.ts`
- Modify: `AGENTS.md` (timeline paragraph: compaction tiers + view window + localStorage key)

**Interfaces:**
- Consumes: Task 3 exports; Task 4 `viewSelect` callback; existing `histFrom`/`histTo`, `timeline.setRange`, playback engine closures (`src/main.ts:350-351`), onPlay `t0` fallback (`src/main.ts:229`).
- Produces: nothing further.

- [ ] **Step 1: Implement** in `src/main.ts`:
  - `let viewSel: ViewSel = parseViewSel(localStorage.getItem("radar.viewSel")) ?? DEFAULT_VIEW_SEL;`
  - `const viewWindow = () => computeViewWindow(histFrom, histTo, viewSel);`
  - timeline opts: `viewSelect: (sel) => { viewSel = sel ?? DEFAULT_VIEW_SEL; localStorage.setItem("radar.viewSel", JSON.stringify(viewSel)); const v = viewWindow(); timeline.setRange(v?.from ?? null, v?.to ?? null); }`.
  - onStatus: `timeline.setRange(...)` (line ~278) switches from `s.history.from/to` to the computed view window (the re-intersection on every status frame is intended).
  - engine closures → `historyFrom: () => viewWindow()?.from ?? null`, `historyTo: () => viewWindow()?.to ?? null`; onPlay `t0` fallback `histTo` → `viewWindow()?.to ?? histTo`.
- [ ] **Step 2: Full gate** (unit tests don't import `main.ts`; `tsc` is the automated check, per the existing wave convention).
- [ ] **Step 3: Update `AGENTS.md`** — history paragraph: tiered retention (48 h @ snapshotMs, older → one-per-`COMPACT_STEP_MS` bucket, pins exempt, hourly pass); timeline bullet: view-window presets/custom, `radar.viewSel` localStorage key, scrubber + playback follow the view.
- [ ] **Step 4: Commit** `git commit -am "feat(timeline): view-window wiring + persistence"`
- [ ] **Step 5: Hand the user the manual checklist** (spec R6): pick each preset + custom range on a 14 d history; play inside a narrow window; reload → window restored; "All" reaches pre-compaction history start; pins partially outside render/removable.
