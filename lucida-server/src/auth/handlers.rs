//! Auth HTTP handlers.
//!
//! Slice 2 (PRD #455) landed `/auth/whoami` (kept from slice 1). Slice
//! 3 (issue #459) lands `/auth/logout`. Slice 4 (issue #460) lands the
//! OAuth flow: `/auth/start` and `/auth/callback`. `/auth/error`
//! arrives in slice 5. PRD #527 retires the dev-login handler in
//! favour of [`crate::auth::principal::StubPrincipalExtractor`] —
//! disabled mode now yields the dev principal directly out of the
//! middleware rather than requiring a session-minting POST.

use std::sync::Arc;

use axum::Extension;
use axum::extract::{Query, State};
use axum::http::header::{LOCATION, SET_COOKIE};
use axum::http::{Request, StatusCode};
use axum::response::{AppendHeaders, IntoResponse, Json, Response};
use base64::Engine;
use chrono::{Duration as ChronoDuration, Utc};
use serde::Deserialize;
use serde_json::json;
use tracing::{error, info, warn};

use lucida_core::auth_principal::AuthPrincipal;

use super::config::AuthConfig;
use super::cookie::{
    build_clearing_cookie, build_clearing_signed_out_marker, build_session_cookie,
    build_signed_out_marker, read_session_cookie, read_signed_out_marker, request_is_https,
};
use super::google_oauth::{GoogleOAuthClient, OAuthError, Prompt};
use super::pending_auth::{PendingAuth, PendingAuthStore};
use super::principal::{RejectionReason, principal_or_rejection_from_claims};
use super::session_store::{LoginSession, LoginSessionStore};

/// `GET /auth/whoami` — returns the current `AuthPrincipal` JSON when
/// the auth middleware attached one, or 401 otherwise. The middleware
/// itself answers 401 before the handler runs in the missing-cookie
/// case; this fallback covers the (currently unreachable) edge of the
/// route being mounted without the middleware.
pub async fn whoami(principal: Option<Extension<AuthPrincipal>>) -> Response {
    match principal {
        Some(Extension(p)) => Json(p).into_response(),
        None => (
            StatusCode::UNAUTHORIZED,
            Json(json!({ "error": "unauthenticated" })),
        )
            .into_response(),
    }
}

/// State for `/auth/logout`. Carries just the pieces logout needs so
/// tests don't need to construct the full `AppState`. Logout reads the
/// cookie, deletes the session row (if present), and writes a clearing
/// cookie back.
#[derive(Clone)]
pub struct LogoutState {
    pub config: Arc<AuthConfig>,
    pub store: Arc<dyn LoginSessionStore>,
}

/// `POST /auth/logout` — local-only sign-out.
///
/// Idempotent: the response shape (302 + clearing cookie) is identical
/// whether or not the request carried a valid session cookie, so the
/// web client can call it without first checking auth state. We
/// deliberately do **not** federate to Google's revoke endpoint — see
/// `wiki/decisions/0016-backend-mediated-oauth-with-session-cookies.md`
/// §"Logout" for the rationale (the ID token isn't held past login).
///
/// Returns 302 to `/`. fetch() in the web client follows redirects by
/// default but the body of `/` is irrelevant — useAuthState refreshes
/// via `/auth/whoami` after the call resolves, which then returns 401.
pub async fn logout<B>(State(state): State<LogoutState>, req: Request<B>) -> Response {
    let (parts, _body) = req.into_parts();
    let session_id = read_session_cookie(&parts, &state.config.cookie_name);

    // Try to look up the email for the audit log before deletion. We
    // don't fail logout when the lookup errors — the deletion attempt
    // (and the cookie clear) still need to happen. Storage errors
    // surface in tracing but not to the client.
    let email = match &session_id {
        Some(id) => match state.store.get(id).await {
            Ok(Some(row)) => Some(row.email),
            Ok(None) => None,
            Err(e) => {
                tracing::warn!(error = %e, "logout.lookup_email.failed");
                None
            }
        },
        None => None,
    };

    if let Some(id) = session_id.as_deref()
        && let Err(e) = state.store.delete(id).await
    {
        // Even on store failure, fall through to clear the cookie.
        // Worst case the row lingers until the slice-8 sweep; the
        // browser is forced unauthenticated immediately, which is
        // the user-visible promise of logout.
        tracing::error!(error = %e, "logout.delete_session.failed");
    }

    // Always emit the audit event so the absence of a row in the audit
    // log distinguishes "user never clicked sign-out" from "endpoint
    // hit but storage hiccuped." Email may be None for cookieless
    // calls or expired/unknown sessions; that's fine — slice 8 will
    // expand the audit shape, this slice just lands the event.
    info!(
        email = email.as_deref().unwrap_or("<unknown>"),
        "auth.logout"
    );

    // Two Set-Cookie headers: clear `lucida_session`, and set the
    // `lucida_signed_out` marker. The marker survives the page refresh
    // that would otherwise route through the auto-bouncing unauth
    // landing → Google's still-active session → silent re-auth.
    // Middleware consumes it (serves the static landing) and
    // `/auth/start` clears it on user-initiated re-sign-in.
    //
    // `AppendHeaders` (not `[(name, val); N]`) — Set-Cookie is one of
    // the few headers that legitimately needs multiple emissions; the
    // array form would silently overwrite the second on the first.
    let is_https = request_is_https(&parts);
    let clearing = build_clearing_cookie(&state.config, is_https);
    let marker = build_signed_out_marker(&state.config, is_https);
    (
        StatusCode::FOUND,
        AppendHeaders([(SET_COOKIE, clearing), (SET_COOKIE, marker)]),
        [(LOCATION, "/".to_string())],
    )
        .into_response()
}

