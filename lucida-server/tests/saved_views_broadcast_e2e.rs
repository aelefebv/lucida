//! Cross-peer bookmark broadcast e2e (PRD #454 slice 4, issue #477).
//!
//! Stands up the real bookmarks router behind the real auth middleware
//! and wires it to a real `Session` + `UnicastRoutes` map. Exercises:
//!
//! - POST → `BookmarkChanged { Created }` lands on every connected
//!   client whose session has at least one overlapping loaded dataset
//!   URL; clients with no overlap see nothing.
//! - PATCH → `BookmarkChanged { Updated }` follows the same scope rule.
//! - DELETE → `BookmarkChanged { Deleted }` follows the same scope rule
//!   *based on the bookmark's stored dataset URLs*, even if the deleter
//!   has none of those datasets currently loaded.
//! - Multi-dataset bookmark touching both sets reaches every client
//!   regardless of which subset they have loaded (the scope is "any
//!   overlap", not "all overlap").
//! - Self-broadcast: the originating client receives the broadcast too
//!   (we don't filter sender server-side — the optimistic local state
//!   in the web client reconciles cleanly via the broadcast-driven
//!   refetch).
//!
//! ## Why mpsc receivers stand in for WebSockets
//!
//! The `unicast_routes` map is the same `HashMap<ClientId,
//! mpsc::UnboundedSender<Message>>` the WebSocket handler uses to
//! deliver per-client frames. Inserting a receiver under a synthetic
//! `ClientId` is exactly what `handle_client` does on connect, minus
//! the WebSocket transport. The broadcast helper enqueues
//! `Message::Text` items into those senders; the WS outbound loop
//! would forward each verbatim to the wire. Avoiding tungstenite
//! keeps the dep budget flat and the test deterministic (no port
//! flakiness, no async accept loops to teardown).

use std::collections::HashMap;
use std::sync::Arc;

use axum::Router;
use axum::body::{Body, to_bytes};
use axum::extract::ws::Message;
use axum::http::header::LOCATION;
use axum::http::{Request, StatusCode};
use axum::middleware::from_fn_with_state;
use chrono::{Duration as ChronoDuration, Utc};
use serde_json::{Value, json};
use tokio::sync::{Mutex, mpsc};
use tower::ServiceExt;

use lucida_content::{
    Axis, AxisKind, DataType, DatasetId, DatasetKind, DatasetManifest, Entity, EntityId,
    EntityKind, EntityLabels, ImageId, ImageSpec, LevelGeometry, MultiscaleInfo,
};
use lucida_core::protocol::{BookmarkAction, ClientId, ServerMessage};
use lucida_protocol::{
    AssetCatalog, DatasetOpened, FetchSource, ProxiedFetchDescriptor, ProxiedImageSpec, WireFormat,
};
use lucida_server::UnicastRoutes;
use lucida_server::auth::middleware::{SharedExtractor, auth_middleware};
use lucida_server::auth::principal::SessionCookieExtractor;
use lucida_server::auth::{AuthConfig, LoginSession, LoginSessionStore, MemorySessionStore};
use lucida_server::binding::{ChunkResolver, ServerBinding};
use lucida_server::bookmarks::handlers::BookmarksState;
use lucida_server::bookmarks::routes::router as bookmarks_router;
use lucida_server::bookmarks::{BookmarkStore, MemoryBookmarkStore};
use lucida_server::proxy::{ProxyCache, ProxyGenerator};
use lucida_server::session::Session;
use lucida_store::cache::CachedStore;
use lucida_store::import_types::ServerBindingSeed;

/// Rig that owns the live router + the underlying session/unicast
/// state so individual tests can install datasets, connect synthetic
/// clients, and pump REST traffic.
struct Rig {
    app: Router,
    session: Arc<Mutex<Session>>,
    unicast_routes: UnicastRoutes,
}

