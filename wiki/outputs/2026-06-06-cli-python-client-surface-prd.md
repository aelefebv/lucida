# PRD: Shared CLI/Python Client Surface

Source grill notes: `wiki/outputs/2026-06-06-cli-python-client-surface-grill.md`
Related issues: #737, #738, #739, #740, #741, #742, #743

## Problem Statement

Lucida's web app is now workspace-first and discoverable, but the non-web client surfaces are still shaped like old protocol test harnesses. The CLI can connect to a raw WebSocket URL, print state, open a dataset, run a small set of viewport commands, and emit one-shot steer messages. Python has useful local `Scene` and `Store` bindings plus an older high-level viewer, but it does not yet reflect the current workspace/auth/client architecture.

This leaves routine workflows awkward or impossible outside the browser:

- A user cannot list or choose workspaces from the CLI.
- A user must manually construct workspace WebSocket URLs.
- Protected deployments have no first-class CLI/Python credential model.
- Dataset, layer, channel, layout, saved-view, peer, debug, and admin surfaces are either absent or exposed only through stale one-off commands.
- Python risks growing a second API shape unless the CLI and Python are designed around one shared client model.

The current issues #737-#743 capture real gaps, but implementing them one by one would patch the old CLI shape instead of producing an intuitive Lucida client. There are no active users depending on the old command contract, so this PRD intentionally makes a clean cut.

## Solution

Define a shared Lucida client model for CLI and Python, with the CLI as the first implementation target. The user-facing command becomes `lucida`, organized around noun subcommands that match the web app's mental model:

- `server` / `status` / `config`
- `auth`
- `workspace`
- `workspace share` / `workspace member`
- `dataset`
- `view` / `camera`
- `layer`
- `channel`
- `layout`
- `saved-view`
- `viewer` / `capture`
- `peer` / `presence`
- `debug` / `plan`
- `admin`

The client model has three planes:

- **HTTP control plane** for durable/discovery resources: server status, auth, workspaces, sharing, saved views, and remote admin APIs.
- **WebSocket session plane** for live workspace state: dataset open, view/camera commands, layer/channel presence, layout document commands, peer/follow/cursor, and debug/plan diagnostics.
- **Local analysis plane** for Python: Rust-backed local `Scene`/`Store` remain available, while a pure-Python server client handles HTTP/WebSocket/auth orchestration.

Authentication targets dual credential support:

- Browser/web clients continue to use httpOnly cookie sessions.
- CLI/Python clients use first-class opaque bearer credentials minted by the server.
- Both credential types resolve to the same internal `AuthPrincipal`.

The CLI supports persistent defaults for server and workspace so routine usage feels like operating a product, not scripting against endpoints:

- `lucida config set server <base-url>`
- `lucida workspace use <workspace>`
- `lucida status`
- per-command `--server` / `--workspace` overrides

Debug/plan surfaces are read-only first. Presenter/steer controls are not promoted as everyday UX unless they are explicitly role-gated or deferred into a later presenter-control design.

## User Stories