// -- /auth/start + /auth/callback (slice 4) -------------------------------

/// State for the OAuth-flow handlers. Mirrors the `LogoutState`
/// pattern: only the wiring each handler actually needs, so unit
/// tests can construct it without standing up the full `AppState`.
#[derive(Clone)]
pub struct OAuthState {
    pub config: Arc<AuthConfig>,
    pub session_store: Arc<dyn LoginSessionStore>,
    pub pending_store: Arc<dyn PendingAuthStore>,
    pub google: Arc<GoogleOAuthClient>,
}

/// Body / query payload accepted by `/auth/start`. Both shapes flow
/// into the same `StartRequest`: the JS shim POSTs JSON, the
/// noscript fallback hits with query params. Hash defaults to `""` so
/// callers omitting it (CLI, tests) don't have to think about it.
#[derive(Debug, Deserialize, Default)]
pub struct StartRequest {
    #[serde(default)]
    pub path: Option<String>,
    #[serde(default)]
    pub hash: Option<String>,
}

/// `POST /auth/start` (also accepts `GET` for the noscript fallback
/// from the unauth landing).
///
/// Generates a 256-bit state token, stashes the intended path + hash
/// in `pending_auth`, and 302s to Google's authorization URL with the
/// token in the `state` parameter. Per ADR-0013 the hash is captured
/// here so a `#view=…` link survives the redirect round-trip.
///
/// When the inbound request carries the `lucida_signed_out` marker
/// cookie (set by `/auth/logout`), this handler asks Google to show
/// the account chooser (`prompt=select_account`) instead of silently
/// passing through its still-active session.
///
/// **The marker is NOT cleared here.** It's cleared in `/auth/callback`
/// on success. If the user bails out at Google's chooser (closes the
/// tab, clicks back) and returns to lucida, the marker must still be
/// in place so the next `/auth/start` also sends `prompt=select_account`
/// — otherwise we'd silently re-auth them via Google's still-active
/// session, defeating the logout. See ADR-0019 §"Why clear in callback,
/// not start."
///
/// Cold-path callers (no marker) get the friction-free silent
/// pass-through Google does when it has an active session — that's the
/// design intent for first-visit and post-expiry re-auth (ADR-0016).
pub async fn auth_start(
    State(state): State<OAuthState>,
    Query(query): Query<StartRequest>,
    req: Request<axum::body::Body>,
) -> Response {
    let (parts, body) = req.into_parts();

    let had_signed_out_marker = read_signed_out_marker(&parts.headers);

    // Re-extract the JSON body via axum's own deserializer rather than
    // listing it in the handler args (which would be Option<Json<…>>
    // and fight with the consumed-Request shape we need for cookie
    // reading). For the noscript GET fallback, body is empty/missing
    // and the JSON parse harmlessly fails, falling through to query
    // params.
    let json_payload: StartRequest = match axum::body::to_bytes(body, 64 * 1024).await {
        Ok(bytes) if !bytes.is_empty() => serde_json::from_slice(&bytes).unwrap_or_default(),
        _ => StartRequest::default(),
    };
    let path = first_nonempty(&[json_payload.path.as_deref(), query.path.as_deref()])
        .unwrap_or("/")
        .to_string();
    let hash = first_nonempty(&[json_payload.hash.as_deref(), query.hash.as_deref()])
        .unwrap_or("")
        .to_string();

    let state_token = random_state_token();
    let now = Utc::now();
    if let Err(e) = state
        .pending_store
        .insert(PendingAuth {
            state_token: state_token.clone(),
            intended_path: path,
            intended_hash: hash,
            created_at: now,
        })
        .await
    {
        error!(error = %e, "auth.signin.start.pending_insert_failed");
        return (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(json!({ "error": "internal" })),
        )
            .into_response();
    }

    let prompt = had_signed_out_marker.then_some(Prompt::SelectAccount);
    let url = state.google.authorize_url(&state_token, prompt);
    info!(reauth = had_signed_out_marker, "auth.signin.start");
    (StatusCode::FOUND, [(LOCATION, url)]).into_response()
}

