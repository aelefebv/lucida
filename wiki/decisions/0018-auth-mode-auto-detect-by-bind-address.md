---
created: 2026-05-08
modified: 2026-05-14
---


# Auth Mode Auto-Detect by Bind Address

> Status: Accepted.

**Implementation note (2026-05-14):** Slice 2 of PRD #455 retired the
slice-1 `StubPrincipalExtractor` without replacement, so disabled mode
silently regressed into requiring a session cookie that nothing minted
— `LUCIDA_AUTH=disabled` looped the SPA between `/auth/whoami` and an
unregistered `/auth/start` until the URL hit HTTP 414. PRD #527
restored the extractor (so this ADR's loopback-default promise actually
holds) and removed the now-dead `/auth/dev/login` machinery. See
[[auth]] for the post-restoration extractor lineup.

## Decision

When `LUCIDA_AUTH` is unset, `lucida-server` infers the default from the bind address:

- **Loopback bind** (`127.0.0.0/8`, `::1`) → `LUCIDA_AUTH=disabled` (uses `StubPrincipalExtractor`, returns `dev@local`).
- **Non-loopback bind** (any other address) → `LUCIDA_AUTH=google` (requires Google OAuth credentials configured at startup, fail-fasts otherwise).

The combination "non-loopback bind + `LUCIDA_AUTH=disabled`" is rejected at startup unless `LUCIDA_INSECURE=1` is also set, in which case the server starts with a prominent warning logged.

The default for `LUCIDA_BIND` itself shifts from `0.0.0.0:9876` (current) to `127.0.0.1:9876`. Any deployment script that was relying on the old "bind to all interfaces by default" behavior must explicitly set `LUCIDA_BIND`.

## Why

Auth has two failure modes: too restrictive (developers can't run lucida locally without setting up OAuth credentials) and not restrictive enough (a production deploy ships with auth disabled by accident). Both are real risks; either extreme as a hard default fails one set of users.

The actual risk model is **"auth-off server reachable on the network."** That's the combination that matters. Tying the safety posture to bind address makes the dangerous combination impossible without explicit `LUCIDA_INSECURE=1` opt-in, while letting the safe combinations (localhost dev, public deploy with credentials) work without ceremony.

Concrete benefits:

- **Onboarding is friction-free.** A new contributor runs `cargo run --bin lucida-server` and lucida starts immediately, with stub auth, fully functional. No Google OAuth app setup required for local development.
- **CI is happy.** Tests run against localhost-bound servers; auth is stubbed without env-var rituals.
- **Production deploy is forced to think about it.** A Calico operator deploying with `LUCIDA_BIND=0.0.0.0:9876` is told "you need Google credentials" — they cannot accidentally run the stub on a network-reachable port.
- **The `LUCIDA_INSECURE=1` escape hatch covers legitimate cases** (private network deployments where the operator deliberately doesn't want auth), but requires an explicit acknowledgment so it's never accidental.

## Why change `LUCIDA_BIND` default

The current `main.rs:163` binds `0.0.0.0:9876` unconditionally. With auto-detect-by-bind, this default would mean every contributor running `cargo run` gets the production auth requirement (and either configures Google OAuth or sets `LUCIDA_INSECURE=1`). That defeats the dev-friendliness goal.

Flipping the default to `127.0.0.1` makes the dev-friendly path the default; production deployments explicitly opt into network exposure via `LUCIDA_BIND=0.0.0.0:9876` (or whatever the deployment hostname is). This is a one-line change in `main.rs` but a meaningful behavioral change worth documenting.

The change does have consequences:
- Existing deployment scripts that relied on the `0.0.0.0` default break unless updated.
- A user running lucida and trying to reach it from another device on their LAN will be confused by "connection refused" until they discover `LUCIDA_BIND`.

Both are acceptable trade-offs given the safety win. Documented in the OSS quickstart and Calico runbook.

## Alternatives considered

- **Default to auth disabled.** Rejected — risks a production deploy shipping insecure if `LUCIDA_AUTH` is forgotten.
- **Default to auth required.** Rejected — punishes the common dev case; raises the onboarding floor; CI gets harder.
- **Always require explicit `LUCIDA_AUTH` (no default).** Considered. Slightly more rigorous, but adds friction to every dev session and every CI run; the bind-address auto-detect captures the same safety property with better ergonomics.
- **Compile-time feature flag (`cargo run --features dev-auth` for stub, default for Google).** Rejected — hard to misconfigure (a binary can't bypass auth), but slow iteration loop (recompile to switch); stub-vs-real is a runtime choice better made via config.
- **Detect by absence of credentials rather than bind address.** Rejected — leads to "I forgot to set the env var so auth was off" footgun. Bind address is a more reliable signal of operator intent than presence/absence of a config value.

## Consequences

- **`LUCIDA_BIND` becomes a meaningful operational variable.** Anyone deploying lucida must set it explicitly to `0.0.0.0:PORT` (or specific interface) to expose to the network.
- **The error message at startup is part of the user experience.** A poorly-worded "missing credentials" error wastes operator time. The message must clearly state which env var is missing and why it's required.
- **Two paths to "auth disabled" exist** (loopback bind, or `LUCIDA_INSECURE=1`). Both should be logged at startup so operators see them in the boot log.
- **The `LUCIDA_INSECURE=1` opt-in is itself an audit signal.** Any production deploy with this flag set should raise eyebrows in code review; documenting that fact in the runbook prevents accidental production use.

## How this decision shows up in code

- `lucida-server::auth::config::AuthConfig::from_env_map` — performs the auto-detect logic. Reads `LUCIDA_BIND` first (default `127.0.0.1:9876`), then if `LUCIDA_AUTH` is unset infers the mode from `bind_addr.ip().is_loopback()`. The dangerous `Disabled + non-loopback` combination errors with `AuthConfigError::InsecureRequiresOptIn` unless `LUCIDA_INSECURE=1` is also set.
- `lucida-server::auth::config::AuthMode::parse` — fails on unknown values (e.g. `LUCIDA_AUTH=microsoft` is fatal at boot, not silently fallthrough).
- `lucida-server::main::run_serve` — calls `AuthConfig::from_env`, emits `auth.startup` (info, with mode + bind), `auth.startup.config_error` (error, before fail-fast exit), and `auth.startup.insecure_mode` (warn, when `insecure_acknowledged`).
- `lucida-server::auth::is_dev_mode` — slice 8 gates the dev-only `/auth/dev/login` route on `mode == AuthMode::Disabled` (was `cfg!(debug_assertions)` in slice 2). A release build with auto-detected disabled mode still gets the dev shortcut; a debug build with Google OAuth configured does not.
- `lucida-server/tests/auth_config_e2e.rs` — exercises every from-env permutation (loopback default, public default → Google, public + disabled → error, public + disabled + insecure → ok with banner).

## Related

- [[decisions/0016-backend-mediated-oauth-with-session-cookies]] — the auth flow this configures defaults for
- [[decisions/0017-configurable-from-day-one-for-oss-release]] — OSS configurability of the underlying env vars
- PRD #455 — implementation specification
