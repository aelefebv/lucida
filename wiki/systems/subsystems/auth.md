---
created: 2026-05-08
modified: 2026-05-08
---

# Authentication

Cross-cutting subsystem in [[lucida-server]] that gates every request through an `AuthPrincipal` extracted by middleware. Identity comes from a Google ID token (validated server-side); session continuity comes from an opaque `lucida_session` cookie backed by a SQLite row. The web client never touches JWTs or refresh tokens — its only notion of "logged in" is "did `GET /auth/whoami` return 200 or 401."

## Why backend-mediated, not SPA-with-JWT

Two viable OAuth shapes for a SPA + backend application were considered. Backend-mediated won on four grounds: tokens never reach JavaScript (XSS-resistant); WebSocket auth is automatic via cookies; refresh logic stays server-side; the server already gains persistent state for bookmarks (PRD #454) so adding `login_sessions` is incremental, not a new architectural commitment. Full rationale in [[decisions/0016-backend-mediated-oauth-with-session-cookies]].

## The seam: `PrincipalExtractor`

The trait `PrincipalExtractor::extract(req) -> Result<AuthPrincipal, AuthError>` is the single boundary auth-using code consumes. Two implementations live in `auth/principal.rs`:

- `SessionCookieExtractor` — production path. Reads the cookie, looks up the session row, enforces idle/hard timeouts, recomputes `is_admin` from `LUCIDA_ADMIN_EMAILS`, fires off a fire-and-forget `last_used_at` bump.
- `GoogleJwtPrincipalExtractor` — Bearer-JWT path, wired but not the default request-time extractor. Reserved for future CLI/server-to-server flows; the OAuth callback uses it transitively via `principal_or_rejection_from_claims`.

Saved-views (PRD #454) and any future feature consume `AuthPrincipal` without knowing about Google. Adding a new auth provider (Microsoft/Azure AD, Okta, generic OIDC) is a single-PR contribution per provider — see [[decisions/0017-configurable-from-day-one-for-oss-release]].

## Three stores

All three are SQLite-backed under one connection pool, with in-memory implementations behind the same trait for tests.

- **`LoginSessionStore`** (`auth/session_store.rs`) — `login_sessions {id, email, display_name, picture_url, created_at, last_used_at, expires_at}`. Hot path: indexed lookup by `id`; `last_used_at` bumped fire-and-forget. Sweep deletes rows past `expires_at` or past `last_used_at + idle_window`.
- **`PendingAuthStore`** (`auth/pending_auth.rs`) — `pending_auth {state_token, intended_path, intended_hash, created_at}` for in-flight OAuth `state` tokens. `consume` is atomic single-use via `DELETE … RETURNING` to prevent state replay. 10-minute TTL.
- **JWKS cache** (`auth/google_oauth.rs`) — in-memory `Arc<RwLock<JwksCache>>`. 24h time-based refresh + on-validation-failure refresh (handles Google's mid-cache key rotation). Initial fetch happens at server boot; failure fail-fasts startup.

## Configuration model

Every Calico-specific value is an env var. The code has no `calicolabs.com` literal anywhere — Calico's deployment is one configuration of the system, not the system itself. See [[decisions/0017-configurable-from-day-one-for-oss-release]] and [[gotchas/oss-config-defaults]].

`AuthConfig::from_env_map` (in `auth/config.rs`) consolidates all `LUCIDA_*` env-var reading and validation. Auto-detect logic from [[decisions/0018-auth-mode-auto-detect-by-bind-address]] uses the bind address as the safety signal: loopback bind defaults to `LUCIDA_AUTH=disabled`, non-loopback defaults to `LUCIDA_AUTH=google`. The dangerous combination "disabled + non-loopback" requires explicit `LUCIDA_INSECURE=1` opt-in.

The closure-based env reader (`from_env_map(reader)`) is a testable seam — unit tests cover every permutation without touching process state.

## Cookie attributes

The `lucida_session` cookie is opaque (256-bit random session ID) and carries no identity claims. Attributes per [[decisions/0016-backend-mediated-oauth-with-session-cookies]]: `HttpOnly`, `Secure` auto-detected from request scheme, `SameSite=Lax`, `Path=/`, `Max-Age` matching the hard cap (default 30 days). `Lax` allows cross-origin top-level GET navigations (so saved-views link clicks work) while blocking cross-origin POST/PATCH/DELETE.

The cookie attribute set lives in one place (`auth/cookie.rs`) so logout's clearing cookie matches the original. `LUCIDA_COOKIE_SECURE={auto,always,never}` overrides the auto-detect for setups behind TLS-terminating proxies (see [[gotchas/oss-config-defaults]]).

## Sign-in flow

End-to-end trace lives in [[flows/auth-signin]]. Summary: unauthed browser → middleware returns inline `UnauthLanding` HTML with JS shim → shim captures `location.hash` and POSTs to `/auth/start` → server stashes intent in `pending_auth`, 302s to Google → user signs in → Google 302s to `/auth/callback` → server validates state token, exchanges code, validates JWT, applies hosted-domain check, creates `LoginSession`, sets cookie → 302 to original path with hash restored.

## Audit logging

All auth boundaries emit `tracing` events at `dot.scope` event names per [[decisions/0012-logging-conventions]]. `auth.signin.success/rejected.*/error.*`, `auth.logout`, `auth.session.expired.{idle,hard_cap}`, `auth.session.cleanup`, `auth.failure.unknown_session`, `auth.startup.{config_error,insecure_mode}`. Structured fields where applicable. **Never logged**: cookie values, JWT values, code exchange tokens, state tokens.

## Interactions

- **Producer**: every connected client. WebSocket clients send the cookie on the upgrade handshake (browsers do this automatically same-origin). HTTP clients send it on every request.
- **Server**: `auth/middleware.rs` runs the configured extractor on every non-`/auth/*` request. Public routes (`/auth/start`, `/auth/callback`, `/auth/error`, `/auth/dev/login` in dev mode) live in a separate router half so they don't recurse through the unauth landing.
- **Consumers**: handlers extract `AuthPrincipal` from request extensions; `AdminRequired` extractor in `auth/extractors.rs` adds the admin gate. Saved views (PRD #454) consumes `created_by = principal.email`.

## Invariants

- **Sessions are derived state.** `AuthPrincipal` is reconstructed per-request from the `LoginSession` row (and `LUCIDA_ADMIN_EMAILS` for `is_admin`). Promoting/demoting an admin takes effect on the user's next request after a config + restart — no session invalidation needed.
- **State tokens are single-use.** `PendingAuthStore::consume` atomically deletes; second use returns missing. Prevents OAuth state replay.
- **No identity in the cookie.** The cookie value is an opaque session ID, never a JWT or principal claims. A stolen cookie grants the session; it doesn't reveal who the session is for.
- **Auth checked at WS upgrade only.** Open WebSocket connections persist for their lifetime even if the underlying session expires. Mid-connection enforcement is a future feature ([[decisions/0016-backend-mediated-oauth-with-session-cookies]] §"Consequences").
- **GET endpoints must be side-effect-free.** `SameSite=Lax` blocks cookies on cross-origin POST/PATCH/DELETE (CSRF protection) but allows them on top-level GET. State-changing GETs would bypass CSRF protection.

## Gotchas

- **`X-Forwarded-Proto` is not trusted** for `Secure` cookie auto-detection. Operators behind TLS-terminating proxies must set `LUCIDA_COOKIE_SECURE=always`. Documented inline in `auth/cookie.rs`.
- **Cross-origin cookie wrinkle in dev**: lucida-server (`:9876`) and Vite (`:5173`) run on different origins; SameSite=Lax cookies aren't sent on cross-origin XHR/fetch even with `credentials: include`. The Vite proxy in `lucida-web/vite.config.ts` forwards `/auth`, `/api`, `/admin`, `/ws` to the backend so the browser sees one origin. Visit `:5173`, never `:9876` directly.
- **Pre-auth `dev@local` bookmarks** created during PRD #454's design phase carry `created_by: "dev@local"`. Migration policy at the auth-cutover for production is recorded in [[queue]].
- **Ghostty/macOS bash 3.2 quirk**: `wait -n` doesn't exist; the `lucida-dev` script polls in a loop instead. Doesn't affect the auth subsystem itself but bites anyone scripting around it.

## Related

- [[decisions/0015-server-stored-bookmarks-and-auth-seam]] — defines the `AuthPrincipal` contract this subsystem implements
- [[decisions/0016-backend-mediated-oauth-with-session-cookies]] — flow choice + cookie rationale
- [[decisions/0017-configurable-from-day-one-for-oss-release]] — OSS posture for env-driven config
- [[decisions/0018-auth-mode-auto-detect-by-bind-address]] — bind-address safety model
- [[flows/auth-signin]] — end-to-end sign-in trace
- [[gotchas/oss-config-defaults]] — env-var contract and common misconfigurations
- [[lucida-server]] — the crate this subsystem lives in
