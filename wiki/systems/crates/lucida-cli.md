---
type: Crate
title: "lucida-cli"
description: "The Rust crate that builds Lucida's product CLI binary, lucida."
tags: [lucida, crate]
source_path: wiki/systems/crates/lucida-cli.md
created: 2026-04-18
modified: 2026-07-06
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

## Module map

One `src/` module per noun plus shared foundations; `main.rs` holds the clap derive tree and dispatch.

- **Foundations**: `config.rs` (server/workspace config file), `credentials.rs` (token sourcing), `error.rs` (`CliError` + stable categories), `output.rs` (`--json`/human/quiet), `http.rs` (API URL building + authed JSON requests; each noun keeps its own status→error vocabulary), `session.rs` (workspace WebSocket plumbing: connect/auth, the snapshot handshake, `send_client_message`, and the `observe_until` reply loop), `workspace.rs` (workspace client plus target resolution and the `workspace_ws_url`/`workspace_web_url` builders every session-based command derives URLs from).
- **Nouns**: `status.rs`, `auth.rs`, `workspace.rs`, `dataset.rs`, `view.rs` (also camera/layer/channel/viewer/peer/plan/debug), `layout.rs`, `saved_view.rs`, `montage.rs`, `admin.rs`.

`session.rs` also owns the unsolicited-snapshot contract: the server pushes fresh `Snapshot`s outside the request/reply rhythm (after broadcast lag, and in answer to `request_snapshot` — see [document-command-application](../../flows/document-command-application.md)). The shared reply loop consumes a mid-exchange snapshot as a state refresh instead of handing it to the reply observer, so one-shot commands cannot misread a resync push as their ack.

## Subcommands

The command tree mirrors the web app's nouns. `lucida --help` (and `<noun> --help`) is the authoritative listing; the source of truth is the clap derive in `lucida-cli/src/main.rs`. Below is one bullet per noun, calling out only the non-obvious bits.

- `status` / `server` / `auth` — effective-server + health/readiness/version + auth status; `auth login` provisions a CLI bearer credential via the browser; `auth logout --local-only` skips server revocation.
- `workspace` — list/create/info/use/open/pin/archive/restore + `share` (link tier off/viewer/editor) + `member` (add/set-role/remove with viewer/editor/owner).
- `dataset` — browse/open/list/info/health/retry/remove, plus `montage` (see below). `open` waits and reports server-authored progress stages; `health` surfaces binding/backend/source-cache/generated-coarse pressure.
- `view` / `camera` / `layer` / `channel` — mutate the selected durable viewer profile's slice view, camera, and per-layer/per-channel display state.
- `viewer` — `state`/`link`/`adopt`/`screenshot`/`overview`; `--from-peer <client-id>` targets a live peer instead of the durable profile (`adopt` persists it, screenshot/overview render it without persisting).
- `layout` — list/active/set shared dataset layouts.
- `saved-view` — see the saved-view workflow below.
- `peer` — `list`/`follow`/`cursor`; `follow` is long-lived (stays connected until Ctrl-C, then clears follow state).
- `plan visible-chunks` / `debug state` — read-only scene-chunk and workspace-snapshot diagnostics.
- `admin workspace` (search/info/archive/restore/owner) + `admin clear-proxy-cache` — authenticated remote admin API, labeled `remote_admin`, distinct from local server-process ops.
- `config` — get/set default server, get default workspace, print config path.

Global flags: `--server`, `--workspace` (one-shot overrides), `--json` (stable machine output), `--quiet`.

### `dataset montage`

`lucida dataset montage <dataset> --out <png> [--cells 16] [--cols 4] [--cell-px 320] [--json] [--timeout-seconds 30]` renders a labeled contact-sheet PNG that samples the dataset's primary axis (Z / T / tile / single), filling cells row-major with a text label per cell. With `--json` it also writes a sidecar at `<out>.json` describing the grid (axis, cols/rows, `cell_px`, shared `contrast` window) and, per cell, its `z`/`t`/`c`/`tile`/`label`/grid position plus a re-openable `#view=`-encoded saved-view URL for drilling into that exact cell. Implemented in `montage.rs` (the `Montage` variant + `mod montage` in `main.rs`).

### Saved-view workflow

`saved-view list|show|apply|capture|rename|update|delete|set-default|clear-default|link|promote|approve|reject`. Views carry a visibility tier — `shared` (default), `personal`, or `proposed`. `proposed` is a bid to share surfaced to editors as a review queue: `capture`/`promote` can set `--visibility proposed`, and an editor resolves it with `approve` (→ shared) or `reject` (→ personal). `update` requires `--from-current` (capturing live state into the view; it refuses without it); `capture`/`update` also accept `--from-peer <client-id>`.

## Browser verification flow

The durable verification fact: the CLI targets the same `/ws/workspaces/:id` session the browser uses and waits on request-correlated dataset-open progress, so a `dataset open` shows up in an open browser tab without hand-constructing WebSocket URLs (the same holds for shared mutations like layout changes and saved-view apply). `viewer screenshot`/`overview` render through headless Chrome/Chromium and wait for the web app's render-ready signal; `--from-peer <client-id>` captures a live peer instead of the durable profile.

## Smoke workflows

Smoke scripts live in `scripts/` and run against an already-running `lucida-server`: `smoke_lucida_cli.sh` (CLI), `smoke_python_client.py` and `smoke_dataset_reliability.py` (Python, via `uv run --project lucida-py`). They are parameterized by `LUCIDA_SMOKE_*` env vars — read the script headers for the current set.

## Interactions

- Config is local JSON under `$LUCIDA_CONFIG_PATH`, `$XDG_CONFIG_HOME/lucida/config.json`, or `~/.config/lucida/config.json`.
- The default server is global, while default workspace and config-file bearer-token fallback are scoped under `servers[normalized_server_url]`.
- Bearer credentials are sourced from `LUCIDA_TOKEN` first, then macOS Keychain when available, then the server-scoped local config fallback. The file fallback is written with `0600` permissions on Unix.
- HTTP status checks call the same public/protected server endpoints the web app uses: `/healthz`, `/readyz`, `/version`, and `/auth/whoami`.
- Remote admin commands call `/admin/*` APIs with bearer auth and label JSON/human output as `remote_admin`, keeping them distinct from local `lucida-server` process operations.
- Noun commands reuse the shared foundations — `config.rs`, `output.rs`, `error.rs`, `workspace.rs` target resolution, `http.rs`, and `session.rs` — instead of adding one-off flag parsing or hand-rolling their own request/session loops; new nouns must too.

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
- **No automatic retry loop yet.** The foundation status/config commands make single HTTP requests, and `dataset retry` is an explicit user action for one persisted workspace dataset binding. Later WebSocket session commands should keep failures explicit unless a long-lived session mode is designed.
- **`peer list` creates a temporary peer.** Opening the diagnostic WebSocket gives the CLI its own client id, so the listing includes the CLI client alongside browser or other live clients.
- **Admin workspace commands are id-based.** Search can discover ids, but `admin workspace info/archive/restore/owner` intentionally do not reuse member-scoped workspace name resolution.
- **Negative numeric flags use clap's accepted forms.** The parser accepts `--flag=-2` and the relevant commands enable hyphen values where practical; scripts should prefer equals-style values for clarity.
- **Viewer screenshots require Chrome/Chromium.** Set `LUCIDA_BROWSER` when auto-discovery cannot find a browser binary; a render-ready timeout means the page never reported a rendered Lucida frame for a loaded dataset.
