# view.plane

## Command
```bash
lucida view plane --view-id <view_id> --plane xz --session-id <session_id> --json
```

## Required Inputs
- `view_id`
- `plane`

## Expected Output Fields
- `view_state.view_2d.plane`
- `view_state.state_hash`

## Common Failure Codes
- `view_not_found`
- `invalid_patch`
- `unsupported_plane`
