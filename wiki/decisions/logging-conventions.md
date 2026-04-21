---
created: 2026-04-20
modified: 2026-04-20
---

# Logging Conventions

Cross-process conventions for debug logging. Trial-run on the dataset-opening flow ([[flows/dataset-opening]]); expand opportunistically as other flows need debugging.

## Decision

- **Server (Rust)**: route everything through `tracing`. Wrap each cross-boundary handler in a named `info_span!` so concurrent operations don't interleave into mush. The subscriber is configured with `FmtSpan::CLOSE` so every instrumented function emits a span-close event with elapsed time — no manual timing needed. No `eprintln!` in instrumented flows.
- **Client (TypeScript)**: route through a single `bridgeLog(event, data)` helper in `lucida-web/src/bridge.ts`. The helper always injects `wsReadyState` and is gated on a category registry (`lucida-web/src/debug/logging.ts`) backed by `localStorage.debug`. Production builds stay quiet by default.
- **WASM (Rust-in-browser)**: route through the [`wasm_log!`] macro in `lucida-core/src/wasm_log.rs`. Same category gating; JS pushes the enabled set into WASM via `set_debug_categories(csv)` on init and on toggle.
- **Naming**: events as `dot.separated.scope`, all lowercase, `snake_case` segments. Spans as `snake_case_noun` (`dataset_open`, `chunk_serve`). The category prefix in brackets (`[bridge]`, `[wasm]`) already names the subsystem, so the event names the *flow* — see [Event-prefix rule](#event-prefix-rule) below.

## Why

- **`eprintln!` and `tracing` mixed in the same file** (e.g. `handler.rs:232` vs `:492` before this convention) makes the stream ungreppable and bypasses level filtering. Standardizing on `tracing` everywhere lets `RUST_LOG=lucida_server=info` actually do what it says.
- **Spans solve concurrent interleaving.** Two `open_remote_dataset` calls racing in `tokio::spawn`'d tasks would otherwise produce `import: starting / import: starting / import: complete / import: failed` with no way to tell which line belongs to which task. A span tags every event with `url` and `client_id` automatically.
- **A central client helper enforces `wsReadyState` capture.** Most "I clicked but nothing happened" bugs are silent socket drops (`bridge.ts::send` no-ops if `readyState !== OPEN`). Centralizing the helper makes it impossible to forget the readyState field.
- **Naming convention is cheap to agree on, expensive to retrofit.** Picking it once means future log call sites slot in without bikeshedding.

## How to apply

**Server**, when adding logging to a handler:

```rust
#[tracing::instrument(skip_all, fields(url = %url, client_id = %client_id))]
async fn handle_open_remote_dataset(...) {
    tracing::info!("open_remote_dataset.received");
    // ... events inside auto-tagged with url + client_id ...
}
```

Or use `let _enter = tracing::info_span!("dataset_open", url = %url).entered();` if `#[instrument]` doesn't fit (e.g. closures, generic types).

**Client**, when adding a new bridge call site:

```ts
bridgeLog("open_remote_dataset.send", { url });
this.send(JSON.stringify({ type: "open_remote_dataset", url }));
```

**WASM**, when adding a log inside Rust code that runs in the browser:

```rust
crate::wasm_log!("scene.dataset_opened.applied", {
    "dataset_id": dataset_id.0,
    "n_entities": event.manifest.entities().len(),
});
```

The macro builds the JSON payload only if the `wasm` category is currently enabled (cost when disabled: one `HashSet` lookup). Native (non-WASM) builds compile the call to a no-op so the same code runs on the server.

Three ways to enable:
- **DebugPanel "Logging" tab** — checkbox per category, persists across reloads. Best for live toggling once the app is up. Toggling the `wasm` category propagates into WASM via `set_debug_categories` without a reload.
- **DevTools console**: `localStorage.setItem("debug", "bridge,wasm")` (or `"*"`). Reload to capture startup events; `useWasmScene` pushes the set into WASM after `init()`.
- **Programmatic**: `setDebugEnabled("bridge", true)` from `debug/logging.ts`.

Adding a new client category: append to `DEBUG_CATEGORIES` in `lucida-web/src/debug/logging.ts` and add a description to `LOGGING_CATEGORY_DESCRIPTIONS` in `DebugPanel.tsx`. The panel renders it automatically.

### Event-prefix rule

The first segment of an event name picks one of three sources, in this priority order:

1. **Wire command name** — when the event corresponds to a command's lifecycle (send, receipt, server-side phases, failure). Example: `open_remote_dataset.send`, `open_remote_dataset.broadcast_sent`. A reader debugging "what happened during this command?" greps the command name.
2. **Function or module name** — when the event is internal JS-side flow not tied to a single wire command. Example: `setup_fetch_pipeline.start`, `setup_fetch_pipeline.complete`. The prefix tells the reader exactly where the log was emitted, so jumping to the source is one grep.
3. **Subsystem name** — for generic infrastructure that isn't command- or function-specific. Examples: `ws.connected`, `ws.bad_message`, `apply_command.failed` (catch-all that fires for any command type).

**WASM is a special case.** WASM-side events use a 3-segment form: `<subsystem>.<wire_command>.<action>` (e.g. `scene.dataset_opened.applied`). The subsystem prefix duplicates the `[wasm]` line marker but adds clarity for grep across mixed-source log streams (since the wire command segment makes the event self-describing without having to read the line marker).

When in doubt: **the prefix should be the most useful word to grep for.** If you're debugging the open flow as a whole, `open_remote_dataset` covers 1a; `setup_fetch_pipeline` covers 1b. Two greps, but each prefix is honest about what generated it.

### Timing patterns

- **Server-side total time per handler**: free with `FmtSpan::CLOSE` — every `#[tracing::instrument]` function emits `time.busy` / `time.idle` on close. No code change needed.
- **Client-side multi-step time**: capture `performance.now()` between steps, fold into the `*.complete` event as a `stepsMs` map plus `totalMs`. Example: `setup_fetch_pipeline.complete` reports per-step time for all six 1b setup steps.
- **Client-side round-trip**: store the start timestamp in a ref on send, compute delta on receipt, include as `roundTripMs` in the receive event. Approximate when concurrent requests are in flight (later sends overwrite the ref) — fine for the typical interactive case of one in-flight open at a time.

### Anomaly checks

When a happy-path log has predictable shape (counts, IDs, structural facts), pair it with a separate `<scope>.shape_anomaly`-style event that fires **only** if something is off. The pattern:

1. Compute structural facts in a single pass (orphan counts, missing references, empty containers).
2. Emit them as fields on the existing happy-path event so they're visible at a glance.
3. Run a cheap predicate suite on the same facts. If anything fails, emit a separate anomaly event with an `issues: [...]` array describing each problem.

Example: `scene.dataset_opened.applied` carries `n_wells`, `n_fields`, `n_orphans`, etc.; `manifest.shape_anomaly` fires only if a Plate has zero fields, a Field references a non-existent parent, or `default_layout_id` doesn't resolve. Healthy datasets emit one log; broken ones emit two — and the second one names the problem.

### Hot-path instrumentation

The render loop runs at ~60Hz, so per-tick logging would flood the console. Two patterns make the `render` category readable while still useful:

- **Source attribution with per-(kind,source) rate limiting.** `markInteractiveDirty(source)` and `markResidencyDirty(source)` flow into a private `setDirty(kind, source)` helper that emits `render_loop.dirty_set` at most once per second per `(kind, source)` key. Bursts collapse into a single log + a `suppressedSince` count. Lets a debugger answer "what woke up the loop?" without 60 logs/sec. Existing external callers default to `source = "external"`; label individually as needed when you're chasing a specific wakeup.
- **Aggregated burst events.** `render_loop.residency_throttled` fires only when the 33ms gate suppresses a render. Rate-limited to once per second, with a `skipCount` showing how many renders were dropped in the window. Quiet on the happy path; noisy only when chunks are arriving faster than the throttle allows.

In general: **anything that fires faster than once per second should aggregate or rate-limit before logging.** The DebugPanel "Render" tab is the right place for live per-frame state; logs are for discrete events and historical audit.

## Tradeoffs

- **Inconsistency persists in untouched flows.** Old `eprintln!`s in chunk-serve, proxy-generate, etc. aren't actively wrong — they just don't benefit from spans/levels. Replacing them all in one go is a refactor with no functional payoff; the convention propagates as each flow gets touched.
- **`localStorage.debug` gating is per-browser-profile.** Fine for solo debugging; for shared bug repros, narrate the toggle explicitly.
- **Event names are not enforced.** The dot-scope naming is convention, not type-checked. Reviewers should flag drift.
- **DebugPanel toggle has a bootstrap gap.** Events that fire before the panel mounts (initial WS connect, first frame) aren't captured by a freshly-flicked toggle. Workaround: enable, reload, then capture the next session.
- **WASM logger holds its own copy of the enabled set.** WASM can't read `localStorage` directly. JS pushes via `set_debug_categories(csv)` on init (in `useWasmScene`) and on every panel toggle (via `onDebugCategoriesChanged`). Out-of-band changes to `localStorage` (e.g., DevTools console without reload) only update the JS-side gate; WASM stays stale until JS calls the setter.
- **Round-trip timing is approximate under concurrent sends.** A second `sendOpenRemoteDataset` before the first's response overwrites the start timestamp; the first's response then reports the *second* send's roundtrip. Acceptable for the interactive 1-at-a-time case; revisit when batch opens become common.
- **Render-loop source attribution is opt-in for external callers.** The renderLoop's internal sites (cache subscribe, eviction, tick continuation, lifecycle) are labeled, but external callers of `markInteractiveDirty()` / `markResidencyDirty()` default to `source: "external"` to avoid touching ~30 callsites in App.tsx and the hooks. Label individually when chasing a specific wakeup; the convention's value is local to the file you're debugging.

## How this decision shows up in code

- `lucida-web/src/debug/logging.ts` — category registry, `isDebugEnabled` / `setDebugEnabled`, `onDebugCategoriesChanged` listener, generic `debugLog(category, event, data)`.
- `lucida-web/src/renderLoop.ts` — `setDirty(kind, source)` private helper + `markInteractiveDirty(source)` / `markResidencyDirty(source)` public methods; throttle skip aggregation in `tick()`.
- `lucida-web/src/bridge.ts` — `bridgeLog` helper (the existing `[Bridge]` `console.log`/`console.warn` lines predate this convention and remain until next touch).
- `lucida-web/src/hooks/useWasmScene.ts` — pushes initial categories into WASM after `init()` and subscribes to JS-side changes.
- `lucida-web/src/debug/DebugPanel.tsx` — "Logging" tab UI over `localStorage.debug`.
- `lucida-core/src/wasm_log.rs` — WASM `set_categories` / `is_enabled` / `log_raw` / `wasm_log!` macro.
- `lucida-core/src/wasm.rs::set_debug_categories` — wasm-bindgen entry point JS calls.
- `lucida-server/src/handler.rs::handle_open_remote_dataset` — first instrumented handler.
- `lucida-server/src/main.rs` — subscriber configured with `FmtSpan::CLOSE` for free per-span timing.
- See [[flows/dataset-opening]] for the trace where this convention is in force.

## Related

- [[flows/dataset-opening]] — the flow this was first applied to
- [[chunk-pipeline]] — next candidate for instrumentation when debugged
