---
created: 2026-04-18
modified: 2026-05-08
---

# Flows

End-to-end traces showing how data or control moves through Lucida. Each article picks a path and walks it from entry to exit, naming the systems involved and the gotchas at each handoff.

## Articles

- [[dataset-opening]] — user pastes URL → server import → `DatasetOpened` broadcast → WASM ingest + JS fetch pipeline → first chunks render
- [[dataset-diagnostics]] — browser/CLI/Python/server-log path for dataset open, health, restore, cache, and failure diagnostics
- [[chunk-lifecycle]] — planner decides "wanted" → CPU cache fetch+decode → GPU upload → atlas write → indirection → shader render
- [[presence-propagation]] — local viewport change → throttled wire emit → server fan-out (self-filtered) → peer apply (or follow-mirror)
- [[follow-chain-resolution]] — `set_follow` validation, transitive flatten into stars, disconnect-driven reset
- [[document-command-application]] — client → server `seq` assignment → broadcast (with `Ack` to sender) → WASM `apply_command` on every client
- [[proxy-generation]] — historical opt-in proxy bridge; default fallback is chunk-only coarse/detail
- [[auth-signin]] — unauthed visit → JS shim captures hash → /auth/start → Google → /auth/callback → state validate → JWT validate → session create → cookie + 302 to original URL
- [[saved-view-recipient-apply]] — `#view=…` or `#b=<id>` URL → bootstrap parse → diff datasets → open missing → apply layouts/settings/camera in order → `applyInProgress` flag prevents feedback loop → `selectedDatasetId` auto-selects to first visible
