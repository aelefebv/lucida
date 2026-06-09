# CLI/Python Client Surface Grill Notes

Date: 2026-06-06
Status: design exploration before PRD
Context: `/code` Thought-to-Idea pass for making Lucida's non-web client surfaces as discoverable as the web GUI.

This is a working note, not an ADR. Promote durable decisions into a PRD or ADR only after the grilling pass hardens the shape.

## Starting Point

The web app is now workspace-first and reasonably discoverable:

- `/` shows the workspace dashboard.
- `/w/:workspace_id` opens a workspace viewer.
- REST APIs expose workspace listing, creation, metadata, sharing, saved views, pinning, archiving, and admin support.
- WebSocket sessions expose live document state, presence, follow, cursor, dataset open, generated availability, and chunk routing.
- The GUI exposes layers, channels, layouts, saved views, sharing, peer follow, local file browsing, debug panels, and workspace lifecycle controls.

The CLI is still mostly a raw WebSocket client:

- `state`
- `open <url>`
- `visible-chunks`
- `pan`, `zoom`, `set-zoom`, `center`
- `slice --axis t|z|c`
- `contrast`, `gamma`
- `set-mode-2d`, `set-mode-3d`, `rotate`
- `steer`

Python has local `PyScene`/`PyStore` bindings plus a higher-level `Viewer`, but that `Viewer` does not yet reflect the current workspace/auth/client architecture.

## Clean-Cut Policy

No compatibility target exists for old client surfaces. There are no active users, so the PRD should optimize for the right architecture instead of preserving legacy command shapes.

Consequences:

- Do not preserve the old global viewer model as a first-class target.
- Do not migrate or promote global bookmarks as a peer of workspace saved views.
- Do not keep the current flat CLI command taxonomy as a compatibility contract.
- Do not require old raw WebSocket URLs as the normal user interface.
- Do not treat the current Python high-level `Viewer` as stable API.
- Compatibility aliases may be useful during an implementation branch, but they should not be part of the product contract unless we explicitly choose that later.

## Architecture Direction

Build one shared client model with three planes.

### HTTP Control Plane

Resource discovery and durable server state:

- `server`
- `auth`
- `workspace`
- `workspace share`
- `saved-view`
- `admin`

This should use the same backend APIs the GUI uses. The CLI/Python clients should not scrape or model the React app.

### WebSocket Session Plane

Live workspace session state:

- `dataset`
- `view`
- `camera`
- `layer`
- `channel`
- `layout`
- `peer`
- `presence`
- `debug/plan`

This plane derives a workspace WebSocket URL from a base HTTP URL and a workspace identity. Raw WebSocket URLs can remain as an implementation escape hatch, not the default user workflow.

### Local Analysis Plane

Python-native and local/offline work:

- local scene construction
- local store open/import
- viewport/chunk reads
- write derived result datasets
- scriptable analysis using the same `Scene`/planning truth as the web app

Python should expose the same noun model as the CLI where it talks to a server, while still keeping local `Scene`/`Store` capabilities for analysis.

Packaging direction:

- Keep Rust-backed local `Scene`/`Store` bindings in `lucida-py`.
- Add the server client as a pure-Python layer in the same package namespace.
- The pure-Python server client should handle HTTP, WebSocket, auth token storage, retries, and high-level resource models.
- Do not push server-client orchestration through pyo3 unless a measured performance or API consistency need appears.

## Command/Client Categories

### `server`

Purpose: discover and inspect a Lucida server.

Current backend support:

- `/healthz`
- `/readyz`
- `/version`

Expected surface:

- `server status`
- `server version`
- `server capabilities` if/when the backend exposes a formal capability document
- config/default server management
- `config set server <base-url>`
- `config get server`
- `status` as a high-level summary of server, auth principal, default workspace, and connection health

Notes:

