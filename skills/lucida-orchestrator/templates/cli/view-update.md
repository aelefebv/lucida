# view.update

## Command
```bash
lucida view update --view-id <view_id> --patch-file <patch_file> --session-id <session_id> --json
```

## Required Inputs
- `view_id`
- `patch`

## Expected Output Fields
- `view_state.state_hash`
- `view_state.state_version`

## Common Failure Codes
- `invalid_patch`
- `view_not_found`
