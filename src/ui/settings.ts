import { GB } from "../../shared/limits.js";
import type { Pin } from "../data/ws.js";
import { formatBytes } from "./format.js";

const COLLAPSED_KEY = "radar.settingsCollapsed";
const enDash = "\u2013";
const DATE_OPTS = { month: "short", day: "numeric" } as const;
const HHMM = { hour12: false, hour: "2-digit", minute: "2-digit" } as const;

export interface SettingsStats {
  storageCapGb: number;
  ramCacheGb: number;
  cacheUsedBytes: number;
  usedBytes: number;
  pinnedBytes: number;
  pins: Pin[];
}

export interface SettingsApi { setStats: (s: SettingsStats) => void }

function formatPinRange(pin: Pin): string {
  const start = `${new Date(pin.from).toLocaleDateString([], DATE_OPTS)} ${new Date(pin.from).toLocaleTimeString([], HHMM)}`;
  const end = new Date(pin.to).toLocaleTimeString([], HHMM);
  return `${start} ${enDash} ${end}`;
}

export function createSettings(
  root: HTMLElement,
  opts: {
    update: (patch: { storageCapGb?: number; ramCacheGb?: number }) => void;
    removePin: (id: string) => void;
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

  body.appendChild(group);
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

  let storageTimer: number | null = null;
  let storageLastSent: number | null = null;
  storageInput.addEventListener("input", () => {
    if (storageTimer != null) clearTimeout(storageTimer);
    storageTimer = window.setTimeout(() => {
      storageTimer = null;
      const v = Number(storageInput.value);
      if (storageInput.value === "" || !Number.isFinite(v) || v === storageLastSent) return;
      storageLastSent = v;
      opts.update({ storageCapGb: v });
    }, 500);
  });

  let cacheTimer: number | null = null;
  let cacheLastSent: number | null = null;
  cacheInput.addEventListener("input", () => {
    if (cacheTimer != null) clearTimeout(cacheTimer);
    cacheTimer = window.setTimeout(() => {
      cacheTimer = null;
      const v = Number(cacheInput.value);
      if (!Number.isFinite(v) || v === cacheLastSent) return;
      cacheLastSent = v;
      opts.update({ ramCacheGb: v });
    }, 500);
  });

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
      range.textContent = formatPinRange(pin);
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
      storageLastSent = s.storageCapGb;
    }
    if (document.activeElement !== cacheInput) {
      cacheInput.value = String(s.ramCacheGb);
      cacheLastSent = s.ramCacheGb;
    }
    cacheVal.textContent = s.ramCacheGb === 0 ? "off" : `${s.ramCacheGb} GB`;
    storageLine.textContent = `using ${formatBytes(s.usedBytes)} (pinned ${formatBytes(s.pinnedBytes)})`;
    cacheLine.textContent = `holding ${formatBytes(s.cacheUsedBytes)}`;
    const over = s.usedBytes - s.storageCapGb * GB;
    warnLine.classList.toggle("warn", over > 0);
    warnLine.textContent = over > 0 ? `⚠ pinned data exceeds cap by ${formatBytes(over)}` : "";
    renderPins(s.pins);
  }

  return { setStats };
}
