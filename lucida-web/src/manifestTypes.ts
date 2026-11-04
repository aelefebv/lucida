/** Dataset manifest and fetch source types. Mirrors lucida-content/lucida-protocol serde output. */

export type DatasetKind =
  | "Single"
  | { Collection: { rows: string[]; columns: string[]; positioning_mode: string; has_explicit_positions: boolean } };

export interface Entity {
  id: string;
  kind: "Image" | "Group" | "Tile";
  parent: string | null;
  labels: Record<string, unknown>;
}

export interface TransformEdge {
  from: string;
  to: string;
  /**
   * Affine transform from `from` to `to`, in voxel units of the source
   * entity's full-resolution image. Column-major 16 floats, so the 2D
   * translation is `matrix[12]` (tx) and `matrix[13]` (ty). The unit contract
   * lives with `VoxelTransform` in `lucida-content/src/transform.rs`.
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
   * Axes outside `{t,c,z,y,x}`, dropped from the 5D shape and pinned to a fixed
   * index when reading chunks. Absent from older servers' payloads.
   */
  pinned_axes?: PinnedAxis[];
  /**
   * Per-channel metadata from OME `omero.channels`. Absent without an omero
   * block, and may not match the channel count, so index by channel and fall
   * back to a positional `Ch N` label per missing entry.
   */
  channel_infos?: ChannelInfo[];
  /**
   * How each coarser level was derived from the one above it, as the OME
   * multiscale `type` declares it (for example `"gaussian"`). Absent when the
   * source declares none; the layer panel then shows no method rather than
   * guessing one.
   */
  downsampling_method?: string;
}

/**
 * Display metadata for one channel (mirrors `lucida-content`'s `ChannelInfo`).
 * `label` is non-empty when present; `color` is the raw omero hex with no
 * leading `#`.
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
 * `LabelColor`). `value` is the label id, a number because ids routinely
 * exceed 16 bits; `rgba` components are `0..255`.
 */
export interface LabelColor {
  value: number;
  rgba: [number, number, number, number];
}

/**
 * A segmentation-mask label attached to a source intensity image (mirrors
 * lucida-content's `LabelSpec`). It carries its own multiscale image, with its
 * own geometry, scale, and integer dtype, and is aligned by that scale.
 * `image.owner` is the source image's owning entity, used for placement.
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
   * Kept apart from `images` so a label never renders as an intensity image.
   * Absent when the dataset has none, so consumers must tolerate `undefined`.
   */
  labels?: LabelSpec[];
}

// Wire forms. A wide collection would repeat one multiscale and one wire format
// per tile, so the server sends shared values once in `multiscales` and
// `wire_formats` tables referenced by index, and pure-2D edges as
// `translation: [tx, ty]`. Unique values, and older persisted documents, carry
// the inline field. `resolveDatasetManifest` and `resolveFetchSource` are the
// only code that knows this encoding; every ingest point resolves through them,
// so downstream code never does table lookups.

/** [`ImageSpec`] as serialized inside a manifest: inline `multiscale` or a
 *  `multiscale_ref` into the manifest's `multiscales` table. */
export interface ImageSpecWire {
  image_id: string;
  owner: string;
  multiscale?: MultiscaleInfo;
  multiscale_ref?: number;
}

/** [`TransformEdge`] as serialized inside a manifest: a full matrix
 *  `transform`, or `translation: [tx, ty]` for pure 2D translations. */
export interface TransformEdgeWire {
  from: string;
  to: string;
  transform?: { matrix: number[] };
  translation?: [number, number];
}

export interface DatasetManifestWire {
  /**
   * 2 when the manifest uses a compact construct, absent when fully inline.
   * The resolver ignores it and decodes by which fields each entry carries.
   */
  format_version?: number;
  dataset_id: string;
  name: string;
  kind: DatasetKind;
  entities: Entity[];
  transforms: TransformEdgeWire[];
  /** Multiscale values shared by two or more images; absent when nothing is
   *  shared (single-image manifests, fully-inline payloads). */
  multiscales?: MultiscaleInfo[];
  images: ImageSpecWire[];
  source_layouts: LayoutSpec[];
  default_layout_id: string | null;
  labels?: LabelSpec[];
}

