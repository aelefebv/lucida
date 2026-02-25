# view.import

## Command
```bash
lucida view import --view-state-file <view_state_file> --session-id <session_id> --json
```

## Required Inputs
- `view_state`

## Expected Output Fields
- `import_id`
- `view_state.view_id`
- `view_state.state_hash`

## Common Failure Codes
- `invalid_request`
- `dataset_not_found`
- `unsupported_mode`
