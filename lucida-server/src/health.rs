//! Liveness, readiness, and version endpoints for containerized deploys.
//!
//! `GET /healthz` answers liveness ("is this process alive?"). The
//! kubelet uses it to decide "kill and restart this pod."
//!
//! `GET /readyz` answers readiness ("should I send traffic to this
//! pod?"). The Service / load balancer uses it to decide whether to
//! route requests here.
//!
//! `GET /version` returns the injected release/build identity. Lets ops confirm what's deployed
//! without `kubectl exec`-ing in to run `lucida-server --version`.
//!
//! Readiness is backed by [`RuntimeLifecycle`]. It remains false while
//! startup dependencies are being opened, becomes true immediately before
//! the accept loop starts, and flips false before graceful shutdown begins.
//! Liveness deliberately remains independent: a draining process is alive and
//! must not be restarted while it finishes existing work.
//!
//! ## Auth interaction
//!
//! All three routes MUST land on the public router half — the kubelet
//! does not present a session cookie, and probes timing out due to a
//! 401 would defeat their entire purpose. /version is similarly public
//! so it's reachable from monitoring/alerting that may not authenticate.
//! See [[subsystems/auth]] for the public/protected split.

use std::sync::Arc;
use std::sync::atomic::{AtomicU8, Ordering};

use axum::Router;
use axum::extract::{Request, State};
use axum::http::StatusCode;
use axum::middleware::Next;
use axum::response::{IntoResponse, Json, Response};
use axum::routing::get;
use lucida_store::budget::{MemoryBudget, MemoryBudgetSnapshot};
use tokio::sync::watch;

const STARTING: u8 = 0;
const READY: u8 = 1;
const DRAINING: u8 = 2;

/// Operational identity compiled into the server and exposed consistently by
/// both `lucida-server --version` and `GET /version`.
///
/// Release images inject the immutable Git tag. Ad-hoc source builds are
/// deliberately marked as such instead of pretending the workspace's frozen
/// crate version is the product release version (ADR-0022).
pub const BUILD_VERSION: &str = match option_env!("LUCIDA_BUILD_VERSION") {
    Some(version) => version,
    None => concat!(env!("CARGO_PKG_VERSION"), "+source"),
};

/// Public server lifecycle phases used by readiness, request admission, and
/// long-lived connection/background-work cancellation.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum RuntimePhase {
    Starting,
    Ready,
    Draining,
}

impl RuntimePhase {
    fn from_u8(value: u8) -> Self {
        match value {
            READY => Self::Ready,
            DRAINING => Self::Draining,
            _ => Self::Starting,
        }
    }
}

struct LifecycleInner {
    phase: AtomicU8,
    changes: watch::Sender<RuntimePhase>,
}

/// Cloneable lifecycle signal shared across the server.
///
/// The atomic phase makes synchronous readiness/admission checks cheap. The
/// watch channel gives WebSocket loops and background tasks a race-free way to
/// observe drain even if they subscribe after shutdown has started.
#[derive(Clone)]
pub struct RuntimeLifecycle {
    inner: Arc<LifecycleInner>,
}

impl Default for RuntimeLifecycle {
    fn default() -> Self {
        Self::new()
    }
}

impl RuntimeLifecycle {
    pub fn new() -> Self {
        let (changes, _) = watch::channel(RuntimePhase::Starting);
        Self {
            inner: Arc::new(LifecycleInner {
                phase: AtomicU8::new(STARTING),
                changes,
            }),
        }
    }

    pub fn phase(&self) -> RuntimePhase {
        RuntimePhase::from_u8(self.inner.phase.load(Ordering::Acquire))
    }

    pub fn is_ready(&self) -> bool {
        self.phase() == RuntimePhase::Ready
    }

    /// Mark startup complete. Returns false if shutdown already began, so a
    /// late startup task can never resurrect a draining instance.
    pub fn mark_ready(&self) -> bool {
        if self
            .inner
            .phase
            .compare_exchange(STARTING, READY, Ordering::AcqRel, Ordering::Acquire)
            .is_err()
        {
            return self.phase() == RuntimePhase::Ready;
        }
        self.inner.changes.send_replace(RuntimePhase::Ready);
        true
    }

    /// Start drain exactly once. Readiness and request admission observe the
    /// atomic transition before any quiet/grace period begins.
    pub fn begin_draining(&self) -> bool {
        let previous = self.inner.phase.swap(DRAINING, Ordering::AcqRel);
        if previous == DRAINING {
            return false;
        }
        self.inner.changes.send_replace(RuntimePhase::Draining);
        true
    }

    pub fn subscribe(&self) -> watch::Receiver<RuntimePhase> {
        self.inner.changes.subscribe()
    }

