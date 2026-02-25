# Current Surface Troubleshooting

## `view_not_found`
- Cause: view id does not exist or does not belong to provided session.
- Recovery:
  1. Re-fetch active view ids after `view.create` or `view.import`.
  2. Re-run command with matching `--session-id` / `session_id`.

## `unsupported_mode`
- Cause: request asks for a mode or path not currently implemented by this repository state.
- Recovery:
  1. Force `mode: "2d"` in `view.create`.
  2. Remove `view_3d` payload in import/render workflows.

## `render_output_too_large`
- Cause: `render.image` exceeds daemon guardrails (`>4096` per dimension or max pixels).
- Recovery:
  1. Reduce `width_px` and `height_px`.
  2. Prefer repeated tiled renders for larger coverage.

## `invalid_request`
- Cause: payload shape mismatch or missing required field.
- Recovery:
  1. Start from operation HTTP template and only substitute placeholders.
  2. Ensure `schema_version` and field names match canonical templates.

## `invalid_patch`
- Cause: malformed RFC6902 patch or invalid post-patch view state.
- Recovery:
  1. Validate patch array shape and operation paths.
  2. Apply smallest possible patch and re-check `view.get.state` output.

## `dataset_not_found`
- Cause: dataset id not opened in runtime state.
- Recovery:
  1. Run `dataset.open` and keep returned `dataset_id`.
  2. Re-run `view.create`/`view.import` with the attached dataset.
