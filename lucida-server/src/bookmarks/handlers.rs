//! REST handlers under `/api/bookmarks`.
//!
//! Mounted on the protected (post-auth-middleware) router half so every
//! handler can rely on an `AuthPrincipal` being attached to request
//! extensions. A handler that runs without one is a wiring bug — we
//! emit `bookmarks.no_principal_in_extensions` and 500 to surface it
//! rather than silently 401'ing on a missing extension.
//!
//! Permission boundary (PRD #454, ADR-0015):
//!
//! - GET (single + list) — every authenticated principal can read every
//!   bookmark. Cross-user discovery is the headline feature; "Mine only"
//!   filtering is a slice-3 sidebar concern, not a server-side gate.
//! - POST — server overwrites `created_by` / `created_by_name` from the
//!   principal. The body type [`CreateRequest`] doesn't even surface
//!   those fields, so a misbehaving client can't spoof them.
//! - PATCH / DELETE — gated on
//!   `bookmark.created_by == principal.email || principal.is_admin`.

use std::sync::Arc;

use axum::Extension;
use axum::extract::{Path, RawQuery, State};
use axum::http::StatusCode;
use axum::http::header::LOCATION;
use axum::response::{IntoResponse, Json, Response};
use serde::{Deserialize, Serialize};
use serde_json::json;
use tokio::sync::Mutex;
use tracing::{error, warn};

use lucida_core::auth_principal::AuthPrincipal;
use lucida_core::protocol::BookmarkAction;
use lucida_core::saved_view::SavedView;

use super::broadcast::broadcast_bookmark_change;
use super::store::{Bookmark, BookmarkStore, StoreError};
use crate::UnicastRoutes;
use crate::session::Session;

/// Hard cap on the human-friendly bookmark name (PRD §"Validation").
/// Counts UTF-8 chars (`.chars().count()`), not bytes — so 200 emoji
/// bookmark names still fit.
pub const MAX_NAME_CHARS: usize = 200;

/// State carried by every bookmark handler. Holds the store + the
/// session/unicast plumbing the slice-4 broadcast helper needs to
/// reach connected clients. The principal arrives via request
/// extensions, not state.
///
/// The session and unicast handles are optional so test wiring that
/// only exercises the REST layer can pass `None` and skip the broadcast
/// path. In production they're always populated from `AppState`.
#[derive(Clone)]
pub struct BookmarksState {
    pub store: Arc<dyn BookmarkStore>,
    /// Live `Session` shared with the WebSocket handler. `None` in
    /// tests that don't exercise the broadcast.
    pub session: Option<Arc<Mutex<Session>>>,
    /// Per-client unicast channels keyed by `ClientId`. `None` in
    /// tests that don't exercise the broadcast.
    pub unicast_routes: Option<UnicastRoutes>,
}

/// Parse `?dataset=A&dataset=B&…` out of a raw query string. axum's
/// default `Query` extractor uses `serde_urlencoded`, which does NOT
/// support repeated keys — it silently drops every value but the last.
/// `axum-extra`'s Query extractor would handle this, but we don't pull
/// it in elsewhere; a small hand-rolled parser keeps the dep budget
/// flat. Other keys are ignored. Percent-decoded.
fn parse_dataset_params(raw: Option<&str>) -> Vec<String> {
    let Some(qs) = raw else { return Vec::new() };
    qs.split('&')
        .filter_map(|pair| {
            let (k, v) = pair.split_once('=')?;
            if k != "dataset" {
                return None;
            }
            // `+` decodes to space per application/x-www-form-urlencoded;
            // matches what serde_urlencoded would do.
            let decoded = urlencoding::decode(&v.replace('+', " ")).ok()?.into_owned();
            if decoded.is_empty() {
                None
            } else {
                Some(decoded)
            }
        })
        .collect()
}

/// POST request body. Notice the missing `created_by` /
/// `created_by_name` — the principal supplies them; the wire format
/// can't override them. Slice 3's web client doesn't ever send them,
/// but this defends against future clients (or curl smoke tests) that
/// might.
#[derive(Debug, Deserialize)]
pub struct CreateRequest {
    pub name: String,
    #[serde(default)]
    pub datasets: Vec<String>,
    pub view: SavedView,
}

/// PATCH request body. v1 only allows renaming.
#[derive(Debug, Deserialize)]
pub struct PatchRequest {
    pub name: String,
}

