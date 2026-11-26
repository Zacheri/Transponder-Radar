import { createMap } from "./map/map.js";
import { createKindIconRegistrar, type KindIconRegistrar } from "./map/icons.js";
import { createPackIconLoader, type PackIconLoader } from "./map/pack-icons.js";
import { addCraftSource, addCraftLayers, setCraftData, setPlaybackMode } from "./map/layers.js";
import {
  addTrackLayers,
  setTrailData,
  clearTrailData,
  setPredictedData,
  clearPredicted,
  setDestMarker,
  clearDestMarker,
} from "./map/trackLayers.js";
import { addHotzoneLayer, setHotzones } from "./map/hotzone.js";
import { addAisTileLayers, setAisTileBoxes } from "./map/aisTiles.js";
import { startMotionTick } from "./map/motion.js";
import { ClientStore } from "./data/store.js";
import { RadarSocket } from "./data/ws.js";
import type { AircraftInfo, FlightRoute, TrackPoint } from "./data/ws.js";
import { buildFeatureCollection, type FeatureBuildOpts } from "./data/features.js";
import { buildIconFilter } from "./data/filter.js";
import { createCoalescedRun } from "./data/coalesce.js";
import { decodeSupported, createDecodePool, type DecodePool } from "./data/decode.js";
import { createPlaybackEngine, type PlaybackApi } from "./data/playback.js";
import { AIR_KINDS, SEA_KINDS, KIND_FALLBACK_ICON, colorKey } from "../shared/craft.js";
import type { AirKind, Craft, CraftKind } from "../shared/craft.js";
import { greatCircle, destinationPoint } from "../shared/geo.js";
import type { LonLat } from "../shared/geo.js";
import { effectiveColor, loadIconColors, saveIconColors, setKindColor, type IconColorState } from "./data/icon-colors.js";
import { loadMotion, saveMotion } from "./data/motion-cfg.js";
import {
  clampZonesBoost,
  parseZonesCfg,
  serializeZonesCfg,
  ZONES_BOOST_DEFAULT_MS,
  ZONES_CFG_KEY,
  type ZonesCfg,
} from "./ui/zones-cfg.js";
import { RAM_CACHE_GB_DEFAULT, STORAGE_CAP_GB_DEFAULT } from "../shared/limits.js";
import { createPanel, type TrailBudget } from "./ui/panel.js";
import { createFilters } from "./ui/filters.js";
import { createHud } from "./ui/hud.js";
import { createFeedRate } from "./ui/pollrate.js";
import { createTimeline } from "./ui/timeline.js";
import { DEFAULT_VIEW_SEL, computeViewWindow, parseViewSel } from "./ui/format.js";
import type { ViewSel } from "./ui/format.js";
import { createSettings, type SettingsStats } from "./ui/settings.js";
import { createTrafficPanel } from "./ui/traffic.js";
import { ReplayGate } from "./data/replay.js";
import { createBrowserTx } from "./data/browser-tx.js";

const container = document.getElementById("map");
if (!container) throw new Error("#map missing");

