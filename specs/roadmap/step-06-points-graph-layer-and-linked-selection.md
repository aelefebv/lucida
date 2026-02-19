# Step 06 Sub-Spec: Points/Graph Layer and Linked Selection

## Objective
Support interactive million-point ND graph visualization with linked selection into image context.

## What Lives in This Sub-Spec
- Points layer data contract and render path.
- LOD/downsampling behavior for large point sets.
- Attribute-based color/filter semantics.
- Linked selection events and state propagation.

## Scope
In scope:
1. `layer.add_points` rendering path using `DataRef` payload descriptors.
2. Attribute filtering and coloring.
3. Selection tools (box/lasso semantics at contract level).
4. Event hooks for linked selection.

Out of scope:
1. In-app clustering/embedding algorithms.
2. Heavy analytics pipelines.

## Interface and Contract Changes
- Define points-layer state shape used by `layer.get` and `selection.get`.
- Define event payload semantics for selection updates.

## Deliverables
1. Points layer state + renderer integration.
2. Selection subsystem integration.
3. LOD policy implementation.
4. Scale tests for million-point workloads.

## Test and Acceptance Gates
1. Large point datasets remain interactive under target thresholds.
2. Selection state is deterministic and replayable.
3. Linked selection emits ordered, valid events.

## Dependencies
- Step 02 state model.
- Step 04/Step 05 renderer foundations.

## Exit Criteria
Step 06 is complete when point-heavy workflows are interactive and selection linking is reliable.