/// What goes back on the wire. Mirrors `Bookmark` exactly today; the
/// separate type exists so we can evolve serialization (e.g., omitting
/// large blobs from list responses) without leaking the storage shape.
///
/// `Deserialize` is gated on `cfg(test)` so handler tests can parse
/// their own response bodies; production never deserializes a
/// `BookmarkResponse` (it produces them).
#[derive(Debug, Serialize)]
#[cfg_attr(test, derive(Deserialize))]
pub struct BookmarkResponse {
    pub id: String,
    pub name: String,
    pub created_by: String,
    pub created_by_name: String,
    pub created_at: String,
    pub datasets: Vec<String>,
    pub view: SavedView,
}

impl From<Bookmark> for BookmarkResponse {
    fn from(b: Bookmark) -> Self {
        Self {
            id: b.id,
            name: b.name,
            created_by: b.created_by,
            created_by_name: b.created_by_name,
            created_at: b.created_at.to_rfc3339(),
            datasets: b.datasets,
            view: b.view,
        }
    }
}

/// `GET /api/bookmarks?dataset=…&dataset=…`
pub async fn list_bookmarks(
    State(state): State<BookmarksState>,
    principal: Option<Extension<AuthPrincipal>>,
    RawQuery(raw): RawQuery,
) -> Response {
    if principal.is_none() {
        return missing_principal_500("bookmarks.list");
    }
    let datasets = parse_dataset_params(raw.as_deref());
    let bookmarks = match state.store.list_by_dataset_overlap(&datasets).await {
        Ok(rows) => rows,
        Err(e) => return store_error(e, "bookmarks.list.store_failed"),
    };
    let body: Vec<BookmarkResponse> = bookmarks.into_iter().map(Into::into).collect();
    (StatusCode::OK, Json(body)).into_response()
}

/// `GET /api/bookmarks/:id`
pub async fn get_bookmark(
    State(state): State<BookmarksState>,
    principal: Option<Extension<AuthPrincipal>>,
    Path(id): Path<String>,
) -> Response {
    if principal.is_none() {
        return missing_principal_500("bookmarks.get");
    }
    match state.store.get(&id).await {
        Ok(Some(b)) => (StatusCode::OK, Json(BookmarkResponse::from(b))).into_response(),
        Ok(None) => not_found(&id),
        Err(e) => store_error(e, "bookmarks.get.store_failed"),
    }
}

/// `POST /api/bookmarks`
pub async fn create_bookmark(
    State(state): State<BookmarksState>,
    principal: Option<Extension<AuthPrincipal>>,
    Json(body): Json<CreateRequest>,
) -> Response {
    let Some(Extension(p)) = principal else {
        return missing_principal_500("bookmarks.create");
    };

    let name = match validate_name(&body.name) {
        Ok(n) => n,
        Err(resp) => return *resp,
    };

    match state
        .store
        .create(&name, &p.email, &p.display_name, body.datasets, body.view)
        .await
    {
        Ok(b) => {
            // Slice 4 (PRD #454 issue #477): live cross-peer sidebar
            // updates. Best-effort — broadcast errors are logged inside
            // the helper, never propagated to the HTTP response.
            broadcast_after_mutation(&state, &b.id, BookmarkAction::Created, &b.datasets).await;

            // Per #475 acceptance: 201 + Location header pointing at the
            // newly-minted resource.
            let location = format!("/api/bookmarks/{}", b.id);
            (
                StatusCode::CREATED,
                [(LOCATION, location)],
                Json(BookmarkResponse::from(b)),
            )
                .into_response()
        }
        Err(e) => store_error(e, "bookmarks.create.store_failed"),
    }
}

/// `PATCH /api/bookmarks/:id` — body `{name}`
pub async fn patch_bookmark(
    State(state): State<BookmarksState>,
    principal: Option<Extension<AuthPrincipal>>,
    Path(id): Path<String>,
    Json(body): Json<PatchRequest>,
) -> Response {
    let Some(Extension(p)) = principal else {
        return missing_principal_500("bookmarks.patch");
    };

    let name = match validate_name(&body.name) {
        Ok(n) => n,
        Err(resp) => return *resp,
    };

    let existing = match state.store.get(&id).await {
        Ok(Some(b)) => b,
        Ok(None) => return not_found(&id),
        Err(e) => return store_error(e, "bookmarks.patch.lookup_failed"),
    };
    if let Err(resp) = enforce_owner_or_admin(&existing, &p, "patch") {
        return *resp;
    }

    match state.store.patch_name(&id, &name).await {
        Ok(Some(b)) => {
            broadcast_after_mutation(&state, &b.id, BookmarkAction::Updated, &b.datasets).await;
            (StatusCode::OK, Json(BookmarkResponse::from(b))).into_response()
        }
        // patch_name on the row that was just visible should not
        // disappear without a delete in-between; race-and-tolerate as 404.
        Ok(None) => not_found(&id),
        Err(e) => store_error(e, "bookmarks.patch.store_failed"),
    }
}

