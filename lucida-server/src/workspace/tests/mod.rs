use std::sync::Arc;
use std::time::Duration;

use axum::Router;
use axum::http::StatusCode;
use axum::response::{IntoResponse, Json};
use chrono::Utc;
use lucida_content::url::{SourceIdentity, SourceRevision, SourceVersion};
use lucida_content::{DatasetId, DatasetManifest};
use lucida_core::auth_principal::AuthPrincipal;
use lucida_core::command::DocumentCommand;
use lucida_core::protocol::ServerMessage;
use lucida_core::saved_view::SavedView;
use lucida_core::scene::DocumentState;
use serde_json::json;

use crate::DatasetRuntimeConfig;
use crate::outbox::BroadcastKind;

use super::manager::{
    AccessMutationTestHook, MAX_DATASET_NAME_CHARS, ensure_saved_view_readable,
    saved_view_transition_allowed,
};
use super::store::normalize_email;

use axum::body::{Body, to_bytes};
use axum::http::{Method, Request};
use sqlx::sqlite::{SqliteConnectOptions, SqlitePoolOptions};
use tokio_tungstenite::tungstenite::client::IntoClientRequest;
use tower::ServiceExt;

use crate::binding::{ChunkResolver, ServerBinding};
use crate::generated_coarse::{DerivedChunkCache, GeneratedCoarseService};
use lucida_protocol::{DatasetOpened, FetchSource, ProxiedFetchDescriptor};
use lucida_store::cache::CachedStore;
use lucida_store::import_types::ServerBindingSeed;
use object_store::memory::InMemory;

use crate::auth::{
    AuthConfig, AuthMode, BearerToken, BearerTokenStore, LoginSessionStore, MemoryBearerTokenStore,
    MemorySessionStore, hash_bearer_token,
};
use crate::auth::{DualCredentialExtractor, PrincipalExtractor};

use super::*;
mod access;
mod datasets;
mod duplicate;
mod saved_views;

static MIGRATOR: sqlx::migrate::Migrator = sqlx::migrate!("./migrations");

pub fn principal(email: &str, is_admin: bool) -> AuthPrincipal {
    AuthPrincipal {
        email: email.to_string(),
        display_name: email.to_string(),
        picture_url: None,
        is_admin,
        auth_epoch: 0,
    }
}

async fn fresh_store() -> SqliteWorkspaceStore {
    fresh_store_with_pool().await.0
}

/// Like [`fresh_store`], but also hands back the pool so a test can
/// `close()` it and drive genuine store failures (every subsequent query
/// errors) — e.g. to prove that a failed role lookup is reported as
/// infrastructure trouble, not as an authorization verdict.
async fn fresh_store_with_pool() -> (SqliteWorkspaceStore, sqlx::sqlite::SqlitePool) {
    let opts = SqliteConnectOptions::new()
        .filename(":memory:")
        .create_if_missing(true);
    let pool = SqlitePoolOptions::new()
        .max_connections(1)
        .connect_with(opts)
        .await
        .unwrap();
    MIGRATOR.run(&pool).await.unwrap();
    (SqliteWorkspaceStore::new(pool.clone()), pool)
}

fn inert_server_binding(source_url: &str, manifest: DatasetManifest) -> ServerBinding {
    let store = Arc::new(InMemory::new()) as Arc<dyn object_store::ObjectStore>;
    let cache = Arc::new(CachedStore::new(Arc::clone(&store), 1024));
    let resolver = Arc::new(ChunkResolver::new(&ServerBindingSeed { images: vec![] }));
    let derived_chunks = Arc::new(DerivedChunkCache::default());
    ServerBinding {
        source: test_source(source_url),
        store,
        resolver,
        cache,
        dataset_opened: DatasetOpened {
            manifest,
            fetch: FetchSource::Proxied(ProxiedFetchDescriptor { images: vec![] }),
            opener_client_id: None,
        },
        derived_chunks: Arc::clone(&derived_chunks),
        generated_service: Arc::new(GeneratedCoarseService::inert(derived_chunks)),
        import_warnings: vec![],
    }
}

fn test_source(url: &str) -> SourceVersion {
    SourceVersion::new(
        SourceIdentity::parse(url).unwrap(),
        SourceRevision::from_bytes(b"workspace-test-revision"),
    )
}

fn idle_eviction_config() -> WorkspaceRuntimeConfig {
    WorkspaceRuntimeConfig {
        idle_ttl: Duration::ZERO,
        idle_sweep_interval: Duration::from_secs(60),
    }
}

fn workspace_router_with_principal(
    manager: Arc<WorkspaceManager>,
    principal: AuthPrincipal,
) -> Router {
    let principal = Arc::new(principal);
    router(manager).layer(axum::middleware::from_fn(
        move |mut req: Request<Body>, next: axum::middleware::Next| {
            let principal = Arc::clone(&principal);
            async move {
                req.extensions_mut()
                    .insert(AuthPrincipal::clone(&*principal));
                next.run(req).await
            }
        },
    ))
}

