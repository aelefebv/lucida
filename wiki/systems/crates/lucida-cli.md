---
created: 2026-04-18
modified: 2026-06-07
---

# lucida-cli

The Rust crate that builds Lucida's product CLI binary, `lucida`. The crate name remains `lucida-cli` as a Cargo workspace identity, but the user-facing command is no longer `lucida-cli`.

The CLI is a workspace-first client surface that mirrors the web app's nouns. It exposes server/config/auth discovery, workspace selection, dataset open/list/info/remove, view/camera/layer/channel mutation, layout and saved-view management, durable headless viewer profiles, peer diagnostics, plan/debug diagnostics, and remote admin support.

## Why a CLI client

Three concrete uses:

1. **Discoverability outside the browser** — inspect configured server/auth/workspace state and list product resources from the terminal.
2. **Headless scripting** — reproduce dataset opens, view state, layer/channel settings, saved views, and diagnostics.
3. **Multi-user testing** — start a CLI session alongside browser tabs and verify workspace/session behavior end-to-end.

The CLI should remain a reference client for the HTTP control plane and WebSocket session plane, but the product contract is the noun-based command tree.

## Subcommands

Current product commands:

- `lucida status` — summarize effective server, health/readiness/version, and auth status.
- `lucida server status` — same server-oriented health check surface.
- `lucida server version` — print server version.
- `lucida auth login` — start browser-assisted CLI bearer credential provisioning.
- `lucida auth whoami` — print the authenticated principal using `LUCIDA_TOKEN` or the stored token.
- `lucida auth logout` — revoke the current server-side bearer token and remove the local token; `--local-only` skips server revocation.
- `lucida workspace list [--archived]` — list active or archived workspaces visible to the current principal.
- `lucida workspace create [name]` — create a workspace.
- `lucida workspace info [id-or-name] [--archived]` — show workspace details and derived target URLs.
- `lucida workspace use <id-or-name>` — persist the default workspace.
- `lucida workspace open [id-or-name] [--no-browser]` — mark the workspace as opened and print/open `/w/:workspace_id`.
- `lucida workspace pin|unpin [id-or-name]` — update the current user's personal workspace pin state.
- `lucida workspace archive|restore [id-or-name]` — archive or restore an owned workspace.
- `lucida workspace share show [id-or-name]` — show link sharing and explicit members.
- `lucida workspace share link <off|viewer|editor> [id-or-name]` — disable link sharing or grant viewer/editor link access.
- `lucida workspace member list [id-or-name]` — list explicit workspace members.
- `lucida workspace member add <email> <viewer|editor|owner> [id-or-name] [--display-name <name>]` — add or update a member.
- `lucida workspace member set-role <email> <viewer|editor|owner> [id-or-name]` — update a member role.
- `lucida workspace member remove <email> [id-or-name]` — remove an explicit member.
- `lucida dataset browse [path]` — browse server-visible filesystem roots and directories.
- `lucida dataset open <path-or-url>` — open a dataset in the selected workspace and wait for completion.
- `lucida dataset list` — list loaded datasets in the selected workspace.
- `lucida dataset info <dataset>` — show manifest/image/channel/layout summary for a loaded dataset.
- `lucida dataset remove <dataset>` — remove a loaded workspace dataset.
- `lucida view pan|zoom|set-zoom|center|slice|z-range|viewport-size` — update the selected durable viewer profile's 2D slice view.
- `lucida camera mode|rotate|pan|zoom|fly-tick` — update slice/arcball/fly camera state.
- `lucida layer list|order|show|hide|opacity|contrast|gamma|colormap|blend-mode|render-mode|detail-level` — inspect or update dataset display state.
- `lucida channel mode|show|hide|colormap|contrast|gamma|blend-mode` — update multichannel display state.
- `lucida viewer state [--from-peer <client-id>]` — inspect a durable headless viewer profile or a live peer's current view source.
- `lucida viewer link` — print a browser URL that opens the durable viewer profile.
- `lucida viewer adopt --from-peer <client-id>` — copy a live peer's current view into the selected durable viewer profile.
- `lucida viewer screenshot|overview [--from-peer <client-id>] <path>` — render a durable headless viewer profile or a live peer's current view through the web renderer.
- `lucida layout list|active|set` — inspect or change shared dataset layouts.
- `lucida saved-view list|show|apply|capture|rename|update|delete|set-default|clear-default|link` — manage workspace saved views.
- `lucida peer list` — list live workspace clients from the WebSocket snapshot, including follow state and compact presence summaries.
- `lucida peer follow <client-id>` — start a long-lived CLI follow session against a live client. The command stays connected until Ctrl-C, then clears follow state before exiting.
- `lucida peer cursor set|clear` — explicit diagnostic/test cursor presence updates.
- `lucida plan visible-chunks [dataset]` — inspect lower-level `lucida-core` scene chunk diagnostics for the selected viewer profile or explicit peer.
- `lucida debug state` — print read-only workspace snapshot, selected viewer state, peer, dataset, active-member, and generated-availability diagnostics.
- `lucida admin workspace search [query]` — search remote admin workspace metadata by id, name, creator, or member email.
- `lucida admin workspace info|archive|restore <workspace-id>` — inspect or mutate one workspace through the authenticated remote admin API.
- `lucida admin workspace owner add|promote <workspace-id> <email>` — add or promote a workspace owner through the remote admin API.
- `lucida admin clear-proxy-cache [--dataset <url>]` — clear the remote server proxy cache via `/admin/clear-proxy-cache`.
- `lucida config set server <base-url>` — persist the default server.
- `lucida config get server` — print the effective default server.
- `lucida config get workspace` — print the effective default workspace.
- `lucida config path` — print the config file path.

