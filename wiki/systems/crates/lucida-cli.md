---
created: 2026-04-18
modified: 2026-06-07
---

# lucida-cli

The Rust crate that builds Lucida's product CLI binary, `lucida`. The crate name remains `lucida-cli` as a Cargo workspace identity, but the user-facing command is no longer `lucida-cli`.

The CLI is moving to a workspace-first client surface that mirrors the web app's nouns. The first foundation slices expose `lucida status`, `lucida server ...`, `lucida auth ...`, and `lucida config ...`; later slices add workspace, dataset, view, layer, channel, layout, saved-view, peer, debug/plan, admin, and Python parity.

## Why a CLI client

Three concrete uses:

1. **Discoverability outside the browser** — inspect configured server/auth/workspace state and list product resources from the terminal.
2. **Headless scripting** — reproduce dataset opens, view state, layer/channel settings, saved views, and diagnostics.
3. **Multi-user testing** — start a CLI session alongside browser tabs and verify workspace/session behavior end-to-end.

The CLI should remain a reference client for the HTTP control plane and WebSocket session plane, but the product contract is the noun-based command tree.

## Subcommands

Visible foundation commands:

- `lucida status` — summarize effective server, health/readiness/version, and auth status.
- `lucida server status` — same server-oriented health check surface.
- `lucida server version` — print server version.
- `lucida auth login` — start browser-assisted CLI bearer credential provisioning.
- `lucida auth whoami` — print the authenticated principal using `LUCIDA_TOKEN` or the stored token.
- `lucida auth logout` — revoke the current server-side bearer token and remove the local token; `--local-only` skips server revocation.
- `lucida config set server <base-url>` — persist the default server.
- `lucida config get server` — print the effective default server.
- `lucida config path` — print the config file path.
- `lucida peer list` — list live workspace clients from the WebSocket snapshot, including follow state and compact presence summaries.
- `lucida peer follow <client-id>` / `lucida peer unfollow` — voluntarily follow or stop following a live client using the same protocol path as the web app.
- `lucida peer cursor set|clear` — explicit diagnostic/test cursor presence updates.
- `lucida plan visible-chunks [dataset]` — inspect lower-level `lucida-core` scene chunk diagnostics for the selected viewer profile or explicit peer.
- `lucida debug state` — print read-only workspace snapshot, selected viewer state, peer, dataset, active-member, and generated-availability diagnostics.

Global visible flags:

- `--server <base-url>` — override the configured/default server for one invocation.
- `--json` — emit stable machine-readable JSON.
- `--quiet` — suppress success output.

## Interactions

- Config is local JSON under `$LUCIDA_CONFIG_PATH`, `$XDG_CONFIG_HOME/lucida/config.json`, or `~/.config/lucida/config.json`.
- Bearer credentials are sourced from `LUCIDA_TOKEN` first, then macOS Keychain when available, then the local config file. The file fallback is written with `0600` permissions on Unix.
- HTTP status checks call the same public/protected server endpoints the web app uses: `/healthz`, `/readyz`, `/version`, and `/auth/whoami`.
- Future noun commands should reuse the same config, output, error, target-resolution, HTTP, and WebSocket modules instead of adding one-off flag parsing.

## Invariants

- **The product command is `lucida`.** `lucida-cli` is the crate/package implementation detail.
- **Server input is a base HTTP URL.** Commands that need a session derive WebSocket URLs internally from the base server target.
- **Every scriptable command needs `--json`.** Human output can be concise, but automation should not parse tables.
- **Errors are categorized.** The foundation defines stable categories such as `unreachable_server`, `unauthenticated`, `unauthorized`, `missing_resource`, `ambiguous_name`, `archived_workspace`, `dataset_open_failure`, `session_disconnect`, and `rejected_command`.
- **One command per invocation.** The CLI remains a one-shot client unless a later slice explicitly introduces a long-lived mode.
- **Presence is ephemeral.** `peer` diagnostics operate on live WebSocket clients; durable headless viewer profiles store view state, not client id, cursor, follow target, or peer liveness.
- **Plan diagnostics are labeled by parity.** `plan visible-chunks` is a lower-level scene diagnostic, not a web-planner-equivalent dump of lanes, carry-forward state, CPU-cache filtering, minimap, or generated-coarse tier selection.

## Gotchas

- **Keychain is opportunistic.** `lucida auth login` stores the approved token in macOS Keychain when available. If Keychain rejects the write or the platform has no supported keychain integration, the CLI falls back to the `0600` config file.
- **No retry loop yet.** The foundation status/config commands make single HTTP requests. Later WebSocket session commands should keep failures explicit unless a long-lived session mode is designed.
- **`peer list` creates a temporary peer.** Opening the diagnostic WebSocket gives the CLI its own client id, so the listing includes the CLI client alongside browser or other live clients.
