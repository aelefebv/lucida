# view.set.set

## Command
```bash
uv run lucida view set set --view-id <view_id> --axis z --index 0 --index 2 --session-id <session_id> --json
```

## Required Inputs
- `view_id`
- `axis`
- `indices`

## Expected Output Fields
- `view_state.selectors`
- `view_state.state_hash`

## Common Failure Codes
- `view_not_found`
- `invalid_patch`
