---
created: 2026-06-25
modified: 2026-06-25
---

# Topic: Agent Surfaces

The non-browser client surfaces — the `lucida` CLI and the Python package — plus the headless rendering paths (montage / screenshot / overview) and the cross-surface diagnostics model they share. The throughline is **parity**: both clients target the same `/ws/workspaces/:id` session the browser uses, send the same protocol messages, and surface the same structured failures, so a scripted `dataset open` shows up in a live browser tab and a script branches on `error.kind`, never on human text.

This page is a curated index. Articles live in their canonical homes (`systems/`, `flows/`); follow `[[wiki-links]]` for the content.

## Start here

- [[lucida-cli]] — the `lucida` binary: a workspace-first command tree mirroring the web app's nouns (status/server/auth, workspace, dataset, view/camera/layer/channel, viewer, layout, saved-view, peer, plan/debug, admin)
- [[lucida-py]] — the Python package: a pure-Python server client (`LucidaClient`) plus local `pyo3` analysis bindings (`PyScene`, `PyStore`)

## Headless rendering paths

These let an agent *see* a dataset without a browser session of its own:

- **`dataset montage`** ([[lucida-cli]]) — a labeled contact-sheet PNG sampling the dataset's primary axis (Z/T/field), with an optional JSON sidecar carrying per-cell re-openable `#view=` saved-view URLs
- **`viewer screenshot` / `viewer overview`** ([[lucida-cli]]) — render the durable headless viewer profile (or, with `--from-peer <client-id>`, a live peer) through headless Chrome, waiting on the web app's render-ready signal

## Cross-surface diagnostics

- [[flows/dataset-diagnostics]] — the one diagnostic story across browser / CLI / Python / server logs: coarse open-progress stages, the stable `kind` failure categories, and `dataset health` / `dataset retry` for runtime bindings

## Why these surfaces exist

- [[lucida-cli]] — discoverability outside the browser, headless scripting, and multi-user testing; the CLI stays a reference client for the HTTP control plane and WebSocket session plane
- [[lucida-py]] — driving a session from analysis pipelines, fast pytest fixtures (scenes/chunk-plans without a browser), and `PyScene` as the easiest way to learn the command wire format

## Gotchas hit while working in this area

- **The product command is `lucida`** — `lucida-cli` is the crate name; the old flat taxonomy (`open`, root `visible-chunks`, `--steer`) is intentionally rejected. See [[lucida-cli]].
- **Screenshots/overview require Chrome/Chromium** — set `LUCIDA_BROWSER` when auto-discovery fails; a render-ready timeout means no Lucida frame was reported. See [[lucida-cli]].
- **Python: build with `maturin develop`, not `cargo build`** — and `from lucida import LucidaClient` works before the Rust extension is built; the local bindings (`PyScene`/`PyStore`) degrade to `None`. See [[lucida-py]].
- **`peer list` creates a temporary peer** — the diagnostic WebSocket gives the CLI its own client id, so the listing includes the CLI itself. See [[lucida-cli]].

## Related

- [[lucida-server]] — the HTTP + WebSocket server both clients target
- [[saved-views]] — the capture record montage/overview cells and CLI `saved-view` commands round-trip through
- [[presence-and-follow-mode]] — the live-peer model `--from-peer` and `peer follow` operate on