1. As a Lucida user, I want to run `lucida status`, so that I can see my configured server, auth principal, default workspace, and connection health.
2. As a Lucida user, I want to configure a default server once, so that I do not have to pass endpoint flags to every command.
3. As a Lucida user, I want to configure a default workspace once, so that routine commands target the workspace I am actively using.
4. As a Lucida user, I want every command to accept explicit server and workspace overrides, so that scripts can be precise.
5. As a Lucida user, I want mutating commands to print the resolved server/workspace target, so that I do not accidentally change the wrong workspace.
6. As a Lucida user, I want `lucida workspace list`, so that I can discover my accessible workspaces from the terminal.
7. As a Lucida user, I want pinned and recent workspaces to be visible in CLI output, so that the CLI matches the dashboard's navigational value.
8. As a Lucida user, I want to list archived workspaces when appropriate, so that lifecycle management does not require the browser.
9. As a Lucida user, I want to create a workspace from the CLI, so that I can start a workspace before opening a browser.
10. As a Lucida user, I want to inspect a workspace by ID or unambiguous name, so that I can understand its role, dataset count, default view, and archive state.
11. As a Lucida user, I want ambiguous workspace names to produce clear errors, so that the CLI never guesses the wrong workspace.
12. As a Lucida user, I want workspace-targeted dataset open, so that I can load data without manually constructing `/ws/workspaces/:id`.
13. As a Lucida user, I want to open a server-local path or supported URL from the CLI, so that the browser immediately reflects the loaded dataset.
14. As a Lucida user, I want `dataset list` and `dataset info`, so that I can inspect loaded workspace datasets without dumping raw document JSON.
15. As a Lucida editor, I want to remove a dataset from a workspace from the CLI, so that scripted cleanup is possible.
16. As a Lucida user, I want to browse server-visible filesystem paths where allowed, so that local development flows do not require typing long paths.
17. As a Lucida user, I want clear dataset-open failure errors, so that unsupported paths, permissions, and import failures are distinguishable.
18. As a Lucida user, I want `view` commands for pan, zoom, center, mode, z/t/c, z-range, 3D rotation, 3D pan, fly mode, and viewport size, so that terminal workflows can reach the same state as the GUI.
19. As a Lucida user, I want view commands to use the same scene truth as the web app, so that CLI/Python math does not drift.
20. As a Lucida user, I want layer commands for visibility, opacity, contrast, gamma, colormap, blend mode, render mode, detail override, and order, so that display presets can be scripted.
21. As a Lucida user, I want channel commands for multichannel mode, channel visibility, channel colormap, channel contrast/gamma, and channel blending, so that multichannel views are reproducible from scripts.
22. As a Lucida collaborator, I want local layer/channel changes to emit dataset presence, so that peers and followers see the intended display state.
23. As a Lucida editor, I want to list layouts and set the active layout, so that plate spatial context can be changed from CLI/Python when appropriate.
24. As a Lucida viewer, I want layout commands to respect role permissions, so that shared document state is not mutated by users without editor access.
25. As a Lucida user, I want to list workspace saved views, so that named workspace states are discoverable outside the browser.
26. As a Lucida user, I want to apply a saved view from the CLI, so that I can reproduce browser state from terminal workflows.
27. As a Lucida editor, I want to capture, rename, update, delete, and set default saved views, so that the CLI can manage the same saved-view surface as the GUI.
28. As a Lucida user, I want saved-view links generated by the CLI to use workspace routes, so that links do not leak source URLs or depend on global bookmarks.
29. As a Lucida collaborator, I want to list live peers, so that I can see who else is connected.
30. As a Lucida collaborator, I want to follow and unfollow peers voluntarily, so that terminal and browser clients can coordinate.
31. As a Lucida tester, I want cursor update/clear commands where useful, so that presence behavior can be exercised without manual browser flows.
32. As a Lucida tester, I want a protocol-reference path for presence messages, so that collaboration bugs can be reproduced reliably.
33. As a Lucida user, I do not want steer/presenter controls to appear as casual default commands, so that users are not surprised by remote-control behavior.
34. As a Lucida editor or admin, I want any future presenter control to be explicitly role-gated, so that viewer-role users cannot force other clients to follow them.
35. As a Lucida developer, I want read-only debug/plan commands, so that I can inspect visible chunks, active sets, generated availability, and raw session state.
36. As a Lucida developer, I want `visible-chunks` reframed under `plan` or `debug`, so that the command is honest about whether it mirrors the web planner or only the lower-level scene query.
37. As a Lucida developer, I want planning diagnostics to include dataset, member, tier, and multichannel context where possible, so that debug output reflects current rendering architecture.
38. As a Lucida developer, I want any mismatch between CLI diagnostics and the web TS planner documented, so that debug output is not over-interpreted.
39. As a Lucida admin, I want remote admin commands under `lucida admin`, so that support workflows can operate against a running server.
40. As a Lucida operator, I want local server process tasks to remain under `lucida-server`, so that local process management is not confused with remote authenticated APIs.
41. As a protected-deployment user, I want `lucida auth login`, so that CLI/Python can authenticate without copying browser cookies or Google tokens.
42. As a protected-deployment user, I want the browser to approve a named CLI/Python credential, so that credential creation is deliberate and auditable.
43. As a protected-deployment user, I want bearer credentials to be revocable and expiring, so that losing a laptop or token does not create permanent access.
44. As a Python user, I want `LUCIDA_TOKEN` support, so that headless jobs can authenticate explicitly.
45. As a Python user, I want Python to reuse the same conceptual client model as the CLI, so that commands and scripts are transferable.
46. As a Python user, I want the server client to be pure Python where practical, so that HTTP/WebSocket/auth behavior can evolve without pyo3 friction.
47. As a Python analysis user, I want local `Scene` and `Store` bindings to remain available, so that offline/local viewport and chunk workflows keep working.
48. As a script author, I want `--json` on scriptable commands, so that automation does not parse human tables.
49. As a human CLI user, I want concise tables by default, so that discovery commands are easy to scan.
50. As a script author, I want structured errors for unauthenticated, unauthorized, missing workspace, ambiguous workspace, archived workspace, dataset open failure, disconnected session, and rejected commands, so that scripts can recover correctly.
51. As a maintainer, I want parser and command-mapping tests for the new CLI surface, so that command drift is caught early.
52. As a maintainer, I want README/wiki examples for workspace-first CLI flows, so that the terminal UX remains discoverable.
53. As a maintainer, I want the old flat command taxonomy treated as non-contractual, so that implementation can optimize for the new architecture.
54. As a maintainer, I want #737-#743 covered by one parent PRD, so that the CLI work lands as a coherent product surface rather than a sequence of disconnected patches.
55. As a headless CLI user, I want the CLI to maintain a current workspace view across commands, so that `view pan`, `view zoom`, layer changes, and later captures build on the same state instead of starting from a fresh transient presence each time.
56. As a headless CLI user, I want to inspect my current viewer state, so that I can understand the camera, slice, display, layer order, and selected viewer profile without opening the GUI.
57. As a headless CLI user, I want to capture a screenshot from my current CLI-controlled view, so that I can iteratively pan/zoom/check results from a terminal workflow.
58. As a headless CLI user, I want an overview capture mode, so that I can recover when I am spatially far from the data or unsure where the current viewport is.
59. As a script author, I want separate named viewer profiles where needed, so that automation does not stomp my personal last view state and concurrent scripts can be isolated.
60. As a protected-deployment user, I want screenshot capture to authenticate without putting bearer tokens, cookies, source URLs, or saved-view payloads in shareable URLs.
61. As a maintainer, I want headless visual capture to reuse the web renderer for v1, so that CLI screenshots match what the GUI would show and do not require a second renderer implementation.

