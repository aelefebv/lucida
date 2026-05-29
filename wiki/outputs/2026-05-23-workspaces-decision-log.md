# Workspace Planning Decision Log

Date: 2026-05-23
Status: in progress
Context: high-level `code` pipeline, Phase 1 design exploration for Lucida workspaces.

This is a running log for workspace planning decisions before the umbrella PRD is written. It is not a formal ADR. Promote durable architectural choices into `wiki/decisions/` after the umbrella PRD hardens.

## Implementation Progress

- 2026-05-28: Workspace isolation tracer-bullet slice implemented create/list/open workspace, `/w/:id` routing, workspace-scoped document persistence, owner-only access, and restart restore.
- 2026-05-28: Runtime identity slice migrated workspace sessions to opaque `workspace_dataset_id` values while keeping source/cache identity global for reuse across workspaces.
- 2026-05-28: Sharing slice implemented owner-managed explicit members, viewer/editor/owner member roles, restricted vs anyone-with-link access, viewer/editor link roles, and owner-only sharing UI. Link-shared workspaces remain URL-accessible but are not globally listed; recents/pins for prior link visits remain a later `user_workspace_state` slice.
- 2026-05-29: Shared workspace saved-view MVP added workspace-scoped saved-view rows/routes/UI. Editors can create/update/rename/delete; viewers can list/open/copy. Stored workspace saved-view payloads clear source URLs and key dataset state by `workspace_dataset_id`.
- 2026-05-29: Workspace saved-view URL/default slice added `/w/:workspace_id#b=<saved_view_id>` resolution through the workspace-scoped API, URL collapse to inline `#view` after saved-view apply, and an editor-controlled `default_saved_view_id` for bare workspace opens.
- 2026-05-29: Workspace recents/pins slice added `user_workspace_state` for per-user last-opened timestamps and personal pins. Link-shared workspaces remain absent from normal dashboard lists until the current user successfully opens the workspace URL.
- 2026-05-28: Dev-auth testing slice added disabled-mode per-browser identity switching so workspace sharing roles can be manually tested locally without Google OAuth.

## Pipeline Shape

- The first artifact should be an umbrella workspace PRD, not a giant implementation PRD.
- The umbrella PRD should capture product intent, domain model, non-goals, and high-level vertical slice boundaries.
- Each major vertical slice can later get its own focused PRD/issues.
- The first implementation milestone should prove end-to-end workspace isolation: create two workspaces, open different datasets in each, switch between them, and verify they do not affect each other.
- The first isolation slice should not include workspace saved views. It should focus on create/open workspace, workspace-scoped WebSocket/document state, dataset add/remove, and switching between isolated workspaces.
- The first isolation slice should include role-shaped schema/API concepts, but can implement owner-only access plus admin override.
- Explicit member sharing and link access should be a later vertical slice.
- The first isolation slice should persist workspaces across server restart.
- First-slice persistence should include workspace record, owner membership, document snapshot/seq, and enough dataset membership/source binding data to reopen the workspace.
- Runtime identity migration to `workspace_dataset_id` should happen after the first isolation slice and before workspace saved views.
- The first isolation slice may temporarily use source-derived dataset IDs as workspace dataset IDs if that lowers implementation risk.
- This temporary identity collapse is allowed only because v0 initially enforces one source membership per workspace.
- The umbrella PRD should name this as temporary technical debt to be resolved by the runtime identity migration slice.
- Persisted workspaces should restore live runtime state lazily when the workspace is opened, not eagerly at server startup.
- Dashboard/list APIs should read workspace metadata from SQLite without warming dataset stores or live bindings.
- Idle live-workspace eviction is expected architecture, but not required in the first isolation slice.
- First slice may keep loaded workspaces live in memory until process exit as long as durable state is persisted.
- A later lifecycle/cleanup slice should add idle TTL eviction, background service cancellation, and memory/cache accounting.

## Core Workspace Semantics

