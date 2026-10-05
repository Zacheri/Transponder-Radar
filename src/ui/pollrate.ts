const MIN_MS = 30000;
const MAX_MS = 900000;
const STEP_MS = 15000;
const DEFAULT_MS = 120000;

const CREDITS_PER_POLL = 4;
const WARN_CREDITS_PER_DAY = 2000;
const DANGER_CREDITS_PER_DAY = 4000;

export function createPollRate(
  root: HTMLElement,
  send: (ms: number) => void,
): { setPollMs: (ms: number) => void } {
  const el = document.createElement("div");
  el.className = "pollrate";
  const label = document.createElement("span");
  label.className = "pollrate-label";
  const slider = document.createElement("input");
  slider.type = "range";
  slider.min = String(MIN_MS);
  slider.max = String(MAX_MS);
  slider.step = String(STEP_MS);
  slider.value = String(DEFAULT_MS);
  slider.setAttribute("aria-label", "Aircraft poll interval");
  const credits = document.createElement("span");
  credits.className = "pollrate-credits";
  el.append(label, slider, credits);
  root.appendChild(el);

  function render(ms: number): void {
    label.textContent = `Aircraft poll ${Math.round(ms / 1000)} s`;
    const c = Math.ceil(86400000 / ms) * CREDITS_PER_POLL;
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
      send(ms);
    }, 150);
  });

  function setPollMs(ms: number): void {
    slider.value = String(Math.min(MAX_MS, Math.max(MIN_MS, ms)));
    render(ms);
  }

  setPollMs(DEFAULT_MS);
  return { setPollMs };
}
