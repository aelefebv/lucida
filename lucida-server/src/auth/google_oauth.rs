//! Encapsulates Google's OAuth surface: build the authorization URL,
//! exchange the authorization code for an ID token, fetch + cache the
//! signing JWKS, and validate inbound JWTs.
//!
//! The module intentionally hides the protocol specifics from
//! `handlers.rs`; the handler layer only sees `Client::authorize_url`,
//! `Client::exchange_code`, and `Client::validate_id_token`.
//!
//! ## JWKS cache
//!
//! Google rotates signing keys roughly weekly. We cache the key set in
//! memory and only refresh on two triggers:
//!
//! 1. **Time-based**: `JWKS_REFRESH_INTERVAL` (24h) — even if every
//!    token validates, we refetch so the next rotation lands a fresh
//!    cache without a request-time stall.
//! 2. **On validation failure**: a JWT signed with an unknown `kid` is
//!    the canonical "Google rotated, our cache is stale" signal. We
//!    refetch eagerly and retry the validation once before giving up.
//!
//! The cache is wrapped in `Arc<RwLock<…>>` so concurrent validations
//! share one cache; a refetch grabs the write lock briefly while the
//! readers fall through to the new state.
//!
//! ## Test harness
//!
//! Production points at `accounts.google.com`. Integration tests
//! override `auth_uri`, `token_uri`, `jwks_uri`, and the allowed
//! issuer list via `AuthConfig::for_tests_google` so a tiny mock axum
//! app can pretend to be Google. The `Client` doesn't know — every
//! endpoint comes from config.

use std::sync::Arc;
use std::time::{Duration, Instant};

use jsonwebtoken::jwk::JwkSet;
use jsonwebtoken::{Algorithm, DecodingKey, Validation, decode, decode_header};
use serde::Deserialize;
use thiserror::Error;
use tokio::sync::RwLock;
use tracing::{debug, warn};

use super::config::GoogleOAuthConfig;

/// How long a fetched JWKS is trusted before a background refresh.
/// Refresh is triggered lazily on the next `validate_id_token` call
/// after this elapses (no background timer; the token-validation path
/// is the only call site that needs fresh keys).
pub const JWKS_REFRESH_INTERVAL: Duration = Duration::from_secs(24 * 3600);

/// What the handler layer pulls out of a verified ID token. Mirrors
/// the subset of Google ID-token claims we actually consume — anything
/// else from Google (`sub`, `aud`, `iat`) is checked-and-discarded by
/// the validator. `email_verified` is captured here so the
/// unverified-rejection branch in the callback handler has a place to
/// read from.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct VerifiedClaims {
    pub email: String,
    pub email_verified: bool,
    pub name: Option<String>,
    pub picture: Option<String>,
    pub hd: Option<String>,
}

/// Failure modes from the OAuth client. Distinguished so the handler
/// can pick the right `auth.signin.error.*` event name and HTTP status.
///
/// `Network` covers cases where reqwest itself fails (DNS, TCP, TLS)
/// reaching Google's token endpoint or JWKS endpoint. Rolling these
/// into `CodeExchange` / `JwksFetch` would blur two distinct
/// dashboards (Google rejected our code vs we couldn't reach Google
/// at all).
#[derive(Debug, Error)]
pub enum OAuthError {
    #[error("token endpoint exchange failed: {0}")]
    CodeExchange(String),
    #[error("JWKS fetch failed: {0}")]
    JwksFetch(String),
    #[error("JWT validation failed: {0}")]
    JwtInvalid(String),
    #[error("network failure reaching Google: {0}")]
    Network(String),
}

/// OpenID Connect `prompt` parameter values we use. Only `SelectAccount`
/// is wired today (post-logout re-sign-in, so Google shows the chooser
/// instead of silently passing through its still-active session). Listed
/// as a typed enum rather than passing strings so call sites can't typo
/// the on-the-wire value, and so adding `Login` / `Consent` later is
/// localized to this enum + the `as_str` arm.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Prompt {
    SelectAccount,
}

impl Prompt {
    fn as_str(self) -> &'static str {
        match self {
            Prompt::SelectAccount => "select_account",
        }
    }
}

/// The bytes Google returns from the token endpoint on success. We
/// only care about `id_token`; `access_token`, `expires_in`, etc are
/// irrelevant in the backend-mediated flow (we don't keep a Google
/// session past login).
#[derive(Debug, Deserialize)]
struct TokenResponse {
    id_token: String,
}