    /// Resolve as soon as drain starts, including when the caller subscribes
    /// after the transition.
    pub async fn wait_for_draining(&self) {
        let mut changes = self.subscribe();
        while *changes.borrow_and_update() != RuntimePhase::Draining {
            if changes.changed().await.is_err() {
                break;
            }
        }
    }
}

/// Liveness probe handler. Always 200; the moment we have an
/// "I should be killed" condition (e.g. fatal background-task failure)
/// this is where it surfaces.
async fn healthz() -> (StatusCode, &'static str) {
    (StatusCode::OK, "ok")
}

async fn readyz(State(lifecycle): State<RuntimeLifecycle>) -> (StatusCode, &'static str) {
    match lifecycle.phase() {
        RuntimePhase::Ready => (StatusCode::OK, "ok"),
        RuntimePhase::Starting => (StatusCode::SERVICE_UNAVAILABLE, "starting"),
        RuntimePhase::Draining => (StatusCode::SERVICE_UNAVAILABLE, "draining"),
    }
}

/// Version handler. Returns the release/build identity injected at compile
/// time, with an explicit `+source` fallback for ad-hoc Cargo builds.
/// Body is plain text matching `lucida-server --version` output, so
/// scripts can grep either source interchangeably.
async fn version() -> (StatusCode, &'static str) {
    (StatusCode::OK, BUILD_VERSION)
}

/// Build the health-probe router with `/healthz`, `/readyz`, and
/// `/version` mounted.
///
/// The returned router is intended to be merged into the application's
/// **public** router half (the one NOT wrapped by auth middleware) so
/// that a kubelet without credentials can hit the probes and so
/// monitoring can read /version without a session cookie.
pub fn router(lifecycle: RuntimeLifecycle) -> Router {
    Router::new()
        .route("/healthz", get(healthz))
        .route("/readyz", get(readyz))
        .route("/version", get(version))
        .with_state(lifecycle)
}

/// Build the low-cardinality process resource metrics route.
///
/// The payload deliberately exposes only byte counts and rejection totals—no
/// workspace, source, or principal identifiers—so operators can alert on
/// budget pressure without turning telemetry into a data-leak surface.
pub fn resource_router(memory_budget: Arc<MemoryBudget>) -> Router {
    async fn resource_metrics(
        State(memory_budget): State<Arc<MemoryBudget>>,
    ) -> Json<MemoryBudgetSnapshot> {
        Json(memory_budget.snapshot())
    }

    async fn websocket_metrics() -> Json<crate::outbox::WebSocketMetricsSnapshot> {
        Json(crate::outbox::websocket_metrics_snapshot())
    }

    Router::new()
        .route("/metrics/resources", get(resource_metrics))
        .route("/metrics/websockets", get(websocket_metrics))
        .with_state(memory_budget)
}

