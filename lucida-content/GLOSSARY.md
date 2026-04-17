# lucida-content Glossary

**ContentGraph** -- Top-level canonical description of a dataset. Contains entities, transforms, images, and layouts.

**Entity** -- A node in the content hierarchy. Kinds: Image (standalone), Well (plate container), Field (FOV within a well).

**EntityLabels** -- Optional structured metadata on an entity (name, well_row, column_index, field_index, etc.).

**TransformEdge** -- A directed spatial relationship between two entities. Typically field-to-well, encoding stage translation or grid offset. The `transform` field is a `VoxelTransform`, so units are enforced at the type level.

**VoxelTransform** -- Newtype wrapper around `AffineTransform` whose translations and scales are required to be in **voxel units** of the source entity's full-resolution image. Producers reading from physical-unit metadata (e.g., OME-Zarr microns) must convert at the call site. Constructors: `identity()`, `from_voxel_translation_2d(tx, ty)`, `from_voxel_matrix([f64; 16])`. Read access via `matrix()`. `#[serde(transparent)]` so wire format is identical to `AffineTransform`.

**AffineTransform** -- Column-major 4x4 matrix. Underlying primitive used by `VoxelTransform`. Has no unit semantics on its own; do not put one inside a `TransformEdge` directly — go through `VoxelTransform`.

**ImageSpec** -- Links an image-bearing entity to its multiscale geometry via `owner: EntityId`.

**MultiscaleInfo** -- Axes, per-level geometry, and data type for one image.

**LevelGeometry** -- Shape, chunk shape, grid shape, and scale for one level of a multiscale pyramid. All arrays are 5D `[T, C, Z, Y, X]`.

**DataType** -- Semantic voxel type: Uint8, Uint16, Uint32, Float32, Float64.

**LayoutSpec** -- A named spatial arrangement. Contains entity placements (positions in layout space).

**PositioningMode** -- How FOVs are arranged within wells: Stage (from metadata) or Grid (computed).

**DatasetKind** -- Single (one image) or Plate (rows, columns, wells, fields).

**grid_shape** -- Precomputed `ceil(shape / chunk_shape)` per axis. Avoids redundant division in chunk iteration and LOD selection.

**normalize_to_5d** -- Pads an N-dimensional array to 5D using axis names. Missing axes get a fill value.
