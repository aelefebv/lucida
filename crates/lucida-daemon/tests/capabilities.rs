use axum::body::Body;
use axum::http::{Request, StatusCode};
use http_body_util::BodyExt;
use lucida_daemon::app;
use tower::ServiceExt;

#[tokio::test]
async fn capabilities_returns_required_payload_shape() {
    let response = app()
        .oneshot(
            Request::builder()
                .method("GET")
                .uri("/capabilities")
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

    assert_eq!(payload["schema_version"], 1);
    assert!(payload["api_version"].as_str().is_some());
    assert_eq!(payload["render_modes"], serde_json::json!(["2d"]));
    assert_eq!(payload["output_formats"], serde_json::json!(["png"]));
    assert!(payload["gpu"]["available"].is_boolean());
    assert!(payload["presets"].is_array());
}
