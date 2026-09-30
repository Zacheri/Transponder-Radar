import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import Fastify from "fastify";
import websocket from "@fastify/websocket";
import { config } from "./config.js";
import { CraftStore } from "./store.js";
import { OpenSkyPoller } from "./opensky.js";
import { AisClient } from "./ais.js";
import { Hub } from "./hub.js";

export interface ServerDeps {
  store?: CraftStore;
  hub?: Hub;
  opensky?: OpenSkyPoller;
  ais?: AisClient;
  log?: (msg: string) => void;
}

export async function buildApp(deps: ServerDeps = {}) {
  const log = deps.log ?? ((m: string) => console.log(`[radar] ${m}`));
  const store = deps.store ?? new CraftStore();
  const opensky =
    deps.opensky ??
    new OpenSkyPoller({ pollMs: config.OPENSKY_POLL_MS, graceMs: 30000, store, log });
  const ais = deps.ais ?? new AisClient({ apiKey: config.AISSTREAM_API_KEY, store, log });
  const hub =
    deps.hub ??
    new Hub({
      store,
      batchMs: config.BATCH_MS,
      log,
      feedStatus: () => ({
        opensky: opensky.feedStatus,
        ais: { connected: ais.isConnected, enabled: Boolean(config.AISSTREAM_API_KEY) },
      }),
    });

  const app = Fastify({ logger: false });
  await app.register(websocket);

  app.get("/ws", { websocket: true }, (socket) => {
    hub.attach(socket as any);
  });

  app.get("/health", async () => ({
    ok: true,
    craft: store.size,
    clients: hub.clientCount,
  }));

  const sweeper = setInterval(() => {
    store.sweep(Date.now(), config.STALE_MS, config.REMOVE_MS);
  }, 5000);

  hub.start();
  opensky.start();
  if (deps.ais || config.AISSTREAM_API_KEY) ais.start();
  else log("ais: AISSTREAM_API_KEY not set — vessel feed disabled");

  const stop = async () => {
    clearInterval(sweeper);
    hub.stop();
    opensky.stop();
    ais.stop();
    await app.close();
  };

  return { app, stop, store, hub, opensky, ais };
}

export function main(): void {
  buildApp()
    .then(({ app }) =>
      app.listen({ port: config.PORT, host: "127.0.0.1" }).then(() => {
        console.log(`[radar] backend on :${config.PORT}`);
      }),
    )
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
  const shutdown = () => process.exit(0);
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

const isMain =
  process.argv[1] != null && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (isMain) main();
