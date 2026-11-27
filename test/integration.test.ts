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
import { boxesFor, type BoundingBoxes } from "../server/ais-tiles.js";
import { resolveAirIcon } from "../server/icons.js";
import { IconPack } from "../server/iconpack.js";
import type { IconSources } from "../server/iconpack-sources.js";
import type { AirKind } from "../shared/craft.js";
import type { Craft } from "../shared/craft.js";
import { PACK_COLORS } from "../shared/pack-transforms.js";
import { sleep, waitFor } from "./util.js";

const PLANE: (string | number | boolean | null)[] = [
  "ac4963", "DAL539", "United States", 1700000000, 1700000000,
  -73.7, 40.6, 10000, false, 250, 90, 10, null, 10050, "1200", false, 2,
];

// Test-seam fetch for the airports/routes/tracks services: never hits the
// network; the services degrade deterministically (none/history/null sources).
const offline: typeof fetch = async () => {
  throw new Error("offline test");
};

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
            secondary: { enabled: false, connected: false, lastError: null, lastMessageAt: null, attributions: [] },
          },
        },
        history: { from: null, to: null, snapshots: 0, usedBytes: 0, pinnedBytes: 0, snapshotMs: 60000 },
        settings: { storageCapGb: 10, ramCacheGb: 1, cacheUsedBytes: 0, homeRegion: null },
        pins: [],
        staleMs: 120000,
        faa: fakeFaa.status(),
        icons: { state: "absent", count: 0, updatedAt: null, lastError: null },
        hotzones: [],
      }),
    });

    server = await buildApp({ store, hub, opensky, ais, recorder: null, faa: fakeFaa, iconPack: null, fetchImpl: offline, settingsFile: join(appTmp, "settings.json"), pinFile: join(appTmp, "pins.json") });
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
    const app2 = await buildApp({ store, hub, opensky, ais, recorder, faa: fakeFaa, iconPack: null, fetchImpl: offline, settingsFile: join(dir, "settings.json"), pinFile: join(dir, "pins.json") });
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
    const app2 = await buildApp({ store, opensky, ais, recorder, faa: fakeFaa, iconPack: null, fetchImpl: offline, settingsFile: join(dir, "settings.json"), pinFile: join(dir, "pins.json") });
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
    const app2 = await buildApp({ store, opensky, ais, recorder: null, faa: fakeFaa, iconPack: null, fetchImpl: offline, settingsFile: join(dir, "settings.json"), pinFile: join(dir, "pins.json") });
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
    const app2 = await buildApp({ store, opensky, ais, recorder, faa: fakeFaa, iconPack: null, fetchImpl: offline, settingsFile: join(dir, "settings.json"), pinFile: join(dir, "pins.json") });
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
        th: 200,
      },
      {
        name: "pd:WUZ",
        file: "pd/WUZ.png",
        url: "https://example.com/WUZ.png",
        sha256: QUX_SHA,
        title: "Wuz Aircraft",
        license: "Public Domain (US Government work)",
        attribution: "Test Author",
        crop: { x: 0.5, y: 0, w: 0.5, h: 0.6 },
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
          ais: { connected: false, enabled: false, lastError: null, lastMessageAt: null, flushMs: 50, secondary: { enabled: false, connected: false, lastError: null, lastMessageAt: null, attributions: [] } },
        },
        history: { from: null, to: null, snapshots: 0, usedBytes: 0, pinnedBytes: 0, snapshotMs: 60000 },
        settings: { storageCapGb: 10, ramCacheGb: 1, cacheUsedBytes: 0, homeRegion: null },
        pins: [],
        staleMs: 120000,
        faa: { state: "loading", updatedAt: null, aircraft: 0, lastError: null },
        icons: fixturePack.status(),
        hotzones: [],
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
    server = await buildApp({ store, hub, opensky: noPoller, ais: noAis, recorder: null, faa: null, iconPack: fixturePack, fetchImpl: offline, settingsFile: join(appTmp, "settings.json"), pinFile: join(appTmp, "pins.json") });
    await server.app.listen({ port: 0, host: "127.0.0.1" });
    port = (server.app.server.address() as { port: number }).port;
  });

  afterAll(async () => {
    await server.stop();
    rmSync(appTmp, { recursive: true, force: true });
    rmSync(fix, { recursive: true, force: true });
    rmSync(dir, { recursive: true, force: true });
  });

  it("GET /icons/list returns entries with style, crop rectangle, and color", async () => {
    const res = await server.app.inject({ url: "/icons/list" });
    expect(res.statusCode).toBe(200);
    const { entries } = res.json() as {
      entries: { name: string; style: string; crop?: { x: number; y: number; w: number; h: number }; th?: number; color: string }[];
    };
    expect(entries.map((e) => e.name).sort()).toEqual(["pd:QUX", "pd:WUZ", "pw:FOO", "rk:BAZ"]);
    for (const e of entries) expect([PACK_COLORS.military, PACK_COLORS.civil]).toContain(e.color);
    const qux = entries.find((e) => e.name === "pd:QUX")!;
    expect(qux.style).toBe("gapfill");
    expect(qux.crop).toEqual({ x: 0, y: 0, w: 1, h: 0.5 }); // cropTopRatio normalized
    expect(qux.th).toBe(200);
    const wuz = entries.find((e) => e.name === "pd:WUZ")!;
    expect(wuz.crop).toEqual({ x: 0.5, y: 0, w: 0.5, h: 0.6 });
    expect(wuz.th).toBeUndefined();
    const foo = entries.find((e) => e.name === "pw:FOO")!;
    expect(foo.style).toBe("filled");
    expect(foo.crop).toBeUndefined();
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
    expect(st.icons.count).toBe(4);
    ws.close();
  });

  it("GET /icons/:name carries ETag + Cache-Control; If-None-Match returns 304", async () => {
    const res = await server.app.inject({ url: "/icons/rk%3ABAZ" });
    expect(res.statusCode).toBe(200);
    const etag = String(res.headers["etag"]);
    expect(etag).toMatch(/^"[0-9a-f]{64}"$/);
    expect(res.headers["cache-control"]).toBe("public, max-age=86400");
    const hit = await server.app.inject({ url: "/icons/rk%3ABAZ", headers: { "if-none-match": etag } });
    expect(hit.statusCode).toBe(304);
    expect(hit.body).toBe("");
    expect(String(hit.headers["etag"])).toBe(etag);
    const miss = await server.app.inject({ url: "/icons/rk%3ABAZ", headers: { "if-none-match": '"deadbeef"' } });
    expect(miss.statusCode).toBe(200);
  });

  it("GET /icons/list carries a pack version string", async () => {
    const res = await server.app.inject({ url: "/icons/list" });
    expect(res.statusCode).toBe(200);
    const st = fixturePack.status();
    expect((res.json() as { version: string }).version).toBe(`${st.updatedAt}:${st.count}`);
  });

  it("vetoed name 404s at the route and drops out of /icons/list", async () => {
    // Last test in the suite on purpose: it mutates the pack (exclude.json +
    // re-init) after the tests above have pinned the no-veto behavior.
    writeFileSync(join(dir, "exclude.json"), JSON.stringify({ vetoed: ["rk:BAZ"] }));
    await fixturePack.init(); // pins verified → rebuild from disk, reloads exclude.json
    expect(fixturePack.status().count).toBe(3);

    const vetoed = await server.app.inject({ url: "/icons/rk%3ABAZ" });
    expect(vetoed.statusCode).toBe(404);

    const list = await server.app.inject({ url: "/icons/list" });
    expect(list.statusCode).toBe(200);
    const { entries } = list.json() as { entries: { name: string }[] };
    expect(entries.map((e) => e.name).sort()).toEqual(["pd:QUX", "pd:WUZ", "pw:FOO"]);

    const ok = await server.app.inject({ url: "/icons/pw%3AFOO" });
    expect(ok.statusCode).toBe(200); // non-vetoed names still resolve
  });
});