const map = await createMap(container);
const store = new ClientStore();
const infoCache = new Map<string, AircraftInfo | null>();
// Flight-context caches for the panel's read-through hooks (infoCache idiom).
const routeCache = new Map<string, FlightRoute | null>();
const budgetCache = new Map<string, TrailBudget>();
let lastFaaState: string | null = null;
const panel = createPanel(document.getElementById("app") as HTMLElement, {
  getInfo: (id) => infoCache.get(id),
  requestInfo: (id) => socket?.sendAircraftInfo(id),
  getRoute: (id) => routeCache.get(id),
  getBudget: (id) => budgetCache.get(id),
  requestTrail: (id) => {
    if (id === trailId) sendTrail(false); // manual fetch: exempt from the auto budget
  },
  onDestClick: (dest) => {
    setDestMarker(map, dest);
    // Right padding clears the 280 px docked panel so the marker stays visible.
    map.flyTo({ center: [dest.lon, dest.lat], zoom: Math.max(map.getZoom(), 8), padding: { right: 304 } });
  },
  onClose: () => clearTrail(),
});
const hud = createHud(document.getElementById("app") as HTMLElement);
let visible = new Set<CraftKind>([...AIR_KINDS, ...SEA_KINDS]);
let filters: { setCounts(c: Map<CraftKind, number>): void } | null = null;
// Smooth motion: live frames dead-reckon air craft ahead of their last fix
// (spec 2026-11-23-smooth-motion). Boot-restored like radar.zonesCfg — the
// drawer owns the row, main owns the flag, persistence and the repaint tick.
let motionOn = loadMotion(localStorage);
let stopMotion: (() => void) | null = null;
const settingsUi = createSettings(document.getElementById("app") as HTMLElement, {
  update: (p) => socket?.sendSettingsUpdate(p),
  removePin: (id) => socket?.sendPinRemove(id),
  parkHome: () => {
    const c = map.getCenter();
    socket?.sendSettingsUpdate({ homeRegion: { lat: c.lat, lon: c.lng } });
  },
  clearHome: () => socket?.sendSettingsUpdate({ homeRegion: null }),
  motionOn,
  setMotion: (on) => {
    motionOn = on;
    saveMotion(on, localStorage);
    syncMotionTick();
    // flush, not void refresh(): immediate, and single-flight — an in-flight
    // refresh that started motion-ON can never land after this OFF rebuild
    refreshRun.flush();
  },
});

// Set after the map.load flow; null until then.
let packLoader: PackIconLoader | null = null;
let kindRegistrar: KindIconRegistrar | null = null;
// Color-keyed names registered on the map by the last refresh(); playback
// frames reuse it instead of touching the store.
let lastRegistered: ReadonlySet<string> | undefined;
// Per-category icon colors: user overrides from localStorage over the kind
// defaults (KINDS[].color).
let iconColorState: IconColorState = loadIconColors(localStorage);
const iconColorFor = (kind: CraftKind): string => effectiveColor(kind, iconColorState);
// Playback wiring, created in the map.load flow; null until then.
// pool != null ⇔ decodeSupported() (checked once at timeline creation).
let pool: DecodePool | null = null;
let engine: PlaybackApi | null = null;
// Latest rendered playback frame (id → craft); playback frames never
// touch the store, so click/click-fallback and panel updates read this.
let lastPlayFrame: Map<string, Craft> | null = null;
// Playback metadata mirrored from status frames (defensive defaults).
let metaSnapshotMs = 60000;
let metaStaleMs = 120000;
let histFrom: number | null = null;
let histTo: number | null = null;
// User-chosen view within history; persisted. viewWindow() re-intersects it
// with histFrom/histTo on every call, so status frames refresh it for free.
let viewSel: ViewSel = parseViewSel(localStorage.getItem("radar.viewSel")) ?? DEFAULT_VIEW_SEL;
const viewWindow = () => computeViewWindow(histFrom, histTo, viewSel);
// Hot-zone boost config (spec R3): restored at boot, before the socket
// exists, so the first open can send it. main owns persistence; the drawer
// only edits the value, keeping the config's single source here.
let zonesCfg: ZonesCfg =
  parseZonesCfg(localStorage.getItem(ZONES_CFG_KEY)) ?? { kinds: [], boostMs: ZONES_BOOST_DEFAULT_MS };
