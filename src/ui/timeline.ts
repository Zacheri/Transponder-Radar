export interface TimelineApi {
  setRange: (from: number | null, to: number | null) => void;
  setLive: () => void;
}

export function createTimeline(
  root: HTMLElement,
  opts: { seek: (t: number) => void; goLive: () => void },
): TimelineApi {
  const el = document.createElement("div");
  el.className = "timeline";
  const rangeLbl = document.createElement("span");
  rangeLbl.className = "timeline-range";
  const slider = document.createElement("input");
  slider.type = "range";
  slider.setAttribute("aria-label", "Timeline scrubber");
  const selLbl = document.createElement("span");
  selLbl.className = "timeline-sel";
  const liveBtn = document.createElement("button");
  liveBtn.className = "timeline-live";
  liveBtn.textContent = "LIVE";
  el.append(rangeLbl, slider, selLbl, liveBtn);
  root.appendChild(el);

  let debounce: number | null = null;

  const fmt = (t: number) => new Date(t).toLocaleTimeString([], { hour12: false });

  function setRange(f: number | null, t: number | null): void {
    const enabled = f != null && t != null;
    el.classList.toggle("disabled", !enabled);
    if (!enabled) {
      rangeLbl.textContent = "no history yet";
      selLbl.textContent = "";
      return;
    }
    slider.min = String(f);
    slider.max = String(t);
    slider.step = "1000";
    slider.value = String(t);
    rangeLbl.textContent = `${fmt(f)} – ${fmt(t)}`;
    selLbl.textContent = "live";
  }

  slider.addEventListener("input", () => {
    const t = Number(slider.value);
    selLbl.textContent = fmt(t);
    liveBtn.classList.add("active");
    if (debounce != null) clearTimeout(debounce);
    debounce = window.setTimeout(() => opts.seek(t), 150);
  });

  liveBtn.addEventListener("click", () => {
    liveBtn.classList.remove("active");
    selLbl.textContent = "live";
    opts.goLive();
  });

  function setLive(): void {
    liveBtn.classList.remove("active");
    selLbl.textContent = "live";
  }

  return { setRange, setLive };
}
