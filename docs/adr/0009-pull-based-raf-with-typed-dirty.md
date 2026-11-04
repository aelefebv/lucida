# Pull-Based RAF Render Loop with Typed Dirty Flags

Status: Accepted.

## Context

Two kinds of change reach the renderer. A user moving the camera needs the next frame now; a pan that takes 33 ms to show feels broken. A decoded chunk arriving changes little on its own, and during a burst load dozens arrive per second. Rendering on every event swamps the GPU during bursts, rendering every animation frame wastes power when nothing changed, and one dirty bit cannot tell the two cases apart.

## Decision

The render loop (`lucida-web/src/renderLoop.ts`) is driven by `requestAnimationFrame` and schedules a frame only when something is dirty. It keeps two flags:

- `interactiveDirty`: camera moves, layout changes, datasets added or removed, display changes. The next tick renders.
- `residencyDirty`: chunk arrivals, worker evictions, wanted-set deltas. Renders are throttled to one per `RESIDENCY_RENDER_INTERVAL_MS` (33 ms, about 30 fps).

When the throttle suppresses a render, the tick still runs. Planning and uploads continue so chunks keep reaching the GPU, and only the draw is skipped. Throttling the whole tick starves uploads.

App code marks the loop dirty through the intents in `invalidation.ts` (`invalidateDisplaySettings`, `invalidateResidency`, `requestRender`, and others). Each pairs the dirty mark with the planner's settings-generation bump, so a caller cannot set one and forget the other.

## Rejected alternatives

- Pure event-driven rendering. It re-renders on every chunk arrival and swamps the GPU during burst loads.
- Rendering every frame. It burns GPU time and battery when nothing changed.
- One dirty boolean with an "urgent" override. Every caller has to remember the urgency convention. Typed flags carry it in the name.
- A reactive subscription per consumer. Too fine-grained for a render loop. Two flags cover the cases that matter.

## Consequences

Two flags are two ways to forget. A missed `interactiveDirty` makes the next input feel laggy, and a missed `residencyDirty` makes loading look stuck.
