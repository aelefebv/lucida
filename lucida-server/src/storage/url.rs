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
    Postgres,
}

impl Scheme {
    /// Every backend this build can open.
    ///
    /// One list, deliberately. [`Self::parse`] searches it and the
    /// unsupported-scheme error names it, so what the server accepts
    /// and what it advertises cannot drift apart. Adding a backend is
    /// two edits: a variant, which stops [`Self::as_str`] compiling
    /// until it is named, and an entry here.
    pub const ALL: &'static [Scheme] = &[Scheme::Sqlite, Scheme::Postgres];

    fn parse(raw: &str) -> Option<Self> {
        Self::ALL
            .iter()
            .copied()
            .find(|s| s.as_str() == raw || s.aliases().contains(&raw))
    }

    /// The one spelling a scheme is known by everywhere past parsing:
    /// in [`super::open`]'s dispatch, in the startup log, and in the
    /// connection string handed to the backend.
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::Sqlite => "sqlite",
            Self::Postgres => "postgres",
        }
    }

    /// Other spellings a deployer may write, accepted and then
    /// forgotten: [`DatabaseUrl::parse`] rewrites the string to
    /// [`Self::as_str`], so an alias never reaches a backend and never
    /// becomes a second thing to match on.
    ///
    /// `postgresql` is here because libpq and PostgreSQL's own
    /// documentation use both spellings, so a connection string copied
    /// from anywhere may carry either.
    fn aliases(&self) -> &'static [&'static str] {
        match self {
            Self::Sqlite => &[],
            Self::Postgres => &["postgresql"],
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
            // Hand the backend the canonical spelling. Schemes are
            // case-insensitive and one of them answers to two names, so
            // `SQLITE://lucida.db` and `postgresql://host/lucida` both
            // have to be accepted — but a backend strips the prefix by
            // literal match, and would take `SQLITE://lucida.db` whole
            // as a filename.
            raw: format!("{}:{rest}", scheme.as_str()),
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

const REDACTED: &str = "<redacted>";

/// Remove every secret a connection string can carry.
///
/// The startup log prints the connection string, as does every
/// [`StorageError`] that reports a database the server could not bring
/// up. A SQLite URL carries no secret; a `postgres://` one usually does.
///
/// Two places hold them, and a string can use either or both. The
/// userinfo before the `@` is the familiar one. The other is the query
/// string: sqlx reads `user`, `password`, and `dbname` from it, so
/// `postgres://db/lucida?user=lucida&password=hunter2` connects with the
/// password nowhere near an `@`.
///
/// [`StorageError`]: super::StorageError
fn redact(raw: &str) -> Cow<'_, str> {
    let redacted = redact_query(&redact_userinfo(raw));
    if redacted == raw {
        Cow::Borrowed(raw)
    } else {
        Cow::Owned(redacted)
    }
}

/// Replace the `user:password@` portion of the authority.
fn redact_userinfo(raw: &str) -> String {
    let authority_start = match raw.find("://") {
        Some(i) => i + "://".len(),
        None => match raw.find(':') {
            Some(i) => i + 1,
            None => 0,
        },
    };
    // The authority ends where the path, query, or fragment begins. An
    // `@` past that point belongs to a query parameter, so bounding the
    // search is what keeps the host in the message.
    let authority_end = raw[authority_start..]
        .find(['/', '?', '#'])
        .map_or(raw.len(), |i| authority_start + i);
    // Search from the right within the authority: a password may itself
    // contain an `@`, and the last one is the delimiter the host follows.
    let Some(at) = raw[authority_start..authority_end].rfind('@') else {
        return raw.to_string();
    };
    let at = authority_start + at;
    format!("{}{REDACTED}{}", &raw[..authority_start], &raw[at..])
}

/// Replace the value of every query parameter that carries a secret.
///
/// Matched on the name containing `password`, which covers libpq's
/// `password` and `sslpassword` without this having to track the list
/// sqlx accepts.
fn redact_query(raw: &str) -> String {
    let Some(query_start) = raw.find('?').map(|i| i + 1) else {
        return raw.to_string();
    };
    let (before, query) = raw.split_at(query_start);
    let (query, fragment) = match query.find('#') {
        Some(i) => query.split_at(i),
        None => (query, ""),
    };
    let scrubbed = query
        .split('&')
        .map(|pair| match pair.split_once('=') {
            Some((name, _)) if name.to_ascii_lowercase().contains("password") => {
                format!("{name}={REDACTED}")
            }
            _ => pair.to_string(),
        })
        .collect::<Vec<_>>()
        .join("&");
    format!("{before}{scrubbed}{fragment}")
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
        assert_eq!(
            DatabaseUrl::parse("postgres://host/lucida")
                .unwrap()
                .scheme(),
            Scheme::Postgres
        );
    }

    #[test]
    fn an_uppercase_scheme_is_accepted_and_normalized() {
        let url = DatabaseUrl::parse("SQLite://lucida.db").unwrap();
        assert_eq!(url.scheme(), Scheme::Sqlite);
        assert_eq!(url.as_str(), "sqlite://lucida.db");
    }

    #[test]
    fn postgresql_is_the_same_backend_as_postgres() {
        let url = DatabaseUrl::parse("postgresql://host/lucida").unwrap();
        assert_eq!(url.scheme(), Scheme::Postgres);
    }

    /// Past `parse` one backend has one name, so the dispatch matches a
    /// single variant, the startup log prints one spelling, and the
    /// backend gets a string it can compare literally.
    #[test]
    fn an_alias_does_not_survive_parsing() {
        let url = DatabaseUrl::parse("PostgreSQL://user@host:5432/lucida").unwrap();
        assert_eq!(url.as_str(), "postgres://user@host:5432/lucida");
        assert_eq!(url.scheme().to_string(), "postgres");
    }

    /// Two schemes sharing a spelling would make [`Scheme::parse`]
    /// answer by list order, which is nobody's intended decision.
    #[test]
    fn no_spelling_names_two_backends() {
        let mut seen = std::collections::HashMap::new();
        for scheme in Scheme::ALL {
            for spelling in std::iter::once(scheme.as_str()).chain(scheme.aliases().iter().copied())
            {
                if let Some(other) = seen.insert(spelling, scheme) {
                    panic!("{spelling} names both {other} and {scheme}");
                }
            }
        }
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
        for scheme in Scheme::ALL {
            assert!(message.contains(scheme.as_str()), "{message}");
        }
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
        let url = DatabaseUrl::parse("postgres://lucida:hunter2@10.0.0.1:5432/lucida").unwrap();
        assert_eq!(url.redacted(), "postgres://<redacted>@10.0.0.1:5432/lucida");
        assert!(!url.redacted().contains("hunter2"));
        // The raw string still carries the password: that is what the
        // backend connects with, and the point of the two accessors.
        assert!(url.as_str().contains("hunter2"));
    }

    #[test]
    fn redaction_survives_an_at_sign_inside_the_password() {
        let url = DatabaseUrl::parse("postgres://lucida:p@ss@10.0.0.1/lucida").unwrap();
        assert_eq!(url.redacted(), "postgres://<redacted>@10.0.0.1/lucida");
        assert!(!url.redacted().contains("p@ss"));
    }

    /// The string below connects, and looking only for an `@` would
    /// print its password verbatim.
    #[test]
    fn a_password_in_the_query_string_is_redacted_too() {
        let url =
            DatabaseUrl::parse("postgres://10.0.0.1:5432/lucida?user=lucida&password=hunter2")
                .unwrap();
        assert_eq!(
            url.redacted(),
            "postgres://10.0.0.1:5432/lucida?user=lucida&password=<redacted>"
        );
    }

    #[test]
    fn every_password_parameter_is_redacted() {
        for raw in [
            "postgres://db/lucida?password=hunter2",
            "postgres://db/lucida?sslpassword=hunter2",
            "postgres://db/lucida?PASSWORD=hunter2",
            "postgres://lucida:hunter2@db/lucida?sslpassword=hunter2",
        ] {
            let redacted = DatabaseUrl::parse(raw).unwrap().redacted().into_owned();
            assert!(!redacted.contains("hunter2"), "{raw} → {redacted}");
        }
    }

    /// Treating an `@` in a query parameter as a userinfo delimiter used
    /// to swallow the host, the one thing the operator needs to read.
    #[test]
    fn an_at_sign_outside_the_authority_leaves_the_host_alone() {
        let url =
            DatabaseUrl::parse("postgres://10.0.0.1:5432/lucida?application_name=a@b").unwrap();
        assert_eq!(
            url.redacted(),
            "postgres://10.0.0.1:5432/lucida?application_name=a@b"
        );
    }

    #[test]
    fn display_shows_the_redacted_form() {
        let url = DatabaseUrl::parse("sqlite://lucida.db").unwrap();
        assert_eq!(url.to_string(), "sqlite://lucida.db");

        // The case the trait exists for: a `DatabaseUrl` interpolated
        // into a message with `{}` cannot leak a password.
        let credentialed = DatabaseUrl::parse("postgres://lucida:hunter2@db:5432/lucida").unwrap();
        assert_eq!(
            credentialed.to_string(),
            "postgres://<redacted>@db:5432/lucida"
        );
    }
}
