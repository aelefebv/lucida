//! `LUCIDA_DB_URL` — the connection string that picks a storage
//! backend.
//!
//! Parsing happens once, at startup, and produces a [`DatabaseUrl`]
//! whose scheme is already known to be one this build supports. That is
//! the point of the type: [`super::open`] matches on [`Scheme`] and has
//! no "unrecognized backend" arm to write, because a `DatabaseUrl` that
//! names an unrecognized backend cannot be constructed.
//!
//! Unsupported and malformed values are rejected here, so the operator
//! learns about a typo during boot rather than on the first request
//! that touches the database.

use std::borrow::Cow;
use std::fmt;

/// The default connection string when `LUCIDA_DB_URL` is unset: a
/// SQLite file named `lucida.db` in the working directory. A fresh
/// `cargo run` therefore needs no configuration at all.
const DEFAULT_DB_URL: &str = "sqlite://lucida.db";

/// An in-memory SQLite database. Nothing survives the process, which is
/// what tests want and what no deployment should ever ask for.
const IN_MEMORY_DB_URL: &str = "sqlite::memory:";

/// The storage backends this build can open.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Scheme {
    Sqlite,
}

impl Scheme {
    /// Every backend this build can open.
    ///
    /// One list, deliberately. [`Self::parse`] searches it and the
    /// unsupported-scheme error names it, so what the server accepts
    /// and what it advertises cannot drift apart. Adding a backend is
    /// two edits: a variant, which stops [`Self::as_str`] compiling
    /// until it is named, and an entry here.
    pub const ALL: &'static [Scheme] = &[Scheme::Sqlite];

    fn parse(raw: &str) -> Option<Self> {
        Self::ALL.iter().copied().find(|s| s.as_str() == raw)
    }

    pub fn as_str(&self) -> &'static str {
        match self {
            Self::Sqlite => "sqlite",
        }
    }

    fn advertised() -> String {
        Self::ALL
            .iter()
            .map(|s| s.as_str())
            .collect::<Vec<_>>()
            .join(", ")
    }
}

impl fmt::Display for Scheme {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.as_str())
    }
}

/// Why `LUCIDA_DB_URL` was rejected. Both variants name the environment
/// variable, because the operator sees this message with no other
/// context than a server that refused to start.
#[derive(Debug, thiserror::Error, PartialEq, Eq)]
pub enum DatabaseUrlError {
    #[error(
        "LUCIDA_DB_URL={value} is not a connection string \
         (expected a scheme prefix, for example `sqlite://lucida.db`)"
    )]
    Malformed { value: String },
    #[error(
        "LUCIDA_DB_URL requests the {scheme:?} backend, which this build does not support \
         (supported: {supported})"
    )]
    UnsupportedScheme { scheme: String, supported: String },
}

/// A connection string whose scheme names a backend this build can
/// open.
///
/// Holds the original string, because the backend needs the parts after
/// the scheme, and those parts are the backend's business rather than
/// this module's.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DatabaseUrl {
    raw: String,
    scheme: Scheme,
}

impl DatabaseUrl {
    /// Parse a connection string. The scheme is the text before the
    /// first colon, compared without regard to case, as URL schemes are
    /// case-insensitive.
    pub fn parse(raw: &str) -> Result<Self, DatabaseUrlError> {
        let trimmed = raw.trim();
        let Some((scheme_raw, rest)) = trimmed.split_once(':') else {
            return Err(DatabaseUrlError::Malformed {
                value: redact(trimmed).into_owned(),
            });
        };
        if scheme_raw.is_empty() || rest.is_empty() {
            return Err(DatabaseUrlError::Malformed {
                value: redact(trimmed).into_owned(),
            });
        }
        let lowered = scheme_raw.to_ascii_lowercase();
        let Some(scheme) = Scheme::parse(&lowered) else {
            return Err(DatabaseUrlError::UnsupportedScheme {
                scheme: lowered,
                supported: Scheme::advertised(),
            });
        };
        Ok(Self {
            // Hand the backend a lowercased scheme. Schemes are
            // case-insensitive, so `SQLITE://lucida.db` has to be
            // accepted, but a backend strips the prefix by literal
            // match and would take the whole string as a filename.
            raw: format!("{lowered}:{rest}"),
            scheme,
        })
    }

    /// The default SQLite file, for when `LUCIDA_DB_URL` is unset.
    pub fn default_sqlite() -> Self {
        Self::parse(DEFAULT_DB_URL).expect("the default connection string parses")
    }

    /// An in-memory SQLite database, for tests.
    pub fn in_memory() -> Self {
        Self::parse(IN_MEMORY_DB_URL).expect("the in-memory connection string parses")
    }

    pub fn scheme(&self) -> Scheme {
        self.scheme
    }

    /// The connection string as given. Pass this to a backend, never to
    /// a log line or an error message — use [`Self::redacted`] there.
    pub fn as_str(&self) -> &str {
        &self.raw
    }

    /// The connection string with any credentials removed, safe to log.
    pub fn redacted(&self) -> Cow<'_, str> {
        redact(&self.raw)
    }
}

