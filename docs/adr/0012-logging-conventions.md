# Logging Conventions

Status: Accepted.

## Context

Debug output comes from three runtimes, the Rust server, browser JS, and Rust compiled to WASM, and had no shared shape. The server mixed `eprintln!` with `tracing`, which bypassed level filtering and made the stream hard to grep. Concurrent tasks interleaved their lines with nothing to tell them apart. Many "I clicked and nothing happened" bugs in the browser were silent socket drops, invisible unless the log recorded the socket state.

## Decision

- Server: everything goes through `tracing`. Each cross-boundary handler runs in a named `info_span!` so concurrent operations stay separable, and the subscriber uses `FmtSpan::CLOSE` so every span reports its elapsed time. Instrumented flows use no `eprintln!`.
- Browser: `bridgeLog(event, data, wsReadyState)` for bridge events, which records the socket's ready state on send paths, and `debugLog(category, event, data)` elsewhere. Both are gated by the category registry in `lucida-web/src/debug/logging.ts` and are off by default.
- WASM: the `wasm_log!` macro, gated by the same categories. WASM cannot read `localStorage`, so JS pushes the enabled set in with `set_debug_categories(csv)` on init and on every change.
- The interface is the console: set `localStorage.debug = 'bridge,cache'` (or `'*'`) and reload. There is no settings UI ([0052](0052-debug-surface-dispositions.md)).

## Event names

Events are `dot.separated.scope`, lowercase, with `snake_case` segments. Spans are `snake_case` nouns (`dataset_open`, `chunk_serve`). The bracketed category (`[bridge]`, `[wasm]`) already names the subsystem, so the first segment names the flow, chosen in this order:

1. The wire command, when the event belongs to a command's lifecycle: `open_remote_dataset.send`, `open_remote_dataset.broadcast_sent`.
2. The function or module, for JS-internal flow not tied to one command: `setup_fetch_pipeline.start`.
3. The subsystem, for generic infrastructure: `ws.connected`, `apply_command.failed`.

WASM events use three segments, `<subsystem>.<wire_command>.<action>` (`scene.dataset_opened.applied`), so they stay self-describing in mixed logs. When in doubt, the first segment is the word a reader would grep for. Names are a convention, not type-checked, so review catches drift.

## Rejected alternatives

- Converting every old `eprintln!` in one pass. A refactor with no functional payoff. The convention spreads as each flow is touched, so untouched flows stay inconsistent until then.
- Reading `localStorage.debug` on every log call. The gate sits on the bridge, cache, and render hot paths, so it is an in-memory set refreshed by `setDebugEnabled`, `refreshDebugCategories()`, and the cross-tab `storage` event. A same-tab write from DevTools takes effect after a reload or `refreshDebugCategories()`.
- A settings panel for categories. [0052](0052-debug-surface-dispositions.md) removed it as a UI over a one-line console command.