zonesCfg.boostMs = clampZonesBoost(zonesCfg.boostMs);
function applyZonesCfg(cfg: ZonesCfg): void {
  zonesCfg = cfg;
  try {
    localStorage.setItem(ZONES_CFG_KEY, serializeZonesCfg(cfg));
  } catch {
    // storage unavailable
  }
  socket?.sendZonesConfig(cfg.kinds, cfg.boostMs);
}
let lastSeekT: number | null = null;
// Monotonic seek seq echoed on timeline.state replies: a reply whose seq is
// below the last applied one comes from a superseded seek and is dropped.
let seekSeq = 0;
let appliedSeekSeq = 0;
// Flight-context selection (spec §F): the air craft whose trail layers and
// credit-guarded refresh loop are active, plus the last replies the layers
// render. Seq counters mirror seekSeq/appliedSeekSeq for the two reply kinds.
let trailId: string | null = null;
let trailKind: CraftKind | null = null;
let trailPath: TrackPoint[] = [];
let trailRoute: FlightRoute | null = null;
let trackTimer: number | null = null;
let openSkyPollMs = 90000;
// Latest status mirror: gate the aiscast follow-tile sends on the server's
// real secondary-enabled field (optional chain guards pre-secondary frames).
let aiscastEnabled = false;
let trackSeq = 0;
let appliedTrackSeq = 0;
let contextSeq = 0;
let appliedContextSeq = 0;
let lastStats: SettingsStats = {
  storageCapGb: STORAGE_CAP_GB_DEFAULT,
  ramCacheGb: RAM_CACHE_GB_DEFAULT,
  cacheUsedBytes: 0,
  usedBytes: 0,
  pinnedBytes: 0,
  pins: [],
  homeRegion: null,
};

async function refresh(): Promise<void> {
  const crafts = store.all();
  // Lazy registration: only names on the map are fetched. Unregistered pack
  // names fall back to the family silhouette inside buildFeatureCollection.
  // Both registrars get the same color-keyed set (each ignores the other's
  // names); the combined ok-set is the registered set for feature building.
  let registered: ReadonlySet<string> | undefined;
  if (packLoader && kindRegistrar) {
    const keys = new Set<string>();
    for (const c of crafts) {
      const base = c.icon ?? (c.domain === "air" ? KIND_FALLBACK_ICON[c.kind as AirKind] : c.kind);
      keys.add(colorKey(base, iconColorFor(c.kind)));
    }
    const [packKeys, kindKeys] = await Promise.all([packLoader.ensure(keys), kindRegistrar.ensure(keys)]);
    registered = new Set([...packKeys, ...kindKeys]);
  }
  lastRegistered = registered;
  const opts: FeatureBuildOpts = {};
  if (registered !== undefined) {
    opts.iconRegistered = registered;
    opts.colorFor = iconColorFor;
  }
  // Motion on live frames only (gated in rewind); one shared nowMs per pass.
  if (motionOn && !replay.rewound) opts.motion = { nowMs: Date.now() };
  setCraftData(map, buildFeatureCollection(crafts, opts));
  let air = 0;
  let sea = 0;
  const counts = new Map<CraftKind, number>();
  for (const c of crafts) {
    if (c.domain === "air") air++;
    else sea++;
    counts.set(c.kind, (counts.get(c.kind) ?? 0) + 1);
  }
  hud.setCounts(air, sea);
  filters?.setCounts(counts);
  const id = panel.selectedId();
  if (id) {
    const c = store.get(id);
    if (c) panel.update(c);
    else {
      panel.hide();
      clearTrail();
    }
  }
  // Live update tick: re-anchor the prediction on the selected craft's new
  // position (FR24-follows-the-aircraft).
  if (trailId) applyTrailLayers();
}

// Store writes burst (snapshots + batched feeds); one map pass per frame.
const refreshRun = createCoalescedRun(refresh);

let lastHudFrame = 0;
let lastCountFrame = 0;

function onFrame(crafts: Craft[], t: number): void {
  lastPlayFrame = new Map(crafts.map((c) => [c.id, c]));
  setCraftData(map, buildFeatureCollection(crafts, lastRegistered !== undefined ? { iconRegistered: lastRegistered, colorFor: iconColorFor } : undefined));
  // Thumb tracks every frame; HUD and counts are throttled.
  timeline.setCursor(t);
  const nowMs = performance.now();
  if (nowMs - lastHudFrame >= 250) {
    lastHudFrame = nowMs;
    hud.setReplay(t);
  }
  if (nowMs - lastCountFrame >= 500) {
    lastCountFrame = nowMs;
    let air = 0;
    let sea = 0;
    const counts = new Map<CraftKind, number>();
    for (const c of crafts) {
      if (c.domain === "air") air++;
      else sea++;
      counts.set(c.kind, (counts.get(c.kind) ?? 0) + 1);
    }
    hud.setCounts(air, sea);
    filters?.setCounts(counts);
    // Present-only: a selected craft missing from the frame stays visible.
    const id = panel.selectedId();
    if (id) {
      const c = lastPlayFrame.get(id);
      if (c) panel.update(c);
    }
    if (trailId) applyTrailLayers(); // throttle-follow the playback cursor
  }
}

