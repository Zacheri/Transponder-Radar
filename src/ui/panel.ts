import type { Craft } from "../../shared/craft.js";
import { KINDS } from "../../shared/craft.js";

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

export function createPanel(root: HTMLElement): { show(craft: Craft): void; hide(): void } {
  const el = document.createElement("aside");
  el.className = "panel";
  const head = document.createElement("div");
  head.className = "panel-head";
  const kindEl = document.createElement("span");
  kindEl.className = "panel-kind";
  const closeBtn = document.createElement("button");
  closeBtn.className = "panel-close";
  closeBtn.setAttribute("aria-label", "Close");
  closeBtn.textContent = "×";
  head.append(kindEl, closeBtn);
  const body = document.createElement("div");
  body.className = "panel-body";
  el.append(head, body);
  root.appendChild(el);

  function show(craft: Craft): void {
    kindEl.textContent = KINDS[craft.kind].label;
    kindEl.dataset.domain = craft.domain;
    body.textContent = "";
    if (craft.domain === "air") {
      body.append(
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
    el.classList.add("open");
  }

  function hide(): void {
    el.classList.remove("open");
  }

  closeBtn.addEventListener("click", hide);
  return { show, hide };
}
