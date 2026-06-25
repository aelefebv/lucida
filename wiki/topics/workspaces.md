---
created: 2026-06-25
modified: 2026-06-25
---

# Topic: Workspaces

The durable, server-stored container users return to: a set of opened datasets, a set of saved views, and a membership/access policy, addressed by an opaque id at `/ws/workspaces/:id`. This hub is about the **container** — how a workspace is created, who can see and edit it, how datasets live inside it, and how it is shared and duplicated. The *live* collaboration that attaches to a workspace while users are active (presence, follow, the sequenced document) is its own concern — see [[#related]] and the collaboration topic — so the two hubs don't double-own it.

This page is a curated index. Articles live in their canonical homes (`systems/`, `decisions/`, `gotchas/`); follow `[[wiki-links]]` for the content.

## Start here

- [[workspaces]] — the container model: the two dataset identities (`dataset_source` vs `workspace_dataset`), roles, sharing, create-from-dataset, duplicate, and the never-leak access discipline

## Membership and identity

- [[auth]] — membership and link grants resolve through the same `AuthPrincipal` boundary; email is the v0 membership key, and members can be pre-provisioned before they ever sign in
- [[decisions/0026-discriminated-active-set-and-entity-types]] — the discriminated active-set / entity-type model the workspace document is built on

## Saved views inside a workspace

- [[saved-views]] — workspace saved views are the third saved-view surface (they replaced the global bookmark concept once workspaces landed); editors create/update/delete and set the default, viewers list/open/copy
- [[decisions/0013-url-as-app-state-for-saved-views]] — saved views as debounced URL-hash state; sharing is copy-a-link
- [[decisions/0014-local-file-datasets-personal-only-in-saved-views]] — local-file paths work for the sender but warn on share
- [[decisions/0015-server-stored-bookmarks-and-auth-seam]] — server-stored views behind the `AuthPrincipal` seam

## Gotchas and invariants

- [[gotchas/saved-view-client-only-state]] — `SavedView` mirrors WASM presence; client-only state needs a dedicated field or it won't round-trip
- **Validate the `wds-` id belongs to the current workspace** — every operation routes `workspace_dataset` → `dataset_source` server-side, but must re-check membership; see [[workspaces]]
- **Duplicate does not inherit members or sharing** — a copied workspace is owner-only with link off, and saved-view payloads are re-stripped of source URLs; see [[workspaces]]

## Related

- [[presence-and-follow-mode]] — the live session is per-workspace (each `LiveWorkspace` owns its `Session`, broadcast channel, peer map, and `seq`); the live-collaboration story lives under the collaboration topic, not here
- [[lucida-server]] — `workspace.rs` hosts the `WorkspaceManager` (live orchestration + authorization + document flow) and the `WorkspaceStore`
- [[lucida-cli]] — `workspace`, `share`, and `member` commands drive membership and sharing from the terminal