async fn response_json(res: axum::response::Response) -> serde_json::Value {
    let bytes = to_bytes(res.into_body(), 64 * 1024).await.unwrap();
    serde_json::from_slice(&bytes).unwrap()
}

// Resolve the open-path error a non-member would receive to the concrete
// (status, json-body) a browser/CLI actually sees, going through the same
// terminal `WorkspaceError::into_response` mapping the handler uses.
async fn open_status_body(
    manager: &WorkspaceManager,
    workspace_id: &str,
    principal: &AuthPrincipal,
) -> (StatusCode, serde_json::Value) {
    let res = match manager.get_workspace_for(workspace_id, principal).await {
        Ok((record, role)) => (
            StatusCode::OK,
            Json(WorkspaceResponse::from_record(record, role)),
        )
            .into_response(),
        Err(err) => err.into_response(),
    };
    let status = res.status();
    let bytes = to_bytes(res.into_body(), 64 * 1024).await.unwrap();
    let body: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
    (status, body)
}

/// Seed a workspace with a single dataset whose manifest name and DB
/// `display_name` are both `name`, persisted at `seq`. Returns the
/// workspace id and the workspace-dataset id so a test can then open the
/// live workspace (which loads this document from the store) and rename it.
async fn seed_workspace_with_dataset(
    store: &SqliteWorkspaceStore,
    owner: &AuthPrincipal,
    name: &str,
) -> (String, DatasetId) {
    let workspace = store.create_workspace(owner, Some("Demo")).await.unwrap();
    let workspace_dataset_id = DatasetId("wds_rename".into());
    let mut doc = DocumentState::default();
    doc.manifests.insert(
        workspace_dataset_id.clone(),
        lucida_content::DatasetManifest::new(
            workspace_dataset_id.clone(),
            name.into(),
            lucida_content::DatasetKind::Single,
            vec![],
            vec![],
            vec![],
            vec![],
            None,
        ),
    );
    store
        .persist_dataset_opened(
            &workspace.id,
            &workspace_dataset_id,
            &test_source("file:///data/original.zarr"),
            name,
            &owner.email,
            1,
            &doc,
        )
        .await
        .unwrap();
    (workspace.id, workspace_dataset_id)
}

/// Open a dataset into a workspace via the store the way the runtime does:
/// a fresh workspace-local id, a manifest in the document, and a
/// `workspace_datasets` membership row. Returns the workspace-local id.
async fn open_dataset_into(
    store: &SqliteWorkspaceStore,
    workspace_id: &str,
    owner: &AuthPrincipal,
    _source_id: &str,
    url: &str,
    display_name: &str,
    seq: u64,
) -> DatasetId {
    let wds_id = DatasetId(format!("wds-{}", uuid::Uuid::new_v4().simple()));
    // Carry the prior document forward so multiple opens accumulate.
    let mut doc = store
        .get_workspace(workspace_id)
        .await
        .unwrap()
        .unwrap()
        .document;
    doc.manifests.insert(
        wds_id.clone(),
        lucida_content::DatasetManifest::new(
            wds_id.clone(),
            display_name.into(),
            lucida_content::DatasetKind::Single,
            vec![],
            vec![],
            vec![],
            vec![],
            None,
        ),
    );
    store
        .persist_dataset_opened(
            workspace_id,
            &wds_id,
            &test_source(url),
            display_name,
            &owner.email,
            seq,
            &doc,
        )
        .await
        .unwrap();
    wds_id
}

fn view_over(order: &[DatasetId]) -> SavedView {
    let mut v = SavedView::empty([800, 600]);
    for id in order {
        v.dataset_order.push(id.clone());
        v.active_layouts
            .insert(id.clone(), lucida_content::LayoutId("default".into()));
    }
    v
}

/// Seed a collaborative pin on `dataset_id` carrying the author's captured
/// view (`Annotation::view`), keyed by `dataset_id` across every id-keyed
/// field of the embedded view. Applies the same `AddAnnotation` command the
/// runtime does and persists the document, so a later duplicate must remap
/// the embedded view onto the copy's ids (the regression this guards).
async fn seed_pin_with_view(
    store: &SqliteWorkspaceStore,
    workspace_id: &str,
    owner: &AuthPrincipal,
    dataset_id: &DatasetId,
    seq: u64,
) {
    // A captured view whose every id-keyed map references `dataset_id`.
    let mut view = SavedView::empty([1024, 768]);
    view.dataset_order.push(dataset_id.clone());
    view.active_layouts.insert(
        dataset_id.clone(),
        lucida_content::LayoutId("default".into()),
    );
    view.dataset_settings.insert(
        dataset_id.clone(),
        lucida_core::scene::DatasetDisplaySettings::default(),
    );
    view.auto_contrast.insert(dataset_id.clone(), false);

    let mut doc = store
        .get_workspace(workspace_id)
        .await
        .unwrap()
        .unwrap()
        .document;
    doc.apply(DocumentCommand::AddAnnotation {
        dataset_id: dataset_id.clone(),
        id: "pin-with-view".into(),
        position: [3.0, 4.0],
        end: None,
        z: 1.0,
        t: 0,
        c: 0,
        author: owner.email.clone(),
        kind: lucida_core::scene::AnnotationKind::Point,
        view: Some(Box::new(view)),
    });
    store
        .persist_document(workspace_id, seq, &doc)
        .await
        .unwrap();
}

