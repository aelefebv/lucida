# view.move.zoom

## Command
```bash
uv run lucida view move zoom --view-id <view_id> --factor 1.5 --session-id <session_id> --json
```

## Required Inputs
- `view_id`
- `factor`

## Expected Output Fields
- `view_state.view_2d.camera.zoom`
- `view_state.state_hash`

## Common Failure Codes
- `view_not_found`
- `invalid_patch`