- A workspace is the durable collaborative container users return to over time.
- A workspace owns loaded dataset membership, shared document state, shared workspace saved views, default view pointer, and access policy.
- A workspace is not a browser tab, login session, transient WebSocket runtime, or saved view.
- Live WebSocket sessions, presence, cursors, and follow state attach to a workspace while users are active, but do not define the workspace.
- Dataset add/remove is a shared workspace action by default.
- Adding a dataset to a workspace should persist and broadcast immediately to all connected clients in that workspace, including viewers.
- New datasets can default visible for everyone initially, after which each user's local view state can hide/reorder/tune them.
- Personal scratch datasets layered onto a shared workspace are out of scope for v0.
- Shared document changes should persist automatically. There should be no "Save workspace" button.
- Durable workspace document storage should start as latest document snapshot plus monotonically increasing `seq`, not a full command/event log.
- Workspace document snapshot should remain user/document state only.
- Workspace document snapshots should be stored as JSON blobs in SQLite.
- Normalize workspace metadata, memberships, dataset source records, workspace dataset memberships, and saved views; do not normalize every field inside `DocumentState`.
- `workspace_datasets` is authoritative for workspace dataset membership.
- `document_json` is authoritative for the current client-facing document/render state snapshot.
- Dataset add/remove must update `workspace_datasets` and `document_json` in one transaction.
- Removing a dataset from a workspace requires editor/owner permission and should be confirmed in the UI.
- The confirmation should clarify that removal affects workspace membership only, not upstream storage or global cache.
- On consistency conflicts between membership rows and document JSON, `WorkspaceManager`/`WorkspaceStore` should repair or reject explicitly rather than silently choosing one.
- Server-private operational binding/cache/generated service details should not be persisted inside document JSON.
- Operational binding restore should use structured workspace dataset membership and dataset source records.
- Workspace document commands should persist before broadcast/ack.
- Document command flow should be `authorize -> apply -> persist snapshot/seq -> broadcast/ack`.
- Concurrent shared document mutations from multiple editors should be serialized per workspace using the existing sequenced command model.
- `WorkspaceManager` should avoid a global command-application lock.
- Command application/sequencing should lock per live workspace so Workspace A does not block Workspace B.
- A short manager-level map lock for locating/loading live workspaces is acceptable.
- Concurrent adds of the same dataset source in one workspace should dedupe or resolve to no-op/reuse via the `unique(workspace_id, dataset_source_id)` rule.
- Concurrent add/remove races resolve by workspace command order; no conflict-resolution UI in v0.
- Presence remains fire-and-forget and not persisted.

## View State Semantics

- Camera, z/t/c, visibility, opacity, contrast, colormaps, and layer order remain personal/local by default.
- Active layout remains shared workspace document state, not personal view state.
- Active layout should stay shared because peer cursors, follow mode, and spatial context become misleading if collaborators view the same workspace through different active layouts.
- Changing active layout requires editor access.
- Dataset visibility, layer order, contrast, opacity, colormaps, and channel settings remain personal view state.
- Follow mode should mirror the followed peer's camera and dataset presence so visual context stays coherent while following.
- Local view changes should not continuously mutate the workspace's canonical state.
- Users preserve or share view state explicitly through shared saved views, inline `#view` URLs, or a workspace default view.
- Workspace default view should exist, but not be required in the first isolation slice.
- The workspace default view should be stored as a pointer to a shared workspace saved view: `default_saved_view_id`.
- Editors can set the workspace default view.
- Reopening `/w/:id` applies the default view if present; otherwise Lucida uses normal initial view behavior.
- `/w/:id#view=...` and `/w/:id#b=...` override the default view.
- Default view should be applied client-side after workspace document load, using the same saved-view applier path as `#b`.
- Server snapshots should remain shared document state, not a personalized viewport command stream.
- Per-user automatic last-view restore is deferred to an idea issue.

## Saved Views And Bookmarks

