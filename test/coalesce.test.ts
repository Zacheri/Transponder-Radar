import { describe, it, expect } from "vitest";
import { createCoalescedRun } from "../src/data/coalesce.js";

// Manual scheduler: callbacks queue up; run() fires one queued callback.
function makeScheduler() {
  const queue: (() => void)[] = [];
  return {
    schedule: (cb: () => void): void => {
      queue.push(cb);
    },
    run: (): void => {
      const cb = queue.shift();
      cb?.();
    },
  };
}

// One macrotask: flushes the microtask chains the coalescer starts on settle.
const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

describe("createCoalescedRun", () => {
  it("3 requests before any scheduled frame → exactly one run when the frame fires", () => {
    const sched = makeScheduler();
    let runs = 0;
    const { request } = createCoalescedRun(
      () => {
        runs++;
      },
      sched.schedule,
    );
    request();
    request();
    request();
    expect(runs).toBe(0);
    sched.run();
    expect(runs).toBe(1);
  });

  it("a run in flight (pending) + request → exactly one more run after it settles", async () => {
    const sched = makeScheduler();
    let runs = 0;
    let release: (() => void) | undefined;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const { request } = createCoalescedRun(
      async () => {
        runs++;
        if (runs === 1) await gate;
      },
      sched.schedule,
    );
    request();
    sched.run();
    expect(runs).toBe(1);
    request(); // lands while the first run is still in flight
    expect(runs).toBe(1);
    release!();
    await gate;
    await tick();
    expect(runs).toBe(2);
  });

  it("flush with nothing pending runs immediately; flush while in flight marks dirty, not a second run", async () => {
    const sched = makeScheduler();
    let runs = 0;
    const immediate = createCoalescedRun(
      () => {
        runs++;
      },
      sched.schedule,
    );
    immediate.flush();
    expect(runs).toBe(1); // no scheduled frame was ever queued

    let release: (() => void) | undefined;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const { request, flush } = createCoalescedRun(
      async () => {
        runs++;
        if (runs === 2) await gate;
      },
      sched.schedule,
    );
    request();
    sched.run();
    expect(runs).toBe(2); // first run of this coalescer, now in flight
    flush();
    expect(runs).toBe(2); // no second immediate run
    release!();
    await gate;
    await tick();
    expect(runs).toBe(3); // exactly one more after settle (dirty flag)
  });
});
