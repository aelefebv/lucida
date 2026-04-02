import type { DatasetInfo } from "./zarr/metadata.ts";
import type { ChunkStore } from "./zarr/chunkStore.ts";

export type ViewMode = "2d" | "3d";

/** A single member (well/field) within a plate-style dataset. */
export interface DatasetMember {
  id: string;
  position: [number, number];
  storePrefix: string | null;
}

/** State for a single dataset, either local or remote. */
export interface DatasetState {
  id: string;
  name: string;
  info: DatasetInfo;
  memberStores: Map<string, ChunkStore>;
  fileIndex: Map<string, File> | null; // null for remote datasets
  members: DatasetMember[];
}

/** Pending chunk request from a remote viewer. */
export interface PendingChunkResolve {
  resolve: (data: ArrayBuffer) => void;
  reject: (err: Error) => void;
}

export function dtypeMax(dtype: string): number {
  switch (dtype) {
    case "uint8": return 255;
    case "uint16": return 65535;
    case "uint32": return 4294967295;
    case "float32": return 1;
    default: return 65535;
  }
}
