import type { Craft } from "../../shared/craft.js";

export function decodeSupported(): boolean {
  return typeof DecompressionStream !== "undefined";
}

export interface DecodePool {
  decode(gz: ArrayBuffer): Promise<Craft[]>;
}

export interface PoolWorker {
  postMessage(msg: { id: number; buf: ArrayBuffer }): void;
  onmessage:
    | ((ev: { data: { id: number; crafts?: Craft[]; error?: string } }) => void)
    | null;
  // Load failure (chunk 404, module-level throw): posts no onmessage, so
  // without this the slot would never die and its dispatches would hang.
  onerror?: ((ev: unknown) => void) | null;
}

interface Pending {
  resolve: (crafts: Craft[]) => void;
  reject: (err: unknown) => void;
}

function defaultPoolSize(): number {
  const hc =
    typeof navigator === "undefined" ? undefined : navigator.hardwareConcurrency;
  return Math.min(4, hc ?? 2);
}

function defaultSpawn(): PoolWorker {
  return new Worker(
    new URL("./decode.worker.ts", import.meta.url),
    { type: "module" },
  ) as unknown as PoolWorker;
}

export function createDecodePool(
  size?: number,
  spawn?: () => PoolWorker,
): DecodePool {
  const n = size ?? defaultPoolSize();
  const factory = spawn ?? defaultSpawn;

  // Slots start empty; a null slot is lazily filled by spawn() on dispatch.
  let workers: (PoolWorker | null)[] = new Array(n).fill(null);
  let next = 0;
  let idCounter = 0;
  const pending = new Map<number, Pending>();
  // Per-slot view of pending ids: lets a dead worker reject everything it
  // holds, not just the id a posted error happens to carry.
  const slotPending: Set<number>[] = Array.from({ length: n }, () => new Set<number>());

  const killSlot = (index: number): void => {
    for (const id of slotPending[index]) {
      const p = pending.get(id);
      if (p) {
        pending.delete(id);
        p.reject(new Error("decode worker died"));
      }
    }
    slotPending[index].clear();
    workers[index] = null; // slot dead; replace on next dispatch
  };

  const makeWorker = (index: number): PoolWorker => {
    const w = factory();
    w.onmessage = (ev) => {
      const { id, crafts, error } = ev.data;
      const p = pending.get(id);
      if (!p) return;
      pending.delete(id);
      slotPending[index].delete(id);
      if (error !== undefined) {
        p.reject(new Error(error));
        killSlot(index); // same slot cleanup; entry already removed above
      } else {
        p.resolve(crafts ?? []);
      }
    };
    w.onerror = () => killSlot(index);
    return w;
  };

  const dispatch = (buf: ArrayBuffer): Promise<Craft[]> =>
    new Promise<Craft[]>((resolve, reject) => {
      const idx = next;
      next = (next + 1) % n;
      let w = workers[idx];
      if (!w) {
        w = makeWorker(idx);
        workers[idx] = w;
      }
      const id = idCounter++;
      pending.set(id, { resolve, reject });
      slotPending[idx].add(id);
      w.postMessage({ id, buf });
    });

  return {
    decode: (buf: ArrayBuffer): Promise<Craft[]> => dispatch(buf),
  };
}