- Prefer `--base-url http://127.0.0.1:9876`.
- Derive WebSocket URLs internally.
- Raw `--server ws://...` should not be normal UX.
- The CLI should support persistent defaults for server and workspace so routine commands do not require endpoint plumbing every time.
- Every command should still support explicit target overrides.
- Mutating commands should print the resolved target unless `--quiet` is set.

### `auth`

Purpose: know and manage the current principal/session.

Current backend support:

- `/auth/whoami`
- `/auth/logout`
- `/auth/dev/status`
- `/auth/dev/login` in dev mode
- Google OAuth browser flow for production

Expected surface:

- `auth whoami`
- `auth logout`
- `auth dev-login --email ... --display-name ... --admin`
- a production login path that provisions a CLI/Python bearer credential
- `auth login` for browser-assisted bearer credential provisioning
- `auth token revoke` / `auth logout` semantics for removing local and/or server-side credentials

Open issue tie-in:

- This is part of #738.

Target architecture:

- Browser/web clients authenticate with httpOnly cookie sessions.
- CLI/Python clients authenticate with first-class bearer credentials.
- Bearer credentials should be opaque server-stored tokens rather than self-contained JWTs unless a concrete federation/offline-validation need appears.
- Both credential types resolve to the same internal `AuthPrincipal`.
- REST requests and WebSocket upgrades should accept the same credential model for non-browser clients.
- `lucida auth login` should open a browser, let an already-authenticated web session approve a named CLI/Python credential, and have the server mint an opaque bearer token with expiry/revocation metadata.
- The CLI should store the token in the OS keychain when available, with a `0600` config-file fallback for dev/headless environments.
- Python should be able to reuse the same stored credential or accept `LUCIDA_TOKEN` for explicit automation.
- The CLI/Python auth flow should not copy Google tokens, refresh tokens, or browser cookies into non-browser clients.
- V1 bearer tokens should be user-equivalent credentials with name, expiry, revocation, created/last-used metadata, and audit logging.
- Do not add granular token scopes in v1; authorization continues to flow through workspace roles and admin checks.
- Scoped tokens and service-account tokens are later PRD material if automation workflows require them.

### `workspace`

Purpose: make the durable collaboration container discoverable.

Current backend support:

- list active workspaces
- list archived workspaces
- create
- open/info
- rename
- pin/unpin
- archive/restore
- REST routes under `/api/workspaces/*`

Expected surface:

- `workspace list`
- `workspace list --archived`
- `workspace create [name]`
- `workspace info <id-or-name>`
- `workspace open <id-or-name>`
- `workspace rename <id-or-name> <name>`
- `workspace pin <id-or-name>`
- `workspace unpin <id-or-name>`
- `workspace archive <id-or-name>`
- `workspace restore <id-or-name>`
- `workspace use <id-or-name>` to set the persistent default workspace

Notes:

- This is the core discoverability gap.
- Workspace name resolution is useful but must handle ambiguity explicitly.
- Workspaces should be resolved by opaque ID underneath.

Open issue tie-in:

- Recast #739 as the parent issue for workspace discovery and targeting.

### `workspace share`

Purpose: manage workspace access policy.

Current backend support:

- link access: restricted vs anyone-with-link
- link role: viewer/editor
- add/update/remove members
- member roles: viewer/editor/owner

Expected surface:

- `workspace share show <workspace>`
- `workspace share link <workspace> --access restricted|anyone-with-link --role viewer|editor`
- `workspace member add <workspace> <email> --role viewer|editor|owner`
- `workspace member set-role <workspace> <email> --role ...`
- `workspace member remove <workspace> <email>`

Notes:

- Valuable, but not first slice.
- Requires auth/session support to matter.

### `dataset`

Purpose: open, list, inspect, and remove datasets inside a workspace.

Current support:

- GUI URL field and local file browser.
- WebSocket `open_remote_dataset`.
- CLI branch has `open <url>` waiting for `DatasetOpened`.
- Shared document command exists for remove dataset.
- Server browse endpoint exists at `/api/browse`.

