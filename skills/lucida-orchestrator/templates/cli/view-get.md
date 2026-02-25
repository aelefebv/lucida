# view.get

## Command
```bash
uv run lucida view get --view-id <view_id> --session-id <session_id> --json
```

## Required Inputs
- `view_id`

## Expected Output Fields
- `view_state.view_id`
- `view_state.state_hash`
- `view_state.state_version`

## Common Failure Codes
- `view_not_found`
