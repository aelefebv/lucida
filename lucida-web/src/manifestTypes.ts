/** Dataset manifest and fetch source types — mirrors lucida-content/lucida-protocol serde output. */

// ---------------------------------------------------------------------------
// DatasetManifest (from lucida-content)
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
  /**
   * Affine transform from `from` to `to`, expressed in **voxel units** of
   * the source entity's full-resolution image. Wire format is
   * `{ matrix: [16 floats] }` in column-major order, so the 2D translation
   * components live at `matrix[12]` (tx) and `matrix[13]` (ty).
   *
   * See `lucida-content/src/transform.rs` for the authoritative
   * `VoxelTransform` definition and the unit contract producers must
   * uphold.
   */
  transform: { matrix: number[] };
}

export interface MultiscaleInfo {
  axes: { name: string; kind: string }[];
  levels: LevelGeometry[];
  data_type: string;
  /**
   * Non-canonical axes (anything outside `{t,c,z,y,x}`) that were dropped
   * from the canonical 5D shape and pinned to a fixed index when reading
   * chunks. Optional/absent on payloads from older servers.
   */
  pinned_axes?: PinnedAxis[];
}

export interface PinnedAxis {
  name: string;
  size: number;
  pinned_index: number;
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

export interface DatasetManifest {
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
// FetchSource (from lucida-protocol)
// ---------------------------------------------------------------------------

/** Externally tagged enum: { "Proxied": { images: [...] } } */
export type FetchSource =
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

/** Extract data_type string from a WireFormat variant. */
export function extractDataType(wf: WireFormat): string {
  if ("Raw" in wf) return wf.Raw.data_type;
  if ("Lz4" in wf) return wf.Lz4.data_type;
  if ("Zstd" in wf) return wf.Zstd.data_type;
  return "uint16";
}

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