Expected surface:

- `dataset browse [path]`
- `dataset open <path-or-url> --workspace <workspace>`
- `dataset list --workspace <workspace>`
- `dataset info <dataset> --workspace <workspace>`
- `dataset remove <dataset> --workspace <workspace>`

Notes:

- Opening a dataset should work from a workspace noun, not a raw WebSocket URL.
- Dataset IDs in workspace sessions are workspace-local `wds-*` IDs.
- Dataset source URLs should not leak into saved views or viewer-facing links.

### `layer`

Purpose: local per-client dataset display state.

Current support:

- GUI layer visibility, opacity, contrast/gamma, colormap, blend mode, render mode, detail override, order, selected layer.
- Protocol has `ViewportCommand` variants for dataset and display state.

Expected surface:

- `layer list --workspace <workspace>`
- `layer show/hide <dataset>`
- `layer opacity <dataset> <value>`
- `layer contrast <dataset> --channel <c> --min ... --max ...`
- `layer gamma <dataset> --channel <c> <value>`
- `layer colormap <dataset> --channel <c> <name>`
- `layer blend-mode <dataset> alpha|additive|max`
- `layer render-mode <dataset> translucent|max_intensity`
- `layer detail <dataset> highest|<level>`
- `layer move <dataset> up|down|top|bottom`

Notes:

- These are local/presence changes, not shared workspace document changes.
- Good Python target for reproducible display presets.

### `channel`

Purpose: multichannel-specific local display state.

Current support:

- GUI multichannel toggle.
- Channel visibility/colormap/contrast/gamma/channel blend.
- Protocol has `SetMultiChannel`, `SetChannel*`, and channel blend.

Expected surface:

- `channel mode single|multi`
- `channel list <dataset>`
- `channel show/hide <dataset> <channel>`
- `channel colormap <dataset> <channel> <name>`
- `channel contrast <dataset> <channel> --min ... --max ...`
- `channel gamma <dataset> <channel> <value>`
- `channel blend <dataset> alpha|additive|max`

Notes:

- Could also be nested under `layer channel`; PRD should pick one shape.

### `view` / `camera`

Purpose: local viewport and camera control.

Current support:

- GUI slice/volume navigation, pan/zoom/rotate/fly, z/t/c sliders, plate well click, minimap.
- CLI has some flat commands.
- Python has local `PyScene` methods.

Expected surface:

- `view state`
- `view mode slice|arcball|fly`
- `view pan --dx ... --dy ...`
- `view zoom --factor ...`
- `view center --x ... --y ...`
- `view rotate --theta ... --phi ...`
- `view set-z <z>`
- `view set-t <t>`
- `view set-c <c>`
- `view set-z-range <start> <end>`
- `view viewport --width ... --height ...`
- `view goto-well <well-id>` once well identifiers are cleanly exposed

Notes:

- Canonical new shape should be nested under `view`; flat CLI commands can be removed in the clean cut.
- The CLI/Python must not reimplement projection/planning math. Use `lucida-core` Scene as truth.

### `layout`

Purpose: inspect and change shared active layouts.

Current support:

- GUI LayoutSwitcher.
- `RegisterLayout` and `SetActiveLayout` document commands.
- Layouts are shared document state.

Expected surface:

- `layout list <dataset> --workspace <workspace>`
- `layout active <dataset> --workspace <workspace>`
- `layout set <dataset> <layout-id> --workspace <workspace>`
- `layout register <dataset> <layout-json> --workspace <workspace>` only if there is a compelling scripted-layout use case

Notes:

- Changing active layout requires editor permission.
- Unlike most view/layer settings, active layout is shared workspace document state.

### `saved-view`

Purpose: capture, list, apply, and manage named workspace views.

Current support:

- Workspace saved-view REST API.
- GUI save/open/search/mine-only/rename/update/delete/copy-link/set-default.
- Inline `#view` and named `#b=<id>` URL model.

