// Pure display-math helpers for the timeline.
// No DOM, no date libraries — Node-testable, browser-safe.
// All timestamps are local (local-midnight aware for dayTicks).

import { HISTORY_WINDOW_MS } from "../../shared/limits.js";

const enDash = "\u2013";
const DATE_OPTS = { month: "short", day: "numeric" } as const;
const HHMM = { hour12: false, hour: "2-digit", minute: "2-digit" } as const;
const HHMMSS = { hour12: false, hour: "2-digit", minute: "2-digit", second: "2-digit" } as const;

/** 1-decimal with trailing ".0" trimmed: trim1(9)→"9", trim1(1.5)→"1.5". */
function trim1(x: number): string {
  const s = x.toFixed(1);
  return s.endsWith(".0") ? s.slice(0, -2) : s;
}

function fmtDate(t: number): string {
  return new Date(t).toLocaleDateString([], DATE_OPTS);
}
function fmtHM(t: number): string {
  return new Date(t).toLocaleTimeString([], HHMM);
}
function fmtHMS(t: number): string {
  return new Date(t).toLocaleTimeString([], HHMMSS);
}
function sameLocalDay(a: number, b: number): boolean {
  const da = new Date(a);
  const db = new Date(b);
  return (
    da.getFullYear() === db.getFullYear() &&
    da.getMonth() === db.getMonth() &&
    da.getDate() === db.getDate()
  );
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${trim1(n)} B`;
  const units = ["", "KB", "MB", "GB"];
  let v = n;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i += 1;
  }
  return `${trim1(v)} ${units[i]}`;
}

export function formatRangeLabel(from: number, to: number): string {
  if (sameLocalDay(from, to)) return `${fmtHM(from)} ${enDash} ${fmtHM(to)}`;
  return `${fmtDate(from)} ${fmtHM(from)} ${enDash} ${fmtDate(to)} ${fmtHM(to)}`;
}

/** Pinned-range row: always dates the start; the end is time-only. */
export function formatPinRange(from: number, to: number): string {
  return `${fmtDate(from)} ${fmtHM(from)} ${enDash} ${fmtHM(to)}`;
}

export function formatSelectedTime(t: number): string {
  return `${fmtDate(t)} ${fmtHMS(t)}`;
}

export function formatReplayClock(t: number, now?: number): string {
  if (!sameLocalDay(t, now ?? Date.now())) return `${fmtDate(t)} ${fmtHM(t)}`;
  return fmtHMS(t);
}

export function dayTicks(from: number, to: number): number[] {
  const ticks: number[] = [];
  let cursor = new Date(from);
  cursor.setHours(0, 0, 0, 0);
  cursor.setDate(cursor.getDate() + 1);
  while (cursor.getTime() <= to) {
    const ms = cursor.getTime();
    if (ms > from) ticks.push(ms);
    cursor = new Date(cursor.getFullYear(), cursor.getMonth(), cursor.getDate() + 1);
  }
  return ticks;
}

export function formatSpeed(s: number): string {
  // The step scale is framed in min/s (0.5 → 60); label it that way throughout.
  if (s < 86400) return `${trim1(s / 60)} min/s`;
  return `${trim1(s / 86400)} d/s`;
}

export type ViewSel =
  | { mode: "preset"; ms: number | null }
  | { mode: "custom"; from: number; to: number };

export const VIEW_PRESETS: { label: string; ms: number | null }[] = [
  { label: "24 h", ms: 86_400_000 },
  { label: "3 d", ms: 259_200_000 },
  { label: "7 d", ms: 604_800_000 },
  { label: "14 d", ms: 1_209_600_000 }, // == HISTORY_WINDOW_MS
  { label: "All", ms: null },
];

export const DEFAULT_VIEW_SEL: ViewSel = { mode: "preset", ms: HISTORY_WINDOW_MS };

/**
 * Intersects the selected view with available history; null only when there
 * is no history. An empty (or inverted) custom intersection collapses to a
 * zero-width window at the clamped `to` — downstream disables seek on it.
 */
export function computeViewWindow(
  histFrom: number | null,
  histTo: number | null,
  sel: ViewSel,
): { from: number; to: number } | null {
  if (histFrom === null || histTo === null) return null;
  if (sel.mode === "preset") {
    const from = sel.ms === null ? histFrom : Math.max(histFrom, histTo - sel.ms);
    return { from, to: histTo };
  }
  const clamp = (t: number) => Math.min(Math.max(t, histFrom), histTo);
  const from = clamp(sel.from);
  const to = clamp(sel.to);
  return from > to ? { from: to, to } : { from, to };
}

/** Parses a persisted selection; anything malformed or out of domain → null. */
export function parseViewSel(raw: string | null): ViewSel | null {
  if (!raw) return null;
  let v: unknown;
  try {
    v = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof v !== "object" || v === null) return null;
  const o = v as Record<string, unknown>;
  const pos = (x: unknown) => typeof x === "number" && Number.isFinite(x) && x > 0;
  if (o.mode === "preset" && (o.ms === null || pos(o.ms))) {
    return { mode: "preset", ms: o.ms === null ? null : (o.ms as number) };
  }
  if (o.mode === "custom" && pos(o.from) && pos(o.to)) {
    return { mode: "custom", from: o.from as number, to: o.to as number };
  }
  return null;
}