/// Error response body from the token endpoint. Google returns a JSON
/// `error` + optional `error_description`; pulling them out gives the
/// operator log line a useful breadcrumb.
#[derive(Debug, Deserialize)]
struct TokenErrorResponse {
    error: String,
    error_description: Option<String>,
}

/// What `decode` expects to find in the JWT body. Google supplies more
/// (locale, family_name, given_name, etc.); we map only what we use.
#[derive(Debug, Deserialize)]
struct GoogleClaims {
    email: String,
    #[serde(default)]
    email_verified: bool,
    name: Option<String>,
    picture: Option<String>,
    hd: Option<String>,
    // Standard claims jsonwebtoken validates for us; we receive them
    // here so the deserializer doesn't reject the payload.
    #[allow(dead_code)]
    #[serde(default)]
    iss: Option<String>,
    #[allow(dead_code)]
    #[serde(default)]
    aud: Option<String>,
    #[allow(dead_code)]
    #[serde(default)]
    exp: Option<i64>,
}

/// In-memory JWKS cache. Holds the parsed `JwkSet` plus the wall-clock
/// instant we fetched it; consumers refresh when `fetched_at + interval
/// < now`. Cache miss path is "set the new value and forget the old."
struct JwksCache {
    keys: JwkSet,
    fetched_at: Instant,
}

/// The OAuth client used by handlers. Cheap to clone (everything inside
/// is `Arc`/owned-string).
#[derive(Clone)]
pub struct GoogleOAuthClient {
    config: Arc<GoogleOAuthConfig>,
    http: reqwest::Client,
    jwks: Arc<RwLock<JwksCache>>,
}

impl GoogleOAuthClient {
    /// Build the client and prime the JWKS cache. We fail-fast when the
    /// initial fetch fails — the server should not boot in a state
    /// where every sign-in attempt is destined to 500.
    pub async fn new(config: Arc<GoogleOAuthConfig>) -> Result<Self, OAuthError> {
        let http = reqwest::Client::builder()
            .timeout(Duration::from_secs(15))
            .build()
            .map_err(|e| OAuthError::JwksFetch(e.to_string()))?;

        let initial = fetch_jwks(&http, &config.jwks_uri).await?;
        let jwks = Arc::new(RwLock::new(JwksCache {
            keys: initial,
            fetched_at: Instant::now(),
        }));

        Ok(Self { config, http, jwks })
    }

    /// Build a Google authorization URL targeting the configured
    /// `redirect_uri` with the supplied state token. Handler stashes the
    /// state token in `pending_auth` first; this helper just emits the
    /// URL the redirect goes to.
    ///
    /// Scope = `openid email profile`, response_type = `code`. We omit
    /// `access_type=offline` deliberately (no refresh tokens in v1 —
    /// see ADR-0016 §"Why no refresh tokens in v1").
    ///
    /// `prompt` is `Some(Prompt::SelectAccount)` only on the post-logout
    /// re-sign-in path (`/auth/start` set the `lucida_signed_out` marker
    /// cookie). Cold and session-expiry paths pass `None` to keep the
    /// friction-free silent pass-through Google does when its session
    /// is still active.
    pub fn authorize_url(&self, state: &str, prompt: Option<Prompt>) -> String {
        // Manual URL build (rather than `reqwest::Url::parse_with_params`)
        // keeps the dependency surface narrow and the output bytewise
        // predictable for assertion in tests.
        let cfg = &self.config;
        let mut url = format!(
            "{base}?client_id={client_id}&redirect_uri={redirect_uri}&response_type=code&scope={scope}&state={state}",
            base = cfg.auth_uri,
            client_id = urlencoding::encode(&cfg.client_id),
            redirect_uri = urlencoding::encode(&cfg.redirect_uri),
            scope = urlencoding::encode("openid email profile"),
            state = urlencoding::encode(state),
        );
        if let Some(p) = prompt {
            url.push_str("&prompt=");
            url.push_str(&urlencoding::encode(p.as_str()));
        }
        url
    }