Expected surface:

- `saved-view list --workspace <workspace>`
- `saved-view show <id> --workspace <workspace>`
- `saved-view apply <id> --workspace <workspace>`
- `saved-view capture <name> --workspace <workspace>`
- `saved-view rename <id> <name> --workspace <workspace>`
- `saved-view update <id> --from-current --workspace <workspace>`
- `saved-view delete <id> --workspace <workspace>`
- `saved-view set-default <id> --workspace <workspace>`
- `saved-view clear-default --workspace <workspace>`
- `saved-view link <id> --workspace <workspace>`

Clean-cut note:

- Workspace saved views are the product surface.
- Global bookmarks are prior art, not a compatibility target.

### `peer` / `presence`

Purpose: inspect and control live collaboration state.

Current support:

- GUI peer list, voluntary follow, peer cursors.
- Protocol supports presence, cursor, follow, steer, dataset presence.
- CLI has `state` and `steer`.

Expected surface:

- `peer list --workspace <workspace>`
- `peer show <client-id> --workspace <workspace>`
- `peer follow <client-id> --workspace <workspace>`
- `peer unfollow --workspace <workspace>`
- `peer steer <client-id> --workspace <workspace>` only if permissions and UX are deliberate

Notes:

- Voluntary follow is the everyday surface.
- Steer/presenter-style controls should not leak in by default just because the protocol has a message.
- Existing workspace decision notes say viewer-role users should not steer others.

### `debug` / `plan`

Purpose: developer/runtime diagnostics.

Current support:

- GUI DebugPanel, debug overlays, planning config, cache dumps, active set dumps.
- CLI has `visible-chunks`.
- Server emits generated availability/status.

Expected surface:

- `debug snapshot`
- `debug visible-chunks` or `plan visible-chunks`
- `debug generated-availability`
- `debug peers`
- `debug raw-state`
- `debug planning-config get` if useful

Notes:

- Keep this bucket separate from everyday workflow.
- `visible-chunks` should move here or under `plan`; top-level `visible-chunks` is a legacy shape.
- Debug/plan surfaces should be inspection-first.
- Planning config mutation from CLI/Python is deferred until there is a concrete external workflow; otherwise it creates hard-to-reproduce session state.

### `admin`

Purpose: support and operator-only tasks.

Current support:

- server CLI `clear-proxy-cache`
- REST `/admin/clear-proxy-cache`
- REST `/admin/workspaces/*`

Expected surface:

- `admin clear-proxy-cache [--dataset <url>]`
- `admin workspace search`
- `admin workspace show`
- `admin workspace archive/restore`
- `admin workspace owner add`

Notes:

- Do not mix admin commands with normal user commands.
- Remote admin/support APIs belong under the user-facing `lucida admin ...` command.
- Local process/operator tasks that do not need a running authenticated API client stay under `lucida-server`.
- Examples: remote workspace search/owner recovery/cache clear via HTTP use `lucida admin`; local serving and direct local cache-directory operations use `lucida-server`.

## Output Modes

Default CLI output should be human-readable tables/summaries where the command is exploratory.

Every command that scripts may consume should support `--json`.

Errors should be structured enough that Python/automation can distinguish:

- server unreachable
- unauthenticated
- unauthorized
- workspace not found
- ambiguous workspace name
- archived workspace
- dataset open failed
- session disconnected
- command rejected

## Likely PRD Slices

1. Client configuration and target resolution
2. Auth/session support
3. Workspace list/create/info/open
4. Workspace-aware dataset open/list/info/remove
5. View/layer/channel command taxonomy
6. Saved-view CLI/Python surface
7. Peer/presence surface
8. Debug/admin surfaces
9. Python client parity over the same model

The exact slice order should be decided by the grilling pass. The strong prior is that target resolution + auth + workspace discovery comes before the rest.

## Resolved Grill Decisions