/// Query params Google redirects back with. We only use `code` and
/// `state`; Google may also send `scope`, `authuser`, etc, all of
/// which we ignore.
#[derive(Debug, Deserialize)]
pub struct CallbackQuery {
    pub code: Option<String>,
    pub state: Option<String>,
    /// Google sets this on user-cancel ("access_denied") or other
    /// upstream errors. We surface it in the log and 400 the request.
    pub error: Option<String>,
}

/// `GET /auth/callback?code=…&state=…`
///
/// Validates the state token, exchanges the code with Google,
/// validates the JWT, applies slice-5's hosted-domain + email_verified
/// checks, mints a `LoginSession`, sets the cookie, and 302s to the
/// originally-captured path + hash.
///
/// Slice 5 (PRD #455 §"Error UX") changes the failure shape: instead
/// of returning JSON 4xx/5xx (slice 4 default), every failure 302s to
/// `/auth/error?code=…`. Two flavors:
///
/// * `code=hd_mismatch` / `code=unverified` — user-fixable rejections
///   from the slice-5 policy. Detail params (attempted_email,
///   allowed_domains) included so the page can render the actionable
///   message from the PRD.
/// * `code=auth_failed` — every other error path (state mismatch,
///   code exchange failure, JWT invalid, store failure). Deliberately
///   vague to the user; logs hold details server-side.
pub async fn auth_callback(
    State(state): State<OAuthState>,
    Query(query): Query<CallbackQuery>,
    req: Request<axum::body::Body>,
) -> Response {
    let (parts, _body) = req.into_parts();

    if let Some(err) = query.error.as_deref() {
        // User cancelled or Google bailed before issuing a code. Same
        // generic page as other auth_failed branches; logs differ.
        warn!(error = %err, "auth.signin.callback.upstream_error");
        return redirect_to_error(&[("code", "auth_failed")]);
    }

    let code = match query.code.as_deref() {
        Some(c) if !c.is_empty() => c,
        _ => {
            warn!("auth.signin.callback.missing_code");
            return redirect_to_error(&[("code", "auth_failed")]);
        }
    };

    let state_token = match query.state.as_deref() {
        Some(s) if !s.is_empty() => s,
        _ => {
            warn!("auth.signin.error.state_mismatch");
            return redirect_to_error(&[("code", "auth_failed")]);
        }
    };

    let pending = match state.pending_store.consume(state_token).await {
        Ok(Some(row)) => row,
        Ok(None) => {
            // Missing or already-used. The named log event the slice's
            // acceptance criteria call out.
            warn!(state = %state_token, "auth.signin.error.state_mismatch");
            return redirect_to_error(&[("code", "auth_failed")]);
        }
        Err(e) => {
            error!(error = %e, "auth.signin.callback.pending_consume_failed");
            return redirect_to_error(&[("code", "auth_failed")]);
        }
    };

    let claims = match state.google.exchange_and_validate(code).await {
        Ok(c) => c,
        Err(OAuthError::CodeExchange(detail)) => {
            error!(error = %detail, "auth.signin.error.code_exchange");
            return redirect_to_error(&[("code", "auth_failed")]);
        }
        Err(OAuthError::JwtInvalid(detail)) => {
            error!(error = %detail, "auth.signin.error.jwt_invalid");
            return redirect_to_error(&[("code", "auth_failed")]);
        }
        Err(OAuthError::JwksFetch(detail)) => {
            // Treated as a network-flavored failure: a JWKS fetch only
            // runs at this depth when the cached set is missing the
            // required `kid` and a refresh attempt failed. Surface as
            // network so dashboards group with the new `network` event.
            error!(error = %detail, "auth.signin.error.network");
            return redirect_to_error(&[("code", "auth_failed")]);
        }
        Err(OAuthError::Network(detail)) => {
            error!(error = %detail, "auth.signin.error.network");
            return redirect_to_error(&[("code", "auth_failed")]);
        }
    };

    // Slice 5 policy: email_verified + (optional) hd allowlist. The
    // raw mapping (`principal_from_claims`) is applied inside
    // `principal_or_rejection_from_claims` on accept; on reject we
    // emit the audit event the PRD specifies and bounce to the error
    // page with the structured detail params.
    let principal = match principal_or_rejection_from_claims(
        &claims,
        &state.config.allowed_hosted_domains,
        &state.config.admin_emails,
    ) {
        Ok(p) => p,
        Err(RejectionReason::Unverified { attempted_email }) => {
            warn!(
                attempted_email = %attempted_email,
                "auth.signin.rejected.unverified",
            );
            return redirect_to_error(&[
                ("code", "unverified"),
                ("attempted_email", attempted_email.as_str()),
            ]);
        }
        Err(RejectionReason::HdMismatch {
            attempted_email,
            attempted_hd,
            allowed_domains,
        }) => {
            let allowed_csv = allowed_domains.join(",");
            warn!(
                attempted_email = %attempted_email,
                attempted_hd = %attempted_hd.as_deref().unwrap_or("<none>"),
                allowed_domains = %allowed_csv,
                "auth.signin.rejected.hd_mismatch",
            );
            return redirect_to_error(&[
                ("code", "hd_mismatch"),
                ("attempted_email", attempted_email.as_str()),
                ("allowed_domains", allowed_csv.as_str()),
            ]);
        }
    };

    let now = Utc::now();
    let id = uuid::Uuid::new_v4().to_string();
    let session = LoginSession {
        id: id.clone(),
        email: principal.email.clone(),
        display_name: principal.display_name.clone(),
        picture_url: principal.picture_url.clone(),
        created_at: now,
        last_used_at: now,
        expires_at: now
            + ChronoDuration::from_std(state.config.hard_cap).unwrap_or(ChronoDuration::hours(720)),
    };
    if let Err(e) = state.session_store.create(session).await {
        error!(error = %e, email = %principal.email, "auth.signin.error.session_create");
        return redirect_to_error(&[("code", "auth_failed")]);
    }

    let is_https = request_is_https(&parts);
    let cookie_header = build_session_cookie(&state.config, &id, is_https);
    let target = redirect_target(&pending.intended_path, &pending.intended_hash);
    info!(
        email = %principal.email,
        session_id = %id,
        target = %target,
        "auth.signin.success",
    );

    // Two Set-Cookie headers: set the new session cookie AND clear
    // the `lucida_signed_out` marker (no-op if it wasn't present, but
    // emitting unconditionally keeps the response shape simple). The
    // marker has done its job — the user has successfully re-signed-in.
    // `AppendHeaders` because the array form `[(K, V); N]` would
    // overwrite duplicate header names.
    let clearing_marker = build_clearing_signed_out_marker(&state.config, is_https);
    (
        StatusCode::FOUND,
        AppendHeaders([(SET_COOKIE, cookie_header), (SET_COOKIE, clearing_marker)]),
        [(LOCATION, target)],
    )
        .into_response()
}