describe("pack-ready icon re-resolution", () => {
  // Aircraft stamped with family fallbacks while the pack was downloading
  // must get pack art on the ready transition (update frames to clients);
  // crafts whose resolution doesn't change, and sea craft, must not move.
  const FIX_SOURCES: IconSources = {
    pw: { repo: "plane-watch/pw-silhouettes", sha: "3d41c9a2f7e6b8d0a1c2b3d4e5f60718293a4b5c", license: "pw license", attribution: "pw attribution" },
    rk: { repo: "RexKramer1/AircraftShapesSVG", sha: "a1b2c3d4e5f60718293a4b5c6d7e8f9012345678", license: "rk license", attribution: "rk attribution" },
    pd: [],
    gapTargets: [],
  };

  let fix: string;
  let dir: string;
  let appTmp: string;
  let pack: IconPack;
  let store: CraftStore;
  let server: Awaited<ReturnType<typeof buildApp>>;
  let port: number;

  beforeAll(async () => {
    fix = mkdtempSync(join(tmpdir(), "radar-ready-fix-"));
    dir = mkdtempSync(join(tmpdir(), "radar-ready-pack-"));
    appTmp = mkdtempSync(join(tmpdir(), "radar-ready-app-"));
    mkdirSync(join(fix, "plane-watch"), { recursive: true }); // empty pw set: rk-only fixture
    mkdirSync(join(fix, "rk"), { recursive: true });
    // The MILITARY_RULES AWACS token points at rk:E3TF when the pack has it.
    writeFileSync(join(fix, "rk", "E3TF.svg"), '<svg><title>E-3F Title</title><g><path d="M0 0"/></g></svg>');

    pack = new IconPack({
      dir,
      sources: FIX_SOURCES,
      transport: {
        async cloneRepo(repo: string, _sha: string, destDir: string) {
          cpSync(join(fix, repo.includes("plane-watch") ? "plane-watch" : "rk"), destDir, { recursive: true });
        },
        async fetchFile() {
          throw new Error("unexpected fetchFile (no pd sources)");
        },
      },
    });
    expect(pack.status().state).toBe("absent");

    const seed = (o: Partial<Craft>): Craft => ({
      id: "", domain: "air", kind: "military", lat: 1, lon: 2,
      speed: null, heading: null, updatedAt: Date.now(), stale: false, ...o,
    });
    store = new CraftStore();
    store.upsert(
      [
        seed({ id: "m1", callsign: "AWACS1", icon: "isr" }), // pack-ready flips this to rk:E3TF
        seed({ id: "m2", callsign: "EAGLE1", icon: "fighter" }), // no table entry: stays fighter
        seed({ id: "999", domain: "sea", kind: "cargo", icon: "cargo", shipName: "SHIP" }),
      ],
      Date.now(),
    );

    const hub = new Hub({ store, batchMs: 50, aisFlushMs: 50 });
    // Stub feed clients: nothing may poll (hermetic); the store is seeded directly.
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
    server = await buildApp({
      store, hub, opensky: noPoller, ais: noAis, recorder: null, faa: null, iconPack: pack,
      fetchImpl: offline, settingsFile: join(appTmp, "settings.json"), pinFile: join(appTmp, "pins.json"),
    });
    await server.app.listen({ port: 0, host: "127.0.0.1" });
    port = (server.app.server.address() as { port: number }).port;
  });

  afterAll(async () => {
    await server.stop();
    rmSync(fix, { recursive: true, force: true });
    rmSync(dir, { recursive: true, force: true });
    rmSync(appTmp, { recursive: true, force: true });
  });

  it("re-stamps stored aircraft with pack icons once the pack turns ready", async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    const frames: any[] = [];
    ws.on("message", (d) => frames.push(JSON.parse(d.toString())));
    await waitFor(() => frames.some((f) => f.type === "snapshot"), 3000);
    const snap = frames.find((f) => f.type === "snapshot")!;
    expect(snap.craft.find((c: any) => c.id === "m1").icon).toBe("isr"); // pre-ready stamp

    await pack.init(); // fake transport → ready synchronously; the hook re-resolves
    expect(pack.status().state).toBe("ready");

    await waitFor(
      () =>
        frames.some(
          (f) => f.type === "update" && (f.upsert ?? []).some((c: any) => c.id === "m1" && c.icon === "rk:E3TF"),
        ),
      3000,
    );
    expect(store.get("m1")!.icon).toBe("rk:E3TF");
    expect(store.get("m2")!.icon).toBe("fighter"); // unchanged → never re-upserted
    const upd = frames.filter((f) => f.type === "update");
    const flip = upd.findIndex((f) => (f.upsert ?? []).some((c: any) => c.id === "m1" && c.icon === "rk:E3TF"));
    expect(flip).toBeGreaterThanOrEqual(0);
    // The ready pass dirtied ONLY m1: no frame after the flip mentions the
    // unchanged aircraft or the ship (their seed drain precedes or merges
    // into the flip frame), and the ship never moved off its kind icon.
    const after = upd.slice(flip + 1);
    expect(after.every((f) => !(f.upsert ?? []).some((c: any) => c.id === "m2"))).toBe(true);
    expect(after.every((f) => !(f.upsert ?? []).some((c: any) => c.id === "999"))).toBe(true);
    expect(upd.every((f) => !(f.upsert ?? []).some((c: any) => c.id === "999" && c.icon !== "cargo"))).toBe(true);
    ws.close();
  });
});

