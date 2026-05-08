//! Auth subsystem runtime configuration.
//!
//! Slice 2 (PRD #455) configured the cookie name, the SQLite database
//! file, the idle timeout, and the hard cap. Slice 4 layers Google
//! OAuth knobs on top: the `LUCIDA_AUTH` mode selector and the three
//! Google credentials needed to drive a real sign-in. Slice 7 lands
//! `LUCIDA_BIND` and the auto-detect-by-bind policy from ADR-0018:
//! when `LUCIDA_AUTH` is unset, the auth mode is inferred from whether
//! the bind address is loopback (→ `Disabled`) or public (→ `Google`),
//! and the dangerous "disabled + non-loopback" combination requires an
//! explicit `LUCIDA_INSECURE=1` opt-in.
//!
//! `from_env_map` is the testable seam: it takes any `Fn(&str) ->
//! Option<String>` so unit tests can exercise every env-var permutation
//! without mutating process state. `from_env` is a thin wrapper that
//! plumbs `std::env::var` into it.
//!
//! The `Secure` cookie attribute is decided per-request, not at startup,
//! so it lives on `CookieConfig` next to the request scheme rather than
//! being baked in here.

use std::collections::HashSet;
use std::net::SocketAddr;
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

/// Default listen address. ADR-0018: loopback-by-default makes the
/// auto-detect-by-bind safety property hold for the zero-config dev
/// path (`cargo run --bin lucida-server` → localhost-only, auth off).
/// Production deployments override via `LUCIDA_BIND=0.0.0.0:9876` (or
/// the deployment-specific interface).
///
/// Behavior change: before slice 7 this binary bound `0.0.0.0:9876`
/// unconditionally. Existing deployment scripts that relied on the old
/// default need to set `LUCIDA_BIND` explicitly.
pub const DEFAULT_BIND_ADDR: &str = "127.0.0.1:9876";

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
/// Slice 7 (ADR-0018) layers the auto-detect-by-bind-address policy on
/// top: when `LUCIDA_AUTH` is unset, the mode is inferred from the
/// bind IP (loopback → `Disabled`, public → `Google`). Explicit
/// `LUCIDA_AUTH` always wins over the auto-detect.
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
    /// Parse an explicit `LUCIDA_AUTH` value. Slice 7 tightens this:
    /// unknown values (e.g. `microsoft`) are now an error, not a silent
    /// fallthrough to `Disabled` — the latter would mask configuration
    /// typos that previously left a deploy in the wrong mode.
    pub fn parse(raw: &str) -> Result<Self, UnknownAuthMode> {
        match raw.trim().to_ascii_lowercase().as_str() {
            "google" => Ok(Self::Google),
            "disabled" => Ok(Self::Disabled),
            other => Err(UnknownAuthMode(other.to_string())),
        }
    }

    pub fn is_google(self) -> bool {
        matches!(self, Self::Google)
    }
}