async fn build_rig() -> Rig {
    let auth_session_store = Arc::new(MemorySessionStore::new());
    let now = Utc::now();
    auth_session_store
        .create(LoginSession {
            id: "alice-cookie".into(),
            email: "alice@x".into(),
            display_name: "Alice".into(),
            picture_url: None,
            created_at: now,
            last_used_at: now,
            expires_at: now + ChronoDuration::hours(24),
        })
        .await
        .unwrap();
    auth_session_store
        .create(LoginSession {
            id: "bob-cookie".into(),
            email: "bob@x".into(),
            display_name: "Bob".into(),
            picture_url: None,
            created_at: now,
            last_used_at: now,
            expires_at: now + ChronoDuration::hours(24),
        })
        .await
        .unwrap();

    let config = Arc::new(AuthConfig::for_tests());
    // Cookie extractor explicitly: PRD #527 made `build_extractor`
    // pick the stub for `Disabled` mode, but this test relies on
    // per-cookie identities (`alice@x` vs `bob@x`) to drive the
    // bookmark-broadcast assertions.
    let extractor: SharedExtractor = Arc::new(SessionCookieExtractor::new(
        Arc::clone(&config),
        auth_session_store as Arc<dyn LoginSessionStore>,
    ));

    let session = Arc::new(Mutex::new(Session::new()));
    let unicast_routes: UnicastRoutes = Arc::new(Mutex::new(HashMap::new()));
    let bookmark_store: Arc<dyn BookmarkStore> = Arc::new(MemoryBookmarkStore::new());
    let bookmarks_state = BookmarksState {
        store: bookmark_store,
        session: Some(Arc::clone(&session)),
        unicast_routes: Some(Arc::clone(&unicast_routes)),
    };

    let app =
        bookmarks_router(bookmarks_state).layer(from_fn_with_state(extractor, auth_middleware));
    Rig {
        app,
        session,
        unicast_routes,
    }
}

/// Build a minimally-valid `ServerBinding` that just carries
/// `source_url` so the broadcast helper's overlap check finds the
/// expected URL. No real storage is involved.
fn make_binding(url: &str) -> ServerBinding {
    let store =
        Arc::new(object_store::memory::InMemory::new()) as Arc<dyn object_store::ObjectStore>;
    let cached = Arc::new(CachedStore::new(store.clone(), 1024));
    let resolver = Arc::new(ChunkResolver::new(&ServerBindingSeed { images: vec![] }));
    let manifest = DatasetManifest::new(
        DatasetId(format!("ds-{url}")),
        "test".into(),
        DatasetKind::Single,
        vec![Entity {
            id: EntityId("e".into()),
            kind: EntityKind::Image,
            parent: None,
            labels: EntityLabels::default(),
        }],
        vec![],
        vec![ImageSpec {
            image_id: ImageId("img".into()),
            owner: EntityId("e".into()),
            multiscale: MultiscaleInfo {
                axes: vec![
                    Axis {
                        name: "z".into(),
                        kind: AxisKind::Space,
                    },
                    Axis {
                        name: "y".into(),
                        kind: AxisKind::Space,
                    },
                    Axis {
                        name: "x".into(),
                        kind: AxisKind::Space,
                    },
                ],
                levels: vec![LevelGeometry {
                    level_index: 0,
                    shape: [1, 1, 1, 1, 1],
                    chunk_shape: [1, 1, 1, 1, 1],
                    grid_shape: [1, 1, 1, 1, 1],
                    scale: [1.0; 5],
                }],
                data_type: DataType::Uint16,
                pinned_axes: vec![],
            },
        }],
        vec![],
        None,
    );
    let dataset_opened = DatasetOpened {
        manifest: manifest.clone(),
        fetch: FetchSource::Proxied(ProxiedFetchDescriptor {
            images: vec![ProxiedImageSpec {
                image_id: ImageId("img".into()),
                wire_format: WireFormat::Raw {
                    data_type: DataType::Uint16,
                },
            }],
        }),
        catalog: AssetCatalog::default(),
    };
    let proxy_cache = Arc::new(ProxyCache::new_disabled(
        std::path::PathBuf::from("/dev/null"),
        [0u8; 16],
    ));
    let proxy_generator = Arc::new(ProxyGenerator::new(
        proxy_cache.clone(),
        cached.clone(),
        resolver.clone(),
        Arc::new(manifest),
        1,
    ));
    ServerBinding {
        source_url: url.to_string(),
        store,
        resolver,
        cache: cached,
        dataset_opened,
        proxy_cache,
        proxy_generator,
    }
}

