# view.create

## Command
```bash
lucida view create --dataset-id <dataset_id> --session-id <session_id> --mode 2d --json
```

## Required Inputs
- `dataset_id`

## Expected Output Fields
- `view_state.view_id`
- `view_state.state_hash`
- `view_state.state_version`

## Common Failure Codes
- `dataset_not_found`
- `unsupported_mode`
- `invalid_request`
