import type { FeedStatus } from "../data/ws.js";

export type ConnStatus = "connecting" | "open" | "closed";

const OPENSKY_STALE_MS = 72000;
const AIS_STALE_MS = 180000;

export function createHud(root: HTMLElement): {
  setCounts(air: number, sea: number): void;
  setStatus(s: ConnStatus): void;
  setFeeds(feeds: FeedStatus, serverTime: number): void;
  setReplay(t: number | null): void;
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
  const replayBadge = document.createElement("span");
  replayBadge.className = "hud-replay";
  replayBadge.textContent = "REPLAY";
  el.append(dot, replayBadge, status, counts, feedsEl, clock);
  root.appendChild(el);

  let replayT: number | null = null;

  function renderClock(): void {
    const pad = (n: number) => String(n).padStart(2, "0");
    if (replayT != null) {
      const d = new Date(replayT);
      clock.textContent = `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
      clock.classList.add("replay");
      return;
    }
    clock.classList.remove("replay");
    const d = new Date();
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
    let ai: string;
    if (!feeds.ais.enabled) ai = "AIS: off";
    else if (!feeds.ais.connected) ai = "AIS: down";
    else if (feeds.ais.lastMessageAt == null) ai = "AIS: waiting";
    else {
      const age = serverTime - feeds.ais.lastMessageAt;
      ai = age <= AIS_STALE_MS ? "AIS: ok" : `AIS: stale ${Math.max(1, Math.round(age / 60000))}m`;
    }
    feedsEl.textContent = `${os} · ${ai}`;
  }

  function setReplay(t: number | null): void {
    replayT = t;
    replayBadge.classList.toggle("visible", t != null);
    renderClock();
  }

  return { setCounts, setStatus, setFeeds, setReplay };
}
