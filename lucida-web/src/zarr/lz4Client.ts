let worker: Worker | null = null;
let nextId = 0;
const pending = new Map<number, (dst: ArrayBuffer) => void>();

function getWorker(): Worker {
  if (!worker) {
    worker = new Worker(new URL("./lz4.worker.ts", import.meta.url), {
      type: "module",
    });
    worker.onmessage = (e: MessageEvent<{ id: number; dst: ArrayBuffer }>) => {
      const { id, dst } = e.data;
      const resolve = pending.get(id);
      if (resolve) {
        pending.delete(id);
        resolve(dst);
      }
    };
  }
  return worker;
}

export function decompressLz4Async(src: ArrayBuffer): Promise<ArrayBuffer> {
  return new Promise((resolve) => {
    const id = nextId++;
    pending.set(id, resolve);
    getWorker().postMessage({ id, src }, [src]);
  });
}
