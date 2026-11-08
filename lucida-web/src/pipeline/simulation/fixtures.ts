/**
 * Datasets for the pipeline simulation, built as the server sends them: a
 * wire manifest and fetch descriptor for the scene's `dataset_opened`, and the
 * resolved manifest the page keeps. Shapes are small so a run stays fast, but
 * each fixture keeps the geometry that makes its scenario hard.
 */

import {
  resolveDatasetManifest,
  type DatasetManifest,
  type DatasetManifestWire,
  type Entity,
  type LevelGeometry,
  type MultiscaleInfo,
} from "../../manifestTypes.ts";
import type {
  WireGeneratedAvailabilitySnapshot,
  WireGeneratedLevelAvailability,
} from "../generatedAvailability.ts";

/** Level-0 shape as `[t, c, z, y, x]`. */
export type Shape5 = readonly [number, number, number, number, number];

export interface PyramidSpec {
  shape: Shape5;
  /** Chunk shape as `[z, y, x]`; every chunk holds one timepoint and one channel. */
  chunk: readonly [number, number, number];
  /** Source levels, each halving y and x. */
  levels: number;
  /** Whether each level also halves z. */
  downsampleZ?: boolean;
  /**
   * The source level the coarse tier holds. Defaults to the coarsest; `null`
   * declares no coarse tier.
   */
  coarseLevel?: number | null;
}

/**
 * A coarse level the server generates after the open. Each chunk answers
 * `pending` until `readyAtMs` of the simulation clock, when one availability
 * update names them all ready.
 */
export interface GeneratedCoarseSpec {
  readyAtMs: number;
  /**
   * When an availability update publishes the level's geometry. By default
   * it arrives with the open; later, it reaches the page as a replaced
   * manifest with no scene epoch behind it.
   */
  publishedAtMs?: number;
}

export interface GeneratedCoarseLevel {
  levelIndex: number;
  readyAtMs: number;
  publishedAtMs: number;
  /** The level's geometry, one entry per image. */
  levels: WireGeneratedLevelAvailability[];
  /** The availability snapshot the server sends with the open. */
  snapshot: WireGeneratedAvailabilitySnapshot;
  /** Image id → every chunk key of the generated level. */
  chunkKeys: Map<string, string[]>;
}

export interface DatasetFixture {
  datasetId: string;
  /** The `dataset_opened` command the scene applies. */
  openCommand: string;
  /** The resolved manifest the page keeps, before any generated level is merged. */
  manifest: DatasetManifest;
  generated: GeneratedCoarseLevel | null;
}

function levelGeometry(spec: PyramidSpec, level: number): LevelGeometry {
  const [t, c, z, y, x] = spec.shape;
  const factor = 2 ** level;
  const zFactor = spec.downsampleZ ? factor : 1;
  const shape = [t, c, Math.ceil(z / zFactor), Math.ceil(y / factor), Math.ceil(x / factor)];
  const chunkShape = [1, 1, ...spec.chunk];
  return {
    level_index: level,
    shape,
    chunk_shape: chunkShape,
    grid_shape: shape.map((n, i) => Math.ceil(n / chunkShape[i])),
    scale: [1, 1, zFactor, factor, factor],
  };
}

function multiscale(spec: PyramidSpec, dataType = "Uint16"): MultiscaleInfo {
  const levels = Array.from({ length: spec.levels }, (_, i) => levelGeometry(spec, i));
  const coarse = spec.coarseLevel === undefined ? spec.levels - 1 : spec.coarseLevel;
  return {
    axes: [
      { name: "t", kind: "Time" },
      { name: "c", kind: "Channel" },
      { name: "z", kind: "Space" },
      { name: "y", kind: "Space" },
      { name: "x", kind: "Space" },
    ],
    levels,
    coarse_level_index: coarse,
    data_type: dataType,
  };
}

/** Every chunk key of one level, `level/t/c/z/y/x`. */
function levelChunkKeys(level: LevelGeometry): string[] {
  const [gt, gc, gz, gy, gx] = level.grid_shape;
  const keys: string[] = [];
  for (let t = 0; t < gt; t++) {
    for (let c = 0; c < gc; c++) {
      for (let z = 0; z < gz; z++) {
        for (let y = 0; y < gy; y++) {
          for (let x = 0; x < gx; x++) {
            keys.push(`${level.level_index}/${t}/${c}/${z}/${y}/${x}`);
          }
        }
      }
    }
  }
  return keys;
}

