import { createMap } from "./map/map.js";
import { registerIcons } from "./map/icons.js";
import { createPackIconLoader, type PackIconLoader } from "./map/pack-icons.js";
import { addCraftSource, addCraftLayers, setCraftData } from "./map/layers.js";
import { ClientStore } from "./data/store.js";
import { RadarSocket } from "./data/ws.js";
import type { AircraftInfo } from "./data/ws.js";
import { buildFeatureCollection } from "./data/features.js";
import { buildIconFilter } from "./data/filter.js";
import { AIR_KINDS, SEA_KINDS, isPackIconName } from "../shared/craft.js";
import type { CraftKind } from "../shared/craft.js";
import { createPanel } from "./ui/panel.js";
import { createFilters } from "./ui/filters.js";
import { createHud } from "./ui/hud.js";
import { createFeedRate } from "./ui/pollrate.js";
import { createTimeline } from "./ui/timeline.js";
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

// Set after registerIcons in the map.load flow; null until then.
let packLoader: PackIconLoader | null = null;

async function refresh(): Promise<void> {
  const crafts = store.all();
  // Lazy pack registration: only names on the map are fetched. Unregistered
  // pack names fall back to the family silhouette inside buildFeatureCollection.
  let registered: ReadonlySet<string> | undefined;
  if (packLoader) {
    const packNames = new Set(crafts.map((c) => c.icon).filter((n): n is string => typeof n === "string" && isPackIconName(n)));
    registered = await packLoader.ensure(packNames);
  }
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

const wsUrl = `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws`;

let socket: RadarSocket | null = null;
const pollRate = createFeedRate(document.getElementById("app") as HTMLElement, {
  label: "Aircraft poll",
  ariaLabel: "Aircraft poll interval",
  minMs: 30000,
  maxMs: 900000,
  stepMs: 15000,
  defaultMs: 120000,
  creditsPerPoll: 4,
  send: (ms) => socket?.sendFeedRate("opensky", ms),
});
const shipRate = createFeedRate(document.getElementById("app") as HTMLElement, {
  label: "Ship updates",
  ariaLabel: "Ship update interval",
  title: "The vessel stream is continuous; this is how often the map applies vessel updates.",
  minMs: 500,
  maxMs: 15000,
  stepMs: 500,
  defaultMs: 1000,
  send: (ms) => socket?.sendFeedRate("ais", ms),
});
const replay = new ReplayGate();
const timeline = createTimeline(document.getElementById("app") as HTMLElement, {
  seek: (t) => {
    replay.enterReplay();
    hud.setReplay(t);
    socket?.sendTimelineSeek(t);
  },
  goLive: () => {
    replay.requestLive();
    socket?.sendTimelineLive();
  },
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
      }
    },
    onStatus: (s) => {
      hud.setFeeds(s.feeds, s.serverTime);
      hud.setIcons(s.icons ?? null); // ?? — pre-Task-7 frames carry no icons
      pollRate.setMs(s.feeds.opensky.pollMs);
      shipRate.setMs(s.feeds.ais.flushMs ?? 1000); // ?? — pre-Task-2 frames carry no flushMs
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
    },
    onTimelineState: (time, crafts) => {
      if (time === null) {
        replay.exitReplay();
        hud.setReplay(null);
        timeline.setLive();
        return;
      }
      store.applySnapshot(crafts);
      hud.setReplay(time);
    },
    onAircraftInfo: (id, info) => {
      infoCache.set(id, info);
      panel.setInfo(id, info);
    },
  });
  socket.connect();
  store.subscribe(() => {
    void refresh();
  });

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
    const craft = store.get(f.properties.id as string);
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
