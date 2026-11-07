# Coordinate-Frame Naming Discipline at the JS↔WASM Boundary

Status: Accepted.

## Context

The planning contract carries coordinates in three frames: voxel space, world space (after
level and spacing), and screen pixels. Field names did not say which, and one entity snapshot
carries a layout-grid position and an intrinsic spatial center in different frames. Shape
arrays were indexed with bare TCZYX numbers.

## Decision

Coordinate fields on the JS planning contract end in a frame suffix: `Vox`, `World`, or `Px`
(for example `layoutPositionVox`, `centroidWorld`, `projectedDiagonalPx`). Scalars that are
ratios, such as `effectiveZoom`, take no suffix. The suffix is applied where the snapshot
translates Rust snake_case to camelCase. Shape indices use `Axis.T` through `Axis.X` from
`lucida-web/src/axes.ts` instead of literal numbers.

## Rejected alternatives

- Rename the Rust fields too. The Rust names reach the serde wire format, the store, the CLI,
  and the Python bindings, so the rename would be a wire change for a readability gain that
  the JS contract alone delivers.
- Suffix every local variable. Locals live a few lines from the assignment that fixes their
  frame. The rule covers interface fields only.