describe("flight context frames (flight.track / flight.context)", () => {
  let dir: string;
  let server: Awaited<ReturnType<typeof buildApp>>;
  let port: number;

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "radar-fc-it-"));
    let t = Date.now();
    const histCraft = (id: string): Craft => ({
      id, domain: "air", kind: "commercial", lat: 40.5, lon: -74, speed: null, heading: null, updatedAt: 0, stale: false,
    });
    const recorder = new HistoryRecorder({
      dir, snapshotMs: 60000, maxBytes: 10_000_000, now: () => (t += 60_000),
    });
    await recorder.recordNow(() => [histCraft("h1")]);
    await recorder.recordNow(() => [histCraft("h1")]);

    const store = new CraftStore();
    // h1: air, no callsign (route ladder short-circuits before any fetch);
    // h2: air with callsign (offline ladder degrades to a negative, route null);
    // 999: sea (domain guard must short-circuit both handlers).
    const seed = Date.now();
    store.upsert(
      [
        { ...histCraft("h1"), updatedAt: seed },
        { ...histCraft("h2"), callsign: "DAL539", updatedAt: seed },
        { ...histCraft("999"), domain: "sea", kind: "cargo", updatedAt: seed },
      ],
      seed,
    );

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
    server = await buildApp({
      store, opensky: noPoller, ais: noAis, recorder, faa: null, iconPack: null,
      fetchImpl: offline, settingsFile: join(dir, "settings.json"), pinFile: join(dir, "pins.json"), log: () => {},
    });
    await server.app.listen({ port: 0, host: "127.0.0.1" });
    port = (server.app.server.address() as { port: number }).port;
  });

  afterAll(async () => {
    await server.stop();
    await rm(dir, { recursive: true, force: true });
  });

  async function connect(): Promise<{ ws: WebSocket; frames: any[] }> {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    const frames: any[] = [];
    ws.on("message", (d) => frames.push(JSON.parse(d.toString())));
    let opened = false;
    ws.on("open", () => {
      opened = true;
    });
    await waitFor(() => opened, 3000);
    return { ws, frames };
  }

  it("flight.track for an unknown id echoes an empty none-path with the request's seq", async () => {
    const { ws, frames } = await connect();
    ws.send(JSON.stringify({ type: "flight.track", id: "deadbe", seq: 7 }));
    await waitFor(() => frames.some((f) => f.type === "flight.track" && f.id === "deadbe"), 3000);
    const fr = frames.find((f) => f.type === "flight.track" && f.id === "deadbe")!;
    expect(fr).toMatchObject({ seq: 7, path: [], fetchedAt: 0, source: "none", budget: { autoLeft: expect.any(Number), hard: false } });

    // seq omitted mirrors timeline.seek's legacy echo: 0.
    ws.send(JSON.stringify({ type: "flight.track", id: "deadbe2" }));
    await waitFor(() => frames.some((f) => f.type === "flight.track" && f.id === "deadbe2"), 3000);
    expect(frames.find((f) => f.type === "flight.track" && f.id === "deadbe2")!.seq).toBe(0);
    ws.close();
  });

  it("flight.context for an unknown id echoes route null with the request's seq", async () => {
    const { ws, frames } = await connect();
    ws.send(JSON.stringify({ type: "flight.context", id: "deadbe", seq: 9 }));
    await waitFor(() => frames.some((f) => f.type === "flight.context" && f.id === "deadbe"), 3000);
    const fr = frames.find((f) => f.type === "flight.context" && f.id === "deadbe")!;
    expect(fr).toMatchObject({ seq: 9, route: null });
    ws.close();
  });

  it("sea ids short-circuit to the same empty echoes (no service call)", async () => {
    const { ws, frames } = await connect();
    ws.send(JSON.stringify({ type: "flight.track", id: "999", seq: 1 }));
    ws.send(JSON.stringify({ type: "flight.context", id: "999", seq: 2 }));
    await waitFor(() => frames.some((f) => f.type === "flight.track" && f.id === "999") && frames.some((f) => f.type === "flight.context" && f.id === "999"), 3000);
    expect(frames.find((f) => f.type === "flight.track" && f.id === "999")).toMatchObject({ path: [], source: "none" });
    expect(frames.find((f) => f.type === "flight.context" && f.id === "999")).toMatchObject({ route: null });
    ws.close();
  });

  it("flight.track for a stored air craft replays its recorded history path", async () => {
    const { ws, frames } = await connect();
    ws.send(JSON.stringify({ type: "flight.track", id: "h1", seq: 3 }));
    await waitFor(() => frames.some((f) => f.type === "flight.track" && f.id === "h1"), 3000);
    const fr = frames.find((f) => f.type === "flight.track" && f.id === "h1")!;
    expect(fr.seq).toBe(3);
    // Offline OpenSky → history-only merge of the two seeded snapshots.
    expect(fr.source).toBe("history");
    expect(fr.path.map((p: any) => [p.lat, p.lon])).toEqual([[40.5, -74], [40.5, -74]]);
    expect(fr.path[0].t).toBeLessThanOrEqual(fr.path[1].t);
    expect(fr.fetchedAt).toBeGreaterThan(0);
    expect(fr.budget).toEqual({ autoLeft: expect.any(Number), hard: false });
    ws.close();
  });

  it("flight.context calls the ladder with the STORE's callsign and degrades to null offline", async () => {
    const { ws, frames } = await connect();
    ws.send(JSON.stringify({ type: "flight.context", id: "h1", seq: 4 })); // no callsign → null, no fetch
    ws.send(JSON.stringify({ type: "flight.context", id: "h2", seq: 5 })); // callsign, offline ladder → null
    await waitFor(() => frames.some((f) => f.type === "flight.context" && f.id === "h1") && frames.some((f) => f.type === "flight.context" && f.id === "h2"), 3000);
    expect(frames.find((f) => f.type === "flight.context" && f.id === "h1")).toMatchObject({ seq: 4, route: null });
    expect(frames.find((f) => f.type === "flight.context" && f.id === "h2")).toMatchObject({ seq: 5, route: null });
    ws.close();
  });

  it("malformed frames are dropped silently (no crash, no reply)", async () => {
    const { ws, frames } = await connect();
    ws.send(JSON.stringify({ type: "flight.track" })); // no id
    ws.send(JSON.stringify({ type: "flight.track", id: "h1", seq: "7" })); // string seq
    ws.send(JSON.stringify({ type: "flight.context", id: 5 })); // non-string id
    ws.send(JSON.stringify({ type: "flight.context", id: "h1", seq: -1 })); // negative seq
    // Liveness marker: a well-formed request is answered, and it is the ONLY
    // flight.* frame this socket received.
    ws.send(JSON.stringify({ type: "flight.track", id: "deadbe", seq: 11 }));
    await waitFor(() => frames.some((f) => f.type === "flight.track" && f.id === "deadbe"), 3000);
    const fc = frames.filter((f) => f.type === "flight.track" || f.type === "flight.context");
    expect(fc).toHaveLength(1);
    expect(fc[0]).toMatchObject({ id: "deadbe", seq: 11 });
    ws.close();
  });
});

