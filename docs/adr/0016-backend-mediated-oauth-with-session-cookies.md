# Backend-Mediated OAuth with Session Cookies

Status: Accepted.

## Context

lucida is a single-page app with a backend, and both REST calls and the WebSocket need authentication. Two OAuth shapes fit. The backend can run the authorization-code flow and hand the browser a session cookie, or the SPA can run authorization code with PKCE itself and keep a token in `localStorage`.

## Decision

The backend runs the OAuth 2.0 authorization-code flow and holds the client secret. Sessions are opaque ids stored server-side in a `login_sessions` table. The cookie carries only the id, never identity claims, and the browser never sees a token. The client's only notion of "signed in" is whether `GET /auth/whoami` returns 200 or 401. WebSocket upgrades carry the same cookie, which the browser sends on same-origin upgrades.

The cookie is `HttpOnly`, `Secure` (detected from the request scheme), `SameSite=Lax`, and `Path=/`, with `Max-Age` equal to the session hard cap. Sessions expire after 7 days idle or 30 days total, both configurable. There are no refresh tokens. The ID token is read once at login for email and name, the session row holds them afterwards, and the scope stays `openid email profile`.

CSRF protection rests on `SameSite=Lax` plus one invariant: GET endpoints have no side effects. `Lax` withholds the cookie on cross-site POST, PATCH, and DELETE and still sends it on top-level navigations, so a shared view link opened from another site arrives signed in.

## Rejected alternatives

- SPA authorization code with PKCE. A token reachable from JavaScript is an XSS target through any compromised dependency. Browsers cannot set headers on a WebSocket upgrade, so the token would go in a query string, and into logs, or an inline handshake. Refresh would run in the client, with races across tabs and sleeping laptops.
- `SameSite=Strict`. A link from another site would arrive without the cookie and force a sign-in even for a user who is signed in.
- Stateless JWTs with no session table. Sessions could not be revoked before expiry, so logout and removing a departed user would not take effect.
- Refresh tokens with periodic re-validation. Nothing calls provider APIs on the user's behalf, so they would add a code path with no use.

## Consequences

Someone removed from the allowed organization keeps access until their session expires, up to the hard cap. An open WebSocket is checked only at upgrade, so it outlives session expiry until it reconnects.
