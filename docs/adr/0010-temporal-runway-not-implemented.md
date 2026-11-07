# GPU-side temporal lookahead: won't implement

Status: Accepted.

## Context

Scrubbing through time could be smoother if chunks for the next timepoints were already
resident on the GPU. The question was whether to reserve GPU slots for that speculation.

## Decision

Temporal lookahead stays on the CPU. The prefetch lane fetches and decodes chunks one or two
timepoints ahead of the current one at `PREFETCH_LANE_OFFSET` priority, into the CPU cache's
prefetch tier, which evicts first. The GPU upload happens when the user scrubs, and stale
slots are evicted as they pass.

## Rejected alternatives

- GPU-resident lookahead. GPU memory is the binding constraint for collections, and a slot
  held for a speculative timepoint is a slot taken from visible detail. Uploading from the CPU
  cache into a free slot is fast; mapping and unmapping is the expensive part, and lookahead
  does not avoid it. Scrubbing is bursty, so an upload at the scrub event stays well under
  perceptual latency.
