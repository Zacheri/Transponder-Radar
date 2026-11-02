import { createMap } from "./map/map.js";
import { registerIcons } from "./map/icons.js";
import { createPackIconLoader, type PackIconLoader } from "./map/pack-icons.js";
import { addCraftSource, addCraftLayers, setCraftData, setPlaybackMode } from "./map/layers.js";
import { ClientStore } from "./data/store.js";
import { RadarSocket } from "./data/ws.js";
import type { AircraftInfo } from "./data/ws.js";
import { buildFeatureCollection } from "./data/features.js";
import { buildIconFilter } from "./data/filter.js";
import { createCoalescedRun } from "./data/coalesce.js";
import { decodeSupported, createDecodePool, type DecodePool } from "./data/decode.js";
import { createPlaybackEngine, type PlaybackApi } from "./data/playback.js";
import { AIR_KINDS, SEA_KINDS, isPackIconName } from "../shared/craft.js";
import type { Craft, CraftKind } from "../shared/craft.js";
import { RAM_CACHE_GB_DEFAULT } from "../shared/limits.js";
import { createPanel } from "./ui/panel.js";
import { createFilters } from "./ui/filters.js";
import { createHud } from "./ui/hud.js";
import { createFeedRate } from "./ui/pollrate.js";
import { createTimeline } from "./ui/timeline.js";
import { createSettings, type SettingsStats } from "./ui/settings.js";
import { ReplayGate } from "./data/replay.js";

const container = document.getElementById("map");
if (!container) throw new Error("#map missing");

const map = await createMap(container);
const store = new ClientStore();
const infoCache = new Map<string, AircraftInfo | null>();
let lastFaaState: string | null = null;
const panel = createPanel(document.getElementById("app") as HTMLElement, {
  getInfo: (id) => infoCache.get(id),
  requestInfo: (id) => socket?.sendAircraftInfo(id),
});
const hud = createHud(document.getElementById("app") as HTMLElement);
let visible = new Set<CraftKind>([...AIR_KINDS, ...SEA_KINDS]);
let filters: { setCounts(c: Map<CraftKind, number>): void } | null = null;
const settingsUi = createSettings(document.getElementById("app") as HTMLElement, {
  update: (p) => socket?.sendSettingsUpdate(p),
  removePin: (id) => socket?.sendPinRemove(id),
});

// Set after registerIcons in the map.load flow; null until then.
let packLoader: PackIconLoader | null = null;
// Pack names registered on the map by the last refresh(); playback frames
// reuse it instead of touching the store.
let lastRegistered: ReadonlySet<string> | undefined;
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
let lastSeekT: number | null = null;
let lastStats: SettingsStats = {
  storageCapGb: 10,
  ramCacheGb: RAM_CACHE_GB_DEFAULT,
  cacheUsedBytes: 0,
  usedBytes: 0,
  pinnedBytes: 0,
  pins: [],
};

async function refresh(): Promise<void> {
  const crafts = store.all();
  // Lazy pack registration: only names on the map are fetched. Unregistered
  // pack names fall back to the family silhouette inside buildFeatureCollection.
  let registered: ReadonlySet<string> | undefined;
  if (packLoader) {
    const packNames = new Set(crafts.map((c) => c.icon).filter((n): n is string => typeof n === "string" && isPackIconName(n)));
    registered = await packLoader.ensure(packNames);
  }
  lastRegistered = registered;
  setCraftData(map, buildFeatureCollection(crafts, registered !== undefined ? { iconRegistered: registered } : undefined));
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
    else panel.hide();
  }
}

// Store writes burst (snapshots + batched feeds); one map pass per frame.
const refreshRun = createCoalescedRun(refresh);

let lastHudFrame = 0;
let lastCountFrame = 0;

function onFrame(crafts: Craft[], t: number): void {
  lastPlayFrame = new Map(crafts.map((c) => [c.id, c]));
  setCraftData(map, buildFeatureCollection(crafts, lastRegistered !== undefined ? { iconRegistered: lastRegistered } : undefined));
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
  }
}

const wsUrl = `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws`;

