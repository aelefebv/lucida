# ADR-0003: Dual Data Representations

- Status: Accepted
- Date: 2026-03-01

## Context

Lucida must support both high-quality 2D interaction and 3D rendering on large datasets. A single storage and streaming representation does not provide optimal behavior for both workloads.

2D browsing wants viewport-oriented multiscale tiles and previews. 3D interaction wants volumetric bricks shaped for 3D sampling locality.

## Decision

Lucida uses dual data representations:

- 2D representation for previews and tile streaming
- 3D representation for brick streaming

Both derive from the same source generation and are addressed through immutable chunk identity semantics.

## Consequences

- 2D and 3D paths can be independently tuned for latency and throughput.
- Build and storage complexity increases because two derived representations are maintained.
- Generation consistency rules must ensure frame-level coherence per layer and generation.

## Alternatives Considered

- 2D-only representation reused for 3D: rejected due to poor 3D performance and quality.
- 3D-only representation reused for 2D: rejected due to unnecessary overhead for common 2D workflows.
