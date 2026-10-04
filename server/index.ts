import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import { existsSync } from "node:fs";
import Fastify from "fastify";
import fastifyStatic from "@fastify/static";
import websocket from "@fastify/websocket";
import { config } from "./config.js";
import { CraftStore } from "./store.js";
import { OpenSkyPoller } from "./opensky.js";
import { createTokenProvider } from "./opensky-auth.js";
import { AisClient } from "./ais.js";
import { Hub, parseClientMessage } from "./hub.js";

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
    new OpenSkyPoller({
      pollMs: config.OPENSKY_POLL_MS,
      graceMs: 30000,
      store,
      log,
      tokenProvider:
        config.OPENSKY_CLIENT_ID && config.OPENSKY_CLIENT_SECRET
          ? createTokenProvider({
              clientId: config.OPENSKY_CLIENT_ID,
              clientSecret: config.OPENSKY_CLIENT_SECRET,
            })
          : undefined,
    });
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
    const ws = socket as any;
    hub.attach(ws);
    ws.on("message", (data: Buffer | string) => {
      const msg = parseClientMessage(data.toString());
      if (!msg) return;
      switch (msg.type) {
        case "poll.rate":
          opensky.setInterval(msg.ms);
          break;
        // "timeline.seek", "timeline.live", "aircraft.info": wired by later tasks
        default:
          break;
      }
    });
  });

  app.get("/health", async () => ({
    ok: true,
    craft: store.size,
    clients: hub.clientCount,
  }));

  const dist = resolve(process.cwd(), "dist");
  if (existsSync(dist)) {
    await app.register(fastifyStatic, { root: dist });
  } else {
    log("dist/ not found — run `npm run build` (API + WS only)");
  }

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
  let stop: (() => Promise<void>) | null = null;
  buildApp()
    .then(({ app, stop: appStop }) => {
      stop = appStop;
      return app.listen({ port: config.PORT, host: "127.0.0.1" }).then(() => {
        console.log(`[radar] backend on :${config.PORT}`);
        console.log(`[radar] open http://127.0.0.1:${config.PORT}`);
      });
    })
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
  const shutdown = () => {
    if (!stop) return process.exit(0);
    void stop().then(() => process.exit(0));
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

const isMain =
  process.argv[1] != null && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (isMain) main();