describe("aiscast fill wiring", () => {
  // Fake aiscast client: captures every setBoxes push (the only observable
  // of the tile policy) and hands out a distinctive secondary status.
  function fakeAiscast(secondary?: Partial<AisClient["secondaryStatus"]>) {
    const calls: BoundingBoxes[][] = [];
    const fake = {
      calls,
      started: 0,
      stopped: 0,
      setBoxes(boxes: BoundingBoxes[]) {
        calls.push(boxes);
      },
      start() {
        fake.started += 1;
      },
      stop() {
        fake.stopped += 1;
      },
      secondaryStatus: {
        connected: true,
        lastError: null,
        lastMessageAt: 123,
        attributions: ["AISHub"],
        ...secondary,
      },
      client: null as unknown as AisClient,
    };
    fake.client = fake as unknown as AisClient;
    return fake;
  }

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

  let dir: string;
  let server: Awaited<ReturnType<typeof buildApp>>;
  let port: number;
  let fake: ReturnType<typeof fakeAiscast>;

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "radar-aiscast-it-"));
    fake = fakeAiscast();
    server = await buildApp({
      store: new CraftStore(),
      opensky: noPoller,
      ais: noAis,
      aiscast: fake.client,
      recorder: null,
      faa: null,
      iconPack: null,
      fetchImpl: offline,
      settingsFile: join(dir, "settings.json"),
      pinFile: join(dir, "pins.json"),
      log: () => {},
    });
    await server.app.listen({ port: 0, host: "127.0.0.1" });
    port = (server.app.server.address() as { port: number }).port;
  });

  afterAll(async () => {
    await server.stop();
    expect(fake.started).toBe(1); // started once the ais.tile test's first tile arrived (deferred connect)
    expect(fake.stopped).toBe(1);
    await rm(dir, { recursive: true, force: true });
  });

  async function connect(): Promise<{ ws: WebSocket; frames: any[] }> {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    const frames: any[] = [];
    ws.on("message", (d) => frames.push(JSON.parse(d.toString())));
    let opened = false;
    ws.on("open", () => {
      opened = true;
    });
    await waitFor(() => opened, 3000);
    return { ws, frames };
  }

  it("status embeds the client's secondaryStatus with enabled derived from the key", async () => {
    const { ws, frames } = await connect();
    await waitFor(() => frames.some((f) => f.type === "status"), 3000);
    const st = frames.find((f) => f.type === "status")!;
    expect(st.feeds.ais.secondary).toEqual({
      enabled: false, // no AISCAST_API_KEY in the test env
      connected: true,
      lastError: null,
      lastMessageAt: 123,
      attributions: ["AISHub"],
      boxes: [], // wave 9: tiles always on the wire, [] with no tiles
    });
    ws.close();
  });

  it("ais.tile follows; homeRegion composes [home, follow]; garbage drops the field; null clears", async () => {
    const { ws, frames } = await connect();
    const follow = { lat: 51.5, lon: -0.12 };
    const home = { lat: 35, lon: 139 };

    await waitFor(() => fake.calls.length >= 1, 3000); // boot push: no home, no follow
    expect(fake.calls[0]).toEqual([]);
    expect(fake.started).toBe(0); // deferred connect: no tiles, no network
    fake.calls.length = 0;

    ws.send(JSON.stringify({ type: "ais.tile", ...follow }));
    await waitFor(() => fake.calls.length === 1, 3000);
    expect(fake.calls[0]).toEqual([boxesFor(follow)]);
    expect(fake.started).toBe(1); // the first tile connects the feed

    ws.send(JSON.stringify({ type: "settings.update", patch: { homeRegion: home } }));
    await waitFor(() => fake.calls.length === 2, 3000);
    expect(fake.calls[1]).toEqual([boxesFor(home), boxesFor(follow)]); // order: [home, follow]
    await waitFor(
      () => frames.some((m) => m.type === "status" && m.settings?.homeRegion?.lat === 35 && m.settings?.homeRegion?.lon === 139),
      3000,
    );
    await waitFor(() => {
      try {
        const doc = JSON.parse(readFileSync(join(dir, "settings.json"), "utf8"));
        return doc.homeRegion?.lat === 35 && doc.homeRegion?.lon === 139;
      } catch {
        return false;
      }
    }, 3000);

    // Malformed tiles and a garbage homeRegion: no crash, no subscription
    // change, while the other patch fields still apply (Review Focus 3/4).
    const before = fake.calls.length;
    ws.send(JSON.stringify({ type: "ais.tile", lat: null, lon: 5 }));
    ws.send(JSON.stringify({ type: "ais.tile" }));
    ws.send(JSON.stringify({ type: "ais.tile", lat: "40", lon: 5 }));
    ws.send(JSON.stringify({ type: "settings.update", patch: { homeRegion: { lat: "x", lon: 5 }, ramCacheGb: 3 } }));
    await waitFor(
      () => frames.some((m) => m.type === "status" && m.settings?.ramCacheGb === 3 && m.settings?.homeRegion?.lat === 35),
      3000,
    );
    expect(fake.calls).toHaveLength(before);

    // Finite-but-oversized coords are accepted and clamped into a valid box.
    ws.send(JSON.stringify({ type: "ais.tile", lat: 1e12, lon: -1e12 }));
    await waitFor(() => fake.calls.length === before + 1, 3000);
    expect(fake.calls.at(-1)).toEqual([boxesFor(home), boxesFor({ lat: 80, lon: -170 })]);

    // Explicit null clears the parked tile; the follow tile stays.
    ws.send(JSON.stringify({ type: "settings.update", patch: { homeRegion: null } }));
    await waitFor(() => fake.calls.length === before + 2, 3000);
    expect(fake.calls.at(-1)).toEqual([boxesFor({ lat: 80, lon: -170 })]);
    await waitFor(
      () => frames.some((m) => m.type === "status" && m.settings?.ramCacheGb === 3 && m.settings.homeRegion === null),
      3000,
    );
    ws.close();
  });

  it("boots with a persisted homeRegion: the first push is the parked tile", async () => {
    const dir2 = await mkdtemp(join(tmpdir(), "radar-aiscast-it2-"));
    writeFileSync(join(dir2, "settings.json"), JSON.stringify({ storageCapGb: 10, ramCacheGb: 1, homeRegion: { lat: 10, lon: 20 } }));
    const fake2 = fakeAiscast({ connected: false, lastMessageAt: null, attributions: [] });
    const app2 = await buildApp({
      store: new CraftStore(),
      opensky: noPoller,
      ais: noAis,
      aiscast: fake2.client,
      recorder: null,
      faa: null,
      iconPack: null,
      fetchImpl: offline,
      settingsFile: join(dir2, "settings.json"),
      pinFile: join(dir2, "pins.json"),
      log: () => {},
    });
    expect(fake2.calls).toEqual([[[[0, 10], [20, 30]]]]); // compose+clamp of {10,20}, no follow yet
    expect(fake2.started).toBe(1); // a home at boot is a tile: connects immediately
    await app2.stop();
    expect(fake2.started).toBe(1);
    expect(fake2.stopped).toBe(1);
    await rm(dir2, { recursive: true, force: true });
  });

  it("without a key or an injected client the secondary block reads disabled and ais.tile is skipped", async () => {
    const dir2 = await mkdtemp(join(tmpdir(), "radar-aiscast-off-"));
    const logs: string[] = [];
    const app2 = await buildApp({
      store: new CraftStore(),
      opensky: noPoller,
      ais: noAis,
      recorder: null,
      faa: null,
      iconPack: null,
      fetchImpl: offline,
      settingsFile: join(dir2, "settings.json"),
      pinFile: join(dir2, "pins.json"),
      log: (m) => logs.push(m),
    });
    await app2.app.listen({ port: 0, host: "127.0.0.1" });
    const port2 = (app2.app.server.address() as { port: number }).port;
    expect(logs.some((l) => l.startsWith("aiscast: AISCAST_API_KEY not set"))).toBe(true);

    const ws = new WebSocket(`ws://127.0.0.1:${port2}/ws`);
    const frames: any[] = [];
    ws.on("message", (d) => frames.push(JSON.parse(d.toString())));
    await waitFor(() => frames.some((f) => f.type === "status"), 3000);
    const st = frames.find((f) => f.type === "status")!;
    expect(st.feeds.ais.secondary).toEqual({
      enabled: false,
      connected: false,
      lastError: null,
      lastMessageAt: null,
      attributions: [],
      boxes: [], // disabled: present and empty
    });

    // Frames are processed (no crash) but change nothing observable.
    ws.send(JSON.stringify({ type: "ais.tile", lat: 10, lon: 20 }));
    ws.send(JSON.stringify({ type: "settings.update", patch: { homeRegion: { lat: 10, lon: 20 } } }));
    await waitFor(
      () => frames.some((f) => f.type === "status" && f.settings?.homeRegion?.lat === 10), // the setting persists…
      3000,
    );
    const last = frames.filter((f) => f.type === "status").at(-1)!;
    expect(last.feeds.ais.secondary).toEqual({ enabled: false, connected: false, lastError: null, lastMessageAt: null, attributions: [], boxes: [] }); // …without touching the feed
    const health = await app2.app.inject({ url: "/health" });
    expect(health.statusCode).toBe(200);
    ws.close();
    await app2.stop();
    await rm(dir2, { recursive: true, force: true });
  });

  it("secondary status carries the composed tile boxes as edge pairs", async () => {
    const { ws, frames } = await connect();
    const home = { lat: 35, lon: 139 };
    const follow = { lat: 51.5, lon: -0.12 };
    ws.send(JSON.stringify({ type: "settings.update", patch: { homeRegion: home } }));
    ws.send(JSON.stringify({ type: "ais.tile", ...follow }));
    await waitFor(
      () => frames.some((m) => m.type === "status" && (m.feeds?.ais?.secondary?.boxes?.length ?? 0) === 2),
      3000,
    );
    const boxes = frames.filter((m) => m.type === "status").at(-1)!.feeds.ais.secondary.boxes;
    // Same composition pushAisTiles sends: [home, follow], each as edge pairs.
    expect(boxes).toEqual([boxesFor(home), boxesFor(follow)]);
    ws.close();
  });
});

