//! Auth HTTP handlers.
//!
//! Hosts `/auth/whoami`, `/auth/logout`, `/auth/mode`, the OAuth flow
//! (`/auth/start` + `/auth/callback`), and the `/auth/error` page.
//! Disabled mode bypasses these handlers by yielding the dev principal
//! directly from [`crate::auth::principal::StubPrincipalExtractor`].

use std::sync::Arc;
use std::time::Duration;

use axum::Extension;
use axum::extract::{Form, Path, Query, State};
use axum::http::header::{AUTHORIZATION, LOCATION, SET_COOKIE};
use axum::http::{HeaderMap, Request, StatusCode, header};
use axum::response::{AppendHeaders, IntoResponse, Json, Response};
use base64::Engine;
use chrono::{Duration as ChronoDuration, Utc};
use serde::{Deserialize, Serialize};
use serde_json::json;
use tracing::{error, info, warn};

use lucida_core::auth_principal::AuthPrincipal;

use super::bearer_token::{BearerToken, BearerTokenStore, hash_bearer_token};
use super::cli_authorization::{CliTokenAuthorization, CliTokenAuthorizationStore};
use super::config::{AuthConfig, AuthMode};
use super::cookie::{
    build_clearing_cookie, build_clearing_signed_out_marker, build_session_cookie,
    build_signed_out_marker, read_session_cookie, read_signed_out_marker, request_is_https,
};
use super::dev::{
    build_clearing_dev_principal_cookie, build_dev_principal_cookie, default_dev_principal,
    normalize_dev_principal,
};
use super::google_oauth::{GoogleOAuthClient, OAuthError, Prompt};
use super::pending_auth::{PendingAuth, PendingAuthStore};
use super::principal::{RejectionReason, principal_or_rejection_from_claims};
use super::session_store::{LoginSession, LoginSessionStore};

const CLI_AUTH_REQUEST_TTL: Duration = Duration::from_secs(10 * 60);
const DEFAULT_CLI_TOKEN_TTL: Duration = Duration::from_secs(30 * 24 * 60 * 60);
const MIN_CLI_TOKEN_TTL: Duration = Duration::from_secs(60);
const MAX_CLI_TOKEN_NAME_LEN: usize = 80;

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

/// What the configured auth mode offers the web client.
///
/// It reports what the mode does, not which mode it is, so the client
/// never grows a branch per mode.
#[derive(Debug, Serialize)]
pub struct AuthModeInfo {
    /// Where the sign-out control points, or `null` when this mode has
    /// nothing to sign out of. See [`AuthMode::sign_out_url`].
    pub sign_out_url: Option<&'static str>,
}

/// `GET /auth/mode` — the sign-out URL, if this mode has one.
///
/// Public, like `/auth/dev/status`. It carries no identity, and the
/// client asks for it while whoami is still in flight.
pub async fn auth_mode(State(config): State<Arc<AuthConfig>>) -> Response {
    Json(AuthModeInfo {
        sign_out_url: config.mode.sign_out_url(),
    })
    .into_response()
}

// -- CLI/Python bearer credential provisioning ---------------------------

#[derive(Clone)]
pub struct CliAuthState {
    pub config: Arc<AuthConfig>,
    pub token_store: Arc<dyn BearerTokenStore>,
    pub cli_store: Arc<dyn CliTokenAuthorizationStore>,
}

#[derive(Debug, Deserialize)]
pub struct CliAuthStartRequest {
    #[serde(default)]
    pub name: Option<String>,
    pub token_hash: String,
    #[serde(default)]
    pub expires_in_seconds: Option<u64>,
}

#[derive(Debug, Serialize)]
pub struct CliAuthStartResponse {
    pub status: &'static str,
    pub request_id: String,
    pub user_code: String,
    pub approval_path: String,
    pub poll_path: String,
    pub poll_token: String,
    pub expires_at: chrono::DateTime<Utc>,
    pub token_expires_at: chrono::DateTime<Utc>,
}

#[derive(Debug, Serialize)]
pub struct CliAuthPollResponse {
    pub status: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub email: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub token_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub token_name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub token_expires_at: Option<chrono::DateTime<Utc>>,
}

