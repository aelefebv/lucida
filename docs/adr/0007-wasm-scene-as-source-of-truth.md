# WASM Scene as Source of Truth

Status: Accepted.

## Context

The browser, the CLI, and the Python client all need the same answers: what is visible, at what apparent size, under which camera, and what a click hit. That view math (projected sizes, frustum culling, target level, ray pick) is the most failure-prone code in the system and runs every frame. WASM cannot call `fetch`, open a WebSocket, or touch the GPU, so JS has to own I/O whatever else happens.

## Decision

The `Scene` model exists once, in Rust, in `lucida-core`. The web client loads it as WASM and treats it as the authority on scene state: commands, camera, visibility, view queries, ray picks. JS owns the network, the cache, the GPU, scheduling, and the DOM. It does not decide what is true; it does the work WASM's answers call for. `lucida-cli` (`Scene::chunk_plan_for`) and `lucida-py` (`PyScene`) use the same crate natively. The server does not instantiate `Scene`.

WASM never pushes. JS calls `scene.apply_command(json)` for each local or broadcast command and pulls state each tick through `epochs()`, `view_query()`, `visible_region()`, and `member_positions()`, plus `ray_pick()` on click.

Data crosses the boundary as JSON strings in both directions. Each call costs one serialize and one parse, which is negligible at input rates, and no struct needs a hand-written binding.

## Rejected alternatives

- A JS or TypeScript port of `Scene`. Two implementations drift, and the math leans on crates such as `glam` that have no first-class TypeScript equivalent.
- The server as the authority for view queries. Every render tick would round-trip, and the latency would kill responsiveness.
- Typed bindings per struct instead of JSON. The binding surface would balloon to save a cost that does not show at human input rates.

## Consequences

A Rust change needs a WASM rebuild (`pnpm run build:wasm` in `lucida-web`) before the browser sees it. Vite picks up the new artifact but does not trigger the build. A wrong number in JS is often a bug in Rust.