    /// Exchange a callback `code` for an ID token. POSTs the
    /// `application/x-www-form-urlencoded` body Google's docs require;
    /// returns the verified claims on success.
    pub async fn exchange_and_validate(&self, code: &str) -> Result<VerifiedClaims, OAuthError> {
        let id_token = self.exchange_code(code).await?;
        self.validate_id_token(&id_token).await
    }

    async fn exchange_code(&self, code: &str) -> Result<String, OAuthError> {
        let cfg = &self.config;
        let res = self
            .http
            .post(&cfg.token_uri)
            .form(&[
                ("code", code),
                ("client_id", &cfg.client_id),
                ("client_secret", &cfg.client_secret),
                ("redirect_uri", &cfg.redirect_uri),
                ("grant_type", "authorization_code"),
            ])
            .send()
            .await
            .map_err(|e| classify_transport_error(e, OAuthError::CodeExchange))?;

        let status = res.status();
        if !status.is_success() {
            // Try to surface Google's structured error for the operator
            // log. Fall back to the raw body if it isn't the documented
            // JSON shape.
            let raw = res.text().await.unwrap_or_else(|_| "<no body>".to_string());
            let detail = match serde_json::from_str::<TokenErrorResponse>(&raw) {
                Ok(parsed) => match parsed.error_description {
                    Some(d) => format!("{}: {}", parsed.error, d),
                    None => parsed.error,
                },
                Err(_) => raw,
            };
            return Err(OAuthError::CodeExchange(format!(
                "status {}: {}",
                status, detail
            )));
        }

        let body: TokenResponse = res
            .json()
            .await
            .map_err(|e| OAuthError::CodeExchange(format!("decode body: {e}")))?;
        Ok(body.id_token)
    }

    /// Validate the JWT against Google's JWKS + the configured issuer
    /// + the configured client_id (audience). On unknown-kid, refresh
    ///   the cache and retry exactly once — Google rotated mid-cache.
    pub async fn validate_id_token(&self, token: &str) -> Result<VerifiedClaims, OAuthError> {
        let header = decode_header(token)
            .map_err(|e| OAuthError::JwtInvalid(format!("header decode: {e}")))?;
        let kid = header
            .kid
            .ok_or_else(|| OAuthError::JwtInvalid("missing kid in JWT header".into()))?;

        // Time-based refresh: cheap check on the read side; only the
        // refresher takes the write lock.
        if self.cache_is_stale().await {
            self.refresh_jwks().await?;
        }

        match self.try_validate(token, &kid).await {
            Ok(claims) => Ok(claims),
            Err(OAuthError::JwtInvalid(msg)) if msg.contains("unknown kid") => {
                // Force a refresh and retry once. Mid-cache key rotation
                // is the canonical reason an otherwise-valid JWT fails
                // with unknown kid.
                debug!(kid = %kid, "google_oauth.jwks.refresh.unknown_kid");
                self.refresh_jwks().await?;
                self.try_validate(token, &kid).await
            }
            Err(other) => Err(other),
        }
    }

    async fn cache_is_stale(&self) -> bool {
        let guard = self.jwks.read().await;
        guard.fetched_at.elapsed() > JWKS_REFRESH_INTERVAL
    }

    async fn refresh_jwks(&self) -> Result<(), OAuthError> {
        let new = fetch_jwks(&self.http, &self.config.jwks_uri).await?;
        let mut guard = self.jwks.write().await;
        guard.keys = new;
        guard.fetched_at = Instant::now();
        Ok(())
    }

    async fn try_validate(&self, token: &str, kid: &str) -> Result<VerifiedClaims, OAuthError> {
        let guard = self.jwks.read().await;
        let jwk = guard
            .keys
            .find(kid)
            .ok_or_else(|| OAuthError::JwtInvalid(format!("unknown kid {kid}")))?;
        let key = DecodingKey::from_jwk(jwk)
            .map_err(|e| OAuthError::JwtInvalid(format!("decoding key: {e}")))?;

        // Validation: signature + exp + iss + aud. We use RS256 because
        // Google's tokens are RS256 in practice; if Google ever migrates
        // to a different alg the JWKS will say so and we'll get a
        // header-decode failure pointing at the signature mismatch.
        let mut validation = Validation::new(Algorithm::RS256);
        let issuers: Vec<&str> = self.config.issuers.iter().map(String::as_str).collect();
        validation.set_issuer(&issuers);
        validation.set_audience(&[&self.config.client_id]);
        // `set_issuer` and `set_audience` constrain a claim that is present
        // and say nothing about one that is missing, and the default
        // required set is `exp` alone. Without this, a token that omits
        // `aud` skips the audience check instead of failing it.
        validation.set_required_spec_claims(&["exp", "iss", "aud"]);

        let data = decode::<GoogleClaims>(token, &key, &validation)
            .map_err(|e| OAuthError::JwtInvalid(e.to_string()))?;
        let c = data.claims;
        Ok(VerifiedClaims {
            email: c.email,
            email_verified: c.email_verified,
            name: c.name,
            picture: c.picture,
            hd: c.hd,
        })
    }
}

