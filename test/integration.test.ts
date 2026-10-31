import { describe, it, expect, beforeAll, afterAll } from "vitest";
import http from "node:http";
import { createHash } from "node:crypto";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { gunzipSync } from "node:zlib";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import WebSocket, { WebSocketServer } from "ws";
import { buildApp } from "../server/index.js";
import { CraftStore } from "../server/store.js";
import { OpenSkyPoller } from "../server/opensky.js";
import { AisClient } from "../server/ais.js";
import { Hub } from "../server/hub.js";
import { HistoryRecorder } from "../server/history.js";
import type { FaaProvider } from "../server/faa.js";
import { resolveAirIcon } from "../server/icons.js";
import { IconPack } from "../server/iconpack.js";
import type { IconSources } from "../server/iconpack-sources.js";
import type { AirKind } from "../shared/craft.js";
import type { Craft } from "../shared/craft.js";
import { PACK_COLORS } from "../shared/pack-transforms.js";
import { waitFor } from "./util.js";

const PLANE: (string | number | boolean | null)[] = [
  "ac4963", "DAL539", "United States", 1700000000, 1700000000,
  -73.7, 40.6, 10000, false, 250, 90, 10, null, 10050, "1200", false, 2,
];

const fakeFaa: FaaProvider = {
  lookup: (hex: string) =>
    hex === "ac4963"
      ? { nNumber: "N123A", year: 2001, mfr: "BOEING", model: "737-8DR", owner: "TEST LLC", city: "KANSAS CITY", state: "MO" }
      : null,
  merge: () => {},
  status: () => ({ state: "ready", updatedAt: null, aircraft: 1, lastError: null }),
  init: async () => {},
  stop: () => {},
};

// Deterministic incompressible blob (xorshift32 over a 36-char alphabet,
// ~5.2 bits/char): its gzip stays ~1:1, so a snapshot carrying one lands
// above the server's 1 MiB window clamp (phase (a) needs that margin).
function randStr(n: number): string {
  let s = 0x9e3779b9;
  const chars = "abcdefghijklmnopqrstuvwxyz0123456789";
  const out: string[] = new Array(n);
  for (let i = 0; i < n; i++) {
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    s >>>= 0;
    out[i] = chars[s % chars.length];
  }
  return out.join("");
}