- Workspace saved views/bookmarks are shared workspace objects.
- Workspace saved-view IDs should be globally unique opaque IDs.
- Saved-view links should still be workspace-routed: `/w/:workspace_id#b=:saved_view_id`.
- Resolving a saved-view link must first check workspace access, then verify `saved_view.workspace_id == workspace_id` before applying.
- Saved-view API routes should be workspace-scoped, e.g. `GET /api/workspaces/:workspace_id/saved-views/:saved_view_id`, even though saved-view IDs are globally unique.
- All new workspace APIs should live under `/api/workspaces/...`.
- Avoid introducing new global workspace-adjacent APIs that would later need retrofitting to a workspace boundary.
- Saved views keep creator metadata, but are visible to workspace members by default.
- Editors can create, update, rename, and delete shared workspace saved views.
- Viewers can open and copy saved-view links, but cannot mutate shared saved views.
- "Mine only" can remain a UI filter, but ownership should not hide a shared saved view by default.
- Personal saved views are out of scope for v0 and tracked separately as an idea.
- Workspace saved views should replace the current global bookmark concept once workspaces land.
- Because there are no users yet, no migration from global bookmarks is required.
- Existing bookmark code is useful prior art, not a compatibility target.
- Saved views should reference workspace-local dataset IDs, not source URLs.
- Workspace saved views/default views should capture active layout IDs as part of their expected spatial context.
- Applying a saved view as an editor may switch active layout when needed.
- Applying a saved view as a viewer should not mutate active layout; if active layout differs from the captured view, Lucida should warn and skip layout mutation.
- Default view is workspace-owned and set by editors, so it can expect/set active layout as part of workspace presentation.
- Applying a saved view should preserve Lucida's existing document-command vs viewport/local-command split.
- Viewers may apply local/viewport portions of a saved view: camera, z/t/c, visibility, order, contrast, opacity, colormaps, and channel settings.
- Viewers may not apply document-command portions such as add/remove dataset or active-layout mutation.
- Opening a saved view does not import/add datasets by URL.
- If a saved view references a workspace dataset that no longer exists, it should partially apply and clearly report the missing dataset.
- Removing a dataset from a workspace should not automatically delete shared saved views that reference it.
- Saved views can become partially stale; editors can clean them manually and apply should warn on missing datasets.
- Workspace saved views should best-effort apply to the current workspace document in v0.
- Saved views should not require the workspace document `seq` to match before applying.
- Storing `captured_at_seq` for diagnostics is acceptable, but stale `seq` should not block apply.

## URL Model

- Root `/` should show the workspace dashboard.
- No backward compatibility is required for the old root viewer/global-session flow.
- Viewer access requires `/w/:workspace_id`; the old global shared session disappears.
- Viewer URLs should be workspace-scoped:
  - `/w/:workspace_id`
  - `/w/:workspace_id#view=...`
  - `/w/:workspace_id#b=...`
- After applying `/w/:workspace_id#b=:saved_view_id`, the URL should collapse to `/w/:workspace_id#view=...` so further navigation reflects the current view rather than remaining tied to the original saved view.
- Workspace IDs in URLs should be opaque, stable, and unguessable.
- Workspace names are editable display labels, not URL identity.
- Human-readable slugs can be added later as cosmetic aliases, but are not the durable identity.
- Inline share URLs should not include dataset source URLs.
- Inline `#view` payloads should reference workspace-local dataset IDs and view/display state only.
- Inside `/w/:workspace_id`, Lucida should keep the current URL-as-view behavior: local viewport/view changes debounce-update the hash to `#view=...`.
- The dashboard `/` should not carry a view hash.
- Inline `#view` payloads should not duplicate the workspace ID. The `/w/:workspace_id` path is the authority for workspace selection and access checks.
- The `#view` decoder should apply the payload to the current workspace and handle missing workspace dataset IDs with a partial-apply warning.
- Inline `#view` URLs may apply visually blank or confusing local settings, such as hiding all datasets; Lucida should not block them on aesthetic grounds.
- View apply validation should focus on access, dataset membership, and document-command permissions.
- If a user cannot access the workspace, the hash payload should not reveal useful dataset source information.

## Dataset Identity And Membership

- The umbrella PRD should explicitly introduce two durable data concepts:
  - `dataset_source`: global source identity, source URL, import/cache/generated state
  - `workspace_dataset`: workspace-local membership/layer, display name/order, pointer to a dataset source