const wsUrl = `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws`;

let socket: RadarSocket | null = null;
// Browser WAN-down harvest: one instance for the page life, created at the
// first socket open and kept across reconnects (the send closure resolves
// the current socket like every other sender). Always on regardless of
// panel visibility — 5 s cadence, cheap; watch-gating the server frames is
// the panel's concern.
let browserTx: { start(): void; stop(): void } | null = null;
const pollRate = createFeedRate(settingsUi.feedRates, {
  label: "Aircraft poll",
  ariaLabel: "Aircraft poll interval",
  minMs: 30000,
  maxMs: 900000,
  stepMs: 15000,
  defaultMs: 90000,
  creditsPerPoll: 4,
  send: (ms) => socket?.sendFeedRate("opensky", ms),
});
const shipRate = createFeedRate(settingsUi.feedRates, {
  label: "Ship updates",
  ariaLabel: "Ship update interval",
  title: "The vessel stream is continuous; this is how often the map applies vessel updates.",
  minMs: 60000,
  maxMs: 600000,
  stepMs: 60000,
  defaultMs: 120000,
  send: (ms) => socket?.sendFeedRate("ais", ms),
});
const replay = new ReplayGate();

// Traffic panel (spec 2026-11-25 R6): drawer sibling docked beside settings.
// The watch flag lives here, not in the panel — the server keeps watchers in
// memory only, so every socket open re-sends the current flag (zonesCfg
// re-send idiom). Created after the socket declaration so the panel's
// creation-time watch(true) reads null instead of hitting the TDZ.
let trafficWatched = false;
const trafficUi = createTrafficPanel(document.getElementById("app") as HTMLElement, {
  watch: (on) => {
    trafficWatched = on;
    socket?.sendTrafficWatch(on);
  },
});

// Trail auto-refresh cadence: half the aircraft poll, clamped to
// [30 s, 300 s] (user ruling), re-read on every (re)start.
const trailCadence = (): number => Math.min(300_000, Math.max(30_000, openSkyPollMs / 2));

// R3: zero track sends while the panel is closed, the tab is hidden, or the
// timeline is rewound. auto=false marks the manual (budget-exempt) fetch.
function sendTrail(auto: boolean): void {
  if (trailId == null || document.hidden || replay.rewound) return;
  socket?.sendFlightTrack(trailId, ++trackSeq, auto);
}

function stopTrailTimer(): void {
  if (trackTimer != null) {
    window.clearInterval(trackTimer);
    trackTimer = null;
  }
}

// The interval runs only while a trail is selected, visible and live; call
// stopTrailTimer() first to re-create it at a new cadence (pollMs change).
function syncTrailTimer(): void {
  const run = trailId != null && !document.hidden && !replay.rewound;
  if (run && trackTimer == null) trackTimer = window.setInterval(() => sendTrail(true), trailCadence());
  else if (!run) stopTrailTimer();
}

// Live + motion on ⇒ repaint every MOTION_TICK_MS so dead-reckoned craft
// glide between polls; anything else disposes the loop (spec §B). Call it
// wherever the toggle or the rewind gate flips.
const MOTION_TICK_MS = 200;
function syncMotionTick(): void {
  const run = motionOn && !replay.rewound;
  if (run && stopMotion == null) stopMotion = startMotionTick(MOTION_TICK_MS, () => refreshRun.request());
  else if (!run && stopMotion != null) {
    stopMotion();
    stopMotion = null;
  }
}