- The PRD should define a shared CLI/Python client model, with CLI as the first implementation target. This keeps Python from growing a second API shape while still letting implementation land through the narrower CLI path first.
- The user-facing command should make a clean cut to `lucida`, with noun subcommands such as `lucida workspace list`, `lucida dataset open`, and `lucida view set-z`. `lucida-cli` can remain a crate/package implementation detail during transition, but should not be the product command name.
- Production auth should target dual credential support: browser clients use cookie sessions, while CLI/Python use first-class bearer credentials. This should be treated as the desired architecture, not merely a concession to existing cookie-session implementation. Bearer credentials should resolve through the same `AuthPrincipal` boundary as web sessions.
- Python server-client support should be a pure-Python layer in the `lucida-py` package namespace, while Rust-backed `PyScene`/`PyStore` remain the local analysis bindings. HTTP/WebSocket/auth orchestration should not go through pyo3 by default.
- Admin operations should split by execution context: remote admin/support operations live under `lucida admin ...`; local server-process operations remain under `lucida-server`.
- Debug and planning surfaces should be read-only first. CLI/Python can inspect visible chunks, active sets, generated availability, and raw state, but should not mutate planning config until a concrete external tuning workflow appears.
- The CLI should maintain persistent defaults for server and workspace. `lucida config set server ...` and `lucida workspace use ...` establish defaults, `--server`/`--workspace` override per command, mutating commands print the resolved target unless `--quiet` is set, and `lucida status` summarizes server/auth/workspace state.
- Bearer credential provisioning should be browser-assisted: `lucida auth login` opens the browser, the authenticated web session approves a named CLI/Python credential, and the server mints an opaque token. Store it in the OS keychain when available, fall back to a `0600` config file for dev/headless use, and let Python reuse the stored credential or read `LUCIDA_TOKEN`. Do not put Google tokens or browser cookies into CLI/Python clients.
- V1 CLI/Python bearer tokens should be user-equivalent credentials, not scoped tokens. They should carry name/expiry/revocation/created/last-used/audit metadata, while authorization still uses workspace roles and admin checks. Granular scopes and service accounts are deferred.

## Remaining Design Questions

The obvious answers already assumed:

- Use workspace-first APIs.
- Make a clean cut with no legacy compatibility target.
- Use HTTP for durable/discovery APIs and WebSocket for live session APIs.
- Keep `lucida-core` Scene as the source of truth for visibility/planning math.
- Treat workspace saved views as the product surface, not global bookmarks.

The initial grilling questions are resolved. Additional questions should be added here only when they are genuinely non-obvious after code/wiki exploration.

## Related Existing Issues

- #737 `cli: cover the current viewport command surface`
- #738 `cli: support authenticated sessions for protected deployments`
- #739 `cli: add workspace-aware commands and targeting`
- #740 `cli: cover the full presence message surface`
- #741 `cli: make visible-chunks reflect the current planning pipeline`
- #742 `cli: make steer useful beyond one-shot sessions`
- #743 `cli: clean up small UX and documentation drift`

These issues should likely be reorganized under a parent CLI/Python client-surface PRD rather than implemented one-by-one in their current framing.

## Existing Issue Coverage For PRD

All seven open issues from the CLI audit should be covered by the PRD, but several should be reframed under the clean-cut `lucida` / shared CLI-Python model.

### #737 `cli: cover the current viewport command surface`

PRD coverage:

- Covered by the `view`, `camera`, `layer`, and `channel` command categories.
- The PRD should not require keeping the old flat CLI command names.
- The acceptance criteria should become "the new noun-based client model covers the useful `ViewportCommand`/display surface" rather than "add flags to the old command layout."

Specific PRD requirements to carry forward:

- fly mode / fly tick or an intentional omission
- 3D pan
- viewport resize
- z-range
- per-dataset display controls
- multi-channel controls
- channel colormap/contrast/gamma
- detail-level override
- parser and command-mapping tests

