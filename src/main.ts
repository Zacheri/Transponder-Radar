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

const container = document.getElementById("map");
if (!container) throw new Error("#map missing");

const map = createMap(container);
const store = new ClientStore();
const panel = createPanel(document.getElementById("app") as HTMLElement);
const visible = new Set<CraftKind>([...AIR_KINDS, ...SEA_KINDS]);

function refresh(): void {
  setCraftData(map, buildFeatureCollection(store.all()));
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
  });
  socket.connect();
  store.subscribe(refresh);

  map.on("click", "craft-icons", (e) => {
    const f = e.features?.[0];
    if (!f) return;
    const craft = store.get(f.properties.id as string);
    if (craft) panel.show(craft);
  });
  map.on("mouseenter", "craft-icons", () => {
    map.getCanvas().style.cursor = "pointer";
  });
  map.on("mouseleave", "craft-icons", () => {
    map.getCanvas().style.cursor = "";
  });
});
