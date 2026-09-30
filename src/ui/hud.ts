import type { FeedStatus } from "../data/ws.js";

export type ConnStatus = "connecting" | "open" | "closed";

const OPENSKY_STALE_MS = 72000;

export function createHud(root: HTMLElement): {
  setCounts(air: number, sea: number): void;
  setStatus(s: ConnStatus): void;
  setFeeds(feeds: FeedStatus, serverTime: number): void;
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
  const feedsEl = document.createElement("span");
  feedsEl.className = "hud-feeds";
  const clock = document.createElement("span");
  clock.className = "hud-clock";
  el.append(dot, status, counts, feedsEl, clock);
  root.appendChild(el);

  function renderClock(): void {
    const d = new Date();
    const pad = (n: number) => String(n).padStart(2, "0");
    clock.textContent = `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
  }
  renderClock();
  setInterval(renderClock, 1000);

  function setCounts(air: number, sea: number): void {
    counts.textContent = `${air} air · ${sea} sea`;
  }

  function setStatus(s: ConnStatus): void {
    status.textContent = s;
    dot.dataset.state = s;
  }

  function setFeeds(feeds: FeedStatus, serverTime: number): void {
    const os =
      feeds.opensky.lastOkAt == null
        ? "OpenSky: no data"
        : serverTime - feeds.opensky.lastOkAt <= OPENSKY_STALE_MS
          ? "OpenSky: ok"
          : "OpenSky: stale";
    const ai = !feeds.ais.enabled ? "AIS: off" : feeds.ais.connected ? "AIS: up" : "AIS: down";
    feedsEl.textContent = `${os} · ${ai}`;
  }

  return { setCounts, setStatus, setFeeds };
}
