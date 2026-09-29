export type ConnStatus = "connecting" | "open" | "closed";

export function createHud(root: HTMLElement): {
  setCounts(air: number, sea: number): void;
  setStatus(s: ConnStatus): void;
} {
  const el = document.createElement("div");
  el.className = "hud";
  const dot = document.createElement("span");
  dot.className = "hud-dot";
  const status = document.createElement("span");
  status.className = "hud-status";
  status.textContent = "connecting";
  const counts = document.createElement("span");
  counts.className = "hud-counts";
  el.append(dot, status, counts);
  root.appendChild(el);

  function setCounts(air: number, sea: number): void {
    counts.textContent = `${air} air · ${sea} sea`;
  }

  function setStatus(s: ConnStatus): void {
    status.textContent = s;
    dot.dataset.state = s;
  }

  return { setCounts, setStatus };
}
