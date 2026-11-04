# Server-Stored Bookmarks and the AuthPrincipal Seam

Status: Accepted. [0055](0055-storage-backend-selected-by-connection-string.md) supersedes the choice of SQLite as the only database; the backend is now selected by a connection string.

## Context

URL-hash saved views ([0013](0013-url-as-app-state-for-saved-views.md)) cover reload and one-off sharing. They give no discovery (what others saved for this dataset), no names or authorship, and no way to rename or delete a view once shared. Stored bookmarks meant giving `lucida-server` its first persistent state, and ownership meant handlers would need to know who is asking.

## Decision

The server stores bookmarks: named records (`{id, name, created_by, created_by_name, created_at, datasets, view}`) addressable as `#b=<id>`, carrying the same `SavedView` capture as the URL hash. Bookmarks are global and keyed to dataset URLs, which are stable, not to sessions, which are transient. A `bookmark_datasets` side table serves the any-overlap query ("bookmarks touching any of these datasets") without relying on JSON extensions. A change pushes `BookmarkChanged { id, action, dataset_urls }` to clients with an overlapping dataset. It carries no `seq`, because it is a notification, not a document command.

Handlers never see credentials. Middleware runs a `PrincipalExtractor` and attaches an `AuthPrincipal` (`{email, display_name, picture_url, is_admin}`), which lives in `lucida-core` so extractors do not depend on the server. POST takes `created_by` from the principal, so a request body cannot spoof it. PATCH and DELETE require `created_by == principal.email` or `principal.is_admin`. Each identity provider is an implementation of the trait, and adding one touches no bookmark code.

## Rejected alternatives

- URL-only sharing. It loses discovery and curation, the features with the most value.
- Bookmarks in browser `localStorage`. Per-user only, so no one sees what others saved.
- A third-party store. An external dependency and a federation boundary for a self-hosted tool.
- Bookmarks scoped to sessions. Sessions would have to become persistent.
- `sled`. Key-value only, so the overlap and creator queries would need hand-built secondary indexes.
- In-memory state with JSON snapshots on disk. Fragile writes, no query language, and hard schema evolution.
- Handlers that read a provider's identity directly. It couples the feature to one provider and makes tests mint real tokens.
- An `AuthPrincipal` struct with no extractor trait. Where the principal comes from stays undefined and hard to fake in tests.

## Consequences

The server needs a writable location for its database and runs versioned SQL migrations at startup. A bookmark that references a local-file path inherits the sharp edge in [0014](0014-local-file-datasets-personal-only-in-saved-views.md): it loads whatever file sits at that path on the recipient's server.
