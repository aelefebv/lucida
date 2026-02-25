# Current CLI Workflow Reference

For operation metadata and required response fields, start with [operation-matrix.md](operation-matrix.md).

Use `lucida ... --json` for machine-readable responses.
Set `LUCIDA_BASE_URL` when daemon does not run on `http://127.0.0.1:3000`.

## Bootstrap Sequence
1. `session.create`
2. `dataset.open`
3. `view.create`
4. `render.image`

## Operation Templates
- `session.create`: [../templates/cli/session-create.md](../templates/cli/session-create.md)
- `dataset.open`: [../templates/cli/dataset-open.md](../templates/cli/dataset-open.md)
- `view.create`: [../templates/cli/view-create.md](../templates/cli/view-create.md)
- `view.state`: [../templates/cli/view-state.md](../templates/cli/view-state.md)
- `view.update`: [../templates/cli/view-update.md](../templates/cli/view-update.md)
- `view.export`: [../templates/cli/view-export.md](../templates/cli/view-export.md)
- `view.import`: [../templates/cli/view-import.md](../templates/cli/view-import.md)
- `view.dim`: [../templates/cli/view-dim.md](../templates/cli/view-dim.md)
- `view.range`: [../templates/cli/view-range.md](../templates/cli/view-range.md)
- `view.indices`: [../templates/cli/view-indices.md](../templates/cli/view-indices.md)
- `view.plane`: [../templates/cli/view-plane.md](../templates/cli/view-plane.md)
- `view.pan`: [../templates/cli/view-pan.md](../templates/cli/view-pan.md)
- `view.zoom`: [../templates/cli/view-zoom.md](../templates/cli/view-zoom.md)
- `render.image`: [../templates/cli/render-image.md](../templates/cli/render-image.md)

## Grouped Navigation
- `view dim|range|indices|plane|rotation`
- `view pan|zoom|rotate`
- `view state|selectors|camera|bounds|screenshot`

## Validation Checklist
- Confirm all command outputs include documented required fields.
- Prefer `--json` and parse fields rather than pattern-matching logs.
- If command fails, capture `{code, message, details}` and map via troubleshooting reference.
