import type { Pin } from "../data/ws.js";
import {
  dayTicks,
  formatRangeLabel,
  formatSelectedTime,
  formatSpeed,
} from "./format.js";
import {
  MIN_PIN_MS,
  SPEED_DEFAULT,
  SPEED_SLIDER_MAX,
  sliderFromSpeed,
  speedFromSlider,
} from "../../shared/limits.js";

export interface TimelineApi {
  setRange: (from: number | null, to: number | null) => void;
  setLive: () => void;
  setPins: (pins: Pin[]) => void;
  setPlaying: (playing: boolean) => void;
  setCursor: (t: number) => void;
}

const DEBOUNCE_MS = 150;

export function createTimeline(
  root: HTMLElement,
  opts: {
    seek: (t: number) => void;
    goLive: () => void;
    play?: () => void;
    speed?: (s: number) => void;
    markAdd?: (from: number, to: number) => void;
    markRemove?: (id: string) => void;
    playAvailable?: boolean;
  },
): TimelineApi {
  const el = document.createElement("div");
  el.className = "timeline";
  const rangeLbl = document.createElement("span");
  rangeLbl.className = "timeline-range";

  // Playback is one unit: play button + speed slider, rendered only when wired.
  let playBtn: HTMLButtonElement | null = null;
  let speedDebounce: number | null = null;
  if (opts.play != null) {
    playBtn = document.createElement("button");
    playBtn.className = "timeline-play";
    playBtn.textContent = "▶";
    playBtn.addEventListener("click", () => opts.play?.());
    if (opts.playAvailable === false) {
      playBtn.disabled = true;
      playBtn.title = "Playback unavailable";
    }
    const speedInput = document.createElement("input");
    speedInput.type = "range";
    speedInput.min = "0";
    speedInput.max = String(SPEED_SLIDER_MAX);
    speedInput.step = "1";
    speedInput.value = String(sliderFromSpeed(SPEED_DEFAULT));
    speedInput.setAttribute("aria-label", "Playback speed");
    const speedLbl = document.createElement("span");
    speedLbl.className = "timeline-speed-lbl";
    speedLbl.textContent = formatSpeed(speedFromSlider(Number(speedInput.value)));
    speedInput.addEventListener("input", () => {
      speedLbl.textContent = formatSpeed(speedFromSlider(Number(speedInput.value)));
      if (speedDebounce != null) clearTimeout(speedDebounce);
      speedDebounce = window.setTimeout(() => {
        opts.speed?.(speedFromSlider(Number(speedInput.value)));
      }, DEBOUNCE_MS);
    });
    const speedWrap = document.createElement("div");
    speedWrap.className = "timeline-speed";
    speedWrap.append(speedInput, speedLbl);
    el.append(rangeLbl, playBtn, speedWrap);
  } else {
    el.appendChild(rangeLbl);
  }

  const track = document.createElement("div");
  track.className = "timeline-track";
  const overlay = document.createElement("div");
  overlay.className = "timeline-overlay";
  const preview = document.createElement("span");
  preview.className = "timeline-pin-preview";
  preview.style.display = "none";
  overlay.appendChild(preview);
  const slider = document.createElement("input");
  slider.type = "range";
  slider.setAttribute("aria-label", "Timeline scrubber");
  track.append(overlay, slider);
  el.appendChild(track);

  const selLbl = document.createElement("span");
  selLbl.className = "timeline-sel";
  el.appendChild(selLbl);

  // Mark mode: rendered only when both mark callbacks are wired.
  let marking = false;
  if (opts.markAdd != null && opts.markRemove != null) {
    const markBtn = document.createElement("button");
    markBtn.className = "timeline-mark";
    markBtn.textContent = "Mark";
    markBtn.addEventListener("click", () => {
      marking = !marking;
      markBtn.classList.toggle("active", marking);
      track.classList.toggle("marking", marking);
      if (!marking) cancelGesture();
    });
    el.appendChild(markBtn);
  }

  const liveBtn = document.createElement("button");
  liveBtn.className = "timeline-live";
  liveBtn.textContent = "LIVE";
  el.appendChild(liveBtn);
  root.appendChild(el);

  let from: number | null = null;
  let to: number | null = null;
  let rewound = false;
  let debounce: number | null = null;
  let currentPins: Pin[] = [];
  let tickEls: HTMLSpanElement[] = [];
  let pinEls: HTMLSpanElement[] = [];
  let gesture: { start: number; preValue: number } | null = null;

  const clampPct = (x: number) => Math.max(0, Math.min(100, x));

  function renderTicks(): void {
    for (const s of tickEls) s.remove();
    tickEls = [];
    if (from == null || to == null || from >= to) return;
    const span = to - from;
    const anchor = pinEls[0] ?? preview;
    for (const tick of dayTicks(from, to)) {
      const s = document.createElement("span");
      s.className = "timeline-tick";
      s.style.left = `${clampPct(((tick - from) / span) * 100)}%`;
      overlay.insertBefore(s, anchor);
      tickEls.push(s);
    }
  }

  function renderPins(): void {
    for (const s of pinEls) s.remove();
    pinEls = [];
    if (from == null || to == null || from >= to) return;
    const span = to - from;
    for (const pin of currentPins) {
      const s = document.createElement("span");
      s.className = "timeline-pin";
      s.style.left = `${clampPct(((pin.from - from) / span) * 100)}%`;
      s.style.width = `${clampPct(((pin.to - pin.from) / span) * 100)}%`;
      overlay.insertBefore(s, preview);
      pinEls.push(s);
    }
  }

  function hidePreview(): void {
    preview.style.display = "none";
  }

  function showPreview(min: number, max: number): void {
    if (from == null || to == null || from >= to) return;
    const span = to - from;
    preview.style.left = `${clampPct(((min - from) / span) * 100)}%`;
    preview.style.width = `${clampPct(((max - min) / span) * 100)}%`;
    preview.style.display = "block";
  }

  function setRange(f: number | null, t: number | null): void {
    from = f;
    to = t;
    const enabled = f != null && t != null;
    el.classList.toggle("disabled", !enabled);
    if (!enabled) {
      rangeLbl.textContent = "no history yet";
      selLbl.textContent = "";
      renderTicks();
      renderPins();
      hidePreview();
      return;
    }
    slider.min = String(f);
    slider.max = String(t);
    slider.step = "1000";
    if (!rewound) {
      slider.value = String(t);
      selLbl.textContent = "live";
    }
    rangeLbl.textContent = formatRangeLabel(f, t);
    renderTicks();
    renderPins();
  }

  slider.addEventListener("input", () => {
    if (marking) return;
    const t = Number(slider.value);
    selLbl.textContent = formatSelectedTime(t);
    liveBtn.classList.add("active");
    if (debounce != null) clearTimeout(debounce);
    debounce = window.setTimeout(() => {
      rewound = true;
      opts.seek(t);
    }, DEBOUNCE_MS);
  });

  function xToTime(clientX: number): number | null {
    if (from == null || to == null || from >= to) return null;
    const rect = slider.getBoundingClientRect();
    if (rect.width <= 0) return from;
    const frac = (clientX - rect.left) / rect.width;
    return Math.max(from, Math.min(to, from + frac * (to - from)));
  }

  function onMarkMove(ev: MouseEvent): void {
    if (gesture == null) return;
    const cur = xToTime(ev.clientX);
    if (cur == null) return;
    showPreview(Math.min(gesture.start, cur), Math.max(gesture.start, cur));
  }

  function onMarkCancel(): void {
    cancelGesture();
  }

  function endMarkListeners(): void {
    window.removeEventListener("mousemove", onMarkMove);
    window.removeEventListener("mouseup", onMarkUp);
    window.removeEventListener("pointercancel", onMarkCancel);
  }

  function cancelGesture(): void {
    if (gesture == null) return;
    const preValue = gesture.preValue;
    gesture = null;
    endMarkListeners();
    hidePreview();
    slider.value = String(preValue);
  }

  function onMarkUp(ev: MouseEvent): void {
    const g = gesture;
    gesture = null;
    endMarkListeners();
    if (g == null) return;
    const cur = xToTime(ev.clientX);
    const min = cur == null ? g.start : Math.min(g.start, cur);
    const max = cur == null ? g.start : Math.max(g.start, cur);
    hidePreview();
    slider.value = String(g.preValue);
    if (max - min >= MIN_PIN_MS) {
      opts.markAdd?.(Math.round(min / 1000) * 1000, Math.round(max / 1000) * 1000);
    } else {
      const hit = currentPins.find((p) => p.from <= g.start && g.start <= p.to);
      if (hit != null) opts.markRemove?.(hit.id);
    }
  }

  slider.addEventListener("mousedown", (ev) => {
    if (!marking || gesture != null) return;
    const start = xToTime(ev.clientX);
    if (start == null) return;
    ev.preventDefault();
    gesture = { start, preValue: Number(slider.value) };
    window.addEventListener("mousemove", onMarkMove);
    window.addEventListener("mouseup", onMarkUp);
    window.addEventListener("pointercancel", onMarkCancel);
  });

  liveBtn.addEventListener("click", () => {
    setLive();
    opts.goLive();
  });

  function setLive(): void {
    rewound = false;
    liveBtn.classList.remove("active");
    selLbl.textContent = "live";
    if (to != null) slider.value = String(to);
  }

  function setPins(pins: Pin[]): void {
    currentPins = pins;
    renderPins();
  }

  function setPlaying(playing: boolean): void {
    if (playBtn == null) return;
    playBtn.textContent = playing ? "⏸" : "▶";
    playBtn.classList.toggle("active", playing);
  }

  function setCursor(t: number): void {
    if (from == null || to == null) return;
    slider.value = String(t);
    selLbl.textContent = formatSelectedTime(t);
  }

  setRange(null, null);

  return { setRange, setLive, setPins, setPlaying, setCursor };
}
