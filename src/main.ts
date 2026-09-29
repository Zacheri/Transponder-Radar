import { createMap } from "./map/map.js";
import { registerIcons } from "./map/icons.js";

const container = document.getElementById("map");
if (container) {
  const map = createMap(container);
  map.on("load", () => {
    registerIcons(map).catch((e) => console.error("icon load failed", e));
  });
}