// Rewind display cursor: the playing engine's cursor, else the last applied
// seek; null while live.
function rewindCursor(): number | null {
  if (!replay.rewound) return null;
  const eng = engine;
  return eng && eng.state !== "idle" ? eng.cursor : lastSeekT;
}

// Redraw the three track layers for the selected trail: recorded path (sliced
// to the rewind cursor while rewound) in the kind's icon color, predicted
// geometry from the current position — great-circle to the arrival airport,
// else a 20-minute heading stub (Craft.speed is knots).
function applyTrailLayers(): void {
  if (trailId == null || trailKind == null) return;
  const cursor = rewindCursor();
  const pts: LonLat[] = [];
  for (const p of trailPath) {
    if (cursor != null && p.t > cursor) break;
    pts.push({ lon: p.lon, lat: p.lat });
  }
  setTrailData(map, pts, iconColorFor(trailKind));
  const craft = lastPlayFrame?.get(trailId) ?? store.get(trailId);
  let pred: LonLat[] | null = null;
  if (craft) {
    const here = { lon: craft.lon, lat: craft.lat };
    const arr = trailRoute?.arr;
    if (arr && arr.lat != null && arr.lon != null) {
      pred = greatCircle(here, { lon: arr.lon, lat: arr.lat });
    } else if (craft.speed != null && craft.speed > 0 && craft.heading != null) {
      pred = [here, destinationPoint(here, craft.heading, craft.speed * 1852 * (20 / 60))];
    }
  }
  setPredictedData(map, pred);
}

// Close/change bump: in-flight replies for the old selection fall below the
// applied gates and are dropped (selection churn, spec Failure modes).
function bumpFlightSeqs(): void {
  appliedTrackSeq = ++trackSeq;
  appliedContextSeq = ++contextSeq;
}

// End the selected trail: stop the refresh, supersede in-flight replies and
// clear all three track sources.
function clearTrail(): void {
  if (trailId == null) return;
  trailId = null;
  trailKind = null;
  trailPath = [];
  trailRoute = null;
  stopTrailTimer();
  bumpFlightSeqs();
  clearTrailData(map);
  clearPredicted(map);
  clearDestMarker(map);
}

// Air selection: re-selecting the same craft keeps the running interval;
// anything else ends the old trail, sends flight.context + the first auto
// track, draws the prediction stub right away and schedules refreshes.
function beginTrail(craft: Craft): void {
  if (craft.domain !== "air") {
    clearTrail();
    return;
  }
  if (trailId === craft.id) return;
  clearTrail();
  trailId = craft.id;
  trailKind = craft.kind;
  socket?.sendFlightContext(craft.id, ++contextSeq);
  sendTrail(true);
  applyTrailLayers();
  syncTrailTimer();
}

// One rAF loop drives engine ticks; idempotent start (state can re-emit
// buffering/playing), self-stops when playback leaves playing/buffering.
let rafId: number | null = null;
function startPlaybackLoop(): void {
  if (rafId != null) return;
  const step = (): void => {
    const eng = engine;
    if (!eng) {
      rafId = null;
      return;
    }
    eng.tick(performance.now());
    if (eng.state === "playing" || eng.state === "buffering") rafId = requestAnimationFrame(step);
    else rafId = null;
  };
  rafId = requestAnimationFrame(step);
}