/// Reject new application work after drain begins while keeping probes
/// reachable. Apply this to the complete application router.
pub async fn reject_while_draining(
    State(lifecycle): State<RuntimeLifecycle>,
    request: Request,
    next: Next,
) -> Response {
    if lifecycle.phase() != RuntimePhase::Draining {
        return next.run(request).await;
    }

    match request.uri().path() {
        "/healthz" | "/readyz" | "/version" => next.run(request).await,
        _ => (StatusCode::SERVICE_UNAVAILABLE, "server is draining").into_response(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::body::{Body, to_bytes};
    use axum::http::{Request, StatusCode};
    use tower::ServiceExt;

    #[tokio::test]
    async fn healthz_returns_200_ok() {
        let app = router(RuntimeLifecycle::new());
        let res = app
            .oneshot(
                Request::builder()
                    .uri("/healthz")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(res.status(), StatusCode::OK);
        let bytes = to_bytes(res.into_body(), 64).await.unwrap();
        assert_eq!(&bytes[..], b"ok");
    }

    #[tokio::test]
    async fn resource_metrics_expose_every_resident_category_without_identifiers() {
        use lucida_store::budget::MemoryCategory;

        let budget = MemoryBudget::new(1_024);
        let source = budget
            .try_reserve(MemoryCategory::SourceCached, 100)
            .unwrap();
        let decoded = budget.try_reserve(MemoryCategory::Decoded, 200).unwrap();
        let parsed_metadata = budget
            .try_reserve(MemoryCategory::MetadataParsed, 50)
            .unwrap();
        assert!(
            budget
                .try_reserve(MemoryCategory::GeneratedReady, 800)
                .is_none()
        );

        let response = resource_router(Arc::clone(&budget))
            .oneshot(
                Request::builder()
                    .uri("/metrics/resources")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        let body = to_bytes(response.into_body(), 4 * 1024).await.unwrap();
        let payload: serde_json::Value = serde_json::from_slice(&body).unwrap();
        assert_eq!(payload["max_bytes"], 1_024);
        assert_eq!(payload["total_bytes"], 350);
        assert_eq!(payload["source_cached_bytes"], 100);
        assert_eq!(payload["source_in_flight_bytes"], 0);
        assert_eq!(payload["decoded_bytes"], 200);
        assert_eq!(payload["generated_ready_bytes"], 0);
        assert_eq!(payload["metadata_parsed_bytes"], 50);
        assert_eq!(payload["rejected_reservations"], 1);
        assert_eq!(payload.as_object().unwrap().len(), 8);

        drop((source, decoded, parsed_metadata));
    }

    #[tokio::test]
    async fn websocket_metrics_are_low_cardinality_and_identifier_free() {
        let budget = MemoryBudget::new(1_024);
        let response = resource_router(budget)
            .oneshot(
                Request::builder()
                    .uri("/metrics/websockets")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        let body = to_bytes(response.into_body(), 4 * 1024).await.unwrap();
        let payload: serde_json::Value = serde_json::from_slice(&body).unwrap();
        let keys: std::collections::BTreeSet<_> = payload
            .as_object()
            .unwrap()
            .keys()
            .map(String::as_str)
            .collect();
        assert_eq!(
            keys,
            std::collections::BTreeSet::from([
                "peak_queued_bytes",
                "process_pressure_connection_victims",
                "process_pressure_ring_victims",
                "queued_bytes",
                "rejected_outbox_full",
                "rejected_outbox_oversized",
                "rejected_outbox_process_full",
                "rejected_request_work",
                "slow_consumer_timeouts",
            ])
        );
    }

    #[tokio::test]
    async fn readyz_tracks_startup_and_drain_without_changing_liveness() {
        let lifecycle = RuntimeLifecycle::new();
        let app = router(lifecycle.clone());
        let starting = app
            .clone()
            .oneshot(
                Request::builder()
                    .uri("/readyz")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(starting.status(), StatusCode::SERVICE_UNAVAILABLE);

        assert!(lifecycle.mark_ready());
        let res = app
            .clone()
            .oneshot(
                Request::builder()
                    .uri("/readyz")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(res.status(), StatusCode::OK);
        let bytes = to_bytes(res.into_body(), 64).await.unwrap();
        assert_eq!(&bytes[..], b"ok");

        assert!(lifecycle.begin_draining());
        let draining = app
            .clone()
            .oneshot(
                Request::builder()
                    .uri("/readyz")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(draining.status(), StatusCode::SERVICE_UNAVAILABLE);
        let live = app
            .oneshot(
                Request::builder()
                    .uri("/healthz")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(live.status(), StatusCode::OK);
    }

    #[tokio::test]
    async fn version_returns_operational_build_identity() {
        let app = router(RuntimeLifecycle::new());
        let res = app
            .oneshot(
                Request::builder()
                    .uri("/version")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(res.status(), StatusCode::OK);
        let bytes = to_bytes(res.into_body(), 64).await.unwrap();
        assert_eq!(&bytes[..], BUILD_VERSION.as_bytes());
    }

    #[tokio::test]
    async fn drain_signal_is_sticky_for_late_subscribers() {
        let lifecycle = RuntimeLifecycle::new();
        lifecycle.begin_draining();
        tokio::time::timeout(
            std::time::Duration::from_millis(50),
            lifecycle.wait_for_draining(),
        )
        .await
        .expect("late subscriber observes drain");
        assert!(
            !lifecycle.mark_ready(),
            "draining cannot become ready again"
        );
    }

    #[tokio::test]
    async fn drain_rejects_new_work_but_keeps_probe_routes_reachable() {
        let lifecycle = RuntimeLifecycle::new();
        assert!(lifecycle.mark_ready());
        let app = router(lifecycle.clone())
            .route("/work", get(|| async { StatusCode::NO_CONTENT }))
            .layer(axum::middleware::from_fn_with_state(
                lifecycle.clone(),
                reject_while_draining,
            ));

        let before = app
            .clone()
            .oneshot(Request::builder().uri("/work").body(Body::empty()).unwrap())
            .await
            .unwrap();
        assert_eq!(before.status(), StatusCode::NO_CONTENT);

        assert!(lifecycle.begin_draining());
        let rejected = app
            .clone()
            .oneshot(Request::builder().uri("/work").body(Body::empty()).unwrap())
            .await
            .unwrap();
        assert_eq!(rejected.status(), StatusCode::SERVICE_UNAVAILABLE);

        let ready = app
            .oneshot(
                Request::builder()
                    .uri("/readyz")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(ready.status(), StatusCode::SERVICE_UNAVAILABLE);
        let bytes = to_bytes(ready.into_body(), 64).await.unwrap();
        assert_eq!(&bytes[..], b"draining");
    }
}
