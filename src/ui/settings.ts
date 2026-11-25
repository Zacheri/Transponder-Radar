import { GB } from "../../shared/limits.js";
import type { Pin } from "../data/ws.js";
import { formatBytes, formatPinRange } from "./format.js";

const COLLAPSED_KEY = "radar.settingsCollapsed";
const PARK_TEXT = "Park AIS fill tile here";
const PARK_TEXT_NOKEY = "Needs AISCAST_API_KEY";

export interface SettingsStats {
  storageCapGb: number;
  ramCacheGb: number;
  cacheUsedBytes: number;
  usedBytes: number;
  pinnedBytes: number;
  pins: Pin[];
  homeRegion?: { lat: number; lon: number } | null;
  // Server-sourced truth: false → the fill feed has no AISCAST key.
  // Undefined (legacy status frames) is treated as enabled.
  secondaryEnabled?: boolean;
}

export interface SettingsApi { setStats: (s: SettingsStats) => void; feedRates: HTMLElement }

function debouncedNumber(input: HTMLInputElement, apply: (n: number) => void): (sent: number) => void {
  let timer: number | null = null;
  let lastSent: number | null = null;
  input.addEventListener("input", () => {
    if (timer != null) clearTimeout(timer);
    timer = window.setTimeout(() => {
      timer = null;
      const v = Number(input.value);
      if (input.value === "" || !Number.isFinite(v) || v === lastSent) return;
      lastSent = v;
      apply(v);
    }, 500);
  });
  // Hook for values pushed in from outside; records them as sent so they aren't re-sent.
  return (sent) => {
    lastSent = sent;
  };
}

