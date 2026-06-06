# CLI/Python Client Surface Implementation Slices

Date: 2026-06-06
Parent PRD: #745
Source PRD: `wiki/outputs/2026-06-06-cli-python-client-surface-prd.md`
Status: draft for review before filing child GitHub issues

These slices convert the parent PRD into tracer-bullet issues. Each slice should be demoable on its own and should land as its own PR. The dependency order is intentionally architectural: establish one product command, one target-resolution/auth model, then layer product nouns onto that shared client model.

## Dependency Graph

1. Product CLI foundation
2. Bearer credential auth
3. Workspace discovery and targeting
4. Workspace-targeted dataset open
5. Dataset browse, inventory, and removal
6. View and camera command tree
7. Layer and channel command tree
8. Layout command tree
9. Workspace saved views command tree
10. Peer, presence, and follow diagnostics
11. Plan/debug diagnostics
12. Remote admin/support commands
13. Python server-client MVP
14. Docs, packaging, and legacy cleanup

Slices 1-5 should remain mostly serial because they create shared config, HTTP, auth, target-resolution, and WebSocket-client modules. After slice 5, several command-surface slices could be implemented in parallel only if the command mapper has a stable extension pattern; otherwise the parser and mapper files will conflict.

## Slice 1: Product CLI Foundation

Type: AFK
Blocked by: None
User stories covered: 1, 2, 4, 5, 48, 49, 50, 51, 52, 53
Related prior issues: #743

### What to build

Introduce the new user-facing `lucida` command shape and the shared CLI foundation it needs: config storage, base HTTP client, output modes, normalized errors, and `lucida status`. This is the clean cut from the current flat `lucida-cli` UX, but it can keep crate/package names as implementation details while the binary/product command becomes `lucida`.

### Acceptance criteria

- [ ] `lucida --help` shows noun-based top-level groups, not the old flat command contract.
- [ ] `lucida config set server <base-url>` persists the default server.
- [ ] `lucida config get server` and `lucida status` read the persisted server.
- [ ] `lucida status` checks `/healthz`, `/readyz`, `/version`, and `/auth/whoami` where available.
- [ ] Every command has shared `--server`, `--json`, and `--quiet` plumbing even if later slices add more command groups.
- [ ] Human output is concise by default; `--json` emits stable machine-readable objects.
- [ ] Errors are normalized into the PRD categories where applicable: unreachable server, unauthenticated, unauthorized, missing resource, ambiguous name, archived workspace, dataset-open failure, session disconnect, rejected command.
- [ ] Parser tests cover the new top-level shape and `--json` / `--quiet` / `--server` behavior.
- [ ] Documentation examples stop presenting the old flat CLI as the product surface.

### Wiki context

- `wiki/systems/crates/lucida-cli.md`
- `wiki/systems/crates/lucida-server.md`
- `wiki/systems/subsystems/auth.md`

## Slice 2: Bearer Credential Auth

Type: HITL
Blocked by: Slice 1
User stories covered: 1, 41, 42, 43, 44, 48, 50
Related prior issues: #738

### What to build

Add first-class opaque bearer credentials for CLI/Python clients, resolving through the same `AuthPrincipal` boundary as browser cookie sessions. Provide `lucida auth login`, `auth whoami`, `auth logout`, and token revocation semantics. The login flow should be browser-assisted and auditable, with keychain storage when available and a `0600` config fallback.

### Acceptance criteria

- [ ] Server has a bearer credential store with name, expiry, revocation state, created/last-used metadata, and audit events.
- [ ] Server auth extraction accepts either existing httpOnly cookie sessions or `Authorization: Bearer <token>` and yields the same `AuthPrincipal` type.
- [ ] WebSocket workspace upgrades accept bearer auth for non-browser clients.
- [ ] `lucida auth login` opens the browser approval flow and stores the returned token.
- [ ] `lucida auth whoami` works with the stored token and with `LUCIDA_TOKEN`.
- [ ] `lucida auth logout` removes local credentials and can revoke the server-side credential.
- [ ] Missing, expired, revoked, and unauthorized credentials produce structured errors.
- [ ] Tests cover token creation, lookup, expiry, revocation, last-used updates, audit events, HTTP auth, and WebSocket auth.
- [ ] The flow never copies browser cookies, Google ID tokens, Google refresh tokens, or OAuth provider credentials into CLI/Python clients.