- The first implementation may still restrict a source to one membership per workspace, but the PRD should not collapse the concepts.
- Separate global dataset source identity from workspace-local dataset membership identity.
- Global `dataset_source_id` should deduplicate import/cache/generated coarse work across workspaces, likely derived from canonical source URL.
- `dataset_source_id` should be derived from a conservatively canonicalized source URL string.
- `dataset_source_id` should be deterministic and stable across deployments when the canonical source URL string is the same, but it should not be treated as proof of content identity.
- Global dataset source records should persist enough import/source metadata to avoid unnecessary re-imports where practical.
- At minimum, source records need ID, canonical URL, default/display name, lifecycle timestamps, and enough manifest/fetch/import metadata to rebuild live bindings after restart.
- A full curated dataset catalog is out of scope for v0.
- V0 does not detect whether source content changed behind the same URL beyond normal open/import/chunk-serving failures.
- Workspaces persist references to dataset sources; they do not snapshot dataset bytes.
- Explicit source refresh/change diagnostics can be added later.
- Workspace IDs and workspace dataset IDs should be random/opaque deployment-local IDs.
- Workspace dataset IDs should be globally unique opaque IDs even though they represent workspace-local memberships.
- Cache/import/generated reuse is keyed through `dataset_source_id`, so multiple workspace dataset memberships can point at the same source and reuse cache.
- Operations using a workspace dataset ID must still validate that the membership belongs to the current workspace.
- Canonicalization exists to avoid accidental duplicates for obvious formatting differences, not to prove two URLs point to identical bytes.
- Conservative v0 canonicalization can trim whitespace, normalize obvious local file forms, and potentially strip semantically empty trailing slashes for supported dataset root URLs.
- V0 canonicalization should not strip query strings, lowercase paths, resolve symlinks, or content-hash datasets.
- Workspace `workspace_dataset_id` should identify the dataset's membership/layer inside one workspace.
- v0 should enforce one membership per dataset source per workspace, e.g. `unique(workspace_id, dataset_source_id)`.
- The workspace-local ID model keeps the door open for duplicate source memberships later, but that comparison workflow is not part of v0.
- Workspace saved views should reference `workspace_dataset_id`.
- `DatasetOpened` should remain the client-facing document command in v0 where possible.
- Internally, adding a dataset means creating/restoring a dataset source, creating workspace dataset membership, then broadcasting a `DatasetOpened`-equivalent command to clients in that workspace.
- Runtime client/rendering identity should migrate to `workspace_dataset_id` as a dedicated prerequisite slice before workspace saved views.
- Source/cache/chunk routing should map from `workspace_dataset_id` to `dataset_source_id` rather than treating source-derived IDs as the layer/document identity.
- Workspace saved views and inline `#view` payloads must key dataset state by `workspace_dataset_id`, not source URL or global source hash.
- Avoid sneaking the runtime identity migration into the saved-view slice; it has broad rendering/cache/planning blast radius and should be tested independently.
- Removing a dataset from one workspace removes only that workspace's membership, not global source cache.
- Cache cleanup and garbage collection are later concerns.
- The same global dataset source may appear in multiple workspaces, and eventually may appear more than once in one workspace.
- Editable workspace dataset display names are deferred to an idea issue.
- Default dataset display names can come from the imported manifest/source path initially.
- Dataset source URLs should be persisted in plaintext in SQLite for v0 so the server can lazily restore bindings after restart.
- Source URL exposure should be role-gated in the UI, and copied `#view`/saved-view links should not contain source URLs.
- Presigned URLs remain poor long-term source identifiers because they expire and embed credentials; solving credential brokerage/catalogs is out of scope for v0.
- Dataset source URLs should be visible to editors/owners where useful for management/debugging, but hidden or minimized for viewers.

## Access Control And Sharing

- Access control is workspace-level for v0.
- Workspace membership should be invite/share-by-email in v0 because users think in email addresses.
- Store provider/principal subject identifiers where available for future hardening, but email is the v0 membership lookup target.
- Adding `alice@example.com` should grant access when Alice signs in with that email.
- Workspace owners can add members by email before those users have ever signed into Lucida.
- On first sign-in with a matching email, the user should gain access to pre-provisioned workspace memberships.
- Per-dataset app-level ACLs inside one workspace are out of scope.
- Underlying storage credentials/permissions still apply at the storage layer.
- Teams/groups are out of scope.
- Sharing modes:
  - restricted: only explicitly added users can access
  - anyone with link: any signed-in user with the workspace URL can access
- Anonymous access is out of scope.
- Link access can grant viewer or editor, but never owner.
- Explicit members can be viewer, editor, or owner.
- Only owners can manage membership, link access, rename/archive/delete, and transfer ownership.
- Editors can mutate workspace content: add/remove datasets, create/update/delete shared saved views, change shared active layout, and set default view.
- Viewers can open workspaces, inspect data, pan/zoom/change local view, follow peers, open saved views, and copy links.
- Viewers can create/copy inline `#view` links from their local state because this does not mutate shared workspace state.
- Creating named shared saved views requires editor access.
- Viewers can follow other collaborators.
- Other collaborators can intentionally follow a viewer.
- Viewer-role users should not be able to steer other users into following them. Steer/presenter-style controls should require editor/owner or be deferred behind a later presenter-control design.
- V0 workspace UX should expose voluntary follow only. No user-facing steer/presenter controls in v0.
- Viewer-role users may need a way to propose saved views/bookmarks for editor approval; this is deferred to idea issue #702.
- If a user successfully opens an anyone-with-link workspace, record user workspace state so it appears in their recents and can be pinned.
- Workspace pinning is personal per user and belongs in `user_workspace_state`, not on the workspace record.
- Shared/featured workspaces are a separate concept and out of scope for v0.
- Link-shared workspaces are not globally discoverable. They become visible to a user after explicit membership or successful link visit.
- If link access is later disabled, users who only had link-derived access should lose access and the workspace should disappear from normal accessible lists.

