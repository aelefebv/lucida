# Descriptor byte-layout single source of truth + WGSL ↔ TS lock test

Status: Accepted.

## Context

The `EntityDescriptor` byte layout was restated in four places: two TS writers (the cold-state
writer and the minimap's transient writer) and the struct declarations in `slice.wgsl` and
`volume.wgsl`. Only one writer was exercised end to end. A drifted offset shows up only as
visual corruption, such as the wrong contrast or a garbage ray march.

## Decision

One TS file, `lucida-web/src/renderer/descriptor/layout.ts`, owns the layout as named offset
and size constants, and every TS writer reads from it. A test parses the `EntityDescriptor`
struct from both shaders, computes offsets with WGSL host-shareable alignment rules, and fails
if either shader disagrees with the constants or with the other shader. The shaders load
through Vite's `?raw` import, the same path production uses. A separate test pins the
transient writer's bytes to the canonical writer's.

The same pattern fits any cross-language byte-shape contract: one file owns the layout, and
lock tests make every other reader agree.

## Rejected alternatives

- Generate the WGSL structs from a TS schema. Removes drift entirely but adds a build step to
  the shader workflow, which two shaders and two writers do not justify.
- Assert byte equivalence at runtime. Costs CPU on every cold state and only checks layouts
  the session happens to exercise. A test catches drift before it ships, at no runtime cost.

## Consequences

The test carries a small WGSL parser that handles only the types the struct uses (matrices,
`vec3<u32>`, scalars, fixed-size arrays of structs). A richer struct needs a richer parser.
Adding a field still touches the constants, the writers, and both shaders. The test catches a
missed edit but does not remove the edit.