/// `POST /auth/cli/start` — public endpoint used by `lucida auth login`.
///
/// The CLI has already generated the raw token and sends only its hash.
/// The response contains a short-lived poll secret and a browser URL
/// path the user must approve while authenticated.
pub async fn cli_auth_start(
    State(state): State<CliAuthState>,
    Json(payload): Json<CliAuthStartRequest>,
) -> Response {
    let name = match normalize_cli_token_name(payload.name.as_deref()) {
        Ok(name) => name,
        Err(detail) => return bad_request(detail),
    };
    if !valid_token_hash(&payload.token_hash) {
        return bad_request("token_hash must be a 64-character lowercase hex digest");
    }

    let now = Utc::now();
    let request_id = uuid::Uuid::new_v4().to_string();
    let poll_token = random_url_secret();
    let poll_token_hash = hash_bearer_token(&poll_token);
    let user_code = random_user_code();
    let expires_at =
        now + ChronoDuration::from_std(CLI_AUTH_REQUEST_TTL).unwrap_or(ChronoDuration::minutes(10));
    let token_ttl = requested_token_ttl(payload.expires_in_seconds, &state.config);
    let token_expires_at =
        now + ChronoDuration::from_std(token_ttl).unwrap_or(ChronoDuration::hours(720));

    let row = CliTokenAuthorization {
        id: request_id.clone(),
        poll_token_hash,
        token_hash: payload.token_hash,
        user_code: user_code.clone(),
        name,
        created_at: now,
        expires_at,
        token_expires_at,
        approved_at: None,
        approved_token_id: None,
        approved_email: None,
    };
    if let Err(e) = state.cli_store.create(row).await {
        error!(error = %e, "auth.cli.start.create_failed");
        return internal_error();
    }

    info!(request_id = %request_id, "auth.cli.start");
    Json(CliAuthStartResponse {
        status: "pending",
        approval_path: format!("/auth/cli/approve/{request_id}"),
        poll_path: format!("/auth/cli/poll/{request_id}"),
        request_id,
        user_code,
        poll_token,
        expires_at,
        token_expires_at,
    })
    .into_response()
}

/// `GET /auth/cli/approve/{request_id}` — authenticated browser page.
pub async fn cli_auth_approve_page(
    State(state): State<CliAuthState>,
    Path(request_id): Path<String>,
    Extension(principal): Extension<AuthPrincipal>,
) -> Response {
    let row = match load_cli_request(&state, &request_id).await {
        Ok(Some(row)) => row,
        Ok(None) => return html_response(StatusCode::NOT_FOUND, cli_auth_missing_html()),
        Err(CliRequestLoadFailed) => return internal_error(),
    };

    let now = Utc::now();
    if row.is_expired_at(now) {
        return html_response(StatusCode::GONE, cli_auth_expired_html(&row));
    }
    if row.is_approved() {
        return html_response(StatusCode::OK, cli_auth_already_approved_html(&row));
    }

    html_response(StatusCode::OK, cli_auth_approve_html(&row, &principal))
}

#[derive(Debug, Deserialize)]
pub struct CliAuthApprovalForm {
    #[serde(default)]
    pub action: Option<String>,
}

/// `POST /auth/cli/approve/{request_id}` — authenticated browser approval.
pub async fn cli_auth_approve_submit(
    State(state): State<CliAuthState>,
    Path(request_id): Path<String>,
    Extension(principal): Extension<AuthPrincipal>,
    Form(form): Form<CliAuthApprovalForm>,
) -> Response {
    if form.action.as_deref().unwrap_or("approve") != "approve" {
        return bad_request("unsupported CLI authorization action");
    }

    let row = match load_cli_request(&state, &request_id).await {
        Ok(Some(row)) => row,
        Ok(None) => return html_response(StatusCode::NOT_FOUND, cli_auth_missing_html()),
        Err(CliRequestLoadFailed) => return internal_error(),
    };
    let now = Utc::now();
    if row.is_expired_at(now) {
        return html_response(StatusCode::GONE, cli_auth_expired_html(&row));
    }
    if row.is_approved() {
        return html_response(StatusCode::OK, cli_auth_already_approved_html(&row));
    }

    let token_id = uuid::Uuid::new_v4().to_string();
    let token = BearerToken {
        id: token_id.clone(),
        token_hash: row.token_hash.clone(),
        name: row.name.clone(),
        email: principal.email.clone(),
        display_name: principal.display_name.clone(),
        picture_url: principal.picture_url.clone(),
        created_at: now,
        last_used_at: None,
        expires_at: row.token_expires_at,
        revoked_at: None,
    };
    if let Err(e) = state.token_store.create(token).await {
        warn!(
            request_id = %row.id,
            email = %principal.email,
            error = %e,
            "auth.cli.approve.token_create_failed",
        );
        return (
            StatusCode::CONFLICT,
            Json(json!({ "error": "token_create_failed" })),
        )
            .into_response();
    }
    if let Err(e) = state
        .cli_store
        .mark_approved(&row.id, &token_id, &principal.email, now)
        .await
    {
        error!(
            request_id = %row.id,
            token_id = %token_id,
            error = %e,
            "auth.cli.approve.mark_failed",
        );
        return internal_error();
    }

    info!(
        request_id = %row.id,
        token_id = %token_id,
        email = %principal.email,
        name = %row.name,
        "auth.cli.approve.success",
    );
    html_response(StatusCode::OK, cli_auth_success_html(&row, &principal))
}

