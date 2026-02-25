# Current HTTP Workflow Reference

For operation metadata and required response fields, start with [operation-matrix.md](operation-matrix.md).

Use daemon endpoints from `crates/lucida-daemon/src/lib.rs`.
Use `schema_version: 1` on all POST payloads.

## Bootstrap Sequence
1. `POST /session/create`
2. `POST /dataset/open`
3. `POST /view/create`
4. `POST /render/image`

## Operation Templates
- `session.create`: [../templates/http/session-create.json](../templates/http/session-create.json)
- `dataset.open`: [../templates/http/dataset-open.json](../templates/http/dataset-open.json)
- `view.create`: [../templates/http/view-create.json](../templates/http/view-create.json)
- `view.state`: [../templates/http/view-state.json](../templates/http/view-state.json)
- `view.update`: [../templates/http/view-update.json](../templates/http/view-update.json)
- `view.export`: [../templates/http/view-export.json](../templates/http/view-export.json)
- `view.import`: [../templates/http/view-import.json](../templates/http/view-import.json)
- `view.dim`: [../templates/http/view-dim.json](../templates/http/view-dim.json)
- `view.range`: [../templates/http/view-range.json](../templates/http/view-range.json)
- `view.indices`: [../templates/http/view-indices.json](../templates/http/view-indices.json)
- `view.plane`: [../templates/http/view-plane.json](../templates/http/view-plane.json)
- `view.pan`: [../templates/http/view-pan.json](../templates/http/view-pan.json)
- `view.zoom`: [../templates/http/view-zoom.json](../templates/http/view-zoom.json)
- `render.image`: [../templates/http/render-image.json](../templates/http/render-image.json)

## Validation Checklist
- Confirm status codes and JSON body shape, not only transport success.
- Validate required response fields in operation matrix.
- Validate failure code expectations for negative-path scenarios.