/// Build a 302 redirect to `/auth/error` with the supplied
/// query-param pairs. Pulled into a helper so the four-or-so failure
/// branches stay one line each. Each value is URL-encoded; absent
/// keys are omitted entirely (no `?code=&attempted_email=…` shapes).
pub(crate) fn redirect_to_error(params: &[(&str, &str)]) -> Response {
    let qs = params
        .iter()
        .filter(|(_, v)| !v.is_empty())
        .map(|(k, v)| format!("{}={}", urlencoding::encode(k), urlencoding::encode(v)))
        .collect::<Vec<_>>()
        .join("&");
    let location = if qs.is_empty() {
        "/auth/error".to_string()
    } else {
        format!("/auth/error?{qs}")
    };
    (StatusCode::FOUND, [(LOCATION, location)]).into_response()
}

/// Build the Location: header for the post-callback 302. Path comes
/// straight from the captured intent; hash gets a leading `#` if it
/// isn't already present (the JS shim strips it before posting; the
/// noscript fallback might pass it through).
///
/// Path defaults to `/` when empty (defensive — the shim always
/// supplies one in practice).
pub(crate) fn redirect_target(intended_path: &str, intended_hash: &str) -> String {
    let path = if intended_path.is_empty() {
        "/"
    } else {
        intended_path
    };
    if intended_hash.is_empty() {
        path.to_string()
    } else if intended_hash.starts_with('#') {
        format!("{path}{intended_hash}")
    } else {
        format!("{path}#{intended_hash}")
    }
}