describe("hot-zone boost wiring (zones.config frame + status)", () => {
  // Real OpenSkyPoller + the REAL index.ts status assembly (no injected hub):
  // the zones.config handler, the boost ride-through opensky.feedStatus, and
  // the hotzone wire mapping (dominantKind -> kind) are all under test. Only
  // the /states fetch is faked.
  const nowSec = () => Math.floor(Date.now() / 1000);
  // spi-true rows classify military (classifyAir); the two positions share a
  // 2° grid hood and keep centroid/half math exact in binary floats.
  const spiRow = (icao24: string, lat: number, lon: number): (string | number | boolean | null)[] => [
    icao24, "VIPER1", "United States", nowSec(), nowSec(),
    lon, lat, 10000, false, 250, 90, 10, null, 10050, "1200", true, 2,
  ];

  let dir: string;
  let server: Awaited<ReturnType<typeof buildApp>>;
  let port: number;
  let states: (string | number | boolean | null)[][] = [];

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "radar-hotzone-it-"));
    const store = new CraftStore();
    const opensky = new OpenSkyPoller({
      pollMs: 60,
      graceMs: 30000,
      store,
      fetchImpl: (async () =>
        new Response(JSON.stringify({ states }), {
          status: 200,
          headers: { "content-type": "application/json" },
        })) as typeof fetch,
    });
    const ais = {
      isConnected: false,
      feedStatus: { lastError: null, lastMessageAt: null },
      start: () => {},
      stop: () => {},
    } as unknown as AisClient;
    server = await buildApp({
      store, opensky, ais, recorder: null, faa: null, iconPack: null, fetchImpl: offline,
      settingsFile: join(dir, "settings.json"), pinFile: join(dir, "pins.json"), log: () => {},
    });
    await server.app.listen({ port: 0, host: "127.0.0.1" });
    port = (server.app.server.address() as { port: number }).port;
  });

  afterAll(async () => {
    await server.stop();
    await rm(dir, { recursive: true, force: true });
  });

  const statusFrames = (frames: any[]) => frames.filter((f) => f.type === "status");

  it("zones.config arms the boost; a military cluster forms a hotzone in status; full replace clears it", async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    const frames: any[] = [];
    ws.on("message", (d) => frames.push(JSON.parse(d.toString())));
    let opened = false;
    ws.on("open", () => {
      opened = true;
    });
    await waitFor(() => opened, 3000);

    await waitFor(() => statusFrames(frames).length >= 1, 3000);
    const base = statusFrames(frames).at(-1)!;
    expect(base.hotzones).toEqual([]); // idle server: explicit empty array, not absent
    expect(base.feeds.opensky.boost).toBeNull();

    // Invalid frames die at the validator; the well-formed one still applies
    // (the drop matrix itself is pinned in test/hub.test.ts).
    ws.send(JSON.stringify({ type: "zones.config", kinds: ["cargo"], boostMs: 30000 }));
    ws.send(JSON.stringify({ type: "zones.config", kinds: ["military"], boostMs: "30000" }));
    ws.send(JSON.stringify({ type: "zones.config", kinds: ["military"], boostMs: 30000 }));
    await waitFor(() => server.opensky.feedStatus.boost?.active === true, 3000);
    expect(server.opensky.feedStatus.boost?.count).toBe(0); // no military in the store yet
    await waitFor(() => {
      const st = statusFrames(frames).at(-1);
      return st?.hotzones?.length === 0 && st?.feeds?.opensky?.boost?.active === true;
    }, 3000);

    // Engineer 2 military rows into the stub /states payload: one globe poll
    // lands them, the next zone tick forms the zone (planZones runs ahead of
    // the credit gate, so the GEOMETRY needs no funded fetch).
    states = [spiRow("m001", 40, -100), spiRow("m002", 40.5, -100.5)];
    await server.opensky.pollOnce();
    await server.opensky.pollZoneOnce();
    await waitFor(() => (statusFrames(frames).at(-1)?.hotzones?.length ?? 0) > 0, 3000);
    const st = statusFrames(frames).at(-1)!;
    expect(st.hotzones).toHaveLength(1);
    expect(st.hotzones[0]).toEqual({
      center: { lat: 40.25, lon: -100.25 },
      halfW: 0.25,
      halfH: 0.25,
      count: 2,
      kind: "military", // dominantKind renamed on the wire
      id: "auto:0", // v2 identity; auto entries carry no manual/active flags
    });
    // boost rides opensky.feedStatus untouched (BoostStatus v2; no duplication).
    expect(st.feeds.opensky.boost).toEqual({
      active: true, count: 2, intervalMs: null, paused: "credits", zones: 1,
      sectionsActive: 0, sectionsIdle: 0, creditsToday: 0,
    });

    // Full replace with an empty kind set: the new config voids the zones.
    ws.send(JSON.stringify({ type: "zones.config", kinds: [], boostMs: 30000 }));
    await waitFor(() => server.opensky.zonesStatus.length === 0, 3000);
    await waitFor(() => statusFrames(frames).at(-1)?.hotzones?.length === 0, 3000);
    ws.close();
  });

  it("v2 frame: a manual section rides the full wire to status.hotzones (id + manual + active)", async () => {
    // The two military rows from the previous case are still in the stub
    // payload (and the store); no x-rate-limit-remaining header is served, so
    // nothing FUNDS — but the plan/activation layer runs before the credit
    // gate, so the active section still surfaces on the wire, unspent.
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    const frames: any[] = [];
    ws.on("message", (d) => frames.push(JSON.parse(d.toString())));
    let opened = false;
    ws.on("open", () => {
      opened = true;
    });
    await waitFor(() => opened, 3000);

    ws.send(
      JSON.stringify({
        type: "zones.config",
        kinds: ["military"],
        boostMs: 30000,
        auto: { enabled: true, createMin: 2, standdownAt: 0 },
        sections: [{ id: "sec-1", kinds: ["military"], boostMs: 30000, b: [[39.5, -100.5], [40.5, -99.5]] }],
      }),
    );
    // Real async wait: drive plan builds and give the hub's 250 ms status
    // tick time to broadcast (the frame lands async; the armed zone tick
    // would be too late). test/util's waitFor is sync-predicate only, hence
    // the explicit loop.
    let armed = false;
    for (let i = 0; i < 60 && !armed; i++) {
      await server.opensky.pollZoneOnce();
      const hz = statusFrames(frames).at(-1)?.hotzones ?? [];
      armed = hz.some((z: any) => z.id === "sec-1" && z.manual === true && z.active === true);
      if (!armed) await sleep(50);
    }
    const st = statusFrames(frames).at(-1)!;
    expect(st.hotzones.find((z: any) => z.id === "sec-1")).toMatchObject({
      count: 2,
      kind: "military",
      manual: true,
      active: true,
    });
    expect(st.hotzones.some((z: any) => z.id === "auto:0")).toBe(true); // auto rides along
    expect(st.feeds.opensky.boost.sectionsActive).toBe(1);
    expect(st.feeds.opensky.boost.sectionsIdle).toBe(0);
    expect(st.feeds.opensky.boost.creditsToday).toBe(0); // unfunded tick spent nothing
    ws.close();
  });
});
