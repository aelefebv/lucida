//! Recent datasets over HTTP, end to end: a person creates and opens
//! workspaces and opens datasets into them over the workspace socket, as a
//! browser does, and any session of theirs reads the datasets back from
//! the listings routes, through the real auth middleware.

use std::path::Path;
use std::sync::Arc;
use std::time::Duration;

use axum::Router;
use chrono::Utc;
use futures_util::{SinkExt, StreamExt};
use lucida_content::url::DatasetLocation;
use lucida_core::protocol::{ClientMessage, ServerMessage};
use lucida_server::GeneratedConfig;
use lucida_server::auth::{
    AuthConfig, AuthMode, BearerToken, BearerTokenStore, DualCredentialExtractor,
    LoginSessionStore, MemoryBearerTokenStore, MemorySessionStore, PrincipalExtractor,
    hash_bearer_token,
};
use lucida_server::listings::{
    self, DatasetSource, Listing, ListingGroup, ListingKind, ListingsIndex, SourceError,
};
use lucida_server::storage::{self, DatabaseUrl};
use lucida_server::workspace::WorkspaceManager;
use lucida_store::source_policy::SourcePolicy;
use serde_json::{Value, json};
use tokio::time::timeout;
use tokio_tungstenite::tungstenite::Message as WsMessage;
use tokio_tungstenite::tungstenite::client::IntoClientRequest;

const READ_TIMEOUT: Duration = Duration::from_secs(20);

/// Two sessions of one person, and a second person.
const SESSION: &str = "lucida_pat_recent_e2e_session";
const OTHER_SESSION: &str = "lucida_pat_recent_e2e_other_session";
const SOMEONE_ELSE: &str = "lucida_pat_recent_e2e_someone_else";

/// A source that lists whatever a test hands it.
struct FakeSource(Vec<Listing>);

#[async_trait::async_trait]
impl DatasetSource for FakeSource {
    fn group_noun(&self) -> &str {
        "Shelf"
    }

    async fn listings(&self) -> Result<Vec<Listing>, SourceError> {
        Ok(self.0.clone())
    }
}

/// A live server with the workspace and listings routes behind the auth
/// middleware, as `main.rs` mounts them.
struct Rig {
    address: std::net::SocketAddr,
    data: tempfile::TempDir,
    server: tokio::task::JoinHandle<()>,
}

impl Drop for Rig {
    fn drop(&mut self) {
        self.server.abort();
    }
}

impl Rig {
    async fn start() -> Self {
        Self::listing(|_| Vec::new()).await
    }

    /// A server whose one source lists `listings`, built over the data
    /// directory so a listing can name a dataset the test writes.
    async fn listing(listings: impl FnOnce(&Path) -> Vec<Listing>) -> Self {
        let data = tempfile::tempdir().unwrap();
        let storage = storage::open(&DatabaseUrl::in_memory()).await.unwrap();
        let mut generated = GeneratedConfig::defaults();
        generated.generated_enabled = false;
        generated.generated_cache_dir = data.path().join("generated-coarse");
        let workspaces = Arc::new(WorkspaceManager::new(storage.workspaces(), generated));
        let source: Arc<dyn DatasetSource> = Arc::new(FakeSource(listings(data.path())));
        let index = Arc::new(ListingsIndex::new(
            vec![source],
            Arc::new(SourcePolicy::unrestricted()),
        ));
        index.refresh().await;
        let app: Router = lucida_server::workspace::router(Arc::clone(&workspaces))
            .merge(listings::router(index, workspaces))
            .layer(axum::middleware::from_fn_with_state(
                bearer_extractor().await,
                lucida_server::auth::middleware::auth_middleware,
            ));
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            axum::serve(
                listener,
                app.into_make_service_with_connect_info::<std::net::SocketAddr>(),
            )
            .await
            .unwrap();
        });
        Self {
            address,
            data,
            server,
        }
    }

    /// A dataset named `name` in the data directory, as its canonical URL.
    fn dataset(&self, name: &str) -> String {
        dataset_url(self.data.path(), name)
    }

    /// Create a workspace and open it, as the dashboard does before a
    /// dataset opens into it.
    async fn new_workspace(&self, token: &str) -> String {
        let response = reqwest::Client::new()
            .post(format!("http://{}/api/workspaces", self.address))
            .bearer_auth(token)
            .json(&json!({ "name": "Recent" }))
            .send()
            .await
            .unwrap();
        assert_eq!(response.status(), reqwest::StatusCode::CREATED);
        let id = response.json::<Value>().await.unwrap()["id"]
            .as_str()
            .unwrap()
            .to_string();
        self.open_workspace(token, &id).await;
        id
    }

    async fn open_workspace(&self, token: &str, workspace_id: &str) {
        let response = reqwest::Client::new()
            .post(format!(
                "http://{}/api/workspaces/{}",
                self.address,
                urlencoding::encode(workspace_id)
            ))
            .bearer_auth(token)
            .send()
            .await
            .unwrap();
        assert_eq!(response.status(), reqwest::StatusCode::OK);
    }

    /// Open each of `urls` into the workspace over its socket, in order,
    /// each once the one before has opened.
    async fn open_datasets(&self, token: &str, workspace_id: &str, urls: &[String]) {
        let mut request = format!(
            "ws://{}/ws/workspaces/{}",
            self.address,
            urlencoding::encode(workspace_id)
        )
        .into_client_request()
        .unwrap();
        request
            .headers_mut()
            .insert("Authorization", format!("Bearer {token}").parse().unwrap());
        let (mut ws, _) = tokio_tungstenite::connect_async(request)
            .await
            .expect("ws connect");
        for (at, url) in urls.iter().enumerate() {
            let request_id = format!("open-{at}");
            let open = ClientMessage::OpenRemoteDataset {
                request_id: request_id.clone(),
                url: url.clone(),
            };
            ws.send(WsMessage::Text(
                serde_json::to_string(&open).unwrap().into(),
            ))
            .await
            .unwrap();
            loop {
                let message = timeout(READ_TIMEOUT, ws.next())
                    .await
                    .expect("timed out waiting for the open")
                    .expect("stream ended")
                    .expect("ws read");
                let WsMessage::Text(text) = message else {
                    continue;
                };
                match serde_json::from_str::<ServerMessage>(text.as_str()).unwrap() {
                    ServerMessage::OpenDatasetSucceeded { request_id: id, .. }
                        if id == request_id =>
                    {
                        break;
                    }
                    ServerMessage::OpenDatasetFailed {
                        request_id: id,
                        diagnostic,
                        ..
                    } if id == request_id => panic!("{url} failed to open: {diagnostic:?}"),
                    _ => {}
                }
            }
        }
    }

    async fn recent(&self, token: &str) -> Vec<Value> {
        let response = reqwest::Client::new()
            .get(format!("http://{}/api/listings/recent", self.address))
            .bearer_auth(token)
            .send()
            .await
            .unwrap();
        assert_eq!(response.status(), reqwest::StatusCode::OK);
        response.json::<Value>().await.unwrap()["recent"]
            .as_array()
            .unwrap()
            .clone()
    }

    async fn recent_urls(&self, token: &str) -> Vec<String> {
        self.recent(token)
            .await
            .iter()
            .map(|recent| recent["url"].as_str().unwrap().to_string())
            .collect()
    }
}

