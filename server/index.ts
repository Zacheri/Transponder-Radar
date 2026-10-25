import { pathToFileURL } from "node:url";
import { join, resolve } from "node:path";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import Fastify from "fastify";
import fastifyStatic from "@fastify/static";
import websocket from "@fastify/websocket";
import { config } from "./config.js";
import { CraftStore } from "./store.js";
import { OpenSkyPoller } from "./opensky.js";
import { createTokenProvider } from "./opensky-auth.js";
import { AisClient } from "./ais.js";
import { Hub, parseClientMessage, type FeedId, type StatusPayload } from "./hub.js";
import { HistoryRecorder, type HistoryRange } from "./history.js";
import { FaaLoader, type FaaProvider, type FaaRecord } from "./faa.js";
import { FaaLookup } from "./faa-lookup.js";
import { resolveAirIcon } from "./icons.js";
import { IconPack } from "./iconpack.js";
import { loadIconSources } from "./iconpack-sources.js";
import { coveredDesignators, packColor, renderCatalog, type CatalogCell } from "./icons-catalog.js";
import type { AirKind } from "../shared/craft.js";

export interface ServerDeps {
  store?: CraftStore;
  hub?: Hub;
  opensky?: OpenSkyPoller;
  ais?: AisClient;
  recorder?: HistoryRecorder | null;
  faa?: FaaProvider | null;
  // Icon pack: undefined → default construction (data/icons + pinned sources)
  // + fire-and-forget init(); null → disabled (family icons only; /icons
  // routes return empty). Same idiom as recorder/faa.
  iconPack?: IconPack | null;
  log?: (msg: string) => void;
}

