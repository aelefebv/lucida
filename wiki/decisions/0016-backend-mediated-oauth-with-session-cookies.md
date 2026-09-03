---
type: Decision
title: "Backend-Mediated OAuth with Session Cookies"
description: "Lucida's authentication uses backend-mediated OAuth 2.0 Authorization Code flow with server-side session cookies, not the SPA-with-JWT pattern."
tags: [lucida, decision]
source_path: wiki/decisions/0016-backend-mediated-oauth-with-session-cookies.md
created: 2026-05-08
modified: 2026-09-03
---

# Backend-Mediated OAuth with Session Cookies

> Status: Accepted (implemented; PRD #455). The auth subsystem lives in `lucida-server/src/auth/`.

## Decision

Lucida's authentication uses **backend-mediated OAuth 2.0 Authorization Code flow with server-side session cookies**, not the SPA-with-JWT pattern. Concretely:

- The server (`lucida-server`) holds the OAuth client secret and runs the authorization code exchange.
- Sessions are server-stored opaque IDs in a `login_sessions` SQLite table; the cookie carries only the session ID, never identity claims.
- The web client never touches JWTs or refresh tokens. Its sole notion of "logged in" is "did `GET /auth/whoami` return 200 or 401."
- WebSocket upgrades use the same `lucida_session` cookie (sent automatically by the browser on same-origin upgrades).
- Cookie attributes: `HttpOnly`, `Secure` (auto-detected by request scheme), `SameSite=Lax`, `Path=/`, `Max-Age` matching the session hard cap.
- Session lifetime: 7-day idle timeout + 30-day hard cap. No refresh tokens in v1 — re-auth at session expiry.

Implementation specifics live in PRD #455.

## Why

The two viable OAuth flows for a SPA + backend application:

- **Backend-mediated** (chosen): server runs the OAuth flow; web client only ever sees session cookies.
- **SPA Authorization Code with PKCE**: web client runs the entire OAuth flow itself, stores the JWT in `localStorage`, sends it as a Bearer header (or query param for WebSocket).

Backend-mediated won on four grounds:

1. **Tokens never touch JavaScript.** `httpOnly` cookies are immune to XSS exfiltration. Lucida's web client pulls in many transitive JS dependencies (vite, react, all their downstream packages); any compromised dep in that graph becomes a token-stealer in the SPA-with-JWT model. With cookies, even full XSS doesn't read the auth token.
2. **WebSocket auth is automatic.** Browsers send cookies on WS upgrade (HTTP Upgrade is just an HTTP request). With SPA-with-JWT, browsers can't set custom headers on WS upgrade, so authentication needs an inline handshake protocol or a query param (which leaks tokens to logs). Cookies sidestep this entirely.
3. **Refresh logic is server-side.** Client-side refresh timers have classic edge cases: refreshing while parallel requests are in flight, multiple tabs racing to refresh, timer drift on sleeping laptops, refresh token expiry mid-refresh. None of these matter with server-side handling. (Moot in v1 since we don't have refresh tokens, but the architecture accommodates them cleanly.)
4. **Server is already gaining persistent state.** [Server-Stored Bookmarks and the AuthPrincipal Seam](0015-server-stored-bookmarks-and-auth-seam.md) introduces SQLite for bookmarks. Adding `login_sessions` to the same database is incremental, not a new architectural commitment.

The CSRF concern with cookies is well-handled by `SameSite=Lax` + REST discipline (no GET side effects). `Lax` blocks cookies on cross-origin POST/PATCH/DELETE while still allowing cross-origin GET top-level navigations — so saved-views link clicks from Slack ([URL-as-App-State for Saved Views](0013-url-as-app-state-for-saved-views.md)) work seamlessly without the user having to re-auth on first click.

## Why no refresh tokens in v1

Google ID tokens expire in ~1 hour. Refresh tokens (granted via `access_type=offline`) extend that. But for our backend-mediated flow, **we only use the ID token once** — at login, to extract email and display name. After that, the `LoginSession` row holds those values; we don't re-validate against Google for each request.

So refresh tokens would matter only if we wanted to:
- Periodically re-validate that the user is still in the org (they could have been removed since login).
- Refresh stale profile data (display name change, new picture).
- Call Google APIs on behalf of the user (we don't, in v1).

For v1, none of these are immediate. Skipping refresh tokens keeps the OAuth scope minimal (`openid email profile`, no `access_type=offline`) and removes the entire token-refresh code path.

The trade-off: if someone leaves the org mid-session, they retain access until their session expires (up to 30 days worst case). Acceptable for an internal research tool; if the deployment's posture later demands faster revocation, v2 adds refresh + periodic re-check.

## Alternatives considered

- **SPA Authorization Code with PKCE.** Rejected for the four reasons above — XSS exposure, awkward WebSocket auth, client-side refresh fragility, no architectural advantage.
- **Backend-mediated with `SameSite=Strict` cookies.** Rejected — would break the saved-views cross-site click flow (someone clicks a `#b=ID` link from Slack → cookie not sent on first request → forced re-auth even if signed in). UX cost too high for the marginal CSRF benefit over `Lax`.
- **Stateless JWTs with server-side validation but no session table.** Rejected — gives up the ability to invalidate sessions before token expiry (logout, force-disconnect departed users). The `login_sessions` table also enables future per-session diagnostics (last-seen IP, user-agent).

## Consequences

- **First persistent state in `lucida-server`** (jointly with [Server-Stored Bookmarks and the AuthPrincipal Seam](0015-server-stored-bookmarks-and-auth-seam.md)). Operational impact: server now needs a writable directory for SQLite, with backup considerations.
- **REST endpoints gain auth middleware.** All non-`/auth/` endpoints require a valid session; 401 on missing/expired. Existing endpoints (`/api/browse`, `/admin/clear-proxy-cache`) are auto-wrapped.
- **WebSocket upgrade gains auth check.** Cookie validated at upgrade time; rejected with close frame on failure. Mid-connection expiry is *not* enforced in v1 (open WS persists for its lifetime); mitigation tracked for v2.
- **`AuthPrincipal` is now a real per-request value** that handlers can extract. Saved views (PRD #454) and any future feature consume it without knowing about auth providers.
- **CSRF posture depends on REST discipline.** GET endpoints must remain side-effect-free for `SameSite=Lax` cookies to be sufficient CSRF protection. Worth recording as an invariant.
- **Pre-auth `dev@local` bookmarks** (created during PRD #454's design phase) need a migration policy at cutover; recorded in Queue — Open Questions.

## How this decision shows up in code

- `lucida-server::auth::session_store` — `LoginSessionStore` trait + the row type (`LoginSession` with id/email/display_name/picture_url/created_at/last_used_at/expires_at). Object-safe so the extractor holds `Arc<dyn LoginSessionStore>`.
- `lucida-server::auth::session_store_sqlite::SqliteSessionStore` — production backend; `WAL` journal for non-blocking touch writes; pool of 5; migrations bundled at compile time.
- `lucida-server::auth::session_store_memory::MemorySessionStore` — in-memory store used by unit and integration tests.
- `lucida-server::auth::pending_auth*` — parallel trio for the in-flight OAuth `state` token (`PendingAuthStore` trait, SQLite + memory backends). `consume` is atomic single-use to prevent state replay.
- `lucida-server::auth::middleware::auth_middleware` — axum layer that runs the configured `PrincipalExtractor`, attaches `AuthPrincipal` to request extensions on success, and returns either the unauth-landing HTML (browsers) or bare JSON 401 (API clients) on failure.
- `lucida-server::auth::handlers` — `/auth/whoami`, `/auth/logout`, `/auth/mode` (the sign-out URL the configured mode declares, per [Post-Logout Marker Cookie](0019-post-logout-marker-cookie-and-prompt-select-account.md)), `/auth/start`, `/auth/callback`, `/auth/error` (slice 5 user-fixable rejection page), and the dev-only `/auth/dev/login` (gated on disabled mode plus a loopback bind; see [Auth Mode Auto-Detect by Bind Address](0018-auth-mode-auto-detect-by-bind-address.md)).
- `lucida-server::auth::google_oauth::GoogleOAuthClient` — authorization-URL builder, token-endpoint POST, JWKS cache (24 h TTL + on-validation-failure refresh), JWT validation. Slice 8 distinguishes `OAuthError::Network` from `OAuthError::CodeExchange` so the audit-log dashboard can split "Google rejected our code" from "we couldn't reach Google."
- `lucida-server::auth::cookie` — single source of truth for the `Set-Cookie` attribute set (`HttpOnly`, `Secure` auto-detected, `SameSite=Lax`, `Path=/`, `Max-Age` matching the hard cap).
- `lucida-server::auth::cleanup` — slice 8's hourly background sweep that drops expired session and pending-auth rows. Spawned at startup; warm-up of 60s before the first sweep.
- `lucida-server::auth::extractors::AdminRequired` — slice 6 axum extractor: pulls the principal from extensions and 403s when `!is_admin`.
- `lucida-core::auth_principal::AuthPrincipal` — the type handlers see; provider-agnostic.

## Related

- [Server-Stored Bookmarks and the AuthPrincipal Seam](0015-server-stored-bookmarks-and-auth-seam.md) — defines the `AuthPrincipal` contract this ADR's implementation provides
- [Configurable From Day One for OSS Release](0017-configurable-from-day-one-for-oss-release.md) — OSS configurability for the auth implementation
- [Auth Mode Auto-Detect by Bind Address](0018-auth-mode-auto-detect-by-bind-address.md) — dev-mode bypass safety model
- PRD #455 — implementation specification
- PRD #454 — saved views, the immediate downstream feature unblocked by this work