### Wiki context

- `wiki/systems/subsystems/auth.md`
- `wiki/flows/auth-signin.md`
- `wiki/systems/crates/lucida-server.md`
- `wiki/systems/crates/lucida-cli.md`

## Slice 3: Workspace Discovery And Targeting

Type: AFK
Blocked by: Slices 1, 2
User stories covered: 1, 3, 4, 5, 6, 7, 8, 9, 10, 11, 48, 49, 50, 51, 52
Related prior issues: #739

### What to build

Make workspaces the CLI discovery spine. Add workspace list/create/info/open/use, persistent default workspace selection, ID/name resolution, and the target resolver that later dataset/view/layer commands reuse to derive HTTP and WebSocket targets.

### Acceptance criteria

- [ ] `lucida workspace list` shows accessible active workspaces with role, pin/recent state, dataset count, and archive state where relevant.
- [ ] `lucida workspace list --archived` shows archived workspaces where the current principal has access.
- [ ] `lucida workspace create [name]` creates a workspace and prints the resolved ID.
- [ ] `lucida workspace info <id-or-name>` resolves opaque IDs and unambiguous names.
- [ ] Ambiguous names fail clearly and never choose implicitly.
- [ ] `lucida workspace use <id-or-name>` persists the default workspace.
- [ ] `lucida workspace open <id-or-name>` prints or opens the `/w/:workspace_id` browser route.
- [ ] Target resolution produces base HTTP URLs and `/ws/workspaces/:id` URLs without requiring users to hand-construct WebSocket URLs.
- [ ] Mutating commands print the resolved target unless `--quiet` is set.
- [ ] Tests cover defaults, overrides, ID/name resolution, missing defaults, ambiguous names, archived workspaces, and URL derivation.

### Wiki context

- `wiki/systems/crates/lucida-server.md`
- `wiki/systems/crates/lucida-cli.md`
- `wiki/systems/subsystems/auth.md`

## Slice 4: Workspace-Targeted Dataset Open

Type: AFK
Blocked by: Slice 3
User stories covered: 12, 13, 17, 48, 50, 51, 54
Related prior issues: #739, #743

### What to build

Fold the currently working dataset-open behavior into the workspace-first product shape: `lucida dataset open <path-or-url>`. It should target the selected workspace, authenticate consistently, connect to the workspace WebSocket, send `OpenRemoteDataset`, wait for `DatasetOpened` or `OpenDatasetFailed`, and produce output that makes browser verification obvious.

### Acceptance criteria

- [ ] `lucida dataset open <path-or-url>` targets the persisted workspace by default.
- [ ] `--workspace` overrides the persisted workspace for this command.
- [ ] The command connects to `/ws/workspaces/:id`, not the legacy global `/ws`, during normal use.
- [ ] Success output includes workspace ID, workspace dataset ID, name, image count, entity count, and sequence.
- [ ] Failure output distinguishes unsupported path/URL, permission failure, import failure, timeout, and disconnected session where the server exposes those distinctions.
- [ ] The command remains visibly verifiable in an already-open browser workspace.
- [ ] Tests cover `DatasetOpened`, `OpenDatasetFailed`, timeout, disconnect, and ignored unrelated WebSocket messages.

### Wiki context

- `wiki/flows/dataset-opening.md`
- `wiki/systems/crates/lucida-cli.md`
- `wiki/systems/crates/lucida-server.md`
- `wiki/systems/crates/lucida-store.md`

## Slice 5: Dataset Browse, Inventory, And Removal

Type: AFK
Blocked by: Slice 4
User stories covered: 14, 15, 16, 17, 48, 49, 50, 51
Related prior issues: #739

### What to build

Complete the basic dataset noun beyond open: browse server-visible paths, list loaded workspace datasets, inspect dataset metadata from session state, and remove a dataset through the shared document command path.

### Acceptance criteria

