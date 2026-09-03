//! What both SQL-backed `LoginSessionStore` implementations share: the
//! statements they run, and how a driver error becomes a store error.
//!
//! **Number the placeholders, `$1` and up, and never mix `$1` and `?` in
//! one statement.** A mixed statement binds the same argument to both,
//! reports no error, and returns a wrong answer. ADR-0058 has the
//! reasoning and [`super::pending_auth_sql`] the longer note.

/// Insert a freshly-minted session.
///
/// The primary key rejects a reused id rather than overwriting the
/// session already sitting under it.
pub(crate) const INSERT: &str = r#"
    INSERT INTO login_sessions
        (id, email, display_name, picture_url, created_at, last_used_at, expires_at)
    VALUES ($1, $2, $3, $4, $5, $6, $7)
"#;

/// Read one session by id.
///
/// No timeout policy here: the extractor applies the idle timeout and the
/// hard cap to the row it gets back, which keeps the trait stable when
/// the timeout knobs change.
pub(crate) const SELECT_BY_ID: &str = r#"
    SELECT id, email, display_name, picture_url, created_at, last_used_at, expires_at
    FROM login_sessions
    WHERE id = $1
"#;

/// Move the idle-timeout anchor, leaving the two hard-cap anchors alone.
///
/// Affecting no rows is the expected outcome for a session deleted
/// between the lookup and this bump, so neither store reads the count.
pub(crate) const TOUCH_LAST_USED: &str =
    "UPDATE login_sessions SET last_used_at = $1 WHERE id = $2";

/// Remove one session, for the logout flow. Idempotent.
pub(crate) const DELETE: &str = "DELETE FROM login_sessions WHERE id = $1";

/// Drop every session already expired at the cutoff, for the periodic
/// sweep. A session expiring exactly at the cutoff has expired.
pub(crate) const DELETE_EXPIRED: &str = "DELETE FROM login_sessions WHERE expires_at <= $1";

/// A driver error, as the trait reports it. One function per store, not
/// one per implementation: a second copy would only be a second place for
/// the two to disagree.
pub(crate) fn map_err(e: sqlx::Error) -> super::session_store::SessionStoreError {
    super::session_store::SessionStoreError::Backend(e.to_string())
}