export interface ProxiedImageSpecWire {
  image_id: string;
  wire_format?: WireFormat;
  wire_format_ref?: number;
}

export interface ProxiedFetchDescriptorWire {
  /** Compact-format marker, like `DatasetManifestWire.format_version`:
   *  present (value 2) exactly when `wire_formats` is, ignored by the
   *  resolver. */
  format_version?: number;
  images: ProxiedImageSpecWire[];
  /** Wire formats shared by two or more images; absent when nothing is
   *  shared. */
  wire_formats?: WireFormat[];
}

export type FetchSourceWire =
  | { Proxied: ProxiedFetchDescriptorWire }
  | { Direct: DirectFetchDescriptor }
  | { Local: LocalFetchDescriptor };

/** The column-major 4x4 matrix `VoxelTransform::from_voxel_translation_2d`
 *  builds from a wire `translation: [tx, ty]`. */
function translationMatrix(tx: number, ty: number): number[] {
  return [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, tx, ty, 0, 1];
}

/**
 * Resolve a wire manifest so every image has a `multiscale` and every edge a
 * full `matrix`. Table-resolved images share one multiscale object, so treat
 * multiscales as immutable. Throws on a bad reference or an entry with neither
 * form, as the server's decoder does.
 */
export function resolveDatasetManifest(wire: DatasetManifestWire): DatasetManifest {
  const table = wire.multiscales ?? [];
  const images: ImageSpec[] = wire.images.map((image) => {
    let multiscale = image.multiscale;
    if (multiscale === undefined && image.multiscale_ref !== undefined) {
      multiscale = table[image.multiscale_ref];
      if (multiscale === undefined) {
        throw new Error(
          `manifest image ${image.image_id} references shared multiscale ` +
            `${image.multiscale_ref}, but the manifest declares ${table.length}`,
        );
      }
    }
    if (multiscale === undefined) {
      throw new Error(
        `manifest image ${image.image_id} carries neither a multiscale nor a multiscale_ref`,
      );
    }
    return { image_id: image.image_id, owner: image.owner, multiscale };
  });
  const transforms: TransformEdge[] = wire.transforms.map((edge) => {
    const transform = edge.transform ??
      (edge.translation !== undefined
        ? { matrix: translationMatrix(edge.translation[0], edge.translation[1]) }
        : undefined);
    if (transform === undefined) {
      throw new Error(
        `manifest transform ${edge.from} -> ${edge.to} carries neither a transform nor a translation`,
      );
    }
    return { from: edge.from, to: edge.to, transform };
  });
  const resolved: DatasetManifest = {
    dataset_id: wire.dataset_id,
    name: wire.name,
    kind: wire.kind,
    entities: wire.entities,
    transforms,
    images,
    source_layouts: wire.source_layouts,
    default_layout_id: wire.default_layout_id,
  };
  if (wire.labels !== undefined) resolved.labels = wire.labels;
  return resolved;
}

/** Resolve a wire fetch source; only the Proxied variant has a compact form. */
export function resolveFetchSource(wire: FetchSourceWire): FetchSource {
  if (!("Proxied" in wire)) return wire;
  const table = wire.Proxied.wire_formats ?? [];
  const images: ProxiedImageSpec[] = wire.Proxied.images.map((image) => {
    let wireFormat = image.wire_format;
    if (wireFormat === undefined && image.wire_format_ref !== undefined) {
      wireFormat = table[image.wire_format_ref];
      if (wireFormat === undefined) {
        throw new Error(
          `proxied image ${image.image_id} references shared wire format ` +
            `${image.wire_format_ref}, but the descriptor declares ${table.length}`,
        );
      }
    }
    if (wireFormat === undefined) {
      throw new Error(
        `proxied image ${image.image_id} carries neither a wire format nor a wire_format_ref`,
      );
    }
    return { image_id: image.image_id, wire_format: wireFormat };
  });
  return { Proxied: { images } };
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
