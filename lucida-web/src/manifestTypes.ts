/** Dataset manifest and fetch source types — mirrors lucida-content/lucida-protocol serde output. */

export type DatasetKind =
  | "Single"
  | { Plate: { rows: string[]; columns: string[]; positioning_mode: string; has_explicit_positions: boolean } };

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
  coarse_level_index?: number | null;
  generated_levels?: GeneratedLevelInfo[];
  data_type: string;
  /**
   * Non-canonical axes (anything outside `{t,c,z,y,x}`) that were dropped
   * from the canonical 5D shape and pinned to a fixed index when reading
   * chunks. Optional/absent on payloads from older servers.
   */
  pinned_axes?: PinnedAxis[];
  /**
   * Per-channel display metadata from the OME `omero.channels` block, in
   * channel order. Optional/absent when the source has no omero block (the
   * server omits the field for channel-less datasets), so consumers must fall
   * back to a positional `Ch N` label. Best-effort and positional: may be
   * shorter or longer than the actual channel count — index by channel and
   * fall back per-index when an entry is missing.
   */
  channel_infos?: ChannelInfo[];
}

/**
 * Display metadata for a single channel (mirrors `lucida-content`'s
 * `ChannelInfo`). `label` is always a non-empty string when present; `color`
 * is the raw omero hex (no leading `#`) and is not consumed by this slice.
 */
export interface ChannelInfo {
  label: string;
  color?: string | null;
}

export interface GeneratedLevelInfo {
  level_index: number;
  role?: "coarse";
  provenance?: GeneratedLevelProvenance;
}

export interface GeneratedLevelProvenance {
  generator?: string;
  config_id?: string;
  source_content_id?: string | null;
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

/**
 * One entry of an OME `image-label` color table (mirrors lucida-content's
 * `LabelColor`). `value` is the integer label id — carried as a number
 * because ids routinely exceed the 16-bit range; `rgba` is `[r, g, b, a]`
 * with each component `0..255`.
 */
export interface LabelColor {
  value: number;
  rgba: [number, number, number, number];
}

/**
 * A segmentation-mask label attached to a source intensity image (mirrors
 * lucida-content's `LabelSpec`). A label carries its OWN multiscale image
 * — distinct axes, per-level geometry, scale, and integer dtype (e.g.
 * `Uint32`) from the source — so it can be streamed and drawn as an
 * overlay aligned by its own coordinate scale. `image.owner` is the entity
 * id owning the source image, used to place the overlay.
 */
export interface LabelSpec {
  name: string;
  source_image_id: string;
  image: ImageSpec;
  /** `image-label.colors`; absent on the wire when empty. */
  colors?: LabelColor[];
  source_declared?: boolean;
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
  /**
   * Segmentation labels attached to images in this dataset. Kept separate
   * from `images` so a label never renders as an ordinary intensity image.
   * Absent on the wire (and on manifests written before labels existed)
   * when the dataset has none — consumers must tolerate `undefined`, like
   * `channel_infos`.
   */
  labels?: LabelSpec[];
}

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
