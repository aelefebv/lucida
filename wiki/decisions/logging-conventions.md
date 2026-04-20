---
created: 2026-04-20
modified: 2026-04-20
---

# Logging Conventions

Cross-process conventions for debug logging. Trial-run on the dataset-opening flow ([[flows/dataset-opening]]); expand opportunistically as other flows need debugging.

## Decision

- **Server (Rust)**: route everything through `tracing`. Wrap each cross-boundary handler in a named `info_span!` so concurrent operations don't interleave into mush. No `eprintln!` in instrumented flows.
- **Client (TypeScript)**: route through a single `bridgeLog(event, data)` helper in `lucida-web/src/bridge.ts`. The helper always injects `wsReadyState` and is gated on a category registry (`lucida-web/src/debug/logging.ts`) backed by `localStorage.debug`. Production builds stay quiet by default.
- **Naming**: events as `dot.separated.scope` (`open_remote_dataset.send`, `chunk.frame_received`); spans as `snake_case_noun` (`dataset_open`, `chunk_serve`). The event prefix matches the wire command name when applicable.

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

Three ways to enable:
- **DebugPanel "Logging" tab** — checkbox per category, persists across reloads. Best for live toggling once the app is up.
- **DevTools console**: `localStorage.setItem("debug", "bridge")` (or `"bridge,chunk"`, or `"*"`). Reload to capture startup events.
- **Programmatic**: `setDebugEnabled("bridge", true)` from `debug/logging.ts`.

Adding a new category: append to `DEBUG_CATEGORIES` in `lucida-web/src/debug/logging.ts` and add a description to `LOGGING_CATEGORY_DESCRIPTIONS` in `DebugPanel.tsx`. The panel renders it automatically.

## Tradeoffs

- **Inconsistency persists in untouched flows.** Old `eprintln!`s in chunk-serve, proxy-generate, etc. aren't actively wrong — they just don't benefit from spans/levels. Replacing them all in one go is a refactor with no functional payoff; the convention propagates as each flow gets touched.
- **`localStorage.debug` gating is per-browser-profile.** Fine for solo debugging; for shared bug repros, narrate the toggle explicitly.
- **Event names are not enforced.** The dot-scope naming is convention, not type-checked. Reviewers should flag drift.
- **DebugPanel toggle has a bootstrap gap.** Events that fire before the panel mounts (initial WS connect, first frame) aren't captured by a freshly-flicked toggle. Workaround: enable, reload, then capture the next session.

## How this decision shows up in code

- `lucida-web/src/debug/logging.ts` — category registry, `isDebugEnabled` / `setDebugEnabled`.
- `lucida-web/src/bridge.ts` — `bridgeLog` helper (the existing `[Bridge]` `console.log`/`console.warn` lines predate this convention and remain until next touch).
- `lucida-web/src/debug/DebugPanel.tsx` — "Logging" tab UI over `localStorage.debug`.
- `lucida-server/src/handler.rs::handle_open_remote_dataset` — first instrumented handler.
- See [[flows/dataset-opening]] for the trace where this convention is in force.

## Related

- [[flows/dataset-opening]] — the flow this was first applied to
- [[chunk-pipeline]] — next candidate for instrumentation when debugged
