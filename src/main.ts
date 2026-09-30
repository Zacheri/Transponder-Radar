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

const container = document.getElementById("map");
if (!container) throw new Error("#map missing");

const map = createMap(container);
const store = new ClientStore();
const panel = createPanel(document.getElementById("app") as HTMLElement);
const hud = createHud(document.getElementById("app") as HTMLElement);
let visible = new Set<CraftKind>([...AIR_KINDS, ...SEA_KINDS]);

function refresh(): void {
  setCraftData(map, buildFeatureCollection(store.all()));
  let air = 0;
  let sea = 0;
  for (const c of store.all()) {
    if (c.domain === "air") air++;
    else sea++;
  }
  hud.setCounts(air, sea);
}

const wsUrl = `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws`;

map.on("load", async () => {
  try {
    await registerIcons(map);
  } catch (err) {
    console.error("icon registration failed", err);
  }
  addCraftSource(map);
  addCraftLayers(map, buildIconFilter(visible));
  refresh();

  const socket = new RadarSocket(wsUrl, {
    onSnapshot: (crafts) => {
      store.applySnapshot(crafts);
      refresh();
    },
    onUpdate: (upsert, remove) => {
      store.applyUpdate(upsert, remove);
      refresh();
    },
    onFeeds: (feeds, t) => hud.setFeeds(feeds, t),
    onStatus: (s) => hud.setStatus(s),
  });
  socket.connect();
  store.subscribe(refresh);

  createFilters(document.getElementById("app") as HTMLElement, visible, (v) => {
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
