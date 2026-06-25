---
created: 2026-05-14
modified: 2026-06-25
---

# Principles

## What a principle is

A principle is a guiding light, not a mechanism. It is an aspirational, directional statement about what this part of the product *should optimize for* — the kind of thing you'd want to be true even after every line of today's code has been rewritten. It tells you which way to lean when a decision is a genuine trade-off and the spec alone won't settle it.

A principle is therefore deliberately *blind to decisions*. It names a direction ("prefer the smoother render"), never an implementation ("use epoch-gated texture atlasing"). The moment a statement names a data structure, a file, or a wire format, it has stopped being a principle and become a mechanic — and mechanics belong in ADRs and subsystem docs, not here. The test: if the sentence could only have been written by someone who'd read the current code, it's too low.

Principles are read by the rest of the wiki, never read from it. ADRs cite a principle as the *justification* for a specific choice; a principle never cites an ADR back, so it keeps applying as the decisions underneath it change. When a proposed change can't honor a principle, that's not a reason to quietly edit the principle — it's an ADR that names the principle being relaxed, the alternatives weighed, and why the trade was worth it.

## The docs

Two altitudes. **Product principles** are cross-cutting north-stars about what Lucida is for its users — who its clients are, what an agent can do, how views are shared, where it runs. **Subsystem principles** say what one part of the system optimizes for. A reader should know which altitude they're reading at.

### Product

- [[principles/surface-parity]] — web, CLI, Python, and LLM agents are all first-class clients of the same workspace; every surface sees the same datasets, the same chunks, and the same live state.
- [[principles/agent-first-access]] — Lucida is drivable without a human in the loop: an agent can orient (montage), render any view headless, drill to an exact slice, and read dataset health — all programmatically and reproducibly.
- [[principles/collaboration-and-reproducibility]] — a view is a thing you can hand to someone: any view is a link that re-opens exactly, and what one user sees a peer can see and follow.
- [[principles/runs-anywhere-and-open]] — one open, local-first product: a single server binary, configurable from day one, where dataset size or dimensionality is never a reason not to open data.

### Subsystem

- [[principles/planning]] — what the per-tick chunk planner optimizes for: the smoother render over the cheaper fetch, memory as the hard floor, well coherence, planner purity, one-home view math, anticipation.
