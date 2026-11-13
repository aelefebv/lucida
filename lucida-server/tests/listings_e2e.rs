//! Search and resolve over HTTP, end to end: listings from a source, through
//! the index and the real auth middleware, out of the routes a client calls.
//!
//! Most cases list from a fake source, so each states exactly what exists.
//! The data-root cases walk `fixtures/ome-zarr` on disk with the source a
//! server builds from its configuration.

use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use axum::Router;
use chrono::{DateTime, Duration, TimeZone, Utc};
use serde_json::{Value, json};

use lucida_content::url::DatasetLocation;
use lucida_server::GeneratedConfig;
use lucida_server::auth::{
    AuthConfig, AuthMode, BearerToken, BearerTokenStore, DualCredentialExtractor,
    LoginSessionStore, MemoryBearerTokenStore, MemorySessionStore, PrincipalExtractor,
    hash_bearer_token,
};
use lucida_server::listings::{
    self, DatasetSource, Listing, ListingField, ListingGroup, ListingKind, ListingsIndex,
    SourceContext, SourceError,
};
use lucida_server::storage::{self, DatabaseUrl};
use lucida_server::workspace::WorkspaceManager;
use lucida_store::source_policy::{SourcePolicy, SourcePolicyConfig};

const RAW_TOKEN: &str = "lucida_pat_listings_e2e";

/// A source that offers whatever a test hands it, or fails.
struct FakeSource {
    offer: Mutex<Result<Vec<Listing>, String>>,
}

impl FakeSource {
    fn new(listings: Vec<Listing>) -> Arc<Self> {
        Arc::new(Self {
            offer: Mutex::new(Ok(listings)),
        })
    }

    fn offer(&self, offer: Result<Vec<Listing>, String>) {
        *self.offer.lock().unwrap() = offer;
    }
}

#[async_trait::async_trait]
impl DatasetSource for FakeSource {
    fn group_noun(&self) -> &str {
        "Shelf"
    }

    async fn listings(&self) -> Result<Vec<Listing>, SourceError> {
        self.offer.lock().unwrap().clone().map_err(Into::into)
    }
}

fn day(n: i64) -> DateTime<Utc> {
    Utc.with_ymd_and_hms(2026, 1, 1, 0, 0, 0).unwrap() + Duration::days(n)
}

fn listing(url: &str, title: &str, group: Option<&str>, date: i64) -> Listing {
    Listing {
        url: url.to_string(),
        title: title.to_string(),
        kind: ListingKind::Image,
        tiles: None,
        owner: None,
        date: Some(day(date)),
        group: group.map(|label| ListingGroup {
            id: format!("shelf:{label}"),
            label: label.to_string(),
        }),
        fields: Vec::new(),
    }
}

/// A live server with the listings routes behind the auth middleware.
struct Rig {
    address: std::net::SocketAddr,
    index: Arc<ListingsIndex>,
    server: tokio::task::JoinHandle<()>,
}

impl Drop for Rig {
    fn drop(&mut self) {
        self.server.abort();
    }
}

impl Rig {
    /// A server over `sources`, refreshed once.
    async fn start(sources: Vec<Arc<dyn DatasetSource>>, policy: SourcePolicy) -> Self {
        let index = Arc::new(ListingsIndex::new(sources, Arc::new(policy)));
        index.refresh().await;
        let storage = storage::open(&DatabaseUrl::in_memory()).await.unwrap();
        let workspaces = Arc::new(WorkspaceManager::new(
            storage.workspaces(),
            GeneratedConfig::defaults(),
        ));
        let app: Router = listings::router(Arc::clone(&index), workspaces).layer(
            axum::middleware::from_fn_with_state(
                bearer_extractor().await,
                lucida_server::auth::middleware::auth_middleware,
            ),
        );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            axum::serve(listener, app).await.unwrap();
        });
        Self {
            address,
            index,
            server,
        }
    }

    async fn with(source: Arc<FakeSource>) -> Self {
        Self::start(vec![source], SourcePolicy::unrestricted()).await
    }

    async fn get(&self, path: &str, query: &[(&str, &str)]) -> reqwest::Response {
        let query: Vec<String> = query
            .iter()
            .map(|(key, value)| format!("{key}={}", urlencoding::encode(value)))
            .collect();
        reqwest::Client::new()
            .get(format!("http://{}{path}?{}", self.address, query.join("&")))
            .bearer_auth(RAW_TOKEN)
            .send()
            .await
            .unwrap()
    }

    async fn ok(&self, path: &str, query: &[(&str, &str)]) -> Value {
        let response = self.get(path, query).await;
        assert_eq!(response.status(), reqwest::StatusCode::OK);
        response.json().await.unwrap()
    }

    async fn search(&self, q: &str) -> Value {
        self.ok("/api/listings", &[("q", q)]).await
    }

    async fn resolve(&self, url: &str) -> Value {
        self.ok("/api/listings/resolve", &[("url", url)]).await["listing"].clone()
    }
}

