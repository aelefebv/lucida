# Step 01 Sub-Spec: Core Interfaces and Command Protocol

## Objective
Freeze a versioned, machine-readable control contract so daemon and SDK implementations can proceed without interface ambiguity.

## What Lives in This Sub-Spec
- Method taxonomy and naming (`domain.method`).
- Version negotiation and compatibility behavior.
- Request/response/event schema contracts.
- Idempotency, async-job, and error envelope rules.
- Command-log format and replay compatibility constraints.

## Scope
In scope:
1. OpenRPC registry.
2. JSON Schemas (common, requests, responses, events, errors, command-log).
3. Generated Python protocol models.
4. Protocol conformance tests.

Out of scope:
1. Rendering implementation.
2. OME-Zarr runtime IO behavior.
3. UI implementation.

## Interface and Contract Changes
- Freeze all v1 protocol methods listed in `SPEC.md` section 17.2.
- Require `idempotency_key` on mutating calls.
- Require dedicated event stream with monotonic `session_seq` per session.

## Deliverables
1. `protocol/openrpc/lucida.v1.openrpc.json`
2. `protocol/schemas/**/*.schema.json`
3. `protocol/command-log/lucida.commandlog.v1.schema.json`
4. `python/lucida_sdk/protocol/generated/models.py`
5. `tests/protocol/*`

## Test and Acceptance Gates
1. OpenRPC references are complete and stable.
2. Schema validation tests pass.
3. Generated models are fresh (`--check` passes).
4. Golden method-list test passes.

## Dependencies
- None.

## Exit Criteria
Step 01 is complete when protocol consumers can implement daemon and SDK behavior without making new interface decisions.