/// The principal extractor the real server runs, holding a token for each
/// session.
async fn bearer_extractor() -> Arc<dyn PrincipalExtractor> {
    let now = Utc::now();
    let tokens = Arc::new(MemoryBearerTokenStore::new());
    for (raw, email) in [
        (SESSION, "person@example.com"),
        (OTHER_SESSION, "person@example.com"),
        (SOMEONE_ELSE, "someone@example.com"),
    ] {
        tokens
            .create(BearerToken {
                id: raw.into(),
                token_hash: hash_bearer_token(raw),
                name: "recent e2e".into(),
                email: email.into(),
                display_name: email.into(),
                picture_url: None,
                created_at: now,
                last_used_at: None,
                expires_at: now + chrono::Duration::hours(1),
                revoked_at: None,
            })
            .await
            .unwrap();
    }
    let mut config = AuthConfig::for_tests();
    config.mode = AuthMode::Google;
    Arc::new(DualCredentialExtractor::new(
        Arc::new(config),
        Arc::new(MemorySessionStore::new()) as Arc<dyn LoginSessionStore>,
        tokens as Arc<dyn BearerTokenStore>,
    ))
}

/// Write a metadata-only OME-Zarr v0.5 store at `dir/name`, which opens
/// without reading a chunk, and return its canonical URL.
fn dataset_url(dir: &Path, name: &str) -> String {
    let root = dir.join(name);
    let level = root.join("0");
    if !level.exists() {
        std::fs::create_dir_all(&level).unwrap();
        let group = json!({
            "zarr_format": 3,
            "node_type": "group",
            "attributes": {"ome": {"version": "0.5", "multiscales": [{
                "version": "0.5",
                "name": "img",
                "axes": [
                    {"name": "t", "type": "time"},
                    {"name": "c", "type": "channel"},
                    {"name": "z", "type": "space"},
                    {"name": "y", "type": "space"},
                    {"name": "x", "type": "space"}
                ],
                "datasets": [{"path": "0", "coordinateTransformations": [
                    {"type": "scale", "scale": [1.0, 1.0, 1.0, 1.0, 1.0]}
                ]}]
            }]}}
        });
        let array = json!({
            "zarr_format": 3,
            "node_type": "array",
            "shape": [1, 1, 1, 4, 4],
            "data_type": "uint16",
            "chunk_grid": {"name": "regular", "configuration": {"chunk_shape": [1, 1, 1, 4, 4]}},
            "codecs": [{"name": "bytes", "configuration": {"endian": "little"}}],
            "fill_value": 0
        });
        std::fs::write(root.join("zarr.json"), group.to_string()).unwrap();
        std::fs::write(level.join("zarr.json"), array.to_string()).unwrap();
    }
    DatasetLocation::parse(root.to_str().unwrap())
        .unwrap()
        .as_str()
        .to_string()
}