/// The principal extractor the real server runs, holding one token.
async fn bearer_extractor() -> Arc<dyn PrincipalExtractor> {
    let now = Utc::now();
    let tokens = Arc::new(MemoryBearerTokenStore::new());
    tokens
        .create(BearerToken {
            id: "listings-e2e".into(),
            token_hash: hash_bearer_token(RAW_TOKEN),
            name: "listings e2e".into(),
            email: "viewer@example.com".into(),
            display_name: "Viewer".into(),
            picture_url: None,
            created_at: now,
            last_used_at: None,
            expires_at: now + Duration::hours(1),
            revoked_at: None,
        })
        .await
        .unwrap();
    let mut config = AuthConfig::for_tests();
    config.mode = AuthMode::Google;
    Arc::new(DualCredentialExtractor::new(
        Arc::new(config),
        Arc::new(MemorySessionStore::new()) as Arc<dyn LoginSessionStore>,
        tokens as Arc<dyn BearerTokenStore>,
    ))
}

/// Each result as its group's label (`-` for none) and its listings' titles.
fn shape(page: &Value) -> Vec<(String, Vec<String>)> {
    page["results"]
        .as_array()
        .unwrap()
        .iter()
        .map(|result| {
            let label = result["group"]["label"].as_str().unwrap_or("-").to_string();
            let titles = result["listings"]
                .as_array()
                .unwrap()
                .iter()
                .map(|l| l["title"].as_str().unwrap().to_string())
                .collect();
            (label, titles)
        })
        .collect()
}

fn titles(page: &Value) -> Vec<String> {
    shape(page).into_iter().flat_map(|(_, t)| t).collect()
}

fn owned(rows: &[(&str, &[&str])]) -> Vec<(String, Vec<String>)> {
    rows.iter()
        .map(|(label, titles)| {
            (
                label.to_string(),
                titles.iter().map(|t| t.to_string()).collect(),
            )
        })
        .collect()
}

#[tokio::test]
async fn a_search_with_no_query_returns_every_listing_grouped_newest_first() {
    let mut tiles = listing("/data/beta/tiles.zarr", "tiles", Some("beta"), 5);
    tiles.kind = ListingKind::Collection;
    tiles.tiles = Some(12);
    tiles.owner = Some("someone@example.com".into());
    tiles.fields = vec![ListingField {
        name: "Size".into(),
        value: "large".into(),
    }];
    let rig = Rig::with(FakeSource::new(vec![
        listing("/data/alpha/old.zarr", "old", Some("alpha"), 1),
        listing("/data/alpha/new.zarr", "new", Some("alpha"), 3),
        tiles,
        listing("/data/loose.zarr", "loose", None, 2),
    ]))
    .await;

    let page = rig.search("").await;
    assert_eq!(
        shape(&page),
        owned(&[
            ("beta", &["tiles"]),
            ("alpha", &["new", "old"]),
            ("-", &["loose"]),
        ])
    );
    assert_eq!(page["next_cursor"], Value::Null);
    let beta = &page["results"][0];
    assert_eq!(beta["collapsed"], false);
    assert_eq!(
        beta["group"],
        json!({"id": "shelf:beta", "label": "beta", "noun": "Shelf"})
    );
    assert_eq!(
        beta["listings"][0],
        json!({
            "url": "/data/beta/tiles.zarr",
            "title": "tiles",
            "kind": "collection",
            "tiles": 12,
            "owner": "someone@example.com",
            "date": "2026-01-06T00:00:00Z",
            "group": {"id": "shelf:beta", "label": "beta", "noun": "Shelf"},
            "fields": [{"name": "Size", "value": "large"}],
        })
    );
    assert_eq!(page["results"][2]["group"], Value::Null);
}

