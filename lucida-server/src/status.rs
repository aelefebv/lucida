//! An opt-in status route that tells an external monitor whether the
//! storage backend answers.
//!
//! `/healthz` and `/readyz` say whether this process is alive and ready.
//! Neither says whether the database behind it can be reached, and an
//! external monitor that shows each service's dependencies side by side
//! has nowhere to read that from. This route is that place: one trivial
//! query through the [`StorageBackend`] the server already holds, under
//! a short timeout, rendered in one fixed JSON shape:
//!
//! ```json
//! {"details": {"dependencies": {"database": [
//!   {"resource_name": "lucida.db", "connected": true, "message": "Success"}
//! ]}}}
//! ```
//!
//! Three things about it are deliberate, and ADR-0064 says why:
//!
//! - **Off unless `LUCIDA_STATUS_PATH` is set.** A deployment that never
//!   configures it exposes nothing new.
//! - **Always `200 OK`.** The external monitor reads a non-200 as "could
//!   not read the status" and `connected: false` as "the dependency is
//!   down". An outage reported as a 503 would show as the wrong one.
//! - **The body carries a resource name, a flag, and a fixed message,
//!   and nothing else.** The resource name defaults to the database
//!   name alone, so the route can sit on the public router half and
//!   never show a host or a credential.
//!
//! Configuration follows the `LUCIDA_*` contract of ADR-0017 and reads
//! the way the profile directory of ADR-0063 does: a blank path is the
//! same as an unset one, and nothing else is read; a label or resource
//! name that is present and blank is refused at boot, because a
//! template that rendered nothing into it is a mistake worth reporting.
//!
//! ## Auth interaction
//!
//! Mounts on the public router half beside the probes in
//! [`crate::health`], for the same reason they do: an external monitor
//! has no session.

use std::sync::Arc;
use std::time::{Duration, Instant};

use axum::Json;
use axum::Router;
use axum::extract::State;
use axum::routing::get;
use serde_json::{Value, json};

use crate::storage::{DatabaseUrl, StorageBackend};

const PATH_VAR: &str = "LUCIDA_STATUS_PATH";
const LABEL_VAR: &str = "LUCIDA_STATUS_LABEL";
const RESOURCE_NAME_VAR: &str = "LUCIDA_STATUS_RESOURCE_NAME";
const DEFAULT_LABEL: &str = "database";

/// Shorter than either backend's pool acquire deadline, so this timeout,
/// not the pool's, decides when a hung database is reported.
const QUERY_TIMEOUT: Duration = Duration::from_secs(2);

/// Why the route's configuration was refused. Each variant names the
/// variable, because the operator sees this with no other context than
/// a server that did not start.
#[derive(Debug, thiserror::Error, PartialEq, Eq)]
pub enum StatusRouteConfigError {
    #[error(
        "{}={value:?} must start with a slash, for example `/status`",
        PATH_VAR
    )]
    PathWithoutLeadingSlash { value: String },
    /// Refused here rather than left for the router, which would panic
    /// with a message that names neither the variable nor the value.
    #[error(
        "{}={value:?} must not contain whitespace, `?`, `#`, `{{`, or `}}`",
        PATH_VAR
    )]
    PathNotRoutable { value: String },
    /// The probes this route mounts beside are the collision an operator
    /// is most likely to type. Any other collision surfaces as the
    /// router's own refusal at boot, which names the path.
    #[error("{}={value:?} is a path the server already answers on", PATH_VAR)]
    PathTaken { value: String },
    /// A variable with a default is present but blank. The default
    /// applies when the variable is absent; one that is set and blank is
    /// a deployment template that rendered nothing into it.
    #[error("{variable} is set but blank (unset it for the default, or set a value)")]
    Blank { variable: &'static str },
    /// The connection string names no database, so there is no name that
    /// is safe to show by default, and the operator has to choose one.
    #[error(
        "LUCIDA_DB_URL names no database, so {} must be set",
        RESOURCE_NAME_VAR
    )]
    NoDatabaseName,
}

/// What the route answers on and what it says. Present only when
/// [`PATH_VAR`] is set; see [`StatusRouteConfig::from_env`].
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StatusRouteConfig {
    /// Where the route mounts. Starts with a slash.
    pub path: String,
    /// The key under `dependencies` the backend is listed under.
    pub label: String,
    /// The `resource_name` in the body. Never derived from anything but
    /// the database name unless the operator set it.
    pub resource_name: String,
}