const timeline = createTimeline(document.getElementById("app") as HTMLElement, {
  seek: (t) => {
    const eng = engine;
    if (eng && eng.state !== "idle") {
      eng.stop();
      setPlaybackMode(map, false);
    }
    lastPlayFrame = null;
    lastSeekT = t;
    replay.enterReplay();
    hud.setReplay(t);
    syncTrailTimer();
    syncMotionTick();
    applyTrailLayers();
    socket?.sendTimelineSeek(t, ++seekSeq);
  },
  goLive: () => {
    const eng = engine;
    if (eng && eng.state !== "idle") {
      eng.stop();
      setPlaybackMode(map, false);
    }
    lastPlayFrame = null;
    replay.requestLive();
    socket?.sendTimelineLive();
    // The timer + full trail restore with the live snapshot (onSnapshot);
    // sends stay suppressed until then (still rewound).
  },
  play: () => {
    const eng = engine;
    if (!eng) return;
    if (eng.state === "playing" || eng.state === "buffering") {
      eng.pause();
      return;
    }
    if (histTo == null) return;
    replay.enterReplay();
    syncTrailTimer(); // R3: playback is rewind — no trail traffic
    syncMotionTick(); // …and no motion extrapolation
    setPlaybackMode(map, true);
    const t0 = eng.state === "paused" ? eng.cursor : lastSeekT ?? viewWindow()?.to ?? histTo;
    eng.start(t0);
  },
  speed: (s) => {
    const eng = engine;
    if (eng) eng.setSpeed(s);
  },
  markAdd: (f, t) => socket?.sendPinAdd(f, t),
  markRemove: (id) => socket?.sendPinRemove(id),
  playAvailable: decodeSupported(),
  viewSelect: (sel) => {
    viewSel = sel ?? DEFAULT_VIEW_SEL;
    localStorage.setItem("radar.viewSel", JSON.stringify(viewSel));
    const v = viewWindow();
    timeline.setRange(v?.from ?? null, v?.to ?? null);
  },
});

// Mirror a persisted selection (e.g. custom) into the select; preset values
// map to their option, so this is a no-op display sync for preset restores.
timeline.setViewSel(viewSel);

// R3: a hidden tab stops trail traffic; returning resumes with an immediate
// refresh plus the interval.
document.addEventListener("visibilitychange", () => {
  if (document.hidden) stopTrailTimer();
  else if (trailId) {
    sendTrail(true);
    syncTrailTimer();
  }
});

