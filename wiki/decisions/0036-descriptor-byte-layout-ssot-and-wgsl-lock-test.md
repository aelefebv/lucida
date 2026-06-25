---
type: Decision
title: "Descriptor byte-layout single source of truth + WGSL ↔ TS lock test"
description: "The byte layout of the EntityDescriptor struct lives in exactly one file — lucida-web/src/renderer/descriptor/layout.ts — as named offset constants (OFFSET_MODEL_MATRIX, OFFSET_FIELD_PROXY_DIMS, LOD_OFFSET_CHUNK_DIMS,…"
tags: [lucida, decision]
source_path: wiki/decisions/0036-descriptor-byte-layout-ssot-and-wgsl-lock-test.md
created: 2026-05-16
modified: 2026-06-25
---

# Descriptor byte-layout single source of truth + WGSL ↔ TS lock test

## Decision

The byte layout of the `EntityDescriptor` struct lives in exactly one file — `lucida-web/src/renderer/descriptor/layout.ts` — as named offset constants (`OFFSET_MODEL_MATRIX`, `OFFSET_FIELD_PROXY_DIMS`, `LOD_OFFSET_CHUNK_DIMS`, etc.) plus a few size constants (`DESCRIPTOR_ENTRY_SIZE`, `DESCRIPTOR_LOD_INFO_SIZE`, `DESCRIPTOR_MAX_LODS`). Every TS writer of the descriptor buffer reads offsets from that file. A companion test, `lucida-web/src/renderer/descriptor/layout.test.ts`, parses the `EntityDescriptor` struct declaration from both `slice.wgsl` and `volume.wgsl` at test time, computes implied byte offsets using WGSL's host-shareable alignment rules, and asserts agreement against the TS constants — failing the suite if the WGSL struct and TS layout drift.

## Why this shape

Pre-refactor, the `EntityDescriptor` byte layout was mirrored across four sites: the canonical writer in `descriptorBuffer.ts`, the transient writer in `volumeRenderer.setTransientDescriptor`, and the struct declarations in `slice.wgsl` + `volume.wgsl`. Three were untested; only the canonical writer's outputs were exercised end-to-end. Adding a new field meant editing four places and trusting that no offset drifted — a class of bug that surfaces only as visual corruption (wrong contrast on a layer, wrong proxy slot bound, ray-march producing garbage). The render-phase dechaos contract scan ranked this as the highest-risk contract issue in the render module.

Two well-trodden alternatives were considered and rejected:

- **WGSL struct codegen from a TS schema.** Generating both shaders from a TS source of truth eliminates the drift entirely but bakes a build-time pipeline into the shader workflow. Dechaos Pass 8 deferred this to "Slice 13, only when a concrete motivator surfaces" — the build cost is not justified for two shaders and one writer pair.
- **Runtime byte-equivalence assertion in production.** Asserting at construction time that the descriptor matches the WGSL layout adds non-trivial CPU cost per cold state and only fires on layouts the runtime actually exercises. Test-time enforcement is cheaper and catches drift before it ships.

The lock-test approach lives between those two: zero build-time cost, zero runtime cost, but a hard fail in CI the instant a developer changes one side without the other. Shader sources are loaded via Vite's `?raw` import — the same mechanism the production renderers use — so the test is self-contained and doesn't need `node:fs`.

The pattern is a generalizable seam for any future cross-language byte-shape contract (WGSL ↔ TS today, could be WASM ↔ TS tomorrow if a Rust struct ever needs to share a layout with a JS reader). The framing is: **a single TS file owns the layout, and lock tests assert that every other reader agrees.**

## How this decision shows up in code

- `lucida-web/src/renderer/descriptor/layout.ts` — SSoT. Named offset constants, size constants, sentinel constants. JSDoc at the top of the file shows the byte layout side-by-side with the WGSL struct.
- `lucida-web/src/renderer/descriptor/layout.test.ts` — lock test. Parses both `slice.wgsl` and `volume.wgsl`, computes std140-ish offsets, asserts agreement with `layout.ts` constants. Also asserts both shaders declare an identical `EntityDescriptor` struct.
- `lucida-web/src/renderer/descriptorBuffer.ts` — canonical writer. Imports offsets from `descriptor/layout.ts` instead of restating them inline. `serializeEntityDescriptor` is the only path the cold-state pipeline uses.
- `lucida-web/src/renderer/descriptor/transient.ts` — minimap-path writer. Imports the same offsets; `serializeTransientDescriptor` was previously buried in `volumeRenderer.setTransientDescriptor` and restated the layout from memory. A transient ↔ canonical byte-equivalence test pins the equivalence.
- `lucida-web/src/renderer/slice.wgsl`, `lucida-web/src/renderer/volume.wgsl` — `struct EntityDescriptor` declarations. These remain the authoritative WGSL shape; `layout.ts` mirrors them and the lock test enforces agreement in both directions.

## Consequences

**Positive:**

- One file (`descriptor/layout.ts`) is the canonical reference for both TS writers and both shaders; adding a field is a four-line diff (constant + two writers' use sites + the WGSL struct), not a four-place coordinated edit.
- The lock test catches drift in CI the next time anyone changes either side without updating both.
- The minimap-path "transient" descriptor writer is no longer a hidden second copy of the layout; it's a tested sibling.
- The pattern is reusable for future TS ↔ shader (or TS ↔ Rust ↔ WASM) byte-shape contracts.

**Negative:**

- The lock test embeds a small WGSL parser. It handles the subset of WGSL that the `EntityDescriptor` struct uses (`mat4x4<f32>`, `vec3<u32>`, scalar `u32` / `f32`, fixed-size arrays); it would need extension for richer struct shapes. Acceptable scope creep at present.
- Adding a field still requires touching four places. The lock test catches drift, but doesn't eliminate the edit surface.

**Neutral:**

- No runtime cost in production; the parser only runs in test.

## Related

- [`gpu.worker.ts` split into `renderer/` subdirectories](0035-gpu-worker-split-into-renderer-subdirectories.md) — parent PRD #622; Slice 3 introduced this layout/test pair
- [All GPU Work on a Dedicated Web Worker](0003-gpu-on-dedicated-worker.md) — establishes the worker / WGSL boundary this lock test polices
- [GPU Residency](../systems/subsystems/gpu-residency.md) — descriptor buffer architecture context
- [Worker Protocol](../systems/subsystems/worker-protocol.md) — discriminated-union message contract; sibling boundary type protected by `tsc` rather than a lock test
- PRD #622, Slice 3 (`87bff09`) — the commit that introduced the SSoT + lock test