impl StatusRouteConfig {
    /// Read the `LUCIDA_STATUS_*` variables from the process
    /// environment. `Ok(None)` means the route is off.
    pub fn from_env(db_url: &DatabaseUrl) -> Result<Option<Self>, StatusRouteConfigError> {
        Self::from_env_map(|name| std::env::var(name).ok(), db_url)
    }

    /// [`Self::from_env`] over any reader, so tests can cover every
    /// permutation without touching process state. `db_url` supplies
    /// the default resource name.
    pub fn from_env_map<F>(
        read: F,
        db_url: &DatabaseUrl,
    ) -> Result<Option<Self>, StatusRouteConfigError>
    where
        F: Fn(&str) -> Option<String>,
    {
        let Some(path) = read(PATH_VAR)
            .map(|raw| raw.trim().to_string())
            .filter(|path| !path.is_empty())
        else {
            return Ok(None);
        };
        if !path.starts_with('/') {
            return Err(StatusRouteConfigError::PathWithoutLeadingSlash { value: path });
        }
        if path
            .chars()
            .any(|c| c.is_whitespace() || matches!(c, '?' | '#' | '{' | '}'))
        {
            return Err(StatusRouteConfigError::PathNotRoutable { value: path });
        }
        if crate::health::PATHS.contains(&path.as_str()) {
            return Err(StatusRouteConfigError::PathTaken { value: path });
        }

        let label = set_or_absent(&read, LABEL_VAR)?.unwrap_or_else(|| DEFAULT_LABEL.to_string());
        let resource_name = match set_or_absent(&read, RESOURCE_NAME_VAR)? {
            Some(name) => name,
            None => db_url
                .database_name()
                .ok_or(StatusRouteConfigError::NoDatabaseName)?,
        };

        Ok(Some(Self {
            path,
            label,
            resource_name,
        }))
    }
}

fn set_or_absent<F>(
    read: &F,
    variable: &'static str,
) -> Result<Option<String>, StatusRouteConfigError>
where
    F: Fn(&str) -> Option<String>,
{
    let Some(raw) = read(variable) else {
        return Ok(None);
    };
    let value = raw.trim();
    if value.is_empty() {
        return Err(StatusRouteConfigError::Blank { variable });
    }
    Ok(Some(value.to_string()))
}

#[derive(Clone)]
struct StatusState {
    config: Arc<StatusRouteConfig>,
    backend: Arc<dyn StorageBackend>,
}

/// The status route, or an empty router when `config` is `None`.
///
/// Taking the `Option` keeps "unset means off" in one place: the caller
/// merges whatever comes back and cannot mount the route by mistake.
/// Merge the result into the **public** router half.
pub fn router(config: Option<StatusRouteConfig>, backend: Arc<dyn StorageBackend>) -> Router {
    let Some(config) = config else {
        return Router::new();
    };
    let path = config.path.clone();
    Router::new()
        .route(&path, get(status))
        .with_state(StatusState {
            config: Arc::new(config),
            backend,
        })
}