- [ ] `lucida dataset browse [path]` calls `/api/browse` and displays files/directories in a scan-friendly table or JSON.
- [ ] Browse errors preserve server security/permission distinctions without leaking internal paths.
- [ ] `lucida dataset list` shows loaded workspace datasets from the current workspace session/document state.
- [ ] `lucida dataset info <dataset>` prints manifest summary, images, dimensions, channel count, and active layout where available.
- [ ] `lucida dataset remove <dataset>` sends `DocumentCommand::RemoveDataset` to the workspace session and waits for ack/broadcast confirmation.
- [ ] Dataset identifiers in output are workspace-local IDs in workspace sessions.
- [ ] Tests cover browse output, list/info from snapshots, remove command mapping, and permission/rejection errors.

### Wiki context

- `wiki/flows/dataset-opening.md`
- `wiki/systems/crates/lucida-server.md`
- `wiki/systems/crates/lucida-cli.md`
- `wiki/systems/crates/lucida-content.md`

## Slice 6: View And Camera Command Tree

Type: AFK
Blocked by: Slice 4
User stories covered: 18, 19, 48, 50, 51
Related prior issues: #737, #743

### What to build

Recast the existing viewport commands under `lucida view` and `lucida camera`, completing the missing variants from `ViewportCommand` while keeping Lucida core as the source of view/camera truth.

### Acceptance criteria

- [ ] `lucida view pan`, `zoom`, `set-zoom`, `center`, `slice`, `z-range`, and `viewport-size` map to the intended `ViewportCommand` variants.
- [ ] `lucida camera mode slice|arcball|fly`, `rotate`, `pan`, `zoom`, and `fly-tick` cover the current 3D/fly command vocabulary.
- [ ] Negative numeric values parse without clap ambiguity.
- [ ] Commands reconstruct `Scene` from the workspace snapshot, apply the command locally, and emit presence rather than document commands.
- [ ] `--peer` or an equivalent explicit adoption flag still allows starting from a peer state, but commands do not silently choose arbitrary peers for scripts.
- [ ] Tests cover parser shape, command mapping, scene application, and presence message shape.

### Wiki context

- `wiki/systems/crates/lucida-cli.md`
- `wiki/systems/crates/lucida-core.md`
- `wiki/flows/presence-propagation.md`
- `wiki/systems/subsystems/presence-and-follow-mode.md`

## Slice 7: Layer And Channel Command Tree

Type: AFK
Blocked by: Slice 6
User stories covered: 20, 21, 22, 48, 50, 51
Related prior issues: #737, #740

### What to build

Expose dataset display state as `lucida layer` and `lucida channel` commands: visibility, order, opacity, contrast, gamma, colormap, blend mode, render mode, detail override, multichannel mode, and per-channel settings. Display changes should emit dataset presence so peers and followers can observe them.

### Acceptance criteria

- [ ] `lucida layer` covers dataset order, visibility, opacity, contrast, gamma, colormap where applicable, blend mode, render mode, and detail override.
- [ ] `lucida channel` covers multichannel mode, channel visibility, colormap, contrast, gamma, and channel blend mode.
- [ ] Commands resolve dataset IDs/names from the workspace snapshot where feasible, with clear ambiguity/missing errors.
- [ ] Commands apply through `Scene`/`ViewportCommand` and emit `ClientMessage::DatasetPresence` where display state changed.
- [ ] Human and JSON outputs show the resulting dataset/channel state.
- [ ] Tests cover command mapping, dataset resolution, dataset presence emission, and invalid channel/dataset errors.

### Wiki context

- `wiki/systems/subsystems/multichannel-and-colormaps.md`
- `wiki/systems/subsystems/presence-and-follow-mode.md`
- `wiki/flows/presence-propagation.md`
- `wiki/systems/crates/lucida-core.md`

## Slice 8: Layout Command Tree

Type: AFK
Blocked by: Slice 5
User stories covered: 23, 24, 48, 50, 51

### What to build

Expose shared layout document state through `lucida layout`: list available layouts for loaded datasets and set the active layout through the sequenced document-command path with workspace role enforcement.

### Acceptance criteria

- [ ] `lucida layout list [dataset]` shows source and registered layouts from the workspace snapshot.
- [ ] `lucida layout active [dataset]` shows the active layout and fallback/default where visible.
- [ ] `lucida layout set <dataset> <layout>` sends `DocumentCommand::SetActiveLayout` and waits for ack/broadcast confirmation.
- [ ] Viewer-role users receive a clear unauthorized/rejected command error for layout mutation.
- [ ] Unknown layouts follow current core behavior where appropriate, but CLI output warns when a fallback/default is what will render.
- [ ] Tests cover layout listing, active layout detection, command mapping, ack handling, and permission rejection.

