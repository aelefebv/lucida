import type { DatasetManifest, FetchSource } from "./manifestTypes.ts";

export type ViewMode = "2d" | "3d";

export interface DatasetState {
  id: string;
  name: string;
  manifest: DatasetManifest;
  fetch: FetchSource;
}


/**
 * Every value an integer data type holds, as `[min, max]`. `null` for a
 * float type, whose values have no useful bound. Handles both lowercase and
 * PascalCase (Rust serde `DataType`) spellings.
 */
export function dtypeRange(dtype: string): [number, number] | null {
  switch (dtype.toLowerCase()) {
    case "uint8": return [0, 255];
    case "uint16": return [0, 65535];
    case "uint32": return [0, 4294967295];
    case "int8": return [-128, 127];
    case "int16": return [-32768, 32767];
    case "int32": return [-2147483648, 2147483647];
    default: return null;
  }
}
