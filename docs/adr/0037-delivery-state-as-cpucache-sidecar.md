# Delivery state as a CpuCache sidecar

Status: Accepted.

## Context

Every decision to send a cached chunk or proxy to the GPU worker needs four facts: is it
cached, is it wanted, was it rejected, and was it already sent. These lived with different
owners. Planning produced request lists, the uploader stashed them, and later resend passes
joined those stale snapshots back to cache state.

## Decision

`CpuCache` owns sent state as a pure sidecar next to its rejection tracker, extending
[ADR 0008](0008-cpu-cache-as-sole-fetch-path.md): the cache owns the "can this be delivered
now?" predicate as well as the fetch. `CpuCache.getDeliverable()` yields entries that are
cached, currently wanted, and not yet sent, in strict priority order across chunks and
proxies. The uploader is one loop over that iterable and holds no planner snapshots.

Sent state is optimistic. An entry counts as sent when it is posted to the worker, not when
the worker acknowledges it. Worker feedback clears it through `markChunkEvicted` or
`markProxyMissing`. Chunk sent state also clears at each plan rebuild, while proxy sent state
lasts until the worker reports the proxy missing or the dataset is removed. The wanted
generation advances once per plan rebuild, not once per dataset submit. The sidecar holds no
worker ids, clocks, or I/O. Worker member ids are built and parsed only at the wire boundary.

## Rejected alternatives

- A separate upload-side delivery tracker fed by planner request maps and a ready queue. This
  is the shape being replaced. It split one predicate across owners and sent in drain-first,
  resend-later order instead of by priority.