impl fmt::Display for DatabaseUrl {
    /// Displays the redacted form, so a `DatabaseUrl` interpolated into
    /// a message by mistake still cannot leak a password.
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.redacted())
    }
}

/// Replace the `user:password@` portion of a connection string with a
/// placeholder.
///
/// A SQLite URL never carries credentials, so this is a no-op today.
/// It exists now because the startup log prints the connection string,
/// and the first network backend to land would otherwise put a password
/// in the logs of every deployment that upgrades to it.
fn redact(raw: &str) -> Cow<'_, str> {
    // Search from the right: a password may itself contain an `@`, and
    // the last one is the delimiter the host follows.
    let Some(at) = raw.rfind('@') else {
        return Cow::Borrowed(raw);
    };
    let credentials_start = match raw.find("://") {
        Some(i) => i + "://".len(),
        None => match raw.find(':') {
            Some(i) => i + 1,
            None => 0,
        },
    };
    if credentials_start > at {
        // The `@` sits inside the scheme, so there is no userinfo to hide.
        return Cow::Borrowed(raw);
    }
    Cow::Owned(format!(
        "{}<redacted>{}",
        &raw[..credentials_start],
        &raw[at..]
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_scheme_parses_back_to_itself() {
        for scheme in Scheme::ALL {
            let url = DatabaseUrl::parse(&format!("{scheme}://somewhere"))
                .unwrap_or_else(|e| panic!("{scheme} is listed in ALL but fails to parse: {e}"));
            assert_eq!(url.scheme(), *scheme);
        }
    }

    #[test]
    fn scheme_selects_the_backend() {
        assert_eq!(
            DatabaseUrl::parse("sqlite://lucida.db").unwrap().scheme(),
            Scheme::Sqlite
        );
    }

    #[test]
    fn an_uppercase_scheme_is_accepted_and_normalized() {
        let url = DatabaseUrl::parse("SQLite://lucida.db").unwrap();
        assert_eq!(url.scheme(), Scheme::Sqlite);
        assert_eq!(url.as_str(), "sqlite://lucida.db");
    }

    #[test]
    fn the_rest_of_the_string_is_preserved_for_the_backend() {
        // `sqlite::memory:` is the one that bites: its "path" carries
        // colons of its own, so only the first one splits the scheme.
        for raw in ["sqlite://lucida.db", "sqlite:lucida.db", "sqlite::memory:"] {
            assert_eq!(DatabaseUrl::parse(raw).unwrap().as_str(), raw);
        }
    }

    #[test]
    fn surrounding_whitespace_is_ignored() {
        assert_eq!(
            DatabaseUrl::parse("  sqlite://lucida.db\n")
                .unwrap()
                .as_str(),
            "sqlite://lucida.db"
        );
    }

    #[test]
    fn an_unsupported_scheme_names_the_ones_that_work() {
        let err = DatabaseUrl::parse("mysql://host/lucida").unwrap_err();
        let message = err.to_string();
        assert!(message.contains("LUCIDA_DB_URL"), "{message}");
        assert!(message.contains("mysql"), "{message}");
        assert!(message.contains("sqlite"), "{message}");
    }

    #[test]
    fn a_string_with_no_scheme_is_malformed() {
        // The old `LUCIDA_DB_PATH` value is the mistake most likely to
        // reach this branch, so it is the one worth pinning.
        for raw in ["/var/lib/lucida/lucida.db", "", "sqlite:", ":memory:"] {
            let err = DatabaseUrl::parse(raw).unwrap_err();
            assert!(
                matches!(err, DatabaseUrlError::Malformed { .. }),
                "{raw:?} produced {err:?}"
            );
            assert!(err.to_string().contains("LUCIDA_DB_URL"));
        }
    }

    #[test]
    fn the_defaults_parse() {
        assert_eq!(DatabaseUrl::default_sqlite().scheme(), Scheme::Sqlite);
        assert_eq!(DatabaseUrl::in_memory().scheme(), Scheme::Sqlite);
    }

    #[test]
    fn a_sqlite_url_is_unchanged_by_redaction() {
        let url = DatabaseUrl::parse("sqlite://lucida.db").unwrap();
        assert_eq!(url.redacted(), "sqlite://lucida.db");
    }

    #[test]
    fn credentials_never_survive_redaction() {
        // Not a scheme this build accepts, so drive `redact` directly.
        let redacted = redact("postgres://lucida:hunter2@10.0.0.1:5432/lucida");
        assert_eq!(redacted, "postgres://<redacted>@10.0.0.1:5432/lucida");
        assert!(!redacted.contains("hunter2"));
    }

    #[test]
    fn redaction_survives_an_at_sign_inside_the_password() {
        let redacted = redact("postgres://lucida:p@ss@10.0.0.1/lucida");
        assert_eq!(redacted, "postgres://<redacted>@10.0.0.1/lucida");
        assert!(!redacted.contains("p@ss"));
    }

    #[test]
    fn display_shows_the_redacted_form() {
        let url = DatabaseUrl::parse("sqlite://lucida.db").unwrap();
        assert_eq!(url.to_string(), "sqlite://lucida.db");
    }
}
