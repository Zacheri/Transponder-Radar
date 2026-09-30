import { describe, it, expect } from "vitest";
import { parseRadarMessage } from "../src/data/ws.js";

const feeds = {
  opensky: { lastOkAt: 1000, lastError: null },
  ais: { connected: true, enabled: true },
};

describe("parseRadarMessage status frames", () => {
  it("accepts a well-formed status frame", () => {
    const raw = JSON.stringify({ type: "status", feeds, serverTime: 2000 });
    const msg = parseRadarMessage(raw);
    expect(msg).not.toBeNull();
    expect(msg?.type).toBe("status");
    if (msg?.type === "status") {
      expect(msg.feeds).toEqual(feeds);
      expect(msg.serverTime).toBe(2000);
    }
  });

  it("rejects a status frame missing feeds", () => {
    const raw = JSON.stringify({ type: "status", serverTime: 2000 });
    expect(parseRadarMessage(raw)).toBeNull();
  });

  it("rejects a status frame missing serverTime", () => {
    const raw = JSON.stringify({ type: "status", feeds });
    expect(parseRadarMessage(raw)).toBeNull();
  });

  it("rejects an unknown type", () => {
    const raw = JSON.stringify({ type: "bogus", feeds, serverTime: 2000 });
    expect(parseRadarMessage(raw)).toBeNull();
  });
});