#[tokio::test]
async fn every_word_must_match_and_case_does_not_matter() {
    let mut labelled = listing("/srv/archive/alpha/x/one.zarr", "Bright Volume", None, 1);
    labelled.fields = vec![ListingField {
        name: "Note".into(),
        value: "Night Shift".into(),
    }];
    let rig = Rig::with(FakeSource::new(vec![
        labelled,
        listing("/srv/archive/alpha/x/two.zarr", "Dim Volume", None, 2),
    ]))
    .await;

    assert_eq!(
        titles(&rig.search("VOLUME bright").await),
        ["Bright Volume"]
    );
    assert_eq!(
        titles(&rig.search("volume").await),
        ["Dim Volume", "Bright Volume"]
    );
    assert!(titles(&rig.search("volume missing").await).is_empty());
    // A field value matches, and so do the URL's last segments.
    assert_eq!(titles(&rig.search("night").await), ["Bright Volume"]);
    assert_eq!(titles(&rig.search("two.zarr").await), ["Dim Volume"]);
    assert_eq!(titles(&rig.search("alpha").await).len(), 2);
    // The leading segments every listing shares narrow nothing.
    assert!(titles(&rig.search("archive").await).is_empty());
}

#[tokio::test]
async fn a_group_whose_label_matches_comes_back_whole_and_collapsed() {
    let rig = Rig::with(FakeSource::new(vec![
        listing("/data/night/a.zarr", "a", Some("Night runs"), 1),
        listing("/data/night/b.zarr", "b", Some("Night runs"), 2),
        listing("/data/day/sky.zarr", "night sky", Some("day"), 3),
        listing("/data/day/sun.zarr", "sun", Some("day"), 4),
    ]))
    .await;

    let page = rig.search("night").await;
    assert_eq!(
        shape(&page),
        owned(&[("day", &["night sky"]), ("Night runs", &["b", "a"])])
    );
    assert_eq!(page["results"][0]["collapsed"], false);
    assert_eq!(page["results"][1]["collapsed"], true);
}

#[tokio::test]
async fn groups_are_ordered_by_their_newest_matching_listing() {
    let rig = Rig::with(FakeSource::new(vec![
        listing("/data/a/keep.zarr", "keep one", Some("a"), 1),
        listing("/data/a/other.zarr", "other", Some("a"), 9),
        listing("/data/b/keep.zarr", "keep two", Some("b"), 5),
    ]))
    .await;
    assert_eq!(
        shape(&rig.search("keep").await),
        owned(&[("b", &["keep two"]), ("a", &["keep one"])])
    );
}

#[tokio::test]
async fn a_cursor_pages_through_every_result_once() {
    // One group larger than a page, then six that fill pages of 200.
    let mut offered: Vec<Listing> = (0..250)
        .map(|i| listing(&format!("/data/big/{i}.zarr"), "x", Some("big"), 100))
        .collect();
    for g in 0..6 {
        let label = format!("g{g}");
        offered.extend((0..50).map(|i| {
            listing(
                &format!("/data/{label}/{i}.zarr"),
                "x",
                Some(&label),
                50 - g,
            )
        }));
    }
    let source = FakeSource::new(offered.clone());
    let rig = Rig::with(Arc::clone(&source)).await;

    let labels =
        |page: &Value| -> Vec<String> { shape(page).into_iter().map(|(l, _)| l).collect() };
    let first = rig.search("").await;
    assert_eq!(labels(&first), ["big"]);
    assert_eq!(
        first["results"][0]["listings"].as_array().unwrap().len(),
        250
    );

    // A newer group arriving between pages sorts before the cursor, so the
    // pages after it neither repeat nor skip a group.
    offered.push(listing("/data/fresh/a.zarr", "x", Some("fresh"), 200));
    source.offer(Ok(offered));
    rig.index.refresh().await;

    let cursor = first["next_cursor"].as_str().unwrap();
    let second = rig.ok("/api/listings", &[("cursor", cursor)]).await;
    assert_eq!(labels(&second), ["g0", "g1", "g2", "g3"]);
    let cursor = second["next_cursor"].as_str().unwrap();
    let third = rig.ok("/api/listings", &[("cursor", cursor)]).await;
    assert_eq!(labels(&third), ["g4", "g5"]);
    assert_eq!(third["next_cursor"], Value::Null);
}

