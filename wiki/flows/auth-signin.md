---
created: 2026-05-08
modified: 2026-06-25
---

# Flow: Authentication Sign-In

The path from "user navigates to lucida unauthenticated" to "user lands at the originally-requested URL with a valid `lucida_session` cookie." Same flow handles cold first-visit and post-expiry re-auth.

## Trace: cold first-visit

1. **User navigates** — `https://lucida.example.com/some-path#view=abc` in a fresh browser (no cookie).
2. **Middleware** ([[auth]] `auth/middleware.rs`) — extractor returns `Err(Unauthenticated)`. The middleware's `unauthenticated_response` branches on `Accept`:
   - HTML route → returns inline `UnauthLanding` HTML page (status 200, body is the JS shim).
   - API route → bare 401 JSON.
3. **JS shim runs** in the unauth landing page:
   - Captures `location.hash` (browser-only — never sent to the server).
   - `window.location.replace("/auth/start?path=" + encodeURIComponent(location.pathname + location.search) + "&hash=" + encodeURIComponent(location.hash.slice(1)))` — `replace` keeps the landing page out of history.
4. **`GET/POST /auth/start`** (shim navigates via GET; both methods registered) ([[lucida-server]] `auth/handlers.rs::auth_start`):
   - Generates a 256-bit random `state` token (URL-safe base64).
   - INSERTs `pending_auth` row with `{state_token, intended_path, intended_hash, created_at}`.
   - Builds Google authorization URL: `https://accounts.google.com/o/oauth2/v2/auth?response_type=code&client_id=…&redirect_uri=…&scope=openid email profile&state=<token>`.
   - 302s the browser to that URL.
5. **Google sign-in** — Google handles its own UX. Already-signed-in users typically pass through with no clicks; first-time users see Google's consent screen.
6. **Google callback** — Google 302s the browser to `https://lucida.example.com/auth/callback?code=…&state=<token>`.
7. **`GET /auth/callback`** (`auth/handlers.rs::auth_callback`):
   - Validates state token: `pending_auth.consume(state)` (atomic single-use via `DELETE … RETURNING`). Missing/expired/already-used → 302 to `/auth/error?code=auth_failed` with `auth.signin.error.state_mismatch` log.
   - Exchanges code with Google: POST to `https://oauth2.googleapis.com/token` via `reqwest`. Failure → 302 to error with `auth.signin.error.code_exchange`.
   - Validates JWT: signature against cached JWKS, standard claims (`iss`, `aud`, `exp`). JWKS cache miss triggers refresh; failure → 302 to error with `auth.signin.error.jwt_invalid`.
   - Applies rejection policy via `principal_or_rejection_from_claims`:
     - `email_verified == false` → 302 to `/auth/error?code=unverified&attempted_email=…` with `auth.signin.rejected.unverified`.
     - `hd` claim missing or not in `LUCIDA_ALLOWED_HOSTED_DOMAINS` (when set) → 302 to `/auth/error?code=hd_mismatch&attempted_email=…&allowed_domains=…` with `auth.signin.rejected.hd_mismatch`.
   - On accept: `LoginSessionStore::create({email, display_name, picture_url, expires_at})`. Computes `is_admin` from `LUCIDA_ADMIN_EMAILS`.
   - Sets `lucida_session` cookie via `build_session_cookie` (HttpOnly, Secure auto-detected, SameSite=Lax, Path=/, Max-Age=hard_cap).
   - 302 to `intended_path` with `intended_hash` re-prefixed (e.g. `/some-path#view=abc`).
8. **Browser navigates** to the original URL with hash. AuthGate calls `/auth/whoami`, gets 200 with the principal, renders the app. Saved-views applier picks up `#view=abc` and applies the captured view.

End-to-end latency: dominated by Google's response time (typically 200–800ms for an already-signed-in user, longer for first-time consent).

## Trace: post-expiry re-auth

User has been idle past the 7-day idle window. Next request triggers a 401 from middleware (session row past `last_used_at + idle`). Browser receives the unauth landing HTML; flow re-enters at step 3 above. Hash is preserved if the user was on a saved-view URL.

## Trace: explicit logout

Different shape. `POST /auth/logout` (`auth/handlers.rs::logout`):
1. Reads cookie, calls `LoginSessionStore::delete(id)`.
2. Emits TWO `Set-Cookie` headers (via `AppendHeaders`):
   - `lucida_session=; Max-Age=0; Path=/; …` — clears the session cookie.
   - `lucida_signed_out=1; Max-Age=600; HttpOnly; SameSite=Lax; Path=/; …` — sets the marker cookie (per [[decisions/0019-post-logout-marker-cookie-and-prompt-select-account]]).
3. 302 to `/`.

The SPA's `useAuthState.signOut` then `await refresh()`, which re-fetches `/auth/whoami`. The marker-aware middleware returns 401 with body `{ "error": "unauthenticated", "signedOut": true }`. The SPA threads `signedOut: true` onto `AuthState`; `AuthGate` re-renders `<UnauthLanding signedOut />`, which renders a static "Signed out — Sign in again" card instead of auto-bouncing.

