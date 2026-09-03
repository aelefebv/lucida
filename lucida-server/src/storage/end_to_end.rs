//! The whole server against one backend, twice over the same database.
//!
//! Every other test here asks whether a store answers correctly. This
//! one asks the question a deployer asks: does a connection string in
//! `LUCIDA_DB_URL` produce a server that signs people in, keeps what
//! they make, and still has it after a restart? Nothing below names a
//! backend type — it goes through [`super::open`] and the routers
//! `main` builds, so the answer is about the seam rather than about
//! PostgreSQL.
//!
//! **Restart is the reason there are two passes.** A process restart is
//! a second [`super::open`] against the same database: the first pass
//! writes through the HTTP surface, drops everything it built, and the
//! second reads it all back through a freshly built one. That is also
//! what proves the migrations are idempotent, since the second open
//! migrates a database the first one already did.
//!
//! It lives beside the backends rather than in `tests/` because it needs
//! [`test_support`](super::test_support), which is crate-private: a test
//! that reached for its own pool and its own migrator would stop being
//! evidence about how the server opens a database. Its counterpart is
//! `tests/storage_boot_e2e.rs`, which runs the server binary to cover
//! the boots that fail, and needs no database server to do it.

use std::sync::Arc;

use axum::Router;
use axum::body::{Body, to_bytes};
use axum::http::{Request, StatusCode, header};
use chrono::{Duration, Utc};
use lucida_core::saved_view::SavedView;
use serde_json::{Value, json};
use tower::ServiceExt as _;

use super::test_support::postgres_schema;
use super::{DatabaseUrl, StorageBackend};
use crate::ProxyConfig;
use crate::auth::{
    AuthConfig, AuthMode, BearerToken, CliTokenAuthorization, DualCredentialExtractor,
    LoginSession, PendingAuth, PrincipalExtractor, hash_bearer_token,
};
use crate::bookmarks::handlers::BookmarksState;
use crate::workspace::WorkspaceManager;

/// The signed-in operator every request below belongs to.
const EMAIL: &str = "operator@example.com";
/// The session id, which doubles as the cookie value.
const SESSION: &str = "session-across-the-restart";
/// The bearer token as a client sends it; the store keeps its hash.
const TOKEN: &str = "lucida_pat_across_the_restart";

/// The routers `main` puts behind the auth middleware, over one backend.
///
/// Both credential paths are live: the cookie extractor reads the
/// login-session store and the bearer extractor reads the bearer-token
/// store, which is the production wiring for `LUCIDA_AUTH=google`.
fn app_over(storage: &Arc<dyn StorageBackend>) -> Router {
    let config = Arc::new(AuthConfig {
        mode: AuthMode::Google,
        ..AuthConfig::for_tests()
    });
    let extractor: Arc<dyn PrincipalExtractor> = Arc::new(DualCredentialExtractor::new(
        config,
        storage.login_sessions(),
        storage.bearer_tokens(),
    ));

    let manager = Arc::new(WorkspaceManager::new(
        storage.workspaces(),
        ProxyConfig::defaults(),
    ));
    let bookmarks = BookmarksState {
        store: storage.bookmarks(),
        session: None,
        unicast_routes: None,
    };

    crate::workspace::router(manager)
        .merge(crate::bookmarks::routes::router(bookmarks))
        .layer(axum::middleware::from_fn_with_state(
            extractor,
            crate::auth::middleware::auth_middleware,
        ))
}

/// What a signed-in browser sends: the session cookie by itself.
fn as_browser(request: axum::http::request::Builder) -> axum::http::request::Builder {
    with_session(request, SESSION)
}

/// A session cookie naming `session`, under the name the extractor
/// reads from the same config, so the two cannot drift.
fn with_session(
    request: axum::http::request::Builder,
    session: &str,
) -> axum::http::request::Builder {
    let cookie = AuthConfig::for_tests().cookie_name;
    request.header(header::COOKIE, format!("{cookie}={session}"))
}

/// What the command-line client sends: a bearer token and no cookie.
fn as_cli(request: axum::http::request::Builder) -> axum::http::request::Builder {
    request.header(header::AUTHORIZATION, format!("Bearer {TOKEN}"))
}

/// Send `request` and return its status and decoded body. A body that
/// is not JSON is a failure worth seeing, so it panics with the text.
async fn send(app: &Router, request: Request<Body>) -> (StatusCode, Value) {
    let response = app
        .clone()
        .oneshot(request)
        .await
        .expect("the router answers");
    let status = response.status();
    let bytes = to_bytes(response.into_body(), 1024 * 1024).await.unwrap();
    if bytes.is_empty() {
        return (status, Value::Null);
    }
    let body = serde_json::from_slice(&bytes).unwrap_or_else(|e| {
        panic!(
            "{status} body is not JSON ({e}): {}",
            String::from_utf8_lossy(&bytes)
        )
    });
    (status, body)
}

