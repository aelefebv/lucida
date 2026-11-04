# Configurable From Day One for OSS Release

Status: Accepted.

## Context

lucida is open source, and the same binary runs on a hosted deployment, in other organizations' clusters, and on a laptop. Any organization-specific literal in the source becomes a refactor when someone else deploys it. A hardcoded value also teaches later code to assume one domain, one organization, one deployment shape. Hardcoded admin emails, for example, would make `is_admin` mean "a fixed internal set" rather than "an allowlist the operator controls."

## Decision

Every deployment-specific value comes from a `LUCIDA_*` environment variable, and the code holds no organization-specific literal. For auth that covers the mode (`LUCIDA_AUTH`: `google`, `iap`, or `disabled`), the allowed hosted domains (empty means no restriction), the OAuth client and redirect settings, the admin allowlist (`LUCIDA_ADMIN_EMAILS`), and cookie overrides. `AuthConfig` in `lucida-server/src/auth/config.rs` reads and validates them. At startup the server fails fast and names each missing variable the chosen mode requires.

The variable names are a public API. Renaming one breaks deployments.

Identity providers plug in through the `PrincipalExtractor` trait. A new provider is one implementation plus its variables, with no change to code that consumes identity. IAP mode arrived exactly this way ([0060](0060-iap-mode-reads-the-identity-the-perimeter-established.md)).

New features that consume identity, organization metadata, or provider details follow the same rule.

## Rejected alternatives

- Hardcode now and refactor if open-sourcing happens. Open source was the plan, and the refactor would touch every site that consumes identity, a set that grows with each feature.
- A runtime plugin system for providers. Too much machinery for the need. A trait and one pull request per provider is enough.
