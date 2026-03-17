const POOL_SIZE = Math.min(navigator.hardwareConcurrency ?? 4, 4);

interface PoolWorker {
  worker: Worker;
  pending: Map<number, (dst: ArrayBuffer) => void>;
  activeCount: number;
}

let pool: PoolWorker[] | null = null;
let nextId = 0;

function getPool(): PoolWorker[] {
  if (!pool) {
    pool = Array.from({ length: POOL_SIZE }, () => {
      const w = new Worker(new URL("./lz4.worker.ts", import.meta.url), {
        type: "module",
      });
      const pending = new Map<number, (dst: ArrayBuffer) => void>();
      const entry: PoolWorker = { worker: w, pending, activeCount: 0 };
      w.onmessage = (e: MessageEvent<{ id: number; dst: ArrayBuffer }>) => {
        const { id, dst } = e.data;
        const resolve = pending.get(id);
        if (resolve) {
          pending.delete(id);
          entry.activeCount--;
          resolve(dst);
        }
      };
      return entry;
    });
  }
  return pool;
}

export function decompressLz4Async(src: ArrayBuffer): Promise<ArrayBuffer> {
  return new Promise((resolve) => {
    const id = nextId++;
    const workers = getPool();
    let best = workers[0];
    for (let i = 1; i < workers.length; i++) {
      if (workers[i].activeCount < best.activeCount) best = workers[i];
    }
    best.pending.set(id, resolve);
    best.activeCount++;
    best.worker.postMessage({ id, src }, [src]);
  });
}
