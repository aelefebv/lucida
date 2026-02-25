# render.image

## Command
```bash
lucida render image --view-id <view_id> --width-px 256 --height-px 192 --delivery inline_base64 --session-id <session_id> --json
```

## Required Inputs
- `view_id`
- `output.width_px`
- `output.height_px`

## Expected Output Fields
- `status`
- `state_hash`
- `images[0].sha256`
- `meta.pyramid_level_used`

## Common Failure Codes
- `invalid_render_request`
- `render_output_too_large`
- `unsupported_mode`
- `view_not_found`
