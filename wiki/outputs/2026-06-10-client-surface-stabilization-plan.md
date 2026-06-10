---
created: 2026-06-10
modified: 2026-06-10
---

# Client Surface Stabilization Plan

This is a working plan for the post-merge hardening pass after the shared
CLI/Python client PRD landed. It is not a second feature wave; the goal is to
make the newly shipped client surface reliable, installable, documented, and
easy to smoke test through realistic Lucida workflows.

## Goal

A fresh developer or early user should be able to start Lucida, open a browser,
drive the same workspace through the CLI and Python, open a dataset, adjust
visual state, capture screenshots/overviews, and understand peer/follow behavior
without hidden state-model explanations.

## Non-Goals

- No legacy or compatibility aliases for the old CLI taxonomy.
- No new native renderer for CLI/Python; headless capture continues to use the
  web renderer.
- No broad renderer, storage, or OME-Zarr feature work unless required to make
  the existing client workflows reliable.
- No automatic persistence of live follow state unless explicitly designed as a
  user-visible command. Presence stays ephemeral by default.

## Slices

### 1. Post-Merge Cleanup And Baseline

Clean up the local/repo state after the large client PR lands.

- Move development back onto current `main`.
- Land the `.pnpm-store/` ignore change as a small standalone cleanup.
- Refresh `wiki/now.md` so it records the merged CLI/Python surface.
- Re-check the use-case matrix for stale follow-up recommendations.
- Run the focused baseline checks from a current checkout.

Done when local status is clean except intentional work, `main` reflects the
merged client PR, and wiki current-state docs no longer describe the client work
as merely in-flight.

### 2. CLI UX Audit

Exercise the CLI as a real user and tighten confusing output without changing
the product command model.

- Review top-level and nested help for the common workflows.
- Smoke status, workspace list/create/use/info/open, dataset browse/open/list,
  viewer state/screenshot/overview, layer/channel contrast, saved views, and
  peer list/follow.
- Verify both human and `--json` output paths where the command is scriptable.
- Improve error text for common mistakes: missing workspace, wrong server,
  missing dataset, unauthorized mutation, bad peer id, and browser capture
  setup.
- Keep parser tests rejecting removed legacy surfaces.

Done when a user can discover the next likely command from help/output, and the
documented CLI examples have been run against a local server.

### 3. Python UX Audit

Make the Python client feel like the same product surface rather than a second
API design.

- Provide one small runnable script that connects, selects a workspace, opens a
  dataset, inspects state, applies view/layer/channel changes, and verifies the
  result.
- Clarify dependency/runtime expectations for WebSocket operations.
- Verify token/config compatibility with the CLI path.
- Confirm Python errors preserve enough category/detail for scripts to branch on
  failures.

Done when the Python happy path works from the documented project environment
and failure guidance points users at the right setup fix.

### 4. Install And Invocation Ergonomics

Reduce dependence on remembering source-checkout incantations.

- Document the blessed developer invocation and the expected installed command.
- Document `cargo install --path lucida-cli` or the chosen equivalent for local
  installs.
- Document the Python editable/dev install path.
- Consider small repo scripts for common dev flows only if they reduce command
  drift rather than creating a second interface.

Done when docs distinguish product commands (`lucida ...`) from source-checkout
substitutions (`cargo run -p lucida-cli -- ...`) clearly enough that users do
not paste shell variables as literal commands.

### 5. End-To-End Smoke Scripts

Codify the workflows we currently test manually.

- Add a developer-run smoke path for local server + browser-visible workspace +
  CLI dataset open.
- Add screenshot/overview capture verification that checks PNG creation and
  nonblank output.
- Add a Python smoke path for workspace/dataset/debug/view operations.
- Prefer scripts that can run outside CI first; promote to CI only after runtime
  and fixture assumptions are stable.

Done when the use-case matrix can cite concrete smoke commands for the CLI and
Python rows instead of relying on ad hoc transcript memory.

### 6. Headless Peer/View Semantics

Close the current mental-model gap between live peer follow and durable
headless viewer profiles.

- Keep `peer follow <client-id>` as a live, ephemeral WebSocket relationship.
- Add an explicit way to render from a live peer, likely
  `viewer screenshot --from-peer <client-id>` and `viewer overview --from-peer
  <client-id>`.
- Add an explicit way to copy a live peer into a durable profile, likely
  `viewer adopt --from-peer <client-id>`.
- Make output label whether the source was a durable profile or a live peer.
- Do not make follow silently persist state on exit.

Done when a user can follow a browser, inspect the browser's current view from
the CLI, capture a screenshot of that live view, and intentionally persist it to
a named headless viewer profile.

### 7. Practical Docs Pass

Turn the stable workflow into user-facing docs.

- Add or tighten a "Using Lucida From CLI/Python" guide.
- Include a browser-open verification flow.
- Include troubleshooting for auth, server selection, workspace defaults,
  browser capture, and Python dependencies.
- Cross-link to `wiki/systems/crates/lucida-cli.md` for architecture details
  rather than duplicating every command.

Done when the docs tell the same story as the smoke scripts and avoid stale
examples from the pre-clean-cut CLI.

## Definition Of Done

- Local and GitHub checks are green for the stabilization branch.
- CLI examples in docs have been run against a real local server.
- Python examples have been run from the documented environment.
- The use-case smoke matrix is current for affected rows.
- `wiki/now.md` and `wiki/systems/crates/lucida-cli.md` match the implemented
  behavior.
- No legacy compatibility command surface is reintroduced.

## Open Decisions

- Whether stabilization should be a single small PRD issue with child slices or
  a sequence of direct small PRs.
- Whether smoke scripts should live under `scripts/`, `tests/smoke/`, or a
  package-specific location.
- Whether `viewer adopt --from-peer` should update only the default profile by
  default or require an explicit `--profile` when copying from a peer.