## Implementation Decisions

- The PRD defines a shared CLI/Python client model, with the CLI as the first implementation target.
- The user-facing command is `lucida`, not `lucida-cli`. Existing crate/package naming can remain an implementation detail during migration, but the product command name is `lucida`.
- The current flat CLI shape is not a product requirement. The product contract is the noun-based command tree, and old flat aliases should not be retained as user-facing paths.
- The client model uses an HTTP control plane for discovery/durable resources and a WebSocket session plane for live workspace interaction.
- Target resolution is a deep module: it consumes configured defaults, per-command overrides, workspace IDs/names, and base URLs, then produces authenticated HTTP endpoints and workspace WebSocket URLs.
- Client configuration stores at least default server and default workspace. It should be inspectable and overrideable.
- The CLI prints resolved mutation targets unless `--quiet` is set.
- The HTTP client is a deep module: it handles base URL normalization, auth headers, JSON request/response decoding, status-to-domain-error mapping, and `--json` output inputs.
- The WebSocket session client is a deep module: it connects to a workspace, ingests snapshots, sends commands/presence messages, waits for specific outcomes such as dataset-open completion, and reports disconnects cleanly.
- The command mapper is a deep module: noun commands map to `DocumentCommand`, `ViewportCommand`, `ClientMessage`, or HTTP requests in one tested place.
- Browser clients authenticate with httpOnly cookie sessions.
- CLI/Python clients authenticate with first-class opaque bearer credentials.
- Bearer credentials resolve through the same internal `AuthPrincipal` boundary as browser sessions.
- Bearer credentials are server-stored opaque tokens, not self-contained JWTs, unless a later offline-validation or federation need appears.
- V1 bearer tokens are user-equivalent credentials. Authorization continues through workspace roles and admin checks.
- V1 bearer tokens carry name, expiry, revocation state, created/last-used metadata, and audit logging.
- Granular token scopes and service accounts are out of scope for v1.
- `lucida auth login` is browser-assisted: the CLI opens a browser, the authenticated web session approves a named CLI/Python credential, and the server mints the token.
- The CLI stores bearer credentials in the OS keychain when available, with a `0600` config-file fallback for dev/headless environments.
- Python can reuse the stored credential or read `LUCIDA_TOKEN`.
- The CLI/Python auth flow must not copy Google tokens, refresh tokens, or browser cookies into non-browser clients.
- Workspace APIs are the primary discovery spine. `workspace list/create/info/open/use/pin/unpin/archive/restore` are first-class.
- Workspace names can be accepted as user input only when they resolve unambiguously. Opaque workspace IDs remain the durable identity.
- Dataset commands target workspaces by default and never require the user to hand-construct `/ws/workspaces/:id`.
- Dataset IDs exposed in workspace sessions are workspace-local IDs. Source URLs are not saved-view identity and should not leak into workspace links.
- View/layer/channel commands are local/presence state unless they explicitly map to document state.
- CLI view/layer/channel commands should gain a durable private headless viewer state. That state is not presence: it excludes cursor, follow target, connected-client identity, and other live-only fields.
- Durable headless viewer state should be private per user, workspace, and viewer profile. A default profile supports normal interactive CLI usage; an explicit profile selector supports automation and concurrent scripts.
- Durable headless viewer state should reuse the `SavedView` payload shape where practical: camera, view, display, dataset order, dataset settings, active layouts, and client-only preferences keyed by `workspace_dataset_id`, with `datasets` cleared for workspace mode.
- CLI view/layer/channel commands should read-modify-write the selected durable viewer state when no explicit peer/snapshot source is requested, and may also broadcast an ephemeral presence update while connected so live browser clients can observe the change.
- Initial durable viewer state should be seedable from an explicit saved view, an explicit peer, the workspace default saved view, or workspace document defaults. The CLI should report which seed source was used when initializing a missing profile.
- Active layout is shared workspace document state and requires editor-or-better permission.
- Workspace saved views are the product surface. Global bookmarks are prior art, not a migration target.
- Saved-view capture from CLI should be able to capture the selected durable viewer profile directly, while retaining explicit peer capture for browser/live-session workflows.
- Headless visual capture should reuse the web renderer as the v1 rendering oracle. A browser/renderer bootstrap path may be CLI-launched headless Chrome or an equivalent render helper, but it must render the same workspace/view state as the GUI rather than duplicating projection/rendering logic in the CLI.
- Protected headless visual capture needs an auth bridge that does not expose durable credentials in URLs. Acceptable approaches include a short-lived render session/cookie minted from the CLI bearer credential or authenticated browser context headers; bearer tokens, browser cookies, and source URLs must not be serialized into screenshot URLs.
- Peer follow is a v1 collaboration surface. Steer/presenter behavior is either role-gated or deferred until a deliberate presenter-control design exists.
- Debug and planning surfaces are read-only first. CLI/Python can inspect state, but should not mutate planning config in v1.
- Planning diagnostics must use shared `lucida-core` scene truth where applicable and must not reimplement projection or visibility math. Chosen to honor [[principles/planning#5-wasm-owns-truth-planning-consumes-a-snapshot]].
- If the current web planner cannot be faithfully represented from shared Rust state, the PRD allows the diagnostic to be labeled as a lower-level scene diagnostic rather than silently claiming web-planner parity.
- Python server-client support is a pure-Python layer in the `lucida-py` package namespace.
- Rust-backed `PyScene`/`PyStore` remain the local analysis bindings.
- Remote admin/support APIs live under `lucida admin`. Local server-process operations remain under `lucida-server`.
- Every scriptable command supports `--json`; exploratory commands default to human-readable summaries.
- Errors are normalized into domain categories: unreachable server, unauthenticated, unauthorized, missing resource, ambiguous name, archived workspace, dataset-open failure, session disconnect, and rejected command.
- #737 is covered by the `view`, `camera`, `layer`, and `channel` command categories.
- #738 is covered by bearer credential auth.
- #739 is covered by target resolution and workspace commands, and should become the parent discovery spine or be superseded by this PRD.
- #740 is covered by peer/presence, layer dataset-presence, and protocol diagnostics.
- #741 is covered by `debug`/`plan`.
- #742 is covered by follow/presenter policy, with steer gated or deferred.
- #743 is covered by the new `lucida` UX quality bar and documentation requirements.

## Testing Decisions

A good test for this PRD checks externally observable behavior: command parsing, resolved targets, request construction, protocol message shape, authorization outcomes, printed output shape, and Python API behavior. Tests should not assert incidental internal struct layout when the observable client contract is what matters.

- Target resolution tests cover configured defaults, per-command overrides, HTTP-to-WebSocket derivation, workspace ID/name resolution, missing defaults, ambiguous names, archived workspaces, and raw override escape hatches where retained.
- CLI parser tests cover every noun command and every UX edge case carried from #743, including negative numeric values or command shapes that avoid the clap ambiguity.
- CLI command-mapping tests assert that `view`, `layer`, `channel`, `layout`, `peer`, and dataset commands produce the intended HTTP requests or protocol messages.
- Auth server tests cover token creation, token lookup, expiry, revocation, last-used updates, audit events, and `AuthPrincipal` equivalence between cookie and bearer credentials.
- Auth client tests cover credential storage selection, `LUCIDA_TOKEN`, missing token, revoked token, expired token, and request header construction.
- WebSocket auth tests cover bearer-authenticated workspace upgrades and unauthenticated/unauthorized failures.
- Workspace command tests cover list/create/info/use/pin/archive/restore output, ID/name resolution, and structured errors.
- Dataset command tests cover workspace-targeted open success, open failure, list/info/remove, and waiting for the correct `DatasetOpened` or failure event.
- View/layer/channel tests cover parser shape and protocol message shape for the `ViewportCommand` variants in #737.
- Presence tests cover follow/unfollow, cursor update/clear if included, dataset presence emission after display changes, and intentionally omitted presence messages.
- Saved-view tests cover list/show/apply/capture/update/delete/default/link behavior and role failures.
- Headless viewer-state tests cover profile initialization, read-modify-write behavior across successive CLI commands, saved-view-shaped serialization with source URLs cleared, explicit seed selection, and absence of cursor/follow/client identity from durable state.
- Headless visual-capture tests cover screenshot command request construction, render-auth bootstrap without token-in-URL leakage, renderer-ready timeout/error handling, output file creation, and a smoke-level pixel/nonblank assertion against a loaded workspace.
- Debug/plan tests cover multi-dataset and tiered output shape where available, plus explicit labeling when output is lower-level scene diagnostics.
- Admin tests cover remote admin request construction and permission failures.
- Python tests cover the pure-Python server client resource model, auth token sourcing, workspace/dataset/view basics, and parity with CLI naming where practical.
- Documentation checks should ensure the wiki and README examples use the new workspace-first `lucida` command shape.

Prior art:

- Existing workspace route tests cover role checks, workspace lifecycle, saved views, archive/restore, and live session restore.
- Existing auth tests cover cookie sessions, logout, dev auth, audit events, and `AuthPrincipal` extraction.
- Existing CLI tests cover parser behavior and dataset-open event classification.
- Existing Python binding tests/examples cover local `Scene`/`Store` usage and should remain separate from server-client tests.

## Out of Scope

- Maintaining the old flat `lucida-cli` command surface.
- Preserving the old global viewer/session model as a first-class target.
- Migrating or promoting global bookmarks.
- Persisting presence itself, including connected client IDs, cursors, follow relationships, or peer liveness.
- Implementing a second native CLI renderer in v1. Headless capture should reuse the web renderer until there is a deliberate rendering-runtime PRD.
- Copying browser cookies, Google ID tokens, Google refresh tokens, or OAuth provider credentials into CLI/Python clients.
- Granular token scopes, service-account tokens, and offline bearer-token validation.
- Full presenter-control design beyond voluntary follow and clearly gated/deferred steer behavior.
- External planning-config mutation from CLI/Python.
- Making `debug/plan` perfectly mirror the web planner if that requires a larger planning migration; the command may be explicitly scoped as lower-level diagnostics.
- A complete admin dashboard. This PRD covers remote admin command surfaces only.
- Rewriting local `PyScene`/`PyStore` bindings.
- A broad stable SDK guarantee for every internal protocol message. The product API is the shared client model, not raw protocol shapes.

## Further Notes

- This PRD should become the umbrella issue for #737-#743. Those issues can either remain as child slices or be closed/superseded as the PRD is broken into implementation issues.
- The clean-cut policy is intentional because there are no active users of the old CLI contract.
- The likely implementation order is: target resolution/config, auth tokens, workspace discovery, workspace-targeted dataset operations, view/layer/channel command mapping, saved views, headless viewer state/capture, peer/presence, debug/admin, then Python parity over the same model.
- The WebSocket and HTTP clients should share auth and target-resolution code so behavior does not drift.
- Python should present resource objects and methods that mirror CLI nouns, not a separate vocabulary.
- If the user opens a browser alongside CLI commands, the browser should visibly reflect workspace session changes, especially dataset open and shared document mutations.
- Headless viewer state is the CLI/Python equivalent of "my current tab view," while saved views remain the explicit durable/shareable snapshot mechanism.
