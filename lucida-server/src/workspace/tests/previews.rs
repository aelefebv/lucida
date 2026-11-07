//! The preview routes: who may read and write a workspace's preview, and
//! what an upload has to be.

use axum::http::header;

use super::*;
use crate::workspace::preview::{MAX_PREVIEW_BYTES, MIN_PREVIEW_INTERVAL};

/// The leading bytes of a WebP file, which is all the server reads.
fn webp(tag: u8) -> Vec<u8> {
    let mut bytes = b"RIFF\x24\x00\x00\x00WEBPVP8 ".to_vec();
    bytes.extend([tag; 16]);
    bytes
}

struct Fixture {
    store: SqliteWorkspaceStore,
    manager: Arc<WorkspaceManager>,
    workspace_id: String,
}

/// A workspace owned by `owner@example.com`, with an editor and a viewer.
async fn fixture() -> Fixture {
    let store = fresh_store().await;
    let owner = principal("owner@example.com", false);
    let workspace = store
        .create_workspace(&owner, Some("Pictured"))
        .await
        .unwrap();
    for (email, role) in [
        ("editor@example.com", WorkspaceRole::Editor),
        ("viewer@example.com", WorkspaceRole::Viewer),
    ] {
        store
            .upsert_member(&workspace.id, email, email, role)
            .await
            .unwrap()
            .unwrap();
    }
    let manager = Arc::new(WorkspaceManager::new(
        Arc::new(store.clone()),
        ProxyConfig::defaults(),
    ));
    Fixture {
        store,
        manager,
        workspace_id: workspace.id,
    }
}

impl Fixture {
    async fn send(&self, email: &str, request: Request<Body>) -> axum::response::Response {
        workspace_router_with_principal(Arc::clone(&self.manager), principal(email, false))
            .oneshot(request)
            .await
            .unwrap()
    }

    fn uri(&self) -> String {
        format!("/api/workspaces/{}/preview", self.workspace_id)
    }

    async fn put(
        &self,
        email: &str,
        content_type: &str,
        bytes: Vec<u8>,
    ) -> axum::response::Response {
        let request = Request::builder()
            .method(Method::PUT)
            .uri(self.uri())
            .header(header::CONTENT_TYPE, content_type)
            .body(Body::from(bytes))
            .unwrap();
        self.send(email, request).await
    }

    async fn get(&self, email: &str) -> axum::response::Response {
        let request = Request::builder()
            .uri(self.uri())
            .body(Body::empty())
            .unwrap();
        self.send(email, request).await
    }

    /// Age the stored preview past the rate limit, as the clock would.
    async fn let_the_interval_pass(&self) {
        let stored = self
            .store
            .get_preview(&self.workspace_id)
            .await
            .unwrap()
            .unwrap();
        let interval = chrono::Duration::from_std(MIN_PREVIEW_INTERVAL).unwrap();
        self.store
            .put_preview(NewWorkspacePreview {
                workspace_id: &self.workspace_id,
                content_type: &stored.meta.content_type,
                image: &stored.image,
                updated_by: &stored.meta.updated_by,
                updated_at: stored.meta.updated_at - interval * 2,
                replaces_up_to: stored.meta.updated_at,
            })
            .await
            .unwrap()
            .unwrap();
    }
}

async fn body_bytes(res: axum::response::Response) -> Vec<u8> {
    to_bytes(res.into_body(), MAX_PREVIEW_BYTES * 2)
        .await
        .unwrap()
        .to_vec()
}

#[tokio::test]
async fn an_owner_uploads_and_every_member_reads_it_back() {
    let fx = fixture().await;
    let image = webp(1);

    let res = fx
        .put("owner@example.com", "image/webp", image.clone())
        .await;
    assert_eq!(res.status(), StatusCode::OK);
    let meta = response_json(res).await;
    assert_eq!(meta["content_type"], "image/webp");
    assert_eq!(meta["size_bytes"], image.len());
    assert_eq!(meta["updated_by"], "owner@example.com");

    for email in [
        "owner@example.com",
        "editor@example.com",
        "viewer@example.com",
    ] {
        let res = fx.get(email).await;
        assert_eq!(res.status(), StatusCode::OK, "{email}");
        let headers = res.headers().clone();
        assert_eq!(headers[header::CONTENT_TYPE], "image/webp");
        assert_eq!(headers[header::CACHE_CONTROL], "private, no-cache");
        assert_eq!(headers[header::X_CONTENT_TYPE_OPTIONS], "nosniff");
        assert!(headers.contains_key(header::ETAG));
        assert!(headers.contains_key(header::LAST_MODIFIED));
        assert_eq!(body_bytes(res).await, image, "{email}");
    }
}

