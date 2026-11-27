import type { FeedStatus, IconStatus } from "../data/ws.js";
import { formatReplayClock } from "./format.js";

export type ConnStatus = "connecting" | "open" | "closed";

const OPENSKY_STALE_MS = 72000;
const AIS_STALE_MS = 180000;

export function createHud(root: HTMLElement): {
  setCounts(air: number, sea: number): void;
  setStatus(s: ConnStatus): void;
  setFeeds(feeds: FeedStatus, serverTime: number): void;
  setIcons(i: IconStatus | null): void;
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
  const fillEl = document.createElement("div");
  fillEl.className = "hud-fill";
  const iconsEl = document.createElement("span");
  iconsEl.className = "hud-icons";
  const clock = document.createElement("span");
  clock.className = "hud-clock";
  const replayBadge = document.createElement("span");
  replayBadge.className = "hud-replay";
  replayBadge.textContent = "REPLAY";
  el.append(dot, replayBadge, status, counts, feedsEl, fillEl, iconsEl, clock);
  root.appendChild(el);

  let replayT: number | null = null;

  function renderClock(): void {
    const pad = (n: number) => String(n).padStart(2, "0");
    if (replayT != null) {
      clock.textContent = formatReplayClock(replayT);
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
    let boostSeg = "";
    let boostTitle: string | null = null;
    const boost = feeds.opensky.boost;
    if (boost?.active) {
      if (boost.paused === "standdown") {
        boostSeg = " · Boost: sections only";
        boostTitle = "Auto zones stand down while you run sections";
      } else if (boost.paused === "credits") {
        boostSeg = " · Boost paused";
        boostTitle = "Slow the Aircraft-poll slider to fund zone polling";
      } else {
        const segs: string[] = [];
        if ((boost.sectionsActive ?? 0) > 0) segs.push(`${boost.sectionsActive} sec`);
        if ((boost.zones ?? 0) > 0) segs.push(`${boost.zones} auto`);
        // Nothing up (and not paused) → no segment, even with credits spent.
        if (segs.length) {
          if ((boost.creditsToday ?? 0) > 0) segs.push(`${boost.creditsToday} cr`);
          boostSeg = ` · Boost: ${segs.join(" · ")}`;
        }
      }
    }
    feedsEl.textContent = `${os} · ${ai}`;
    if (boostSeg) {
      // Paused variants are titled spans so the hover tooltip explains the
      // fix; the rendered feeds line stays byte-identical to the plain
      // string it used to be.
      if (boostTitle != null) {
        const seg = document.createElement("span");
        seg.textContent = boostSeg;
        seg.setAttribute("title", boostTitle);
        feedsEl.appendChild(seg);
      } else {
        feedsEl.textContent += boostSeg;
      }
    }
    // Attribution credit line (below the pill via CSS); hidden while the
    // fill feed is off or down. ?. guards legacy frames without secondary.
    const sec = feeds.ais.secondary;
    if (sec?.enabled && sec?.connected) {
      const atts = sec.attributions ?? [];
      const shown = atts.slice(0, 3);
      const more = atts.length > shown.length ? ` (+${atts.length - shown.length})` : "";
      fillEl.textContent = shown.length ? `AIS fill: ${shown.join(" · ")}${more}` : "AIS fill: waiting";
    } else {
      fillEl.textContent = "";
    }
  }

  function setIcons(i: IconStatus | null): void {
    // null / absent → hidden (pack disabled or legacy frame)
    if (i === null || i.state === "absent") {
      iconsEl.textContent = "";
      iconsEl.classList.remove("warn");
      return;
    }
    iconsEl.textContent =
      i.state === "ready" ? `Icons: ${i.count}` : i.state === "downloading" ? "Icons: …" : "Icons: offline";
    iconsEl.classList.toggle("warn", i.state === "failed");
  }

  function setReplay(t: number | null): void {
    replayT = t;
    replayBadge.classList.toggle("visible", t != null);
    renderClock();
  }

  return { setCounts, setStatus, setFeeds, setIcons, setReplay };
}
