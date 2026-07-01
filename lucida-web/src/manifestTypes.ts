/** Dataset manifest and fetch source types — mirrors lucida-content/lucida-protocol serde output. */

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

/**
 * A single `image-label.colors` entry: an RGBA color assigned to a label value.
 * Mirrors `lucida-content`'s `LabelColor`.
 */
export interface LabelColor {
  value: number;
  rgba: [number, number, number, number];
}

/**
 * Sidecar metadata for a label image, parsed from the OME-NGFF `image-label`
 * block (mirrors `lucida-content`'s `LabelMeta`). Every field is optional and
 * untrusted; `source_image` is carried verbatim as an opaque relative string
 * and is never resolved.
 */
export interface LabelMeta {
  name: string;
  colors?: LabelColor[];
  properties?: { value: number; fields: Record<string, unknown> }[];
  source_image?: string | null;
}

/**
 * The semantic role of an {@link ImageSpec}, mirroring the Rust `ImageRole`
 * externally-tagged serde enum: the unit string `"Intensity"` for ordinary
 * pixel data, or `{ Label: LabelMeta }` for a segmentation mask parsed from a
 * `labels/` group. Absent (older payloads) ⇒ treat as intensity.
 */
export type ImageRole = "Intensity" | { Label: LabelMeta };

/** True when an {@link ImageRole} is the `Label` variant. */
export function isLabelRole(role: ImageRole | undefined): role is { Label: LabelMeta } {
  return typeof role === "object" && role !== null && "Label" in role;
}

export interface ImageSpec {
  image_id: string;
  owner: string;
  multiscale: MultiscaleInfo;
  /**
   * What this image is to the viewer: intensity vs a `Label` overlay. Optional
   * (`#[serde(default)]` on the Rust side): a payload from before labels
   * existed omits it and is treated as {@link ImageRole} `"Intensity"`.
   */
  role?: ImageRole;
}

/**
 * One label overlay's joined metadata + effective display state — the TS mirror
 * of the Rust `LabelOverlayView` (`WasmScene::label_overlays` JSON). One entry
 * per label image in a dataset, in manifest order, addressed by the
 * label-relative {@link index} the `SetLabelVisible`/`SetLabelOpacity` commands
 * carry.
 */
export interface LabelOverlayView {
  /** The label image's `ImageSpec.image_id` — the stable join key. */
  image_id: string;
  /** Label-relative index (the N-th label image, skipping intensity). */
  index: number;
  /** The `labels/` group name (may be empty if the producer omitted it). */
  name: string;
  /** Effective visibility (default off until toggled). */
  visible: boolean;
  /** Effective blend opacity in [0,1] (default 0.5). */
  opacity: number;
  /** How many `image-label.colors` entries the label declares. */
  num_colors: number;
  /** The opaque `source-image` string, carried verbatim (never resolved). */
  source_image: string | null;
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