#[tokio::test]
async fn a_matching_etag_is_answered_without_the_image() {
    let fx = fixture().await;
    fx.put("owner@example.com", "image/webp", webp(1)).await;
    let etag = fx.get("viewer@example.com").await.headers()[header::ETAG].clone();

    let request = Request::builder()
        .uri(fx.uri())
        .header(header::IF_NONE_MATCH, etag.clone())
        .body(Body::empty())
        .unwrap();
    let res = fx.send("viewer@example.com", request).await;
    assert_eq!(res.status(), StatusCode::NOT_MODIFIED);
    assert_eq!(res.headers()[header::ETAG], etag);
    assert!(body_bytes(res).await.is_empty());

    // A new preview gets a new validator.
    fx.let_the_interval_pass().await;
    fx.put("editor@example.com", "image/webp", webp(2)).await;
    let request = Request::builder()
        .uri(fx.uri())
        .header(header::IF_NONE_MATCH, etag)
        .body(Body::empty())
        .unwrap();
    let res = fx.send("viewer@example.com", request).await;
    assert_eq!(res.status(), StatusCode::OK);
    assert_eq!(body_bytes(res).await, webp(2));
}

#[tokio::test]
async fn a_viewer_never_uploads_and_an_editor_does() {
    let fx = fixture().await;

    let res = fx.put("viewer@example.com", "image/webp", webp(1)).await;
    assert_eq!(res.status(), StatusCode::FORBIDDEN);
    assert!(
        fx.store
            .get_preview(&fx.workspace_id)
            .await
            .unwrap()
            .is_none()
    );

    // The role is checked before the bytes: a viewer hears "forbidden"
    // whatever it sent.
    let res = fx
        .put("viewer@example.com", "text/plain", b"hello".to_vec())
        .await;
    assert_eq!(res.status(), StatusCode::FORBIDDEN);

    let res = fx.put("editor@example.com", "image/webp", webp(1)).await;
    assert_eq!(res.status(), StatusCode::OK);
    assert_eq!(response_json(res).await["updated_by"], "editor@example.com");
}

#[tokio::test]
async fn someone_without_access_can_neither_read_nor_write_it() {
    let fx = fixture().await;
    fx.put("owner@example.com", "image/webp", webp(1)).await;

    assert_eq!(
        fx.get("mallory@example.com").await.status(),
        StatusCode::FORBIDDEN
    );
    let res = fx.put("mallory@example.com", "image/webp", webp(2)).await;
    assert_eq!(res.status(), StatusCode::FORBIDDEN);

    // The link grant is access like any other.
    fx.store
        .update_link_access(
            &fx.workspace_id,
            WorkspaceLinkAccess::AnyoneWithLink,
            WorkspaceRole::Viewer,
        )
        .await
        .unwrap()
        .unwrap();
    assert_eq!(fx.get("mallory@example.com").await.status(), StatusCode::OK);
    let res = fx.put("mallory@example.com", "image/webp", webp(2)).await;
    assert_eq!(res.status(), StatusCode::FORBIDDEN);
}

#[tokio::test]
async fn a_workspace_with_no_preview_says_so() {
    let fx = fixture().await;
    let res = fx.get("viewer@example.com").await;
    assert_eq!(res.status(), StatusCode::NOT_FOUND);
    assert_eq!(response_json(res).await["error"], "preview_not_found");
}

#[tokio::test]
async fn an_oversized_upload_is_refused_with_the_cap() {
    let fx = fixture().await;
    let mut image = webp(1);
    image.resize(MAX_PREVIEW_BYTES + 1, 0);

    // A declared length over the cap is refused before the body is read.
    let request = Request::builder()
        .method(Method::PUT)
        .uri(fx.uri())
        .header(header::CONTENT_TYPE, "image/webp")
        .header(header::CONTENT_LENGTH, image.len())
        .body(Body::from(image))
        .unwrap();
    let res = fx.send("owner@example.com", request).await;
    assert_eq!(res.status(), StatusCode::PAYLOAD_TOO_LARGE);
    let body = response_json(res).await;
    assert_eq!(body["error"], "preview_too_large");
    assert!(
        body["detail"]
            .as_str()
            .unwrap()
            .contains(&MAX_PREVIEW_BYTES.to_string()),
        "{body}"
    );

    // A body with no declared length is cut off at the cap.
    let mut image = webp(1);
    image.resize(MAX_PREVIEW_BYTES + 1, 0);
    let chunks: Vec<Result<Vec<u8>, std::io::Error>> =
        image.chunks(64 * 1024).map(|c| Ok(c.to_vec())).collect();
    let request = Request::builder()
        .method(Method::PUT)
        .uri(fx.uri())
        .body(Body::from_stream(futures_util::stream::iter(chunks)))
        .unwrap();
    let res = fx.send("owner@example.com", request).await;
    assert_eq!(res.status(), StatusCode::PAYLOAD_TOO_LARGE);

    let mut image = webp(1);
    image.resize(MAX_PREVIEW_BYTES, 0);
    let res = fx.put("owner@example.com", "image/webp", image).await;
    assert_eq!(res.status(), StatusCode::OK, "the cap itself is allowed");
}

