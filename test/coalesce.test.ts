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

describe("createCoalescedRun — run failures", () => {
  // Captures console.warn and process-level unhandled rejections for the
  // duration of fn: a throwing run must neither die loudly upstream nor
  // escape as an unhandled rejection (motion tick requests at ~5 Hz).
  async function withProbes(fn: () => Promise<void> | void): Promise<{ warns: number; unhandled: unknown }> {
    const realWarn = console.warn;
    let warns = 0;
    let unhandled: unknown = null;
    const onUnhandled = (e: unknown): void => {
      unhandled = e;
    };
    console.warn = () => warns++;
    process.on("unhandledRejection", onUnhandled);
    try {
      await fn();
      await tick();
      await tick();
    } finally {
      console.warn = realWarn;
      process.off("unhandledRejection", onUnhandled);
    }
    return { warns, unhandled };
  }

  it("a sync-throwing run: caught + warned once, no unhandled rejection, coalescer still works", async () => {
    const sched = makeScheduler();
    let runs = 0;
    let boom = true;
    const { request } = createCoalescedRun(
      () => {
        runs++;
        if (boom) throw new Error("paint exploded");
      },
      sched.schedule,
    );
    const { warns, unhandled } = await withProbes(async () => {
      request();
      sched.run();
      expect(runs).toBe(1);
      boom = false;
      request();
      sched.run();
      expect(runs).toBe(2); // survived the failed run
    });
    expect(unhandled).toBeNull();
    expect(warns).toBe(1);
  });

  it("an async-rejecting run: warned, no unhandled rejection, and a request that landed mid-run still gets its follow-up", async () => {
    const sched = makeScheduler();
    let runs = 0;
    let release: (() => void) | undefined;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const { request } = createCoalescedRun(
      async () => {
        runs++;
        if (runs === 1) {
          await gate;
          throw new Error("paint exploded");
        }
      },
      sched.schedule,
    );
    const { warns, unhandled } = await withProbes(async () => {
      request();
      sched.run();
      expect(runs).toBe(1); // in flight
      request(); // lands while the doomed run is in flight
      release!();
      await tick();
      expect(runs).toBe(2); // dirty follow-up survived the failure
    });
    expect(unhandled).toBeNull();
    expect(warns).toBe(1);
  });
});