/// `GET /auth/cli/poll/{request_id}` — public polling endpoint for CLI.
pub async fn cli_auth_poll(
    State(state): State<CliAuthState>,
    Path(request_id): Path<String>,
    req: Request<axum::body::Body>,
) -> Response {
    let poll_token = match read_bearer_from_headers(req.headers()) {
        Some(token) => token,
        None => {
            return (
                StatusCode::UNAUTHORIZED,
                Json(json!({ "error": "unauthenticated" })),
            )
                .into_response();
        }
    };
    let poll_hash = hash_bearer_token(poll_token);
    let row = match state.cli_store.get_for_poll(&request_id, &poll_hash).await {
        Ok(Some(row)) => row,
        Ok(None) => {
            return (
                StatusCode::UNAUTHORIZED,
                Json(json!({ "error": "unauthenticated" })),
            )
                .into_response();
        }
        Err(e) => {
            error!(request_id = %request_id, error = %e, "auth.cli.poll.failed");
            return internal_error();
        }
    };

    if row.is_expired_at(Utc::now()) {
        return (
            StatusCode::GONE,
            Json(CliAuthPollResponse {
                status: "expired",
                email: None,
                token_id: None,
                token_name: None,
                token_expires_at: None,
            }),
        )
            .into_response();
    }
    if row.is_approved() {
        return Json(CliAuthPollResponse {
            status: "approved",
            email: row.approved_email,
            token_id: row.approved_token_id,
            token_name: Some(row.name),
            token_expires_at: Some(row.token_expires_at),
        })
        .into_response();
    }

    (
        StatusCode::ACCEPTED,
        Json(CliAuthPollResponse {
            status: "pending",
            email: None,
            token_id: None,
            token_name: None,
            token_expires_at: None,
        }),
    )
        .into_response()
}

/// `POST /auth/tokens/revoke-current` — revoke the bearer token used
/// for this request. Cookie-authenticated callers get a 400 because
/// there is no current bearer credential to revoke.
pub async fn revoke_current_bearer_token(
    State(state): State<CliAuthState>,
    req: Request<axum::body::Body>,
) -> Response {
    let Some(raw) = read_bearer_from_headers(req.headers()) else {
        return bad_request("request was authenticated without a bearer token");
    };
    let hash = hash_bearer_token(raw);
    match state.token_store.revoke_by_hash(&hash, Utc::now()).await {
        Ok(Some(row)) => {
            info!(
                token_id = %row.id,
                email = %row.email,
                "auth.bearer.revoke_current",
            );
            Json(json!({ "revoked": true, "token_id": row.id })).into_response()
        }
        Ok(None) => (
            StatusCode::UNAUTHORIZED,
            Json(json!({ "error": "unauthenticated" })),
        )
            .into_response(),
        Err(e) => {
            error!(error = %e, "auth.bearer.revoke_current.failed");
            internal_error()
        }
    }
}

/// The lookup failed and the cause is already logged; callers answer with
/// `internal_error()`. Carrying the `Response` itself here makes the `Err`
/// variant large enough to trip `clippy::result_large_err`.
struct CliRequestLoadFailed;

async fn load_cli_request(
    state: &CliAuthState,
    request_id: &str,
) -> Result<Option<CliTokenAuthorization>, CliRequestLoadFailed> {
    state.cli_store.get(request_id).await.map_err(|e| {
        error!(request_id = %request_id, error = %e, "auth.cli.request_load_failed");
        CliRequestLoadFailed
    })
}

fn requested_token_ttl(requested_seconds: Option<u64>, config: &AuthConfig) -> Duration {
    let requested = requested_seconds
        .map(Duration::from_secs)
        .unwrap_or(DEFAULT_CLI_TOKEN_TTL);
    let max = config.hard_cap.max(MIN_CLI_TOKEN_TTL);
    requested.clamp(MIN_CLI_TOKEN_TTL, max)
}

