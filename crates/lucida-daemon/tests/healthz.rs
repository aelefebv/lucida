use axum::body::Body;
use axum::http::{Request, StatusCode};
use http_body_util::BodyExt;
use lucida_daemon::app;
use tower::ServiceExt;

#[tokio::test]
async fn healthz_returns_ok_status_payload() {
    let response = app()
        .oneshot(
            Request::builder()
                .method("GET")
                .uri("/healthz")
                .body(Body::empty())
                .expect("valid request"),
        )
        .await
        .expect("response");

    assert_eq!(response.status(), StatusCode::OK);

    let body_bytes = response
        .into_body()
        .collect()
        .await
        .expect("read body")
        .to_bytes();
    let payload: serde_json::Value = serde_json::from_slice(&body_bytes).expect("json");
    assert_eq!(payload["status"], "ok");
}