map.on("load", async () => {
  // Family/sea icons are lazy color-keyed registrations (the first refresh
  // registers the keys in use) — no start-up registration anymore.
  kindRegistrar = createKindIconRegistrar(map);
  packLoader = createPackIconLoader(map);
  addCraftSource(map);
  addCraftLayers(map, buildIconFilter(visible));
  addTrackLayers(map);
  addHotzoneLayer(map);
  addAisTileLayers(map); // after hotzone: lands above it, below craft-icons
  void refresh();

  socket = new RadarSocket(wsUrl, {
    onSnapshot: (crafts) => {
      replay.onSnapshot();
      if (!replay.rewound) timeline.setLive();
      store.applySnapshot(crafts);
      // LIVE restored (snapshot answering requestLive, or reconnect): the
      // trail interval and the unsliced trail come back with it.
      syncTrailTimer();
      syncMotionTick(); // motion resumes on LIVE restore, if toggled on
      if (trailId) {
        applyTrailLayers();
        sendTrail(true);
      }
    },
    onUpdate: (upsert, remove) => {
      if (replay.onUpdate()) store.applyUpdate(upsert, remove);
    },
    onConnection: (s) => {
      hud.setStatus(s);
      // The server keeps the zones config in memory only: re-send the local
      // config on every open (first, reconnect, server restart).
      if (s === "open") socket?.sendZonesConfig(zonesCfg.kinds, zonesCfg.boostMs);
      if (s === "open" && trafficWatched) socket?.sendTrafficWatch(true);
      if (s === "open" && !browserTx) {
        browserTx = createBrowserTx({ send: (down) => socket?.sendTrafficReport(down) });
        browserTx.start();
      }
      if (s === "open" && replay.rewound) {
        replay.exitReplay();
        hud.setReplay(null);
        timeline.setLive();
        lastPlayFrame = null;
        const eng = engine;
        if (eng && eng.state !== "idle") {
          eng.stop();
          setPlaybackMode(map, false);
        }
        syncTrailTimer();
        syncMotionTick();
      }
    },
    onStatus: (s) => {
      hud.setFeeds(s.feeds, s.serverTime);
      hud.setIcons(s.icons ?? null); // ?? — legacy frames carry no icons
      // One rect per hot zone, each in its own dominant kind's icon color
      // (<= 2, slot-stable order); empty/legacy clears them.
      setHotzones(
        map,
        (s.hotzones ?? []).map((z) => ({
          center: z.center,
          halfW: z.halfW,
          halfH: z.halfH,
          count: z.count,
          color: iconColorFor(z.kind),
        })),
      );
      // AIS fill tile outlines; boxes: [] (disabled fill) clears from status,
      // and legacy frames without boxes clear via the ?? null.
      setAisTileBoxes(map, s.feeds?.ais?.secondary?.boxes ?? null);
      aiscastEnabled = s.feeds.ais.secondary?.enabled === true;
      pollRate.setMs(s.feeds.opensky.pollMs);
      shipRate.setMs(s.feeds.ais.flushMs ?? 120000); // ?? — legacy frames carry no flushMs
      if (s.feeds.opensky.pollMs !== openSkyPollMs) {
        openSkyPollMs = s.feeds.opensky.pollMs;
        stopTrailTimer();
        syncTrailTimer(); // re-create the refresh interval at the new cadence
      }
      if (s.faa.state === "ready" && lastFaaState !== "ready") {
        const purged: string[] = [];
        for (const [id, v] of infoCache) {
          if (v === null) {
            infoCache.delete(id);
            purged.push(id);
          }
        }
        if (purged.length) panel.resetInfoRequests(purged);
      }
      lastFaaState = s.faa.state;
      metaSnapshotMs = s.history.snapshotMs ?? 60000;
      metaStaleMs = s.staleMs ?? 120000;
      histFrom = s.history.from;
      histTo = s.history.to;
      // Re-intersect the view with history on every status frame.
      const v = viewWindow();
      timeline.setRange(v?.from ?? null, v?.to ?? null);
      lastStats = {
        storageCapGb: s.settings?.storageCapGb ?? STORAGE_CAP_GB_DEFAULT,
        ramCacheGb: s.settings?.ramCacheGb ?? RAM_CACHE_GB_DEFAULT,
        cacheUsedBytes: s.settings?.cacheUsedBytes ?? 0,
        usedBytes: s.history.usedBytes ?? 0,
        pinnedBytes: s.history.pinnedBytes ?? 0,
        pins: s.pins ?? [],
        homeRegion: s.settings?.homeRegion ?? null,
        secondaryEnabled: s.feeds.ais.secondary?.enabled ?? true, // legacy absent → enabled
      };
      settingsUi.setStats(lastStats);
    },
    onTimelineState: (time, crafts, seq) => {
      const eng = engine;
      if (time === null) {
        // Seek failed: leave rewind and ask for a fresh live snapshot, as LIVE does.
        replay.exitReplay();
        hud.setReplay(null);
        timeline.setLive();
        lastPlayFrame = null;
        if (eng && eng.state !== "idle") {
          eng.stop();
          setPlaybackMode(map, false);
        }
        replay.requestLive();
        socket?.sendTimelineLive();
        syncTrailTimer(); // rewind exited immediately: trail traffic resumes
        syncMotionTick();
        return;
      }
      const s = seq ?? 0;
      if (s < appliedSeekSeq) return;
      appliedSeekSeq = s;
      lastSeekT = time;
      store.applySnapshot(crafts);
      hud.setReplay(time);
      applyTrailLayers(); // trail/prediction slice to the seek cursor
    },
    onAircraftInfo: (id, info) => {
      infoCache.set(id, info);
      panel.setInfo(id, info);
    },
    onFlightContext: (id, route, seq) => {
      const s = seq ?? 0;
      if (s < appliedContextSeq) return;
      appliedContextSeq = s;
      routeCache.set(id, route);
      if (id === trailId) {
        trailRoute = route;
        const arr = route?.arr;
        if (arr && arr.lat != null && arr.lon != null) {
          setDestMarker(map, { lon: arr.lon, lat: arr.lat, name: arr.name ?? arr.icao ?? arr.code });
        } else {
          clearDestMarker(map);
        }
        applyTrailLayers(); // prediction may switch stub → great circle
      }
      panel.showContext(id, route);
    },
    onFlightTrack: (id, reply, seq) => {
      const s = seq ?? 0;
      if (s < appliedTrackSeq) return;
      appliedTrackSeq = s;
      budgetCache.set(id, reply.budget);
      if (id === trailId) {
        trailPath = reply.path;
        applyTrailLayers();
      }
      panel.showTrack(id, reply.budget);
    },
    onPins: (pins) => {
      timeline.setPins(pins);
      lastStats.pins = pins;
      settingsUi.setStats(lastStats);
    },
    onWindowChunk: (chunk) => {
      const eng = engine;
      if (eng) eng.feed(chunk);
    },
    onTraffic: (sample) => trafficUi.update(sample),
  });
  socket.connect();

  // Engine + pool after the socket is assigned: requestWindow fires only
  // from user-initiated play, so the socket is always ready by then.
  pool = decodeSupported() ? createDecodePool() : null;
  const pl = pool; // const copy: narrowing survives into the decode closure
  engine = createPlaybackEngine({
    snapshotMs: () => metaSnapshotMs,
    staleMs: () => metaStaleMs,
    historyFrom: () => viewWindow()?.from ?? null,
    historyTo: () => viewWindow()?.to ?? null,
    requestWindow: (r) => socket?.sendTimelineWindow(r.seq, r.from, r.to, r.stride, r.maxBytes),
    decode: pl ? (b) => pl.decode(b) : () => Promise.reject(new Error("decode unsupported")),
    onFrame,
    onState: (s) => {
      timeline.setPlaying(s === "playing" || s === "buffering");
      if (s === "playing" || s === "buffering") startPlaybackLoop();
    },
    now: () => performance.now(),
  });

  store.subscribe(() => refreshRun.request());

  filters = createFilters(
    document.getElementById("app") as HTMLElement,
    visible,
    (v) => {
      visible = v;
      const f = buildIconFilter(v);
      map.setFilter("craft-icons", f);
      map.setFilter("craft-labels", f);
      map.setFilter("craft-sublabels", f);
    },
    {
      getColor: (k) => effectiveColor(k, iconColorState),
      setColor: (k, hex) => {
        iconColorState = setKindColor(iconColorState, k, hex);
        saveIconColors(iconColorState, localStorage);
        // immediate (not coalesced): closes the window where playback frames
        // would reference a color key that is not registered yet
        void refresh();
      },
    },
    { initial: zonesCfg, onZonesChange: applyZonesCfg },
  );

  map.on("click", "craft-icons", (e) => {
    const f = e.features?.[0];
    if (!f) return;
    const id = f.properties.id as string;
    const craft = lastPlayFrame?.get(id) ?? store.get(id);
    if (craft) {
      panel.show(craft);
      beginTrail(craft);
    }
  });
  map.on("click", (e) => {
    const features = map.queryRenderedFeatures(e.point, { layers: ["craft-icons"] });
    if (!features.length) {
      panel.hide();
      clearTrail();
    }
  });
  map.on("mouseenter", "craft-icons", () => {
    map.getCanvas().style.cursor = "pointer";
  });
  map.on("mouseleave", "craft-icons", () => {
    map.getCanvas().style.cursor = "";
  });

  // aiscast follow tile: push the settled viewport center, 1 s debounce,
  // only while the status says the fill feed is enabled.
  let tileTimer: number | null = null;
  map.on("moveend", () => {
    if (tileTimer != null) window.clearTimeout(tileTimer);
    tileTimer = window.setTimeout(() => {
      tileTimer = null;
      if (!aiscastEnabled || !socket) return;
      const c = map.getCenter();
      socket.sendAisTile(c.lat, c.lng);
    }, 1000);
  });
});
