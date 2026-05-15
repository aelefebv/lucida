---
created: 2026-04-18
modified: 2026-05-14
---

# GPU-Side Temporal Lookahead — Won't Implement

## Decision

GPU-side temporal lookahead (keeping next-timepoint chunks resident on the GPU without slot mapping) was **considered and not pursued**. The conclusion (recorded in project memory, `project_runway_decision.md`, dated 2026-04-17) was that the CPU-side prefetch lane plus scrubbing-aware eviction is sufficient for the workloads the team cares about.

> **Terminology note (added 2026-05-14):** This ADR was originally drafted using "runway" as the name for the temporal-lookahead concept. The shipping code calls the same lane `prefetch` (and uses `PREFETCH_LANE_OFFSET` / `PREFETCH_DEPTH` constants). The two names refer to the same thing; the code's `prefetch` terminology won. This ADR has been edited in place to use "prefetch."

## Why not GPU-side lookahead

- **GPU memory is the binding constraint** for plate datasets. Reserving slots for next-timepoint speculation means fewer slots available for currently-visible detail; the latter is always more valuable.
- **Mapping vs unmapping is the expensive part of GPU residency**, not the upload itself. Once chunks are in the [[cpu-cache]], pushing them to a free GPU slot is fast. So a CPU-side prefetch that uploads on-demand at scrub time has competitive perceived latency without sacrificing GPU capacity.
- **Scrubbing patterns are bursty, not continuous.** Users scrub through a range, pause, then scrub more. The CPU cache's prefetch tier keeps the relevant chunks decoded; the GPU upload happens at the scrub event. Latency is a few ms — well under perceptual threshold.

## What stayed

- **CPU-side prefetch lane** — chunks one or two timepoints ahead of `currentT` are speculatively fetched and decoded at `PREFETCH_LANE_OFFSET` priority. They live in the prefetch tier of the CPU cache and evict first when memory is tight.
- **Scrubbing-aware eviction** — when the user scrubs past a timepoint, the GPU worker evicts the now-stale slots; the CPU cache's prefetch tier feeds the next ones.

## Related

- [[cpu-cache]] — prefetch tier and lane priority
- [[chunk-pipeline]] — where the prefetch lane shows up in the priority formula
- [[planning-domain]] — emits prefetch requests
