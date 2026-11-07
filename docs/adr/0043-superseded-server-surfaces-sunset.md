# Sunset dispositions for the three superseded server surfaces

Status: Accepted. Each removal lands as its own change.

## Context

Three server surfaces predate workspaces and chunk tiers and duplicate their successors, so
every session-shaped feature must be reasoned about across both generations.

## Decision

Retire the global `/ws` session. No shipped client reaches it: the web app always passes a
workspace id, and the CLI and Python client build only `/ws/workspaces/{id}` URLs. The session
is in memory, unpersisted, and outside workspace authorization, so nothing needs migrating.

Workspace saved views absorb bookmarks. Both store the same `SavedView`, bookmarks have no live
writer or reader, and their change broadcast reaches only the global session. The `#b=<id>`
link form stays and means a workspace saved-view id. Existing bookmark rows stay in place.

Delete the proxy-asset fallback and the `lucida-proxy` crate. Planning never emits a proxy
request and the server gates proxies behind a flag that defaults off
([ADR 0061](0061-screen-chosen-target-level-with-resident-coarser-levels.md)). Keep what
generated coarse borrows: the server proxy module's region reader and the cache-root setting
with its clear-cache command. `FetchSource::Proxied` is the live relayed-chunk descriptor
despite its name, and stays.

## Rejected alternatives

- A default workspace behind `/ws`. Adds persistence and access policy for zero consumers.
- Keep bookmarks for cross-workspace, dataset-keyed discovery
  ([ADR 0015](0015-server-stored-bookmarks-and-auth-seam.md)). That feature has had no UI since
  its sidebar was removed, so the store preserves rows, not the feature.
- Keep the proxy path behind its flag as a way back. The client no longer emits proxy requests,
  so the flag alone restores nothing.

## Consequences

Headless scripts must target a workspace before opening a socket. With auth disabled that is
one `POST /api/workspaces`.
