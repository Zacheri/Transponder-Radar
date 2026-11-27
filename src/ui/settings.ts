import { GB } from "../../shared/limits.js";
import { creditsPerDay } from "../../shared/credits.js";
import { AIR_KINDS, KINDS } from "../../shared/craft.js";
import type { AirKind, CraftKind } from "../../shared/craft.js";
import {
  AUTO_CREATE_MAX,
  AUTO_CREATE_MIN,
  clampZonesBoost,
  ZONES_BOOST_DEFAULT_MS,
  ZONES_BOOST_MAX_MS,
  ZONES_BOOST_MIN_MS,
  type ZonesCfg,
} from "./zones-cfg.js";
import {
  REGION_COLORS,
  REGION_KINDS,
  regionLabel,
  sizeDeg,
  type Region,
  type RegionBoost,
  type RegionKind,
} from "../data/regions.js";
import type { Pin } from "../data/ws.js";
import { formatBytes, formatPinRange } from "./format.js";

const COLLAPSED_KEY = "radar.settingsCollapsed";
const PARK_TEXT = "Park AIS fill tile here";
const PARK_TEXT_NOKEY = "Needs AISCAST_API_KEY";

// shared/craft declares AIR_KINDS as CraftKind[] (the filter drawer owns
// that typing); the members are air-only, narrowed here for RegionBoost.
const AIR_ONLY = AIR_KINDS as AirKind[];

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
  // BoostStatus v2 creditsToday (spec 2026-11-27 §C, memory-only). Undefined
  // until the T2 server ships → the "Y cr today" group readout stays hidden.
  boostCreditsToday?: number;
}

export interface SettingsApi {
  setStats: (s: SettingsStats) => void;
  setRegions: (regions: Region[]) => void;
  setRegionArmed: (kind: RegionKind | null) => void;
  // Ids of sections the server is polling right now (status.hotzones manual
  // entries); renders as the active/idle badge in expanded boost editors.
  setRegionActivity: (ids: Set<string>) => void;
  feedRates: HTMLElement
}

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

/**
 * Typed-number inputs commit on Enter only — an input listener posting
 * debounced keystrokes applies half-typed values (user report: it "applied
 * the first digit"). Escape and blur restore the committed value; the display
 * reformats only on a committed Enter. The returned hook records values
 * pushed in from outside (status echo) as the committed baseline.
 */