async fn install_dataset(rig: &Rig, url: &str) {
    let mut sess = rig.session.lock().await;
    sess.server_bindings
        .insert(DatasetId(format!("ds-{url}")), make_binding(url));
}

async fn connect_client(rig: &Rig, id: ClientId) -> mpsc::UnboundedReceiver<Message> {
    rig.session.lock().await.add_client(id);
    let (tx, rx) = mpsc::unbounded_channel::<Message>();
    rig.unicast_routes.lock().await.insert(id, tx);
    rx
}

fn drain_text(rx: &mut mpsc::UnboundedReceiver<Message>) -> Vec<String> {
    let mut out = Vec::new();
    while let Ok(msg) = rx.try_recv() {
        if let Message::Text(t) = msg {
            out.push(t.to_string());
        }
    }
    out
}

fn parse_bookmark_changed(json: &str) -> (String, BookmarkAction, Vec<String>) {
    let parsed: ServerMessage = serde_json::from_str(json).expect("ServerMessage");
    match parsed {
        ServerMessage::BookmarkChanged {
            id,
            action,
            dataset_urls,
        } => (id, action, dataset_urls),
        other => panic!("expected BookmarkChanged, got {other:?}"),
    }
}

fn sample_view_json() -> Value {
    json!({
        "v": 1,
        "camera": {"mode": "slice", "center": [0.0, 0.0], "zoom": 1.0, "viewport": [800, 600]},
        "view": {"z_range": {"start": 0, "end": 1}, "t": 0, "c": 0},
        "display": {"contrast_min": 0.0, "contrast_max": 65535.0, "gamma": 1.0}
    })
}

async fn read_json(res: axum::response::Response) -> Value {
    let bytes = to_bytes(res.into_body(), 1024 * 1024).await.unwrap();
    serde_json::from_slice(&bytes).unwrap_or_else(|e| {
        panic!(
            "body did not parse: {e}; raw: {}",
            String::from_utf8_lossy(&bytes)
        )
    })
}

const URL_A: &str = "gs://bucket/a.zarr";
const URL_B: &str = "gs://bucket/b.zarr";

/// Two clients connected to the same Session. Client A has dataset
/// URL_A loaded; client B has URL_B (in this test rig the session is
/// shared so both URLs end up loaded once we install both bindings —
/// see the "broadcast scope" note in the broadcast module docs).
///
/// Acceptance criterion §"affected-client computation": the broadcast
/// scope is decided by the bookmark's `dataset_urls` overlapping any
/// loaded URL. With both URL_A and URL_B installed, a bookmark
/// referencing URL_A reaches both clients (both share the session),
/// and a bookmark referencing URL_C reaches neither.
#[tokio::test]
async fn post_broadcasts_to_clients_with_overlapping_datasets() {
    let rig = build_rig().await;
    install_dataset(&rig, URL_A).await;
    install_dataset(&rig, URL_B).await;
    let mut rx_a = connect_client(&rig, 1).await;
    let mut rx_b = connect_client(&rig, 2).await;

    // POST a bookmark scoped to URL_A
    let body = json!({
        "name": "Apoptotic morphology",
        "datasets": [URL_A],
        "view": sample_view_json(),
    });
    let res = rig
        .app
        .clone()
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/api/bookmarks")
                .header("cookie", "lucida_session=alice-cookie")
                .header("content-type", "application/json")
                .body(Body::from(serde_json::to_vec(&body).unwrap()))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(res.status(), StatusCode::CREATED);

    let msgs_a = drain_text(&mut rx_a);
    let msgs_b = drain_text(&mut rx_b);
    assert_eq!(msgs_a.len(), 1, "client A receives Created broadcast");
    assert_eq!(msgs_b.len(), 1, "client B receives Created broadcast");
    let (_, action_a, urls_a) = parse_bookmark_changed(&msgs_a[0]);
    assert_eq!(action_a, BookmarkAction::Created);
    assert_eq!(urls_a, vec![URL_A.to_string()]);
    let (_, action_b, urls_b) = parse_bookmark_changed(&msgs_b[0]);
    assert_eq!(action_b, BookmarkAction::Created);
    assert_eq!(urls_b, vec![URL_A.to_string()]);
}

