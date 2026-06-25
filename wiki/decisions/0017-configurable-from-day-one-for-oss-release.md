---
type: Decision
title: "Configurable From Day One for OSS Release"
description: "The auth implementation (and, by extension, all subsequent features that consume identity) is configurable from day one to support open-source release."
tags: [lucida, decision]
source_path: wiki/decisions/0017-configurable-from-day-one-for-oss-release.md
created: 2026-05-08
modified: 2026-06-25
---

# Configurable From Day One for OSS Release

> Status: Accepted (implemented; PRD #455). Every `LUCIDA_*` env var below is live.

## Decision

The auth implementation (and, by extension, all subsequent features that consume identity) is **configurable from day one** to support open-source release. Every deployment-specific value lives in environment variables; no Calico-specific literal exists in the codebase.

Concretely:
- **Allowed hosted domain(s)** — `LUCIDA_ALLOWED_HOSTED_DOMAINS` (comma-separated; empty = no domain restriction). Calico deploys with `calicolabs.com`; an OSS user might use their own org's domain or leave it empty.
- **OAuth provider configuration** — `LUCIDA_GOOGLE_CLIENT_ID`, `LUCIDA_GOOGLE_CLIENT_SECRET`, `LUCIDA_OAUTH_REDIRECT_URI`. No Google-Workspace-specific or Calico-specific values are baked in.
- **Auth mode** — `LUCIDA_AUTH={google,disabled}` (with future values like `microsoft`, `okta`, `oidc` as contributors add providers).
- **Admin allowlist** — `LUCIDA_ADMIN_EMAILS` (comma-separated). OSS self-hoster sets their own; Calico sets the bootstrap admin set.
- **Cookie configuration** — `LUCIDA_COOKIE_NAME`, `LUCIDA_COOKIE_SECURE`. Defaults are sensible; overrides exist for unusual deployments.
- **Provider extensibility** — `PrincipalExtractor` is the documented OSS extension point. New providers (Microsoft, Okta, GitHub, generic OIDC, Authentik, etc.) are added by implementing the trait, not by refactoring auth-using code.

The Calico hosted instance is one *configuration* of lucida, not the system itself. The same binary runs in a Calico colleague's home lab, in a non-Calico research group's deployment, or in a personal localhost setup — all behaving correctly per their respective configs.

## Why

Lucida is destined for open-source release outside Calico. Any value baked into source code as a Calico-specific literal becomes a refactor obligation when an OSS user wants to deploy. The marginal cost of designing in configurability now (env var reads + validation + defaults) is small. The cost of retrofitting later (changing every literal site, plus the cognitive overhead of "is this Calico-specific or generic?") is meaningful and grows with each new feature that consumes identity.

This decision is also pre-emptive against a more subtle problem: **hardcoding implies an architectural assumption**. If `calicolabs.com` is hardcoded, future contributors will (reasonably) write code that assumes a single domain, single org, single deployment shape. Configurability from day one shapes the abstractions correctly.

A specific worked example: the `is_admin` flag on `AuthPrincipal`. With `LUCIDA_ADMIN_EMAILS` as an env var, the abstraction is "an external allowlist." With hardcoded admin emails, the abstraction would be "a fixed Calico set" — and code consuming `is_admin` would carry that assumption invisibly until an OSS user asked "how do I add an admin?" and discovered the answer was "edit the source."

## OSS extensibility — the `PrincipalExtractor` seam

A specific case of configurability: auth provider. v1 ships `GoogleJwtPrincipalExtractor`. Other providers (Microsoft Azure AD, Okta, GitHub OAuth, Authentik, generic OIDC) are common requests for any open-source tool. Without an explicit seam, adding a second provider would require modifying every site that touches identity.

`PrincipalExtractor` is that seam. The trait surface is small (`extract(req) -> Result<AuthPrincipal, AuthError>`); a new implementation is a single PR per provider. Saved views (PRD #454) and any future feature depend only on the trait, not on Google.

This also benefits Calico — if Calico ever migrates from Google Workspace to another provider, that's also a single-extractor change, not a feature rewrite.

## Alternatives considered

- **Hardcode Calico-specific values; refactor later if open-sourcing happens.** Rejected — the open-source release is intended, not speculative; the refactor would touch every identity-consuming site (a moving target as features land).
- **Build a more elaborate plugin system with runtime-loadable providers.** Rejected as overkill for the stage. The trait-based seam is sufficient for "add a provider via PR."
- **Skip OSS configurability for v1; revisit at release time.** Rejected — the same code that lands for Calico will be the OSS code; designing for two audiences from the start costs little and prevents a meaningful retrofit later.

## Consequences

- **Two deployment "profiles" to document**: Calico-internal (Google + `calicolabs.com` + Calico admin emails) and OSS-self-hosted (varied). Documentation lives in the README/quickstart and a separate Calico runbook.
- **Server fail-fast behavior at startup** validates that required env vars are set for the chosen `LUCIDA_AUTH` mode, with clear messages naming missing variables. Better to fail loudly than start up insecure.
- **The configurability surface is itself a contract.** `LUCIDA_*` env var names must be treated as a public API; renaming them later is a breaking change for OSS deployments.
- **Test surface expands** to cover both auth modes and various config permutations (allowed-domains empty, single, multi; admin-emails empty, single, multi; etc.).
- **Future decisions inherit the posture.** Any new feature that consumes identity, organization metadata, or auth provider details must follow the same configurable-from-day-one pattern.

## How this decision shows up in code

- `lucida-server::auth::config::AuthConfig` — env var reading + validation + defaults. Single source of truth for "what's configured."
- `lucida-server::auth::principal::PrincipalExtractor` — the trait. Provider implementations register here.
- README / quickstart documentation — public-facing description of `LUCIDA_*` env vars.

## Related

- [Backend-Mediated OAuth with Session Cookies](0016-backend-mediated-oauth-with-session-cookies.md) — the auth flow this configures
- [Auth Mode Auto-Detect by Bind Address](0018-auth-mode-auto-detect-by-bind-address.md) — auto-detection layered on top of explicit `LUCIDA_AUTH`
- PRD #455 — implementation specification including the full env var table
