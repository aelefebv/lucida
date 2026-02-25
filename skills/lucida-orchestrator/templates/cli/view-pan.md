# view.pan

## Command
```bash
lucida view pan --view-id <view_id> --dx-px 48 --dy-px -24 --session-id <session_id> --json
```

## Required Inputs
- `view_id`
- `dx_px`
- `dy_px`

## Expected Output Fields
- `view_state.view_2d.camera.center_world`
- `view_state.state_hash`

## Common Failure Codes
- `view_not_found`
- `invalid_patch`
