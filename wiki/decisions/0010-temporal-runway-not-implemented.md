---
created: 2026-04-18
modified: 2026-05-07
---

# Temporal Runway — Won't Implement

## Decision

GPU-side temporal runway (keeping next-timepoint chunks resident on the GPU without slot mapping) was **considered and not pursued**. The conclusion (recorded in project memory, `project_runway_decision.md`, dated 2026-04-17) was that a CPU-side runway plus scrubbing-aware eviction is sufficient for the workloads the team cares about.

## Why not GPU-side runway

- **GPU memory is the binding constraint** for plate datasets. Reserving slots for next-timepoint speculation means fewer slots available for currently-visible detail; the latter is always more valuable.
- **Mapping vs unmapping is the expensive part of GPU residency**, not the upload itself. Once chunks are in the [[cpu-cache]], pushing them to a free GPU slot is fast. So a runway that lives in the CPU cache and uploads on-demand at scrub time has competitive perceived latency without sacrificing GPU capacity.
- **Scrubbing patterns are bursty, not continuous.** Users scrub through a range, pause, then scrub more. The CPU cache's runway lane (`RUNWAY` priority, ~1000 offset in the priority formula) keeps the relevant chunks decoded; the GPU upload happens at the scrub event. Latency is a few ms — well under perceptual threshold.

## What stayed

- **CPU-side runway lane** — chunks one or two timepoints ahead of `currentT` are speculatively fetched and decoded with `RUNWAY` priority. They live in the runway tier of the CPU cache and evict first when memory is tight.
- **Scrubbing-aware eviction** — when the user scrubs past a timepoint, the GPU worker evicts the now-stale slots; the CPU cache's runway feeds the next ones.

## Related

- [[cpu-cache]] — runway tier and lane priority
- [[chunk-pipeline]] — where the runway lane shows up in the priority formula
- [[planning-domain]] — emits runway requests