/// Classify a `reqwest::Error` as either a transport-layer failure (DNS,
/// TCP connect, TLS handshake, request timeout) or a fall-through that
/// the caller maps to its own variant (HTTP-level error, body decode).
/// Returns the transport variant directly; otherwise calls `fallback` to
/// build the caller's preferred variant from the stringified error.
///
/// Why not just check `is_status` and inverse: `reqwest::Error` doesn't
/// expose a single "transport vs protocol" boolean, so we look for the
/// signals that mean "we never reached Google" (`is_connect`, `is_timeout`,
/// `is_request`) and fall through on everything else.
fn classify_transport_error<F>(e: reqwest::Error, fallback: F) -> OAuthError
where
    F: FnOnce(String) -> OAuthError,
{
    if e.is_connect() || e.is_timeout() || e.is_request() {
        OAuthError::Network(e.to_string())
    } else {
        fallback(e.to_string())
    }
}

async fn fetch_jwks(http: &reqwest::Client, jwks_uri: &str) -> Result<JwkSet, OAuthError> {
    let res = http
        .get(jwks_uri)
        .send()
        .await
        .map_err(|e| classify_transport_error(e, OAuthError::JwksFetch))?;
    if !res.status().is_success() {
        return Err(OAuthError::JwksFetch(format!("status {}", res.status())));
    }
    let set = res
        .json::<JwkSet>()
        .await
        .map_err(|e| OAuthError::JwksFetch(format!("decode: {e}")))?;
    if set.keys.is_empty() {
        warn!(jwks_uri, "google_oauth.jwks.empty");
    }
    Ok(set)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::auth::config::AuthConfig;

    fn config_with_mock_base(base: &str) -> Arc<GoogleOAuthConfig> {
        let cfg = AuthConfig::for_tests_google("test-client", "https://app/cb", base);
        Arc::new(cfg.google.unwrap())
    }

    #[test]
    fn authorize_url_includes_required_params() {
        // Build a config object directly without contacting any
        // network — `authorize_url` doesn't touch the jwks cache.
        let config = config_with_mock_base("https://mock");
        let client = GoogleOAuthClient {
            config: config.clone(),
            http: reqwest::Client::new(),
            jwks: Arc::new(RwLock::new(JwksCache {
                keys: JwkSet { keys: vec![] },
                fetched_at: Instant::now(),
            })),
        };

        let url = client.authorize_url("state-xyz", None);
        assert!(url.starts_with("https://mock/oauth2/v2/auth?"));
        assert!(url.contains("client_id=test-client"));
        // redirect_uri is URL-encoded
        assert!(url.contains("redirect_uri=https%3A%2F%2Fapp%2Fcb"));
        assert!(url.contains("response_type=code"));
        assert!(url.contains("scope=openid%20email%20profile"));
        assert!(url.contains("state=state-xyz"));
        // No prompt parameter on the cold path.
        assert!(!url.contains("prompt="));
    }

    /// Post-logout re-sign-in path: `/auth/start` saw the marker cookie
    /// and asked for the account chooser. Google's docs prescribe
    /// `select_account` as the literal value; the URL-encoded form is
    /// `select_account` (underscore is reserved-safe).
    #[test]
    fn authorize_url_appends_prompt_select_account() {
        let config = config_with_mock_base("https://mock");
        let client = GoogleOAuthClient {
            config: config.clone(),
            http: reqwest::Client::new(),
            jwks: Arc::new(RwLock::new(JwksCache {
                keys: JwkSet { keys: vec![] },
                fetched_at: Instant::now(),
            })),
        };

        let url = client.authorize_url("state-xyz", Some(Prompt::SelectAccount));
        assert!(url.contains("&prompt=select_account"));
    }
}