/// A saved view with the fields the decoder requires and nothing more.
fn view() -> Value {
    json!({
        "v": 1,
        "camera": {"mode": "slice", "center": [0.0, 0.0], "zoom": 1.0, "viewport": [800, 600]},
        "view": {"z_range": {"start": 0, "end": 1}, "t": 0, "c": 0},
        "display": {"contrast_min": 0.0, "contrast_max": 65535.0, "gamma": 1.0}
    })
}

/// [`view`] as the store holds it: a `SavedView` decoded and encoded
/// again, which fills in the fields the request left to their defaults.
/// The store keeps the payload whole, so this is what has to come back —
/// asking for the request body verbatim would be asking the store to
/// undo a normalization it never did.
fn stored_view() -> Value {
    let decoded: SavedView =
        serde_json::from_value(view()).expect("the request body is a valid saved view");
    serde_json::to_value(decoded).expect("a saved view serializes")
}

#[tokio::test]
async fn the_application_runs_against_postgresql_and_survives_a_restart() {
    let Some(db) = postgres_schema().await else {
        return;
    };
    let written = write_everything(&db.url).await;
    read_everything_back(&db.url, &written).await;
}

/// What the first pass made, for the second pass to look for.
struct Written {
    workspace_id: String,
    saved_view_id: String,
    bookmark_id: String,
}

