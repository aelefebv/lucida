---
type: Decision
title: "Delivery state as a CpuCache sidecar"
description: "CpuCache owns chunk/proxy delivery state as a fetch-side sidecar, next to RejectionTracker."
tags: [lucida, decision]
source_path: wiki/decisions/0037-delivery-state-as-cpucache-sidecar.md
created: 2026-05-17
modified: 2026-05-17
---

# Delivery state as a CpuCache sidecar

Status: Accepted

## Decision

`CpuCache` owns chunk/proxy delivery state as a fetch-side sidecar, next to `RejectionTracker`. The upload path no longer keeps a separate `DeliveryTracker`, planner-stashed request maps, or a `ready[]` drain queue. Instead, `CpuCache.getDeliverable()` enumerates cached, currently-wanted, not-yet-sent entries in strict priority order, and `Uploader.deliverToWorker` is a single dispatch loop over that iterable.

The state records optimistic **sent** facts, not acknowledged delivery. A chunk or proxy becomes sent when posted to the worker; worker feedback clears that fact through `cpuCache.markChunkEvicted(...)` or `cpuCache.markProxyMissing(...)`.

## Why

The previous upload-side tracker was stateful residue across the planner/uploader boundary. Planning produced request lists, `Uploader.recordPlanForDataset` stashed them, and resend passes later joined those snapshots back to `CpuCache` cache state. That made cache residency, wanted state, rejection state, and sent state live in different owners even though every resend decision needed all four.

Moving delivery state into `CpuCache` extends [CpuCache as Sole Fetch Path](0008-cpu-cache-as-sole-fetch-path.md): the cache is not only the sole fetch path, it is also the owner of the "can this cached thing be delivered now?" predicate. It also extends [`orchestrator.ts` split into `pipeline/upload/` modules](0034-orchestrator-split-into-pipeline-upload.md) by removing the last planner-staging hooks from the uploader seam.

The final shape is easier to reason about: planning submits wanted work, `CpuCache` records the wanted generation and cached bytes, and upload asks for deliverables without carrying planner snapshots.

## Consequences

- Send order changes from drain-first/resend-later to strict priority across chunks and proxies.
- `currentSubmitTick` is a plan-rebuild generation, advanced once by `cpuCache.onPlanRebuildStart()`, not once per dataset submit.
- Chunk sent state clears on cold-state rebuild; proxy sent state survives until the worker reports a missing proxy or the dataset is removed.
- Worker member-id parsing stays at wire boundaries (`dispatch` / `feedback` / resource cleanup). `DeliveryState` keys chunks by `(imageId, c, chunkKey)` and proxies by their composite proxy key.
- `DeliveryState` is intentionally pure: no worker IDs, no clocks, no I/O.

## How this decision shows up in code

- `lucida-web/src/pipeline/fetch/deliveryState.ts` — pure sent-state collaborator.
- `lucida-web/src/pipeline/fetch/cpuCache.ts` — `onPlanRebuildStart`, `getDeliverable`, `markSent`, `markChunkEvicted`, and `markProxyMissing`.
- `lucida-web/src/pipeline/upload/uploader.ts` — single priority send loop; no `recordPlanForDataset` or `onPlanRebuildStart`.
- `lucida-web/src/pipeline/upload/delivery/dispatch.ts` and `feedback.ts` — wire-boundary member-id construction/parsing.
- `lucida-web/src/pipeline/upload/delivery/resources.ts` — worker resource lifecycle tracking, separate from delivery state.

## Related

- [CpuCache as Sole Fetch Path](0008-cpu-cache-as-sole-fetch-path.md)
- [`cpuCache.ts` split into `pipeline/fetch/` modules](0032-cpucache-split-into-pipeline-fetch.md)
- [`orchestrator.ts` split into `pipeline/upload/` modules](0034-orchestrator-split-into-pipeline-upload.md)
- [CPU Cache](../systems/subsystems/cpu-cache.md)
- [Upload Pipeline](../systems/subsystems/upload-pipeline.md)
- PRD #640