/// `LUCIDA_AUTH` was set to a value `AuthMode::parse` doesn't recognize.
/// The string is captured so the error message names the offending value.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct UnknownAuthMode(pub String);

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
/// concrete `LUCIDA_*` env var the operator must set (or the offending
/// value, for the parse-failure variants).
#[derive(Debug, thiserror::Error)]
pub enum AuthConfigError {
    #[error("LUCIDA_AUTH=google requires LUCIDA_GOOGLE_CLIENT_ID")]
    MissingClientId,
    #[error("LUCIDA_AUTH=google requires LUCIDA_GOOGLE_CLIENT_SECRET")]
    MissingClientSecret,
    #[error("LUCIDA_AUTH=google requires LUCIDA_OAUTH_REDIRECT_URI")]
    MissingRedirectUri,
    #[error(
        "LUCIDA_AUTH={0:?} is not a recognized value (expected `google` or `disabled`)"
    )]
    UnknownAuthMode(String),
    #[error(
        "LUCIDA_BIND={value:?} is not a valid socket address ({reason})"
    )]
    InvalidBindAddr { value: String, reason: String },
    /// `LUCIDA_AUTH=disabled` on a non-loopback bind requires
    /// `LUCIDA_INSECURE=1` as an explicit acknowledgment that the
    /// server will be exposed without authentication. ADR-0018: the
    /// dangerous combination must be impossible to reach by accident.
    #[error(
        "LUCIDA_AUTH=disabled with non-loopback LUCIDA_BIND={bind} requires LUCIDA_INSECURE=1 \
         (set it to acknowledge that the server will be exposed without authentication)"
    )]
    InsecureRequiresOptIn { bind: SocketAddr },
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
    /// Slice 5 (PRD #455 §"Hosted-domain validation"): when non-empty,
    /// callbacks reject any JWT whose `hd` claim isn't in this set.
    /// Empty = no restriction (the OSS-permissive default; matches
    /// "any verified Google email" per user-story 11). Both this set
    /// and the `hd` claim are lowercased before comparison so casing
    /// drift in env vars or upstream tokens never silently rejects.
    pub allowed_hosted_domains: HashSet<String>,
    /// Slice 6 (PRD #455 §"Admin role bootstrap"): emails granted
    /// `is_admin: true` at principal-extraction time. Empty = no admins
    /// (admin-only endpoints return 403 for everyone). Lowercased at
    /// parse time; the principal email is also lowercased before lookup
    /// so casing drift never silently demotes. Admin status is derived
    /// per-request, not persisted on `LoginSession` — promote/demote is
    /// a config-change-and-restart that takes effect on the next request.
    pub admin_emails: HashSet<String>,
    /// Slice 7 (ADR-0018): the socket the server binds. Default is
    /// loopback (`127.0.0.1:9876`); production deployments override
    /// via `LUCIDA_BIND`. The auth mode auto-detect keys off
    /// `bind_addr.ip().is_loopback()`.
    pub bind_addr: SocketAddr,
    /// Slice 7 (ADR-0018): explicit acknowledgment that the operator
    /// is intentionally running with auth disabled on a non-loopback
    /// bind. Always `false` on the safe paths; `true` only when the
    /// operator set `LUCIDA_INSECURE=1`. The bool is preserved for
    /// startup-logging and audit purposes; the validation that it must
    /// be set has already happened by the time `from_env` returns Ok.
    pub insecure_acknowledged: bool,
}

impl AuthConfig {
    /// Read configuration from process env vars, applying documented
    /// defaults for anything missing. Fail-fast when `LUCIDA_AUTH=google`
    /// and any required Google credential is absent, when `LUCIDA_BIND`
    /// is malformed, when `LUCIDA_AUTH` is an unknown value, or when
    /// the dangerous "disabled + non-loopback" combination is requested
    /// without `LUCIDA_INSECURE=1`.
    pub fn from_env() -> Result<Self, AuthConfigError> {
        Self::from_env_map(|name| std::env::var(name).ok())
    }