Global visible flags:

- `--server <base-url>` — override the configured/default server for one invocation.
- `--workspace <id-or-name>` — override the configured/default workspace for one invocation.
- `--json` — emit stable machine-readable JSON.
- `--quiet` — suppress success output.

## Browser verification flow

Use `lucida workspace open [workspace]` to print/open the browser route for the selected workspace. Keep that browser tab open, then run `lucida dataset open <path-or-url>`. The CLI targets the same `/ws/workspaces/:id` session and waits for the request-correlated dataset-open result, so the browser should show the new dataset without manually constructing WebSocket URLs. The same visible verification path applies to shared document mutations such as layout changes and saved-view apply.

For headless profile verification, `lucida viewer screenshot <path>` and `lucida viewer overview <path>` drive the web renderer through Chrome/Chromium. Capture waits for the web app's explicit render-ready signal and validates that CDP returned PNG bytes before writing the file. To capture a live browser peer instead of the durable profile, use `lucida peer list` to find its client id, then pass `--from-peer <client-id>` to `viewer state`, `viewer screenshot`, or `viewer overview`. Use `viewer adopt --from-peer <client-id>` when the peer's current view should become the durable headless profile state.

## Smoke workflows

Run `scripts/smoke_lucida_cli.sh` from the repo root against an already-running `lucida-server` to exercise the common CLI client workflow. It uses a temp `LUCIDA_CONFIG_PATH`, creates a throwaway workspace, opens `LUCIDA_SMOKE_DATASET`, runs workspace/dataset/view/layer/channel/debug/plan commands, and validates screenshot/overview PNGs with `scripts/assert_png_nonblank.py`.

Required inputs:

- `LUCIDA_SMOKE_SERVER` — server base URL; defaults to `http://127.0.0.1:9876`.
- `LUCIDA_SMOKE_DATASET` — server-visible OME-Zarr path or URL. On Austin's laptop the script falls back to the CPPX test dataset if present.

Useful overrides:

- `LUCIDA_SMOKE_CLI="target/debug/lucida"` — use a prebuilt binary instead of `cargo run -p lucida-cli --`.
- `LUCIDA_SMOKE_OUTPUT_DIR=/path/to/artifacts` — keep JSON and PNG artifacts somewhere specific.
- `LUCIDA_SMOKE_CAPTURE=0` — skip screenshot/overview when Chrome/Chromium is unavailable.

