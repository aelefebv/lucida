//! Bookmark router builder. `main.rs` calls [`router`] and merges the
//! result into the protected (post-auth-middleware) router half.
//!
//! Kept thin — handlers do the work, this just maps verbs to functions
//! and threads the shared state through.

use axum::Router;
use axum::routing::get;

use super::handlers::{
    BookmarksState, create_bookmark, delete_bookmark, get_bookmark, list_bookmarks, patch_bookmark,
};

/// Build the `/api/bookmarks` subtree. Returns a `Router<()>` so the
/// caller can `.merge()` it into the existing protected router half
/// without first stripping a different state type.
pub fn router(state: BookmarksState) -> Router {
    Router::new()
        .route("/api/bookmarks", get(list_bookmarks).post(create_bookmark))
        .route(
            "/api/bookmarks/{id}",
            get(get_bookmark)
                .patch(patch_bookmark)
                .delete(delete_bookmark),
        )
        .with_state(state)
}