In production (lucida-server serves the SPA bundle), a hard refresh routes through the marker-aware middleware HTML branch and gets `SIGNED_OUT_LANDING_HTML` directly — same UX, server-rendered. In dev (vite serves `/`), refresh re-bootstraps the SPA, which re-runs whoami, gets the same `signedOut: true`, and renders the React `SignedOutCard`. Both surfaces converge on the same UX from the same underlying signal.

When the user clicks "Sign in again," `/auth/start` reads the marker:
- Calls `authorize_url(&state, Some(Prompt::SelectAccount))` so Google's URL gets `&prompt=select_account` — Google shows the account chooser instead of silently passing through its still-active session.
- Does NOT clear the marker. The marker stays set so a chooser-bail (close tab, click back) followed by return to lucida still hits the static landing → chooser flow.

The marker is **cleared in `/auth/callback` on success**, alongside the new session cookie's Set-Cookie (also via `AppendHeaders`). At that point the session cookie is the source of truth; the marker has done its job. Failure paths (`/auth/error?code=…`) leave the marker alone so the user can retry from `/`.

The marker has a 10-minute TTL as a backstop. Without the marker, `/auth/start` behaves exactly as it does on the cold path — no `prompt=`, friction-free silent pass-through.

Why this shape: Google's authorization session typically outlives lucida's. A naive auto-bounce after logout would 302 → `/auth/start` → Google → silent pass-through → callback → fresh lucida session, defeating the user's intent. The marker plus `prompt=select_account` gives the user a deliberate choice point. Clearing the marker only on callback success means a chooser-bail doesn't silently undo the logout. Auto-bounce is still correct for *passive* unauth (session expired mid-tab), where re-auth without a click is the friction-free behavior the user wants — which is why the marker only flips on after explicit logout.

Logout is local-only — no Google revocation, no federation. See [[decisions/0016-backend-mediated-oauth-with-session-cookies]] §"Why local-only logout."

## Cross-origin wrinkle in dev

lucida-server runs on `:9876`; the Vite dev server runs on `:5173`. Without intervention, the browser sees them as separate origins and SameSite=Lax cookies don't flow cross-origin on XHR/fetch. The fix is the Vite proxy in `lucida-web/vite.config.ts` — forwards `/auth`, `/api`, `/admin`, `/ws` to the backend so the browser sees a single origin (`localhost:5173`). Always visit `:5173`, never `:9876` directly.

In production, lucida-server serves the built web bundle from the same origin, so the proxy isn't needed.

## Invariants

- **`state` tokens are single-use.** `PendingAuthStore::consume` atomically deletes the row; replay attempts return missing. Prevents OAuth state-replay attacks.
- **The state token is the only CSRF protection on the OAuth flow.** Don't accept callbacks with no state, or with state values not in `pending_auth`.
- **`intended_hash` is captured client-side.** Hash fragments never reach the server; the JS shim is the only opportunity to record them. If the shim fails to run (JS disabled, CSP blocking, etc.), the redirect after auth lands at `intended_path` without the hash. Acceptable degradation — the path itself still routes correctly.
- **Cookie is set on the same origin as the callback URL.** The `LUCIDA_OAUTH_REDIRECT_URI` env var must match what's registered in Google Console AND must match the origin the user lands on. Mismatch → cookie set on the wrong origin → user sees themselves as still unauthed → infinite redirect loop.
- **Hard cap is checked alongside idle.** A session active continuously for 30 days still expires; the user signs in again.

## Failure modes

| What goes wrong | User sees | Log event |
|---|---|---|
| Google unreachable / network failure | Generic "Authentication failed" page | `auth.signin.error.network` |
| State token mismatch (cookie expired between start + callback, or attack) | Generic "Authentication failed" page | `auth.signin.error.state_mismatch` |
| Code exchange returns error from Google | Generic "Authentication failed" page | `auth.signin.error.code_exchange` |
| JWT signature invalid | Generic "Authentication failed" page | `auth.signin.error.jwt_invalid` |
| `email_verified == false` | "Your Google account's email isn't verified..." | `auth.signin.rejected.unverified` |
| `hd` claim doesn't match allowlist | "lucida is restricted to {allowed_domains}..." | `auth.signin.rejected.hd_mismatch` |
| SQLite write fails | Generic "Authentication failed" page | `auth.signin.error.session_store` (or similar) |

User-fixable problems get specific actionable messages (`hd_mismatch`, `unverified`); system-side and potential-attack problems get deliberately vague messages (don't aid reconnaissance). All errors logged server-side with full detail.

## Related

- [[auth]] — the subsystem this flow lives in
- [[decisions/0016-backend-mediated-oauth-with-session-cookies]] — design rationale for the flow shape
- [[decisions/0018-auth-mode-auto-detect-by-bind-address]] — when this flow is active vs the stub
- [[gotchas/oss-config-defaults]] — common misconfigurations of the env-var surface
