---
created: 2026-06-25
modified: 2026-06-25
---

# Workspaces

A workspace is the durable, server-stored container users return to: a set of opened datasets, a set of saved views, and a membership/access policy, all addressed by an opaque id at `/ws/workspaces/:id`. It is the **unit of collaboration and of the live session** — presence, follow, the sequenced document, and the broadcast channel are all per-workspace. A workspace is *not* a browser tab, a login session, a transient WebSocket runtime, or a saved view; live sessions attach to a workspace while users are active but do not define it.

Implemented in `lucida-server/src/workspace.rs` (one large module): `WorkspaceManager` owns live orchestration + authorization + the document command flow; the `WorkspaceStore` trait (with `SqliteWorkspaceStore`) owns durable rows in the shared `lucida.db`. The web side is `WorkspaceDashboard.tsx` (`/`), `WorkspaceRoot.tsx` (`/w/:id`), `WorkspaceSharingDialog.tsx`, and `workspaceApi.ts`. All REST lives under `/api/workspaces/...`; admin override under `/admin/workspaces/...`.

## Two dataset identities — the central distinction

- **`dataset_source`** — global source identity, keyed by `dataset_source_id` = `ds-{16-hex BLAKE3 of the canonicalized URL}` (`lucida-content/src/url.rs`). This deduplicates import / cache / generated-coarse work *across* workspaces. Multiple memberships, in one or many workspaces, can point at the same source and reuse its cache.
- **`workspace_dataset`** — a dataset's membership/layer *inside one workspace*, keyed by `wds-{uuid}` (random, opaque, globally unique). This is the id the client, the document, saved views, and rendering use.

`DatasetOpened` and every document command carry the `wds-` id; source/cache/chunk routing maps `wds-` → `ds-` server-side. Saved views and inline `#view` payloads key dataset state by `wds-` id and intentionally omit source URLs. v0 enforces one membership per source per workspace (`unique(workspace_id, dataset_source_id)`), so a duplicate add is a no-op (`ON CONFLICT … DO NOTHING`). **Invariant:** any operation given a `wds-` id must still validate that the membership belongs to the current workspace.

## Membership, roles, and sharing

Roles are `viewer < editor < owner`. Sharing has two axes: explicit members (added by email, may be pre-provisioned before that user ever signs in — see [[auth]] principals) and a link-access mode (`restricted` | `anyone_with_link`, the latter granting `viewer`/`editor` but **never** owner). Only owners manage membership, link access, rename/archive, and ownership; editors mutate content (datasets, shared saved views, active layout, default view); viewers read, follow, and copy `#view`/`#b` links.

Enforcement is server-side at three points — HTTP API, WebSocket connect (viewer+), and each mutating command (editor+); button-hiding is never sufficient. The **never-leak** discipline is load-bearing: to a non-member, an existing-but-denied workspace is byte-identical to a missing one (both `NotFound`/404), so the role check runs *before* any row is read. Archived state is surfaced (`Gone`/410) only to a real member; to everyone else it too collapses to 404. Link-shared workspaces are not globally listed — a user sees one only after explicit membership or a successful link visit (recorded in `user_workspace_state`, which also holds personal pins).

## Create-from-dataset and duplicate

- **Create-from-dataset (#697)** — `workspaceFromDataset.ts` is thin orchestration: it creates a blank workspace named after the dataset basename(s), then the caller navigates in and opens the URLs over the normal viewer path. **Gotcha:** the open happens *after* the workspace exists, so a failed import leaves the (empty) workspace in place and surfaces through the viewer's open-failed banner rather than unwinding anything. It never weakens the server's default sharing (restricted, link off).
- **Duplicate (#698)** — `duplicate_workspace` (manager + store) copies in one transaction: dataset memberships get **fresh `wds-` ids**, and an old→new remap is applied across the document and saved views (the id-consistency trap). It copies only **Shared** saved views, re-attributed to the duplicator (personal/proposed views are dropped). **Security-critical invariant:** the copy does **not** inherit the source's other members or sharing — it is owner-only with link off, via the shared `insert_blank_owned_workspace`. Saved-view payloads are re-stripped of source URLs defensively even though the create/update paths already strip them.

## Collaborative dataset rename (#701)

Renaming a dataset's display label is a real document mutation, not a local edit: `WorkspaceManager::rename_dataset` emits a `DocumentCommand::RenameDataset` that broadcasts to co-present peers and is acked like any other command. It is editor-only (checked first, never-leak), validates the name, requires the `wds-` id to exist in the live document (else `NotFound`, never confirming which ids exist), and persists the `workspace_datasets.display_name` row and the full `document_json` in one transaction. **Invariant:** it leaves the shared `dataset_sources.default_name` (the import-time name) untouched — a rename is per-workspace.

## Interactions

- [[auth]] — members/link grants resolve through the same `AuthPrincipal` boundary; email is the v0 membership key, with provider subject stored for later hardening.
- [[saved-views]] — workspace saved views are the third saved-view surface; they replaced the global bookmark concept once workspaces landed. Editors create/update/delete + set the `default_saved_view_id`; viewers list/open/copy.
- [[presence-and-follow-mode]] — the session is per-workspace: each `LiveWorkspace` owns its `Session`, broadcast channel, peer map, and `seq`. Presence, peers, follow chains, and document/saved-view broadcasts are all workspace-local; `ClientId` is workspace-local live-peer identity. There is no longer a single global shared session (ADR-0020).

## Other gotchas / invariants

- The shared document command flow is **authorize → apply → persist snapshot+seq → broadcast/ack**; commands persist before they broadcast. Sequencing locks per live workspace, never globally, so workspace A can't block workspace B.
- `workspace_datasets` is authoritative for membership; `document_json` is authoritative for the client-facing snapshot. Dataset add/remove updates both in one transaction.
- Removing a dataset removes only that workspace's membership — never the global source, its cache, or saved views that reference it (those may go partially stale and warn on apply).
- Lifecycle is archive/restore (no v0 hard delete outside admin); archiving revokes live usability and notifies clients. Idle live workspaces are evicted on a TTL while durable rows and shared cache survive.
