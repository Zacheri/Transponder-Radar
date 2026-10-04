import { createMap } from "./map/map.js";
import { registerIcons } from "./map/icons.js";
import { addCraftSource, addCraftLayers, setCraftData } from "./map/layers.js";
import { ClientStore } from "./data/store.js";
import { RadarSocket } from "./data/ws.js";
import { buildFeatureCollection } from "./data/features.js";
import { buildIconFilter } from "./data/filter.js";
import { AIR_KINDS, SEA_KINDS } from "../shared/craft.js";
import type { CraftKind } from "../shared/craft.js";
import { createPanel } from "./ui/panel.js";
import { createFilters } from "./ui/filters.js";
import { createHud } from "./ui/hud.js";
import { createPollRate } from "./ui/pollrate.js";
import { createTimeline } from "./ui/timeline.js";
import { ReplayGate } from "./data/replay.js";

const container = document.getElementById("map");
if (!container) throw new Error("#map missing");

const map = await createMap(container);
const store = new ClientStore();
const panel = createPanel(document.getElementById("app") as HTMLElement);
const hud = createHud(document.getElementById("app") as HTMLElement);
let visible = new Set<CraftKind>([...AIR_KINDS, ...SEA_KINDS]);
let filters: { setCounts(c: Map<CraftKind, number>): void } | null = null;

function refresh(): void {
  setCraftData(map, buildFeatureCollection(store.all()));
  let air = 0;
  let sea = 0;
  const counts = new Map<CraftKind, number>();
  for (const c of store.all()) {
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
const pollRate = createPollRate(document.getElementById("app") as HTMLElement, (ms) => {
  socket?.sendPollRate(ms);
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
  addCraftSource(map);
  addCraftLayers(map, buildIconFilter(visible));
  refresh();

  socket = new RadarSocket(wsUrl, {
    onSnapshot: (crafts) => {
      replay.onSnapshot();
      if (!replay.rewound) timeline.setLive();
      store.applySnapshot(crafts);
    },
    onUpdate: (upsert, remove) => {
      if (replay.onUpdate()) store.applyUpdate(upsert, remove);
    },
    onConnection: (s) => hud.setStatus(s),
    onStatus: (s) => {
      hud.setFeeds(s.feeds, s.serverTime);
      pollRate.setPollMs(s.feeds.opensky.pollMs);
      timeline.setRange(s.history.from, s.history.to);
    },
    onTimelineState: (time, crafts) => {
      store.applySnapshot(crafts);
      hud.setReplay(time);
    },
  });
  socket.connect();
  store.subscribe(refresh);

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