/// Bookmark whose URL doesn't overlap any loaded dataset → no client
/// receives a broadcast (the helper short-circuits on `matched_scope`).
#[tokio::test]
async fn post_with_unrelated_dataset_skips_broadcast_entirely() {
    let rig = build_rig().await;
    install_dataset(&rig, URL_A).await;
    let mut rx = connect_client(&rig, 1).await;

    let body = json!({
        "name": "Unrelated",
        "datasets": ["gs://other/c.zarr"],
        "view": sample_view_json(),
    });
    let res = rig
        .app
        .clone()
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/api/bookmarks")
                .header("cookie", "lucida_session=alice-cookie")
                .header("content-type", "application/json")
                .body(Body::from(serde_json::to_vec(&body).unwrap()))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(res.status(), StatusCode::CREATED);

    assert!(drain_text(&mut rx).is_empty(), "no overlap → no broadcast");
}

/// Multi-dataset bookmark whose `datasets` list spans URL_A and URL_B
/// reaches every connected client whose session has either loaded.
#[tokio::test]
async fn post_with_multi_dataset_bookmark_reaches_all_overlapping_clients() {
    let rig = build_rig().await;
    install_dataset(&rig, URL_A).await;
    install_dataset(&rig, URL_B).await;
    let mut rx_a = connect_client(&rig, 1).await;
    let mut rx_b = connect_client(&rig, 2).await;

    let body = json!({
        "name": "Spans both",
        "datasets": [URL_A, URL_B],
        "view": sample_view_json(),
    });
    let res = rig
        .app
        .clone()
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/api/bookmarks")
                .header("cookie", "lucida_session=alice-cookie")
                .header("content-type", "application/json")
                .body(Body::from(serde_json::to_vec(&body).unwrap()))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(res.status(), StatusCode::CREATED);

    let msgs_a = drain_text(&mut rx_a);
    let msgs_b = drain_text(&mut rx_b);
    assert_eq!(msgs_a.len(), 1);
    assert_eq!(msgs_b.len(), 1);
    let (_, _, urls_a) = parse_bookmark_changed(&msgs_a[0]);
    let mut urls_a_sorted = urls_a.clone();
    urls_a_sorted.sort();
    assert_eq!(urls_a_sorted, vec![URL_A.to_string(), URL_B.to_string()],);
}