describe("full pipeline (stub feeds -> hub)", () => {
  let httpServer: http.Server;
  let wsServer: WebSocketServer;
  let server: Awaited<ReturnType<typeof buildApp>>;
  let port: number;
  let hport: number;
  let wport: number;
  let current: { time: number; states: (string | number | boolean | null)[][] } = { time: 0, states: [] };
  let appTmp: string;

  beforeAll(async () => {
    // Hermetic: settings + pins files live in a tmp dir, never the live data/.
    appTmp = await mkdtemp(join(tmpdir(), "radar-it-app-"));
    httpServer = http.createServer((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(current));
    });
    await new Promise<void>((r) => httpServer.listen(0, () => r()));
    hport = (httpServer.address() as { port: number }).port;

    wsServer = new WebSocketServer({ port: 0 });
    await new Promise<void>((r) => wsServer.once("listening", () => r()));
    wport = (wsServer.address() as { port: number }).port;
    wsServer.on("connection", (socket) => {
      socket.send(JSON.stringify({
        MessageType: "ShipStaticData", MMSI: 999,
        Message: { ShipStaticData: { Name: "PIPELINE SHIP", Type: 70 } },
      }));
      socket.send(JSON.stringify({
        MessageType: "PositionReport", MMSI: 999,
        Message: { PositionReport: { Latitude: 50, Longitude: 5, Sog: 8, Cog: 180 } },
      }));
    });

    const store = new CraftStore();
    const opensky = new OpenSkyPoller({
      url: `http://127.0.0.1:${hport}/states/all`,
      pollMs: 50,
      graceMs: 30000,
      store,
      resolveIcon: (c) => {
        const rec = fakeFaa.lookup(c.id);
        return resolveAirIcon({
          kind: c.kind as AirKind,
          callsign: c.callsign,
          faaModel: rec?.model ?? null,
          faaMfr: rec?.mfr ?? null,
        });
      },
    });
    const ais = new AisClient({ url: `ws://127.0.0.1:${wport}`, apiKey: "test", store });
    const hub = new Hub({
      store,
      batchMs: 50,
      aisFlushMs: 50, // explicit: the test waits for a sea update within 3 s
      statusPayload: () => ({
        feeds: {
          opensky: opensky.feedStatus,
          ais: {
            connected: ais.isConnected,
            enabled: true,
            lastError: ais.feedStatus.lastError,
            lastMessageAt: ais.feedStatus.lastMessageAt,
            flushMs: 50, // mirrors the explicit aisFlushMs above
          },
        },
        history: { from: null, to: null, snapshots: 0, usedBytes: 0, pinnedBytes: 0, snapshotMs: 60000 },
        settings: { storageCapGb: 10, ramCacheGb: 1, cacheUsedBytes: 0 },
        pins: [],
        staleMs: 120000,
        faa: fakeFaa.status(),
        icons: { state: "absent", count: 0, updatedAt: null, lastError: null },
      }),
    });

    server = await buildApp({ store, hub, opensky, ais, recorder: null, faa: fakeFaa, iconPack: null, settingsFile: join(appTmp, "settings.json"), pinFile: join(appTmp, "pins.json") });
    await server.app.listen({ port: 0, host: "127.0.0.1" });
    port = (server.app.server.address() as { port: number }).port;
  });

  afterAll(async () => {
    await server.stop();
    await new Promise<void>((r) => httpServer.close(() => r()));
    await new Promise<void>((r) => wsServer.close(() => r()));
    await rm(appTmp, { recursive: true, force: true });
  });

  it("streams a snapshot and updates for both domains", async () => {
    current = { time: 0, states: [PLANE] };
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    const messages: any[] = [];
    ws.on("message", (d) => messages.push(JSON.parse(d.toString())));

    await waitFor(() => messages.length > 0, 3000);
    expect(messages[0].type).toBe("snapshot");

    await waitFor(() => messages.some((m) => m.type === "status"), 3000);
    const st = messages.find((m) => m.type === "status");
    expect(st.feeds.opensky.pollMs).toBeTypeOf("number");
    expect(st.history).toEqual({ from: null, to: null, snapshots: 0, usedBytes: 0, pinnedBytes: 0, snapshotMs: 60000 });

    await waitFor(
      () => messages.some((m: any) => m.type === "status" && m.feeds.ais?.lastMessageAt != null),
      3000,
    );
    const aisSt = messages.find((m: any) => m.type === "status" && m.feeds.ais?.lastMessageAt != null)!;
    expect(aisSt.feeds.ais.connected).toBe(true);
    expect(aisSt.feeds.ais.lastError).toBeNull();

    await waitFor(() => {
      const all = messages.flatMap((m) => m.upsert ?? (m.type === "snapshot" ? m.craft : []));
      return all.some((c: any) => c.id === "ac4963") && all.some((c: any) => c.id === "999");
    }, 3000);

    const all = messages.flatMap((m) => m.upsert ?? (m.type === "snapshot" ? m.craft : []));
    const plane = all.find((c: any) => c.id === "ac4963");
    const ship = all.find((c: any) => c.id === "999");
    expect(plane.domain).toBe("air");
    expect(ship.domain).toBe("sea");
    expect(ship.kind).toBe("cargo");
    expect(ship.shipName).toBe("PIPELINE SHIP");
    expect(plane.icon).toBe("narrowbody"); // fakeFaa: 737-8DR / BOEING
    expect(ship.icon).toBeUndefined(); // AIS sets no icon — client falls back
    ws.close();
  });

  it("feed.rate frame changes the effective poll interval", async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    let opened = false;
    ws.on("open", () => {
      opened = true;
    });
    await waitFor(() => opened, 3000);
    ws.send(JSON.stringify({ type: "feed.rate", feed: "opensky", ms: 60000 }));
    await waitFor(() => server.opensky.feedStatus.pollMs === 60000, 3000);
    expect(server.opensky.feedStatus.pollMs).toBe(60000);
    ws.close();
  });

  it("aircraft.info frame returns the provider record end-to-end", async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    const frames: any[] = [];
    ws.on("message", (d) => frames.push(JSON.parse(d.toString())));
    let opened = false;
    ws.on("open", () => {
      opened = true;
    });
    await waitFor(() => opened, 3000);
    ws.send(JSON.stringify({ type: "aircraft.info", id: "ac4963" }));
    await waitFor(() => frames.some((f) => f.type === "aircraft.info"), 3000);
    const infoMsg = frames.find((f) => f.type === "aircraft.info")!;
    expect(infoMsg.info.nNumber).toBe("N123A");
    expect(infoMsg.info.source).toBe("db");
    ws.close();
  });

  it("timeline.seek / timeline.live end-to-end (real recorder, incl. missing-snapshot error path)", async () => {
    const dir = await mkdtemp(join(tmpdir(), "radar-hist-it-"));
    let t = Date.now();
    const histCraft = (id: string): Craft => ({
      id, domain: "air", kind: "commercial", lat: 1, lon: 2, speed: null, heading: null, updatedAt: 0, stale: false,
    });
    const recorder = new HistoryRecorder({
      dir,
      snapshotMs: 60000,
      maxBytes: 10_000_000,
      now: () => (t += 1000),
    });
    await recorder.recordNow(() => [histCraft("h1")]);
    await recorder.recordNow(() => [histCraft("h2")]);
    const t2 = t;

    const store = new CraftStore();
    const hub = new Hub({ store, batchMs: 50 });
    const opensky = new OpenSkyPoller({
      url: `http://127.0.0.1:${hport}/states/all`,
      pollMs: 60000,
      graceMs: 30000,
      store,
    });
    const ais = new AisClient({ url: `ws://127.0.0.1:${wport}`, apiKey: "test", store });
    // Hermetic: settings + pins files share the tmp history dir (the
    // recorder's init() ignores non-snapshot files; the dir is removed below).
    const app2 = await buildApp({ store, hub, opensky, ais, recorder, faa: fakeFaa, iconPack: null, settingsFile: join(dir, "settings.json"), pinFile: join(dir, "pins.json") });
    await app2.app.listen({ port: 0, host: "127.0.0.1" });
    const port2 = (app2.app.server.address() as { port: number }).port;

    const ws = new WebSocket(`ws://127.0.0.1:${port2}/ws`);
    const messages: any[] = [];
    ws.on("message", (d) => messages.push(JSON.parse(d.toString())));
    let opened = false;
    ws.on("open", () => {
      opened = true;
    });
    await waitFor(() => opened, 3000);

    ws.send(JSON.stringify({ type: "timeline.seek", time: t2 }));
    await waitFor(() => messages.some((m) => m.type === "timeline.state"), 3000);
    const st = messages.find((m) => m.type === "timeline.state");
    expect(st.time).toBe(t2);
    expect(st.craft.map((c: any) => c.id)).toEqual(["h2"]);

    await rm(join(dir, `${t2}.json.gz`));
    ws.send(JSON.stringify({ type: "timeline.seek", time: t2 }));
    await waitFor(() => messages.filter((m) => m.type === "timeline.state").length >= 2, 3000);
    const st2 = messages.filter((m) => m.type === "timeline.state").pop();
    expect(st2.time).toBeNull();
    expect(st2.craft).toEqual([]);

    const snapsBefore = messages.filter((m) => m.type === "snapshot").length;
    ws.send(JSON.stringify({ type: "timeline.live" }));
    await waitFor(() => messages.filter((m) => m.type === "snapshot").length > snapsBefore, 3000);
    const live = messages.filter((m) => m.type === "snapshot").pop();
    expect(Array.isArray(live.craft)).toBe(true);
    expect(ws.readyState).toBe(WebSocket.OPEN);

    ws.close();
    await app2.stop();
    await rm(dir, { recursive: true, force: true });
  });

  it("pin.add with an inverted span normalizes to a pin; status echoes it; pin.remove clears both", async () => {
    const dir = await mkdtemp(join(tmpdir(), "radar-hist-it-"));
    let t = Date.now();
    const histCraft = (id: string): Craft => ({
      id, domain: "air", kind: "commercial", lat: 1, lon: 2, speed: null, heading: null, updatedAt: 0, stale: false,
    });
    const recorder = new HistoryRecorder({
      dir,
      snapshotMs: 60000,
      maxBytes: 10_000_000,
      now: () => (t += 60_000), // 60 s spacing: the full span survives MIN_PIN_MS
    });
    await recorder.recordNow(() => [histCraft("h1")]);
    const t0 = t;
    await recorder.recordNow(() => [histCraft("h2")]);
    const t1 = t;
    await recorder.recordNow(() => [histCraft("h3")]);
    const t2 = t;

    const store = new CraftStore();
    const opensky = new OpenSkyPoller({
      url: `http://127.0.0.1:${hport}/states/all`,
      pollMs: 60000,
      graceMs: 30000,
      store,
    });
    const ais = new AisClient({ url: `ws://127.0.0.1:${wport}`, apiKey: "test", store });
    const app2 = await buildApp({ store, opensky, ais, recorder, faa: fakeFaa, iconPack: null, settingsFile: join(dir, "settings.json"), pinFile: join(dir, "pins.json") });
    await app2.app.listen({ port: 0, host: "127.0.0.1" });
    const port2 = (app2.app.server.address() as { port: number }).port;

    const ws = new WebSocket(`ws://127.0.0.1:${port2}/ws`);
    const messages: any[] = [];
    ws.on("message", (d) => messages.push(JSON.parse(d.toString())));
    let opened = false;
    ws.on("open", () => {
      opened = true;
    });
    await waitFor(() => opened, 3000);

    ws.send(JSON.stringify({ type: "pin.add", from: t2, to: t0 })); // inverted full span
    await waitFor(() => messages.some((m) => m.type === "pins" && m.pins.length === 1), 3000);
    const pin = messages.find((m) => m.type === "pins" && m.pins.length === 1).pins[0];
    expect(pin.from).toBe(t0); // normalized: from < to
    expect(pin.to).toBe(t2);
    expect(pin.from <= t1 && t1 <= pin.to).toBe(true); // full span covers the middle snapshot

    await waitFor(() => messages.some((m) => m.type === "status" && m.pins.length === 1), 3000);

    ws.send(JSON.stringify({ type: "pin.remove", id: pin.id }));
    const before = messages.length;
    await waitFor(() => messages.slice(before).some((m) => m.type === "pins" && m.pins.length === 0), 3000);
    await waitFor(() => messages.slice(before).some((m) => m.type === "status" && m.pins.length === 0), 3000);

    ws.close();
    await app2.stop();
    await rm(dir, { recursive: true, force: true });
  });

  it("settings.update clamps and echoes in the next status frame; the file on disk carries the clamped values", async () => {
    const dir = await mkdtemp(join(tmpdir(), "radar-hist-it-"));
    const store = new CraftStore();
    const opensky = new OpenSkyPoller({
      url: `http://127.0.0.1:${hport}/states/all`,
      pollMs: 60000,
      graceMs: 30000,
      store,
    });
    const ais = new AisClient({ url: `ws://127.0.0.1:${wport}`, apiKey: "test", store });
    const app2 = await buildApp({ store, opensky, ais, recorder: null, faa: fakeFaa, iconPack: null, settingsFile: join(dir, "settings.json"), pinFile: join(dir, "pins.json") });
    await app2.app.listen({ port: 0, host: "127.0.0.1" });
    const port2 = (app2.app.server.address() as { port: number }).port;

    const ws = new WebSocket(`ws://127.0.0.1:${port2}/ws`);
    const messages: any[] = [];
    ws.on("message", (d) => messages.push(JSON.parse(d.toString())));
    let opened = false;
    ws.on("open", () => {
      opened = true;
    });
    await waitFor(() => opened, 3000);

    ws.send(JSON.stringify({ type: "settings.update", patch: { storageCapGb: 0.0001, ramCacheGb: 99 } }));
    await waitFor(
      () =>
        messages.some(
          (m) => m.type === "status" && m.settings?.storageCapGb === 0.5 && m.settings?.ramCacheGb === 16,
        ),
      3000,
    );

    // persistSettingsDoc is fire-and-forget: bounded-poll the file.
    const settingsPath = join(dir, "settings.json");
    await waitFor(() => {
      try {
        const doc = JSON.parse(readFileSync(settingsPath, "utf8")) as { storageCapGb?: number; ramCacheGb?: number };
        return doc.storageCapGb === 0.5 && doc.ramCacheGb === 16;
      } catch {
        return false;
      }
    }, 3000);

    ws.close();
    await app2.stop();
    await rm(dir, { recursive: true, force: true });
  });

  it("timeline.window streams byte-budgeted chunks: sub-item budget, multi-chunk, and stride sampling", async () => {
    const dir = await mkdtemp(join(tmpdir(), "radar-hist-it-"));
    let t = Date.now();
    const blob = randStr(2_500_000);
    const histCraft = (id: string): Craft => ({
      id, domain: "air", kind: "commercial", lat: 1, lon: 2, speed: null, heading: null, updatedAt: 0, stale: false,
      callsign: blob,
    });
    const recorder = new HistoryRecorder({
      dir,
      snapshotMs: 60000,
      maxBytes: 10_000_000,
      now: () => (t += 1000),
    });
    await recorder.recordNow(() => [histCraft("h1")]);
    const t0 = t;
    await recorder.recordNow(() => [histCraft("h2")]);
    const t1 = t;
    await recorder.recordNow(() => [histCraft("h3")]);
    const t2 = t;
    await recorder.recordNow(() => [histCraft("h4")]);
    const t3 = t;

    // Above the server's 1 MiB window clamp: phase (a)'s sub-item budget survives the clamp.
    const itemGz = (await readFile(join(dir, `${t0}.json.gz`))).length;
    expect(itemGz).toBeGreaterThan(1 << 20);

    const store = new CraftStore();
    const opensky = new OpenSkyPoller({
      url: `http://127.0.0.1:${hport}/states/all`,
      pollMs: 60000,
      graceMs: 30000,
      store,
    });
    const ais = new AisClient({ url: `ws://127.0.0.1:${wport}`, apiKey: "test", store });
    const app2 = await buildApp({ store, opensky, ais, recorder, faa: fakeFaa, iconPack: null, settingsFile: join(dir, "settings.json"), pinFile: join(dir, "pins.json") });
    await app2.app.listen({ port: 0, host: "127.0.0.1" });
    const port2 = (app2.app.server.address() as { port: number }).port;

    const ws = new WebSocket(`ws://127.0.0.1:${port2}/ws`);
    const messages: any[] = [];
    ws.on("message", (d) => messages.push(JSON.parse(d.toString())));
    let opened = false;
    ws.on("open", () => {
      opened = true;
    });
    await waitFor(() => opened, 3000);

    const chunks = (seq: number) => messages.filter((m) => m.type === "timeline.window.chunk" && m.seq === seq);

    // (a) maxBytes strictly smaller than one item's gz size → first item only.
    ws.send(JSON.stringify({ type: "timeline.window", seq: 1, from: t0, to: t3, stride: 1, maxBytes: itemGz - 1 }));
    await waitFor(() => chunks(1).some((m) => m.done), 3000);
    const a = chunks(1);
    expect(a).toHaveLength(1);
    expect(a[0].items.map((i: any) => i.ts)).toEqual([t0]);
    expect(a[0].done).toBe(true);
    expect(a[0].reachedTo).toBe(t0);

    // (b) big budget, stride 1 → all four items, 3 per chunk, round-tripping.
    ws.send(JSON.stringify({ type: "timeline.window", seq: 2, from: t0, to: t3, stride: 1, maxBytes: 10_000_000 }));
    await waitFor(() => chunks(2).some((m) => m.done), 3000);
    const b = chunks(2);
    expect(b).toHaveLength(2);
    expect(b[0].items.map((i: any) => i.ts)).toEqual([t0, t1, t2]);
    expect(b[0].done).toBe(false);
    expect(b[0].reachedTo).toBeNull();
    expect(b[1].items.map((i: any) => i.ts)).toEqual([t3]);
    expect(b[1].done).toBe(true);
    expect(b[1].reachedTo).toBe(t3);
    const allB = [...b[0].items, ...b[1].items];
    const expectedIds = ["h1", "h2", "h3", "h4"];
    allB.forEach((item: any, i: number) => {
      const decoded = JSON.parse(gunzipSync(Buffer.from(item.b64, "base64")).toString("utf8")) as Craft[];
      expect(decoded.map((c) => c.id)).toEqual([expectedIds[i]]);
    });

    // (c) stride 2 → t0, t2 only.
    ws.send(JSON.stringify({ type: "timeline.window", seq: 3, from: t0, to: t3, stride: 2, maxBytes: 10_000_000 }));
    await waitFor(() => chunks(3).some((m) => m.done), 3000);
    const c = chunks(3);
    expect(c).toHaveLength(1);
    expect(c[0].items.map((i: any) => i.ts)).toEqual([t0, t2]);
    expect(c[0].done).toBe(true);
    expect(c[0].reachedTo).toBe(t2);

    ws.close();
    await app2.stop();
    await rm(dir, { recursive: true, force: true });
  });
});

