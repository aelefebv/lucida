---
type: Subsystem
title: "Workspaces"
description: "A workspace is the durable, server-stored container users return to: a set of opened datasets, a set of saved views, and a membership/access policy, all addressed by an opaque id — the browser page route is /w/:id (Wo…"
tags: [lucida, subsystem]
source_path: wiki/systems/subsystems/workspaces.md
created: 2026-06-25
modified: 2026-07-17
---

# Workspaces

A workspace is the durable, server-stored container users return to: a set of opened datasets, a set of saved views, and a membership/access policy, all addressed by an opaque id — the browser page route is `/w/:id` (`WorkspaceRoot.tsx`); the per-workspace WebSocket endpoint is `/ws/workspaces/{workspace_id}` (don't confuse the two). It is the **unit of collaboration and of the live session** — presence, follow, the sequenced document, and the broadcast channel are all per-workspace. A workspace is *not* a browser tab, a login session, a transient WebSocket runtime, or a saved view; live sessions attach to a workspace while users are active but do not define it.

Implemented in `lucida-server/src/workspace/` (layout in [lucida-server](../crates/lucida-server.md)): `WorkspaceManager` (`manager.rs`) owns live orchestration + authorization + the document command flow; the `WorkspaceStore` trait (`store/`, with `SqliteWorkspaceStore`) owns durable rows in the shared `lucida.db`. The web side is `WorkspaceDashboard.tsx` (`/`), `WorkspaceRoot.tsx` (`/w/:id`), `WorkspaceSharingDialog.tsx`, and `workspaceApi.ts`. All REST lives under `/api/workspaces/...`; admin override under `/admin/workspaces/...`.

## Two dataset identities — the central distinction

- **`dataset_source`** — global source identity, keyed by `dataset_source_id` = `ds-{64 lowercase hex characters}` from the full BLAKE3 digest of the canonicalized URL (`SourceIdentity::dataset_id`). Runtime caches use that typed source identity plus semantic revision, preventing aliasing while still reusing source/generated-coarse work across workspaces.
- **`workspace_dataset`** — a dataset's membership/layer *inside one workspace*, keyed by `wds-{uuid}` (random, opaque, globally unique). This is the id the client, the document, saved views, and rendering use.

`DatasetOpened` and every document command carry the `wds-` id; source/cache/chunk routing maps `wds-` → `ds-` server-side. Saved views and inline `#view` payloads key dataset state by `wds-` id and intentionally omit source URLs. v0 enforces one membership per source per workspace (`unique(workspace_id, dataset_source_id)`), so a duplicate add is a no-op (`ON CONFLICT … DO NOTHING`). **Invariant:** any operation given a `wds-` id must still validate that the membership belongs to the current workspace.

## Membership, roles, and sharing

Roles are `viewer < editor < owner`. Sharing has two axes: explicit members (added by email, may be pre-provisioned before that user ever signs in — see [Authentication](auth.md) principals) and a link-access mode (`restricted` | `anyone_with_link`, the latter granting `viewer`/`editor` but **never** owner). Only owners manage membership, link access, rename/archive, and ownership; editors mutate content (datasets, shared saved views, active layout, default view); viewers read, follow, and copy `#view`/`#b` links.

Enforcement is server-side at three points — HTTP API, WebSocket connect (viewer+), and each mutating command (editor+); button-hiding is never sufficient. The **never-leak** discipline is load-bearing: to a non-member, an existing-but-denied workspace is byte-identical to a missing one (both `NotFound`/404), so the role check runs *before* any row is read. Archived state is surfaced (`Gone`/410) only to a real member; to everyone else it too collapses to 404. Link-shared workspaces are not globally listed — a user sees one only after explicit membership or a successful link visit (recorded in `user_workspace_state`, which also holds personal pins).

## Create-from-dataset and duplicate

- **Create-from-dataset (#697)** — `workspaceFromDataset.ts` is thin orchestration: it creates a blank workspace named after the dataset basename(s), then the caller navigates in and opens the URLs over the normal viewer path. **Gotcha:** the open happens *after* the workspace exists, so a failed import leaves the (empty) workspace in place and surfaces through the viewer's open-failed banner rather than unwinding anything. It never weakens the server's default sharing (restricted, link off).
- **Duplicate (#698)** — `duplicate_workspace` (manager + store) copies in one transaction: dataset memberships get **fresh `wds-` ids**, and an old→new remap is applied across the document and saved views (the id-consistency trap). It copies only **Shared** saved views, re-attributed to the duplicator (personal/proposed views are dropped). **Security-critical invariant:** the copy does **not** inherit the source's other members or sharing — it is owner-only with link off, via the shared `insert_blank_owned_workspace`. Saved-view payloads are re-stripped of source URLs defensively even though the create/update paths already strip them.

## Collaborative dataset rename (#701)

Renaming a dataset's display label is a real document mutation, not a local edit: `WorkspaceManager::rename_dataset` emits a `DocumentCommand::RenameDataset` that broadcasts to co-present peers and is acked like any other command. It is editor-only (checked first, never-leak), validates the name, requires the `wds-` id to exist in the live document (else `NotFound`, never confirming which ids exist), and persists the `workspace_datasets.display_name` row and the full `document_json` in one transaction. **Invariant:** it leaves the shared `dataset_sources.default_name` (the import-time name) untouched — a rename is per-workspace.

## Interactions

- [Authentication](auth.md) — members/link grants resolve through the same `AuthPrincipal` boundary; email is the v0 membership key, with provider subject stored for later hardening.
- [Saved Views](saved-views.md) — workspace saved views are the sole active server-stored view surface; the stable `#b=<id>` hash resolves within the workspace. Editors create/update/delete + set the `default_saved_view_id`; viewers list/open/copy subject to visibility rules.
- [Presence and Follow Mode](presence-and-follow-mode.md) — the live session is per-workspace: each `LiveWorkspace` owns its `Session`, broadcast channel, peer map, and `seq`. Presence, peers, follow chains, and document broadcasts are workspace-local; `ClientId` is workspace-local live-peer identity. Saved-view CRUD stays on workspace REST rather than the session stream. There is no global shared session after [ADR-0043](../../decisions/0043-superseded-server-surfaces-sunset.md).

## Other gotchas / invariants

- The shared document command flow is **authorize → apply → persist snapshot+seq → broadcast/ack**; commands persist before they broadcast. Sequencing locks per live workspace, never globally, so workspace A can't block workspace B.
- Durable `document_json` writes use a versioned `{ "format_version": 1, "document": ... }` envelope. Historical bare documents are implicit v0 and migrate on their next successful write; explicit unknown or malformed versions fail closed without rewriting the row.
- Released databases that still contain the earlier short `ds-{16 hex}` source ids are upgraded at server startup, after SQL schema migrations and before a workspace store is exposed. The Rust data migration validates every source/id pair and every `workspace_datasets` reference, plans the complete old→full rekey, then canonicalizes locator spellings and updates source primary keys/references in one deferred-FK transaction. It deliberately preserves all opaque `wds-*` ids and workspace/source metadata. Equivalent locators that would collapse, unknown id generations, and orphan references fail startup with no partial data rewrite; successful and repeated runs are recorded idempotently in `lucida_data_migrations` while still revalidating current rows. Startup failures carry a stable reason code and the same credential-safe source diagnostic used by offline recovery; raw canonical locators and database-driver detail are not retained in `Display`, `Debug`, tracing, or the top-level process error.
- `workspace_datasets` is authoritative for membership; `document_json` is authoritative for the client-facing snapshot. Dataset add/remove updates both in one transaction.
- Removing a dataset removes only that workspace's membership — never the global source, its cache, or saved views that reference it (those may go partially stale and warn on apply).
- Lifecycle is archive/restore (no v0 hard delete outside admin); archiving revokes live usability and notifies clients. Idle live workspaces are evicted on a TTL while durable rows and shared cache survive.

## Collaboration resource budgets

Collaborative input is admitted once at the shared Rust boundary, before any
mutation, persistence, or broadcast. The executable source of truth is
`lucida-core/src/quota.rs`; deployments may lower surrounding ingress/cache
budgets, but must not raise these wire guarantees independently in one client.

| Boundary | Limit | Failure behavior |
|---|---:|---|
| Client WebSocket message / command JSON | 2 MiB | close code 1009 for an oversized frame; request-correlated `resource_limit` Nack for a decoded command |
| Retained presence / viewer-interest update | 64 KiB per client | close code 1009 before session state changes |
| Command text / identifier | 256 KiB / 1 KiB | atomic validation failure |
| Annotations per dataset / comments per annotation | 100,000 / 4,096 | atomic validation failure |
| Persisted collaborative document JSON | 24 MiB | rejected before the sequence or database changes |
| Full session snapshot JSON | 32 MiB | connection closes instead of allocating or sending an unbounded snapshot |
| Live connections | 64 per workspace; 8 per principal/workspace | upgrade closes with 1013 before presence is registered |
| Outstanding request work | 32 per connection; 64 per principal process-wide | request receives a retryable, request-appropriate resource-limit result; admitted work is unchanged |
| Per-connection unicast queue | 128 messages and 32 MiB | overload counters/logs increment and the connection closes with 1013 |
| Chunk-planner candidates per pass | 65,536 | deterministic centered window before enumeration |

Manifests additionally validate aggregate entity/image/level/reference counts,
compact-reference expansion, identifiers, numeric geometry, and checked chunk
byte layouts. Decoder output and cache budgets are enforced at their respective
storage boundaries rather than being inferred from these collaboration limits.
