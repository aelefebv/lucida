---
created: 2026-05-07
modified: 2026-05-08
---

# URL-as-App-State for Saved Views

> Status: Accepted (implemented in PRs #478, #480 — landed 2026-05-08).

## Decision

Saved views in the web client are encoded as a debounced, continuously-updated URL hash fragment (`#view=…`). The URL is *the* representation of the user's current view at all times — Google-Maps-style — rather than a one-shot encoded artifact produced when a user clicks a "Share" button.

Concretely:

- Every viewport mutation triggers a debounced re-encode (~250–500 ms idle) and a `window.history.replaceState` to update the URL hash.
- Page load with `#view=…` parses, validates, opens missing datasets via `OpenRemoteDataset`, then applies the captured state.
- Sharing a view = copying the current URL. There is no separate "save" verb in the wire format.
- Refresh preserves state (the URL is the state).

The encoded payload is a versioned record (`{v: 1, datasets, active_layouts, camera, view, display, dataset_order, dataset_settings}`) — gzip-compressed, base64url-encoded, defaults stripped before encoding. See [[saved-views]] for the per-field rationale.

## Why

The two viable models considered were:

- **Encode-on-demand** ("Model X"): URL stays at base path during normal use; "Share view" button generates a one-off encoded URL on click. Simple, no behavior change for non-sharers.
- **URL-as-app-state** ("Model Y", chosen): URL continuously reflects current view via debounced `replaceState`.

Y won on three grounds:

1. **Refresh-preserves-state for free.** Closing and reopening a tab, or accidentally hitting reload mid-exploration, doesn't lose the view. This is the dominant *personal* use case ("bookmark this view") even before the *sharing* use case.
2. **No separate Share verb.** Every URL is a saved view. Sharing reduces to "copy URL." The mental model is consistent — there is one representation of "the current view," not two.
3. **Same encoding, same v2 upgrade path.** When/if a server-side bookmark store is added (URLs longer than ~4 KB switch to `#v=ID`), the encoding code is unchanged. Y doesn't paint into a corner.

The runtime cost is negligible: `history.replaceState` is microseconds; encoding is sub-millisecond after defaults-stripping; debouncing on idle (recommended 250–500 ms) means zero work during continuous interaction.

## Alternatives considered

- **Encode-on-demand (X)**: simpler to implement, but loses refresh-preserves and forces a separate Share affordance. Rejected as a regression in the *personal* use case despite being slightly cleaner code.
- **`pushState` per change**: every Pan would create a history entry. Rejected — back-button becomes useless. (See [[queue]]: a separate in-app undo/redo system is the right answer for milestone-event nav, not history-API piggybacking.)
- **Hybrid `pushState` for milestone changes (dataset opened, layout changed) + `replaceState` for continuous changes**: nontrivial classification logic; back-button semantics get muddled. Rejected for v1; in-app undo/redo is the cleaner separation.
- **Server-side bookmark store as v1**: requires new persistent storage in `lucida-server` (currently entirely session-scoped), TTL policy, and possibly auth. Deferred — additive on top of Y's encoding when URL length pressure earns the infra.

## Consequences

- The web client gains a `popstate` listener for browser back/forward navigation. Today the URL hash is unused; with this decision, it becomes load-bearing for application state.
- Apply-time race conditions matter: while the recipient flow is opening datasets and applying viewport commands, the URL-write debounce must be suppressed (an `applyInProgress` flag) to avoid feedback loops.
- The capture record is a durable wire format. Schema evolution requires the `v:` field discipline — add fields with defaults, never repurpose, bump `v` on breaking changes.
- Local-file datasets create a sharp edge: the URL is technically valid (refresh-preserves works for the sender) but the link is fragile when shared across machines. Handled separately in [[decisions/0014-local-file-datasets-personal-only-in-saved-views]].
- The selected-dataset wrinkle ([[queue]]): UI focus is excluded from the capture, so the recipient may land with controls pointing at a different dataset than the sender was tweaking. Pixels match; follow-up controls don't. To revisit during implementation.

## How this decision shows up in code

- `lucida-core/src/saved_view.rs` — `SavedView` struct + `dataset_id_for_url` helper. Shared schema between web (encode/decode) and server (validate/store).
- `lucida-web/src/savedView/encoder.ts` — pure `encode`/`decode` with `CompressionStream` (gzip) + base64url + default-stripping. Owns the `v: 1` discipline.
- `lucida-web/src/savedView/applier.ts` — async orchestrator implementing the apply order from PRD §"Apply flow at the recipient." Manages `applyInProgress` flag.
- `lucida-web/src/savedView/urlSync.ts` — debounced `replaceState` + `popstate` listener + bootstrap on initial load (`#view=…` and `#b=<id>`).
- `lucida-web/src/hooks/useSavedViewSync.ts` — React wiring; constructs urlSync + applier; subscribes to `DatasetOpened`/`OpenDatasetFailed` via `useBridge`.
- `lucida-web/src/components/ShareToolbarButton.tsx` — Copy URL toolbar button with size/local-file/4KB warnings.
- `lucida-web/src/components/LoadingViewBanner.tsx` — recipient apply progress.
- See [[saved-views]] subsystem article and [[flows/saved-view-recipient-apply]] for end-to-end traces.

## Related

- [[decisions/0001-document-vs-viewport-split]] — defines the two state tiers the capture record spans
- [[decisions/0002-peer-to-peer-follow-mode]] — saved views are conceptually "one-shot follow against a frozen snapshot"
- [[decisions/0014-local-file-datasets-personal-only-in-saved-views]] — sharp edge for local-file paths
- [[presence-and-follow-mode]] — what the capture record mirrors
- [[queue]] — undo/redo system; selected-dataset wrinkle