describe("icon pack routes (fixture pack)", () => {
  // Same fixture-dir pattern as test/iconpack.test.ts, with one extra rk
  // silhouette (BAZ) so /icons/:name and the catalog have a line cell.
  const PW_SHA = "3d41c9a2f7e6b8d0a1c2b3d4e5f60718293a4b5c"; // 40-hex fixture sha
  const RK_SHA = "a1b2c3d4e5f60718293a4b5c6d7e8f9012345678"; // 40-hex fixture sha
  const QUX_BYTES = Buffer.from("qux-png-bytes\n");
  const QUX_SHA = createHash("sha256").update(QUX_BYTES).digest("hex");
  const FIXTURE_SOURCES: IconSources = {
    pw: { repo: "plane-watch/pw-silhouettes", sha: PW_SHA, license: "pw license", attribution: "pw attribution" },
    rk: { repo: "RexKramer1/AircraftShapesSVG", sha: RK_SHA, license: "rk license", attribution: "rk attribution" },
    pd: [
      {
        name: "pd:QUX",
        file: "pd/QUX.png",
        url: "https://example.com/QUX.png",
        sha256: QUX_SHA,
        title: "Qux Aircraft",
        license: "Public Domain (US Government work)",
        attribution: "Test Author",
        cropTopRatio: 0.5,
      },
    ],
    gapTargets: [],
  };

  let fix: string;
  let dir: string;
  let appTmp: string;
  let fixturePack: IconPack;
  let server: Awaited<ReturnType<typeof buildApp>>;
  let port: number;

  beforeAll(async () => {
    // Hermetic: settings + pins files live in a tmp dir, never the live data/.
    appTmp = mkdtempSync(join(tmpdir(), "radar-iconpack-it-app-"));
    fix = mkdtempSync(join(tmpdir(), "radar-iconpack-it-fix-"));
    const airframes = join(fix, "plane-watch", "airframes");
    const silhouettes = join(fix, "plane-watch", "silhouettes");
    const rk = join(fix, "rk");
    const pd = join(fix, "pd");
    mkdirSync(airframes, { recursive: true });
    mkdirSync(silhouettes, { recursive: true });
    mkdirSync(rk, { recursive: true });
    mkdirSync(pd, { recursive: true });
    writeFileSync(join(airframes, "FOO.json"), JSON.stringify({ icao: { designator: "FOO" } }));
    writeFileSync(join(silhouettes, "FOO-1.svg"), '<svg><path style="fill:#ffffff"/></svg>');
    writeFileSync(join(rk, "BAZ.svg"), '<svg><title>BAZ Title</title><g><path d="M0 0"/></g></svg>');
    writeFileSync(join(pd, "QUX.png"), QUX_BYTES);

    dir = mkdtempSync(join(tmpdir(), "radar-iconpack-it-"));
    fixturePack = new IconPack({
      dir,
      sources: FIXTURE_SOURCES,
      transport: {
        async cloneRepo(repo: string, _sha: string, destDir: string) {
          cpSync(join(fix, repo.includes("plane-watch") ? "plane-watch" : "rk"), destDir, { recursive: true });
        },
        async fetchFile(_url: string, destPath: string, sha256: string) {
          const bytes = readFileSync(join(fix, "pd/QUX.png"));
          const got = createHash("sha256").update(bytes).digest("hex");
          if (got !== sha256) throw new Error(`sha256 mismatch: expected ${sha256}, got ${got}`);
          mkdirSync(dirname(destPath), { recursive: true });
          writeFileSync(destPath, bytes);
        },
      },
    });
    await fixturePack.init();
    expect(fixturePack.status().state).toBe("ready");

    const store = new CraftStore();
    const hub = new Hub({
      store,
      batchMs: 50,
      aisFlushMs: 50, // mirrors the status fixture below (icons app; no timing dependence)
      statusPayload: () => ({
        feeds: {
          opensky: { lastOkAt: null, lastError: null, pollMs: 120000 },
          ais: { connected: false, enabled: false, lastError: null, lastMessageAt: null, flushMs: 50 },
        },
        history: { from: null, to: null, snapshots: 0, usedBytes: 0, pinnedBytes: 0, snapshotMs: 60000 },
        settings: { storageCapGb: 10, ramCacheGb: 1, cacheUsedBytes: 0 },
        pins: [],
        staleMs: 120000,
        faa: { state: "loading", updatedAt: null, aircraft: 0, lastError: null },
        icons: fixturePack.status(),
      }),
    });
    // Stub feed clients: the pack routes + hub are what's under test; pointing
    // the real pollers anywhere would risk network access (hermetic test).
    const noPoller = {
      feedStatus: { lastOkAt: null, lastError: null, pollMs: 120000 },
      setPollInterval: () => {},
      start: () => {},
      stop: () => {},
    } as unknown as OpenSkyPoller;
    const noAis = {
      isConnected: false,
      feedStatus: { lastError: null, lastMessageAt: null },
      start: () => {},
      stop: () => {},
    } as unknown as AisClient;
    server = await buildApp({ store, hub, opensky: noPoller, ais: noAis, recorder: null, faa: null, iconPack: fixturePack, settingsFile: join(appTmp, "settings.json"), pinFile: join(appTmp, "pins.json") });
    await server.app.listen({ port: 0, host: "127.0.0.1" });
    port = (server.app.server.address() as { port: number }).port;
  });

  afterAll(async () => {
    await server.stop();
    rmSync(appTmp, { recursive: true, force: true });
    rmSync(fix, { recursive: true, force: true });
    rmSync(dir, { recursive: true, force: true });
  });

  it("GET /icons/list returns entries with style, cropTopRatio, and color", async () => {
    const res = await server.app.inject({ url: "/icons/list" });
    expect(res.statusCode).toBe(200);
    const { entries } = res.json() as {
      entries: { name: string; style: string; cropTopRatio?: number; color: string }[];
    };
    expect(entries.map((e) => e.name).sort()).toEqual(["pd:QUX", "pw:FOO", "rk:BAZ"]);
    for (const e of entries) expect([PACK_COLORS.military, PACK_COLORS.civil]).toContain(e.color);
    const qux = entries.find((e) => e.name === "pd:QUX")!;
    expect(qux.style).toBe("gapfill");
    expect(qux.cropTopRatio).toBe(0.5);
    const foo = entries.find((e) => e.name === "pw:FOO")!;
    expect(foo.style).toBe("filled");
    expect(foo.cropTopRatio).toBeUndefined();
  });

  it("GET /icons/:name serves file bytes with the right content type; unknown names 404", async () => {
    const res = await server.app.inject({ url: "/icons/rk%3ABAZ" });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toContain("image/svg+xml");
    const qux = await server.app.inject({ url: "/icons/pd%3AQUX" });
    expect(qux.statusCode).toBe(200);
    expect(qux.headers["content-type"]).toContain("image/png");
    const nope = await server.app.inject({ url: "/icons/nope" });
    expect(nope.statusCode).toBe(404);
  });

  it("GET /icons/catalog is 200 text/html and lists names and gaps", async () => {
    const res = await server.app.inject({ url: "/icons/catalog" });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toContain("text/html");
    const html = res.body;
    expect(html).toContain("pw:FOO");
    expect(html).toContain("rk:BAZ");
    expect(html).toContain("pd:QUX");
    expect(html).toContain("Boeing E-4"); // real sources file: E4 has no art
  });

  it("status frame carries the icons block from the pack", async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    const messages: any[] = [];
    ws.on("message", (d) => messages.push(JSON.parse(d.toString())));
    await waitFor(() => messages.some((m) => m.type === "status"), 3000);
    const st = messages.find((m) => m.type === "status")!;
    expect(st.icons.state).toBe("ready");
    expect(st.icons.count).toBe(3);
    ws.close();
  });

  it("vetoed name 404s at the route and drops out of /icons/list", async () => {
    // Last test in the suite on purpose: it mutates the pack (exclude.json +
    // re-init) after the tests above have pinned the no-veto behavior.
    writeFileSync(join(dir, "exclude.json"), JSON.stringify({ vetoed: ["rk:BAZ"] }));
    await fixturePack.init(); // pins verified → rebuild from disk, reloads exclude.json
    expect(fixturePack.status().count).toBe(2);

    const vetoed = await server.app.inject({ url: "/icons/rk%3ABAZ" });
    expect(vetoed.statusCode).toBe(404);

    const list = await server.app.inject({ url: "/icons/list" });
    expect(list.statusCode).toBe(200);
    const { entries } = list.json() as { entries: { name: string }[] };
    expect(entries.map((e) => e.name).sort()).toEqual(["pd:QUX", "pw:FOO"]);

    const ok = await server.app.inject({ url: "/icons/pw%3AFOO" });
    expect(ok.statusCode).toBe(200); // non-vetoed names still resolve
  });
});
