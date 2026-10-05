import type { Craft } from "../../shared/craft.js";
import { KINDS } from "../../shared/craft.js";
import type { AircraftInfo } from "../data/ws.js";

function row(label: string, value: string | number | null | undefined): HTMLDivElement {
  const d = document.createElement("div");
  d.className = "panel-row";
  const k = document.createElement("span");
  k.className = "panel-key";
  k.textContent = label;
  const v = document.createElement("span");
  v.className = "panel-val";
  v.textContent = value == null || value === "" ? "—" : String(value);
  d.append(k, v);
  return d;
}

function formatPosition(lat: number, lon: number): string {
  const latStr = `${Math.abs(lat).toFixed(4)}° ${lat >= 0 ? "N" : "S"}`;
  const lonStr = `${Math.abs(lon).toFixed(4)}° ${lon >= 0 ? "E" : "W"}`;
  return `${latStr}, ${lonStr}`;
}

function timeSince(ts: number): string {
  const s = Math.max(0, Math.floor((Date.now() - ts) / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (h > 0) return `${h} h ${m} m ago`;
  if (m > 0) return `${m} m ${sec} s ago`;
  return `${sec} s ago`;
}

export interface PanelHooks {
  getInfo?: (id: string) => AircraftInfo | null | undefined;
  requestInfo?: (id: string) => void;
}

export function createPanel(root: HTMLElement, hooks: PanelHooks = {}): {
  show(craft: Craft): void;
  hide(): void;
  update(craft: Craft): void;
  selectedId(): string | null;
  setInfo(id: string, info: AircraftInfo | null): void;
  resetInfoRequests(ids: string[]): void;
} {
  const el = document.createElement("aside");
  el.className = "panel";
  const head = document.createElement("div");
  head.className = "panel-head";
  const kindEl = document.createElement("span");
  kindEl.className = "panel-kind";
  const badgeEl = document.createElement("span");
  badgeEl.className = "panel-badge";
  const nameEl = document.createElement("span");
  nameEl.className = "panel-name";
  const closeBtn = document.createElement("button");
  closeBtn.className = "panel-close";
  closeBtn.setAttribute("aria-label", "Close");
  closeBtn.textContent = "×";
  head.append(kindEl, badgeEl, nameEl, closeBtn);
  const body = document.createElement("div");
  body.className = "panel-body";
  el.append(head, body);
  root.appendChild(el);

  let selected: Craft | null = null;
  let lastFixVal: HTMLSpanElement | null = null;
  let tick: number | null = null;
  const requestedInfo = new Set<string>();

  function infoRows(craft: Craft): HTMLDivElement[] {
    const info = hooks.getInfo?.(craft.id);
    if (info === undefined) {
      if (!requestedInfo.has(craft.id)) {
        requestedInfo.add(craft.id);
        hooks.requestInfo?.(craft.id);
      }
      return [row("Type", "…"), row("N-number", "…"), row("Owner", "…")];
    }
    if (info === null) return [row("Type", null), row("N-number", null), row("Owner", null)];
    const base = [info.mfr, info.model].filter(Boolean).join(" ");
    const typeText = base + (base && info.year ? `, ${info.year}` : "");
    const where = [info.city, info.state].filter(Boolean).join(", ");
    const ownerText = info.owner ? (where ? `${info.owner} — ${where}` : info.owner) : null;
    return [row("Type", typeText || null), row("N-number", info.nNumber), row("Owner", ownerText)];
  }

  function lastFixText(craft: Craft): string {
    return timeSince(craft.updatedAt) + (craft.stale ? " (stale)" : "");
  }

  function renderHead(craft: Craft): void {
    kindEl.textContent = KINDS[craft.kind].label;
    kindEl.dataset.domain = craft.domain;
    badgeEl.textContent = craft.domain;
    badgeEl.dataset.domain = craft.domain;
    nameEl.textContent = craft.shipName ?? craft.callsign ?? craft.id;
  }

  function renderBody(craft: Craft): void {
    const rawOpen = body.querySelector<HTMLDetailsElement>(".panel-raw")?.open ?? false;
    body.textContent = "";
    if (craft.domain === "air") {
      body.append(
        row("ID", craft.id),
        row("Callsign", craft.callsign),
        row("Altitude", craft.altitude != null ? `${Math.round(craft.altitude)} ft` : null),
        row("Speed", craft.speed != null ? `${Math.round(craft.speed)} kn` : null),
        row("Heading", craft.heading != null ? `${Math.round(craft.heading)}°` : null),
        row("Vertical rate", craft.verticalRate != null ? `${Math.round(craft.verticalRate)} fpm` : null),
        row("Squawk", craft.squawk),
        row("On ground", craft.onGround ? "yes" : "no"),
        row("SPI (military)", craft.spi ? "yes" : "no"),
        row("Origin", craft.originCountry),
      );
      body.append(...infoRows(craft));
    } else {
      body.append(
        row("Name", craft.shipName),
        row("MMSI", craft.id),
        row("IMO", craft.imo != null ? String(craft.imo) : null),
        row("Call sign", craft.callSign),
        row("Destination", craft.destination),
        row("Speed", craft.speed != null ? `${Math.round(craft.speed)} kn` : null),
        row("Heading", craft.heading != null ? `${Math.round(craft.heading)}°` : null),
        row("Nav status", craft.navStatus != null ? String(craft.navStatus) : null),
      );
    }
    body.append(row("Position", formatPosition(craft.lat, craft.lon)));
    const fixRow = row("Last fix", lastFixText(craft));
    lastFixVal = fixRow.querySelector(".panel-val") as HTMLSpanElement;
    lastFixVal.classList.toggle("stale", craft.stale);
    body.append(fixRow);
    const raw = document.createElement("details");
    raw.className = "panel-raw";
    raw.open = rawOpen;
    const summary = document.createElement("summary");
    summary.textContent = "Raw";
    const pre = document.createElement("pre");
    pre.textContent = JSON.stringify(craft, null, 2);
    raw.append(summary, pre);
    body.append(raw);
  }

  function render(craft: Craft): void {
    renderHead(craft);
    renderBody(craft);
  }

  function startTick(): void {
    stopTick();
    tick = window.setInterval(() => {
      if (selected && lastFixVal) {
        lastFixVal.textContent = lastFixText(selected);
        lastFixVal.classList.toggle("stale", selected.stale);
      }
    }, 1000);
  }

  function stopTick(): void {
    if (tick != null) {
      window.clearInterval(tick);
      tick = null;
    }
  }

  function show(craft: Craft): void {
    selected = craft;
    render(craft);
    el.classList.add("open");
    startTick();
  }

  function hide(): void {
    selected = null;
    lastFixVal = null;
    el.classList.remove("open");
    stopTick();
  }

  function update(craft: Craft): void {
    if (selected && craft.id === selected.id) {
      selected = craft;
      render(craft);
    }
  }

  function selectedId(): string | null {
    return selected ? selected.id : null;
  }

  function setInfo(id: string, _info: AircraftInfo | null): void {
    if (selected && selected.id === id) render(selected);
  }

  function resetInfoRequests(ids: string[]): void {
    for (const id of ids) requestedInfo.delete(id);
  }

  closeBtn.addEventListener("click", hide);
  return { show, hide, update, selectedId, setInfo, resetInfoRequests };
}
