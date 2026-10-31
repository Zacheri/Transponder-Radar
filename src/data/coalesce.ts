// Latest-wins coalescing for an async run (map refresh): request() marks
// dirty and schedules at most ONE run per scheduled frame; a request that
// lands while a run is in flight yields exactly one more run after it
// settles. flush() runs immediately (single-flight: a flush while running
// just marks dirty). schedule defaults to requestAnimationFrame.

export function createCoalescedRun(
  run: () => void | Promise<void>,
  schedule?: (cb: () => void) => void,
): { request: () => void; flush: () => void } {
  const sched = schedule ?? ((cb: () => void) => requestAnimationFrame(() => cb()));
  let dirty = false;
  let scheduled = false;
  let running = false;

  const execute = async (): Promise<void> => {
    running = true;
    dirty = false;
    try {
      await run();
    } finally {
      running = false;
      // A request/flush landed mid-run: exactly one follow-up, and only
      // now if no scheduled frame is still going to run it.
      if (dirty && !scheduled) void execute();
    }
  };

  const onFrame = (): void => {
    scheduled = false;
    if (running || !dirty) return;
    void execute();
  };

  return {
    request: (): void => {
      dirty = true;
      if (running || scheduled) return;
      scheduled = true;
      sched(onFrame);
    },
    flush: (): void => {
      if (running) {
        dirty = true;
        return;
      }
      void execute();
    },
  };
}