fn normalize_cli_token_name(raw: Option<&str>) -> Result<String, &'static str> {
    let name = raw.unwrap_or("Lucida CLI").trim();
    if name.is_empty() {
        return Err("token name cannot be empty");
    }
    if name.chars().count() > MAX_CLI_TOKEN_NAME_LEN {
        return Err("token name is too long");
    }
    Ok(name.to_string())
}

fn valid_token_hash(raw: &str) -> bool {
    raw.len() == 64 && raw.bytes().all(|b| b.is_ascii_hexdigit())
}

fn read_bearer_from_headers(headers: &HeaderMap) -> Option<&str> {
    let header = headers.get(AUTHORIZATION).and_then(|v| v.to_str().ok())?;
    let (scheme, token) = header.split_once(' ')?;
    if !scheme.eq_ignore_ascii_case("bearer") {
        return None;
    }
    let token = token.trim();
    (!token.is_empty()).then_some(token)
}

fn random_url_secret() -> String {
    let bytes: [u8; 32] = rand::random();
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(bytes)
}

fn random_user_code() -> String {
    let raw: u32 = rand::random();
    format!("{:04X}-{:04X}", raw >> 16, raw & 0xFFFF)
}

fn internal_error() -> Response {
    (
        StatusCode::INTERNAL_SERVER_ERROR,
        Json(json!({ "error": "internal" })),
    )
        .into_response()
}

fn bad_request(detail: impl Into<String>) -> Response {
    (
        StatusCode::BAD_REQUEST,
        Json(json!({ "error": "bad_request", "detail": detail.into() })),
    )
        .into_response()
}

fn html_response(status: StatusCode, body: String) -> Response {
    (
        status,
        [(header::CONTENT_TYPE, "text/html; charset=utf-8")],
        body,
    )
        .into_response()
}

fn cli_auth_missing_html() -> String {
    auth_html_page(
        "Lucida CLI authorization not found",
        "<p>This CLI authorization request does not exist or was already removed.</p>",
    )
}

fn cli_auth_expired_html(row: &CliTokenAuthorization) -> String {
    auth_html_page(
        "Lucida CLI authorization expired",
        &format!(
            "<p>The request for <strong>{}</strong> expired at {}.</p>",
            html_escape(&row.name),
            html_escape(&row.expires_at.to_rfc3339())
        ),
    )
}

fn cli_auth_already_approved_html(row: &CliTokenAuthorization) -> String {
    auth_html_page(
        "Lucida CLI authorization already approved",
        &format!(
            "<p>The request for <strong>{}</strong> has already been approved.</p>",
            html_escape(&row.name)
        ),
    )
}

fn cli_auth_approve_html(row: &CliTokenAuthorization, principal: &AuthPrincipal) -> String {
    auth_html_page(
        "Approve Lucida CLI access",
        &format!(
            r#"
            <p>Approve a CLI/Python bearer credential for <strong>{email}</strong>.</p>
            <dl>
              <dt>Name</dt><dd>{name}</dd>
              <dt>Code</dt><dd><code>{code}</code></dd>
              <dt>Token expires</dt><dd>{token_expires}</dd>
              <dt>Approval expires</dt><dd>{expires}</dd>
            </dl>
            <form method="post">
              <button type="submit" name="action" value="approve">Approve credential</button>
            </form>
            "#,
            email = html_escape(&principal.email),
            name = html_escape(&row.name),
            code = html_escape(&row.user_code),
            token_expires = html_escape(&row.token_expires_at.to_rfc3339()),
            expires = html_escape(&row.expires_at.to_rfc3339()),
        ),
    )
}

fn cli_auth_success_html(row: &CliTokenAuthorization, principal: &AuthPrincipal) -> String {
    auth_html_page(
        "Lucida CLI access approved",
        &format!(
            "<p><strong>{}</strong> can now use Lucida as <strong>{}</strong>.</p>",
            html_escape(&row.name),
            html_escape(&principal.email)
        ),
    )
}