/// Generate a 256-bit cryptographically-random state token, base64url
/// encoded (no padding) so it slots into a query param without further
/// escaping. PRD #455 calls out 256 bits as the minimum.
pub(crate) fn random_state_token() -> String {
    let bytes: [u8; 32] = rand::random();
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(bytes)
}

fn first_nonempty<'a>(opts: &[Option<&'a str>]) -> Option<&'a str> {
    for opt in opts {
        if let Some(v) = opt
            && !v.is_empty()
        {
            return Some(*v);
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::auth::middleware::{SharedExtractor, auth_middleware};
    use crate::auth::principal::SessionCookieExtractor;
    use crate::auth::session_store_memory::MemorySessionStore;
    use axum::Router;
    use axum::body::Body;
    use axum::http::Request;
    use axum::middleware::from_fn_with_state;
    use axum::routing::{get, post};
    use tower::ServiceExt;

    #[tokio::test]
    async fn whoami_returns_401_when_no_principal_attached() {
        let app = Router::new().route("/auth/whoami", get(whoami));

        let req = Request::builder()
            .uri("/auth/whoami")
            .body(Body::empty())
            .unwrap();
        let res = app.oneshot(req).await.unwrap();
        assert_eq!(res.status(), StatusCode::UNAUTHORIZED);
    }

    #[tokio::test]
    async fn whoami_returns_401_without_cookie_under_real_extractor() {
        let store: Arc<MemorySessionStore> = Arc::new(MemorySessionStore::new());
        let config = Arc::new(AuthConfig::for_tests());
        let extractor: SharedExtractor = Arc::new(SessionCookieExtractor::new(
            Arc::clone(&config),
            Arc::clone(&store) as Arc<dyn LoginSessionStore>,
        ));
        let app = Router::new()
            .route("/auth/whoami", get(whoami))
            .layer(from_fn_with_state(extractor, auth_middleware));
        let req = Request::builder()
            .uri("/auth/whoami")
            .body(Body::empty())
            .unwrap();
        let res = app.oneshot(req).await.unwrap();
        assert_eq!(res.status(), StatusCode::UNAUTHORIZED);
    }

    // -- /auth/logout (slice 3) -------------------------------------------

    fn logout_state_with(store: Arc<MemorySessionStore>) -> LogoutState {
        LogoutState {
            config: Arc::new(AuthConfig::for_tests()),
            store: store as Arc<dyn LoginSessionStore>,
        }
    }

    fn logout_app(state: LogoutState) -> Router {
        Router::new().route("/auth/logout", post(logout).with_state(state))
    }

    #[tokio::test]
    async fn logout_with_valid_cookie_deletes_session_and_clears_cookie() {
        let store = Arc::new(MemorySessionStore::new());
        let now = Utc::now();
        store
            .create(LoginSession {
                id: "kill-me".into(),
                email: "dev@local".into(),
                display_name: "Local Dev".into(),
                picture_url: None,
                created_at: now,
                last_used_at: now,
                expires_at: now + ChronoDuration::hours(24),
            })
            .await
            .unwrap();

        let app = logout_app(logout_state_with(Arc::clone(&store)));
        let req = Request::builder()
            .method("POST")
            .uri("/auth/logout")
            .header("cookie", "lucida_session=kill-me")
            .body(Body::empty())
            .unwrap();
        let res = app.oneshot(req).await.unwrap();

        assert_eq!(res.status(), StatusCode::FOUND);
        let location = res.headers().get(LOCATION).unwrap().to_str().unwrap();
        assert_eq!(location, "/");

        // Two Set-Cookie headers expected: clear lucida_session AND
        // set the lucida_signed_out marker. Iterate get_all so we
        // don't accidentally only see the first one.
        let set_cookies: Vec<&str> = res
            .headers()
            .get_all(SET_COOKIE)
            .iter()
            .map(|v| v.to_str().unwrap())
            .collect();
        let clearing = set_cookies
            .iter()
            .find(|c| c.contains("lucida_session=") && c.contains("Max-Age=0"))
            .expect("clearing cookie for lucida_session");
        assert!(clearing.contains("Path=/"));
        assert!(clearing.contains("SameSite=Lax"));
        let marker = set_cookies
            .iter()
            .find(|c| c.contains("lucida_signed_out=1"))
            .expect("signed-out marker cookie");
        assert!(marker.contains("Max-Age=600"));
        assert!(marker.contains("HttpOnly"));

        // The row must be gone after logout.
        assert!(store.get("kill-me").await.unwrap().is_none());
    }

    #[tokio::test]
    async fn logout_without_cookie_is_idempotent() {
        let store = Arc::new(MemorySessionStore::new());
        let app = logout_app(logout_state_with(Arc::clone(&store)));
        let req = Request::builder()
            .method("POST")
            .uri("/auth/logout")
            .body(Body::empty())
            .unwrap();
        let res = app.oneshot(req).await.unwrap();

        assert_eq!(res.status(), StatusCode::FOUND);
        assert_eq!(res.headers().get(LOCATION).unwrap().to_str().unwrap(), "/");
        // Even cookieless callers get the clearing cookie + the marker —
        // logout's contract is shape-stable regardless of inbound state.
        let set_cookies: Vec<&str> = res
            .headers()
            .get_all(SET_COOKIE)
            .iter()
            .map(|v| v.to_str().unwrap())
            .collect();
        assert!(
            set_cookies
                .iter()
                .any(|c| c.contains("lucida_session=") && c.contains("Max-Age=0"))
        );
        assert!(
            set_cookies
                .iter()
                .any(|c| c.contains("lucida_signed_out=1"))
        );
        // No rows existed; no rows now.
        assert!(store.is_empty());
    }

    /// Even when the cookie names a session that no longer exists, we
    /// still 302 + clear (so a stale tab in the browser sees its
    /// cookie evicted). Mirrors the "delete is idempotent" promise on
    /// the store.
    #[tokio::test]
    async fn logout_with_unknown_session_id_still_302s_and_clears() {
        let store = Arc::new(MemorySessionStore::new());
        let app = logout_app(logout_state_with(Arc::clone(&store)));
        let req = Request::builder()
            .method("POST")
            .uri("/auth/logout")
            .header("cookie", "lucida_session=ghost")
            .body(Body::empty())
            .unwrap();
        let res = app.oneshot(req).await.unwrap();

        assert_eq!(res.status(), StatusCode::FOUND);
        let set_cookies: Vec<&str> = res
            .headers()
            .get_all(SET_COOKIE)
            .iter()
            .map(|v| v.to_str().unwrap())
            .collect();
        assert!(
            set_cookies
                .iter()
                .any(|c| c.contains("lucida_session=") && c.contains("Max-Age=0"))
        );
        assert!(
            set_cookies
                .iter()
                .any(|c| c.contains("lucida_signed_out=1"))
        );
    }

    // -- redirect_target + random_state_token (slice 4) -----------------

    #[test]
    fn redirect_target_appends_hash_when_present() {
        assert_eq!(redirect_target("/dataset", "view=abc"), "/dataset#view=abc");
    }

    #[test]
    fn redirect_target_preserves_existing_hash_marker() {
        // The shim strips the leading '#' before posting; the
        // noscript fallback might not. Both shapes must produce a
        // single '#' in the output.
        assert_eq!(redirect_target("/", "#b=42"), "/#b=42");
    }

    #[test]
    fn redirect_target_omits_hash_separator_when_empty() {
        assert_eq!(redirect_target("/foo", ""), "/foo");
    }

    #[test]
    fn redirect_target_defaults_path_to_slash_when_empty() {
        assert_eq!(redirect_target("", "view=a"), "/#view=a");
    }

    #[test]
    fn random_state_token_is_distinct_and_url_safe() {
        let a = random_state_token();
        let b = random_state_token();
        assert_ne!(a, b);
        // 32 bytes -> 43 base64url chars (no padding).
        assert_eq!(a.len(), 43);
        // Char set: A-Z a-z 0-9 _ -. No padding `=`, no `+` or `/`.
        for c in a.chars() {
            assert!(
                c.is_ascii_alphanumeric() || c == '-' || c == '_',
                "unexpected char {c:?} in state token",
            );
        }
    }
}
