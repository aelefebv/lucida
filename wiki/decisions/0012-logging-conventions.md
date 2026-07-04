---
type: Decision
title: "Logging Conventions"
description: "Cross-process conventions for debug logging."
tags: [lucida, decision]
source_path: wiki/decisions/0012-logging-conventions.md
created: 2026-04-20
modified: 2026-07-03
---

# Logging Conventions

Cross-process conventions for debug logging. Trial-run on the dataset-opening flow ([Flow: Dataset Opening](../flows/dataset-opening.md)); expand opportunistically as other flows need debugging.

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

## Event-prefix rule

The first segment of an event name picks one of three sources, in this priority order:

1. **Wire command name** — when the event corresponds to a command's lifecycle (send, receipt, server-side phases, failure). Example: `open_remote_dataset.send`, `open_remote_dataset.broadcast_sent`. A reader debugging "what happened during this command?" greps the command name.
2. **Function or module name** — when the event is internal JS-side flow not tied to a single wire command. Example: `setup_fetch_pipeline.start`, `setup_fetch_pipeline.complete`. The prefix tells the reader exactly where the log was emitted, so jumping to the source is one grep.
3. **Subsystem name** — for generic infrastructure that isn't command- or function-specific. Examples: `ws.connected`, `ws.bad_message`, `apply_command.failed` (catch-all that fires for any command type).

**WASM is a special case.** WASM-side events use a 3-segment form: `<subsystem>.<wire_command>.<action>` (e.g. `scene.dataset_opened.applied`). The subsystem prefix duplicates the `[wasm]` line marker but adds clarity for grep across mixed-source log streams (since the wire command segment makes the event self-describing without having to read the line marker).

When in doubt: **the prefix should be the most useful word to grep for.** If you're debugging the open flow as a whole, `open_remote_dataset` covers 1a; `setup_fetch_pipeline` covers 1b. Two greps, but each prefix is honest about what generated it.

## Tradeoffs

- **Inconsistency persists in untouched flows.** Old `eprintln!`s in chunk-serve, proxy-generate, etc. aren't actively wrong — they just don't benefit from spans/levels. Replacing them all in one go is a refactor with no functional payoff; the convention propagates as each flow gets touched.
- **`localStorage.debug` gating is per-browser-profile.** Fine for solo debugging; for shared bug repros, narrate the toggle explicitly.
- **Event names are not enforced.** The dot-scope naming is convention, not type-checked. Reviewers should flag drift.
- **DebugPanel toggle has a bootstrap gap.** Events that fire before the panel mounts (initial WS connect, first frame) aren't captured by a freshly-flicked toggle. Workaround: enable, reload, then capture the next session.
- **WASM logger holds its own copy of the enabled set.** WASM can't read `localStorage` directly. JS pushes via `set_debug_categories(csv)` on init (in `useWasmScene`) and on every panel toggle (via `onDebugCategoriesChanged`). Out-of-band changes to `localStorage` (e.g., DevTools console without reload) only update the JS-side gate; WASM stays stale until JS calls the setter.

## How this decision shows up in code

- `lucida-web/src/debug/logging.ts` — category registry, `isDebugEnabled` / `setDebugEnabled`, `onDebugCategoriesChanged` listener, generic `debugLog(category, event, data)`.
- `lucida-web/src/renderLoop.ts` — `setDirty(kind, source)` private helper + `markInteractiveDirty(source)` / `markResidencyDirty(source)` public methods; throttle skip aggregation in `tick()`.
- `lucida-web/src/bridge.ts` — `bridgeLog` helper (the existing `[Bridge]` `console.log`/`console.warn` lines predate this convention and remain until next touch).
- `lucida-web/src/hooks/useWasmScene.ts` — pushes initial categories into WASM after `init()` and subscribes to JS-side changes.
- `lucida-web/src/debug/DebugPanel.tsx` — "Logging" tab UI over `localStorage.debug`.
- `lucida-core/src/wasm_log.rs` — WASM `set_categories` / `is_enabled` / `log_raw` / `wasm_log!` macro.
- `lucida-core/src/wasm.rs::set_debug_categories` — wasm-bindgen entry point JS calls.
- `lucida-server/src/dataset_open.rs::open_dataset` (the `dataset_open` span) — first instrumented handler.
- `lucida-server/src/main.rs` — subscriber configured with `FmtSpan::CLOSE` for free per-span timing.
- See [Flow: Dataset Opening](../flows/dataset-opening.md) for the trace where this convention is in force.

## Related

- [Flow: Dataset Opening](../flows/dataset-opening.md) — the flow this was first applied to
- [Flow: Chunk Lifecycle](../flows/chunk-lifecycle.md) — next candidate for instrumentation when debugged
