# Step 02 Sub-Spec: ND State Model and Transforms

## Objective
Implement the canonical ND runtime state model and anisotropic transform system that backs protocol operations.

## What Lives in This Sub-Spec
- Session/dataset/layer/view/camera/selection state structures.
- Deterministic state transition rules for protocol commands.
- Axis remapping and canonical axis semantics.
- World transform behavior with anisotropy.

## Scope
In scope:
1. In-memory state graph for active sessions.
2. Command dispatcher from protocol method to state transition.
3. Transform math and validation.
4. Async job scaffolding for long-running operations.

Out of scope:
1. Real rendering backend.
2. Real OME-Zarr data loading.

## Interface and Contract Changes
- Map every step-1 method to explicit state transitions or typed errors.
- Introduce stable internal state types for command handlers.
- Enforce idempotency and request correlation in state transitions.

## Deliverables
1. Core state modules (`lucida-core` planned).
2. Transform utilities and axis remap helpers.
3. Command dispatcher skeleton with typed errors.
4. Unit tests for transitions and transform correctness.

## Test and Acceptance Gates
1. Deterministic command replay over the same inputs yields identical state.
2. Axis reorder and index changes validate against dataset shape.
3. Anisotropic transforms preserve physical scale semantics.
4. Job lifecycle transitions follow allowed state machine edges.

## Dependencies
- Step 01 protocol contract.

## Exit Criteria
Step 02 is complete when command/state behavior is deterministic, validated, and ready for IO and renderer integration.
