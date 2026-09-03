//! What both SQL-backed `BookmarkStore` implementations share: the
//! statements they run, and how a driver or payload error becomes a
//! store error.
//!
//! One text, two engines. The statements below are valid SQLite and
//! valid PostgreSQL, so the SQLite and PostgreSQL stores execute the
//! same characters and a change to a query lands once.
//!
//! **Placeholders are numbered, `$1` and up, in every statement here.**
//! That is PostgreSQL's spelling, and sqlx's SQLite driver reads the
//! number out of the parameter name and binds argument N to `$N`, so the
//! numbered form means the same thing on both sides. SQLite's bare `?`
//! has no PostgreSQL counterpart, which is why the numbered form is the
//! one that travels.
//!
//! **Do not mix the two forms in one statement.** A statement holding
//! both `$1` and `?` binds the same argument to both and reports no
//! error, so it returns a wrong answer rather than failing. Convert a
//! statement whole or leave it alone.
//!
//! What the two implementations do *not* share is the binding, because
//! `view_json` is `TEXT` on one engine and `JSONB` on the other. See
//! ADR-0058.

use super::store::StoreError;

/// Insert the bookmark row. The attachments follow, one [`ATTACH`] per
/// URL, in the same transaction.
pub(crate) const INSERT: &str = r#"
    INSERT INTO bookmarks
        (id, name, created_by, created_by_name, created_at, view_json)
    VALUES ($1, $2, $3, $4, $5, $6)
"#;

/// Attach one dataset URL to a bookmark.
pub(crate) const ATTACH: &str =
    "INSERT INTO bookmark_datasets (bookmark_id, dataset_url) VALUES ($1, $2)";

/// The columns a read hands back, for one bookmark. The attachments come
/// from [`SELECT_ATTACHMENTS`].
pub(crate) const SELECT_BY_ID: &str = r#"
    SELECT id, name, created_by, created_by_name, created_at, view_json
    FROM bookmarks
    WHERE id = $1
"#;

/// Every bookmark, newest first.
pub(crate) const SELECT_ALL: &str = r#"
    SELECT id, name, created_by, created_by_name, created_at, view_json
    FROM bookmarks
    ORDER BY created_at DESC
"#;

/// The dataset URLs one bookmark is attached to, in the settled order a
/// created bookmark reports.
pub(crate) const SELECT_ATTACHMENTS: &str =
    "SELECT dataset_url FROM bookmark_datasets WHERE bookmark_id = $1 ORDER BY dataset_url";

/// Rename in place. Everything else about a bookmark is immutable.
pub(crate) const RENAME: &str = "UPDATE bookmarks SET name = $1 WHERE id = $2";

/// Remove the bookmark row and hand it back. The attachments go with it
/// through the schema's `ON DELETE CASCADE`, which both engines enforce.
///
/// `RETURNING` is what makes the row the caller gets the row that was
/// removed. Reading it first and deleting it after would be two
/// statements, and PostgreSQL takes a fresh snapshot per statement under
/// its default isolation, so a rename committing between them would hand
/// back a row that never existed. SQLite has had `RETURNING` since 3.35
/// and PostgreSQL since 8.2.
pub(crate) const DELETE: &str = r#"
    DELETE FROM bookmarks
    WHERE id = $1
    RETURNING id, name, created_by, created_by_name, created_at, view_json
"#;

/// The any-overlap SELECT, with one placeholder per dataset URL.
///
/// The URL list is variable-length and neither engine expands a slice
/// into `IN ($1)` on its own, so the statement is built rather than
/// written out. `= ANY($1)` over a bound array would spare the building
/// on PostgreSQL and has no SQLite spelling, so this is one of the
/// places sharing costs something.
///
/// `DISTINCT` in the subquery is what keeps a bookmark matching several
/// of the URLs from being listed several times.
pub(crate) fn select_by_overlap(url_count: usize) -> String {
    let placeholders = (1..=url_count)
        .map(|n| format!("${n}"))
        .collect::<Vec<_>>()
        .join(", ");
    format!(
        r#"
        SELECT id, name, created_by, created_by_name, created_at, view_json
        FROM bookmarks
        WHERE id IN (
            SELECT DISTINCT bookmark_id
            FROM bookmark_datasets
            WHERE dataset_url IN ({placeholders})
        )
        ORDER BY created_at DESC
        "#
    )
}

/// A driver error, as the trait reports it.
///
/// One function rather than one per store: `sqlx::Error` is the same type
/// whichever driver produced it, so a second copy would only be a second
/// place for the two to disagree.
pub(crate) fn map_err(e: sqlx::Error) -> StoreError {
    StoreError::Backend(e.to_string())
}

/// A stored payload that no longer parses into a `SavedView`.
///
/// Both stores read `view_json` back through `serde_json`, from text on
/// one engine and from a parsed value on the other, and both owe the
/// caller the same error when it no longer fits the type.
pub(crate) fn map_stored_view(e: serde_json::Error) -> StoreError {
    StoreError::InvalidView(e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The built statement is the one place a `?` could creep back in,
    /// because it is the one place the placeholders are written by code
    /// rather than typed out.
    #[test]
    fn the_overlap_statement_numbers_its_placeholders_from_one() {
        let sql = select_by_overlap(3);
        assert!(sql.contains("IN ($1, $2, $3)"), "{sql}");
        assert!(!sql.contains('?'), "{sql}");
    }
}