/** `generated` adds a coarse level one step past the pyramid's last source level. */
function fixture(
  wire: DatasetManifestWire,
  generated?: GeneratedCoarseSpec & { pyramid: PyramidSpec },
): DatasetFixture {
  const openCommand = JSON.stringify({
    type: "dataset_opened",
    manifest: wire,
    fetch: {
      Proxied: {
        images: [
          ...wire.images.map((image) => ({
            image_id: image.image_id,
            wire_format: { Raw: { data_type: "Uint16" } },
          })),
          ...(wire.labels ?? []).map((label) => ({
            image_id: label.image.image_id,
            wire_format: { Raw: { data_type: "Uint32" } },
          })),
        ],
      },
    },
    opener_client_id: null,
  });
  const resolved = resolveDatasetManifest(wire);
  if (!generated) {
    return { datasetId: wire.dataset_id, openCommand, manifest: resolved, generated: null };
  }

  // The server can publish a generated level's geometry before any of its
  // chunks exist, and usually does so with the open.
  const levelIndex = generated.pyramid.levels;
  const level = levelGeometry(generated.pyramid, levelIndex);
  const publishedAtMs = generated.publishedAtMs ?? 0;
  const levels = resolved.images.map((image) => ({
    image_id: image.image_id,
    info: { level_index: levelIndex, role: "coarse" as const },
    level,
  }));
  return {
    datasetId: wire.dataset_id,
    openCommand,
    manifest: resolved,
    generated: {
      levelIndex,
      readyAtMs: generated.readyAtMs,
      publishedAtMs,
      levels,
      snapshot: { levels: publishedAtMs > 0 ? [] : levels, chunks: [] },
      chunkKeys: new Map(resolved.images.map((image) => [image.image_id, levelChunkKeys(level)])),
    },
  };
}

/**
 * One image in a single-image dataset. `label` lays a uint32 label of that
 * geometry over it, and the simulation shows it.
 */
export function singleImage(args: {
  id: string;
  pyramid: PyramidSpec;
  generatedCoarse?: GeneratedCoarseSpec;
  label?: PyramidSpec;
}): DatasetFixture {
  const { id, pyramid } = args;
  const entityId = `${id}-entity`;
  const imageId = `${id}-image`;
  // A generated coarse level replaces any declared one.
  const spec = args.generatedCoarse ? { ...pyramid, coarseLevel: null } : pyramid;
  const wire: DatasetManifestWire = {
    dataset_id: id,
    name: `${id}.ome.zarr`,
    kind: "Single",
    entities: [{ id: entityId, kind: "Image", parent: null, labels: {} }],
    transforms: [],
    images: [{ image_id: imageId, owner: entityId, multiscale: multiscale(spec) }],
    labels: args.label && [{
      name: "regions",
      source_image_id: imageId,
      image: { image_id: `${id}-label`, owner: entityId, multiscale: multiscale(args.label, "Uint32") },
      source_declared: true,
    }],
    source_layouts: [
      {
        id: "layout-source",
        name: "Source positions",
        placements: [{ entity_id: entityId, position: [0, 0] }],
      },
    ],
    default_layout_id: "layout-source",
  };
  return fixture(wire, args.generatedCoarse && { ...args.generatedCoarse, pyramid: spec });
}

/**
 * A collection laid out as a `rows × columns` grid, one tile per cell, every
 * tile sharing one pyramid as the server's compact manifest does.
 */
export function collection(args: {
  id: string;
  rows: number;
  columns: number;
  pyramid: PyramidSpec;
  /** Gap between neighbouring tiles, in level-0 samples. */
  gap?: number;
}): DatasetFixture {
  const { id, rows, columns, pyramid } = args;
  const gap = args.gap ?? 16;
  const [, , , height, width] = pyramid.shape;
  const rowNames = Array.from({ length: rows }, (_, r) => String.fromCharCode(65 + r));
  const columnNames = Array.from({ length: columns }, (_, c) => String(c + 1));
  const entities: Entity[] = [];
  const placements: { entity_id: string; position: [number, number] }[] = [];
  const transforms: DatasetManifestWire["transforms"] = [];
  const images: DatasetManifestWire["images"] = [];
  rowNames.forEach((row, r) => {
    columnNames.forEach((column, c) => {
      const group = `group-${row}${column}`;
      const tile = `tile-${row}${column}`;
      const position: [number, number] = [c * (width + gap), r * (height + gap)];
      entities.push(
        {
          id: group,
          kind: "Group",
          parent: null,
          labels: { name: `${row}${column}`, group_row: row, group_column: column, row_index: r, column_index: c },
        },
        { id: tile, kind: "Tile", parent: group, labels: { name: `${row}${column}/0`, tile_index: 0 } },
      );
      placements.push({ entity_id: group, position }, { entity_id: tile, position });
      transforms.push({ from: tile, to: group, translation: [0, 0] });
      images.push({ image_id: `${tile}-image`, owner: tile, multiscale_ref: 0 });
    });
  });
  const wire: DatasetManifestWire = {
    format_version: 2,
    dataset_id: id,
    name: `${id}.ome.zarr`,
    kind: {
      Collection: {
        rows: rowNames,
        columns: columnNames,
        positioning_mode: "Explicit",
        has_explicit_positions: true,
      },
    },
    entities,
    transforms,
    multiscales: [multiscale(pyramid)],
    images,
    source_layouts: [{ id: "layout-explicit", name: "Explicit positions", placements }],
    default_layout_id: "layout-explicit",
  };
  return fixture(wire);
}
