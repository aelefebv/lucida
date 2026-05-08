---
created: 2026-05-08
modified: 2026-05-08
---

# Backend-Mediated OAuth with Session Cookies

> Status: Proposed (in design — feature not yet implemented; PRD #455).

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
4. **Server is already gaining persistent state.** [[decisions/0015-server-stored-bookmarks-and-auth-seam]] introduces SQLite for bookmarks. Adding `login_sessions` to the same database is incremental, not a new architectural commitment.

The CSRF concern with cookies is well-handled by `SameSite=Lax` + REST discipline (no GET side effects). `Lax` blocks cookies on cross-origin POST/PATCH/DELETE while still allowing cross-origin GET top-level navigations — so saved-views link clicks from Slack ([[decisions/0013-url-as-app-state-for-saved-views]]) work seamlessly without the user having to re-auth on first click.

## Why no refresh tokens in v1

Google ID tokens expire in ~1 hour. Refresh tokens (granted via `access_type=offline`) extend that. But for our backend-mediated flow, **we only use the ID token once** — at login, to extract email and display name. After that, the `LoginSession` row holds those values; we don't re-validate against Google for each request.

So refresh tokens would matter only if we wanted to:
- Periodically re-validate that the user is still in the org (they could have been removed since login).
- Refresh stale profile data (display name change, new picture).
- Call Google APIs on behalf of the user (we don't, in v1).

For v1, none of these are immediate. Skipping refresh tokens keeps the OAuth scope minimal (`openid email profile`, no `access_type=offline`) and removes the entire token-refresh code path.

The trade-off: if someone leaves the org mid-session, they retain access until their session expires (up to 30 days worst case). Acceptable for an internal research tool; if Calico's posture later demands faster revocation, v2 adds refresh + periodic re-check.

## Alternatives considered

- **SPA Authorization Code with PKCE.** Rejected for the four reasons above — XSS exposure, awkward WebSocket auth, client-side refresh fragility, no architectural advantage.
- **Backend-mediated with `SameSite=Strict` cookies.** Rejected — would break the saved-views cross-site click flow (someone clicks a `#b=ID` link from Slack → cookie not sent on first request → forced re-auth even if signed in). UX cost too high for the marginal CSRF benefit over `Lax`.
- **Stateless JWTs with server-side validation but no session table.** Rejected — gives up the ability to invalidate sessions before token expiry (logout, force-disconnect departed users). The `login_sessions` table also enables future per-session diagnostics (last-seen IP, user-agent).

## Consequences

- **First persistent state in `lucida-server`** (jointly with [[decisions/0015-server-stored-bookmarks-and-auth-seam]]). Operational impact: server now needs a writable directory for SQLite, with backup considerations.
- **REST endpoints gain auth middleware.** All non-`/auth/` endpoints require a valid session; 401 on missing/expired. Existing endpoints (`/api/browse`, `/admin/clear-proxy-cache`) are auto-wrapped.
- **WebSocket upgrade gains auth check.** Cookie validated at upgrade time; rejected with close frame on failure. Mid-connection expiry is *not* enforced in v1 (open WS persists for its lifetime); mitigation tracked for v2.
- **`AuthPrincipal` is now a real per-request value** that handlers can extract. Saved views (PRD #454) and any future feature consume it without knowing about auth providers.
- **CSRF posture depends on REST discipline.** GET endpoints must remain side-effect-free for `SameSite=Lax` cookies to be sufficient CSRF protection. Worth recording as an invariant.
- **Pre-auth `dev@local` bookmarks** (created during PRD #454's design phase) need a migration policy at cutover; recorded in [[queue]].

## How this decision shows up in code

To be filled in during implementation. Anchors:

- `lucida-server::auth::session_store` — `LoginSessionStore` trait + SQLite implementation.
- `lucida-server::auth::middleware` — axum middleware that runs principal extraction on every request.
- `lucida-server::auth::handlers` — `/auth/start`, `/auth/callback`, `/auth/logout`, `/auth/whoami`.
- `lucida-server::auth::google_oauth` — encapsulates Google integration; the deepest piece.
- `lucida-core::auth_principal` — `AuthPrincipal` struct shared between server and any future Rust client.

## Related

- [[decisions/0015-server-stored-bookmarks-and-auth-seam]] — defines the `AuthPrincipal` contract this ADR's implementation provides
- [[decisions/0017-configurable-from-day-one-for-oss-release]] — OSS configurability for the auth implementation
- [[decisions/0018-auth-mode-auto-detect-by-bind-address]] — dev-mode bypass safety model
- PRD #455 — implementation specification
- PRD #454 — saved views, the immediate downstream feature unblocked by this work
