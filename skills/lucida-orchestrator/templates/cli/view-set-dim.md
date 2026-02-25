# view.set.dim

## Command
```bash
uv run lucida view set dim --view-id <view_id> --axis z --index 1 --session-id <session_id> --json
```

## Required Inputs
- `view_id`
- `axis`
- `index`

## Expected Output Fields
- `view_state.selectors`
- `view_state.state_hash`

## Common Failure Codes
- `view_not_found`
- `invalid_patch`
