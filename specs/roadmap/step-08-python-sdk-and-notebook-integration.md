# Step 08 Sub-Spec: Python SDK and Notebook Integration

## Objective
Provide a typed Python SDK that controls Lucida sessions from scripts and Jupyter notebooks with minimal friction.

## What Lives in This Sub-Spec
- SDK client lifecycle (`launch_or_connect`, `connect`, session helpers).
- Typed request/response/event models generated from schema.
- Notebook interaction patterns and examples.
- Error handling and retry ergonomics.

## Scope
In scope:
1. Core SDK calls that map 1:1 to protocol methods.
2. Typed model exposure and validation utilities.
3. Event subscription APIs for notebook workflows.

Out of scope:
1. Plugin ecosystem for arbitrary extensions.
2. Non-Python official SDKs.

## Interface and Contract Changes
- Keep SDK synchronized with protocol schema versions.
- Ensure generated models stay reproducible and checked in CI.

## Deliverables
1. SDK client modules and typed APIs.
2. Notebook-focused usage docs/examples.
3. SDK unit/integration tests with daemon test harness.

## Test and Acceptance Gates
1. SDK can control live daemon sessions from notebook cells.
2. Generated model freshness checks pass.
3. Protocol errors map to ergonomic SDK exceptions.

## Dependencies
- Step 01 protocol artifacts.
- Step 07 daemon runtime.

## Exit Criteria
Step 08 is complete when users can script end-to-end viewer workflows from Python reliably.