### Wiki context

- `wiki/systems/subsystems/layout-system.md`
- `wiki/systems/crates/lucida-core.md`
- `wiki/systems/crates/lucida-server.md`

## Slice 9: Workspace Saved Views Command Tree

Type: AFK
Blocked by: Slices 5, 6, 7, 8
User stories covered: 25, 26, 27, 28, 48, 50, 51, 52

### What to build

Expose workspace saved views as the durable view-sharing surface: list/show/apply/capture/update/delete/default/link. This should use workspace routes and workspace-local dataset IDs, not global bookmarks or source URL recipes.

### Acceptance criteria

- [ ] `lucida saved-view list` and `show <id-or-name>` call workspace saved-view APIs.
- [ ] `lucida saved-view apply <id-or-name>` applies the saved view to the current CLI/session state and emits the necessary presence/document changes.
- [ ] `lucida saved-view capture <name>` captures current workspace state using the same schema as the web app.
- [ ] `rename`, `update`, `delete`, and `set-default` respect viewer/editor role checks.
- [ ] `lucida saved-view link <id-or-name>` produces `/w/:workspace_id#b=<saved_view_id>` links.
- [ ] The CLI never promotes global bookmarks as the product surface and never emits source URLs for workspace saved-view links.
- [ ] Tests cover list/show, apply, capture/update/delete/default, role failures, and link generation.

### Wiki context

- `wiki/systems/subsystems/saved-views.md`
- `wiki/flows/saved-view-recipient-apply.md`
- `wiki/gotchas/saved-view-credentials-in-urls.md`
- `wiki/gotchas/saved-view-client-only-state.md`

## Slice 10: Peer, Presence, And Follow Diagnostics

Type: AFK
Blocked by: Slice 6
User stories covered: 29, 30, 31, 32, 33, 34, 48, 50, 51
Related prior issues: #740, #742

### What to build

Expose collaboration diagnostics and voluntary follow without making steer/presenter behavior casual UX. Add peer listing, follow/unfollow, optional cursor update/clear for tests, and a protocol-reference path for presence messages.

### Acceptance criteria

- [ ] `lucida peer list` shows live peers, following state, and summary presence state from the workspace snapshot.
- [ ] `lucida peer follow <client-id>` and `lucida peer unfollow` use `ClientMessage::Follow`.
- [ ] Follow command output reports accepted/rejected outcomes clearly.
- [ ] Cursor update/clear is available only as an explicit diagnostic/test command if included.
- [ ] Steer is absent from casual default UX; if retained, it lives under an explicit debug/protocol namespace with role/policy caveats.
- [ ] Tests cover peer snapshot parsing, follow/unfollow message shape, follow rejection handling, and cursor message shape if implemented.

### Wiki context

- `wiki/systems/subsystems/presence-and-follow-mode.md`
- `wiki/flows/presence-propagation.md`
- `wiki/systems/crates/lucida-server.md`

## Slice 11: Plan/Debug Diagnostics

Type: AFK
Blocked by: Slices 6, 7
User stories covered: 35, 36, 37, 38, 48, 50, 51
Related prior issues: #741

### What to build

Reframe `visible-chunks` under `lucida plan` or `lucida debug` and add read-only diagnostics for current session state, visible chunks, generated availability, active sets, and any planner-parity caveats.

### Acceptance criteria

- [ ] `lucida plan visible-chunks` uses shared `lucida-core` scene truth and does not reimplement projection math.
- [ ] Output is clearly labeled as either web-planner-equivalent or lower-level scene diagnostic.
- [ ] Diagnostics include dataset, member, tier, multichannel/display context, and generated availability where available.
- [ ] `lucida debug state` replaces the old raw `state` command with human and JSON modes.
- [ ] No command mutates planning config in this slice.
- [ ] Tests cover snapshot-to-scene reconstruction, generated availability handling, output labeling, and JSON shape.

### Wiki context

- `wiki/principles/planning.md`
- `wiki/systems/subsystems/planning-domain.md`
- `wiki/systems/crates/lucida-core.md`
- `wiki/systems/crates/lucida-cli.md`