## Workspace Lifecycle And Dashboard

- Newly created workspaces default to restricted, owner-only, link access off.
- The creator becomes owner.
- Any signed-in user can create workspaces in v0.
- Admin-only or allowlisted workspace creation is out of scope unless future deployment governance requires it.
- Workspace creation should support blank workspace first.
- Workspace creation should create immediately with an editable default name, such as "Untitled workspace", rather than blocking on a naming modal.
- Do not auto-archive/delete a workspace merely because it still has a default name.
- Empty workspaces are valid.
- Users may create a workspace before adding datasets or remove all datasets and keep the workspace.
- The viewer should show an empty state with an "Add dataset" path rather than auto-cleaning empty workspaces.
- "Create workspace from dataset" is deferred to an idea issue.
- "Duplicate workspace without transferring permissions" is deferred to an idea issue.
- Workspace archive/restore should be the v0 destructive lifecycle model.
- Hard delete should be admin-only or deferred.
- Workspace storage limits/quotas are out of scope for v0.
- Workspace records should still carry basic lifecycle metadata such as `created_at`, `updated_at`, and `archived_at` so admin cleanup is possible later.
- V0 should rely on archive/admin cleanup and existing cache budget controls rather than per-user or per-workspace quotas.
- Archived workspaces should disappear from normal lists.
- Normal dashboard lists exclude archived workspaces.
- Owners should have an archived filter/list where they can restore their archived workspaces.
- Viewers/editors do not need archived workspaces in normal dashboard UX.
- Admins can find archived workspaces through admin/support tooling.
- Owners/admins can restore archived workspaces.
- Archiving a workspace should revoke live usability: new WebSocket connections are denied, mutating commands fail, and existing clients are notified or redirected.
- A polished archive modal is not required initially, but archived workspaces must not remain live/editable.
- The first dashboard should be functional rather than polished:
  - recent/accessed workspaces
  - pinned workspaces
  - create workspace
  - open workspace
  - search by name if cheap
- Dashboard workspace lists should be derived from explicit membership/ownership plus `user_workspace_state` for prior link visits, recents, and pins.
- Dashboard listing should not scan and show all `anyone_with_link` workspaces globally.
- Dashboard search should filter only workspaces already visible to the user through membership/ownership or prior link visit.
- Users discover unvisited link-shared workspaces by opening the URL, not by name search.
- SPA routes should include `/` dashboard and `/w/:id` viewer.
- The viewer route should include minimal workspace chrome for orientation: workspace name, back/dashboard navigation, sharing/access control entry point for owners, and inaccessible/archive states.
- This viewer chrome is required for workspace clarity and is not considered optional dashboard polish.
- Switching workspaces can tear down the old viewer/WebSocket/render loop and open the new workspace. One active workspace per browser tab is enough for v0.
- The app does not need to keep multiple workspaces hot in one tab.
- Persistent per-user unsaved local view state is out of scope for v0.

## Live Collaboration

