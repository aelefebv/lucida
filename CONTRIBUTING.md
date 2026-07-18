# Contributing to Lucida

Start with [the project intention](intention.md), then read the
[wiki guide](wiki/CLAUDE.md) and [current state](wiki/now.md). Lucida stays
domain-neutral, chunk-lazy, remote-first, and correctness-first; code, tests,
fixtures, documentation, issue text, and PR titles should use general dataset,
array, image, volume, channel, sample, and label vocabulary.

## Supported development environment

- Rust 1.95.0, including `rustfmt`, `clippy`, and `wasm32-unknown-unknown`
  (`rust-toolchain.toml` installs these automatically).
- Node 22.14.0 (`.node-version`; the supported range is declared in
  `lucida-web/package.json`).
- pnpm 9.15.9 through Corepack (`packageManager` is the single version source).
- Python 3.10 or newer, with Python 3.12 used by CI, and `uv`.
- wasm-pack 0.15.0. `scripts/install-wasm-pack.sh` installs the supported Linux
  or macOS binary after checking its upstream-published SHA-256 digest.

The web client is the repository's only JavaScript package. From a clean clone,
build the WASM package before installing the local file dependency:

```bash
sh scripts/install-wasm-pack.sh "$HOME/.cargo/bin"
(cd lucida-core && wasm-pack build --target web --out-dir pkg -- --locked)
(cd lucida-web && corepack pnpm install --frozen-lockfile)
```

For the normal development loop, use `./scripts/dev.sh`.

## Verification

Run `./scripts/verify.sh` before requesting review. It is the local equivalent
of the Rust, web, Python, formatting, lint, and delivery-contract CI gates.
GitHub additionally performs a dependency-diff review, advisory lookups, a
container build/smoke test, and Kubernetes schema validation because those need
registry or pull-request context. Its cross-stack lane also runs the built
server, CLI, maintained Python client, and production SPA against one generated
OME-Zarr fixture, retaining DPR 1/2 browser screenshots and logs on failure.

When narrowing a test during development, restore the full verification command
before handoff. Rendering changes also require a real large/3D/timeseries
fixture at device-pixel-ratio 2; see the linked wiki gotcha from `CLAUDE.md`.

## Generated and locked files

- Commit `Cargo.lock`, `lucida-web/pnpm-lock.yaml`, and `lucida-py/uv.lock` when
  their source manifests intentionally change.
- Do not commit `target/`, `lucida-core/pkg`, `lucida-web/dist`, `node_modules`,
  `.vite`, local databases, credentials, or screenshots from manual testing.
- Wire fixtures are reviewed API contracts. Regenerate them only for an
  intentional protocol change using the command documented in
  `wiki/systems/crates/lucida-protocol.md`.

## Dependencies and supply-chain policy

Rust advisories, licenses, registries, git sources, wildcards, and duplicate
versions are governed by `deny.toml`. Web runtime dependencies are audited with
pnpm; Python auditing exports only the runtime dependency set, so build tools
such as Maturin are not reported or shipped as application dependencies.
GitHub's dependency review checks every changed lockfile and manifest.

Dependabot proposes weekly Cargo, pnpm, Python, workflow-action, and container
base updates. Workflow actions stay pinned to reviewed commit SHAs, downloaded
tools have fixed versions and checksums, and Docker bases use readable tags plus
immutable digests. A suppression is acceptable only when it records an owner,
rationale, exposure analysis, and expiry beside the suppression.

Upgrade a toolchain as one reviewed change, rather than allowing local, CI, and
release environments to drift:

- Rust: update `rust-toolchain.toml`, the Rust Docker base tag and digest, and
  every CI `toolchain` input; then regenerate locks if resolution changes.
- Node: update `.node-version`, the web package engine range, and the Node Docker
  base tag and digest.
- pnpm: update the web `packageManager`, Docker activation, and CI setup input.
- wasm-pack and downloaded CI tools: update the exact version and the
  upstream-published checksums for every supported architecture.
- Actions and container bases: review upstream release notes, replace the pinned
  SHA or digest, and retain the readable version comment/tag beside it.

Run `./scripts/verify.sh` plus the container and manifest CI jobs after any of
these changes. Production manifests use `tag@sha256:digest`: tags remain readable
while the digest makes promotion and rollback immutable.

## Build profile intent

Cargo profiles belong only in the workspace root; member-level profile sections
are ignored by Cargo. `lucida-core` uses `opt-level = "s"` in release builds to
control the WASM payload, while `lucida-store` uses `opt-level = 2` in development
to keep chunk and layout work representative without optimizing every crate.
Profile changes must include a warning-free `cargo metadata` run and before/after
artifact-size or representative-workload evidence in the PR.

## Work and pull requests

This repository uses Beads (`bd`) for durable work tracking. Run `bd prime`,
inspect and claim an issue before implementation, and record follow-up work in
Beads rather than a markdown task list. Do not commit or push unless the active
workflow or maintainer grants that authority.

Keep changes reviewable and preserve unrelated work in a dirty tree. PR titles
and commits use Conventional Commit subjects because release-please derives
versions and changelogs from them. Explain the root cause, architectural choice,
user-visible behavior, verification evidence, and any remaining acceptance gap
in the PR description.