fn auth_html_page(title: &str, body: &str) -> String {
    format!(
        r#"<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>{title}</title>
  <style>
    body {{ font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; margin: 3rem auto; max-width: 42rem; padding: 0 1rem; line-height: 1.5; color: #172026; }}
    h1 {{ font-size: 1.6rem; line-height: 1.2; }}
    dl {{ display: grid; grid-template-columns: 9rem 1fr; gap: .5rem 1rem; }}
    dt {{ font-weight: 650; color: #4a5560; }}
    dd {{ margin: 0; }}
    code {{ font-size: 1.1rem; letter-spacing: .04em; }}
    button {{ appearance: none; border: 0; border-radius: 6px; background: #176b5f; color: white; font: inherit; font-weight: 650; padding: .7rem 1rem; cursor: pointer; }}
  </style>
</head>
<body>
  <h1>{title}</h1>
  {body}
</body>
</html>"#,
        title = html_escape(title),
        body = body,
    )
}

fn html_escape(raw: &str) -> String {
    raw.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
        .replace('\'', "&#39;")
}

/// State for disabled-auth developer identity routes.
///
/// Both fields are private, so [`DevAuthState::new`] is the only way to
/// build one. A future route cannot mount the switcher without running
/// the check that decides whether it is safe.
#[derive(Clone)]
pub struct DevAuthState {
    config: Arc<AuthConfig>,
    enabled: bool,
}

impl DevAuthState {
    /// Decide whether the dev identity switcher is available.
    ///
    /// It needs `LUCIDA_AUTH=disabled` and a loopback bind. Disabled
    /// mode alone is not enough. `/auth/dev/login` mints whatever
    /// identity the request body names, admin included, so on any other
    /// address it lets every caller make themselves an admin.
    /// `LUCIDA_INSECURE=1` acknowledges running without sign-in
    /// (ADR-0018). It does not ask for a route that hands out privilege.
    pub fn new(config: Arc<AuthConfig>) -> Self {
        let enabled = config.mode == AuthMode::Disabled && config.bind_is_loopback();
        Self { config, enabled }
    }
}

#[derive(Debug, Serialize)]
pub struct DevAuthStatus {
    pub enabled: bool,
    pub default_principal: AuthPrincipal,
}

#[derive(Debug, Deserialize)]
pub struct DevLoginRequest {
    pub email: String,
    pub display_name: Option<String>,
    #[serde(default)]
    pub is_admin: bool,
}

/// `GET /auth/dev/status` — tells the SPA whether to draw the identity
/// switcher. Registered on every deployment, and `enabled` carries the
/// verdict.
pub async fn dev_status(State(state): State<DevAuthState>) -> Response {
    Json(DevAuthStatus {
        enabled: state.enabled,
        default_principal: default_dev_principal(),
    })
    .into_response()
}

/// `POST /auth/dev/login` — take on a local dev identity of the
/// caller's choosing.
///
/// Registered on every deployment, and 404s unless the switcher is
/// enabled. Leaving the path unregistered would hand it to the SPA
/// catch-all, which replies 200 with `index.html`.
pub async fn dev_login(
    State(state): State<DevAuthState>,
    req: Request<axum::body::Body>,
) -> Response {
    if !state.enabled {
        return StatusCode::NOT_FOUND.into_response();
    }

    let (parts, body) = req.into_parts();
    let payload: DevLoginRequest = match axum::body::to_bytes(body, 64 * 1024).await {
        Ok(bytes) => match serde_json::from_slice(&bytes) {
            Ok(payload) => payload,
            Err(_) => {
                return (
                    StatusCode::BAD_REQUEST,
                    Json(json!({ "error": "bad_request", "detail": "invalid JSON body" })),
                )
                    .into_response();
            }
        },
        Err(_) => {
            return (
                StatusCode::BAD_REQUEST,
                Json(json!({ "error": "bad_request", "detail": "invalid request body" })),
            )
                .into_response();
        }
    };

    let principal = match normalize_dev_principal(
        &payload.email,
        payload.display_name.as_deref(),
        payload.is_admin,
    ) {
        Ok(principal) => principal,
        Err(detail) => {
            return (
                StatusCode::BAD_REQUEST,
                Json(json!({ "error": "bad_request", "detail": detail })),
            )
                .into_response();
        }
    };

    let cookie = build_dev_principal_cookie(&state.config, &principal, request_is_https(&parts));
    (
        StatusCode::OK,
        AppendHeaders([(SET_COOKIE, cookie)]),
        Json(principal),
    )
        .into_response()
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
        // Worst case the row lingers until the background sweep; the
        // browser is forced unauthenticated immediately, which is
        // the user-visible promise of logout.
        tracing::error!(error = %e, "logout.delete_session.failed");
    }

    // Always emit the audit event so the absence of a row in the audit
    // log distinguishes "user never clicked sign-out" from "endpoint
    // hit but storage hiccuped." Email may be None for cookieless
    // calls or expired/unknown sessions.
    info!(
        email = email.as_deref().unwrap_or("<unknown>"),
        "auth.logout"
    );

    // Set-Cookie headers: clear `lucida_session`, set the
    // `lucida_signed_out` marker, and clear any disabled-auth dev
    // principal override. The marker survives the page refresh that
    // would otherwise route through the auto-bouncing unauth landing →
    // Google's still-active session → silent re-auth.
    // Middleware consumes it (serves the static landing) and
    // `/auth/start` clears it on user-initiated re-sign-in.
    //
    // `AppendHeaders` (not `[(name, val); N]`) — Set-Cookie is one of
    // the few headers that legitimately needs multiple emissions; the
    // array form would silently overwrite the second on the first.
    let is_https = request_is_https(&parts);
    let clearing = build_clearing_cookie(&state.config, is_https);
    let marker = build_signed_out_marker(&state.config, is_https);
    let dev_clearing = build_clearing_dev_principal_cookie(&state.config, is_https);
    (
        StatusCode::FOUND,
        AppendHeaders([
            (SET_COOKIE, clearing),
            (SET_COOKIE, marker),
            (SET_COOKIE, dev_clearing),
        ]),
        [(LOCATION, "/".to_string())],
    )
        .into_response()
}

// -- /auth/start + /auth/callback -----------------------------------------

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
        return internal_error();
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
/// validates the JWT, applies the hosted-domain + email_verified
/// checks, mints a `LoginSession`, sets the cookie, and 302s to the
/// originally-captured path + hash.
///
/// Every failure 302s to `/auth/error?code=…`. Two flavors:
///
/// * `code=hd_mismatch` / `code=unverified` — user-fixable rejections.
///   Detail params (attempted_email, allowed_domains) included so the
///   page can render the actionable message.
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
            // Missing or already-used.
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

    // Apply the email_verified + (optional) hd allowlist policy. The
    // raw mapping (`principal_from_claims`) is applied inside
    // `principal_or_rejection_from_claims` on accept; on reject we
    // emit an audit event and bounce to the error page with the
    // structured detail params.
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
/// escaping. 256 bits is the minimum acceptable entropy.
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
    use crate::auth::bearer_token::hash_bearer_token;
    use crate::auth::middleware::{SharedExtractor, auth_middleware};
    use crate::auth::principal::SessionCookieExtractor;
    use crate::auth::session_store_memory::MemorySessionStore;
    use crate::auth::{
        AuthMode, BearerTokenStore, CliTokenAuthorizationStore, MemoryBearerTokenStore,
        MemoryCliTokenAuthorizationStore,
    };
    use axum::Router;
    use axum::body::{Body, to_bytes};
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

    #[tokio::test]
    async fn cli_auth_flow_approves_bearer_token_for_cookie_principal() {
        let mut config = AuthConfig::for_tests();
        config.mode = AuthMode::Google;
        let config = Arc::new(config);

        let session_store = Arc::new(MemorySessionStore::new());
        let now = Utc::now();
        session_store
            .create(LoginSession {
                id: "browser-cookie".into(),
                email: "dev@local".into(),
                display_name: "Local Dev".into(),
                picture_url: None,
                created_at: now,
                last_used_at: now,
                expires_at: now + ChronoDuration::hours(24),
            })
            .await
            .unwrap();

        let token_store = Arc::new(MemoryBearerTokenStore::new());
        let cli_store = Arc::new(MemoryCliTokenAuthorizationStore::new());
        let cli_state = CliAuthState {
            config: Arc::clone(&config),
            token_store: Arc::clone(&token_store) as Arc<dyn BearerTokenStore>,
            cli_store: Arc::clone(&cli_store) as Arc<dyn CliTokenAuthorizationStore>,
        };
        let extractor: SharedExtractor = crate::auth::middleware::build_extractor(
            Arc::clone(&config),
            Arc::clone(&session_store) as Arc<dyn LoginSessionStore>,
            Arc::clone(&token_store) as Arc<dyn BearerTokenStore>,
        );
        let authed = Router::new()
            .route("/auth/whoami", get(whoami))
            .route(
                "/auth/cli/approve/{request_id}",
                get(cli_auth_approve_page)
                    .post(cli_auth_approve_submit)
                    .with_state(cli_state.clone()),
            )
            .layer(from_fn_with_state(extractor, auth_middleware));
        let public = Router::new()
            .route(
                "/auth/cli/start",
                post(cli_auth_start).with_state(cli_state.clone()),
            )
            .route(
                "/auth/cli/poll/{request_id}",
                get(cli_auth_poll).with_state(cli_state),
            );
        let app = authed.merge(public);

        let raw_token = "lucida_pat_route_test";
        let start = Request::builder()
            .method("POST")
            .uri("/auth/cli/start")
            .header("content-type", "application/json")
            .body(Body::from(
                json!({
                    "name": "route test",
                    "token_hash": hash_bearer_token(raw_token),
                    "expires_in_seconds": 3600
                })
                .to_string(),
            ))
            .unwrap();
        let start_res = app.clone().oneshot(start).await.unwrap();
        assert_eq!(start_res.status(), StatusCode::OK);
        let body = to_bytes(start_res.into_body(), 64 * 1024).await.unwrap();
        let start_body: serde_json::Value = serde_json::from_slice(&body).unwrap();
        let approval_path = start_body["approval_path"].as_str().unwrap().to_string();
        let poll_path = start_body["poll_path"].as_str().unwrap().to_string();
        let poll_token = start_body["poll_token"].as_str().unwrap().to_string();

        let pending = Request::builder()
            .uri(&poll_path)
            .header("authorization", format!("Bearer {poll_token}"))
            .body(Body::empty())
            .unwrap();
        let pending_res = app.clone().oneshot(pending).await.unwrap();
        assert_eq!(pending_res.status(), StatusCode::ACCEPTED);

        let approve = Request::builder()
            .method("POST")
            .uri(&approval_path)
            .header("cookie", "lucida_session=browser-cookie")
            .header("content-type", "application/x-www-form-urlencoded")
            .body(Body::from("action=approve"))
            .unwrap();
        let approve_res = app.clone().oneshot(approve).await.unwrap();
        assert_eq!(approve_res.status(), StatusCode::OK);
        assert_eq!(token_store.len(), 1);

        let approved = Request::builder()
            .uri(&poll_path)
            .header("authorization", format!("Bearer {poll_token}"))
            .body(Body::empty())
            .unwrap();
        let approved_res = app.clone().oneshot(approved).await.unwrap();
        assert_eq!(approved_res.status(), StatusCode::OK);

        let whoami_req = Request::builder()
            .uri("/auth/whoami")
            .header("authorization", format!("Bearer {raw_token}"))
            .body(Body::empty())
            .unwrap();
        let whoami_res = app.oneshot(whoami_req).await.unwrap();
        assert_eq!(whoami_res.status(), StatusCode::OK);
        let body = to_bytes(whoami_res.into_body(), 64 * 1024).await.unwrap();
        let principal: AuthPrincipal = serde_json::from_slice(&body).unwrap();
        assert_eq!(principal.email, "dev@local");
    }

    // -- /auth/mode ------------------------------------------------------

    async fn advertised_sign_out_url(mode: AuthMode) -> serde_json::Value {
        let mut config = AuthConfig::for_tests();
        config.mode = mode;
        let app = Router::new()
            .route("/auth/mode", get(auth_mode))
            .with_state(Arc::new(config));

        let req = Request::builder()
            .uri("/auth/mode")
            .body(Body::empty())
            .unwrap();
        let res = app.oneshot(req).await.unwrap();
        assert_eq!(res.status(), StatusCode::OK);
        let body = to_bytes(res.into_body(), 64 * 1024).await.unwrap();
        let payload: serde_json::Value = serde_json::from_slice(&body).unwrap();
        payload["sign_out_url"].clone()
    }

    #[tokio::test]
    async fn auth_mode_advertises_the_url_the_configured_mode_declares() {
        assert_eq!(
            advertised_sign_out_url(AuthMode::Google).await,
            json!("/auth/logout"),
        );
        assert_eq!(
            advertised_sign_out_url(AuthMode::Disabled).await,
            serde_json::Value::Null,
            "disabled mode has no session to end, so it offers no sign-out",
        );
    }

    // -- /auth/dev/* -----------------------------------------------------

    fn dev_auth_config(mode: AuthMode, bind: &str) -> Arc<AuthConfig> {
        let mut config = AuthConfig::for_tests();
        config.mode = mode;
        config.bind_addr = bind.parse().expect("test bind parses");
        Arc::new(config)
    }

    #[test]
    fn dev_switcher_needs_disabled_mode_and_a_loopback_bind() {
        assert!(
            DevAuthState::new(dev_auth_config(AuthMode::Disabled, "127.0.0.1:9876")).enabled,
            "the local-dev path keeps the switcher",
        );
        assert!(
            !DevAuthState::new(dev_auth_config(AuthMode::Disabled, "0.0.0.0:9876")).enabled,
            "an exposed bind must not hand out identities, acknowledged or not",
        );
        assert!(
            !DevAuthState::new(dev_auth_config(AuthMode::Google, "127.0.0.1:9876")).enabled,
            "real sign-in leaves no room for the switcher",
        );
    }

    /// Mount both dev routes the way `main.rs` does. `enabled` picks the
    /// bind that produces it, so the routes under test are reachable only
    /// through the same gate production goes through.
    fn dev_auth_app(enabled: bool) -> Router {
        let bind = if enabled {
            "127.0.0.1:9876"
        } else {
            "0.0.0.0:9876"
        };
        let state = DevAuthState::new(dev_auth_config(AuthMode::Disabled, bind));
        assert_eq!(state.enabled, enabled, "helper picked the wrong bind");
        Router::new()
            .route(
                "/auth/dev/status",
                get(dev_status).with_state(state.clone()),
            )
            .route("/auth/dev/login", post(dev_login).with_state(state))
    }

    #[tokio::test]
    async fn dev_status_reports_disabled_auth_switcher_availability() {
        let app = dev_auth_app(true);
        let req = Request::builder()
            .uri("/auth/dev/status")
            .body(Body::empty())
            .unwrap();
        let res = app.oneshot(req).await.unwrap();
        assert_eq!(res.status(), StatusCode::OK);

        let body = axum::body::to_bytes(res.into_body(), 64 * 1024)
            .await
            .unwrap();
        let value: serde_json::Value = serde_json::from_slice(&body).unwrap();
        assert_eq!(value["enabled"], true);
        assert_eq!(value["default_principal"]["email"], "dev@local");
    }

    #[tokio::test]
    async fn dev_login_sets_principal_cookie_and_returns_principal() {
        let app = dev_auth_app(true);
        let req = Request::builder()
            .method("POST")
            .uri("/auth/dev/login")
            .header("content-type", "application/json")
            .body(Body::from(
                r#"{"email":"Viewer@Example.com","display_name":"Viewer","is_admin":false}"#,
            ))
            .unwrap();
        let res = app.oneshot(req).await.unwrap();
        assert_eq!(res.status(), StatusCode::OK);

        let set_cookie = res
            .headers()
            .get(SET_COOKIE)
            .expect("dev principal cookie")
            .to_str()
            .unwrap();
        assert!(set_cookie.contains("lucida_dev_principal="));
        assert!(set_cookie.contains("HttpOnly"));

        let body = axum::body::to_bytes(res.into_body(), 64 * 1024)
            .await
            .unwrap();
        let principal: AuthPrincipal = serde_json::from_slice(&body).unwrap();
        assert_eq!(principal.email, "viewer@example.com");
        assert_eq!(principal.display_name, "Viewer");
        assert!(!principal.is_admin);
    }

    #[tokio::test]
    async fn dev_login_404s_when_switcher_disabled() {
        let app = dev_auth_app(false);
        let req = Request::builder()
            .method("POST")
            .uri("/auth/dev/login")
            .header("content-type", "application/json")
            .body(Body::from(r#"{"email":"viewer@example.com"}"#))
            .unwrap();
        let res = app.oneshot(req).await.unwrap();
        assert_eq!(res.status(), StatusCode::NOT_FOUND);
    }

    // -- /auth/logout -----------------------------------------------------

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

        // Set-Cookie headers expected: clear lucida_session, set the
        // lucida_signed_out marker, and clear any dev-principal
        // override. Iterate get_all so we don't accidentally only see
        // the first one.
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
        assert!(
            set_cookies
                .iter()
                .any(|c| c.contains("lucida_dev_principal=") && c.contains("Max-Age=0"))
        );

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
        // Even cookieless callers get clearing cookies + the marker —
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
        assert!(
            set_cookies
                .iter()
                .any(|c| c.contains("lucida_dev_principal=") && c.contains("Max-Age=0"))
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
        assert!(
            set_cookies
                .iter()
                .any(|c| c.contains("lucida_dev_principal=") && c.contains("Max-Age=0"))
        );
    }

    // -- redirect_target + random_state_token ---------------------------

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