- Server-side workspace lookup, authorization, live-state loading, document application, persistence, and broadcast coordination should be centralized behind a `WorkspaceManager`-style deep module.
- Workspace logic should not be scattered independently through WebSocket handlers, dataset-open handlers, saved-view handlers, dashboard routes, and admin routes.
- Durable workspace persistence should sit behind a `WorkspaceStore` trait from day one, following the auth/bookmark store pattern.
- `WorkspaceManager` owns live orchestration, authorization, command flow, and broadcast coordination.
- `WorkspaceStore` owns durable records, migrations/queries, transaction boundaries, and membership/document persistence.
- Tests should be able to use an in-memory workspace store where practical.
- Workspace tables should live in the existing SQLite database (`lucida.db`) shared with auth and bookmarks.
- Workspaces should add migrations/tables to the existing DB rather than introducing a second DB file.
- Each live workspace should own its own broadcast channel, client/presence map, and sequence counter.
- Avoid a single global broadcast channel with workspace filtering.
- Chunk/binary unicast routing should be workspace-scoped, or at minimum keyed by `(workspace_id, client_id)`.
- Binary/chunk/status routes must not be able to deliver data across workspaces accidentally.
- `ClientId` should be treated as workspace-local live peer identity.
- If global connection correlation is needed for logs/debugging, use a separate global `connection_id`.
- Presence, peers, follow mode, cursor updates, document command broadcasts, and saved-view broadcasts should be scoped to one workspace.
- Workspace snapshots include only peers in the same workspace.
- PeerJoined/PeerLeft, presence, cursor, follow, saved-view changed, and dataset document broadcasts are all workspace-local.
- The current overlapping-loaded-datasets bookmark broadcast scope should not carry forward; workspace saved-view broadcasts use workspace scope.
- Sequence numbers are per workspace.
- New browser tabs/windows in the same workspace are separate live clients.
- Multiple live clients from the same signed-in user can be grouped visually later, but protocol state should remain client/tab scoped.
- WebSocket connect requires at least viewer access.
- Mutating document commands require editor or owner access.
- Access-management APIs require owner access.
- The server must enforce access checks on HTTP APIs, WebSocket connect, and mutating commands. Frontend button hiding is not sufficient.
- If a connected user's permissions are downgraded, the next mutating command should be denied. A follow-up access-changed event or reconnect flow can improve UX.
- Workspace membership and link-access changes should take effect immediately for server-side enforcement.
- If a user loses access while connected, their next command/API request is denied; ideally the server also pushes an access-revoked message and the client returns to dashboard.
- If a user's role is upgraded while connected, a full reload is acceptable in v0, though live permission refresh is preferred later.
- Admins should have minimal override tooling for support/cleanup: list/find workspaces, access or restore/archive workspaces, and manage ownership if needed.
- Full admin dashboards, audit reports, quota enforcement, and bulk policy tooling are out of scope for v0.

## Out Of Scope For Umbrella v0

- Lucida CLI workspace support and workspace management commands.
- Teams/groups.
- Per-dataset ACLs inside one workspace.
- Personal scratch datasets layered over a shared workspace.
- Anonymous access.
- Full command/event history, activity feed, comments, audit UI, undo, or time-travel restore.
- Automatic per-user last-view restore.
- Personal saved views.
- Create workspace directly from dataset.
- Duplicate workspace.
- Editable workspace dataset display names.
- Full dashboard redesign/polish.
- Annotation implementation. Workspaces should be designed as the future annotation ownership boundary, but annotation work is not part of this PRD.

## Testing Priorities

- First isolation slice tests should prioritize server-side workspace isolation over frontend dashboard polish.
- Tests should prove that two workspaces have independent documents/sequences and dataset membership.
- Tests should prove dataset opens/removals and broadcasts do not cross workspace boundaries.
- Tests should cover WebSocket snapshots scoped to one workspace.
- Tests should cover unauthorized access denial and owner/admin access for the first slice.
- Tests should cover document snapshot/seq persistence across store reload or server restart simulation.
- Tests should cover duplicate dataset add dedupe within one workspace.
- Frontend tests can be lighter initially: dashboard route smoke, create/open workspace path, and add-dataset UI path where feasible.

## Recommended High-Level Slice Order

1. Demoable workspace isolation tracer bullet: create workspace, open `/w/:id`, add/remove datasets scoped to that workspace, switch between two workspaces, persist across restart, owner-only access plus admin override.
2. Runtime identity migration to `workspace_dataset_id`.
3. Sharing model: explicit members plus anyone-with-link viewer/editor.
4. Workspace saved views, default view, and `#view`/`#b` URL semantics.
5. Archive/restore plus minimal admin override tools.
6. Lifecycle cleanup: idle live workspace eviction and background cancellation.

## Deferred Idea Issues Filed

- #697: Idea: create workspace directly from dataset
- #698: Idea: duplicate workspace without transferring permissions
- #699: Idea: personal saved views inside a workspace
- #700: Idea: remember my last view per workspace
- #701: Idea: editable workspace dataset display names
- #702: Idea: viewer-proposed workspace saved views

## Open Threads To Continue

- Exact workspace schema names and whether to introduce separate `dataset_sources` and `workspace_datasets` tables in the umbrella PRD.
- Whether workspace saved-view IDs should be globally opaque or workspace-local.
- How strict the first `#view` decoder should be when the payload contains stale workspace dataset IDs.
- Whether active layout should remain a shared document command in workspaces exactly as it is today.
- Whether workspace dashboard search is required in the first usable slice or can wait for polish.
