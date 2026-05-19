## Parent PRD

#672

## What to build

Establish the coarse/detail metadata and per-dataset detail LOD state needed by the rest of the feature. This slice should make the model explicit without requiring generated coarse chunks or renderer fallback to be complete yet.

The end state of this slice is that dataset metadata can identify a coarse level, detail defaults to source level 0, users can explicitly choose a lower source detail level, and saved views/presence preserve that choice without turning the default into document content.

## Acceptance criteria

- [ ] Image/multiscale metadata can carry an explicit coarse level pointer and generated-level provenance/config placeholder while keeping level geometry geometry-only.
- [ ] Existing source levels can be classified as selectable detail levels, while generated coarse levels are not presented as normal detail choices by default.
- [ ] Per-dataset detail override state uses null/absent to mean highest-resolution source level and a number to mean an explicit user choice.
- [ ] Saved-view capture/apply preserves explicit detail overrides, strips/restores the default null override, and clamps stale overrides to selectable detail levels.
- [ ] Old settings JSON and saved views without detail overrides continue to load.
- [ ] The UI exposes a minimal per-dataset detail-level control with labels based on meaning/resolution rather than raw LOD number.

## Blocked by

None - can start immediately.

## User stories addressed

- User story 1
- User story 2
- User story 21
- User story 22

## Wiki context

- systems - [[systems/subsystems/scene-state-and-epochs]], [[systems/subsystems/presence-and-follow]], [[systems/subsystems/planning-domain]]
- decisions - [[decisions/0001-document-vs-viewport-split]], [[decisions/0013-url-as-app-state-for-saved-views]], [[decisions/0039-chunk-only-coarse-detail-residency]], [[decisions/0040-generated-coarse-as-derived-pyramid-levels]]
- gotchas - [[gotchas/wasm-rebuild-after-rust-changes]]
