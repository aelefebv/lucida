---
created: 2026-05-18
modified: 2026-05-18
---

# Budgeted proxy GPU residency

Status: Accepted

## Decision

Proxy GPU residency is a budgeted, planning-owned desired set rather than an
unbounded consequence of every advertised visible proxy.

Planning ranks coherent well-level proxy bundles across the worker's visible
inputs, admits only the best bundles that fit the configured worker-global GPU
proxy budget, and sends that budgeted desired proxy set to the GPU worker. The
worker reconciles resident proxy atlases to the desired set: wanted-set feedback
reports only desired-but-missing proxies, stale or no-longer-desired uploads are
dropped, and descriptors are cleared when resident proxies leave the desired
set.

The first implementation uses a 128 MB default worker-global proxy budget with a
Debug Config override. Atlas packing moves away from the current one-dimensional
X-only slot layout to grid/3D packing constrained by device limits and the memory
budget.

## Why

The previous model treated advertised visible proxies as implicitly wanted on
the GPU. That breaks down in large plate views: a 384-well plate with multiple
fields and channels can expose far more `FieldProxy3D` candidates than a proxy
pool can hold. With the current X-only slot layout, `128x128x1` field proxies ask
for 64 slots but clamp to 16 on common 3D texture dimension limits. When more
than 16 still-wanted proxies are visible for a pool, pure LRU evicts proxies that
the worker immediately reports as missing, and the main thread reuploads them
from CPU cache. The result is a steady CPU-to-GPU upload loop even when network
fetching is not the bottleneck.

Memory is the binding constraint here, so the system needs a positive decision
about which proxies deserve GPU residency, not a reactive eviction loop after
everything has already been declared wanted. Whole-well bundles preserve the
plate invariant from [[decisions/0025-wells-as-planning-unit]]: fields within a
well should not diverge arbitrarily because of slot-level eviction.

Keeping the policy in planning follows [[principles/planning#4-planning-is-pure-carry-forward-state-is-explicit]]:
the ranking and budget decision can be tested from snapshots, catalog metadata,
and explicit config. The worker stays responsible for GPU resources, descriptor
updates, and stale upload rejection, but it no longer invents residency policy.

## Consequences

- A proxy can be advertised and visible without being desired for GPU residency.
- The asset catalog/proxy availability contract needs estimated proxy dimensions
  and bytes so planning can budget before fetching or uploading proxy bytes.
- `TickCoordinator` needs a worker-global proxy budget pass across the visible
  dataset/member plans before cold state and uploads are submitted.
- `wantedSetDelta` changes meaning for proxies: missing feedback is scoped to
  the budgeted desired proxy set, not every advertised fallback.
- `epochs.request` is the staleness boundary for proxy policy and late uploads;
  a separate proxy-policy epoch is intentionally deferred unless implementation
  proves it is necessary.
- Detail chunk planning remains independent. Proxy budget exhaustion should not
  block active detail chunk loading.
- Telemetry needs to expose budget bytes, resident bytes, admitted/skipped
  bundles, evictions, late drops, and upload churn so the policy can be tuned.

## How this decision should show up in code

- `lucida-web/src/pipeline/planning/` — pure proxy budget/ranking module that
  admits coherent well bundles and returns desired proxy keys.
- `lucida-web/src/pipeline/tickCoordinator.ts` — collects plan candidates, runs
  the worker-global proxy budget pass, and submits cold state/upload work from
  the filtered desired set.
- `lucida-web/src/renderer/workerProtocol.ts` — cold state carries the desired
  proxy set and request epoch needed for stale upload rejection.
- `lucida-web/src/renderer/wantedSet.ts` — proxy missing feedback is
  desired-set driven.
- `lucida-web/src/renderer/proxyAtlas.ts` — proxy pools use grid/3D packing and
  memory-budget-derived capacity rather than X-only slot count.
- `lucida-web/src/renderer/proxy/upload.ts` — uploads reconcile against the
  desired set, clear descriptors on eviction, and drop late non-desired proxies.
- `lucida-server` / `lucida-proxy` proxy availability code — proxy metadata
  exposes estimated dimensions and bytes for planning.

## Related

- [[decisions/0004-multi-pool-atlases]]
- [[decisions/0024-catalog-degrade-one-tier-at-a-time]]
- [[decisions/0025-wells-as-planning-unit]]
- [[decisions/0037-delivery-state-as-cpucache-sidecar]]
- [[principles/planning#2-memory-is-the-binding-constraint]]
- [[principles/planning#3-wells-are-coherent-visual-units]]
- [[principles/planning#4-planning-is-pure-carry-forward-state-is-explicit]]
- PRD #664
