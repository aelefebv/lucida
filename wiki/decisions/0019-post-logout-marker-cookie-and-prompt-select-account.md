---
type: Decision
title: "Post-Logout Marker Cookie + `prompt=select_account`"
description: "After explicit /auth/logout, lucida-server sets a short-lived"
tags: [lucida, decision]
source_path: wiki/decisions/0019-post-logout-marker-cookie-and-prompt-select-account.md
created: 2026-05-08
modified: 2026-05-08
---

# Post-Logout Marker Cookie + `prompt=select_account`

> Status: Implemented (2026-05-08).

## Decision

After explicit `/auth/logout`, `lucida-server` sets a short-lived
`lucida_signed_out=1` marker cookie alongside the existing
session-clearing cookie. The marker drives three distinct surfaces:

1. **Middleware HTML branch.** Unauthenticated HTML requests with the
   marker get `SIGNED_OUT_LANDING_HTML` (a static "Signed out — Sign in
   again" card) instead of the auto-bouncing `UNAUTH_LANDING_HTML`.
2. **Middleware JSON branch.** Unauthenticated JSON requests (the SPA's
   `/auth/whoami` polling) get the 401 body enriched with `signedOut: true`.
   The SPA reads this, threads it onto `AuthState`, and `UnauthLanding`
   renders its `SignedOutCard` branch — needed in dev where vite serves
   `/` and the static landing HTML never reaches the SPA.
3. **`/auth/start` prompt.** Reads the marker; when present, calls
   `GoogleOAuthClient::authorize_url(&state, Some(Prompt::SelectAccount))`
   so Google's URL carries `&prompt=select_account` and the user sees
   the account chooser instead of silent pass-through.

The marker is **cleared in `/auth/callback` on success** — not in
`/auth/start` — so the user can bail at Google's chooser, return to
lucida, and still get the static-landing + chooser flow on retry.

The marker has a 10-minute TTL as a backstop. Cookie attributes mirror
`lucida_session`: `HttpOnly`, `SameSite=Lax`, `Path=/`, `Secure`
auto-detected.

The SPA's `signOut()` is `await postLogout(); await refresh()`. The
refresh hits the marker-aware whoami, gets `signedOut: true`, and
`AuthGate` renders the static card.

## Why

ADR-0016 chose backend-mediated OAuth with session cookies on the
strength of friction-free re-auth: the unauth landing's JS shim
auto-bounces the browser through `/auth/start` → Google, and Google's
default behavior is silent pass-through if the user's Google session is
still active. Great UX for cold visits and session expiry. Wrong UX for
explicit logout: the user clicks "Sign out," sees the page reload, and
is silently re-authed via the same Google session before they can blink.

The naive fix — a SPA-side `signedOut: true` flag that suppresses the
auto-bounce — only covers the SPA-mounted case. A page refresh after
logout still routes through the server's auto-bouncing landing and
silently re-auths. So the discriminator must live server-side, in a
form that survives refresh / new tab / bookmark click.

A cookie is the natural primitive: it's already lucida's session-state
mechanism, it survives refresh by definition, and it composes with the
existing cookie-driven middleware decision. Two-effect coupling — the
same marker drives both the static-landing branch in middleware *and*
the conditional `prompt=select_account` in `/auth/start` — keeps the
"just signed out" concept localized to one cookie.

`prompt=select_account` is the OpenID Connect parameter Google supports
for "show the account chooser even if I have an active session." It's
the canonical way to give a user a choice point at re-sign-in time
(switch accounts, or confirm "Continue as foo@example.com" with a
deliberate click) without forcing a full password re-entry.

## Why conditional, not always-on

The simpler design would be to always send `prompt=select_account` on
every `/auth/start`. Rejected because it adds an extra click to every
cold visit and every saved-view link click from Slack — exactly the
friction-free flow ADR-0016 was designed to preserve. Calico is small,
all users have one work account; on cold paths, silent pass-through is
the correct UX.

Conditioning on the marker draws the line at "user explicitly opted to
sign out" — the one case where the chooser is unambiguously what they
want.

## Why a marker cookie, not a distinct landing URL

Considered: `/auth/logout` could 302 to `/auth/signed-out` instead of
`/`, with `/auth/signed-out` whitelisted from the unauth-landing path
and serving its own static page.

Rejected because it doesn't survive the user navigating away or
refreshing back at `/`. The user's actual repro is "log out, refresh
the page" — the URL after the refresh is `/`, not `/auth/signed-out`.
A landing URL fixes the symptom on one path; the marker cookie fixes
it on every path.

## Why the SPA-side `signedOut` field is required (not optional)

A first-pass design dropped `signedOut?: boolean` from `AuthState` on
the theory that the server's `SIGNED_OUT_LANDING_HTML` would handle
the post-logout UI on its own — the SPA could just full-reload to `/`
and let the server take over.

That fails in dev. Vite serves `/` directly; the SPA bundle loads,
mounts, and never gives `lucida-server` a chance to render the static
landing for the root URL. The SPA's `UnauthLanding` is what the user
actually sees, and without a `signedOut` signal it auto-bounces back
through Google's still-active session — exactly the bug we set out to
fix. Production avoids the issue (lucida-server serves the bundle from
the same origin), but a design that only works in production is a
design that bites you the first time you test in dev.

Hence: server-side marker drives BOTH surfaces. The HTML landing
covers production cold-load and refresh; the JSON-enriched whoami
covers dev (and any other case where the SPA boots before middleware
sees `GET /`). The two cards (Rust `SIGNED_OUT_LANDING_HTML` + React
`SignedOutCard`) intentionally render the same UX from the same
underlying signal.

## Why clear in callback, not start

A first-pass design cleared the marker in `/auth/start`. The thinking:
"once the user explicitly opts back in, the marker has done its job."

That fails when the user bails at Google's chooser (closes the tab,
clicks back, or anything else short of completing the sign-in). They
return to `/` with no marker — middleware serves the auto-bouncing
landing → `/auth/start` without prompt → Google silent pass-through →
signed in. The logout is silently undone.

