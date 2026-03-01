# ADR-0005: Dense Label ID Remap

- Status: Accepted
- Date: 2026-03-01

## Context

Label rasters can contain sparse, very large original IDs. Metadata filtering and GPU visibility operations become inefficient if they operate directly on sparse ID spaces.

Lucida requires interactive filtering for millions of labels and consistent behavior across clients.

## Decision

Lucida remaps sparse original label IDs to dense internal IDs for filter and visibility operations. Metadata and filter evaluation operate in dense-ID space, with deterministic mapping to original IDs for inspection and export.

## Consequences

- Bitset and visibility operations become practical at large scale.
- Remap build and persistence paths add storage and preprocessing work.
- Metadata/index mismatch handling must be explicit and warning-backed.

## Alternatives Considered

- Operate directly on sparse IDs: rejected due to memory and performance costs.
- Per-client ad hoc remap: rejected due to inconsistency and reproducibility risks.
