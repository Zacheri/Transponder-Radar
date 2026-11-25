import type { TrafficSample } from "../data/ws.js";

// Traffic panel (spec 2026-11-25-traffic-monitor R6, ruling 2): upload band
// on top, download band below, totals column on the side; left-docked beside
// the settings drawer. Two-line canvas graph over a 10-min ring buffer
// (device thin translucent behind, radar bold accent in front). The watch
// lifecycle is delegated to opts.watch — main keeps the flag and re-sends it
// on every socket open (zonesCfg idiom). The watch spans the whole panel
// life (2026-11-26 ruling): the collapsed header shows condensed live rates.

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
  let s = v >= 100 ? String(Math.round(v)) : v.toFixed(2).replace(/\.?0+$/, "");
  // Rounding can push a value to 1000 of the current unit (999.6 KB -> "1000
  // KB"); escalate once so the unit always matches the magnitude.
  if (Number(s) >= 1000 && i < UNITS.length - 1) {
    s = String(Number(s) / 1000);
    i += 1;
  }
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
  // Two-cell rows (label left, value right) keep every number flush-right
  // and make horizontal overflow structurally impossible in the narrow dock.
  const row = (cls: string, key: string): { el: HTMLElement; val: HTMLElement } => {
    const el = document.createElement("div");
    el.className = `traffic-line ${cls}`;
    const k = document.createElement("span");
    k.className = "traffic-k";
    k.textContent = key;
    const v = document.createElement("span");
    v.className = "traffic-v";
    el.append(k, v);
    return { el, val: v };
  };
  const bands = document.createElement("div");
  bands.className = "traffic-bands";
  const upDev = row("traffic-up-device", "↑ device");
  const upRadar = row("traffic-up-radar", "↑ radar");
  const dnDev = row("traffic-down-device", "↓ device");
  const dnRadar = row("traffic-down-radar", "↓ radar");
  dnRadar.el.title = "Browser downloads are counted only when resource timing is exact (exact or 0)";
  bands.append(upDev.el, upRadar.el, dnDev.el, dnRadar.el);

  const totals = document.createElement("div");
  totals.className = "traffic-totals";
  const totSrc = line("traffic-totals-src", "");
  const totNow = row("traffic-total-now", "now");
  const totToday = row("traffic-total-today", "today");
  const totSession = row("traffic-total-session", "session");
  const topEl = document.createElement("div");
  topEl.className = "traffic-top";
  totals.append(totSrc, totNow.el, totToday.el, totSession.el, topEl);

  const main = document.createElement("div");
  main.className = "traffic-main";
  main.append(bands, totals);
  body.append(canvas, main);
  // Collapsed-header readout (user ruling 2026-11-26): condensed live rates,
  // visible only while collapsed — which is why the watch now spans the
  // whole panel life, not just the expanded state.
  const compact = document.createElement("span");
  compact.className = "traffic-compact";
  compact.textContent = "u:— d:—";
  head.append(title, compact, chevron);
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
  let lastSample: TrafficSample | null = null;
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
    // No watch flip on toggle: the stream also feeds the collapsed-header
    // compact readout, so the watch spans the whole panel life (2026-11-26).
    if (!collapsed) {
      if (lastSample) render(lastSample); // no blank rows before the next frame
      draw();
    }
  }
  const onKey = (e: KeyboardEvent): void => {
    if (e.key === "Enter" || e.key === " ") {
      if (e.key === " ") e.preventDefault();
      toggle();
    }
  };
  head.addEventListener("click", toggle);
  head.addEventListener("keydown", onKey);

  // The watch flag flips here in main and is re-sent on every socket open
  // (zonesCfg re-send idiom); collapsed boot keeps it on for the compact
  // readout, so it fires unconditionally at creation.
  opts.watch(true);

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
    upDev.val.textContent = s.device ? `${rate(s.device.up)} · ${humanize(s.device.upTotal)}` : "—";
    dnDev.val.textContent = s.device ? `${rate(s.device.down)} · ${humanize(s.device.downTotal)}` : "—";
    upRadar.val.textContent = `${rate(s.radar.up)} · ${humanize(s.radar.upTotal)}`;
    dnRadar.val.textContent = `${rate(s.radar.down)} · ${humanize(s.radar.downTotal)}`;
    // Totals follow the device superset (whole-machine attribution is the
    // point of the column); radar-only where the counters degraded away.
    const tot = s.device ?? s.radar;
    const ses = s.device ? session.device : session.radar;
    totSrc.textContent = s.device ? "device totals" : "radar totals (device n/a)";
    totNow.val.textContent = `↑${rate(tot.up)} ↓${rate(tot.down)}`;
    totToday.val.textContent = `↑${humanize(tot.upTotal)} ↓${humanize(tot.downTotal)}`;
    totSession.val.textContent = `↑${humanize(ses.up)} ↓${humanize(ses.down)}`;
    const rows = (s.top ?? []).slice(0, 3);
    topEl.replaceChildren(
      ...rows.map((r) => {
        const { el, val } = row("traffic-top-row", r.proc);
        val.textContent = humanize(r.bytes);
        return el;
      }),
    );
  }

  /** Condensed rates for the collapsed header: the device superset where
   * present, radar where the device counters degraded away. */
  function renderCompact(s: TrafficSample): void {
    const tot = s.device ?? s.radar;
    compact.textContent = `u:${rate(tot.up)} d:${rate(tot.down)}`;
    compact.title = s.device ? "device totals (whole machine)" : "radar totals (device n/a)";
  }

  function update(sample: TrafficSample): void {
    if (dead) return;
    lastSample = sample;
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
    renderCompact(sample);
    if (collapsed) return; // cheap path: bands/canvas stay untouched, header updates
    render(sample);
    draw();
  }

  function destroy(): void {
    dead = true;
    ro?.disconnect();
    head.removeEventListener("click", toggle);
    head.removeEventListener("keydown", onKey);
    opts.watch(false);
    el.remove();
  }

  return { update, destroy };
}
