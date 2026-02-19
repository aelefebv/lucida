# Step 09 Sub-Spec: Command Log Replay

## Objective
Implement deterministic command log export/import/replay for reproducible workflows and debugging.

## What Lives in This Sub-Spec
- JSONL record write/read behavior.
- Correlation between command records and resulting events.
- Replay execution modes and validation checks.
- Conflict handling and failure reporting.

## Scope
In scope:
1. `command_log.export`, `command_log.import`, `command_log.replay` behavior.
2. Replay compatibility/version checks.
3. Deterministic replay ordering and state comparison hooks.

Out of scope:
1. Full interactive undo/redo stack.
2. Time-travel visualization UX.

## Interface and Contract Changes
- Enforce log schema and strict record validation.
- Define replay job status and progress event semantics.

## Deliverables
1. Command log writer/reader modules.
2. Replay engine with dry-run mode.
3. Determinism and roundtrip tests.

## Test and Acceptance Gates
1. Export -> import -> replay produces equivalent state on deterministic fixtures.
2. Incompatible protocol versions fail fast with typed errors.
3. Replay progress/events are ordered and complete.

## Dependencies
- Step 02 deterministic state transitions.
- Step 07 daemon/event lifecycle.

## Exit Criteria
Step 09 is complete when command logs can be used as reliable, replayable workflow artifacts.
