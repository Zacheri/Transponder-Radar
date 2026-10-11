const WARN_CREDITS_PER_DAY = 2000;
const DANGER_CREDITS_PER_DAY = 4000;

export interface FeedRateOpts {
  label: string;
  ariaLabel: string;
  minMs: number;
  maxMs: number;
  stepMs: number;
  defaultMs: number;
  creditsPerPoll?: number;
  send: (ms: number) => void;
}

export function createFeedRate(
  root: HTMLElement,
  opts: FeedRateOpts,
): { setMs: (ms: number) => void } {
  const { minMs, maxMs, stepMs, defaultMs, creditsPerPoll } = opts;
  const el = document.createElement("div");
  el.className = "pollrate";
  const label = document.createElement("span");
  label.className = "pollrate-label";
  const slider = document.createElement("input");
  slider.type = "range";
  slider.min = String(minMs);
  slider.max = String(maxMs);
  slider.step = String(stepMs);
  slider.value = String(defaultMs);
  slider.setAttribute("aria-label", opts.ariaLabel);
  const credits = document.createElement("span");
  credits.className = "pollrate-credits";
  el.append(label, slider, credits);
  root.appendChild(el);

  function render(ms: number): void {
    label.textContent = `${opts.label} ${Math.round(ms / 1000)} s`;
    if (creditsPerPoll == null) return;
    const c = Math.ceil(86400000 / ms) * creditsPerPoll;
    credits.textContent = `≈${c.toLocaleString()} credits/day`;
    credits.dataset.level = c >= DANGER_CREDITS_PER_DAY ? "danger" : c >= WARN_CREDITS_PER_DAY ? "warn" : "ok";
  }

  let debounce: number | null = null;

  slider.addEventListener("input", () => {
    const ms = Number(slider.value);
    render(ms);
    if (debounce != null) clearTimeout(debounce);
    debounce = window.setTimeout(() => {
      debounce = null;
      opts.send(ms);
    }, 150);
  });

  function setMs(ms: number): void {
    slider.value = String(Math.min(maxMs, Math.max(minMs, ms)));
    render(ms);
  }

  setMs(defaultMs);
  return { setMs };
}
