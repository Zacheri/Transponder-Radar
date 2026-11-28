export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// Polls a SYNC predicate until it holds or the timeout fires. The predicate
// MUST be synchronous: an async predicate returns a Promise, which is always
// truthy, so waitFor would resolve on the first check without waiting at all
// (silently, too — the awaited async work is never observed here). If you
// need to await something, write an explicit polling loop
// (`while (!(await pred())) { … }`) instead of passing an async predicate.
export async function waitFor(
  predicate: () => boolean,
  timeoutMs = 2000,
  intervalMs = 25,
): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error("waitFor timed out");
    await sleep(intervalMs);
  }
}