/// Bring a server up on `url` and use it the way a deployment's first
/// day does: sign in, make a Workspace, share it, save a view, keep a
/// bookmark, and authorize a command-line client.
async fn write_everything(url: &DatabaseUrl) -> Written {
    let storage = super::open(url)
        .await
        .expect("a postgres:// connection string brings a server up");
    let now = Utc::now();

    // Signing in is the OAuth callback's last act: a row in the
    // login-session store, keyed by the value it sets as the cookie.
    storage
        .login_sessions()
        .create(LoginSession {
            id: SESSION.to_string(),
            email: EMAIL.to_string(),
            display_name: "Operator".to_string(),
            picture_url: None,
            created_at: now,
            last_used_at: now,
            expires_at: now + Duration::hours(12),
        })
        .await
        .unwrap();
    storage
        .bearer_tokens()
        .create(BearerToken {
            id: "token-across-the-restart".to_string(),
            token_hash: hash_bearer_token(TOKEN),
            name: "workstation".to_string(),
            email: EMAIL.to_string(),
            display_name: "Operator".to_string(),
            picture_url: None,
            created_at: now,
            last_used_at: None,
            expires_at: now + Duration::days(30),
            revoked_at: None,
        })
        .await
        .unwrap();

    // The two stores with no HTTP surface of their own outside the
    // OAuth and device-authorization flows. Both are mid-flight state,
    // which is exactly the state a rolling restart interrupts, so both
    // are written here and completed on the far side.
    storage
        .pending_auth()
        .insert(PendingAuth {
            state_token: "state-across-the-restart".to_string(),
            intended_path: "/w/demo".to_string(),
            intended_hash: "#v=1".to_string(),
            created_at: now,
        })
        .await
        .unwrap();
    storage
        .cli_token_authorizations()
        .create(CliTokenAuthorization {
            id: "authorization-across-the-restart".to_string(),
            poll_token_hash: hash_bearer_token("poll-token"),
            token_hash: hash_bearer_token("cli-token"),
            user_code: "ABCD-EFGH".to_string(),
            name: "workstation".to_string(),
            created_at: now,
            expires_at: now + Duration::minutes(10),
            token_expires_at: now + Duration::days(30),
            approved_at: None,
            approved_token_id: None,
            approved_email: None,
        })
        .await
        .unwrap();

    let app = app_over(&storage);

    // Authentication, from the server's side: a cookie naming a session
    // the store has is a principal, and one it does not have is a 401.
    // The second half is what says the store was consulted at all.
    let (status, _) = send(
        &app,
        with_session(Request::builder().uri("/api/workspaces"), "never-signed-in")
            .body(Body::empty())
            .unwrap(),
    )
    .await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);

    let (status, workspace) = send(
        &app,
        as_browser(Request::builder().method("POST").uri("/api/workspaces"))
            .header(header::CONTENT_TYPE, "application/json")
            .body(Body::from(json!({"name": "Demo"}).to_string()))
            .unwrap(),
    )
    .await;
    assert_eq!(status, StatusCode::CREATED, "{workspace}");
    let workspace_id = workspace["id"]
        .as_str()
        .expect("a created Workspace has an id")
        .to_string();

    let (status, member) = send(
        &app,
        as_browser(
            Request::builder()
                .method("POST")
                .uri(format!("/api/workspaces/{workspace_id}/members")),
        )
        .header(header::CONTENT_TYPE, "application/json")
        .body(Body::from(
            json!({"email": "colleague@example.com", "role": "editor", "display_name": "Colleague"})
                .to_string(),
        ))
        .unwrap(),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{member}");

    let (status, saved_view) = send(
        &app,
        as_browser(
            Request::builder()
                .method("POST")
                .uri(format!("/api/workspaces/{workspace_id}/saved-views")),
        )
        .header(header::CONTENT_TYPE, "application/json")
        .body(Body::from(
            json!({"name": "Overview", "view": view()}).to_string(),
        ))
        .unwrap(),
    )
    .await;
    assert_eq!(status, StatusCode::CREATED, "{saved_view}");
    let saved_view_id = saved_view["id"]
        .as_str()
        .expect("a saved view has an id")
        .to_string();

    let (status, bookmark) = send(
        &app,
        as_browser(Request::builder().method("POST").uri("/api/bookmarks"))
            .header(header::CONTENT_TYPE, "application/json")
            .body(Body::from(
                json!({
                    "name": "Where I left off",
                    "datasets": ["file:///data/demo.zarr"],
                    "view": view(),
                })
                .to_string(),
            ))
            .unwrap(),
    )
    .await;
    assert_eq!(status, StatusCode::CREATED, "{bookmark}");
    let bookmark_id = bookmark["id"]
        .as_str()
        .expect("a bookmark has an id")
        .to_string();

    // The other credential: a bearer token reaches the same Workspace,
    // which is the command-line client's whole path in.
    let (status, listed) = send(
        &app,
        as_cli(Request::builder().uri("/api/workspaces"))
            .body(Body::empty())
            .unwrap(),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{listed}");
    assert_eq!(listed[0]["id"], workspace_id.as_str());

    Written {
        workspace_id,
        saved_view_id,
        bookmark_id,
    }
}

/// Restart: a second backend over the same database, a second app over
/// that, and everything the first pass made still where it was left.
async fn read_everything_back(url: &DatabaseUrl, written: &Written) {
    let storage = super::open(url)
        .await
        .expect("reopening a migrated database is what every restart does");
    let app = app_over(&storage);
    let Written {
        workspace_id,
        saved_view_id,
        bookmark_id,
    } = written;

    // Still signed in: the cookie from before the restart resolves to a
    // principal, because the session row outlived the process.
    let (status, listed) = send(
        &app,
        as_browser(Request::builder().uri("/api/workspaces"))
            .body(Body::empty())
            .unwrap(),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{listed}");
    assert_eq!(listed[0]["id"], workspace_id.as_str());
    assert_eq!(listed[0]["name"], "Demo");
    assert_eq!(listed[0]["role"], "owner");

    let (status, sharing) = send(
        &app,
        as_browser(Request::builder().uri(format!("/api/workspaces/{workspace_id}/sharing")))
            .body(Body::empty())
            .unwrap(),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{sharing}");
    let members = sharing["members"]
        .as_array()
        .expect("sharing lists members");
    let colleague = members
        .iter()
        .find(|m| m["email"] == "colleague@example.com")
        .unwrap_or_else(|| panic!("the member added before the restart is gone: {sharing}"));
    assert_eq!(colleague["role"], "editor");
    assert_eq!(colleague["display_name"], "Colleague");

    let (status, saved_views) = send(
        &app,
        as_browser(Request::builder().uri(format!("/api/workspaces/{workspace_id}/saved-views")))
            .body(Body::empty())
            .unwrap(),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{saved_views}");
    assert_eq!(saved_views[0]["id"], saved_view_id.as_str());
    assert_eq!(saved_views[0]["name"], "Overview");
    assert_eq!(
        saved_views[0]["view"],
        stored_view(),
        "a saved view comes back the way it went in"
    );

    let (status, bookmarks) = send(
        &app,
        as_browser(Request::builder().uri("/api/bookmarks"))
            .body(Body::empty())
            .unwrap(),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{bookmarks}");
    assert_eq!(bookmarks[0]["id"], bookmark_id.as_str());
    assert_eq!(bookmarks[0]["name"], "Where I left off");
    assert_eq!(bookmarks[0]["datasets"][0], "file:///data/demo.zarr");

    // The bearer token outlived the process too.
    let (status, listed) = send(
        &app,
        as_cli(Request::builder().uri("/api/workspaces"))
            .body(Body::empty())
            .unwrap(),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{listed}");

    // And the two mid-flight rows complete on the far side of the
    // restart, which is the whole point of storing them rather than
    // holding them in memory.
    let pending = storage
        .pending_auth()
        .consume("state-across-the-restart")
        .await
        .unwrap()
        .expect("an in-flight sign-in survives the restart it was interrupted by");
    assert_eq!(pending.intended_path, "/w/demo");
    assert_eq!(pending.intended_hash, "#v=1");

    let authorization = storage
        .cli_token_authorizations()
        .get_for_poll(
            "authorization-across-the-restart",
            &hash_bearer_token("poll-token"),
        )
        .await
        .unwrap()
        .expect("a command-line client keeps polling across the restart");
    assert_eq!(authorization.user_code, "ABCD-EFGH");
}