/// PATCH (rename) emits Updated to every overlapping client.
#[tokio::test]
async fn patch_broadcasts_updated_action() {
    let rig = build_rig().await;
    install_dataset(&rig, URL_A).await;
    let mut rx = connect_client(&rig, 1).await;

    let create_body = json!({
        "name": "Old name",
        "datasets": [URL_A],
        "view": sample_view_json(),
    });
    let res = rig
        .app
        .clone()
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/api/bookmarks")
                .header("cookie", "lucida_session=alice-cookie")
                .header("content-type", "application/json")
                .body(Body::from(serde_json::to_vec(&create_body).unwrap()))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(res.status(), StatusCode::CREATED);
    let location = res
        .headers()
        .get(LOCATION)
        .unwrap()
        .to_str()
        .unwrap()
        .to_string();
    let created = read_json(res).await;
    let id = created["id"].as_str().unwrap().to_string();
    assert!(location.ends_with(&id));
    // Drain the Created broadcast.
    let _ = drain_text(&mut rx);

    let patch_body = json!({"name": "New name"});
    let res = rig
        .app
        .clone()
        .oneshot(
            Request::builder()
                .method("PATCH")
                .uri(format!("/api/bookmarks/{id}"))
                .header("cookie", "lucida_session=alice-cookie")
                .header("content-type", "application/json")
                .body(Body::from(serde_json::to_vec(&patch_body).unwrap()))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(res.status(), StatusCode::OK);

    let msgs = drain_text(&mut rx);
    assert_eq!(msgs.len(), 1);
    let (parsed_id, action, urls) = parse_bookmark_changed(&msgs[0]);
    assert_eq!(parsed_id, id);
    assert_eq!(action, BookmarkAction::Updated);
    assert_eq!(urls, vec![URL_A.to_string()]);
}

/// DELETE emits Deleted to every overlapping client. The scope is the
/// bookmark's stored `dataset_urls`, not whatever the deleter happens
/// to have loaded — exercised here by deleting via a principal whose
/// session bindings haven't changed since the bookmark was created.
#[tokio::test]
async fn delete_broadcasts_deleted_action() {
    let rig = build_rig().await;
    install_dataset(&rig, URL_A).await;
    let mut rx = connect_client(&rig, 1).await;

    // Create
    let res = rig
        .app
        .clone()
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/api/bookmarks")
                .header("cookie", "lucida_session=alice-cookie")
                .header("content-type", "application/json")
                .body(Body::from(
                    serde_json::to_vec(&json!({
                        "name": "Doomed",
                        "datasets": [URL_A],
                        "view": sample_view_json(),
                    }))
                    .unwrap(),
                ))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(res.status(), StatusCode::CREATED);
    let id = read_json(res).await["id"].as_str().unwrap().to_string();
    let _ = drain_text(&mut rx);

    // Delete
    let res = rig
        .app
        .clone()
        .oneshot(
            Request::builder()
                .method("DELETE")
                .uri(format!("/api/bookmarks/{id}"))
                .header("cookie", "lucida_session=alice-cookie")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(res.status(), StatusCode::NO_CONTENT);

    let msgs = drain_text(&mut rx);
    assert_eq!(msgs.len(), 1);
    let (parsed_id, action, urls) = parse_bookmark_changed(&msgs[0]);
    assert_eq!(parsed_id, id);
    assert_eq!(action, BookmarkAction::Deleted);
    assert_eq!(urls, vec![URL_A.to_string()]);
}

/// Self-broadcast is intentional: the originating client receives the
/// broadcast too. Slice 3's optimistic local state in `useBookmarks`
/// reconciles cleanly via the broadcast-driven refetch (the server's
/// returned bookmark is canonical).
#[tokio::test]
async fn self_broadcast_originator_receives_message() {
    let rig = build_rig().await;
    install_dataset(&rig, URL_A).await;
    // One client posts and is also the only listener.
    let mut rx = connect_client(&rig, 1).await;

    let res = rig
        .app
        .clone()
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/api/bookmarks")
                .header("cookie", "lucida_session=alice-cookie")
                .header("content-type", "application/json")
                .body(Body::from(
                    serde_json::to_vec(&json!({
                        "name": "Self echo",
                        "datasets": [URL_A],
                        "view": sample_view_json(),
                    }))
                    .unwrap(),
                ))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(res.status(), StatusCode::CREATED);

    let msgs = drain_text(&mut rx);
    assert_eq!(msgs.len(), 1, "originator receives self-broadcast");
}

/// 403 from a cross-user PATCH must NOT emit a broadcast — a
/// permission-denied request is server-state-unchanged and can't
/// trigger a sidebar update.
#[tokio::test]
async fn forbidden_patch_does_not_broadcast() {
    let rig = build_rig().await;
    install_dataset(&rig, URL_A).await;
    let mut rx = connect_client(&rig, 1).await;

    // Alice creates
    let res = rig
        .app
        .clone()
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/api/bookmarks")
                .header("cookie", "lucida_session=alice-cookie")
                .header("content-type", "application/json")
                .body(Body::from(
                    serde_json::to_vec(&json!({
                        "name": "Alice's",
                        "datasets": [URL_A],
                        "view": sample_view_json(),
                    }))
                    .unwrap(),
                ))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(res.status(), StatusCode::CREATED);
    let id = read_json(res).await["id"].as_str().unwrap().to_string();
    let _ = drain_text(&mut rx);

    // Bob attempts to PATCH
    let res = rig
        .app
        .clone()
        .oneshot(
            Request::builder()
                .method("PATCH")
                .uri(format!("/api/bookmarks/{id}"))
                .header("cookie", "lucida_session=bob-cookie")
                .header("content-type", "application/json")
                .body(Body::from(
                    serde_json::to_vec(&json!({"name": "hijack"})).unwrap(),
                ))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(res.status(), StatusCode::FORBIDDEN);
    assert!(drain_text(&mut rx).is_empty());
}
