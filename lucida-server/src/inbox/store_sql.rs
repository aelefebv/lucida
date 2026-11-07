//! What both SQL-backed [`InboxStore`](super::store::InboxStore)
//! implementations share: the statements they run, and how a driver
//! error becomes a store error.
//!
//! Same rules as `bookmarks/store_sql.rs`: numbered `$N` placeholders
//! only, never mixed with `?`. Both payload columns are `TEXT` on both
//! engines, because the inbox hands back the bytes it was sent and a JSON
//! column would store a parsed value.

use super::store::StoreError;

/// Store one bundle.
pub(crate) const INSERT: &str = r#"
    INSERT INTO inbox_entries
        (id, workspace_id, sent_by, sent_by_name, sent_at, expires_at, size_bytes,
         header_json, bundle_json)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
"#;

/// One workspace's unexpired entries, newest first.
pub(crate) const SELECT_LIST: &str = r#"
    SELECT id, workspace_id, sent_by, sent_by_name, sent_at, expires_at, size_bytes, header_json
    FROM inbox_entries
    WHERE workspace_id = $1 AND expires_at > $2
    ORDER BY sent_at DESC
"#;

/// One unexpired entry and its bundle, in the workspace that holds it.
pub(crate) const SELECT_ONE: &str = r#"
    SELECT id, workspace_id, sent_by, sent_by_name, sent_at, expires_at, size_bytes, header_json,
           bundle_json
    FROM inbox_entries
    WHERE workspace_id = $1 AND id = $2 AND expires_at > $3
"#;

/// The sweep. Runs on every write, so the table is bounded by the
/// retention rather than by anybody remembering to clean it.
pub(crate) const DELETE_EXPIRED: &str = "DELETE FROM inbox_entries WHERE expires_at <= $1";

/// A driver failure. Nothing a sender can send provokes one: the bundle
/// was parsed and measured before the store saw it.
pub(crate) fn map_err(e: sqlx::Error) -> StoreError {
    StoreError::Backend(e.to_string())
}