### #738 `cli: support authenticated sessions for protected deployments`

PRD coverage:

- Covered by the `auth` category and dual credential architecture.
- The issue body lists cookie import/session-cookie/bearer/device-code as alternatives; the PRD should supersede that with the resolved target: first-class opaque bearer credentials for CLI/Python.

Specific PRD requirements to carry forward:

- `lucida auth login` browser-assisted credential provisioning
- bearer token accepted by REST and WebSocket upgrades
- token storage via OS keychain with `0600` fallback
- `LUCIDA_TOKEN` support for Python/headless use
- clear unauthenticated/unauthorized errors
- docs and tests for request construction/failure handling

### #739 `cli: add workspace-aware commands and targeting`

PRD coverage:

- This should become the parent/central issue for workspace discovery and targeting, or be superseded by the PRD parent.
- Covered by `server`, `config`, `workspace`, and target-resolution requirements.

Specific PRD requirements to carry forward:

- list active/archived workspaces
- create workspace
- open/info workspace
- `workspace use`
- persistent default server/workspace
- `--server` / `--workspace` overrides
- derive workspace WebSocket URL from HTTP base URL
- `dataset open` targets a workspace without manual `/ws/workspaces/:id`
- structured errors for archived/missing/ambiguous/permission failures

### #740 `cli: cover the full presence message surface`

PRD coverage:

- Covered by `peer`, `presence`, `layer`, and `debug/plan`.
- The PRD should separate everyday collaboration commands from protocol-reference diagnostics.

Specific PRD requirements to carry forward:

- follow/unfollow
- cursor update/clear if useful for protocol testing
- dataset presence emitted after local layer/channel/display changes
- viewer-interest decision: likely diagnostic/read-only first, not arbitrary manual mutation
- message-shape tests
- document intentionally omitted presence messages

### #741 `cli: make visible-chunks reflect the current planning pipeline`

PRD coverage:

- Covered by `debug/plan`.
- The clean-cut command should likely be `lucida plan ...` or `lucida debug ...`, not top-level `visible-chunks`.

Specific PRD requirements to carry forward:

- decide whether the command is a faithful planner diagnostic or explicitly a lower-level scene diagnostic
- include dataset/member/tier information
- support multi-dataset selection
- account for per-dataset settings and multi-channel state where relevant
- document mismatches with the web TS planning pipeline
- tests for multi-dataset and tiered output

Architectural wrinkle:

- This may become a deeper question about whether more planning logic should move into shared Rust. The PRD should name that risk, but not require the refactor unless the diagnostic cannot be useful without it.

### #742 `cli: make steer useful beyond one-shot sessions`

PRD coverage:

- Covered by `peer` / `presence`, but modified by the clean-cut presenter/follow policy.
- Steer should not automatically become a normal user-facing feature just because the protocol supports it.

Specific PRD requirements to carry forward:

- decide whether presenter behavior is one-shot, long-lived session, or intentionally deferred
- if long-lived, define `present`, `watch`, or `session` style behavior
- make disconnect cleanup explicit
- account for role gating: viewer-role users should not be able to steer others
- follow/steer integration tests where feasible

Recommended PRD framing:

- Voluntary follow is in v1.
- Steer/presenter controls are either editor/admin-gated or deferred until a deliberate presenter-control design exists.

### #743 `cli: clean up small UX and documentation drift`

PRD coverage:

- Covered by the clean-cut `lucida` command model, output modes, target resolution, and docs requirements.
- Because there is no compatibility target, this should become "new UX quality bar" rather than patching every rough edge of the old command shape.

Specific PRD requirements to carry forward:

- audit command help for stale wording
- handle negative numeric arguments naturally or avoid flag shapes that cause the clap ambiguity
- README/wiki examples for common workspace-first flows
- docs synchronized with actual defaults
- parser tests for UX edge cases
- help text explains one-shot vs long-lived session behavior where relevant
