# Flows

End-to-end traces showing how data or control moves through Lucida. Each article picks a path and walks it from entry to exit, naming the systems involved and the gotchas at each handoff.

## Articles

- [Flow: Dataset Opening](dataset-opening.md) — user pastes URL → server import → `DatasetOpened` broadcast → WASM ingest + JS fetch pipeline → first chunks render
- [Flow: Dataset Diagnostics](dataset-diagnostics.md) — browser/CLI/Python/server-log path for dataset open, health, restore, cache, and failure diagnostics
- [Flow: Chunk Lifecycle](chunk-lifecycle.md) — planner decides "wanted" → CPU cache fetch+decode → GPU upload → atlas write → indirection → shader render
- [Flow: Presence Propagation](presence-propagation.md) — local viewport change → throttled wire emit → server fan-out (self-filtered) → peer apply (or follow-mirror)
- [Flow: Follow Chain Resolution](follow-chain-resolution.md) — `set_follow` validation, transitive flatten into stars, disconnect-driven reset
- [Flow: Document Command Application](document-command-application.md) — client → server `seq` assignment → broadcast (with `Ack` to sender) → WASM `apply_command` on every client
- [Flow: Proxy Generation (S5)](proxy-generation.md) — historical opt-in proxy bridge; default fallback is chunk-only coarse/detail
- [Flow: Authentication Sign-In](auth-signin.md) — unauthed visit → JS shim captures hash → /auth/start → Google → /auth/callback → state validate → JWT validate → session create → cookie + 302 to original URL
- [Flow: Saved-View Recipient Apply](saved-view-recipient-apply.md) — `#view=…` or `#b=<id>` URL → bootstrap parse → diff datasets → open missing → apply layouts/settings/camera in order → `applyInProgress` flag prevents feedback loop → `selectedDatasetId` auto-selects to first visible
- [Flow: Annotation Lifecycle](annotation-lifecycle.md) — shift-drag pin → capture author's view onto the pin (empty `datasets`) → `add_annotation` document command broadcast + persist → light recipient-local restore via thread click, @mention, or `#a=<id>` link
- [Flow: Saved-View Propose → Review](saved-view-proposal-review.md) — viewer proposes a saved view → enters every editor's review queue → editor approves (→ Shared) or rejects (→ proposer's Personal); three-state visibility machine with closed transition allow-list and editor-only queue disclosure
- [Flow: Headless Capture (montage + viewer screenshot/overview)](headless-capture.md) — CLI/agent → plan shot + compose inline `SavedView` → drive headless Chrome over CDP → wait on viewer render-readiness contract → capture PNG(s) → stitch montage + drill-in sidecar