/// `DELETE /api/bookmarks/:id`
pub async fn delete_bookmark(
    State(state): State<BookmarksState>,
    principal: Option<Extension<AuthPrincipal>>,
    Path(id): Path<String>,
) -> Response {
    let Some(Extension(p)) = principal else {
        return missing_principal_500("bookmarks.delete");
    };

    let existing = match state.store.get(&id).await {
        Ok(Some(b)) => b,
        Ok(None) => return not_found(&id),
        Err(e) => return store_error(e, "bookmarks.delete.lookup_failed"),
    };
    if let Err(resp) = enforce_owner_or_admin(&existing, &p, "delete") {
        return *resp;
    }

    match state.store.delete(&id).await {
        Ok(Some(removed)) => {
            // Use the deleted bookmark's `dataset_urls` (returned from
            // the store on delete) so the broadcast scope matches the
            // bookmark's actual scope, not whatever subset of datasets
            // happens to currently be loaded by the deleter.
            broadcast_after_mutation(
                &state,
                &removed.id,
                BookmarkAction::Deleted,
                &removed.datasets,
            )
            .await;
            StatusCode::NO_CONTENT.into_response()
        }
        // Same race window as patch — vanished between get and delete.
        Ok(None) => not_found(&id),
        Err(e) => store_error(e, "bookmarks.delete.store_failed"),
    }
}

/// Best-effort wrapper around [`broadcast_bookmark_change`]. Skipped
/// when `state.session` / `state.unicast_routes` are `None` (test
/// wiring that doesn't drive the broadcast). Logs delivery counts
/// at trace level so an operator can correlate "I renamed a
/// bookmark" with "N sidebars updated."
async fn broadcast_after_mutation(
    state: &BookmarksState,
    bookmark_id: &str,
    action: BookmarkAction,
    dataset_urls: &[String],
) {
    let (Some(session), Some(routes)) = (state.session.as_ref(), state.unicast_routes.as_ref())
    else {
        return;
    };
    let summary =
        broadcast_bookmark_change(session, routes, bookmark_id, action, dataset_urls).await;
    tracing::trace!(
        bookmark_id = bookmark_id,
        action = ?action,
        delivered = summary.delivered,
        failed = summary.failed,
        matched_scope = summary.matched_scope,
        "bookmarks.broadcast.complete",
    );
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

fn validate_name(raw: &str) -> Result<String, Box<Response>> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Err(Box::new(
            (
                StatusCode::BAD_REQUEST,
                Json(json!({ "error": "invalid_name", "detail": "name is empty" })),
            )
                .into_response(),
        ));
    }
    if trimmed.chars().count() > MAX_NAME_CHARS {
        return Err(Box::new(
            (
                StatusCode::BAD_REQUEST,
                Json(json!({
                    "error": "invalid_name",
                    "detail": format!("name exceeds {MAX_NAME_CHARS} characters"),
                })),
            )
                .into_response(),
        ));
    }
    Ok(trimmed.to_string())
}

fn enforce_owner_or_admin(
    bookmark: &Bookmark,
    principal: &AuthPrincipal,
    op: &str,
) -> Result<(), Box<Response>> {
    if bookmark.created_by == principal.email || principal.is_admin {
        return Ok(());
    }
    warn!(
        bookmark_id = %bookmark.id,
        owner = %bookmark.created_by,
        actor = %principal.email,
        operation = %op,
        "bookmarks.forbidden",
    );
    Err(Box::new(
        (StatusCode::FORBIDDEN, Json(json!({ "error": "forbidden" }))).into_response(),
    ))
}

fn not_found(id: &str) -> Response {
    (
        StatusCode::NOT_FOUND,
        Json(json!({ "error": "not_found", "id": id })),
    )
        .into_response()
}