#[tokio::test]
async fn a_wrongly_typed_upload_is_refused_by_what_it_is() {
    let fx = fixture().await;
    for (content_type, bytes) in [
        ("image/gif", b"GIF89a\x01\x00\x01\x00".to_vec()),
        (
            "image/svg+xml",
            b"<svg xmlns=\"http://www.w3.org/2000/svg\"/>".to_vec(),
        ),
        // Declared as an allowed type, but the bytes are not one.
        ("image/webp", b"not an image at all".to_vec()),
    ] {
        let res = fx.put("owner@example.com", content_type, bytes).await;
        assert_eq!(
            res.status(),
            StatusCode::UNSUPPORTED_MEDIA_TYPE,
            "{content_type}"
        );
        assert_eq!(
            response_json(res).await["error"],
            "unsupported_preview_type"
        );
    }

    let res = fx.put("owner@example.com", "image/png", webp(1)).await;
    assert_eq!(res.status(), StatusCode::UNSUPPORTED_MEDIA_TYPE);
    let detail = response_json(res).await["detail"]
        .as_str()
        .unwrap()
        .to_string();
    assert!(
        detail.contains("image/png") && detail.contains("image/webp"),
        "{detail}"
    );

    let res = fx.put("owner@example.com", "image/webp", Vec::new()).await;
    assert_eq!(res.status(), StatusCode::BAD_REQUEST);

    assert!(
        fx.store
            .get_preview(&fx.workspace_id)
            .await
            .unwrap()
            .is_none()
    );
}

#[tokio::test]
async fn uploads_too_close_together_are_refused_until_the_interval_passes() {
    let fx = fixture().await;
    assert_eq!(
        fx.put("owner@example.com", "image/webp", webp(1))
            .await
            .status(),
        StatusCode::OK
    );

    let res = fx.put("editor@example.com", "image/webp", webp(2)).await;
    assert_eq!(res.status(), StatusCode::TOO_MANY_REQUESTS);
    let retry_after: u64 = res.headers()[header::RETRY_AFTER]
        .to_str()
        .unwrap()
        .parse()
        .unwrap();
    assert!(
        (1..=MIN_PREVIEW_INTERVAL.as_secs()).contains(&retry_after),
        "{retry_after}"
    );
    assert_eq!(response_json(res).await["error"], "preview_rate_limited");
    assert_eq!(body_bytes(fx.get("owner@example.com").await).await, webp(1));

    fx.let_the_interval_pass().await;
    let res = fx.put("editor@example.com", "image/webp", webp(2)).await;
    assert_eq!(res.status(), StatusCode::OK);
    assert_eq!(body_bytes(fx.get("owner@example.com").await).await, webp(2));
}

#[tokio::test]
async fn an_archived_workspace_keeps_its_preview_for_its_owners_only() {
    let fx = fixture().await;
    fx.put("owner@example.com", "image/webp", webp(1)).await;
    fx.store
        .archive_workspace(&fx.workspace_id)
        .await
        .unwrap()
        .unwrap();

    let res = fx.get("owner@example.com").await;
    assert_eq!(res.status(), StatusCode::OK, "the archived shelf shows it");
    assert_eq!(body_bytes(res).await, webp(1));
    assert_eq!(
        fx.get("viewer@example.com").await.status(),
        StatusCode::FORBIDDEN
    );

    let res = fx.put("owner@example.com", "image/webp", webp(2)).await;
    assert_eq!(
        res.status(),
        StatusCode::FORBIDDEN,
        "an archived workspace takes no writes"
    );
}

#[tokio::test]
async fn the_listing_carries_the_preview_update_time() {
    let fx = fixture().await;
    let listed = |res: axum::response::Response| async move {
        response_json(res).await[0]["preview_updated_at"].clone()
    };
    let list = || {
        Request::builder()
            .uri("/api/workspaces")
            .body(Body::empty())
            .unwrap()
    };

    let before = fx.send("viewer@example.com", list()).await;
    assert_eq!(listed(before).await, serde_json::Value::Null);

    let meta = response_json(fx.put("owner@example.com", "image/webp", webp(1)).await).await;
    let after = fx.send("viewer@example.com", list()).await;
    assert_eq!(listed(after).await, meta["updated_at"]);
}