export function createSettings(
  root: HTMLElement,
  opts: {
    update: (patch: { storageCapGb?: number; ramCacheGb?: number }) => void;
    removePin: (id: string) => void;
    parkHome: () => void;
    clearHome: () => void;
    motionOn: boolean;
    setMotion: (on: boolean) => void;
  },
): SettingsApi {
  const el = document.createElement("aside");
  el.className = "drawer drawer-settings";
  const head = document.createElement("div");
  head.className = "drawer-head";
  head.setAttribute("role", "button");
  head.setAttribute("tabindex", "0");
  const title = document.createElement("span");
  title.textContent = "⚙ Settings";
  const chevron = document.createElement("span");
  chevron.className = "drawer-chevron";
  chevron.textContent = "▾";
  head.append(title, chevron);
  const body = document.createElement("div");
  body.className = "drawer-body";
  el.append(head, body);

  const group = document.createElement("div");
  group.className = "settings-group";
  const groupTitle = document.createElement("div");
  groupTitle.className = "settings-group-title";
  groupTitle.textContent = "Timeline";
  group.appendChild(groupTitle);

  const storageRow = document.createElement("div");
  storageRow.className = "settings-row";
  const storageLabel = document.createElement("label");
  storageLabel.textContent = "Storage cap";
  const storageInput = document.createElement("input");
  storageInput.type = "number";
  storageInput.min = "0.5";
  storageInput.max = "1000";
  storageInput.step = "0.5";
  storageInput.setAttribute("aria-label", "Storage cap (GB)");
  const storageUnit = document.createElement("span");
  storageUnit.className = "settings-unit";
  storageUnit.textContent = "GB";
  const storageLine = document.createElement("div");
  storageLine.className = "settings-line";
  const warnLine = document.createElement("div");
  warnLine.className = "settings-line";
  storageRow.append(storageLabel, storageInput, storageUnit, storageLine, warnLine);
  group.appendChild(storageRow);

  const cacheRow = document.createElement("div");
  cacheRow.className = "settings-row";
  const cacheLabel = document.createElement("label");
  cacheLabel.textContent = "Snapshot cache";
  const cacheInput = document.createElement("input");
  cacheInput.type = "range";
  cacheInput.min = "0";
  cacheInput.max = "16";
  cacheInput.step = "1";
  cacheInput.value = "0";
  cacheInput.setAttribute("aria-label", "Snapshot cache (GB)");
  const cacheVal = document.createElement("span");
  cacheVal.className = "settings-value";
  cacheVal.textContent = "off";
  const cacheLine = document.createElement("div");
  cacheLine.className = "settings-line";
  cacheRow.append(cacheLabel, cacheInput, cacheVal, cacheLine);
  group.appendChild(cacheRow);

  const pins = document.createElement("div");
  pins.className = "settings-pins";
  pins.textContent = "(none)";
  group.appendChild(pins);

  const feedGroup = document.createElement("div");
  feedGroup.className = "settings-group";
  const feedTitle = document.createElement("div");
  feedTitle.className = "settings-group-title";
  feedTitle.textContent = "Feed rates";
  feedGroup.appendChild(feedTitle);

  const fillGroup = document.createElement("div");
  fillGroup.className = "settings-group";
  const fillTitle = document.createElement("div");
  fillTitle.className = "settings-group-title";
  fillTitle.textContent = "AIS fill";
  const homeRow = document.createElement("div");
  homeRow.className = "settings-row";
  const homeLabel = document.createElement("label");
  homeLabel.textContent = "Home tile";
  const homeVal = document.createElement("span");
  homeVal.className = "settings-value settings-home-value";
  homeVal.textContent = "not parked";
  const parkBtn = document.createElement("button");
  parkBtn.type = "button";
  parkBtn.className = "settings-btn";
  parkBtn.textContent = PARK_TEXT;
  parkBtn.addEventListener("click", () => opts.parkHome());
  const clearBtn = document.createElement("button");
  clearBtn.type = "button";
  clearBtn.className = "settings-btn";
  clearBtn.textContent = "Clear";
  clearBtn.addEventListener("click", () => opts.clearHome());
  homeRow.append(homeLabel, homeVal, parkBtn, clearBtn);
  fillGroup.append(fillTitle, homeRow);

  const displayGroup = document.createElement("div");
  displayGroup.className = "settings-group";
  const displayTitle = document.createElement("div");
  displayTitle.className = "settings-group-title";
  displayTitle.textContent = "Display";
  const motionRow = document.createElement("div");
  motionRow.className = "settings-row";
  const motionLabel = document.createElement("label");
  const motionInput = document.createElement("input");
  motionInput.type = "checkbox";
  motionInput.checked = opts.motionOn;
  motionInput.setAttribute("aria-label", "Smooth motion");
  motionInput.addEventListener("change", () => opts.setMotion(motionInput.checked));
  const motionText = document.createElement("span");
  motionText.textContent = "Smooth motion";
  motionLabel.append(motionInput, motionText);
  motionRow.appendChild(motionLabel);
  displayGroup.append(displayTitle, motionRow);

  body.append(displayGroup, feedGroup, fillGroup, group);
  root.appendChild(el);

  let collapsed = true;
  try {
    collapsed = localStorage.getItem(COLLAPSED_KEY) !== "0";
  } catch {
    collapsed = true;
  }
  el.classList.toggle("collapsed", collapsed);
  head.setAttribute("aria-expanded", String(!collapsed));
  function toggle(): void {
    collapsed = !collapsed;
    el.classList.toggle("collapsed", collapsed);
    head.setAttribute("aria-expanded", String(!collapsed));
    try {
      localStorage.setItem(COLLAPSED_KEY, collapsed ? "1" : "0");
    } catch {
      // storage unavailable
    }
  }
  head.addEventListener("click", toggle);
  head.addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === " ") {
      if (e.key === " ") e.preventDefault();
      toggle();
    }
  });

  const markStorageSent = debouncedNumber(storageInput, (v) => opts.update({ storageCapGb: v }));

  const markCacheSent = debouncedNumber(cacheInput, (v) => opts.update({ ramCacheGb: v }));

  let lastPinSig: string | null = null;
  function renderPins(list: Pin[]): void {
    const sig = list.map((p) => `${p.id}:${p.from}:${p.to}`).join("|");
    if (sig === lastPinSig) return;
    lastPinSig = sig;
    pins.replaceChildren();
    if (list.length === 0) {
      pins.textContent = "(none)";
      return;
    }
    for (const pin of list) {
      const row = document.createElement("div");
      row.className = "settings-pin-row";
      const range = document.createElement("span");
      range.textContent = formatPinRange(pin.from, pin.to);
      const rm = document.createElement("button");
      rm.type = "button";
      rm.className = "settings-pin-remove";
      rm.textContent = "×";
      rm.setAttribute("aria-label", "Remove pinned range");
      rm.addEventListener("click", () => opts.removePin(pin.id));
      row.append(range, rm);
      pins.appendChild(row);
    }
  }

  function setStats(s: SettingsStats): void {
    if (document.activeElement !== storageInput) {
      storageInput.value = String(s.storageCapGb);
      markStorageSent(s.storageCapGb);
    }
    if (document.activeElement !== cacheInput) {
      cacheInput.value = String(s.ramCacheGb);
      markCacheSent(s.ramCacheGb);
    }
    cacheVal.textContent = s.ramCacheGb === 0 ? "off" : `${s.ramCacheGb} GB`;
    storageLine.textContent = `using ${formatBytes(s.usedBytes)} (pinned ${formatBytes(s.pinnedBytes)})`;
    cacheLine.textContent = `holding ${formatBytes(s.cacheUsedBytes)}`;
    const over = s.usedBytes - s.storageCapGb * GB;
    warnLine.classList.toggle("warn", over > 0);
    warnLine.textContent = over > 0 ? `⚠ pinned data exceeds cap by ${formatBytes(over)}` : "";
    homeVal.textContent = s.homeRegion ? `${s.homeRegion.lat.toFixed(2)}, ${s.homeRegion.lon.toFixed(2)}` : "not parked";
    // No-key state is server-sourced (secondaryEnabled false), never guessed;
    // re-applied on every setStats so a later key addition re-enables it.
    const noKey = s.secondaryEnabled === false;
    parkBtn.disabled = noKey;
    parkBtn.textContent = noKey ? PARK_TEXT_NOKEY : PARK_TEXT;
    renderPins(s.pins);
  }

  return { setStats, feedRates: feedGroup };
}