/// Seed a "rich" source workspace owned by `owner`:
/// 2 datasets (custom display names), a Shared view (set as default), a
/// Personal view by `other`, a Proposed view by `other`, an extra member,
/// and link access turned ON with a non-default (editor) role.
/// Returns (workspace_id, [dataset ids], shared_view_id).
async fn seed_rich_source(
    store: &SqliteWorkspaceStore,
    owner: &AuthPrincipal,
    other: &AuthPrincipal,
) -> (String, Vec<DatasetId>, String) {
    let ws = store
        .create_workspace(owner, Some("My Project"))
        .await
        .unwrap();
    let a = open_dataset_into(
        store,
        &ws.id,
        owner,
        "src-a",
        "file:///data/a.zarr",
        "Alpha",
        1,
    )
    .await;
    let b = open_dataset_into(
        store,
        &ws.id,
        owner,
        "src-b",
        "file:///data/b.zarr",
        "Beta",
        2,
    )
    .await;

    let shared = store
        .create_saved_view(
            &ws.id,
            "Team view",
            owner,
            view_over(&[a.clone(), b.clone()]),
            SavedViewVisibility::Shared,
        )
        .await
        .unwrap()
        .unwrap();
    store
        .create_saved_view(
            &ws.id,
            "Bob private",
            other,
            view_over(std::slice::from_ref(&a)),
            SavedViewVisibility::Personal,
        )
        .await
        .unwrap();
    store
        .create_saved_view(
            &ws.id,
            "Bob proposal",
            other,
            view_over(std::slice::from_ref(&b)),
            SavedViewVisibility::Proposed,
        )
        .await
        .unwrap();
    store
        .set_default_saved_view(&ws.id, Some(&shared.id))
        .await
        .unwrap();

    // Extra member + link access ON with a non-default role.
    store
        .upsert_member(
            &ws.id,
            &other.email,
            &other.display_name,
            WorkspaceRole::Editor,
        )
        .await
        .unwrap();
    store
        .update_link_access(
            &ws.id,
            WorkspaceLinkAccess::AnyoneWithLink,
            WorkspaceRole::Editor,
        )
        .await
        .unwrap();

    (ws.id, vec![a, b], shared.id)
}

fn manager_for(store: &SqliteWorkspaceStore) -> WorkspaceManager {
    WorkspaceManager::new(Arc::new(store.clone()), DatasetRuntimeConfig::defaults())
}

/// Seed a pin whose captured author view embeds SOURCE dataset *URLs* in
/// its `datasets` Vec — simulating a document PERSISTED BEFORE the apply-path
/// strip existed (a genuinely DIRTY source). `DocumentState::apply` now
/// strips such URLs, so we deliberately bypass it: `add_annotation` stores
/// the view verbatim and `persist_document` serializes the `DocumentState`
/// as-is (no apply). This is the dirty carrier the duplicate's copy-point
/// defense must clean — `remap_dataset_ids` remaps ids but the explicit
/// `clear_source_urls` at the copy point drops the URLs.
async fn seed_pin_with_view_urls(
    store: &SqliteWorkspaceStore,
    workspace_id: &str,
    owner: &AuthPrincipal,
    dataset_id: &DatasetId,
    urls: &[&str],
    seq: u64,
) {
    let mut view = SavedView::empty([1024, 768]);
    view.dataset_order.push(dataset_id.clone());
    view.active_layouts.insert(
        dataset_id.clone(),
        lucida_content::LayoutId("default".into()),
    );
    // The smuggled payload: source dataset URLs on the embedded view.
    for u in urls {
        view.datasets.push((*u).to_string());
    }

    let mut doc = store
        .get_workspace(workspace_id)
        .await
        .unwrap()
        .unwrap()
        .document;
    // Bypass `apply` (which now strips) to write a dirty pin straight into
    // the document, exactly as a pre-fix persisted document would carry it.
    doc.add_annotation(
        dataset_id.clone(),
        lucida_core::scene::Annotation {
            id: "pin-url-leak".into(),
            position: [1.0, 2.0],
            end: None,
            z: 0.0,
            t: 0,
            c: 0,
            author: owner.email.clone(),
            kind: lucida_core::scene::AnnotationKind::Point,
            comments: Vec::new(),
            anchor: None,
            view: Some(view),
        },
    );
    store
        .persist_document(workspace_id, seq, &doc)
        .await
        .unwrap();
}
