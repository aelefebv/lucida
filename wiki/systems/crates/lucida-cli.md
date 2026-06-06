---
created: 2026-04-18
modified: 2026-06-06
---

# lucida-cli

The Rust crate that builds Lucida's product CLI binary, `lucida`. The crate name remains `lucida-cli` as a Cargo workspace identity, but the user-facing command is no longer `lucida-cli`.

The CLI is moving to a workspace-first client surface that mirrors the web app's nouns. The first foundation slice exposes `lucida status`, `lucida server ...`, and `lucida config ...`; later slices add workspace, dataset, view, layer, channel, layout, saved-view, peer, debug/plan, admin, and Python parity.

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
- `lucida config set server <base-url>` — persist the default server.
- `lucida config get server` — print the effective default server.
- `lucida config path` — print the config file path.

Global visible flags:

- `--server <base-url>` — override the configured/default server for one invocation.
- `--json` — emit stable machine-readable JSON.
- `--quiet` — suppress success output.

## Interactions

- Config is local JSON under `$LUCIDA_CONFIG_PATH`, `$XDG_CONFIG_HOME/lucida/config.json`, or `~/.config/lucida/config.json`.
- HTTP status checks call the same public/protected server endpoints the web app uses: `/healthz`, `/readyz`, `/version`, and `/auth/whoami`.
- Future noun commands should reuse the same config, output, error, target-resolution, HTTP, and WebSocket modules instead of adding one-off flag parsing.

## Invariants

- **The product command is `lucida`.** `lucida-cli` is the crate/package implementation detail.
- **Server input is a base HTTP URL.** Commands that need a session derive WebSocket URLs internally from the base server target.
- **Every scriptable command needs `--json`.** Human output can be concise, but automation should not parse tables.
- **Errors are categorized.** The foundation defines stable categories such as `unreachable_server`, `unauthenticated`, `unauthorized`, `missing_resource`, `ambiguous_name`, `archived_workspace`, `dataset_open_failure`, `session_disconnect`, and `rejected_command`.
- **One command per invocation.** The CLI remains a one-shot client unless a later slice explicitly introduces a long-lived mode.

## Gotchas

- **Auth status is best-effort until bearer credentials land.** `lucida status` can call `/auth/whoami`, but durable CLI/Python auth arrives in the bearer-credential slice.
- **No retry loop yet.** The foundation status/config commands make single HTTP requests. Later WebSocket session commands should keep failures explicit unless a long-lived session mode is designed.
