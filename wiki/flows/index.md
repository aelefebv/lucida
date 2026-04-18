---
created: 2026-04-18
modified: 2026-04-18
---

# Flows

End-to-end traces showing how data or control moves through Lucida. Each article picks a path and walks it from entry to exit, naming the systems involved and the gotchas at each handoff.

## Articles

- [[dataset-opening]] — user pastes URL → server import → `DatasetOpened` broadcast → WASM ingest + JS fetch pipeline → first chunks render
- [[chunk-lifecycle]] — planner decides "wanted" → CPU cache fetch+decode → GPU upload → atlas write → indirection → shader render
- [[presence-propagation]] — local viewport change → throttled wire emit → server fan-out (self-filtered) → peer apply (or follow-mirror)
- [[follow-chain-resolution]] — `set_follow` validation, transitive flatten into stars, disconnect-driven reset
- [[document-command-application]] — client → server `seq` assignment → broadcast (with `Ack` to sender) → WASM `apply_command` on every client
- [[proxy-generation]] — on-demand `AssetRequest` → bounded-concurrency generator with in-flight dedup → on-disk cache → binary frame back
