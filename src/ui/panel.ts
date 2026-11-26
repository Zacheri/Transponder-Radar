import type { Craft } from "../../shared/craft.js";
import { KINDS } from "../../shared/craft.js";
import { etaMs } from "../../shared/geo.js";
import type { AircraftInfo, AirportRef, FlightRoute, TrackReply } from "../data/ws.js";

export type TrailBudget = TrackReply["budget"];

// Destination a route chip points at (fly-to target + marker payload).
export type FlightDest = { name: string; lat: number; lon: number };

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
  // Flight context (spec §F): getRoute/getBudget mirror getInfo — undefined
  // = no reply yet, null = known-none. requestTrail fires the trail refresh
  // button (manual fetch, exempt from the server's daily auto budget);
  // onDestClick fires for chips with coordinates.
  getRoute?: (id: string) => FlightRoute | null | undefined;
  getBudget?: (id: string) => TrailBudget | undefined;
  requestTrail?: (id: string) => void;
  onDestClick?: (dest: FlightDest) => void;
  // Fires when the close button hides the panel, so the owner can end the
  // trail refresh and clear the track layers (the other hide paths already
  // run in the owner).
  onClose?: () => void;
}

export function createPanel(root: HTMLElement, hooks: PanelHooks = {}): {
  show(craft: Craft): void;
  hide(): void;
  update(craft: Craft): void;
  selectedId(): string | null;
  setInfo(id: string, info: AircraftInfo | null): void;
  resetInfoRequests(ids: string[]): void;
  showContext(id: string, route: FlightRoute | null): void;
  showTrack(id: string, budget: TrailBudget): void;
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

  function chipLabel(a: AirportRef): string {
    const head = a.iata ?? a.icao ?? a.code;
    return a.city ? `${head} · ${a.city}` : head;
  }

  function chip(a: AirportRef, dir: "dep" | "arr"): HTMLSpanElement {
    const c = document.createElement("span");
    c.className = `panel-chip panel-chip-${dir}`;
    c.textContent = chipLabel(a);
    if (a.lat != null && a.lon != null && hooks.onDestClick) {
      const dest: FlightDest = { name: a.name ?? a.icao ?? a.code, lat: a.lat, lon: a.lon };
      c.classList.add("panel-chip-link");
      c.addEventListener("click", () => hooks.onDestClick?.(dest));
    }
    return c;
  }

  function noteRow(text: string): HTMLDivElement {
    const d = document.createElement("div");
    d.className = "panel-note";
    d.textContent = text;
    return d;
  }

  // Remaining-flight-time to the arrival airport, local clock. Read at render
  // time from the live craft, so it can never go stale across updates.
  function etaText(craft: Craft, route: FlightRoute): string | null {
    const arr = route.arr;
    if (!arr || arr.lat == null || arr.lon == null || craft.onGround) return null;
    const eta = etaMs(
      { lon: craft.lon, lat: craft.lat },
      { lon: arr.lon, lat: arr.lat },
      craft.speed,
      Date.now(),
    );
    if (eta === null) return null;
    const d = new Date(eta);
    const p2 = (n: number): string => String(n).padStart(2, "0");
    return `~${p2(d.getHours())}:${p2(d.getMinutes())}`;
  }

  // Route chips + trail section (spec §F): route/budget are read through
  // hooks like the FAA info; the trail refresh button always renders and
  // the budget note appears once a budget is known (R2).
  function flightRows(craft: Craft): HTMLElement[] {
    const out: HTMLElement[] = [];
    const route = hooks.getRoute?.(craft.id);
    if (route === undefined) {
      out.push(row("Route", "…"));
    } else if (route === null) {
      out.push(row("Route", "no route data"));
    } else {
      const d = document.createElement("div");
      d.className = "panel-row";
      const k = document.createElement("span");
      k.className = "panel-key";
      k.textContent = "Route";
      const v = document.createElement("span");
      v.className = "panel-val panel-chips";
      if (route.dep) v.append(chip(route.dep, "dep"));
      const sep = document.createElement("span");
      sep.className = "panel-chip-sep";
      sep.textContent = "→";
      v.append(sep);
      if (route.arr) v.append(chip(route.arr, "arr"));
      d.append(k, v);
      out.push(d, row("ETA", etaText(craft, route)));
    }
    const btn = document.createElement("button");
    btn.className = "panel-trail-refresh";
    btn.textContent = "Refresh trail";
    btn.addEventListener("click", () => hooks.requestTrail?.(craft.id));
    out.push(btn);
    const budget = hooks.getBudget?.(craft.id);
    if (budget) {
      if (budget.hard) out.push(noteRow("daily trail fetch limit reached"));
      else if (budget.autoLeft === 0) out.push(noteRow("trail auto-refresh paused (daily limit)"));
    }
    return out;
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
      body.append(...infoRows(craft), ...flightRows(craft));
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

  function showContext(id: string, _route: FlightRoute | null): void {
    if (selected && selected.id === id) render(selected);
  }

  function showTrack(id: string, _budget: TrailBudget): void {
    if (selected && selected.id === id) render(selected);
  }

  closeBtn.addEventListener("click", () => {
    hide();
    hooks.onClose?.();
  });
  return { show, hide, update, selectedId, setInfo, resetInfoRequests, showContext, showTrack };
}
