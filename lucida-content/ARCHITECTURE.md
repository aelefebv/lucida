# lucida-content Architecture

Canonical content model. Describes datasets as scientific objects. No dependencies on other lucida crates.

## Module Map

```
lib.rs          re-exports
id.rs           DatasetId, EntityId, ImageId, LayoutId
entity.rs       Entity, EntityKind (Image/Well/Field), EntityLabels
transform.rs    TransformEdge, VoxelTransform (voxel-unit newtype), AffineTransform (column-major 4x4)
image.rs        ImageSpec, MultiscaleInfo, Axis, AxisKind, LevelGeometry, DataType
layout.rs       LayoutSpec, EntityPlacement, PositioningMode
kind.rs         DatasetKind (Single / Plate)
graph.rs        ContentGraph (top-level aggregate)
plate.rs        build_plate_layout(), build_grid_field_transforms(), plate_extent()
normalize.rs    axis_index(), normalize_to_5d(), normalize_f64_to_5d()
```

## Key Relationships

`ContentGraph` is the root. It owns:
- `Vec<Entity>` -- tree via `parent: Option<EntityId>` (wells contain fields)
- `Vec<TransformEdge>` -- directed spatial transforms between entities (field-to-well)
- `Vec<ImageSpec>` -- per-image multiscale geometry, linked to entities via `owner: EntityId`
- `Vec<LayoutSpec>` -- spatial arrangements of entities (well placements)

## Conventions

- All geometry is fixed 5D `[T, C, Z, Y, X]`. Missing axes = 1.
- `LevelGeometry.grid_shape` is precomputed: `ceil(shape / chunk_shape)`.
- Plate layouts place wells, not fields. Field positions come from `TransformEdge`.
- Placements are `[X, Y]`. Shapes are `[T, C, Z, Y, X]`.
- All `TransformEdge.transform` values are in **voxel units** of the source entity's full-resolution image. Enforced by the `VoxelTransform` newtype.
