//! Auth subsystem runtime configuration.
//!
//! Slice 2 (PRD #455) configures the cookie name, the SQLite database
//! file, the idle timeout, and the hard cap. Defaults are set so a fresh
//! checkout boots without any env vars; production deployments override
//! via environment variables documented in PRD #455 §"Configuration
//! surface".
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
}

impl AuthConfig {
    /// Read configuration from process env vars, applying documented
    /// defaults for anything missing.
    pub fn from_env() -> Self {
        Self {
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
        }
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
        }
    }
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
    }
}
