---
type: Decision
title: "Pull-Based RAF Render Loop with Typed Dirty Flags"
description: "The web client's render loop (lucida-web/src/renderLoop.ts) is pull-based and driven by requestAnimationFrame."
tags: [lucida, decision]
source_path: wiki/decisions/0009-pull-based-raf-with-typed-dirty.md
created: 2026-04-18
modified: 2026-07-04
---

# Pull-Based RAF Render Loop with Typed Dirty Flags

## Decision

The web client's render loop (`lucida-web/src/renderLoop.ts`) is **pull-based** and driven by `requestAnimationFrame`. It exposes two typed dirty flags:

- **`interactiveDirty`** — camera move, layout change, dataset add/remove, multichannel toggle, click in canvas. Renders **immediately**.
- **`residencyDirty`** — new chunk decoded, worker reports eviction, worker reports wanted-set delta. Throttled to ≈30 fps (`RESIDENCY_RENDER_INTERVAL_MS = 33ms`).

The tick still **runs** when `residencyDirty` is throttled — only the *render* call is suppressed. Uploads and planning continue so chunks keep arriving on the GPU.

## Why

Three specific failure modes shaped the design:

1. **Pure event-driven render** would re-render on every chunk arrival, swamping the GPU during burst loading.
2. **Pure RAF-every-frame render** wastes battery and GPU cycles when nothing changed.
3. **Single dirty bit** can't tell the difference between "user moved" (must render now) and "chunk arrived" (batch with siblings).

The typed split lets the loop be aggressive when the user wants snap response (`interactiveDirty`) and patient when only data changed (`residencyDirty`).

## Throttle rationale

- **`interactiveDirty` immediate**: a Pan that takes 33ms to reflect feels broken. The user-perception window for "instant" is ~16ms.
- **`residencyDirty` 33ms**: a single chunk arrival doesn't change much visually; batching arrivals into one render at 30fps cuts redraw work without hurting perceived load progress.

## Tradeoffs

- **Two dirty channels means two sources of mistakes.** Forgetting to set `interactiveDirty` after a viewport change makes the next user input feel lagged. Forgetting `residencyDirty` makes loading visibly stuck. Most app-level call sites now go through the composed intents in `lucida-web/src/invalidation.ts` (`invalidateDisplaySettings` / `invalidateResidency` / `invalidateAfterViewRestore` / `requestRender`), which pair the dirty mark with the settings-generation bump the planner needs — a settings mutation can't tap one and forget the other.
- **The "tick still runs in the gap" rule is non-obvious.** New contributors sometimes try to throttle the whole tick; that starves uploads and breaks the chunk arrival pipeline.

## How this decision shows up in code

- `lucida-web/src/renderLoop.ts` — the loop. The `residencyDirty` throttle gate lives at ~`:515-548` (the interval check against `RESIDENCY_RENDER_INTERVAL_MS`).
- `lucida-web/src/renderLoopTypes.ts` — type definitions for the dirty flags.
- Every place that mutates state calls `loopRef.current.markInteractiveDirty()` or `markResidencyDirty()` — app-level settings mutations via the composed intents in `lucida-web/src/invalidation.ts`, which co-tap the planner's settings-generation bump. Producers include the WebSocket bridge (presence updates from peers), the `tickCoordinator` (chunk arrivals), and viewport command handlers.

## Alternatives considered (inferred)

- **Single boolean dirty + explicit "urgent" override.** Worse than typed flags — every consumer has to remember the urgency convention. Typed flags make it self-documenting.
- **Reactive subscription model (every consumer subscribes to "things that affect me").** Considered too granular for a render loop; the dirty bits buy enough for the cost.

## Related

- Flow: Chunk Lifecycle
- Scene State and Epochs — the WASM-side epoch model the orchestrator consults to decide if planning is needed at all
- Minimap Skip-When-Stationary via Render Key — a related render-skip mechanism
