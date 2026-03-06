import { decompressLz4 } from "./lz4.ts";

self.onmessage = (e: MessageEvent<{ id: number; src: ArrayBuffer }>) => {
  const { id, src } = e.data;
  const dst = decompressLz4(src);
  self.postMessage({ id, dst }, [dst]);
};
