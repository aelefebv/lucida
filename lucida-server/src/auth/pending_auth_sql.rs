//! What both SQL-backed `PendingAuthStore` implementations share: the
//! statements they run, and how a driver error becomes a store error.
//!
//! Every statement is valid on both engines and uses numbered `$N`
//! placeholders, which sqlx's SQLite driver binds by number. Do not mix
//! `$1` and `?` in one statement: it binds the same argument to both and
//! returns a wrong answer without an error. A backend may diverge where
//! the engines really differ, such as row locking. See ADR-0058.

/// Insert a freshly-minted pending row.
///
/// The primary key rejects a reused state token rather than overwriting
/// the intent already in flight under it.
pub(crate) const INSERT: &str = r#"
    INSERT INTO pending_auth (state_token, intended_path, intended_hash, created_at)
    VALUES ($1, $2, $3, $4)
"#;

/// Atomic lookup-and-delete.
///
/// `DELETE ... RETURNING` hands the row back from the statement that
/// removed it, so two callers racing on one token cannot both be served.
/// SQLite has had it since 3.35 and PostgreSQL since 8.2.
pub(crate) const CONSUME: &str = r#"
    DELETE FROM pending_auth
    WHERE state_token = $1
    RETURNING state_token, intended_path, intended_hash, created_at
"#;

/// Drop every intent older than the cutoff, for the periodic sweep.
pub(crate) const DELETE_EXPIRED: &str = "DELETE FROM pending_auth WHERE created_at < $1";

/// A driver error, as the trait reports it.
///
/// One function rather than one per store: `sqlx::Error` is the same type
/// whichever driver produced it, so a second copy would only be a second
/// place for the two to disagree.
pub(crate) fn map_err(e: sqlx::Error) -> super::pending_auth::PendingAuthStoreError {
    super::pending_auth::PendingAuthStoreError::Backend(e.to_string())
}
