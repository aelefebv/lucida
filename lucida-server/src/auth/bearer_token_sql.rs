//! What both SQL-backed `BearerTokenStore` implementations share: the
//! statements they run, and how a driver error becomes a store error.
//!
//! One text, two engines. Placeholders are numbered, `$1` and up:
//! PostgreSQL's spelling, which sqlx's SQLite driver binds by number, so
//! the SQLite and PostgreSQL stores execute the same characters and a
//! change to a query lands once. Never mix `$1` and `?` in one statement
//! — that binds the same argument to both, reports no error, and returns
//! a wrong answer. ADR-0058 has the reasoning.

/// Insert a freshly-minted credential.
///
/// The primary key rejects a reused id and the unique index rejects a
/// reused hash, so one hash resolves to one identity and presenting a
/// credential is never ambiguous.
pub(crate) const INSERT: &str = r#"
    INSERT INTO bearer_tokens
        (id, token_hash, name, email, display_name, picture_url,
         created_at, last_used_at, expires_at, revoked_at)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
"#;

/// Read one credential by hash. The raw token never reaches the server,
/// so the hash is the only handle a caller presenting one has.
pub(crate) const SELECT_BY_HASH: &str = r#"
    SELECT id, token_hash, name, email, display_name, picture_url,
           created_at, last_used_at, expires_at, revoked_at
    FROM bearer_tokens
    WHERE token_hash = $1
"#;

/// Record that a credential was used. Affecting no rows is the expected
/// outcome for one revoked between the lookup and this bump, so neither
/// store reads the count.
pub(crate) const TOUCH_LAST_USED: &str = "UPDATE bearer_tokens SET last_used_at = $1 WHERE id = $2";

/// Stamp a credential as revoked.
///
/// `COALESCE` keeps the first stamp: a credential stops being valid when
/// it was first revoked, not when someone said so again.
pub(crate) const REVOKE_BY_HASH: &str = r#"
    UPDATE bearer_tokens
    SET revoked_at = COALESCE(revoked_at, $1)
    WHERE token_hash = $2
"#;

/// A driver error, as the trait reports it.
///
/// One function rather than one per store: `sqlx::Error` is the same type
/// whichever driver produced it, so a second copy would only be a second
/// place for the two to disagree.
pub(crate) fn map_err(e: sqlx::Error) -> super::bearer_token::BearerTokenStoreError {
    super::bearer_token::BearerTokenStoreError::Backend(e.to_string())
}