function commitOnEnter(input: HTMLInputElement, apply: (n: number) => void): (sent: number) => void {
  let committed: number | null = null;
  const restore = (): void => {
    if (committed != null) input.value = String(committed);
  };
  input.addEventListener("keydown", (e: KeyboardEvent) => {
    if (e.key === "Escape") {
      restore();
      return;
    }
    if (e.key !== "Enter") return;
    const v = Number(input.value);
    if (input.value === "" || !Number.isFinite(v)) return;
    committed = v;
    input.value = String(v);
    apply(v);
  });
  input.addEventListener("blur", restore);
  return (sent) => {
    committed = sent;
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
    onArmRegion: (kind: RegionKind | null) => void;
    removeRegion: (id: string) => void;
    // Traffic boost (spec 2026-11-27 §F): boot value for the auto controls,
    // the live-config getter (emits merge their own fields onto it so the
    // filters drawer's kinds — or anything edited elsewhere — survive), and
    // the change sink (main persists + re-sends zones.config).
    zonesInitial: ZonesCfg;
    getZones: () => ZonesCfg;
    onZonesChange: (cfg: ZonesCfg) => void;
    // One section's boost edited in its row editor; null clears the boost.
    onRegionBoost: (id: string, boost: RegionBoost | null) => void;
    // Activation-kind checkbox tint (filters' accentColor idiom); optional —
    // absent renders untinted.
    kindColor?: (kind: CraftKind) => string;
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

  // Map sections (spec 2026-11-26 §B): rows render from caller data; armed
  // state is main's (the drawer can end via Escape/blur/commit on the map),
  // so clicks only forward, and setRegionArmed is the single re-render path.
  // Traffic boost (spec 2026-11-27 §F) sits directly above them.
  //
  // Emit posture for both boost surfaces: every change merges its own fields
  // onto opts.getZones() — the LIVE config main holds — never onto a
  // creation-time snapshot, so a kinds edit in the filters drawer (or an
  // auto edit made moments ago) can never be clobbered by a stale spread.
  const zc = opts.zonesInitial;
  function emitZones(patch: Partial<ZonesCfg>): void {
    opts.onZonesChange({ ...opts.getZones(), ...patch });
  }
  const liveAuto = () => opts.getZones().auto;

  const boostGroup = document.createElement("div");
  boostGroup.className = "settings-group settings-boost-group";
  const boostTitle = document.createElement("div");
  boostTitle.className = "settings-group-title";
  boostTitle.textContent = "Traffic boost";
  const boostToday = document.createElement("span");
  boostToday.className = "settings-boost-today";
  boostTitle.appendChild(boostToday);

  const autoRow = document.createElement("div");
  autoRow.className = "settings-row";
  const autoLabel = document.createElement("label");
  const autoCb = document.createElement("input");
  autoCb.type = "checkbox";
  autoCb.checked = zc.auto.enabled;
  autoCb.setAttribute("aria-label", "Auto hot zones");
  autoCb.addEventListener("change", () => {
    emitZones({ auto: { ...liveAuto(), enabled: autoCb.checked } });
    syncAutoEnabled();
  });
  const autoText = document.createElement("span");
  autoText.textContent = "Auto hot zones";
  autoLabel.append(autoCb, autoText);
  autoRow.appendChild(autoLabel);

  const minRow = document.createElement("div");
  minRow.className = "settings-row settings-boost-min";
  const minLabel = document.createElement("label");
  minLabel.textContent = "Form when ≥ N";
  const minInput = document.createElement("input");
  minInput.type = "range";
  minInput.min = String(AUTO_CREATE_MIN);
  minInput.max = String(AUTO_CREATE_MAX);
  minInput.step = "1";
  minInput.value = String(zc.auto.createMin);
  minInput.setAttribute("aria-label", "Auto zone formation minimum");
  minInput.addEventListener("input", () => {
    const n = Number(minInput.value);
    const v = Number.isFinite(n)
      ? Math.min(AUTO_CREATE_MAX, Math.max(AUTO_CREATE_MIN, Math.round(n)))
      : zc.auto.createMin;
    minInput.value = String(v);
    minVal.textContent = String(v);
    emitZones({ auto: { ...liveAuto(), createMin: v } });
  });
  const minVal = document.createElement("span");
  minVal.className = "settings-value";
  minVal.textContent = String(zc.auto.createMin);
  minRow.append(minLabel, minInput, minVal);

  // Auto-enable off makes the formation dial meaningless: disabled + dimmed
  // (aria-disabled for AT, the class for the visual).
  function syncAutoEnabled(): void {
    const off = !autoCb.checked;
    minInput.disabled = off;
    minInput.setAttribute("aria-disabled", String(off));
    minRow.classList.toggle("settings-row-disabled", off);
  }

  // Auto poll rate — moved from the filters drawer (spec §F).
  const rateRow = document.createElement("div");
  rateRow.className = "settings-row";
  const rateLabel = document.createElement("label");
  rateLabel.textContent = "Auto poll rate";
  const rateInput = document.createElement("input");
  rateInput.type = "range";
  rateInput.min = String(ZONES_BOOST_MIN_MS);
  rateInput.max = String(ZONES_BOOST_MAX_MS);
  rateInput.step = "5000";
  rateInput.value = String(zc.boostMs);
  rateInput.setAttribute("aria-label", "Auto poll interval");
  const rateVal = document.createElement("span");
  rateVal.className = "settings-value";
  rateVal.textContent = `${zc.boostMs / 1000} s`;
  rateInput.addEventListener("input", () => {
    // Self-clamping: a programmatic out-of-range value must not leak out.
    const ms = clampZonesBoost(Number(rateInput.value));
    rateInput.value = String(ms);
    rateVal.textContent = `${ms / 1000} s`;
    emitZones({ boostMs: ms });
  });
  rateRow.append(rateLabel, rateInput, rateVal);

  // Stand-down select (timeline.ts select idiom): boosted sections gate auto.
  const sdRow = document.createElement("div");
  sdRow.className = "settings-row";
  const sdLabel = document.createElement("label");
  sdLabel.textContent = "Stand down";
  const sdSel = document.createElement("select");
  sdSel.setAttribute("aria-label", "Auto stand-down");
  const SD_OPTIONS: Array<[0 | 1 | 2, string]> = [
    [0, "never"],
    [1, "after 1 boosted section"],
    [2, "after 2 boosted sections"],
  ];
  for (const [v, label] of SD_OPTIONS) {
    const o = document.createElement("option");
    o.value = String(v);
    o.textContent = label;
    sdSel.appendChild(o);
  }
  sdSel.value = String(zc.auto.standdownAt);
  sdSel.addEventListener("change", () => {
    emitZones({ auto: { ...liveAuto(), standdownAt: Number(sdSel.value) as 0 | 1 | 2 } });
  });
  sdRow.append(sdLabel, sdSel);

  boostGroup.append(boostTitle, autoRow, minRow, rateRow, sdRow);
  syncAutoEnabled();

  const regionGroup = document.createElement("div");
  regionGroup.className = "settings-group";
  const regionTitle = document.createElement("div");
  regionTitle.className = "settings-group-title";
  regionTitle.textContent = "Map sections";
  const regionBtnRow = document.createElement("div");
  regionBtnRow.className = "settings-row";
  const regionRows = document.createElement("div");
  let armed: RegionKind | null = null;
  const regionBtns = new Map<RegionKind, HTMLButtonElement>();
  for (const kind of REGION_KINDS) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "settings-btn settings-region-arm";
    btn.textContent = `+ ${regionLabel(kind)}`;
    btn.setAttribute("aria-pressed", "false");
    btn.addEventListener("click", () => opts.onArmRegion(armed === kind ? null : kind));
    regionBtns.set(kind, btn);
    regionBtnRow.appendChild(btn);
  }
  regionGroup.append(regionTitle, regionBtnRow, regionRows);

  // 1 decimal, trimmed ("12° × 7°"); the || 0 keeps -0 from printing "-0".
  const fmtDeg = (n: number): string => {
    const s = (Math.round(n * 10) / 10 || 0).toFixed(1);
    return s.endsWith(".0") ? s.slice(0, -2) : s;
  };

  // Section boost editors (spec 2026-11-27 §F): expansion ids and the live
  // poll set are component-local — expansion is not persisted, and the
  // active/idle badge only renders once a T2 status frame has been seen
  // (activeIds stays null on legacy frames → idle-unknown, no badge).
  let lastRegions: Region[] = [];
  const expanded = new Set<string>();
  let activeIds: Set<string> | null = null;

  function renderEditor(r: Region): HTMLElement {
    const ed = document.createElement("div");
    ed.className = "settings-region-editor";
    const cur = r.boost;
    let curMs = clampZonesBoost(cur?.boostMs ?? ZONES_BOOST_DEFAULT_MS);

    const enRow = document.createElement("div");
    enRow.className = "settings-row";
    const enLabel = document.createElement("label");
    const enCb = document.createElement("input");
    enCb.type = "checkbox";
    enCb.checked = cur?.enabled ?? false;
    enCb.setAttribute("aria-label", "Enable boost");
    const enText = document.createElement("span");
    enText.textContent = "Boost this section";
    enLabel.append(enCb, enText);
    enRow.appendChild(enLabel);

    const emitBoost = (): void => {
      const next: RegionBoost = {
        enabled: enCb.checked,
        kinds: AIR_ONLY.filter((k) => kindBoxes.get(k)?.checked),
        boostMs: curMs,
      };
      // Optimistic mirror: main's round-trip through setRegions only lands
      // on the next commit/remove, and mid-slider-drag a rebuild would
      // yank the control — so keep the local copy fresh and never re-render
      // from here.
      lastRegions = lastRegions.map((x) => (x.id === r.id ? { ...x, boost: next } : x));
      opts.onRegionBoost(r.id, next);
    };

    // Activation kinds: data-boost-kind, NEVER data-kind (filters' All/None
    // querySelectorAll scopes to [data-kind]; a collision would let it
    // toggle these). Tinted through the color api, filters idiom.
    const kindBoxes = new Map<AirKind, HTMLInputElement>();
    const kindRows: HTMLElement[] = [];
    for (const k of AIR_ONLY) {
      const row = document.createElement("div");
      row.className = "settings-row settings-boost-kind";
      const cb = document.createElement("input");
      cb.type = "checkbox";
      cb.checked = cur?.kinds.includes(k) ?? false;
      cb.dataset.boostKind = k;
      if (opts.kindColor) cb.style.accentColor = opts.kindColor(k);
      cb.addEventListener("change", emitBoost);
      const txt = document.createElement("span");
      txt.textContent = KINDS[k].label;
      row.append(cb, txt);
      kindBoxes.set(k, cb);
      kindRows.push(row);
    }
    enCb.addEventListener("change", () => {
      emitBoost();
      renderReadout();
    });

    const rateRow = document.createElement("div");
    rateRow.className = "settings-row";
    const rateLbl = document.createElement("label");
    rateLbl.textContent = "Rate";
    const slider = document.createElement("input");
    slider.type = "range";
    slider.min = String(ZONES_BOOST_MIN_MS);
    slider.max = String(ZONES_BOOST_MAX_MS);
    slider.step = "5000";
    slider.value = String(curMs);
    slider.setAttribute("aria-label", "Section boost interval");
    const rateVal = document.createElement("span");
    rateVal.className = "settings-value";
    rateVal.textContent = `${curMs / 1000} s`;
    slider.addEventListener("input", () => {
      curMs = clampZonesBoost(Number(slider.value));
      slider.value = String(curMs);
      rateVal.textContent = `${curMs / 1000} s`;
      emitBoost();
      renderReadout();
    });
    rateRow.append(rateLbl, slider, rateVal);

    // Money readout: the box's own estimate at the chosen rate (cost follows
    // AREA — kinds only gate WHEN it polls, never what it costs), plus the
    // live poll badge once T2 status is in.
    const readout = document.createElement("div");
    readout.className = "settings-row settings-region-readout";
    const crText = document.createElement("span");
    const liveText = document.createElement("span");
    liveText.className = "settings-region-live";
    readout.append(crText, liveText);
    const d = sizeDeg(r);
    function renderReadout(): void {
      const est = Math.round(creditsPerDay(d.lon, d.lat, curMs));
      crText.textContent = `~${est.toLocaleString("en-US")} cr/day`;
      liveText.textContent = enCb.checked && activeIds ? (activeIds.has(r.id) ? "active" : "idle") : "";
    }
    renderReadout();

    ed.append(enRow, ...kindRows, rateRow, readout);
    return ed;
  }

  function renderRegions(): void {
    regionRows.replaceChildren();
    if (lastRegions.length === 0) {
      const hint = document.createElement("div");
      hint.className = "settings-line settings-region-empty";
      hint.textContent = "No sections yet — add one, then drag on the map.";
      regionRows.appendChild(hint);
      return;
    }
    for (const r of lastRegions) {
      const row = document.createElement("div");
      row.className = "settings-region-row";
      row.title = `${regionLabel(r.kind)} — click to remove`;
      const chip = document.createElement("span");
      chip.className = "settings-region-chip";
      chip.style.backgroundColor = REGION_COLORS[r.kind];
      const name = document.createElement("span");
      name.className = "settings-region-name";
      name.textContent = regionLabel(r.kind);
      const size = document.createElement("span");
      size.className = "settings-region-size";
      const d = sizeDeg(r);
      size.textContent = `${fmtDeg(d.lon)}° × ${fmtDeg(d.lat)}°`;
      row.append(chip, name, size);
      // Chevron on ADS-B rows only (AIS is push — nothing to fund). It stops
      // propagation because the row itself REMOVES the section.
      if (r.kind === "adsb") {
        const chev = document.createElement("button");
        chev.type = "button";
        chev.className = "settings-btn settings-region-expand";
        chev.textContent = expanded.has(r.id) ? "▾" : "▸";
        chev.setAttribute("aria-expanded", String(expanded.has(r.id)));
        chev.setAttribute("aria-label", "Boost settings");
        chev.title = "Boost settings";
        chev.addEventListener("click", (e: Event) => {
          e.stopPropagation();
          if (expanded.has(r.id)) expanded.delete(r.id);
          else expanded.add(r.id);
          renderRegions();
        });
        row.appendChild(chev);
      }
      row.addEventListener("click", () => opts.removeRegion(r.id));
      regionRows.append(row);
      if (r.kind === "adsb" && expanded.has(r.id)) regionRows.appendChild(renderEditor(r));
    }
  }

  function setRegions(regions: Region[]): void {
    for (const id of [...expanded]) if (!regions.some((r) => r.id === id)) expanded.delete(id);
    lastRegions = regions;
    renderRegions();
  }

  function setRegionActivity(ids: Set<string>): void {
    const prev = activeIds;
    if (prev && prev.size === ids.size && [...ids].every((i) => prev.has(i))) return;
    activeIds = ids;
    renderRegions();
  }

  function setRegionArmed(kind: RegionKind | null): void {
    armed = kind;
    for (const [k, btn] of regionBtns) {
      const on = k === kind;
      btn.classList.toggle("settings-btn-armed", on);
      btn.setAttribute("aria-pressed", String(on));
    }
  }

  setRegions([]);

  body.append(displayGroup, feedGroup, fillGroup, boostGroup, regionGroup, group);
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

  const markStorageSent = commitOnEnter(storageInput, (v) => opts.update({ storageCapGb: v }));

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
    // Group-level credit readout (BoostStatus v2): shown once here, never
    // per row; absent/zero (pre-T2 server) renders nothing.
    boostToday.textContent = (s.boostCreditsToday ?? 0) > 0 ? `${s.boostCreditsToday} cr today` : "";
    renderPins(s.pins);
  }

  return { setStats, setRegions, setRegionArmed, setRegionActivity, feedRates: feedGroup };
}
