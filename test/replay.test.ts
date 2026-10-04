import { describe, it, expect } from "vitest";
import { ReplayGate } from "../src/data/replay.js";

describe("ReplayGate", () => {
  it("applies updates and snapshots while live", () => {
    const g = new ReplayGate();
    expect(g.rewound).toBe(false);
    expect(g.onSnapshot()).toBe(true);
    expect(g.onUpdate()).toBe(true);
  });

  it("suppresses updates while rewound but still applies the seek snapshot", () => {
    const g = new ReplayGate();
    g.enterReplay();
    expect(g.rewound).toBe(true);
    expect(g.onSnapshot()).toBe(true);
    expect(g.onUpdate()).toBe(false);
  });

  it("returns to live only on the snapshot that answers timeline.live", () => {
    const g = new ReplayGate();
    g.enterReplay();
    expect(g.onUpdate()).toBe(false);
    g.requestLive();
    expect(g.onUpdate()).toBe(false); // live snapshot not received yet
    expect(g.onSnapshot()).toBe(true);
    expect(g.rewound).toBe(false);
    expect(g.onUpdate()).toBe(true);
  });
});