let socket: RadarSocket | null = null;
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
    lastSeekT = t;
    replay.enterReplay();
    hud.setReplay(t);
    socket?.sendTimelineSeek(t);
  },
  goLive: () => {
    const eng = engine;
    if (eng && eng.state !== "idle") {
      eng.stop();
      setPlaybackMode(map, false);
    }
    replay.requestLive();
    socket?.sendTimelineLive();
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
    setPlaybackMode(map, true);
    const t0 = eng.state === "paused" ? eng.cursor : lastSeekT ?? histTo;
    eng.start(t0);
  },
  speed: (s) => {
    const eng = engine;
    if (eng) eng.setSpeed(s);
  },
  markAdd: (f, t) => socket?.sendPinAdd(f, t),
  markRemove: (id) => socket?.sendPinRemove(id),
  playAvailable: decodeSupported(),
});

map.on("load", async () => {
  try {
    await registerIcons(map);
  } catch (err) {
    console.error("icon registration failed", err);
  }
  packLoader = createPackIconLoader(map);
  addCraftSource(map);
  addCraftLayers(map, buildIconFilter(visible));
  void refresh();

  socket = new RadarSocket(wsUrl, {
    onSnapshot: (crafts) => {
      replay.onSnapshot();
      if (!replay.rewound) timeline.setLive();
      store.applySnapshot(crafts);
    },
    onUpdate: (upsert, remove) => {
      if (replay.onUpdate()) store.applyUpdate(upsert, remove);
    },
    onConnection: (s) => {
      hud.setStatus(s);
      if (s === "open" && replay.rewound) {
        replay.exitReplay();
        hud.setReplay(null);
        timeline.setLive();
        const eng = engine;
        if (eng && eng.state !== "idle") {
          eng.stop();
          setPlaybackMode(map, false);
        }
      }
    },
    onStatus: (s) => {
      hud.setFeeds(s.feeds, s.serverTime);
      hud.setIcons(s.icons ?? null); // ?? — pre-Task-7 frames carry no icons
      pollRate.setMs(s.feeds.opensky.pollMs);
      shipRate.setMs(s.feeds.ais.flushMs ?? 120000); // ?? — pre-Task-2 frames carry no flushMs
      timeline.setRange(s.history.from, s.history.to);
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
      lastStats = {
        storageCapGb: s.settings?.storageCapGb ?? 10,
        ramCacheGb: s.settings?.ramCacheGb ?? RAM_CACHE_GB_DEFAULT,
        cacheUsedBytes: s.settings?.cacheUsedBytes ?? 0,
        usedBytes: s.history.usedBytes ?? 0,
        pinnedBytes: s.history.pinnedBytes ?? 0,
        pins: s.pins ?? [],
      };
      settingsUi.setStats(lastStats);
    },
    onTimelineState: (time, crafts) => {
      const eng = engine;
      if (time === null) {
        replay.exitReplay();
        hud.setReplay(null);
        timeline.setLive();
        if (eng && eng.state !== "idle") {
          eng.stop();
          setPlaybackMode(map, false);
        }
        return;
      }
      lastSeekT = time;
      store.applySnapshot(crafts);
      hud.setReplay(time);
    },
    onAircraftInfo: (id, info) => {
      infoCache.set(id, info);
      panel.setInfo(id, info);
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
  });
  socket.connect();

  // Engine + pool after the socket is assigned: requestWindow fires only
  // from user-initiated play, so the socket is always ready by then.
  pool = decodeSupported() ? createDecodePool() : null;
  const pl = pool; // const copy: narrowing survives into the decode closure
  engine = createPlaybackEngine({
    snapshotMs: () => metaSnapshotMs,
    staleMs: () => metaStaleMs,
    historyFrom: () => histFrom,
    historyTo: () => histTo,
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

  filters = createFilters(document.getElementById("app") as HTMLElement, visible, (v) => {
    visible = v;
    const f = buildIconFilter(v);
    map.setFilter("craft-icons", f);
    map.setFilter("craft-labels", f);
    map.setFilter("craft-sublabels", f);
  });

  map.on("click", "craft-icons", (e) => {
    const f = e.features?.[0];
    if (!f) return;
    const id = f.properties.id as string;
    const craft = lastPlayFrame?.get(id) ?? store.get(id);
    if (craft) panel.show(craft);
  });
  map.on("click", (e) => {
    const features = map.queryRenderedFeatures(e.point, { layers: ["craft-icons"] });
    if (!features.length) panel.hide();
  });
  map.on("mouseenter", "craft-icons", () => {
    map.getCanvas().style.cursor = "pointer";
  });
  map.on("mouseleave", "craft-icons", () => {
    map.getCanvas().style.cursor = "";
  });
});
