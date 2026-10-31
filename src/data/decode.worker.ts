import type { Craft } from "../../shared/craft.js";

// Decompress a gzip ArrayBuffer of JSON-crafted records into the craft list.
export async function decodeGz(buf: ArrayBuffer): Promise<Craft[]> {
  const decompressed = new Blob([buf])
    .stream()
    .pipeThrough(new DecompressionStream("gzip"));
  const text = await new Response(decompressed).text();
  return JSON.parse(text) as Craft[];
}

// Guarded worker entry so importing this module in Node tests is side-effect free.
const isWorker =
  typeof self !== "undefined" && typeof self.postMessage === "function";

if (isWorker) {
  self.onmessage = async (e: MessageEvent<{ id: number; buf: ArrayBuffer }>) => {
    try {
      postMessage({ id: e.data.id, crafts: await decodeGz(e.data.buf) });
    } catch (err) {
      postMessage({ id: e.data.id, error: String(err) });
    }
  };
}
