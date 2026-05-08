//! Auth subsystem runtime configuration.
//!
//! Slice 2 (PRD #455) configured the cookie name, the SQLite database
//! file, the idle timeout, and the hard cap. Slice 4 layers Google
//! OAuth knobs on top: the `LUCIDA_AUTH` mode selector and the three
//! Google credentials needed to drive a real sign-in. Defaults stay
//! "boots without env vars" — the auth mode defaults to `Disabled`,
//! which keeps the dev-login + cookie path from slice 2 in place.
//!
//! The `Secure` cookie attribute is decided per-request, not at startup,
//! so it lives on `CookieConfig` next to the request scheme rather than
//! being baked in here.

use std::path::PathBuf;
use std::time::Duration;

/// Default cookie name. Overridable via `LUCIDA_COOKIE_NAME`.
pub const DEFAULT_COOKIE_NAME: &str = "lucida_session";

/// Default idle timeout: 7 days. A session must be touched within this
/// window or it's treated as expired on next lookup. Overridable via
/// `LUCIDA_SESSION_IDLE_TIMEOUT_HOURS`.
pub const DEFAULT_IDLE_TIMEOUT_HOURS: u64 = 168;

/// Default hard cap: 30 days. After this many hours from `created_at`,
/// the session is unconditionally dead, regardless of activity.
/// Overridable via `LUCIDA_SESSION_HARD_CAP_HOURS`.
pub const DEFAULT_HARD_CAP_HOURS: u64 = 720;

/// Default SQLite file. Resolves to `./lucida.db` so a fresh `cargo
/// run` produces a database in the working directory; production
/// deployments override via `LUCIDA_DB_PATH`.
pub const DEFAULT_DB_FILENAME: &str = "lucida.db";

/// Production Google authorization endpoint. Overridable via
/// `LUCIDA_GOOGLE_AUTH_URI` so integration tests can point at a mock.
pub const DEFAULT_GOOGLE_AUTH_URI: &str =
    "https://accounts.google.com/o/oauth2/v2/auth";

/// Production Google token endpoint. Overridable via
/// `LUCIDA_GOOGLE_TOKEN_URI`.
pub const DEFAULT_GOOGLE_TOKEN_URI: &str = "https://oauth2.googleapis.com/token";

/// Production Google JWKS endpoint. Overridable via
/// `LUCIDA_GOOGLE_JWKS_URI`.
pub const DEFAULT_GOOGLE_JWKS_URI: &str = "https://www.googleapis.com/oauth2/v3/certs";

/// Production JWT issuer values. Google sometimes signs with the host
/// `accounts.google.com` and sometimes with the URL scheme prefix; both
/// are valid per their docs. Overridable as a comma-separated list via
/// `LUCIDA_GOOGLE_ISSUER` for test harnesses that mint tokens with a
/// distinct issuer.
pub const DEFAULT_GOOGLE_ISSUERS: &[&str] =
    &["https://accounts.google.com", "accounts.google.com"];

/// How the `Secure` cookie attribute is chosen.
///
/// `Auto` (the default) sets `Secure` iff the request scheme is
/// `https`. `Always` sets it unconditionally — required when a TLS-
/// terminating proxy strips the scheme. `Never` skips it — the only
/// option that lets a non-loopback HTTP deployment work, used in dev
/// when nothing terminates TLS.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SecureCookieMode {
    Auto,
    Always,
    Never,
}

impl SecureCookieMode {
    /// Parse the env-var spelling. Unknown values fall back to `Auto`
    /// (matches the documented default rather than failing boot).
    pub fn parse(raw: &str) -> Self {
        match raw.trim().to_ascii_lowercase().as_str() {
            "always" => Self::Always,
            "never" => Self::Never,
            // "auto" or anything else falls through to Auto.
            _ => Self::Auto,
        }
    }
}

/// Auth backend selector.
///
/// Slice 4 (PRD #455) lands the explicit `Disabled` / `Google` toggle.
/// Slice 7 will layer the auto-detect-by-bind-address policy from
/// ADR-0018 on top of this; for now, absence of `LUCIDA_AUTH` means
/// `Disabled` (use the dev-login + cookie extractor) and an explicit
/// `LUCIDA_AUTH=google` switches on the OAuth flow.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AuthMode {
    /// Dev-friendly mode: no OAuth, sessions only via the dev-login
    /// endpoint. The slice-2 cookie extractor still runs; everything
    /// just bypasses the new sign-in flow.
    Disabled,
    /// Production OAuth: /auth/start + /auth/callback wired up against
    /// Google. Requires `LUCIDA_GOOGLE_CLIENT_ID`,
    /// `LUCIDA_GOOGLE_CLIENT_SECRET`, `LUCIDA_OAUTH_REDIRECT_URI`.
    Google,
}

impl AuthMode {
    pub fn parse(raw: &str) -> Self {
        match raw.trim().to_ascii_lowercase().as_str() {
            "google" => Self::Google,
            // anything else (including "disabled" and the empty string)
            // falls through to disabled. Slice 7 will tighten this with
            // a fail-loud branch for unknown values, but for slice 4 we
            // stay lenient so explicit `LUCIDA_AUTH=disabled` works.
            _ => Self::Disabled,
        }
    }

