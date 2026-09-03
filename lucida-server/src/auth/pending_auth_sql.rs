//! The SQL that both `PendingAuthStore` backends run.
//!
//! One text, two engines. The statements below are valid SQLite and
//! valid PostgreSQL, so the SQLite and PostgreSQL stores execute the
//! same characters and a change to a query lands once.
//!
//! **Placeholders are numbered, `$1` and up, in every statement here.**
//! That is PostgreSQL's spelling, and sqlx's SQLite driver reads the
//! number out of the parameter name and binds argument N to `$N`, so the
//! numbered form means the same thing on both sides — including a
//! placeholder used twice and placeholders out of order. SQLite's bare
//! `?` has no PostgreSQL counterpart, which is why the numbered form is
//! the one that travels.
//!
//! **Do not mix the two forms in one statement.** A statement holding
//! both `$1` and `?` binds the same argument to both and reports no
//! error, so it returns a wrong answer rather than failing. Convert a
//! statement whole or leave it alone.
//!
//! A backend is free to run a statement of its own where the engines
//! genuinely differ — row locking has no SQLite spelling, for one. The
//! rule is to share by default and diverge where sharing would be a lie.
//! See ADR-0058.

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
