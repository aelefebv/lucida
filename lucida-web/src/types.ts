import type { ContentGraph, ClientFetchDescriptor } from "./contentTypes.ts";

export type ViewMode = "2d" | "3d";

export interface VolumeData {
  data: Uint16Array;
  width: number; // X
  height: number; // Y
  depth: number; // Z
}

/** State for a single dataset, either local or remote. */
export interface DatasetState {
  id: string;
  name: string;
  content: ContentGraph;
  fetch: ClientFetchDescriptor;
}


/**
 * Map a data type string to its maximum intensity value.
 * Handles both lowercase (legacy) and PascalCase (Rust serde DataType enum).
 */
export function dtypeMax(dtype: string): number {
  switch (dtype.toLowerCase()) {
    case "uint8": return 255;
    case "uint16": return 65535;
    case "uint32": return 4294967295;
    case "float32": return 1;
    default: return 65535;
  }
}