fn store_error(err: StoreError, event: &str) -> Response {
    error!(error = %err, "{event}");
    (
        StatusCode::INTERNAL_SERVER_ERROR,
        Json(json!({ "error": "internal" })),
    )
        .into_response()
}

fn missing_principal_500(event: &str) -> Response {
    // Same shape as `AdminRequired` uses for the parallel wiring bug
    // — we want a loud 500, not a misleading 401.
    error!("{event}.no_principal_in_extensions");
    (
        StatusCode::INTERNAL_SERVER_ERROR,
        Json(json!({ "error": "internal" })),
    )
        .into_response()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::bookmarks::routes::router;
    use crate::bookmarks::store::MemoryBookmarkStore;
    use axum::Router;
    use axum::body::{Body, to_bytes};
    use axum::http::Request;
    use axum::middleware::{Next, from_fn};
    use tower::ServiceExt;

    /// Build a router that injects `principal` into request extensions
    /// before each handler runs. Mirrors what the auth middleware would
    /// do in production. `None` means "no auth middleware ran" — used
    /// to assert the wiring-bug 500 path.
    fn router_with_principal(
        store: Arc<dyn BookmarkStore>,
        principal: Option<AuthPrincipal>,
    ) -> Router {
        let p = principal.map(Arc::new);
        router(BookmarksState {
            store,
            session: None,
            unicast_routes: None,
        })
        .layer(from_fn(move |mut req: Request<Body>, next: Next| {
            let p = p.clone();
            async move {
                if let Some(p) = p {
                    req.extensions_mut().insert(AuthPrincipal::clone(&p));
                }
                next.run(req).await
            }
        }))
    }

    fn principal(email: &str, is_admin: bool) -> AuthPrincipal {
        AuthPrincipal {
            email: email.into(),
            display_name: format!("Display {email}"),
            picture_url: None,
            is_admin,
        }
    }

    fn sample_view() -> SavedView {
        SavedView::empty([800, 600])
    }

    async fn parse_body<T: for<'de> Deserialize<'de>>(res: Response) -> T {
        let bytes = to_bytes(res.into_body(), 1024 * 1024).await.unwrap();
        serde_json::from_slice(&bytes).unwrap_or_else(|e| {
            panic!(
                "body did not deserialize: {e}; raw: {}",
                String::from_utf8_lossy(&bytes)
            )
        })
    }

    // -- 401-ish wiring + auth gate --------------------------------------

    /// Without an attached principal, every handler 500s — that's a
    /// wiring bug surface. The middleware (if mounted) would have 401'd
    /// long before this; the integration test below exercises that.
    #[tokio::test]
    async fn create_500s_without_principal_when_middleware_skipped() {
        let store: Arc<dyn BookmarkStore> = Arc::new(MemoryBookmarkStore::new());
        let app = router_with_principal(store, None);

        let req = Request::builder()
            .method("POST")
            .uri("/api/bookmarks")
            .header("content-type", "application/json")
            .body(Body::from(
                serde_json::to_vec(&json!({
                    "name": "x",
                    "datasets": ["u"],
                    "view": sample_view(),
                }))
                .unwrap(),
            ))
            .unwrap();
        let res = app.oneshot(req).await.unwrap();
        assert_eq!(res.status(), StatusCode::INTERNAL_SERVER_ERROR);
    }

    // -- POST -------------------------------------------------------------

    #[tokio::test]
    async fn create_returns_201_with_principal_derived_creator() {
        let store: Arc<dyn BookmarkStore> = Arc::new(MemoryBookmarkStore::new());
        let app = router_with_principal(
            store.clone(),
            Some(principal("alice@calicolabs.com", false)),
        );

        let req = Request::builder()
            .method("POST")
            .uri("/api/bookmarks")
            .header("content-type", "application/json")
            .body(Body::from(
                serde_json::to_vec(&json!({
                    "name": "Alice's view",
                    "datasets": ["gs://b/a.zarr"],
                    "view": sample_view(),
                }))
                .unwrap(),
            ))
            .unwrap();
        let res = app.oneshot(req).await.unwrap();
        assert_eq!(res.status(), StatusCode::CREATED);
        let location = res
            .headers()
            .get(LOCATION)
            .expect("Location header on 201")
            .to_str()
            .unwrap()
            .to_string();
        assert!(location.starts_with("/api/bookmarks/"));

        let body: BookmarkResponse = parse_body(res).await;
        assert_eq!(body.created_by, "alice@calicolabs.com");
        assert_eq!(body.created_by_name, "Display alice@calicolabs.com");
        assert_eq!(body.name, "Alice's view");
        assert_eq!(body.datasets, vec!["gs://b/a.zarr".to_string()]);
        assert_eq!(location, format!("/api/bookmarks/{}", body.id));
    }

    /// The wire format type doesn't even surface `created_by` —
    /// serde-extra fields are ignored on `#[derive(Deserialize)]` by
    /// default. So even if a client sends them, they're discarded and
    /// the principal's identity wins. This test exercises the contract
    /// explicitly so a future "extra: true" ever creeping in fails it.
    #[tokio::test]
    async fn create_overrides_spoofed_creator_fields() {
        let store: Arc<dyn BookmarkStore> = Arc::new(MemoryBookmarkStore::new());
        let app = router_with_principal(
            store.clone(),
            Some(principal("alice@calicolabs.com", false)),
        );

        let req = Request::builder()
            .method("POST")
            .uri("/api/bookmarks")
            .header("content-type", "application/json")
            .body(Body::from(
                serde_json::to_vec(&json!({
                    "name": "spoofed",
                    "datasets": [],
                    "view": sample_view(),
                    "created_by": "evil@x",
                    "created_by_name": "Evil",
                }))
                .unwrap(),
            ))
            .unwrap();
        let res = app.oneshot(req).await.unwrap();
        assert_eq!(res.status(), StatusCode::CREATED);
        let body: BookmarkResponse = parse_body(res).await;
        assert_eq!(body.created_by, "alice@calicolabs.com");
        assert_eq!(body.created_by_name, "Display alice@calicolabs.com");
    }

    #[tokio::test]
    async fn create_400s_on_empty_name() {
        let store: Arc<dyn BookmarkStore> = Arc::new(MemoryBookmarkStore::new());
        let app = router_with_principal(store, Some(principal("a@b", false)));
        let req = Request::builder()
            .method("POST")
            .uri("/api/bookmarks")
            .header("content-type", "application/json")
            .body(Body::from(
                serde_json::to_vec(&json!({
                    "name": "   ",
                    "datasets": [],
                    "view": sample_view(),
                }))
                .unwrap(),
            ))
            .unwrap();
        let res = app.oneshot(req).await.unwrap();
        assert_eq!(res.status(), StatusCode::BAD_REQUEST);
    }

    #[tokio::test]
    async fn create_400s_on_too_long_name() {
        let store: Arc<dyn BookmarkStore> = Arc::new(MemoryBookmarkStore::new());
        let app = router_with_principal(store, Some(principal("a@b", false)));
        let huge: String = "a".repeat(MAX_NAME_CHARS + 1);
        let req = Request::builder()
            .method("POST")
            .uri("/api/bookmarks")
            .header("content-type", "application/json")
            .body(Body::from(
                serde_json::to_vec(&json!({
                    "name": huge,
                    "datasets": [],
                    "view": sample_view(),
                }))
                .unwrap(),
            ))
            .unwrap();
        let res = app.oneshot(req).await.unwrap();
        assert_eq!(res.status(), StatusCode::BAD_REQUEST);
    }

    /// 200-emoji names should fit (each emoji is multi-byte but a single
    /// `char`). Confirms we count chars, not bytes.
    #[tokio::test]
    async fn create_accepts_200_emoji_name() {
        let store: Arc<dyn BookmarkStore> = Arc::new(MemoryBookmarkStore::new());
        let app = router_with_principal(store, Some(principal("a@b", false)));
        let emoji_name: String = "🦀".repeat(MAX_NAME_CHARS);
        let req = Request::builder()
            .method("POST")
            .uri("/api/bookmarks")
            .header("content-type", "application/json")
            .body(Body::from(
                serde_json::to_vec(&json!({
                    "name": emoji_name,
                    "datasets": [],
                    "view": sample_view(),
                }))
                .unwrap(),
            ))
            .unwrap();
        let res = app.oneshot(req).await.unwrap();
        assert_eq!(res.status(), StatusCode::CREATED);
    }

    // -- GET (list + single) ---------------------------------------------

    #[tokio::test]
    async fn get_single_404s_on_missing() {
        let store: Arc<dyn BookmarkStore> = Arc::new(MemoryBookmarkStore::new());
        let app = router_with_principal(store, Some(principal("a@b", false)));
        let req = Request::builder()
            .uri("/api/bookmarks/nope")
            .body(Body::empty())
            .unwrap();
        let res = app.oneshot(req).await.unwrap();
        assert_eq!(res.status(), StatusCode::NOT_FOUND);
    }

    #[tokio::test]
    async fn get_single_returns_existing() {
        let store = Arc::new(MemoryBookmarkStore::new());
        let b = store
            .create("v", "a@b", "A", vec!["u".into()], sample_view())
            .await
            .unwrap();
        let app = router_with_principal(
            store as Arc<dyn BookmarkStore>,
            Some(principal("a@b", false)),
        );
        let req = Request::builder()
            .uri(format!("/api/bookmarks/{}", b.id))
            .body(Body::empty())
            .unwrap();
        let res = app.oneshot(req).await.unwrap();
        assert_eq!(res.status(), StatusCode::OK);
        let got: BookmarkResponse = parse_body(res).await;
        assert_eq!(got.id, b.id);
    }

    #[tokio::test]
    async fn list_no_query_returns_all_visible() {
        let store = Arc::new(MemoryBookmarkStore::new());
        store
            .create("a", "a@b", "A", vec!["u1".into()], sample_view())
            .await
            .unwrap();
        store
            .create("b", "x@y", "X", vec!["u2".into()], sample_view())
            .await
            .unwrap();
        let app = router_with_principal(
            store as Arc<dyn BookmarkStore>,
            Some(principal("a@b", false)),
        );
        let req = Request::builder()
            .uri("/api/bookmarks")
            .body(Body::empty())
            .unwrap();
        let res = app.oneshot(req).await.unwrap();
        assert_eq!(res.status(), StatusCode::OK);
        let got: Vec<BookmarkResponse> = parse_body(res).await;
        assert_eq!(got.len(), 2, "no dataset filter ⇒ org-globally readable");
    }

    #[tokio::test]
    async fn list_with_dataset_filter_overlaps_only() {
        let store = Arc::new(MemoryBookmarkStore::new());
        store
            .create("a", "a@b", "A", vec!["u1".into()], sample_view())
            .await
            .unwrap();
        store
            .create("b", "a@b", "A", vec!["u2".into()], sample_view())
            .await
            .unwrap();
        let app = router_with_principal(
            store as Arc<dyn BookmarkStore>,
            Some(principal("a@b", false)),
        );

        let req = Request::builder()
            .uri("/api/bookmarks?dataset=u2")
            .body(Body::empty())
            .unwrap();
        let res = app.oneshot(req).await.unwrap();
        assert_eq!(res.status(), StatusCode::OK);
        let got: Vec<BookmarkResponse> = parse_body(res).await;
        assert_eq!(got.len(), 1);
        assert_eq!(got[0].name, "b");
    }

    #[tokio::test]
    async fn list_with_multi_dataset_filter_unions() {
        let store = Arc::new(MemoryBookmarkStore::new());
        store
            .create("a", "a@b", "A", vec!["u1".into()], sample_view())
            .await
            .unwrap();
        store
            .create("b", "a@b", "A", vec!["u2".into()], sample_view())
            .await
            .unwrap();
        store
            .create("c", "a@b", "A", vec!["u3".into()], sample_view())
            .await
            .unwrap();
        let app = router_with_principal(
            store as Arc<dyn BookmarkStore>,
            Some(principal("a@b", false)),
        );

        let req = Request::builder()
            .uri("/api/bookmarks?dataset=u1&dataset=u3")
            .body(Body::empty())
            .unwrap();
        let res = app.oneshot(req).await.unwrap();
        assert_eq!(res.status(), StatusCode::OK);
        let got: Vec<BookmarkResponse> = parse_body(res).await;
        assert_eq!(got.len(), 2);
        let names: std::collections::HashSet<&str> = got.iter().map(|b| b.name.as_str()).collect();
        assert_eq!(names, ["a", "c"].into_iter().collect());
    }

    // -- PATCH ------------------------------------------------------------

    #[tokio::test]
    async fn patch_owner_succeeds() {
        let store = Arc::new(MemoryBookmarkStore::new());
        let b = store
            .create("old", "alice@x", "Alice", vec![], sample_view())
            .await
            .unwrap();
        let app = router_with_principal(
            store as Arc<dyn BookmarkStore>,
            Some(principal("alice@x", false)),
        );
        let req = Request::builder()
            .method("PATCH")
            .uri(format!("/api/bookmarks/{}", b.id))
            .header("content-type", "application/json")
            .body(Body::from(
                serde_json::to_vec(&json!({"name": "new"})).unwrap(),
            ))
            .unwrap();
        let res = app.oneshot(req).await.unwrap();
        assert_eq!(res.status(), StatusCode::OK);
        let got: BookmarkResponse = parse_body(res).await;
        assert_eq!(got.name, "new");
    }

    #[tokio::test]
    async fn patch_others_bookmark_403s() {
        let store = Arc::new(MemoryBookmarkStore::new());
        let b = store
            .create("v", "alice@x", "Alice", vec![], sample_view())
            .await
            .unwrap();
        let app = router_with_principal(
            store as Arc<dyn BookmarkStore>,
            Some(principal("bob@x", false)),
        );
        let req = Request::builder()
            .method("PATCH")
            .uri(format!("/api/bookmarks/{}", b.id))
            .header("content-type", "application/json")
            .body(Body::from(
                serde_json::to_vec(&json!({"name": "hacked"})).unwrap(),
            ))
            .unwrap();
        let res = app.oneshot(req).await.unwrap();
        assert_eq!(res.status(), StatusCode::FORBIDDEN);
    }

    #[tokio::test]
    async fn patch_admin_can_modify_others() {
        let store = Arc::new(MemoryBookmarkStore::new());
        let b = store
            .create("v", "alice@x", "Alice", vec![], sample_view())
            .await
            .unwrap();
        let app = router_with_principal(
            store.clone() as Arc<dyn BookmarkStore>,
            Some(principal("admin@x", true)),
        );
        let req = Request::builder()
            .method("PATCH")
            .uri(format!("/api/bookmarks/{}", b.id))
            .header("content-type", "application/json")
            .body(Body::from(
                serde_json::to_vec(&json!({"name": "renamed"})).unwrap(),
            ))
            .unwrap();
        let res = app.oneshot(req).await.unwrap();
        assert_eq!(res.status(), StatusCode::OK);
        let got = store.get(&b.id).await.unwrap().unwrap();
        assert_eq!(got.name, "renamed");
    }

    #[tokio::test]
    async fn patch_404s_on_missing() {
        let store: Arc<dyn BookmarkStore> = Arc::new(MemoryBookmarkStore::new());
        let app = router_with_principal(store, Some(principal("a@b", false)));
        let req = Request::builder()
            .method("PATCH")
            .uri("/api/bookmarks/nope")
            .header("content-type", "application/json")
            .body(Body::from(
                serde_json::to_vec(&json!({"name": "x"})).unwrap(),
            ))
            .unwrap();
        let res = app.oneshot(req).await.unwrap();
        assert_eq!(res.status(), StatusCode::NOT_FOUND);
    }

    // -- DELETE -----------------------------------------------------------

    #[tokio::test]
    async fn delete_owner_succeeds() {
        let store = Arc::new(MemoryBookmarkStore::new());
        let b = store
            .create("v", "alice@x", "Alice", vec![], sample_view())
            .await
            .unwrap();
        let app = router_with_principal(
            store.clone() as Arc<dyn BookmarkStore>,
            Some(principal("alice@x", false)),
        );
        let req = Request::builder()
            .method("DELETE")
            .uri(format!("/api/bookmarks/{}", b.id))
            .body(Body::empty())
            .unwrap();
        let res = app.oneshot(req).await.unwrap();
        assert_eq!(res.status(), StatusCode::NO_CONTENT);
        assert!(store.get(&b.id).await.unwrap().is_none());
    }

    #[tokio::test]
    async fn delete_others_bookmark_403s() {
        let store = Arc::new(MemoryBookmarkStore::new());
        let b = store
            .create("v", "alice@x", "Alice", vec![], sample_view())
            .await
            .unwrap();
        let app = router_with_principal(
            store.clone() as Arc<dyn BookmarkStore>,
            Some(principal("bob@x", false)),
        );
        let req = Request::builder()
            .method("DELETE")
            .uri(format!("/api/bookmarks/{}", b.id))
            .body(Body::empty())
            .unwrap();
        let res = app.oneshot(req).await.unwrap();
        assert_eq!(res.status(), StatusCode::FORBIDDEN);
        // bookmark must still be there
        assert!(store.get(&b.id).await.unwrap().is_some());
    }

    #[tokio::test]
    async fn delete_admin_can_remove_others() {
        let store = Arc::new(MemoryBookmarkStore::new());
        let b = store
            .create("v", "alice@x", "Alice", vec![], sample_view())
            .await
            .unwrap();
        let app = router_with_principal(
            store.clone() as Arc<dyn BookmarkStore>,
            Some(principal("admin@x", true)),
        );
        let req = Request::builder()
            .method("DELETE")
            .uri(format!("/api/bookmarks/{}", b.id))
            .body(Body::empty())
            .unwrap();
        let res = app.oneshot(req).await.unwrap();
        assert_eq!(res.status(), StatusCode::NO_CONTENT);
    }

    #[tokio::test]
    async fn delete_404s_on_missing() {
        let store: Arc<dyn BookmarkStore> = Arc::new(MemoryBookmarkStore::new());
        let app = router_with_principal(store, Some(principal("a@b", false)));
        let req = Request::builder()
            .method("DELETE")
            .uri("/api/bookmarks/nope")
            .body(Body::empty())
            .unwrap();
        let res = app.oneshot(req).await.unwrap();
        assert_eq!(res.status(), StatusCode::NOT_FOUND);
    }

    // -- parse_dataset_params ---------------------------------------------

    #[test]
    fn parse_dataset_params_handles_repeats() {
        assert_eq!(
            parse_dataset_params(Some("dataset=a&dataset=b")),
            vec!["a".to_string(), "b".to_string()],
        );
    }

    #[test]
    fn parse_dataset_params_ignores_other_keys() {
        assert_eq!(
            parse_dataset_params(Some("foo=1&dataset=u&bar=2")),
            vec!["u".to_string()],
        );
    }

    #[test]
    fn parse_dataset_params_percent_decodes() {
        assert_eq!(
            parse_dataset_params(Some("dataset=gs%3A%2F%2Fb%2Fa.zarr")),
            vec!["gs://b/a.zarr".to_string()],
        );
    }

    #[test]
    fn parse_dataset_params_none_or_empty() {
        assert!(parse_dataset_params(None).is_empty());
        assert!(parse_dataset_params(Some("")).is_empty());
        assert!(parse_dataset_params(Some("dataset=")).is_empty());
    }

    // -- 401 via real auth middleware ------------------------------------

    /// Mount the actual auth middleware (no cookie ⇒ 401) over the
    /// bookmarks router and assert every endpoint is gated. Slice 2's
    /// acceptance: "no-auth requests return 401".
    #[tokio::test]
    async fn endpoints_401_without_auth_under_real_middleware() {
        use crate::auth::middleware::{SharedExtractor, auth_middleware, build_extractor};
        use crate::auth::session_store_memory::MemorySessionStore;
        use crate::auth::{AuthConfig, LoginSessionStore};

        let store: Arc<dyn BookmarkStore> = Arc::new(MemoryBookmarkStore::new());
        let session_store: Arc<dyn LoginSessionStore> = Arc::new(MemorySessionStore::new());
        let config = Arc::new(AuthConfig::for_tests());
        let extractor: SharedExtractor =
            build_extractor(Arc::clone(&config), Arc::clone(&session_store));

        let app = router(BookmarksState {
            store,
            session: None,
            unicast_routes: None,
        })
        .layer(axum::middleware::from_fn_with_state(
            extractor,
            auth_middleware,
        ));

        // GET list
        let res = app
            .clone()
            .oneshot(
                Request::builder()
                    .uri("/api/bookmarks")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(res.status(), StatusCode::UNAUTHORIZED);

        // GET single
        let res = app
            .clone()
            .oneshot(
                Request::builder()
                    .uri("/api/bookmarks/x")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(res.status(), StatusCode::UNAUTHORIZED);

        // POST
        let res = app
            .clone()
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/api/bookmarks")
                    .header("content-type", "application/json")
                    .body(Body::from(b"{}".to_vec()))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(res.status(), StatusCode::UNAUTHORIZED);

        // PATCH
        let res = app
            .clone()
            .oneshot(
                Request::builder()
                    .method("PATCH")
                    .uri("/api/bookmarks/x")
                    .header("content-type", "application/json")
                    .body(Body::from(b"{}".to_vec()))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(res.status(), StatusCode::UNAUTHORIZED);

        // DELETE
        let res = app
            .oneshot(
                Request::builder()
                    .method("DELETE")
                    .uri("/api/bookmarks/x")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(res.status(), StatusCode::UNAUTHORIZED);
    }
}