Clearing in `/auth/callback` on the success path keeps the marker
load-bearing across the entire "I clicked sign in, then got distracted"
window. If sign-in succeeds, the marker is no longer relevant (the
session cookie is now the source of truth) and we clear it. If
sign-in fails or the user bails, the marker persists and the next
visit gets the static landing + chooser-on-retry behavior.

The 10-minute TTL is the long-tail backstop: if the user logs out
and walks away from their computer for the day, the marker expires
on its own and the next fresh visit behaves like a cold visit.

## Alternatives considered

- **`prompt=login`** (force re-authentication, password re-entry).
  Rejected — too heavyweight for the "let me switch accounts or
  confirm" use case. `prompt=login` is appropriate for security-
  sensitive flows (e.g. before payment); not warranted here.
- **`prompt=consent`** (re-show OAuth consent screen). Rejected —
  only relevant when scopes change.
- **Federated logout via Google's revoke endpoint**. We don't store
  refresh/access tokens past callback (per ADR-0016), so there's
  nothing to revoke. Google's logout URL (`accounts.google.com/Logout`)
  signs the user out of *all* Google services — rude and
  inappropriate.
- **Session cookie (no `Max-Age`) for the marker.** Rejected — sticks
  across hours of idle browsing in the same window, which feels like
  overreach for "you just clicked logout." 10-minute TTL covers the
  realistic "I logged out and refreshed/clicked a bookmark while
  still nearby" window; after that, treating the next visit as cold
  is the correct default.
- **Clear the marker in `/auth/start` instead of `/auth/callback`.**
  Considered first; rejected after testing. See §"Why clear in
  callback, not start" above — the chooser-bail case silently undoes
  the logout.

- **Drop the SPA-side `signedOut` field; rely on full-reload + server
  static landing.** Considered; rejected after testing. See §"Why the
  SPA-side `signedOut` field is required" above — the dev/prod gap
  with vite-served `/` makes this design fail in dev.

