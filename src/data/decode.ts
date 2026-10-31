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

  const makeWorker = (index: number): PoolWorker => {
    const w = factory();
    w.onmessage = (ev) => {
      const { id, crafts, error } = ev.data;
      const p = pending.get(id);
      if (!p) return;
      pending.delete(id);
      if (error !== undefined) {
        p.reject(new Error(error));
        workers[index] = null; // mark slot dead; replace on next dispatch
      } else {
        p.resolve(crafts ?? []);
      }
    };
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
      w.postMessage({ id, buf });
    });

  return {
    decode: (buf: ArrayBuffer): Promise<Craft[]> => dispatch(buf),
  };
}