#[tokio::test]
async fn another_session_of_the_same_person_sees_their_recent_datasets_newest_first() {
    let rig = Rig::start().await;
    let [a, b, c] = ["a.zarr", "b.zarr", "c.zarr"].map(|name| rig.dataset(name));

    let first = rig.new_workspace(SESSION).await;
    rig.open_datasets(SESSION, &first, &[a.clone(), b.clone()])
        .await;
    let second = rig.new_workspace(SESSION).await;
    rig.open_datasets(SESSION, &second, std::slice::from_ref(&c))
        .await;

    assert_eq!(
        rig.recent(OTHER_SESSION).await,
        [(&c, "c.zarr"), (&b, "b.zarr"), (&a, "a.zarr")]
            .map(|(url, name)| json!({ "url": url, "name": name, "listing": null }))
            .to_vec(),
        "the workspace opened last first, and its latest dataset first",
    );

    rig.open_workspace(OTHER_SESSION, &first).await;
    assert_eq!(rig.recent_urls(SESSION).await, [b, a, c]);
}

#[tokio::test]
async fn no_dataset_appears_twice_and_the_list_stops_at_eight() {
    let rig = Rig::start().await;
    let older: Vec<String> = (0..6)
        .map(|n| rig.dataset(&format!("old-{n}.zarr")))
        .collect();
    let newer: Vec<String> = (0..4)
        .map(|n| rig.dataset(&format!("new-{n}.zarr")))
        .collect();

    let first = rig.new_workspace(SESSION).await;
    rig.open_datasets(SESSION, &first, &older).await;
    let second = rig.new_workspace(SESSION).await;
    // One dataset sits in both workspaces.
    let mut again = vec![older[5].clone()];
    again.extend(newer.iter().cloned());
    rig.open_datasets(SESSION, &second, &again).await;

    let urls = rig.recent_urls(OTHER_SESSION).await;
    assert_eq!(
        urls,
        [
            &newer[3], &newer[2], &newer[1], &newer[0], &older[5], &older[4], &older[3], &older[2],
        ]
        .map(String::clone),
    );
}

#[tokio::test]
async fn a_recent_dataset_a_source_lists_comes_back_as_its_listing() {
    let rig = Rig::listing(|data| {
        vec![Listing {
            url: dataset_url(data, "listed.zarr"),
            title: "Listed volume".into(),
            kind: ListingKind::Image,
            tiles: None,
            owner: None,
            date: None,
            group: Some(ListingGroup {
                id: "shelf:runs".into(),
                label: "runs".into(),
            }),
            fields: Vec::new(),
        }]
    })
    .await;
    let listed = rig.dataset("listed.zarr");
    let unlisted = rig.dataset("unlisted.zarr");

    let workspace = rig.new_workspace(SESSION).await;
    rig.open_datasets(SESSION, &workspace, &[listed.clone(), unlisted.clone()])
        .await;

    let recent = rig.recent(SESSION).await;
    assert_eq!(recent.len(), 2);
    assert_eq!(recent[0]["url"], unlisted.as_str());
    assert_eq!(recent[0]["name"], "unlisted.zarr");
    assert_eq!(recent[0]["listing"], Value::Null);
    assert_eq!(recent[1]["url"], listed.as_str());
    assert_eq!(recent[1]["name"], "listed.zarr");
    let listing = &recent[1]["listing"];
    assert_eq!(listing["url"], listed.as_str());
    assert_eq!(listing["title"], "Listed volume");
    assert_eq!(
        listing["group"],
        json!({ "id": "shelf:runs", "label": "runs", "noun": "Shelf" })
    );
}

#[tokio::test]
async fn two_people_never_see_each_others_recent_datasets() {
    let rig = Rig::start().await;
    let mine = rig.dataset("mine.zarr");
    let theirs = rig.dataset("theirs.zarr");

    let workspace = rig.new_workspace(SESSION).await;
    rig.open_datasets(SESSION, &workspace, std::slice::from_ref(&mine))
        .await;
    assert!(rig.recent(SOMEONE_ELSE).await.is_empty());

    let their_workspace = rig.new_workspace(SOMEONE_ELSE).await;
    rig.open_datasets(
        SOMEONE_ELSE,
        &their_workspace,
        std::slice::from_ref(&theirs),
    )
    .await;
    assert_eq!(rig.recent_urls(SESSION).await, [mine]);
    assert_eq!(rig.recent_urls(SOMEONE_ELSE).await, [theirs]);

    let response = reqwest::Client::new()
        .get(format!("http://{}/api/listings/recent", rig.address))
        .header("Accept", "application/json")
        .send()
        .await
        .unwrap();
    assert_eq!(
        response.status(),
        reqwest::StatusCode::UNAUTHORIZED,
        "nobody's recent datasets without a principal",
    );
}
