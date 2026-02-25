# view.range

## Command
```bash
lucida view range --view-id <view_id> --axis z --start 0 --end-exclusive 2 --session-id <session_id> --json
```

## Required Inputs
- `view_id`
- `axis`
- `start`
- `end_exclusive`

## Expected Output Fields
- `view_state.selectors`
- `view_state.state_hash`

## Common Failure Codes
- `view_not_found`
- `invalid_patch`