#[tokio::test]
async fn a_cursor_this_server_did_not_return_is_refused() {
    let rig = Rig::with(FakeSource::new(Vec::new())).await;
    let response = rig
        .get("/api/listings", &[("q", "a"), ("cursor", "not-a-cursor")])
        .await;
    assert_eq!(response.status(), reqwest::StatusCode::BAD_REQUEST);
    let body: Value = response.json().await.unwrap();
    assert_eq!(body["error"], "bad_request");
}

#[tokio::test]
async fn resolve_returns_the_listing_for_a_known_url_and_nothing_for_an_unknown_one() {
    let rig = Rig::with(FakeSource::new(vec![listing(
        "/data/alpha/one.zarr",
        "one",
        Some("alpha"),
        1,
    )]))
    .await;

    let found = rig.resolve("/data/alpha/one.zarr").await;
    assert_eq!(found["title"], "one");
    assert_eq!(
        found["group"],
        json!({"id": "shelf:alpha", "label": "alpha", "noun": "Shelf"})
    );
    // Any spelling of the same location resolves.
    for spelling in ["file:///data/alpha/one.zarr", "/data/alpha/one.zarr/"] {
        assert_eq!(rig.resolve(spelling).await["title"], "one", "{spelling}");
    }
    for unknown in ["/data/alpha/two.zarr", "relative/one.zarr", ""] {
        assert_eq!(rig.resolve(unknown).await, Value::Null, "{unknown}");
    }

    let missing = rig.get("/api/listings/resolve", &[]).await;
    assert_eq!(missing.status(), reqwest::StatusCode::BAD_REQUEST);
}

#[tokio::test]
async fn a_listing_the_source_policy_refuses_never_appears() {
    let tmp = tempfile::tempdir().unwrap();
    let root = tmp.path().join("root");
    let inside = root.join("in.zarr");
    let outside = tmp.path().join("elsewhere").join("out.zarr");
    std::fs::create_dir_all(&inside).unwrap();
    std::fs::create_dir_all(&outside).unwrap();
    let policy = SourcePolicy::new(SourcePolicyConfig {
        restricted: true,
        data_roots: vec![root.clone()],
        ..Default::default()
    })
    .unwrap();
    let text = |path: &Path| path.to_str().unwrap().to_string();
    let rig = Rig::start(
        vec![FakeSource::new(vec![
            listing(&text(&inside), "inside", None, 1),
            listing(&text(&outside), "outside", None, 2),
            listing("http://127.0.0.1:9/private.zarr", "private host", None, 3),
            listing("not a location", "unparsed", None, 4),
            listing("gs://bucket/public.zarr", "bucket", None, 5),
        ])],
        policy,
    )
    .await;

    assert_eq!(titles(&rig.search("").await), ["bucket", "inside"]);
    assert_eq!(rig.resolve(&text(&outside)).await, Value::Null);
    assert_eq!(
        rig.resolve(&text(&inside)).await["url"],
        DatasetLocation::parse(&text(&inside)).unwrap().as_str()
    );
}

#[tokio::test]
async fn a_bucket_root_admits_its_listings_past_the_bucket_allowlist() {
    let policy = SourcePolicy::new(SourcePolicyConfig {
        restricted: true,
        bucket_roots: vec!["gs://shared/images".into()],
        allowed_buckets: vec!["gs://team-data".into()],
        ..Default::default()
    })
    .unwrap();
    let rig = Rig::start(
        vec![FakeSource::new(vec![
            listing("gs://shared/images/runs/a.zarr", "under the root", None, 1),
            listing("gs://shared/other/b.zarr", "beside the root", None, 2),
            listing("gs://team-data/c.zarr", "allowlisted", None, 3),
            listing("gs://elsewhere/d.zarr", "elsewhere", None, 4),
        ])],
        policy,
    )
    .await;

    assert_eq!(
        titles(&rig.search("").await),
        ["allowlisted", "under the root"]
    );
    assert_eq!(
        rig.resolve("GS://shared/images/runs/a.zarr/").await["title"],
        "under the root"
    );
    assert_eq!(rig.resolve("gs://shared/other/b.zarr").await, Value::Null);
}

