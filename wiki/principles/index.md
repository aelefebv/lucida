---
created: 2026-05-14
modified: 2026-05-16
---

# Principles

Stable claims about what each subsystem optimizes for, and why. Principles are the framework that ADRs live within.

ADRs cite principles as the justification for specific decisions. Principles never cite ADRs — they remain agnostic to which decisions exist today, so they continue to apply as decisions change. If a proposed change cannot honor a principle, surface it as an ADR that names the principle being relaxed.

## Articles

- [[principles/planning]] — what the planning domain optimizes for: visual smoothness, memory bounds, well coherence, purity, WASM as truth, anticipation
- [[principles/cpu-cache]] — what the host-side cache between network and GPU optimizes for: survive GPU eviction, tier-aware protection, movement over deletion, attention-aware active-set eviction, windowed failure, single fetch path
