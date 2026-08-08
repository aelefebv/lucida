---
type: Principle
title: "Principles — Planning Domain"
description: "Planning is the subsystem that, each tick, decides which chunks the renderer wants next."
tags: [lucida, principle]
source_path: wiki/principles/planning.md
created: 2026-05-14
modified: 2026-07-06
---

# Principles — Planning Domain

> What a *principle* is — guiding light, not mechanism — is defined once in [Principles](index.md). This is a subsystem-scoped principles doc.

## Scope

Planning is the subsystem that, each tick, decides which chunks the renderer wants next. These principles say what that decision optimizes for, and why — the durable direction, not the current policy. They govern the trade-offs planning is allowed to make (how much to fetch ahead, what to hold in memory, how coherent a group must look) and the shape planning must keep (pure, snapshot-driven, deferring all view math to the one Rust implementation). They do not describe the shipped coarse/detail path; where a principle and today's default disagree, the principle is recorded as direction and the gap is called out.

## 1. The smoother render wins over the cheaper fetch

Within the memory bound, planning should prefer whatever the user perceives as continuous over whatever moves the fewest bytes. When two policies are equally correct but one flickers and one doesn't, choose the one that doesn't — even if it costs a little more to fetch.

**Why.** The user experiences this system as pixels changing over time. A viewer that fetches optimally but pops and flickers is worse than one that fetches a little more and stays coherent. Smoothness is the quality that separates a good viewer from a merely fast one.

**When in tension.** Smoothness can raise memory pressure or fetch cost. Principle 2 caps both: tied trades go to smoothness, bounded trades respect the bound.

## 2. Stay within memory; nothing is allowed past it

Every policy must be bounded. No unbounded enumeration, no runaway fetch escalation, no carry-forward state that only grows, no asset you never let go of. Anything that holds more memory ships with three things: a budget, an eviction policy for when the budget is hit, and a defined behavior for when eviction can't keep up.

**Why.** GPU and CPU memory caps are hardware-given — we cannot engineer past them. Every "let's also keep X around" needs its paired "…and we'll release X when Y." Without that pairing, a large dataset simply exhausts memory and the renderer dies.

**This is a constraint, not a preference.** No other principle may violate it; it is the one that wins every tie it's in.

## 3. A group reads as one thing, so it should render as one thing

In a collection, all the tiles of a single group are one visual unit. They should agree on representation and timing. Per-tile divergence inside a group is not something to optimize toward — it's something to avoid.

**Why.** The user reads "group B7," not "tile 4 of group B7." Giving sibling tiles different representations produces a visible patchwork that the eye reads as a rendering defect, not as meaningful variation.

**When in tension.** Coherence can cost responsiveness: if one tile could load faster than its siblings, coherence makes everyone wait for the slowest. This principle says that's the right call.

**Where today's default disagrees.** The shipped coarse/detail path resolves residency tiers *per tile* (see Planning Domain), so this principle currently describes the direction we want, not the behavior we have. Kept as a guiding light, flagged as not-yet-true.

## 4. Planning is a pure function of a snapshot

Planning should take a snapshot in and hand a plan back, with nothing hidden in between. Any state that needs to survive from one tick to the next is an explicit input, passed in and out in the open — never a private cache, a module global, or a static the planner reaches for on its own.

**Why.** A pure function is testable without mocks, debuggable without runtime context, and swappable behind its contract. Hidden state is the classic cause of "passes in the test, breaks in the app" bugs in render pipelines, and it makes A/B-comparing two planning strategies on identical inputs impossible.

## 5. The view math has one home, and planning isn't it

What is visible, and at what apparent size, is decided once — in `lucida-core` — and planning reads the answer from the snapshot. Planning should never recompute projected size, frustum geometry, importance, or LOD on the JS side. If a number planning needs isn't in the snapshot, the right move is to grow the snapshot, not to re-derive the number.

**Why.** That visibility math has a single Rust implementation, shared by the server, the CLI, and the Python bindings as well as the web client. A second copy in JS would be a second set of subtly different bugs, drifting apart over time. The boundary is the price we pay to keep exactly one source of that truth. (This is the planner's view of the product-level [Surface Parity](surface-parity.md).)

## 6. Fetch a step ahead of the user's likely next move

Planning may fetch a little past the current view to absorb the next plausible gesture — a zoom step, a timepoint scrub, a glance at the neighboring entity — so that when the user makes that move, the data is already there. How far ahead it reaches is capped by principle 2.

**Why.** User input is bursty: pan, zoom, scrub, pause. If planning only starts work when a gesture begins, the fetch latency for just-arrived data is too long to feel responsive. Pre-fetching the most likely next state, sized to fit the bound, makes remote data feel local.

**When in tension.** Anticipation costs memory and bandwidth. Principle 2 caps it; principle 1 says that, within the cap, the path that absorbs the next gesture more smoothly is the one to take.

## How these pull against each other

These principles are not equally weighted, and most of the real decisions live in the tension between them.

- **Memory (2) is the hard floor.** Nothing may cross it; it wins every tie.
- **Smoothness (1) and anticipation (6) trade against each other** inside the bound — more lookahead is usually smoother but costs more memory and bandwidth.
- **Group coherence (3) constrains what 1 and 6 may do** at the per-tile level.
- **Purity (4) and one-home view math (5) are about *how* planning is built**, not *what* it optimizes for — they shape the subsystem so the other four stay testable and consistent.

When a change can't satisfy all six at once, don't soften a principle to fit the change. Write the ADR: name the principle being relaxed, the alternatives considered, and why the trade is worth making.
