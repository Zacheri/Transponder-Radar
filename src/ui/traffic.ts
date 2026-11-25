import type { TrafficSample } from "../data/ws.js";

// Traffic panel (spec 2026-11-25-traffic-monitor R6, ruling 2): upload band
// on top, download band below, totals column on the side; left-docked beside
// the settings drawer. Two-line canvas graph over a 10-min ring buffer
// (device thin translucent behind, radar bold accent in front). The watch
// lifecycle is delegated to opts.watch — main keeps the flag and re-sends it
// on every socket open (zonesCfg idiom).

const KEY = "radar.trafficPanel";

/** 600 samples = 10 min at the 1 Hz traffic frame. */
export const RING_CAP = 600;

const ACCENT_FALLBACK = "#4fc3f7";
const DEVICE_STROKE = "rgba(160, 164, 179, 0.55)";
/** Gaps longer than this (paused/lost stream) never extrapolate session bytes. */
const SESSION_GAP_S = 10;

const UNITS = ["B", "KB", "MB", "GB"] as const;

/**
 * SI humanizer pinned by the user ruling (999 B / 1.5 KB / 2.3 MB / 1.02 GB):
 * 1000-based, up to 2 decimals (3 significant digits), trailing zeros
 * trimmed, capped at GB.
 */
export function humanize(n: number): string {
  let v = Number.isFinite(n) ? Math.max(0, n) : 0;
  let i = 0;
  while (v >= 1000 && i < UNITS.length - 1) {
    v /= 1000;
    i += 1;
  }
  const s = v >= 100 ? String(Math.round(v)) : v.toFixed(2).replace(/\.?0+$/, "");
  return `${s} ${UNITS[i]}`;
}

const rate = (x: number): string => `${humanize(x)}/s`;

export interface Ring<T> {
  push(v: T): void;
  toArray(): T[];
  readonly size: number;
}

/** Fixed-capacity FIFO: push past cap evicts the oldest. */
export function createRing<T>(cap: number): Ring<T> {
  const buf = new Array<T | undefined>(cap);
  let start = 0;
  let count = 0;
  return {
    push(v: T): void {
      buf[(start + count) % cap] = v;
      if (count < cap) count += 1;
      else start = (start + 1) % cap;
    },
    toArray(): T[] {
      const out: T[] = [];
      for (let i = 0; i < count; i++) out.push(buf[(start + i) % cap] as T);
      return out;
    },
    get size(): number {
      return count;
    },
  };
}

interface PanelResizeObserver {
  observe: (target: object) => void;
  disconnect: () => void;
}

interface Pt {
  radar: number;
  device: number | null;
}

export interface TrafficPanelOpts {
  watch: (on: boolean) => void;
  /** Initial state override (embeds/tests); otherwise the persisted key wins. */
  collapsed?: boolean;
  now?: () => number;
  devicePixelRatio?: number;
  /** null forces the no-op (node tests); undefined falls back to the global. */
  ResizeObserverCtor?: (new (cb: () => void) => PanelResizeObserver) | null;
}

export interface TrafficPanelApi {
  update(sample: TrafficSample): void;
  destroy(): void;
}

function accentColor(): string {
  try {
    const v = getComputedStyle(document.documentElement).getPropertyValue("--accent");
    if (v && v.trim()) return v.trim();
  } catch {
    // not a browser (node tests)
  }
  return ACCENT_FALLBACK;
}

