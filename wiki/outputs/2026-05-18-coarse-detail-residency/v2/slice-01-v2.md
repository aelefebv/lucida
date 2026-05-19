## Parent PRD

#672

## What to build

Establish the metadata and user state contract for the complete coarse/detail
model. Dataset metadata can point to a valid source coarse level when one fits,
generated-level placeholders can be represented without becoming selectable
detail, and users can explicitly choose source detail levels while the default
remains highest resolution.

## Acceptance criteria

- [ ] Image metadata carries an explicit coarse pointer and generated-level
      metadata without putting provenance/config on `LevelGeometry`.
- [ ] Source levels are the only default detail-selector choices; generated
      levels do not appear as normal detail choices.
- [ ] Detail override uses null/absent for highest-resolution source level and a
      number for explicit user choice.
- [ ] Saved-view capture/apply preserves explicit detail overrides, omits or
      restores default null, and clamps stale overrides to source levels.
- [ ] Source coarse selection can identify an existing source level that fits
      configured bounds and leaves no valid pointer when none fits.
- [ ] Non-server-mediated datasets use only valid source-backed coarse; missing
      source coarse reports unavailable rather than guessing a level.
- [ ] Tests cover old settings/saved views, generated metadata absence, source
      detail clamping, and source coarse selection.

## Blocked by

None - can start immediately.

## User stories addressed

- User story 1
- User story 2
- User story 8
- User story 12
- User story 22
- User story 23

## Wiki context

- systems - [[systems/subsystems/planning-domain]], [[systems/subsystems/scene-state-and-epochs]]
- decisions - [[decisions/0001-document-vs-viewport-split]], [[decisions/0013-url-as-app-state-for-saved-views]], [[decisions/0039-chunk-only-coarse-detail-residency]], [[decisions/0040-generated-coarse-as-derived-pyramid-levels]]
- gotchas - [[gotchas/wasm-rebuild-after-rust-changes]]