The matching Python smoke entry point is `uv run --project lucida-py python scripts/smoke_python_client.py`. It creates a throwaway workspace, opens the same dataset, applies view/layer/channel changes through `LucidaClient`, and writes a structured summary artifact.

## Interactions

- Config is local JSON under `$LUCIDA_CONFIG_PATH`, `$XDG_CONFIG_HOME/lucida/config.json`, or `~/.config/lucida/config.json`.
- The default server is global, while default workspace and config-file bearer-token fallback are scoped under `servers[normalized_server_url]`.
- Bearer credentials are sourced from `LUCIDA_TOKEN` first, then macOS Keychain when available, then the server-scoped local config fallback. The file fallback is written with `0600` permissions on Unix.
- HTTP status checks call the same public/protected server endpoints the web app uses: `/healthz`, `/readyz`, `/version`, and `/auth/whoami`.
- Remote admin commands call `/admin/*` APIs with bearer auth and label JSON/human output as `remote_admin`, keeping them distinct from local `lucida-server` process operations.
- Future noun commands should reuse the same config, output, error, target-resolution, HTTP, and WebSocket modules instead of adding one-off flag parsing.

## Invariants

- **The product command is `lucida`.** `lucida-cli` is the crate/package implementation detail.
- **The old flat command taxonomy is not a compatibility contract.** Flat `open`, root `visible-chunks`, `--steer`, `--peer`, and `config set workspace` are intentionally rejected in parser tests.
- **Server input is a base HTTP URL.** Commands that need a session derive WebSocket URLs internally from the base server target.
- **Workspace defaults are server-scoped.** Switching `--server` must not silently reuse another server's selected workspace or config-file token.
- **Every scriptable command needs `--json`.** Human output can be concise, but automation should not parse tables.
- **Errors are categorized.** The foundation defines stable categories such as `unreachable_server`, `unauthenticated`, `unauthorized`, `missing_resource`, `ambiguous_name`, `archived_workspace`, `dataset_open_failure`, `session_disconnect`, and `rejected_command`.
- **Most commands are one-shot.** `peer follow` is intentionally long-lived because follow state is tied to a live WebSocket client. Other commands should remain one-shot unless a later slice explicitly designs another long-lived mode.
- **Presence is ephemeral.** `peer` diagnostics operate on live WebSocket clients; durable headless viewer profiles store view state, not client id, cursor, follow target, or peer liveness. `peer follow` stays connected precisely because a disconnected CLI client cannot keep following anyone. Copying live peer state into a durable profile is explicit via `viewer adopt --from-peer`; screenshot/overview can render a peer directly via `--from-peer` without persisting it.
- **Plan diagnostics are labeled by parity.** `plan visible-chunks` is a lower-level scene diagnostic, not a web-planner-equivalent dump of lanes, carry-forward state, CPU-cache filtering, minimap, or generated-coarse tier selection.

## Gotchas

- **Keychain is opportunistic.** `lucida auth login` stores the approved token in macOS Keychain when available. If Keychain rejects the write or the platform has no supported keychain integration, the CLI falls back to the `0600` config file.
- **No retry loop yet.** The foundation status/config commands make single HTTP requests. Later WebSocket session commands should keep failures explicit unless a long-lived session mode is designed.
- **`peer list` creates a temporary peer.** Opening the diagnostic WebSocket gives the CLI its own client id, so the listing includes the CLI client alongside browser or other live clients.
- **Admin workspace commands are id-based.** Search can discover ids, but `admin workspace info/archive/restore/owner` intentionally do not reuse member-scoped workspace name resolution.
- **Negative numeric flags use clap's accepted forms.** The parser accepts `--flag=-2` and the relevant commands enable hyphen values where practical; scripts should prefer equals-style values for clarity.
- **Viewer screenshots require Chrome/Chromium.** Set `LUCIDA_BROWSER` when auto-discovery cannot find a browser binary; a render-ready timeout means the page never reported a rendered Lucida frame for a loaded dataset.