## Consequences

- **One additional cookie** in lucida's protocol surface, scoped to
  ~10 minutes after logout. Carries no identity (presence-only
  signal); ADR-0016's "no identity in the cookie" invariant still
  holds.
- **Two response paths in middleware's HTML branch** (auto-bounce vs
  static), discriminated by cookie presence. The JSON branch also
  branches: 401 body now carries `signedOut: bool`. Each is a tiny
  conditional; complexity is bounded.
- **`/auth/start` is no longer purely stateless** — it reads the
  marker (but does not clear it; that's `/auth/callback`'s job).
  Still has no DB writes beyond the existing `pending_auth` insert.
- **`/auth/callback` emits two `Set-Cookie` headers on success** (set
  session + clear marker). Same with `/auth/logout` (clear session +
  set marker). Both required `AppendHeaders` (axum's tuple form
  `[(name, val); N]` silently overwrites duplicate header names;
  Set-Cookie is one of the few headers where multiple emissions are
  mandatory).
- **SPA `AuthState` carries `signedOut?: boolean` populated from the
  enriched whoami response.** `useAuthState.signOut` is `await
  postLogout(); await refresh()`. `UnauthLanding` branches: static
  card when `signedOut`, auto-bounce otherwise.

## How this decision shows up in code

- `lucida-server::auth::cookie::SIGNED_OUT_COOKIE_NAME` —
  `"lucida_signed_out"`. Single source of truth.
- `lucida-server::auth::cookie::SIGNED_OUT_TTL_SECS` — 600.
- `lucida-server::auth::cookie::{build_signed_out_marker, build_clearing_signed_out_marker, read_signed_out_marker}`
  — three helpers mirroring the session-cookie set.
- `lucida-server::auth::unauth_landing::SIGNED_OUT_LANDING_HTML` —
  the static landing. Inline JS rewrites the "Sign in again" link's
  `href` on load to inject `location.pathname + location.search` and
  the captured `location.hash`, so a saved-view URL like
  `/dataset/foo#view=abc` survives the round trip.
- `lucida-server::auth::middleware::unauthenticated_response` — branches
  on `read_signed_out_marker(headers)` for both HTML (which landing
  HTML) and JSON (which 401 body shape).
- `lucida-server::auth::handlers::logout` — emits both clearing-
  session and marker `Set-Cookie` headers via `AppendHeaders`.
- `lucida-server::auth::handlers::auth_start` — reads marker, passes
  `Some(Prompt::SelectAccount)` when present. Does NOT clear the
  marker — that's `/auth/callback`'s job.
- `lucida-server::auth::handlers::auth_callback` — on success path,
  emits both session-set and marker-clear `Set-Cookie` headers via
  `AppendHeaders`. Failure paths leave the marker alone so the user
  can retry.
- `lucida-server::auth::google_oauth::Prompt` — typed enum (single
  `SelectAccount` variant); avoids string typos at the call site,
  localizes future `Login` / `Consent` additions.
- `lucida-web::auth::whoami::fetchAuthState` — parses the enriched
  401 body and propagates `signedOut` onto `AuthState`.
- `lucida-web::auth::useAuthState::signOut` — `await postLogout();
  await refresh();` — the refresh sees the enriched whoami and flips
  state to `{ authenticated: false, signedOut: true }`.
- `lucida-web::auth::UnauthLanding` — branches on `signedOut`: static
  `SignedOutCard` when set, auto-bounce otherwise.

## Related

- [Backend-Mediated OAuth with Session Cookies](0016-backend-mediated-oauth-with-session-cookies.md) —
  the parent ADR; this one extends its logout flow.
- [Flow: Authentication Sign-In](../flows/auth-signin.md) — end-to-end trace, including the explicit-
  logout path this ADR shapes.
- [Authentication](../systems/subsystems/auth.md) — the subsystem this lives in.
