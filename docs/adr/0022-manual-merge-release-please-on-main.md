# Trunk-Based Releases via Manual-Merge `release-please` on `main`

Status: Accepted.

## Context

Adopters pin `vX.Y.Z` image tags, so the release cadence and the bump rules are part of the public contract. Commits already follow Conventional Commits. A small team often lands a fix and a related feature minutes apart.

## Decision

`main` is the only long-lived branch and is always releasable. Work lands through short-lived branches and pull requests that must pass CI. Branch protection blocks direct pushes, which could otherwise mint a release.

release-please reads Conventional Commits since the last release and keeps a release PR open with the next version and its `CHANGELOG.md` entry. Auto-merge is off. The maintainer merges the release PR when a release is wanted, the merge creates a tag, and the tag triggers the workflow that builds and pushes a multi-architecture image to `ghcr.io`. Before 1.0, `bump-minor-pre-major` keeps breaking changes on minor bumps.

The config is single-root (`release-type: simple`, `packages: { ".": {} }`): one tag stream, one changelog, and the version in `.release-please-manifest.json`. Per-crate `Cargo.toml` versions are not bumped and mean nothing externally. The git tag is the version.

What is deployed where is an image tag in a manifest, not a branch, and promotion is a manifest edit.

The release-please workflow authenticates with a token that has `workflow` scope, because a tag pushed with the default `GITHUB_TOKEN` does not trigger other workflows.

## Rejected alternatives

- Manual tags only. It depends on someone remembering to release, and the changelog is written by hand.
- A calendar-version tag per commit. Automatic, but it gives adopters no semver signal about what might break.
- release-please with auto-merge on. It releases on every bumping merge, which is noise when related PRs land together. Turning it on later is a one-line change.
- Scheduled releases. An urgent fix waits for the schedule or ships out of band.
- GitFlow. It is built for slow cadences with several supported versions in flight.
- Environment branches (`dev`, `staging`, `prod`). Branches drift from what is actually deployed, and promotions pile up merge conflicts.
- Per-crate versions held together by the `linked-versions` plugin. At v0.3.0 it silently bumped only one crate, because the plugin needs an explicit `component` per package. Single-root config has nothing to misconfigure. Revisit if crates are ever published to crates.io.
