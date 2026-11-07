//! Server-stored bookmarks: persistent named snapshots of a user's view
//! across one or more datasets.
//!
//! The capture record is `lucida_core::SavedView`, the type URL-hash saved
//! views use, so a `#b=<id>` URL can be authored from any saved-view
//! source. Every principal can read every bookmark; PATCH and DELETE need
//! the creator or an admin.

pub mod broadcast;
pub mod handlers;
pub mod routes;
pub mod store;
pub mod store_memory;
pub mod store_postgres;
pub(crate) mod store_sql;
pub mod store_sqlite;

pub use broadcast::{BroadcastSummary, broadcast_bookmark_change};
pub use store::{Bookmark, BookmarkStore, StoreError};
pub use store_memory::MemoryBookmarkStore;
pub use store_postgres::PostgresBookmarkStore;
pub use store_sqlite::SqliteBookmarkStore;
