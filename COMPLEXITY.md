1. Split the CPU renderer into pipeline modules instead of one 3k-line unit
   Evidence: `crates/lucida-daemon/src/render_cpu.rs` combines request orchestration, OME-Zarr chunk IO, chunk decode, slab reduction, sampling, compositing, and overlay drawing in one file, with very large functions like `extract_channel_stack` and `render_single_plane_to_rgba`.
   Reduction approach: break this into `chunk_source`, `sampling`, `compose`, and `overlay` modules with narrow typed boundaries (for example, typed plane/channel buffers instead of generic vectors). Keep `render_view_to_png` as orchestration only.
   Payoff: lower cognitive load, easier targeted perf work, and smaller blast radius for rendering changes.

2. Decompose telemetry storage into repository + service layers
   Evidence: `crates/lucida-daemon/src/usage.rs` centralizes config/env parsing, schema init, insert path, pruning policy, event parsing, run summaries, and SSE signaling.
   Reduction approach: split into `usage_config.rs`, `usage_repo.rs` (SQL and row mapping), and `usage_service.rs` (prune cadence, pending inserts, broadcasts). Keep SQL in one repository boundary and expose typed methods.
   Payoff: easier reasoning about retention/query correctness and fewer cross-cutting edits for usage features.

3. Remove hand-rolled request parsing duplication in route handlers
   Evidence: `crates/lucida-daemon/src/render_image.rs` still performs substantial manual payload validation/parsing even though shared helpers exist in `crates/lucida-daemon/src/request_validation.rs`.
   Reduction approach: move route payloads to strongly typed request DTOs with centralized validation adapters (single path for required/optional fields, schema version handling, and error envelope construction).
   Payoff: less parser drift across endpoints and simpler addition of new fields without touching multiple ad hoc parse paths.

4. Collapse repetitive CLI view command scaffolding into shared command executors
   Evidence: `src/lucida/commands/view.py` has many command handlers that repeat the same lifecycle: resolve context IDs, call client, persist context, and emit text/JSON.
   Reduction approach: define reusable command executors for read vs mutation flows (input resolution, client invocation, context persistence, output formatting), then keep each command limited to argument schema + operation-specific payload mapping.
   Payoff: fewer branches to maintain, less chance of inconsistent context persistence behavior between commands.

5. Keep the Python client thin by extracting view-mutation patch builders
   Evidence: `src/lucida/client.py` combines transport concerns with many view-specific mutation helpers (`set_plane`, `pan`, `zoom`, selector replacement, patch composition).
   Reduction approach: move patch-construction logic into a dedicated module (or server-side convenience endpoints) so `LucidaClient` remains transport + typed request/response plumbing.
   Payoff: clearer separation of concerns and lower churn in the HTTP client when view-state mutation rules evolve.

6. Split OME-TIFF conversion into parse/plan/write phases
   Evidence: `src/lucida/io/ome_tiff_to_zarr.py` mixes OME-XML parsing, index mapping, read planning, level construction, and chunk writes in one module.
   Reduction approach: separate into explicit phases: metadata parser, frame addressing planner, and pyramid writer. Keep cross-phase contracts strongly typed (`dataclass`/pydantic model) instead of ad hoc dict payloads.
   Payoff: clearer invariants, easier testing of edge cases (dimension order, IFD mapping), and less coupling between metadata and write-path changes.

7. Reduce duplication across large Rust integration tests with scenario builders
   Evidence: `crates/lucida-daemon/tests/render_image.rs`, `view_state.rs`, and `usage_telemetry.rs` are each very large and likely repeat setup/assertion patterns.
   Reduction approach: add shared scenario builders and assertion helpers in `tests/support.rs` for common app-state setup, request submission, and response validation patterns.
   Payoff: shorter tests that emphasize behavior differences, with fewer fragile copy/paste fixtures.