export async function buildApp(deps: ServerDeps = {}) {
  const log = deps.log ?? ((m: string) => console.log(`[radar] ${m}`));
  let iconPack: IconPack | null;
  if (deps.iconPack === undefined) {
    iconPack = new IconPack({ dir: resolve(process.cwd(), "data/icons"), sources: loadIconSources(), log });
    // init() itself never throws (the catch below is defensive). Note that
    // loadIconSources() on the line above is intentionally NOT guarded: a
    // corrupt committed manifest fails the boot on purpose (fail-loud — the
    // file is committed and shape-tested).
    void iconPack.init().catch((e) => log(`iconpack: init failed — family icons only (${e instanceof Error ? e.message : String(e)})`));
  } else {
    iconPack = deps.iconPack;
  }
  const store = deps.store ?? new CraftStore();
  const faaDir = resolve(process.cwd(), "data/faa");
  const faa: FaaProvider | null =
    deps.faa === undefined
      ? new FaaLoader({ dir: faaDir, refreshMs: config.FAA_REFRESH_MS, log })
      : deps.faa;
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
      resolveIcon: faa
        ? (c) => {
            const rec = faa.lookup(c.id);
            return resolveAirIcon({
              kind: c.kind as AirKind, // poller is air-only
              callsign: c.callsign,
              faaModel: rec?.model ?? null,
              faaMfr: rec?.mfr ?? null,
              pack: iconPack?.names(),
            });
          }
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
  if (faa) void faa.init().catch((e) => log(`faa: init failed — enrichment disabled (${e instanceof Error ? e.message : String(e)})`));
  const faaLookup = faa
    ? new FaaLookup(faa, { cacheFile: join(faaDir, "enrichment.json"), log })
    : null;
  if (faaLookup) await faaLookup.init();
  const hub =
    deps.hub ??
    new Hub({
      store,
      batchMs: config.BATCH_MS,
      aisFlushMs: config.BATCH_MS, // sea window defaults to today's batch behavior
      log,
      // Annotated return type: the closure reads hub.aisFlushMs (live slider
      // value) and hub is declared via this very initializer — without the
      // annotation TS infers hub as any (circular reference).
      statusPayload: (): StatusPayload => ({
        feeds: {
          opensky: opensky.feedStatus,
          ais: {
            connected: ais.isConnected,
            enabled: Boolean(config.AISSTREAM_API_KEY),
            lastError: ais.feedStatus.lastError,
            lastMessageAt: ais.feedStatus.lastMessageAt,
            flushMs: hub.aisFlushMs,
          },
        },
        history: recorder ? recorder.range() : emptyRange,
        faa: faa?.status() ?? { state: "loading", updatedAt: null, aircraft: 0, lastError: null },
        icons: iconPack ? iconPack.status() : { state: "absent", count: 0, updatedAt: null, lastError: null },
      }),
    });

  const feedRate: Record<FeedId, (ms: number) => void> = {
    opensky: (ms) => opensky.setPollInterval(ms),
    ais: (ms) => hub.setAisFlushMs(ms),
  };

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
        case "feed.rate":
          feedRate[msg.feed]?.(msg.ms);
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
        case "aircraft.info": {
          const provider = faa;
          if (!provider) break;
          const craft = store.get(msg.id);
          void (async () => {
            let info: (FaaRecord & { source: "db" | "live" }) | null = null;
            const db = provider.lookup(msg.id);
            if (db) info = { ...db, source: "db" };
            else if (craft && faaLookup) info = await faaLookup.lookup(craft);
            reply({ type: "aircraft.info", id: msg.id, info });
          })();
          break;
        }
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

  // Icon-pack routes — registered before the fastifyStatic dist fallback
  // below so /icons/* is always answered by the API (pack disabled included),
  // not by the SPA shell's static fallback.
  // Resolvable names only (index minus vetoed) — the client loader uses this
  // to decide what to fetch; a vetoed name would 404 on /icons/:name. The
  // catalog route keeps the full index (vetoed cells stay visible there).
  app.get("/icons/list", async () => ({
    entries: (iconPack?.entries() ?? [])
      .filter((e) => iconPack && !iconPack.isVetoed(e.name))
      .map((e) => ({
        name: e.name,
        style: e.style,
        cropTopRatio: e.cropTopRatio,
        color: packColor(e.name, e.source),
      })),
  }));

  app.get("/icons/catalog", async (_req, reply) => {
    const pack = iconPack;
    const cells: CatalogCell[] = (pack?.entries() ?? []).map((e) => {
      const cell: CatalogCell = {
        name: e.name,
        title: e.title,
        license: e.license,
        style: e.style,
        color: packColor(e.name, e.source),
        vetoed: pack?.isVetoed(e.name) ?? false,
        cropTopRatio: e.cropTopRatio,
      };
      const f = pack?.fileBytes(e.name);
      if (f) {
        if (e.style === "gapfill") cell.pngDataUrl = `data:${f.contentType};base64,${f.bytes.toString("base64")}`;
        else cell.svg = f.bytes.toString("utf8");
      }
      return cell;
    });
    let staticIcons: { name: string; svg: string; color: string | null }[] = [];
    try {
      const staticDir = resolve(process.cwd(), "src", "assets", "icons");
      staticIcons = readdirSync(staticDir)
        .filter((f) => f.endsWith(".svg"))
        .sort()
        .map((f) => {
          const svg = readFileSync(join(staticDir, f), "utf8");
          const m = /fill="#([0-9a-fA-F]{6})"/.exec(svg);
          return { name: f.slice(0, -4), svg, color: m ? `#${m[1]}` : null };
        });
    } catch {
      staticIcons = [];
    }
    let gaps: { designator: string; title: string }[] = [];
    try {
      // Resolver-based coverage: a gapTarget is covered when a rule from
      // EITHER table points at a pack name present in the index.
      const covered = coveredDesignators(new Set(pack?.names() ?? []));
      gaps = loadIconSources().gapTargets.filter((g) => !covered.has(g.designator));
    } catch (e) {
      log(`iconpack: catalog gap list unavailable (${e instanceof Error ? e.message : String(e)})`);
    }
    return reply.type("text/html").send(renderCatalog({ cells, staticIcons, gaps }));
  });

  app.get("/icons/:name", async (req, reply) => {
    const f = iconPack?.fileBytes(String((req.params as { name: string }).name));
    if (!f) return reply.code(404).send({ error: "unknown icon" });
    return reply.type(f.contentType).send(f.bytes);
  });

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
    faa?.stop();
    faaLookup?.stop();
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