    pub fn is_google(self) -> bool {
        matches!(self, Self::Google)
    }
}

/// Configured Google OAuth credentials. Present only when
/// `LUCIDA_AUTH=google`; absent otherwise (dev-mode skips the
/// validation since the OAuth flow isn't wired).
#[derive(Debug, Clone)]
pub struct GoogleOAuthConfig {
    pub client_id: String,
    pub client_secret: String,
    pub redirect_uri: String,
    /// Authorization-endpoint URL (Google by default; overridable by
    /// `LUCIDA_GOOGLE_AUTH_URI` for integration tests against a mock).
    pub auth_uri: String,
    pub token_uri: String,
    pub jwks_uri: String,
    /// Allowed `iss` claim values. List rather than scalar because
    /// production Google signs with two host forms, and tests can
    /// override with their own.
    pub issuers: Vec<String>,
}

/// Why startup fail-fasted in `from_env`. Each variant names the
/// concrete `LUCIDA_*` env var the operator must set.
#[derive(Debug, thiserror::Error)]
pub enum AuthConfigError {
    #[error("LUCIDA_AUTH=google requires LUCIDA_GOOGLE_CLIENT_ID")]
    MissingClientId,
    #[error("LUCIDA_AUTH=google requires LUCIDA_GOOGLE_CLIENT_SECRET")]
    MissingClientSecret,
    #[error("LUCIDA_AUTH=google requires LUCIDA_OAUTH_REDIRECT_URI")]
    MissingRedirectUri,
}

/// All knobs the auth subsystem reads at startup.
///
/// Construction is via [`AuthConfig::from_env`] in production code and
/// [`AuthConfig::for_tests`] in unit tests. Handlers and middleware
/// receive an `Arc<AuthConfig>` so callers can clone cheaply.
#[derive(Debug, Clone)]
pub struct AuthConfig {
    pub cookie_name: String,
    pub secure_mode: SecureCookieMode,
    pub idle_timeout: Duration,
    pub hard_cap: Duration,
    pub db_path: PathBuf,
    pub mode: AuthMode,
    /// Populated iff `mode == AuthMode::Google`. Validated for
    /// presence-of-required-fields in `from_env` so handlers can
    /// `unwrap()` it without rechecking.
    pub google: Option<GoogleOAuthConfig>,
}

impl AuthConfig {
    /// Read configuration from process env vars, applying documented
    /// defaults for anything missing. Fail-fast when `LUCIDA_AUTH=google`
    /// and any required Google credential is absent.
    pub fn from_env() -> Result<Self, AuthConfigError> {
        let mode = std::env::var("LUCIDA_AUTH")
            .ok()
            .map(|raw| AuthMode::parse(&raw))
            .unwrap_or(AuthMode::Disabled);

        let google = if mode.is_google() {
            Some(google_from_env()?)
        } else {
            None
        };

        Ok(Self {
            cookie_name: std::env::var("LUCIDA_COOKIE_NAME")
                .unwrap_or_else(|_| DEFAULT_COOKIE_NAME.to_string()),
            secure_mode: std::env::var("LUCIDA_COOKIE_SECURE")
                .ok()
                .map(|raw| SecureCookieMode::parse(&raw))
                .unwrap_or(SecureCookieMode::Auto),
            idle_timeout: parse_hours_env("LUCIDA_SESSION_IDLE_TIMEOUT_HOURS")
                .unwrap_or_else(|| Duration::from_secs(DEFAULT_IDLE_TIMEOUT_HOURS * 3600)),
            hard_cap: parse_hours_env("LUCIDA_SESSION_HARD_CAP_HOURS")
                .unwrap_or_else(|| Duration::from_secs(DEFAULT_HARD_CAP_HOURS * 3600)),
            db_path: std::env::var("LUCIDA_DB_PATH")
                .map(PathBuf::from)
                .unwrap_or_else(|_| PathBuf::from(DEFAULT_DB_FILENAME)),
            mode,
            google,
        })
    }

    /// Test-friendly config: short timeouts, in-process cookie name,
    /// in-memory database path placeholder. Tests substitute the store
    /// directly so `db_path` is unused; we still provide one to keep
    /// the type closed.
    pub fn for_tests() -> Self {
        Self {
            cookie_name: DEFAULT_COOKIE_NAME.to_string(),
            secure_mode: SecureCookieMode::Auto,
            idle_timeout: Duration::from_secs(DEFAULT_IDLE_TIMEOUT_HOURS * 3600),
            hard_cap: Duration::from_secs(DEFAULT_HARD_CAP_HOURS * 3600),
            db_path: PathBuf::from(":memory:"),
            mode: AuthMode::Disabled,
            google: None,
        }
    }

