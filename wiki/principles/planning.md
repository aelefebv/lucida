---
created: 2026-05-14
modified: 2026-06-25
---

# Principles — Planning Domain

Planning is the subsystem that, each tick, decides which chunks the renderer wants. These principles describe what planning optimizes for, and why. They are stable claims about *direction*; specific design choices are recorded as ADRs that cite these principles as their justification.

Principles are blind to decisions. They are read by — never read from — the rest of the wiki.

## 1. Visual smoothness over fetch optimality

Within memory bounds, planning prefers what reduces visible flicker, pop-in, or perceptual discontinuity over what reduces total bytes fetched. When two policies are equally correct but differ on perceived continuity, the smoother one wins.

**Why.** The user perceives the system through pixels changing over time. A system that fetches optimally but flickers visibly is worse than one that fetches slightly more but renders coherently. Smoothness is the user-facing quality measure that separates a good viewer from a fast one.

**When in tension.** Smoothness can grow memory pressure or fetch cost. Principle 2 caps both. Tied trade-offs go to smoothness; bounded trade-offs respect the bound.

## 2. Memory is the binding constraint

Every policy must be bounded. No unbounded enumeration, no unbounded fetch escalation, no unbounded carry-forward state, no unbounded asset retention. Any feature that holds more memory must come with a budget, an eviction policy when the budget is hit, and a documented behaviour when the policy can't keep up.

**Why.** GPU and CPU memory caps are hardware-given; we can't engineer past them. Every "let's also keep X around" needs a paired "and we'll let X go when Y." Without this, large datasets exhaust memory and the renderer dies.

**This is a constraint, not a preference.** No other principle may violate it.

## 3. Wells are coherent visual units

On plates, all fields belonging to one well are treated as one visual unit. Fields within a well agree on representation and timing. Per-field divergence within a well is not a target.

**Why.** A plate well is a perceptual unit — the user reads "well B7," not "field 4 of well B7." A system that gives different fields different representations creates visible patchwork that reads as a rendering defect, not as informative variation.

**When in tension.** Coherence can cost responsiveness — if one field could load faster than its siblings, coherence makes everyone wait for the slowest. This principle says that's the right trade.

**In tension with the current default.** The shipped coarse/detail path resolves residency tiers *per field* (see [[planning-domain]]), so this principle is in tension with the default rather than realized by it — kept as direction, not current behavior.

## 4. Planning is pure; carry-forward state is explicit

Planning consumes a snapshot and produces a plan. State that survives across ticks is an explicit input parameter — never private to the planner. There are no globals, no module state, no hidden caches.

**Why.** Pure functions are testable without mocks, debuggable without runtime context, and replaceable behind their contract. Hidden state is the most common cause of "works in the test but not in the app" bugs in render pipelines, and it makes alternative planning strategies impossible to A/B-compare on the same inputs.

## 5. WASM owns truth; planning consumes a snapshot

What is visible at what apparent size is computed in `lucida-core` (compiled to WASM) and read via query. Planning never re-derives projected size, importance, frustum geometry, or LOD selection on the JS side. If a number planning needs isn't in the snapshot, the snapshot grows.

**Why.** The visibility math has a single Rust implementation that is also used by the server, the CLI, and the Python bindings. Reimplementing any piece of it in JS would create multiple versions of the same math, with subtly different bugs that drift over time. The boundary is the cost we pay to keep one implementation.

## 6. Anticipate the user's likely next gesture

Planning may fetch slightly ahead of the current view to absorb the next likely user motion — a zoom step, a timepoint scrub, exploration of a neighboring entity. The amount of anticipation is bounded by principle 2.

**Why.** User input is bursty: a pan, a zoom, a scrub, then a pause. The fetch latency for "just-arrived" data is too long to feel responsive if planning only starts work when a gesture begins. Pre-fetching the most likely next state, sized to fit the bound, makes interaction feel local even when the underlying data is remote.

**When in tension.** Anticipation costs memory and bandwidth. Principle 2 caps it; principle 1 says that, within the cap, the path that absorbs the next likely gesture more smoothly is preferred.

## How these interact

These principles are not equally weighted.

- **Principle 2 (memory) is a hard constraint.** Nothing may violate it.
- **Principles 1 and 6 (smoothness, anticipation) trade against each other** within the bound. More anticipation is usually smoother but costs more memory and bandwidth.
- **Principle 3 (well coherence)** constrains what 1 and 6 are allowed to do at the per-field level.
- **Principles 4 and 5 (purity, WASM as truth)** are architectural — they shape *how* planning is built, not *what* it optimizes for.

When a proposed change cannot honor all principles simultaneously, surface it as an ADR that names the principle being relaxed, the alternatives considered, and the reason for the trade-off.
