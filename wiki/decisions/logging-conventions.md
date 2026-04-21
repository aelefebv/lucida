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
- **Naming**: events as `dot.separated.scope` (`open_remote_dataset.send`, `scene.dataset_opened.applied`); spans as `snake_case_noun` (`dataset_open`, `chunk_serve`). The event prefix matches the wire command name or subsystem when applicable.

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

### Timing patterns

- **Server-side total time per handler**: free with `FmtSpan::CLOSE` — every `#[tracing::instrument]` function emits `time.busy` / `time.idle` on close. No code change needed.
- **Client-side multi-step time**: capture `performance.now()` between steps, fold into the `*.complete` event as a `stepsMs` map plus `totalMs`. Example: `setup_fetch_pipeline.complete` reports per-step time for all six 1b setup steps.
- **Client-side round-trip**: store the start timestamp in a ref on send, compute delta on receipt, include as `roundTripMs` in the receive event. Approximate when concurrent requests are in flight (later sends overwrite the ref) — fine for the typical interactive case of one in-flight open at a time.

## Tradeoffs

- **Inconsistency persists in untouched flows.** Old `eprintln!`s in chunk-serve, proxy-generate, etc. aren't actively wrong — they just don't benefit from spans/levels. Replacing them all in one go is a refactor with no functional payoff; the convention propagates as each flow gets touched.
- **`localStorage.debug` gating is per-browser-profile.** Fine for solo debugging; for shared bug repros, narrate the toggle explicitly.
- **Event names are not enforced.** The dot-scope naming is convention, not type-checked. Reviewers should flag drift.
- **DebugPanel toggle has a bootstrap gap.** Events that fire before the panel mounts (initial WS connect, first frame) aren't captured by a freshly-flicked toggle. Workaround: enable, reload, then capture the next session.
- **WASM logger holds its own copy of the enabled set.** WASM can't read `localStorage` directly. JS pushes via `set_debug_categories(csv)` on init (in `useWasmScene`) and on every panel toggle (via `onDebugCategoriesChanged`). Out-of-band changes to `localStorage` (e.g., DevTools console without reload) only update the JS-side gate; WASM stays stale until JS calls the setter.
- **Round-trip timing is approximate under concurrent sends.** A second `sendOpenRemoteDataset` before the first's response overwrites the start timestamp; the first's response then reports the *second* send's roundtrip. Acceptable for the interactive 1-at-a-time case; revisit when batch opens become common.

## How this decision shows up in code

- `lucida-web/src/debug/logging.ts` — category registry, `isDebugEnabled` / `setDebugEnabled`, `onDebugCategoriesChanged` listener.
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
