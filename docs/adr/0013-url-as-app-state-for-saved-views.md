# URL-as-App-State for Saved Views

Status: Accepted.

## Context

Users want to keep a view, so a reload or a bookmark brings it back, and to share it. Two models fit. Encode-on-demand leaves the URL alone and builds a one-off link when the user clicks Share. URL-as-app-state keeps the URL in step with the view at all times, the way map sites do.

## Decision

The URL hash is the current view. Every view change triggers a debounced re-encode (after 250 to 500 ms idle) and a `history.replaceState` that writes `#view=...`. Loading a page with `#view=...` decodes it, opens any missing datasets, and applies the captured state. Sharing is copying the URL, and a reload keeps the view for free.

The payload is a `SavedView` record (`lucida-core/src/saved_view.rs`, shared by web and server) with defaults stripped, then JSON, gzip, and base64url. Its `v` field makes it a durable wire format: add fields with defaults, never repurpose one, and bump `v` on a breaking change. While a recipient is opening datasets and replaying commands, URL writes are suppressed so the apply does not feed back into itself. Back and forward navigation re-apply the hash through the same path.

The same encoding backs server-stored bookmarks (`#b=<id>`, [0015](0015-server-stored-bookmarks-and-auth-seam.md)), which collapse to the live `#view=...` form once applied.

## Rejected alternatives

- Encode-on-demand. Simpler code, but a reload loses the view and sharing needs its own control. Losing the personal "keep this view" case outweighed the cleaner code.
- `pushState` per change. Every pan becomes a history entry and the back button becomes useless.
- `pushState` for milestones (dataset opened, layout changed) and `replaceState` for the rest. The classification is fiddly and back-button behavior gets muddled. Undo for milestone changes belongs in an in-app undo system, not the history API.
- A server-side bookmark store as the only mechanism. It needed persistent server state the server did not yet have. It arrived later as an addition on top of this encoding.

## Consequences

UI focus is not captured, so a recipient may land with the controls pointing at a different dataset than the one the sender was editing. The pixels match and the follow-up controls may not. Local-file paths produce a URL that works for the sender and is fragile for anyone else ([0014](0014-local-file-datasets-personal-only-in-saved-views.md)).