## Slice 12: Remote Admin/Support Commands

Type: AFK
Blocked by: Slices 2, 3
User stories covered: 39, 40, 48, 50, 51

### What to build

Expose authenticated remote support APIs under `lucida admin` while keeping local process/server management under `lucida-server`. Start with the existing workspace admin and proxy-cache support routes.

### Acceptance criteria

- [ ] `lucida admin workspace search`, `info`, `archive`, `restore`, and `owner add/promote` call existing `/admin/workspaces` routes.
- [ ] `lucida admin clear-proxy-cache` calls the existing admin route if still desired as remote support UX.
- [ ] Non-admin principals receive structured unauthorized errors.
- [ ] Output distinguishes remote admin APIs from local `lucida-server` process operations.
- [ ] Tests cover request construction, admin success, non-admin failure, and JSON/human output.

### Wiki context

- `wiki/systems/crates/lucida-server.md`
- `wiki/systems/subsystems/auth.md`
- `wiki/systems/crates/lucida-cli.md`

## Slice 13: Python Server-Client MVP

Type: HITL
Blocked by: Slices 2, 3, 4, 6, 7
User stories covered: 44, 45, 46, 47, 48, 50

### What to build

Add a pure-Python server-client layer in `lucida-py` that mirrors the CLI noun model for status, auth token sourcing, workspace discovery, dataset open, basic view/layer/channel commands, and snapshot/state access. Keep Rust-backed `PyScene`/`PyStore` as local analysis bindings.

### Acceptance criteria

- [ ] Python exposes a server client with resource objects/methods matching CLI nouns where practical.
- [ ] Python reads `LUCIDA_TOKEN` and can reuse stored CLI credentials where feasible.
- [ ] Python can list/use workspaces, open a dataset into a workspace, inspect snapshot state, and send basic view/layer/channel commands.
- [ ] Server-client code is pure Python unless a measured need requires pyo3 involvement.
- [ ] Existing `PyScene` and `PyStore` local analysis APIs remain available.
- [ ] Pytest coverage exercises auth token sourcing, workspace/dataset basics, WebSocket snapshot handling, command sending, and error normalization.

### Wiki context

- `wiki/systems/crates/lucida-py.md`
- `wiki/systems/crates/lucida-cli.md`
- `wiki/systems/crates/lucida-core.md`
- `wiki/flows/dataset-opening.md`

## Slice 14: Docs, Packaging, And Legacy Cleanup

Type: AFK
Blocked by: Slices 1-13
User stories covered: 52, 53, 54
Related prior issues: #737, #738, #739, #740, #741, #742, #743

### What to build

Finish the clean cut: update user-facing docs, examples, package metadata, and wiki articles so the new workspace-first `lucida` command and Python client model are the documented contract. Close or supersede old gap issues as their slices land.

### Acceptance criteria

- [ ] README and wiki examples use `lucida` noun commands and workspace-first flows.
- [ ] Old flat `lucida-cli` commands are removed, hidden, or explicitly marked non-contractual according to implementation reality.
- [ ] Package/binary metadata exposes `lucida` as the product command.
- [ ] The local browser verification flow for `lucida dataset open` is documented.
- [ ] #737-#743 are either closed by child slice PRs or explicitly linked as superseded by #745 and its child issues.
- [ ] Wiki updates capture any new auth/token, target-resolution, or Python-client boundaries discovered during implementation.

### Wiki context

- `wiki/systems/crates/lucida-cli.md`
- `wiki/systems/crates/lucida-py.md`
- `wiki/systems/subsystems/auth.md`
- `wiki/systems/crates/lucida-server.md`

## Filing Notes

When approved, file these as child issues under #745 in dependency order. Use the parent PRD issue template from `/code`:

- Parent PRD: #745
- What to build: use the slice section summary
- Acceptance criteria: copy the checklist
- Blocked by: replace slice references with actual issue numbers as they are created
- User stories addressed: copy the story numbers
- Wiki context: copy the articles listed for each slice

Security-sensitive slices should include explicit review expectations in the issue body even when the implementation itself is otherwise straightforward. The auth slice is marked HITL for that reason. The Python slice is marked HITL because it creates a public API shape that should get one ergonomics review before it becomes the documented client model.