export function createTrafficPanel(root: HTMLElement, opts: TrafficPanelOpts): TrafficPanelApi {
  const now = opts.now ?? (() => Date.now());
  const dpr = () =>
    opts.devicePixelRatio ?? ((globalThis as { devicePixelRatio?: number }).devicePixelRatio || 1);

  const el = document.createElement("aside");
  el.className = "drawer traffic-panel";
  const head = document.createElement("div");
  head.className = "drawer-head";
  head.setAttribute("role", "button");
  head.setAttribute("tabindex", "0");
  const title = document.createElement("span");
  title.textContent = "⇅ Traffic";
  const chevron = document.createElement("span");
  chevron.className = "drawer-chevron";
  chevron.textContent = "▾";
  head.append(title, chevron);
  const body = document.createElement("div");
  body.className = "drawer-body";

  const canvas = document.createElement("canvas");
  canvas.className = "traffic-canvas";

  const line = (cls: string, text: string): HTMLElement => {
    const row = document.createElement("div");
    row.className = `traffic-line ${cls}`;
    row.textContent = text;
    return row;
  };
  const bands = document.createElement("div");
  bands.className = "traffic-bands";
  const upDev = line("traffic-up-device", "↑ device —");
  const upRadar = line("traffic-up-radar", "↑ radar —");
  const dnDev = line("traffic-down-device", "↓ device —");
  const dnRadar = line("traffic-down-radar", "↓ radar —");
  bands.append(upDev, upRadar, dnDev, dnRadar);

  const totals = document.createElement("div");
  totals.className = "traffic-totals";
  const totSrc = line("traffic-totals-src", "");
  const totNow = line("traffic-total-now", "now —");
  const totToday = line("traffic-total-today", "today —");
  const totSession = line("traffic-total-session", "session —");
  const topEl = document.createElement("div");
  topEl.className = "traffic-top";
  totals.append(totSrc, totNow, totToday, totSession, topEl);

  const main = document.createElement("div");
  main.className = "traffic-main";
  main.append(bands, totals);
  body.append(canvas, main);
  el.append(head, body);
  root.appendChild(el);

  // Only a stored "1" means expanded: absent/"0"/corrupt → collapsed.
  let collapsed: boolean;
  if (typeof opts.collapsed === "boolean") collapsed = opts.collapsed;
  else {
    let raw: string | null = null;
    try {
      raw = localStorage.getItem(KEY);
    } catch {
      // storage unavailable
    }
    collapsed = raw !== "1";
  }
  const syncUi = (): void => {
    el.classList.toggle("collapsed", collapsed);
    head.setAttribute("aria-expanded", String(!collapsed));
  };
  syncUi();

  const ring = createRing<Pt>(RING_CAP);
  const session = { radar: { up: 0, down: 0 }, device: { up: 0, down: 0 } };
  let prevAt: number | null = null;
  let sized = false;
  let dead = false;

  function toggle(): void {
    collapsed = !collapsed;
    syncUi();
    try {
      localStorage.setItem(KEY, collapsed ? "0" : "1");
    } catch {
      // storage unavailable
    }
    opts.watch(!collapsed);
    if (!collapsed) draw();
  }
  const onKey = (e: KeyboardEvent): void => {
    if (e.key === "Enter" || e.key === " ") {
      if (e.key === " ") e.preventDefault();
      toggle();
    }
  };
  head.addEventListener("click", toggle);
  head.addEventListener("keydown", onKey);

  // Expanded at boot: flip main's watch flag now so the first (and every
  // later) socket open re-sends watch(true); no call ever when collapsed.
  if (!collapsed) opts.watch(true);

  const RoCtor =
    opts.ResizeObserverCtor !== undefined
      ? opts.ResizeObserverCtor
      : ((globalThis as { ResizeObserver?: new (cb: () => void) => PanelResizeObserver }).ResizeObserver ?? null);
  const ro = RoCtor ? new RoCtor(() => { sized = false; if (!collapsed) draw(); }) : null;
  ro?.observe(canvas);

  function ensureSize(): boolean {
    const w = canvas.clientWidth;
    const h = canvas.clientHeight;
    if (w <= 0 || h <= 0) return false;
    const d = dpr();
    canvas.width = Math.round(w * d);
    canvas.height = Math.round(h * d);
    const ctx = canvas.getContext("2d");
    ctx?.setTransform(d, 0, 0, d, 0, 0);
    sized = true;
    return true;
  }

  function strokeSeries(
    ctx: CanvasRenderingContext2D,
    vals: (number | null)[],
    max: number,
    w: number,
    h: number,
    color: string,
    width: number,
  ): void {
    const n = vals.length;
    if (n < 2) return;
    ctx.strokeStyle = color;
    ctx.lineWidth = width;
    ctx.beginPath();
    let pen = false;
    for (let i = 0; i < n; i++) {
      const v = vals[i];
      if (v == null) {
        pen = false; // counter gap: break the polyline instead of lying
        continue;
      }
      const x = (i * w) / (n - 1);
      const y = h - 2 - (v / max) * (h - 4);
      if (pen) ctx.lineTo(x, y);
      else {
        ctx.moveTo(x, y);
        pen = true;
      }
    }
    ctx.stroke();
  }

  function draw(): void {
    if (collapsed) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    if (!sized && !ensureSize()) return;
    const w = canvas.clientWidth;
    const h = canvas.clientHeight;
    ctx.clearRect(0, 0, w, h);
    const pts = ring.toArray();
    if (pts.length === 0) return;
    let max = 1;
    for (const p of pts) {
      if (p.radar > max) max = p.radar;
      if (p.device != null && p.device > max) max = p.device;
    }
    if (pts.some((p) => p.device != null))
      strokeSeries(ctx, pts.map((p) => p.device), max, w, h, DEVICE_STROKE, 1);
    strokeSeries(ctx, pts.map((p) => p.radar), max, w, h, accentColor(), 2);
  }

  function render(s: TrafficSample): void {
    upDev.textContent = s.device ? `↑ device ${rate(s.device.up)} · ${humanize(s.device.upTotal)}` : "↑ device —";
    dnDev.textContent = s.device ? `↓ device ${rate(s.device.down)} · ${humanize(s.device.downTotal)}` : "↓ device —";
    upRadar.textContent = `↑ radar ${rate(s.radar.up)} · ${humanize(s.radar.upTotal)}`;
    dnRadar.textContent = `↓ radar ${rate(s.radar.down)} · ${humanize(s.radar.downTotal)}`;
    // Totals follow the device superset (whole-machine attribution is the
    // point of the column); radar-only where the counters degraded away.
    const tot = s.device ?? s.radar;
    const ses = s.device ? session.device : session.radar;
    totSrc.textContent = s.device ? "device totals" : "radar totals (device n/a)";
    totNow.textContent = `now ↑${rate(tot.up)} ↓${rate(tot.down)}`;
    totToday.textContent = `today ↑${humanize(tot.upTotal)} ↓${humanize(tot.downTotal)}`;
    totSession.textContent = `session ↑${humanize(ses.up)} ↓${humanize(ses.down)}`;
    const rows = (s.top ?? []).slice(0, 3);
    topEl.replaceChildren(
      ...rows.map((r) => {
        const row = document.createElement("div");
        row.className = "traffic-top-row";
        row.textContent = `${r.proc} ${humanize(r.bytes)}`;
        return row;
      }),
    );
  }

  function update(sample: TrafficSample): void {
    if (dead) return;
    const t = now();
    if (prevAt != null) {
      const dt = (t - prevAt) / 1000;
      if (dt > 0 && dt <= SESSION_GAP_S) {
        session.radar.up += sample.radar.up * dt;
        session.radar.down += sample.radar.down * dt;
        if (sample.device) {
          session.device.up += sample.device.up * dt;
          session.device.down += sample.device.down * dt;
        }
      }
    }
    prevAt = t;
    ring.push({
      radar: sample.radar.up + sample.radar.down,
      device: sample.device ? sample.device.up + sample.device.down : null,
    });
    if (collapsed) return; // cheap path: buffer fills, DOM and canvas untouched
    render(sample);
    draw();
  }

  function destroy(): void {
    dead = true;
    ro?.disconnect();
    head.removeEventListener("click", toggle);
    head.removeEventListener("keydown", onKey);
  }

  return { update, destroy };
}
