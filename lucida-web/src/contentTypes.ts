/** Content graph and fetch descriptor types — mirrors lucida-content/lucida-protocol serde output. */

// ---------------------------------------------------------------------------
// ContentGraph (from lucida-content)
// ---------------------------------------------------------------------------

export type DatasetKind =
  | "Single"
  | { Plate: { rows: string[]; columns: string[]; positioning_mode: string; has_stage_positions: boolean } };

export interface Entity {
  id: string;
  kind: "Image" | "Well" | "Field";
  parent: string | null;
  labels: Record<string, unknown>;
}

export interface TransformEdge {
  from: string;
  to: string;
  transform: { matrix: number[] };
}

export interface MultiscaleInfo {
  axes: { name: string; kind: string }[];
  levels: LevelGeometry[];
  data_type: string;
}

export interface LevelGeometry {
  level_index: number;
  shape: number[];       // [T, C, Z, Y, X]
  chunk_shape: number[];
  grid_shape: number[];
  scale: number[];
}

export interface ImageSpec {
  image_id: string;
  owner: string;
  multiscale: MultiscaleInfo;
}

export interface LayoutSpec {
  id: string;
  name: string;
  placements: { entity_id: string; position: [number, number] }[];
}

export interface ContentGraph {
  dataset_id: string;
  name: string;
  kind: DatasetKind;
  entities: Entity[];
  transforms: TransformEdge[];
  images: ImageSpec[];
  source_layouts: LayoutSpec[];
  default_layout_id: string | null;
}

// ---------------------------------------------------------------------------
// ClientFetchDescriptor (from lucida-protocol)
// ---------------------------------------------------------------------------

/** Externally tagged enum: { "Proxied": { images: [...] } } */
export type ClientFetchDescriptor =
  | { Proxied: ProxiedFetchDescriptor }
  | { Direct: DirectFetchDescriptor }
  | { Local: LocalFetchDescriptor };

export interface ProxiedFetchDescriptor {
  images: ProxiedImageSpec[];
}

export interface ProxiedImageSpec {
  image_id: string;
  wire_format: WireFormat;
}

export type WireFormat =
  | { Raw: { data_type: string } }
  | { Lz4: { data_type: string } }
  | { Zstd: { data_type: string } };

export interface DirectFetchDescriptor {
  images: DirectImageSpec[];
}

export interface LocalFetchDescriptor {
  images: DirectImageSpec[];
}

export interface DirectImageSpec {
  image_id: string;
  wire_format: WireFormat;
  levels: { level_index: number; path: string }[];
  store_prefix: string | null;
}