#[tokio::test]
async fn a_failed_refresh_keeps_what_the_source_offered_last() {
    let source = FakeSource::new(vec![listing("/data/a.zarr", "a", None, 1)]);
    let rig = Rig::with(Arc::clone(&source)).await;

    source.offer(Err("unreachable".into()));
    rig.index.refresh().await;
    assert_eq!(titles(&rig.search("").await), ["a"]);

    source.offer(Ok(vec![
        listing("/data/a.zarr", "a", None, 1),
        listing("/data/b.zarr", "b", None, 2),
    ]));
    rig.index.refresh().await;
    assert_eq!(titles(&rig.search("").await), ["b", "a"]);
}

#[tokio::test]
async fn a_request_without_a_principal_is_refused() {
    let rig = Rig::with(FakeSource::new(Vec::new())).await;
    let response = reqwest::Client::new()
        .get(format!("http://{}/api/listings", rig.address))
        .header("Accept", "application/json")
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), reqwest::StatusCode::UNAUTHORIZED);
}

/// The source a server builds from its configuration, over the data roots
/// `policy` holds.
async fn configured_rig(policy: SourcePolicy) -> Rig {
    let policy = Arc::new(policy);
    let sources = listings::configured(&SourceContext {
        policy: Arc::clone(&policy),
    })
    .await;
    Rig::start(sources, (*policy).clone()).await
}

#[tokio::test]
async fn with_no_data_roots_search_returns_nothing() {
    for restricted in [false, true] {
        let rig = configured_rig(
            SourcePolicy::new(SourcePolicyConfig {
                restricted,
                ..Default::default()
            })
            .unwrap(),
        )
        .await;
        assert_eq!(rig.index.source_count(), 0);
        assert_eq!(
            rig.search("").await,
            json!({"results": [], "next_cursor": null})
        );
    }
}

fn fixtures() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .unwrap()
        .join("fixtures")
        .join("ome-zarr")
}

#[tokio::test]
async fn the_data_roots_list_every_dataset_on_disk() {
    let rig = configured_rig(
        SourcePolicy::new(SourcePolicyConfig {
            restricted: true,
            data_roots: vec![fixtures()],
            ..Default::default()
        })
        .unwrap(),
    )
    .await;

    let page = rig.search("").await;
    let results = page["results"].as_array().unwrap();
    assert_eq!(results.len(), 1, "every fixture sits in one folder");
    assert_eq!(results[0]["group"]["label"], "ome-zarr");
    assert_eq!(results[0]["group"]["noun"], "Folder");
    let mut kinds: Vec<(String, String)> = results[0]["listings"]
        .as_array()
        .unwrap()
        .iter()
        .map(|l| {
            assert!(l["date"].is_string(), "{l}");
            assert_eq!(l["owner"], Value::Null);
            let url = l["url"].as_str().unwrap();
            // The walk stopped at each store's root.
            assert!(url.ends_with(".ome.zarr"), "{url}");
            let kind = l["kind"].as_str().unwrap().to_string();
            (l["title"].as_str().unwrap().to_string(), kind)
        })
        .collect();
    kinds.sort();
    let collections = [
        "collection-mixed.ome.zarr",
        "collection-unsharded.ome.zarr",
        "v2-collection.ome.zarr",
        "v2-consolidated.ome.zarr",
        "v3-consolidated.ome.zarr",
    ];
    let mut expected: Vec<(String, String)> = std::fs::read_dir(fixtures())
        .unwrap()
        .map(|entry| entry.unwrap().file_name().to_string_lossy().to_string())
        .filter(|name| name.ends_with(".ome.zarr"))
        .map(|name| {
            let kind = if collections.contains(&name.as_str()) {
                "collection"
            } else {
                "image"
            };
            (name, kind.to_string())
        })
        .collect();
    expected.sort();
    assert_eq!(kinds, expected);
    assert!(kinds.iter().any(|(name, _)| name == "v2-twin.ome.zarr"));

    assert_eq!(
        titles(&rig.search("V2 collection").await),
        ["v2-collection.ome.zarr"]
    );
}
