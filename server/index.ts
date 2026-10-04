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
import { HistoryRecorder, type HistoryRange } from "./history.js";

export interface ServerDeps {
  store?: CraftStore;
  hub?: Hub;
  opensky?: OpenSkyPoller;
  ais?: AisClient;
  recorder?: HistoryRecorder | null;
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
  let recorder: HistoryRecorder | null =
    deps.recorder === undefined
      ? new HistoryRecorder({
          dir: resolve(process.cwd(), "data/history"),
          snapshotMs: config.HISTORY_SNAPSHOT_MS,
          maxBytes: config.HISTORY_MAX_BYTES,
          log,
        })
      : deps.recorder;
  if (recorder) {
    try {
      await recorder.init();
    } catch (e) {
      log(`history: init failed — timeline rewind disabled (${e instanceof Error ? e.message : String(e)})`);
      recorder = null;
    }
  }
  const emptyRange: HistoryRange = { from: null, to: null, snapshots: 0 };
  const hub =
    deps.hub ??
    new Hub({
      store,
      batchMs: config.BATCH_MS,
      log,
      statusPayload: () => ({
        feeds: {
          opensky: opensky.feedStatus,
          ais: { connected: ais.isConnected, enabled: Boolean(config.AISSTREAM_API_KEY) },
        },
        history: recorder ? recorder.range() : emptyRange,
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
      const reply = (obj: unknown) => {
        if (ws.readyState !== ws.OPEN) return;
        try {
          ws.send(JSON.stringify(obj));
        } catch {
          /* socket closed mid-send */
        }
      };
      switch (msg.type) {
        case "poll.rate":
          opensky.setInterval(msg.ms);
          break;
        case "timeline.seek": {
          const r = recorder;
          if (!r) break;
          void r.seek(msg.time).then(
            (res) => reply({ type: "timeline.state", time: res.time, craft: res.craft }),
            (e: unknown) => {
              log(`history: seek failed: ${e instanceof Error ? e.message : String(e)}`);
              reply({ type: "timeline.state", time: null, craft: [] });
            },
          );
          break;
        }
        case "timeline.live":
          reply({ type: "snapshot", craft: store.all() });
          break;
        // "aircraft.info": wired by later tasks
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
  recorder?.start(() => store.all());
  opensky.start();
  if (deps.ais || config.AISSTREAM_API_KEY) ais.start();
  else log("ais: AISSTREAM_API_KEY not set — vessel feed disabled");

  const stop = async () => {
    clearInterval(sweeper);
    hub.stop();
    recorder?.stop();
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