    /// Pure-function variant of [`from_env`] driven by a closure. The
    /// only parameter is the env-var reader: tests pass a HashMap-
    /// backed closure to exercise every permutation without touching
    /// process state (env vars are global, so two parallel tests
    /// fighting over `LUCIDA_AUTH` would be flaky). Production code
    /// uses [`from_env`], which threads `std::env::var` in.
    pub fn from_env_map<F>(read: F) -> Result<Self, AuthConfigError>
    where
        F: Fn(&str) -> Option<String>,
    {
        let nonempty = |name: &str| read(name).filter(|v| !v.trim().is_empty());

        // ---- bind address ---------------------------------------------------
        // Parse first so the auto-detect below can branch on it. The
        // loopback question is the safety hinge for everything else.
        let bind_raw = nonempty("LUCIDA_BIND")
            .unwrap_or_else(|| DEFAULT_BIND_ADDR.to_string());
        let bind_addr: SocketAddr = bind_raw.parse().map_err(|e: std::net::AddrParseError| {
            AuthConfigError::InvalidBindAddr {
                value: bind_raw.clone(),
                reason: e.to_string(),
            }
        })?;
        let bind_is_loopback = bind_addr.ip().is_loopback();

        // ---- auth mode (explicit override > auto-detect) --------------------
        let mode = match nonempty("LUCIDA_AUTH") {
            Some(raw) => AuthMode::parse(&raw)
                .map_err(|UnknownAuthMode(s)| AuthConfigError::UnknownAuthMode(s))?,
            // ADR-0018 auto-detect: loopback → safe to default off,
            // public → require Google (fail-fasts below if creds missing).
            None => {
                if bind_is_loopback {
                    AuthMode::Disabled
                } else {
                    AuthMode::Google
                }
            }
        };

        // ---- LUCIDA_INSECURE gate for the dangerous combination -------------
        // Only relevant when mode == Disabled AND bind is non-loopback.
        // Both safe paths skip the check; the unsafe path requires the
        // operator to opt in explicitly (and `main.rs` prints a banner).
        let insecure_acknowledged = nonempty("LUCIDA_INSECURE")
            .map(|v| v.trim() == "1")
            .unwrap_or(false);
        if matches!(mode, AuthMode::Disabled) && !bind_is_loopback && !insecure_acknowledged {
            return Err(AuthConfigError::InsecureRequiresOptIn { bind: bind_addr });
        }

        // ---- Google OAuth credentials (only when mode == Google) ------------
        let google = if mode.is_google() {
            Some(google_from_reader(&nonempty)?)
        } else {
            None
        };

        Ok(Self {
            cookie_name: read("LUCIDA_COOKIE_NAME")
                .unwrap_or_else(|| DEFAULT_COOKIE_NAME.to_string()),
            secure_mode: read("LUCIDA_COOKIE_SECURE")
                .map(|raw| SecureCookieMode::parse(&raw))
                .unwrap_or(SecureCookieMode::Auto),
            idle_timeout: parse_hours(&read, "LUCIDA_SESSION_IDLE_TIMEOUT_HOURS")
                .unwrap_or_else(|| Duration::from_secs(DEFAULT_IDLE_TIMEOUT_HOURS * 3600)),
            hard_cap: parse_hours(&read, "LUCIDA_SESSION_HARD_CAP_HOURS")
                .unwrap_or_else(|| Duration::from_secs(DEFAULT_HARD_CAP_HOURS * 3600)),
            db_path: read("LUCIDA_DB_PATH")
                .map(PathBuf::from)
                .unwrap_or_else(|| PathBuf::from(DEFAULT_DB_FILENAME)),
            mode,
            google,
            allowed_hosted_domains: parse_allowed_hosted_domains(
                read("LUCIDA_ALLOWED_HOSTED_DOMAINS").as_deref(),
            ),
            admin_emails: parse_admin_emails(read("LUCIDA_ADMIN_EMAILS").as_deref()),
            bind_addr,
            insecure_acknowledged,
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
            allowed_hosted_domains: HashSet::new(),
            admin_emails: HashSet::new(),
            bind_addr: DEFAULT_BIND_ADDR.parse().expect("default bind parses"),
            insecure_acknowledged: false,
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

fn google_from_reader<F>(nonempty: &F) -> Result<GoogleOAuthConfig, AuthConfigError>
where
    F: Fn(&str) -> Option<String>,
{
    let client_id = nonempty("LUCIDA_GOOGLE_CLIENT_ID")
        .ok_or(AuthConfigError::MissingClientId)?;
    let client_secret = nonempty("LUCIDA_GOOGLE_CLIENT_SECRET")
        .ok_or(AuthConfigError::MissingClientSecret)?;
    let redirect_uri = nonempty("LUCIDA_OAUTH_REDIRECT_URI")
        .ok_or(AuthConfigError::MissingRedirectUri)?;

    Ok(GoogleOAuthConfig {
        client_id,
        client_secret,
        redirect_uri,
        auth_uri: nonempty("LUCIDA_GOOGLE_AUTH_URI")
            .unwrap_or_else(|| DEFAULT_GOOGLE_AUTH_URI.to_string()),
        token_uri: nonempty("LUCIDA_GOOGLE_TOKEN_URI")
            .unwrap_or_else(|| DEFAULT_GOOGLE_TOKEN_URI.to_string()),
        jwks_uri: nonempty("LUCIDA_GOOGLE_JWKS_URI")
            .unwrap_or_else(|| DEFAULT_GOOGLE_JWKS_URI.to_string()),
        issuers: nonempty("LUCIDA_GOOGLE_ISSUER")
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

fn parse_hours<F>(read: &F, name: &str) -> Option<Duration>
where
    F: Fn(&str) -> Option<String>,
{
    read(name)
        .and_then(|raw| raw.trim().parse::<u64>().ok())
        .map(|hours| Duration::from_secs(hours * 3600))
}

/// Parse the `LUCIDA_ALLOWED_HOSTED_DOMAINS` env var into a lowercased
/// `HashSet`. None / empty / whitespace-only → empty set ("no
/// restriction" — the OSS-permissive default per ADR-0017). Comma-
/// separated; whitespace around entries is tolerated. Duplicate entries
/// collapse via the set semantics, lowercase normalization avoids
/// `Calicolabs.com` vs `calicolabs.com` near-misses since both env-var
/// authoring and Google's `hd` claim should be treated case-insensitively.
pub(crate) fn parse_allowed_hosted_domains(raw: Option<&str>) -> HashSet<String> {
    parse_lowercased_csv(raw)
}

/// Parse the `LUCIDA_ADMIN_EMAILS` env var into a lowercased `HashSet`.
/// Same shape as the hosted-domains parser: None / empty / whitespace-only
/// → empty set (no admins; admin-only endpoints 403 for everyone). The
/// principal email is also lowercased before lookup, so casing mismatch
/// between env var and JWT email never silently demotes.
pub(crate) fn parse_admin_emails(raw: Option<&str>) -> HashSet<String> {
    parse_lowercased_csv(raw)
}

/// Comma-separated, whitespace-tolerant, lowercased, empty-collapsing
/// parser. Both [`parse_allowed_hosted_domains`] and
/// [`parse_admin_emails`] share this shape; the helper keeps the
/// behavior identical so case-sensitivity bugs don't drift between the
/// two env vars.
fn parse_lowercased_csv(raw: Option<&str>) -> HashSet<String> {
    let Some(raw) = raw else {
        return HashSet::new();
    };
    raw.split(',')
        .map(|s| s.trim().to_ascii_lowercase())
        .filter(|s| !s.is_empty())
        .collect()
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
    fn auth_mode_parses_known_values() {
        assert_eq!(AuthMode::parse("google").unwrap(), AuthMode::Google);
        assert_eq!(AuthMode::parse("GOOGLE").unwrap(), AuthMode::Google);
        assert_eq!(AuthMode::parse(" google ").unwrap(), AuthMode::Google);
        assert_eq!(AuthMode::parse("disabled").unwrap(), AuthMode::Disabled);
        assert_eq!(AuthMode::parse("DISABLED").unwrap(), AuthMode::Disabled);
    }

    #[test]
    fn auth_mode_parses_unknown_value_fails() {
        // Slice 7 (ADR-0018): silent fallthrough was a footgun. The
        // operator who typed `microsoft` in their deploy script wants
        // a fail-fast at boot, not a server that quietly disabled auth.
        let err = AuthMode::parse("microsoft").unwrap_err();
        assert_eq!(err, UnknownAuthMode("microsoft".to_string()));
        let err = AuthMode::parse("").unwrap_err();
        assert_eq!(err, UnknownAuthMode("".to_string()));
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

    // -- LUCIDA_ALLOWED_HOSTED_DOMAINS parsing (slice 5) ----------------

    #[test]
    fn allowed_hosted_domains_unset_is_empty_set() {
        let set = parse_allowed_hosted_domains(None);
        assert!(set.is_empty(), "unset env var = no restriction");
    }

    #[test]
    fn allowed_hosted_domains_empty_string_is_empty_set() {
        assert!(parse_allowed_hosted_domains(Some("")).is_empty());
        assert!(parse_allowed_hosted_domains(Some("   ")).is_empty());
        assert!(
            parse_allowed_hosted_domains(Some(",,")).is_empty(),
            "all-empty entries collapse",
        );
    }

    #[test]
    fn allowed_hosted_domains_single_value() {
        let set = parse_allowed_hosted_domains(Some("calicolabs.com"));
        assert_eq!(set.len(), 1);
        assert!(set.contains("calicolabs.com"));
    }

    #[test]
    fn allowed_hosted_domains_multi_value_with_whitespace() {
        let set = parse_allowed_hosted_domains(Some("calicolabs.com, othercorp.com ,third.org"));
        assert_eq!(set.len(), 3);
        assert!(set.contains("calicolabs.com"));
        assert!(set.contains("othercorp.com"));
        assert!(set.contains("third.org"));
    }

    #[test]
    fn allowed_hosted_domains_lowercased_for_case_insensitive_match() {
        let set = parse_allowed_hosted_domains(Some("Calicolabs.COM,OtherCorp.com"));
        assert!(set.contains("calicolabs.com"));
        assert!(set.contains("othercorp.com"));
        assert!(!set.contains("Calicolabs.COM"), "values are normalized");
    }

    // -- LUCIDA_ADMIN_EMAILS parsing (slice 6) --------------------------

    #[test]
    fn admin_emails_unset_is_empty_set() {
        let set = parse_admin_emails(None);
        assert!(set.is_empty(), "unset env var = no admins");
    }

    #[test]
    fn admin_emails_empty_string_is_empty_set() {
        assert!(parse_admin_emails(Some("")).is_empty());
        assert!(parse_admin_emails(Some("   ")).is_empty());
        assert!(parse_admin_emails(Some(",,")).is_empty(), "all-empty entries collapse");
    }

    #[test]
    fn admin_emails_single_value() {
        let set = parse_admin_emails(Some("austin@calicolabs.com"));
        assert_eq!(set.len(), 1);
        assert!(set.contains("austin@calicolabs.com"));
    }

    #[test]
    fn admin_emails_multi_value_with_whitespace() {
        let set = parse_admin_emails(Some("a@x.com, b@x.com ,c@y.org"));
        assert_eq!(set.len(), 3);
        assert!(set.contains("a@x.com"));
        assert!(set.contains("b@x.com"));
        assert!(set.contains("c@y.org"));
    }

    #[test]
    fn admin_emails_lowercased_for_case_insensitive_match() {
        // Operator authoring `AuStin@CalicoLabs.com` in the env var must
        // still match a JWT-derived `austin@calicolabs.com` principal.
        let set = parse_admin_emails(Some("AuStin@CalicoLabs.com,Other@x.COM"));
        assert!(set.contains("austin@calicolabs.com"));
        assert!(set.contains("other@x.com"));
        assert!(!set.contains("AuStin@CalicoLabs.com"), "values are normalized");
    }

    #[test]
    fn for_tests_seeds_empty_admin_emails() {
        let cfg = AuthConfig::for_tests();
        assert!(cfg.admin_emails.is_empty(), "tests start with no admins");
    }

    // -- LUCIDA_BIND + auto-detect (slice 7, ADR-0018) ------------------
    //
    // All permutations driven through `from_env_map` so we never touch
    // process-global env vars: tests can run in parallel without
    // racing on `set_var`/`remove_var`.

    use std::collections::HashMap;

    fn reader(entries: &[(&str, &str)]) -> impl Fn(&str) -> Option<String> {
        let map: HashMap<String, String> =
            entries.iter().map(|(k, v)| (k.to_string(), v.to_string())).collect();
        move |name: &str| map.get(name).cloned()
    }

    /// Minimal Google credentials so an `LUCIDA_AUTH=google` config
    /// passes the validation step without us having to repeat the
    /// triple in every test.
    fn google_creds() -> Vec<(&'static str, &'static str)> {
        vec![
            ("LUCIDA_GOOGLE_CLIENT_ID", "id"),
            ("LUCIDA_GOOGLE_CLIENT_SECRET", "secret"),
            ("LUCIDA_OAUTH_REDIRECT_URI", "https://app/cb"),
        ]
    }

    #[test]
    fn for_tests_seeds_loopback_bind_and_no_insecure_ack() {
        let cfg = AuthConfig::for_tests();
        assert!(cfg.bind_addr.ip().is_loopback());
        assert_eq!(cfg.bind_addr.port(), 9876);
        assert!(!cfg.insecure_acknowledged);
    }

    #[test]
    fn from_env_default_is_loopback_disabled() {
        let cfg = AuthConfig::from_env_map(reader(&[])).expect("defaults parse");
        assert_eq!(cfg.mode, AuthMode::Disabled);
        assert_eq!(cfg.bind_addr.to_string(), DEFAULT_BIND_ADDR);
        assert!(cfg.bind_addr.ip().is_loopback());
        assert!(cfg.google.is_none());
        assert!(!cfg.insecure_acknowledged);
    }

    #[test]
    fn auto_detect_loopback_bind_defaults_to_disabled() {
        // No LUCIDA_AUTH set + loopback bind → safe path, no Google
        // creds required, mode = Disabled.
        for bind in ["127.0.0.1:9876", "127.0.0.5:8080", "[::1]:9876"] {
            let cfg = AuthConfig::from_env_map(reader(&[("LUCIDA_BIND", bind)]))
                .unwrap_or_else(|e| panic!("loopback bind {bind} should auto-detect Disabled: {e}"));
            assert_eq!(cfg.mode, AuthMode::Disabled, "bind={bind}");
            assert!(cfg.google.is_none());
        }
    }

    #[test]
    fn auto_detect_non_loopback_bind_defaults_to_google() {
        // No LUCIDA_AUTH + public bind → Google. With creds present,
        // construction succeeds. Without them, `from_env_map` would
        // error on MissingClientId — covered by the next test.
        let mut entries = vec![("LUCIDA_BIND", "0.0.0.0:9876")];
        entries.extend(google_creds());
        let cfg = AuthConfig::from_env_map(reader(&entries))
            .expect("non-loopback bind + google creds = ok");
        assert_eq!(cfg.mode, AuthMode::Google);
        assert!(cfg.google.is_some());
    }

    #[test]
    fn auto_detect_non_loopback_without_google_creds_fails() {
        // No LUCIDA_AUTH + public bind → defaults to Google → missing
        // CLIENT_ID is the named error. This is the path that catches
        // a production deploy that forgot to set credentials.
        let err = AuthConfig::from_env_map(reader(&[("LUCIDA_BIND", "0.0.0.0:9876")]))
            .expect_err("missing google creds should fail");
        assert!(matches!(err, AuthConfigError::MissingClientId), "got {err:?}");
    }

    #[test]
    fn explicit_disabled_loopback_succeeds_without_insecure() {
        let cfg = AuthConfig::from_env_map(reader(&[
            ("LUCIDA_AUTH", "disabled"),
            ("LUCIDA_BIND", "127.0.0.1:9876"),
        ]))
        .expect("loopback + explicit disabled = ok");
        assert_eq!(cfg.mode, AuthMode::Disabled);
        assert!(!cfg.insecure_acknowledged);
    }

    #[test]
    fn explicit_disabled_non_loopback_without_insecure_fails() {
        // The dangerous combination. ADR-0018: must be impossible to
        // reach by accident.
        let err = AuthConfig::from_env_map(reader(&[
            ("LUCIDA_AUTH", "disabled"),
            ("LUCIDA_BIND", "0.0.0.0:9876"),
        ]))
        .expect_err("disabled + public bind should fail without LUCIDA_INSECURE");
        match err {
            AuthConfigError::InsecureRequiresOptIn { bind } => {
                assert_eq!(bind.to_string(), "0.0.0.0:9876");
            }
            other => panic!("expected InsecureRequiresOptIn, got {other:?}"),
        }
    }

    #[test]
    fn explicit_disabled_non_loopback_with_insecure_succeeds() {
        let cfg = AuthConfig::from_env_map(reader(&[
            ("LUCIDA_AUTH", "disabled"),
            ("LUCIDA_BIND", "0.0.0.0:9876"),
            ("LUCIDA_INSECURE", "1"),
        ]))
        .expect("LUCIDA_INSECURE=1 unlocks the dangerous combination");
        assert_eq!(cfg.mode, AuthMode::Disabled);
        assert!(cfg.insecure_acknowledged, "audit signal preserved on the config");
    }

    #[test]
    fn lucida_insecure_only_one_unlocks() {
        // The opt-in is the literal string "1". `true`, `yes`, etc. are
        // not recognized — the operator should be deliberate, not
        // accidentally enable it via a typo.
        for v in ["true", "yes", "0", "TRUE", "y"] {
            let err = AuthConfig::from_env_map(reader(&[
                ("LUCIDA_AUTH", "disabled"),
                ("LUCIDA_BIND", "0.0.0.0:9876"),
                ("LUCIDA_INSECURE", v),
            ]))
            .expect_err(&format!("LUCIDA_INSECURE={v:?} should not unlock"));
            assert!(matches!(err, AuthConfigError::InsecureRequiresOptIn { .. }));
        }
    }

    #[test]
    fn explicit_google_validates_credentials() {
        // Slice 4 already validated this; verify it still works after
        // the slice 7 reorganization.
        let err = AuthConfig::from_env_map(reader(&[("LUCIDA_AUTH", "google")]))
            .expect_err("google mode + missing creds should fail");
        assert!(matches!(err, AuthConfigError::MissingClientId));

        let err = AuthConfig::from_env_map(reader(&[
            ("LUCIDA_AUTH", "google"),
            ("LUCIDA_GOOGLE_CLIENT_ID", "id"),
        ]))
        .expect_err("missing client_secret should fail");
        assert!(matches!(err, AuthConfigError::MissingClientSecret));

        let err = AuthConfig::from_env_map(reader(&[
            ("LUCIDA_AUTH", "google"),
            ("LUCIDA_GOOGLE_CLIENT_ID", "id"),
            ("LUCIDA_GOOGLE_CLIENT_SECRET", "s"),
        ]))
        .expect_err("missing redirect_uri should fail");
        assert!(matches!(err, AuthConfigError::MissingRedirectUri));
    }

    #[test]
    fn unknown_auth_mode_fails_with_named_error() {
        let err = AuthConfig::from_env_map(reader(&[("LUCIDA_AUTH", "microsoft")]))
            .expect_err("unknown LUCIDA_AUTH should fail-fast");
        match err {
            AuthConfigError::UnknownAuthMode(s) => assert_eq!(s, "microsoft"),
            other => panic!("expected UnknownAuthMode, got {other:?}"),
        }
    }

    #[test]
    fn invalid_bind_addr_fails_with_named_error() {
        let err = AuthConfig::from_env_map(reader(&[("LUCIDA_BIND", "not-a-socket")]))
            .expect_err("malformed LUCIDA_BIND should fail-fast");
        match err {
            AuthConfigError::InvalidBindAddr { value, .. } => {
                assert_eq!(value, "not-a-socket");
            }
            other => panic!("expected InvalidBindAddr, got {other:?}"),
        }
    }

    #[test]
    fn empty_lucida_auth_falls_back_to_auto_detect() {
        // Empty string is treated as "unset" by the `nonempty` filter
        // — the auto-detect path runs. Without this, an env var
        // declared but left empty in a deploy script would fail with
        // UnknownAuthMode("").
        let cfg = AuthConfig::from_env_map(reader(&[("LUCIDA_AUTH", "")]))
            .expect("empty LUCIDA_AUTH = unset = auto-detect");
        assert_eq!(cfg.mode, AuthMode::Disabled);
    }
}
