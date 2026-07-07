/** Dataset manifest and fetch source types — mirrors lucida-content/lucida-protocol serde output. */

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

// ---------------------------------------------------------------------------
// Wire forms and resolution
//
// Collection manifests would repeat one identical multiscale (and one
// identical wire format) per tile — tens of thousands of times on a wide
// collection — so the server encodes shared values ONCE: a top-level
// `multiscales` table with per-image `multiscale_ref` indexes, a
// `wire_formats` table with per-image `wire_format_ref` indexes, and pure-2D
// placement edges as `translation: [tx, ty]` instead of a 16-element matrix.
// Entries whose value is unique (every single-image dataset, and older
// payloads/persisted documents predating the compact form) carry the inline
// field instead.
//
// `resolveDatasetManifest` / `resolveFetchSource` are the ONLY places that
// know this encoding: every ingest point (dataset_opened broadcast, snapshot
// document manifests) resolves the wire form into the fully-populated
// in-memory types above, so downstream consumers never do table lookups.
// Table-resolved images intentionally share ONE multiscale object reference.
// ---------------------------------------------------------------------------

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
  dataset_id: string;
  name: string;
  kind: DatasetKind;
  entities: Entity[];
  transforms: TransformEdgeWire[];
  /** Multiscale values shared by two or more images; absent when nothing is
   *  shared (single-image manifests, historical payloads). */
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
 *  builds — the expansion of a wire `translation: [tx, ty]`. */
function translationMatrix(tx: number, ty: number): number[] {
  return [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, tx, ty, 0, 1];
}

/**
 * Resolve a wire manifest into the fully-populated in-memory shape: every
 * image ends up with an effective `multiscale` (table-resolved images share
 * one object reference — treat multiscales as immutable, copy-on-write) and
 * every transform edge with a full `matrix`. Throws on a reference outside
 * the shared table or an entry carrying neither form, mirroring the server's
 * own decoder.
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