/// Logs at debug level only: an external monitor polls every few
/// seconds, and an outage would otherwise fill the log.
async fn status(State(state): State<StatusState>) -> Json<Value> {
    let started = Instant::now();
    let connected = match tokio::time::timeout(QUERY_TIMEOUT, state.backend.ping()).await {
        Ok(Ok(())) => true,
        Ok(Err(e)) => {
            tracing::debug!(error = %e, "status.backend_unreachable");
            false
        }
        Err(_) => {
            tracing::debug!(timeout = ?QUERY_TIMEOUT, "status.backend_timed_out");
            false
        }
    };
    tracing::debug!(connected, elapsed = ?started.elapsed(), "status.checked");

    let message = if connected { "Success" } else { "Failure" };
    Json(json!({
        "details": {
            "dependencies": {
                state.config.label.as_str(): [
                    {
                        "resource_name": state.config.resource_name,
                        "connected": connected,
                        "message": message,
                    }
                ]
            }
        }
    }))
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;
    use std::time::Duration;

    use axum::Router;
    use axum::body::{Body, to_bytes};
    use axum::http::{Request, StatusCode, header};
    use serde_json::{Value, json};
    use tower::ServiceExt as _;

    use super::*;
    use crate::health;
    use crate::storage::test_support::{postgres_backend, sqlite_backend};
    use crate::storage::{DatabaseUrl, Scheme, StorageBackend};

    fn reader(vars: &[(&str, &str)]) -> impl Fn(&str) -> Option<String> {
        let vars: Vec<(String, String)> = vars
            .iter()
            .map(|(name, value)| (name.to_string(), value.to_string()))
            .collect();
        move |name| {
            vars.iter()
                .find(|(candidate, _)| candidate == name)
                .map(|(_, value)| value.clone())
        }
    }

    fn sqlite_url() -> DatabaseUrl {
        DatabaseUrl::parse("sqlite://lucida.db").unwrap()
    }

    fn configured(vars: &[(&str, &str)], db_url: &DatabaseUrl) -> StatusRouteConfig {
        StatusRouteConfig::from_env_map(reader(vars), db_url)
            .expect("the variables parse")
            .expect("a path is set, so the route is on")
    }

    /// Without the SPA fallback that `main` merges after these. It
    /// answers every unknown path with HTML, and these cases need an
    /// unmounted path to be a plain 404.
    fn public_half(config: Option<StatusRouteConfig>, backend: Arc<dyn StorageBackend>) -> Router {
        health::router().merge(router(config, backend))
    }

    async fn working_backend(scheme: Scheme) -> Option<Arc<dyn StorageBackend>> {
        match scheme {
            Scheme::Sqlite => Some(Arc::new(sqlite_backend().await)),
            Scheme::Postgres => postgres_backend()
                .await
                .map(|db| Arc::new(db.backend) as Arc<dyn StorageBackend>),
        }
    }

    async fn get(app: &Router, path: &str) -> (StatusCode, Option<String>, String) {
        let response = app
            .clone()
            .oneshot(Request::builder().uri(path).body(Body::empty()).unwrap())
            .await
            .unwrap();
        let status = response.status();
        let content_type = response
            .headers()
            .get(header::CONTENT_TYPE)
            .map(|v| v.to_str().unwrap().to_string());
        let bytes = to_bytes(response.into_body(), 64 * 1024).await.unwrap();
        (
            status,
            content_type,
            String::from_utf8(bytes.to_vec()).unwrap(),
        )
    }

    async fn get_json(app: &Router, path: &str) -> (StatusCode, Value) {
        let (status, content_type, text) = get(app, path).await;
        assert_eq!(content_type.as_deref(), Some("application/json"), "{text}");
        let body = serde_json::from_str(&text).unwrap_or_else(|e| panic!("not JSON ({e}): {text}"));
        (status, body)
    }

    // -- configuration --------------------------------------------------

    #[test]
    fn an_unset_or_blank_path_leaves_the_route_off() {
        for vars in [
            vec![],
            vec![("LUCIDA_STATUS_PATH", "")],
            vec![("LUCIDA_STATUS_PATH", "  ")],
        ] {
            let parsed = StatusRouteConfig::from_env_map(reader(&vars), &sqlite_url())
                .expect("off is not an error");
            assert!(parsed.is_none(), "{vars:?}");
        }
    }

    /// A template that leaves the path empty must not fail on a label
    /// nothing will render.
    #[test]
    fn with_the_route_off_the_other_variables_are_not_read() {
        let parsed = StatusRouteConfig::from_env_map(
            reader(&[
                ("LUCIDA_STATUS_PATH", ""),
                ("LUCIDA_STATUS_LABEL", ""),
                ("LUCIDA_STATUS_RESOURCE_NAME", ""),
            ]),
            &sqlite_url(),
        )
        .expect("nothing past a blank path is read");
        assert!(parsed.is_none());
    }

    #[test]
    fn a_path_alone_turns_the_route_on_with_documented_defaults() {
        let config = configured(&[("LUCIDA_STATUS_PATH", "/status")], &sqlite_url());
        assert_eq!(
            config,
            StatusRouteConfig {
                path: "/status".to_string(),
                label: "database".to_string(),
                resource_name: "lucida.db".to_string(),
            }
        );
    }

    #[test]
    fn the_label_and_resource_name_are_overridable() {
        let config = configured(
            &[
                ("LUCIDA_STATUS_PATH", " /probes/status "),
                ("LUCIDA_STATUS_LABEL", " sql "),
                ("LUCIDA_STATUS_RESOURCE_NAME", " primary "),
            ],
            &sqlite_url(),
        );
        assert_eq!(config.path, "/probes/status");
        assert_eq!(config.label, "sql");
        assert_eq!(config.resource_name, "primary");
    }

    #[test]
    fn the_default_resource_name_is_the_database_name_alone() {
        let db_url = DatabaseUrl::parse(
            "postgres://lucida:hunter2@db.example:5432/lucida_prod?password=hunter2",
        )
        .unwrap();
        let config = configured(&[("LUCIDA_STATUS_PATH", "/status")], &db_url);
        assert_eq!(config.resource_name, "lucida_prod");
    }

    #[test]
    fn a_blank_label_is_refused() {
        let err = StatusRouteConfig::from_env_map(
            reader(&[
                ("LUCIDA_STATUS_PATH", "/status"),
                ("LUCIDA_STATUS_LABEL", "  "),
            ]),
            &sqlite_url(),
        )
        .expect_err("blank is not the default");
        assert_eq!(
            err,
            StatusRouteConfigError::Blank {
                variable: "LUCIDA_STATUS_LABEL"
            }
        );
        assert!(err.to_string().contains("LUCIDA_STATUS_LABEL"), "{err}");
    }

    #[test]
    fn a_blank_resource_name_is_refused() {
        let err = StatusRouteConfig::from_env_map(
            reader(&[
                ("LUCIDA_STATUS_PATH", "/status"),
                ("LUCIDA_STATUS_RESOURCE_NAME", ""),
            ]),
            &sqlite_url(),
        )
        .expect_err("blank is not the default");
        assert_eq!(
            err,
            StatusRouteConfigError::Blank {
                variable: "LUCIDA_STATUS_RESOURCE_NAME"
            }
        );
    }

    #[test]
    fn a_path_without_a_leading_slash_is_refused() {
        let err = StatusRouteConfig::from_env_map(
            reader(&[("LUCIDA_STATUS_PATH", "status")]),
            &sqlite_url(),
        )
        .expect_err("a relative path cannot be mounted");
        assert_eq!(
            err,
            StatusRouteConfigError::PathWithoutLeadingSlash {
                value: "status".to_string()
            }
        );
        assert!(err.to_string().contains("LUCIDA_STATUS_PATH"), "{err}");
    }

    #[test]
    fn a_path_the_router_cannot_mount_is_refused() {
        for value in ["/sta tus", "/status?verbose=1", "/status#top", "/{status}"] {
            let err = StatusRouteConfig::from_env_map(
                reader(&[("LUCIDA_STATUS_PATH", value)]),
                &sqlite_url(),
            )
            .expect_err(value);
            assert_eq!(
                err,
                StatusRouteConfigError::PathNotRoutable {
                    value: value.to_string()
                }
            );
            assert!(err.to_string().contains("LUCIDA_STATUS_PATH"), "{err}");
        }
    }

    #[test]
    fn a_path_the_probes_already_answer_is_refused() {
        for value in health::PATHS {
            let err = StatusRouteConfig::from_env_map(
                reader(&[("LUCIDA_STATUS_PATH", value)]),
                &sqlite_url(),
            )
            .expect_err(value);
            assert_eq!(
                err,
                StatusRouteConfigError::PathTaken {
                    value: value.to_string()
                }
            );
            assert!(err.to_string().contains("LUCIDA_STATUS_PATH"), "{err}");
        }
    }

    #[test]
    fn a_connection_string_with_no_database_name_needs_an_override() {
        let db_url = DatabaseUrl::parse("postgres://lucida:hunter2@db.example:5432").unwrap();
        let err =
            StatusRouteConfig::from_env_map(reader(&[("LUCIDA_STATUS_PATH", "/status")]), &db_url)
                .expect_err("there is no name to show");
        assert_eq!(err, StatusRouteConfigError::NoDatabaseName);
        assert!(
            err.to_string().contains("LUCIDA_STATUS_RESOURCE_NAME"),
            "{err}"
        );

        let config = configured(
            &[
                ("LUCIDA_STATUS_PATH", "/status"),
                ("LUCIDA_STATUS_RESOURCE_NAME", "primary"),
            ],
            &db_url,
        );
        assert_eq!(config.resource_name, "primary");
    }

    // -- the route ------------------------------------------------------

    #[tokio::test]
    async fn nothing_is_mounted_without_a_path() {
        let app = public_half(None, Arc::new(sqlite_backend().await));
        for path in ["/status", "/api/status", "/healthz/dependencies"] {
            let (status, _, _) = get(&app, path).await;
            assert_eq!(status, StatusCode::NOT_FOUND, "{path}");
        }
        let (status, _, body) = get(&app, "/healthz").await;
        assert_eq!((status, body.as_str()), (StatusCode::OK, "ok"));
    }

    #[tokio::test]
    async fn a_working_backend_reports_connected_in_the_fixed_shape() {
        for scheme in Scheme::ALL {
            let Some(backend) = working_backend(*scheme).await else {
                continue;
            };
            let config = configured(
                &[
                    ("LUCIDA_STATUS_PATH", "/status"),
                    ("LUCIDA_STATUS_LABEL", "sql"),
                    ("LUCIDA_STATUS_RESOURCE_NAME", "primary"),
                ],
                &sqlite_url(),
            );
            let app = public_half(Some(config), backend);
            let (status, body) = get_json(&app, "/status").await;
            assert_eq!(status, StatusCode::OK, "{scheme}");
            assert_eq!(
                body,
                json!({
                    "details": {
                        "dependencies": {
                            "sql": [
                                {
                                    "resource_name": "primary",
                                    "connected": true,
                                    "message": "Success"
                                }
                            ]
                        }
                    }
                }),
                "{scheme}"
            );
        }
    }

    #[tokio::test]
    async fn an_unreachable_backend_still_answers_200_with_connected_false() {
        let backend = sqlite_backend().await;
        backend.pool().close().await;
        let config = configured(&[("LUCIDA_STATUS_PATH", "/status")], &sqlite_url());
        let app = public_half(Some(config), Arc::new(backend));
        let (status, body) = get_json(&app, "/status").await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(
            body,
            json!({
                "details": {
                    "dependencies": {
                        "database": [
                            {
                                "resource_name": "lucida.db",
                                "connected": false,
                                "message": "Failure"
                            }
                        ]
                    }
                }
            })
        );
    }

    /// The in-memory pool has one connection, so holding it makes the
    /// ping wait. The clock is paused only once the backend is open,
    /// because pausing earlier fires the pool's thirty-second acquire
    /// deadline while the backend is still opening. With the clock
    /// paused, the wait costs no wall-clock time, and the elapsed time
    /// shows that the route's timeout answered and not the pool's.
    #[tokio::test]
    async fn a_backend_that_does_not_answer_in_time_is_reported_disconnected() {
        let backend = sqlite_backend().await;
        let _held = backend.pool().acquire().await.unwrap();
        let config = configured(&[("LUCIDA_STATUS_PATH", "/status")], &sqlite_url());
        let app = public_half(Some(config), Arc::new(backend));

        tokio::time::pause();
        let started = tokio::time::Instant::now();
        let (status, body) = get_json(&app, "/status").await;
        let waited = started.elapsed();

        assert_eq!(status, StatusCode::OK);
        assert_eq!(
            body["details"]["dependencies"]["database"][0],
            json!({"resource_name": "lucida.db", "connected": false, "message": "Failure"})
        );
        assert!(
            waited >= QUERY_TIMEOUT,
            "answered before the timeout: {waited:?}"
        );
        assert!(
            waited < QUERY_TIMEOUT + Duration::from_secs(1),
            "waited on something other than the route's timeout: {waited:?}"
        );
    }

    /// The config comes from a PostgreSQL connection string while SQLite
    /// answers the ping. Which backend answers has no bearing on what
    /// the body may contain.
    #[tokio::test]
    async fn the_body_carries_the_database_name_and_nothing_else_from_the_connection_string() {
        let db_url = DatabaseUrl::parse(
            "postgres://lucida:hunter2@db.example:5432/lucida_prod?password=hunter2",
        )
        .unwrap();
        let config = configured(&[("LUCIDA_STATUS_PATH", "/status")], &db_url);
        let app = public_half(Some(config), Arc::new(sqlite_backend().await));
        let (status, _, text) = get(&app, "/status").await;
        assert_eq!(status, StatusCode::OK);
        let body: Value = serde_json::from_str(&text).unwrap();
        assert_eq!(
            body["details"]["dependencies"]["database"][0]["resource_name"],
            json!("lucida_prod")
        );
        for secret in [
            "postgres",
            "lucida:",
            "hunter2",
            "db.example",
            "5432",
            "password",
            "@",
        ] {
            assert!(
                !text.contains(secret),
                "{secret:?} reached the body: {text}"
            );
        }
    }
}
