// IndexedDB cache of pre-color pack rasters (browser-only, unit-test-exempt
// like pack-icons.ts). Stores each base's SIZE×SIZE pre-color ImageData as a
// lossless PNG blob under `${version}:${name}`, so a reload skips the
// fetch + SVG/scan decode. Every operation is best-effort: no IndexedDB
// (private mode), a blocked open, a decode failure, or a wrong-size entry
// all resolve as a miss and the caller takes the network path. An empty
// version (older server without one) disables caching entirely; stale
// versions self-collect because correctness comes from the key, with a
// best-effort prune of foreign-version entries after open.

export interface RasterCache {
  /** Cached pre-color raster for a pack base name, or null on any miss. */
  get(name: string): Promise<ImageData | null>;
  /** Best-effort store; a no-op when IDB or PNG encoding is unavailable. */
  set(name: string, data: ImageData): Promise<void>;
}

const DB_NAME = "radar";
const STORE = "radar-icons";

const disabled: RasterCache = {
  get: async () => null,
  set: async () => {},
};

function wrap<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error("indexeddb: request failed"));
  });
}

function txDone(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onabort = () => reject(tx.error ?? new Error("indexeddb: transaction aborted"));
  });
}

// Entries kept are the ones whose key starts with our version prefix.
function pruneOld(db: IDBDatabase, prefix: string): Promise<void> {
  return new Promise((resolve, reject) => {
    try {
      const tx = db.transaction(STORE, "readwrite");
      const store = tx.objectStore(STORE);
      const req = store.getAllKeys();
      req.onsuccess = () => {
        for (const k of req.result) {
          if (typeof k !== "string" || !k.startsWith(prefix)) store.delete(k);
        }
      };
      req.onerror = () => reject(req.error ?? new Error("indexeddb: prune failed"));
      tx.oncomplete = () => resolve();
      tx.onabort = () => reject(tx.error ?? new Error("indexeddb: prune aborted"));
    } catch (e) {
      reject(e);
    }
  });
}

// PNG round-trip through a canvas; null when encoding is unavailable.
function encodePng(data: ImageData): Promise<Blob | null> {
  return new Promise((resolve) => {
    const canvas = document.createElement("canvas");
    canvas.width = data.width;
    canvas.height = data.height;
    const ctx = canvas.getContext("2d");
    if (!ctx || typeof canvas.toBlob !== "function") {
      resolve(null);
      return;
    }
    ctx.putImageData(data, 0, 0);
    canvas.toBlob((b) => resolve(b), "image/png");
  });
}

export function createRasterCache(size: number, version: string): RasterCache {
  if (version === "" || typeof indexedDB === "undefined") return disabled;

  const prefix = `${version}:`;
  let dbPromise: Promise<IDBDatabase> | null = null;

  const openDb = (): Promise<IDBDatabase> => {
    if (dbPromise === null) {
      dbPromise = new Promise((resolve, reject) => {
        try {
          const req = indexedDB.open(DB_NAME);
          req.onupgradeneeded = () => {
            const db = req.result;
            if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE);
          };
          req.onsuccess = () => {
            const db = req.result;
            db.onversionchange = () => db.close();
            void pruneOld(db, prefix).catch(() => {});
            resolve(db);
          };
          req.onblocked = () => reject(new Error("indexeddb: open blocked"));
          req.onerror = () => reject(req.error ?? new Error("indexeddb: open failed"));
        } catch (e) {
          reject(e);
        }
      });
    }
    return dbPromise;
  };

  const get = async (name: string): Promise<ImageData | null> => {
    try {
      const db = await openDb();
      const blob = await wrap(db.transaction(STORE, "readonly").objectStore(STORE).get(prefix + name));
      if (!(blob instanceof Blob)) return null;
      const bmp = await createImageBitmap(blob);
      try {
        if (bmp.width !== size || bmp.height !== size) return null;
        const canvas = document.createElement("canvas");
        canvas.width = size;
        canvas.height = size;
        const ctx = canvas.getContext("2d");
        if (!ctx) return null;
        ctx.drawImage(bmp, 0, 0);
        return ctx.getImageData(0, 0, size, size);
      } finally {
        bmp.close();
      }
    } catch {
      return null;
    }
  };

  const set = async (name: string, data: ImageData): Promise<void> => {
    try {
      const blob = await encodePng(data);
      if (!blob) return;
      const db = await openDb();
      const tx = db.transaction(STORE, "readwrite");
      tx.objectStore(STORE).put(blob, prefix + name);
      await txDone(tx);
    } catch {
      // best-effort
    }
  };

  return { get, set };
}