    /// Test-friendly config with a synthetic Google block pointing at
    /// the supplied URLs. Used by the OAuth integration test harness so
    /// the real http endpoints are never reached.
    pub fn for_tests_google(client_id: &str, redirect_uri: &str, mock_base: &str) -> Self {
        let mut cfg = Self::for_tests();
        cfg.mode = AuthMode::Google;
        cfg.google = Some(GoogleOAuthConfig {
            client_id: client_id.to_string(),
            client_secret: "test-secret".to_string(),
            redirect_uri: redirect_uri.to_string(),
            auth_uri: format!("{mock_base}/oauth2/v2/auth"),
            token_uri: format!("{mock_base}/token"),
            jwks_uri: format!("{mock_base}/certs"),
            issuers: vec!["https://test-issuer".to_string()],
        });
        cfg
    }
}

fn google_from_env() -> Result<GoogleOAuthConfig, AuthConfigError> {
    let client_id = nonempty_env("LUCIDA_GOOGLE_CLIENT_ID")
        .ok_or(AuthConfigError::MissingClientId)?;
    let client_secret = nonempty_env("LUCIDA_GOOGLE_CLIENT_SECRET")
        .ok_or(AuthConfigError::MissingClientSecret)?;
    let redirect_uri = nonempty_env("LUCIDA_OAUTH_REDIRECT_URI")
        .ok_or(AuthConfigError::MissingRedirectUri)?;

    Ok(GoogleOAuthConfig {
        client_id,
        client_secret,
        redirect_uri,
        auth_uri: nonempty_env("LUCIDA_GOOGLE_AUTH_URI")
            .unwrap_or_else(|| DEFAULT_GOOGLE_AUTH_URI.to_string()),
        token_uri: nonempty_env("LUCIDA_GOOGLE_TOKEN_URI")
            .unwrap_or_else(|| DEFAULT_GOOGLE_TOKEN_URI.to_string()),
        jwks_uri: nonempty_env("LUCIDA_GOOGLE_JWKS_URI")
            .unwrap_or_else(|| DEFAULT_GOOGLE_JWKS_URI.to_string()),
        issuers: nonempty_env("LUCIDA_GOOGLE_ISSUER")
            .map(|raw| {
                raw.split(',')
                    .map(|s| s.trim().to_string())
                    .filter(|s| !s.is_empty())
                    .collect()
            })
            .unwrap_or_else(|| {
                DEFAULT_GOOGLE_ISSUERS
                    .iter()
                    .map(|s| s.to_string())
                    .collect()
            }),
    })
}

/// Read an env var, treating empty strings as absence. Operators
/// commonly land empty-string entries in deploy scripts; `Some("")` for
/// a credential is a worse failure mode than "missing entirely."
fn nonempty_env(name: &str) -> Option<String> {
    std::env::var(name).ok().filter(|v| !v.trim().is_empty())
}

fn parse_hours_env(name: &str) -> Option<Duration> {
    std::env::var(name)
        .ok()
        .and_then(|raw| raw.trim().parse::<u64>().ok())
        .map(|hours| Duration::from_secs(hours * 3600))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn secure_mode_parsing_is_case_insensitive() {
        assert_eq!(SecureCookieMode::parse("Auto"), SecureCookieMode::Auto);
        assert_eq!(SecureCookieMode::parse("ALWAYS"), SecureCookieMode::Always);
        assert_eq!(SecureCookieMode::parse("never"), SecureCookieMode::Never);
        assert_eq!(SecureCookieMode::parse("nonsense"), SecureCookieMode::Auto);
    }

    #[test]
    fn for_tests_uses_documented_defaults() {
        let cfg = AuthConfig::for_tests();
        assert_eq!(cfg.cookie_name, DEFAULT_COOKIE_NAME);
        assert_eq!(cfg.idle_timeout.as_secs(), DEFAULT_IDLE_TIMEOUT_HOURS * 3600);
        assert_eq!(cfg.hard_cap.as_secs(), DEFAULT_HARD_CAP_HOURS * 3600);
        assert_eq!(cfg.mode, AuthMode::Disabled);
        assert!(cfg.google.is_none());
    }

    #[test]
    fn auth_mode_parses() {
        assert_eq!(AuthMode::parse("google"), AuthMode::Google);
        assert_eq!(AuthMode::parse("GOOGLE"), AuthMode::Google);
        assert_eq!(AuthMode::parse("disabled"), AuthMode::Disabled);
        assert_eq!(AuthMode::parse(""), AuthMode::Disabled);
        assert_eq!(AuthMode::parse("microsoft"), AuthMode::Disabled);
    }

    #[test]
    fn for_tests_google_carries_overridden_endpoints() {
        let cfg = AuthConfig::for_tests_google("cid", "https://app/cb", "https://mock");
        assert!(cfg.mode.is_google());
        let g = cfg.google.expect("Google block");
        assert_eq!(g.client_id, "cid");
        assert_eq!(g.redirect_uri, "https://app/cb");
        assert_eq!(g.auth_uri, "https://mock/oauth2/v2/auth");
        assert_eq!(g.token_uri, "https://mock/token");
        assert_eq!(g.jwks_uri, "https://mock/certs");
    }
}
