---
created: 2026-04-18
modified: 2026-06-25
---

# Layout System

A **layout** is a named placement of entities in 2D world space. Datasets ship with a "source" layout produced by the importer; clients can register additional layouts (via `RegisterLayout`) and switch between them (via `SetActiveLayout`). All clients see the same set of registered layouts and the same active selection — layouts are document state, not presence.

## Why layouts are first-class

Two reasons:

1. **Plates and singles share the planning code path.** A single is one entity at the origin; a plate is many wells at well-grid positions, fields nested within. Both are encoded as a layout that the planner consumes — which means the planner doesn't know plate-vs-single, only "iterate this list of placements."
2. **Different views of the same plate are useful.** "Source layout" follows the plate's microscope coordinates; alternative layouts (dense pack, aggregated, sorted by metric) re-arrange wells without re-importing. Layouts let the renderer answer "where do you want them?" without rebuilding the manifest.

## Source vs registered

The `DatasetManifest` carries `source_layouts: Vec<LayoutSpec>` and `default_layout_id: Option<LayoutId>` from import. After import, clients can:

- `DocumentCommand::RegisterLayout { dataset_id, layout: LayoutSpec }` — adds a new layout to `document.registered_layouts[dataset_id]`. Idempotent — duplicate IDs are deduped, not appended.
- `DocumentCommand::SetActiveLayout { dataset_id, layout_id }` — sets `document.active_layout_ids[dataset_id]`. Triggers a derived-state rebuild and bumps the `layout` epoch.

When `SetActiveLayout` references an unknown layout ID, derived state falls back to the default layout (current behavior — see the `unknown_layout_id_is_no_op_for_derived` test in `command.rs`). The active ID is still recorded; if the layout is registered later, switching becomes a no-op since the active ID already matches.

## Interactions

- **Producers**: [[lucida-store]] `import.rs` builds the source layout(s). Web-client UI (`LayoutSwitcher.tsx`) emits `SetActiveLayout`; some derived layouts are computed in `pipeline/layoutBuilders.ts` and published via `RegisterLayout`.
- **Consumers**: [[lucida-core]] `Scene::apply` rebuilds `DerivedState` (member positions, projected transforms) on layout change. [[planning-domain]] reads from derived state.
- **Annotation re-anchoring**: `SetActiveLayout` also re-anchors collaborative annotations — each anchored pin translates by its anchor entity's displacement between the old and new layouts (`DocumentState::reanchor_for_layout` in `scene/types.rs`; unanchored pins are left alone).
- **Storage**: `document.registered_layouts` and `document.active_layout_ids` in [[scene-state-and-epochs|DocumentState]]. Both serialized and re-broadcast on `Snapshot`.

## Invariants

- **Layouts are document state**, not presence. Switching layout is a sequenced, persisted, broadcast `DocumentCommand`. Two clients viewing the same dataset always see the same active layout.
- **`RegisterLayout` is dedupe-by-id.** Repeated registration of the same `LayoutId` is a no-op (verified by the `register_layout_dedupes_by_id` test). This makes derived layouts safe to publish unconditionally on dataset open.
- **Derived state reflects the active layout.** Member positions in `DerivedState` are post-layout — what the planner uses. The planner does not know about layouts; it sees only positions.
- **Default layout is the fallback.** Unknown active-layout IDs don't error; derived state falls back to the default. This means a stale snapshot in a CLI session won't corrupt itself just because the active layout is missing.

## Gotchas

- **Layout `id` is the dedupe key**, not `name`. Two layouts with the same name and different IDs both register; same ID re-registers as a no-op. Builder code that generates layout IDs procedurally (e.g. `derived:dense`) needs to keep the ID stable across regenerations.
- **For plates, `placements` only positions wells.** Field-within-well offsets come from `TransformEdge`s (built by `lucida_content::plate::build_grid_field_transforms` for grid plates, or from OME translation for stage-positioned plates). A reader looking at a plate's source layout will see N well placements and zero field placements — that's correct, not a bug.
- **Position is `[x, y]` in world units**, not `[y, x]`. The same convention as the layout source, but easy to get wrong if you're translating from chunk-key conventions (which are TCZYX, with X last).
- **Layout switches force a `derived` rebuild for that dataset only**, not all datasets. This is correct — but if you have 50 plates loaded and you switch each in sequence, expect 50 derived rebuilds in quick succession. The epoch bumps once per switch.
- **The layout epoch (`epochs.layout`) bumps on `RegisterLayout` too**, not just `SetActiveLayout`. Consumers (e.g. the LayoutSwitcher dropdown populating) want this; the planner doesn't (the active layout didn't change). The tick coordinator's epoch fast-path treats them as a single bucket — a `RegisterLayout` will trigger one (cheap) plan re-run.
