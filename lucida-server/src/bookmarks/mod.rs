//! Server-stored bookmarks.
//!
//! Bookmarks are persistent named snapshots of a user's view across one
//! or more datasets. The capture record is `lucida_core::SavedView` —
//! the same type the URL-hash side of saved views uses (ADR-0013) —
//! so the two surfaces share a single schema and a `#b=<id>` URL can
//! be authored from any saved-view source.
//!
//! Module layout:
//!
//! - [`store`] — `BookmarkStore` trait + `SqliteBookmarkStore` (production) +
//!   `MemoryBookmarkStore` (tests). Two-table schema: `bookmarks` for the
//!   rows, `bookmark_datasets` for the side index that powers the
//!   any-overlap query the sidebar runs. ADR-0015 §"Why SQLite" covers the
//!   choice.
//! - [`handlers`] — REST handlers under `/api/bookmarks`. Mounted on the
//!   protected (post-auth-middleware) router half so every handler sees an
//!   `AuthPrincipal` in request extensions.
//! - [`routes`] — small builder that bundles the four routes into a
//!   `Router<()>`, parameterized by the shared store handle. `main.rs`
//!   merges this into the same router half that `/auth/whoami` and
//!   `/auth/logout` live on.
//!
//! Permission boundary: read paths (GET) are org-globally readable per
//! ADR-0015 (cross-user discovery is the headline feature). Mutation
//! paths (PATCH, DELETE) require `bookmark.created_by == principal.email
//! || principal.is_admin`. POST always overwrites `created_by` /
//! `created_by_name` from the principal — body fields can't spoof.

pub mod broadcast;
pub mod handlers;
pub mod routes;
pub mod store;

pub use broadcast::{BroadcastSummary, broadcast_bookmark_change};
pub use store::{Bookmark, BookmarkStore, MemoryBookmarkStore, SqliteBookmarkStore, StoreError};
