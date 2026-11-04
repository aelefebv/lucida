# Post-Logout Marker Cookie + `prompt=select_account`

Status: Accepted.

## Context

Re-auth is meant to be frictionless ([0016](0016-backend-mediated-oauth-with-session-cookies.md)). An unauthenticated page bounces the browser through `/auth/start` to Google, and Google passes a user with a live Google session straight through. That is right for a cold visit or an expired session and wrong after an explicit sign-out: the page reloads and the user is signed straight back in. A flag held only in the SPA does not survive a refresh, which goes through the server's auto-bouncing landing. The signal has to live server-side, in a form that survives refreshes, new tabs, and bookmark clicks.

## Decision

Each auth mode declares where sign-out goes. `AuthMode::sign_out_url` returns an optional URL from an exhaustive match, so a new mode must answer before it compiles. `GET /auth/mode` publishes it, and the client draws the sign-out control only when there is one. Disabled mode has no session and answers with no URL. `/auth/logout` stays mounted and idempotent in every mode for clients still running an older bundle.

For Google, `/auth/logout` clears the session and sets a `lucida_signed_out=1` marker cookie with a 10-minute TTL. The marker carries no identity and has the same attributes as the session cookie. It drives three things:

1. Unauthenticated HTML requests get a static "Signed out, sign in again" page instead of the auto-bouncing landing. Its sign-in link keeps the current path and hash, so a saved view survives the round trip.
2. Unauthenticated JSON requests (the SPA's `/auth/whoami`) get `signedOut: true` in the 401 body, and the SPA renders the same card. This covers dev, where Vite serves `/` and the server's HTML landing never reaches the browser.
3. `/auth/start` adds `prompt=select_account`, so Google shows the account chooser instead of passing through.

The marker is cleared in `/auth/callback` on success, not in `/auth/start`, so a user who abandons the chooser and comes back still gets the static page and the chooser. The TTL is a backstop. After it, the next visit is treated as cold.

Responses that set the session and the marker together emit two `Set-Cookie` headers through `AppendHeaders`, because Axum's tuple form silently keeps only the last header of a given name.

## Rejected alternatives

- `prompt=select_account` on every `/auth/start`. It adds a click to every cold visit and every shared-link open, the flow 0016 kept frictionless.
- A distinct `/auth/signed-out` landing URL. A refresh at `/` after sign-out bypasses it.
- The server landing alone, with no `signedOut` in the SPA. Fails in dev, where the SPA boots before the server can serve its landing for `/`.
- Clearing the marker in `/auth/start`. Abandoning the chooser silently undoes the sign-out.
- `prompt=login`. It forces password entry, too heavy for switching or confirming an account.
- `prompt=consent`. It only matters when scopes change.
- Federated logout through Google. No tokens are stored to revoke, and Google's logout signs the user out of every Google service.
- A marker with no `Max-Age`. It would persist through hours of idle browsing in the same window.
