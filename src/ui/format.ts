// Pure display-math helpers for the timeline modernization (Tasks 13/14).
// No DOM, no date libraries, no dependencies — Node-testable, browser-safe.
// All timestamps are local (local-midnight aware for dayTicks).

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

export function formatSelectedTime(t: number): string {
  return `${fmtDate(t)} ${fmtHMS(t)}`;
}

export function formatReplayClock(t: number, now?: number): string {
  if (now !== undefined && !sameLocalDay(t, now)) return `${fmtDate(t)} ${fmtHM(t)}`;
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
  if (s < 60) return `${trim1(s)} s/s`;
  if (s < 3600) return `${trim1(s / 60)} min/s`;
  if (s < 86400) return `${trim1(s / 3600)} h/s`;
  return `${trim1(s / 86400)} d/s`;
}
