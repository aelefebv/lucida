---
created: 2026-06-25
modified: 2026-06-25
---

# Topic: Auth and Deployment

How lucida decides *who you are* and how it *ships and runs* — one hub because the two concerns are entangled. The cookie design forces a same-origin deploy shape, the bind address auto-selects the auth mode, and the whole `LUCIDA_*` env-var contract is the seam both halves read. The recurring theme is **OSS-from-day-one**: every Calico-specific value is configuration, never a literal in code, so a self-hoster reconfigures rather than forks.

This page is a curated index. Articles live in their canonical homes (`systems/`, `decisions/`, `flows/`, `gotchas/`); follow `[[wiki-links]]` for the content.

## Start here

- [[auth]] — the `AuthPrincipal` boundary every protected request passes through; cookie-vs-bearer credential paths; the SQLite-backed stores
- [[deployment]] — single-image deploy unit, the persistence model, OAuth provider setup, ingress/WebSocket tuning, release process

## Subsystems

- [[auth]] — `PrincipalExtractor` seam, session/bearer/pending stores, JWKS cache, sign-in + CLI bearer flows, audit logging
- [[deployment]] — `ServeDir` static-serve, single PVC, data-backend dispatch, probes, log format, release/image-tag model

## Crate ownership

- [[lucida-server]] — hosts both the auth middleware and the served SPA dist; the runtime being deployed
- [[lucida-store]] — data-backend dispatch by URL scheme (`gs://`/`s3://`/`http(s)`/local), where cloud-credential wiring lands

## Why decisions were made

- [[decisions/0016-backend-mediated-oauth-with-session-cookies]] — tokens never reach JS; WebSocket auth is automatic via cookies; the same-origin requirement that motivates the single image
- [[decisions/0017-configurable-from-day-one-for-oss-release]] — env-driven config; no `calicolabs.com` literal anywhere; the provider seam is a single-PR extension point
- [[decisions/0018-auth-mode-auto-detect-by-bind-address]] — loopback → `disabled`, non-loopback → `google`; "disabled + non-loopback" requires explicit `LUCIDA_INSECURE=1`
- [[decisions/0019-post-logout-marker-cookie-and-prompt-select-account]] — `lucida_signed_out` marker + `prompt=select_account` on re-sign-in
- [[decisions/0020-single-image-with-servedir]] — one container carries both API binary and SPA dist; `ServeDir` serves the dist
- [[decisions/0021-deployment-artifacts-as-reference-templates]] — k8s manifests are reference templates to copy, not packaged infra to depend on
- [[decisions/0022-manual-merge-release-please-on-main]] — trunk-based; auto-merge OFF so related changes batch into one release

## Cross-cutting flow

- [[flows/auth-signin]] — unauthed browser → inline unauth landing → `/auth/start` → Google → `/auth/callback` validates state + JWT → session cookie → land at original URL with hash restored

## Gotchas hit while working in this area

- [[gotchas/oss-config-defaults]] — the full `LUCIDA_*` env-var reference and common misconfigurations (including unknown `LUCIDA_AUTH` values failing loudly, not falling through to disabled)
- [[gotchas/gcs-credentials]] — use `GoogleCloudStorageBuilder::from_env()`, not `new()`, so `GOOGLE_APPLICATION_CREDENTIALS` ADC actually works from `docker run`
- [[gotchas/branching-and-releases]] — image tags (not git branches) model what's deployed where; environment-branches are the anti-pattern lucida avoids
