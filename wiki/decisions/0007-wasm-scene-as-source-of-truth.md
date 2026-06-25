---
created: 2026-04-18
modified: 2026-06-25
---

# WASM Scene as Source of Truth

## Decision

The web client doesn't reimplement the Scene model. The Rust [[lucida-core]] crate compiles to WASM, the web client loads it, and JS treats `Scene` as the authority for "what is visible, at what scale, with what camera." JS owns the network, the GPU, and the DOM; WASM owns the Scene state, command application, view query, and ray pick.

This affects every viewport command, every `view_query`, every chunk plan, every ray pick. Concretely, JS calls `scene.apply_command(json)` for every incoming broadcast and `scene.view_query(dsId)` every render tick.

## Mental model: store vs. world

Two completely separate programs run inside one browser tab and have to cooperate:

- **WASM is the *store*** — the source of truth about what's true. Where things are in space, what's visible, what the camera is doing, what channels are on, what layout is active. If you want to know an answer about the scene, you ask WASM.
- **JS is the *world*** — everything WASM can't reach because it's stuck in a sandbox. Network calls, the cache, the GPU, the React UI, scheduling animation frames. JS doesn't decide what's true; it executes I/O and runtime work based on what WASM says.

The split isn't math-vs-bookkeeping or backend-vs-frontend. It's **state-owner vs. world-toucher**. WASM holds the canonical answers; JS interfaces with everything outside.

## Why

Three reasons, in the order they bite:

### Browser constraint
WASM literally cannot make a `fetch()`, open a WebSocket, or write to the GPU. Those APIs are JS-only. So even if everything were Rust, JS would still have to be the I/O layer. The boundary isn't optional — the question is only what crosses it.

### Code reuse
Several surfaces need the same answers:

- **[[lucida-cli]]** uses `Scene::chunk_plan_for(datasetId)` to print visible chunks for a viewport, identical to what the browser would compute.
- **[[lucida-py]]** wraps `Scene` (`PyScene`) for scriptable analyses, exposing `chunk_plan`/`chunk_plan_for`.
- **[[lucida-web]]** runs the same Scene in the browser via WASM.

(Note: [[lucida-server]] does *not* instantiate `Scene` or call `chunk_plan` — its headless prefetch uses a separate viewer-interest work-key mechanism, not the Scene model.)

If each had its own implementation, those bugs would coexist in subtly different ways. By compiling Rust to WASM, all four share one implementation — including the view-query math that's the most failure-prone piece (projected diagonals, ideal LOD, importance scoring).

### Performance
The visibility math (matrix transforms, frustum culling, projected sizes for hundreds of entities per frame) is hot-path. Rust-in-WASM is meaningfully faster than JS for this and doesn't fight the GC.

## Communication pattern

**WASM never pushes; JS always pulls.** WASM has no callback into JS — it only responds to JS calls. So all communication is JS-initiated, in two flavors:

### JS → WASM, on every external event (mutation)
JS receives an event, builds command JSON, and calls `scene.apply_command(json)`; WASM mutates state and bumps an epoch counter. Examples: user moves camera → `apply_command(SetCamera)`. Dataset opened broadcast arrives → `apply_command(DatasetOpened)`. User toggles a channel → `apply_command(SetChannelVisible)`.

### JS → WASM, every animation frame (query)
JS pulls fresh state via known APIs. The main ones (used by the orchestrator each tick):

- `scene.epochs()` — "did anything change?" (the fast-path check; skips planning if all epochs are unchanged)
- `scene.view_query(datasetId)` — "what's visible right now, at what apparent size?"
- `scene.member_positions(datasetId)` — "where are entities placed in voxel space?"
- `scene.visible_region(datasetId)` — "what xy/z bounds + frustum planes define the view?"
- `scene.ray_pick(datasetId, x, y)` — "what did the user click on?" (only on click, not every frame)

JS uses the answers to plan chunk fetches, run them, decode them, upload to GPU, and draw.

### What crosses the boundary
**JSON strings.** Both directions. Not for speed (it's not — there's serde overhead) but because it's the lowest-common-denominator that works across the WASM ABI without writing custom bindings for every struct. Whenever you see `JSON.parse(scene.something())` in JS, that's the WASM→JS channel; whenever you see `scene.apply_command(json)`, that's JS→WASM.

The cost is one parse+serialize per call — negligible at human input rates, mildly nontrivial at firehose presence rates (mitigated by client-side throttling in `bridge.ts`).

## Costs

- **Build complexity.** Rust changes require `cargo test -p lucida-core` and then `cd lucida-web && npm run build:wasm`. Vite hot-reload picks up the new WASM but doesn't trigger the rebuild itself. See [[gotchas/wasm-rebuild-after-rust-changes]].
- **JSON marshaling at the boundary.** `apply_command(json)` serializes commands as JSON across the WASM boundary because typed pyo3-style bindings would balloon the API surface — see the cost note under "What crosses the boundary" above.
- **Debugging crosses runtimes.** A bug in view-query math shows up as a wrong projected diagonal in JS; you have to reach into Rust source to debug it. Mitigated by the test suite in `lucida-core/src/scene/`, which is JS-callable equivalent.

## How this decision shows up in code

- `lucida-core/pkg/` — the WASM artifact, regenerated by `npm run build:wasm` (`wasm-pack build … --out-dir pkg`); the web client resolves it via the `lucida-core` package alias (`import … from "lucida-core"`).
- `lucida-web/src/hooks/useWasmScene.ts` — initializes the WASM Scene on mount, exposes `wasmSceneRef`.
- Every place the orchestrator queries the Scene (`view_query`, `member_positions`, `visible_region`, `ray_pick`) calls into WASM.
- `applyAndSend.ts::applyDocumentCommand` and `applyViewportCommand` both go through `wasmScene.apply_command(json)`.

## Alternatives considered (inferred)

- **JS reimplementation of Scene.** Rejected — duplication and inevitable drift.
- **Server as authority for view query.** Rejected — every render tick would round-trip; latency would kill responsiveness.
- **TypeScript port of `lucida-core`.** Rejected — view-query math depends on `glam` and similar crates that don't have first-class TS equivalents; the maintenance overhead would exceed the WASM build cost.

## Related

- [[lucida-core]]
- [[scene-state-and-epochs]]
- [[chunk-lifecycle]]
