---
type: Topic
title: "Topic: Auth and Deployment"
description: "How lucida decides who you are and how it ships and runs — one hub because the two concerns are entangled."
tags: [lucida, topic]
source_path: wiki/topics/auth-and-deployment.md
created: 2026-06-25
modified: 2026-06-25
---

# Topic: Auth and Deployment

How lucida decides *who you are* and how it *ships and runs* — one hub because the two concerns are entangled. The cookie design forces a same-origin deploy shape, the bind address auto-selects the auth mode, and the whole `LUCIDA_*` env-var contract is the seam both halves read. The recurring theme is **OSS-from-day-one**: every organization-specific value is configuration, never a literal in code, so a self-hoster reconfigures rather than forks.

This page is a curated index. Articles live in their canonical homes (`systems/`, `decisions/`, `flows/`, `gotchas/`); follow the links for the content.

## Start here

- [Authentication](../systems/subsystems/auth.md) — the `AuthPrincipal` boundary every protected request passes through; cookie-vs-bearer credential paths; the SQLite-backed stores
- [Deployment](../systems/subsystems/deployment.md) — single-image deploy unit, the persistence model, OAuth provider setup, ingress/WebSocket tuning, release process

## Subsystems

- [Authentication](../systems/subsystems/auth.md) — `PrincipalExtractor` seam, session/bearer/pending stores, JWKS cache, sign-in + CLI bearer flows, audit logging
- [Deployment](../systems/subsystems/deployment.md) — `ServeDir` static-serve, single PVC, data-backend dispatch, probes, log format, release/image-tag model

## Crate ownership

- [lucida-server](../systems/crates/lucida-server.md) — hosts both the auth middleware and the served SPA dist; the runtime being deployed
- [lucida-store](../systems/crates/lucida-store.md) — data-backend dispatch by URL scheme (`gs://`/`s3://`/`http(s)`/local), where cloud-credential wiring lands

## Why decisions were made

- [Backend-Mediated OAuth with Session Cookies](../decisions/0016-backend-mediated-oauth-with-session-cookies.md) — tokens never reach JS; WebSocket auth is automatic via cookies; the same-origin requirement that motivates the single image
- [Configurable From Day One for OSS Release](../decisions/0017-configurable-from-day-one-for-oss-release.md) — env-driven config; no hardcoded domain literal anywhere; the provider seam is a single-PR extension point
- [Auth Mode Auto-Detect by Bind Address](../decisions/0018-auth-mode-auto-detect-by-bind-address.md) — loopback → `disabled`, non-loopback → `google`; "disabled + non-loopback" requires explicit `LUCIDA_INSECURE=1`
- [Post-Logout Marker Cookie + `prompt=select_account`](../decisions/0019-post-logout-marker-cookie-and-prompt-select-account.md) — `lucida_signed_out` marker + `prompt=select_account` on re-sign-in
- [Single-Image Container with `ServeDir` is the Canonical Deploy Unit](../decisions/0020-single-image-with-servedir.md) — one container carries both API binary and SPA dist; `ServeDir` serves the dist
- [Deployment Artifacts Are Reference Templates, Not Opinionated Infra](../decisions/0021-deployment-artifacts-as-reference-templates.md) — k8s manifests are reference templates to copy, not packaged infra to depend on
- [Trunk-Based Releases via Manual-Merge `release-please` on `main`](../decisions/0022-manual-merge-release-please-on-main.md) — trunk-based; auto-merge OFF so related changes batch into one release

## Cross-cutting flow

- [Flow: Authentication Sign-In](../flows/auth-signin.md) — unauthed browser → inline unauth landing → `/auth/start` → Google → `/auth/callback` validates state + JWT → session cookie → land at original URL with hash restored

## Gotchas hit while working in this area

- [OSS Config Defaults and the LUCIDA_* Env Var Contract](../gotchas/oss-config-defaults.md) — the full `LUCIDA_*` env-var reference and common misconfigurations (including unknown `LUCIDA_AUTH` values failing loudly, not falling through to disabled)
- [Use `GoogleCloudStorageBuilder::from_env()`, not `new()`, for GCS credentials](../gotchas/gcs-credentials.md) — use `GoogleCloudStorageBuilder::from_env()`, not `new()`, so `GOOGLE_APPLICATION_CREDENTIALS` ADC actually works from `docker run`
- [Branching and Releases](../gotchas/branching-and-releases.md) — image tags (not git branches) model what's deployed where; environment-branches are the anti-pattern lucida avoids
