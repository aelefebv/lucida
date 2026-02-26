mod support;

use std::fs;
use std::path::{Path, PathBuf};

use axum::body::Body;
use axum::http::{Request, StatusCode};
use base64::engine::general_purpose::STANDARD as BASE64_STANDARD;
use base64::Engine;
use http_body_util::BodyExt;
use lucida_daemon::app;
use serde_json::{json, Value};
use support::create_render_omezarr;
use tower::ServiceExt;
use uuid::Uuid;

const PARITY_WIDTH: u64 = 96;
const PARITY_HEIGHT: u64 = 72;
const MAX_MEAN_ABS_DIFF: f64 = 4.0;
const MAX_PEAK_ABS_DIFF: u8 = 72;

#[tokio::test]
async fn gpu_cpu_parity_interpolation_modes() {
    let router = app();
    if !gpu_is_available(&router).await {
        return;
    }
    let dataset_path = unique_dataset_path("gpu-parity-interpolation");
    create_render_omezarr(&dataset_path);
    let base_state = base_parity_view_state(open_view_state(&router, &dataset_path).await);

    for interpolation in ["nearest", "linear"] {
        let mut scenario = base_state.clone();
        scenario["layers"][0]["image"]["interpolation"] = json!(interpolation);
        assert_cpu_gpu_parity(&router, &scenario, interpolation).await;
    }
}

#[tokio::test]
async fn gpu_cpu_parity_slab_modes() {
    let router = app();
    if !gpu_is_available(&router).await {
        return;
    }
    let dataset_path = unique_dataset_path("gpu-parity-slab");
    create_render_omezarr(&dataset_path);
    let base_state = base_parity_view_state(open_view_state(&router, &dataset_path).await);

    for mode in ["single", "mip", "mean"] {
        let mut scenario = base_state.clone();
        scenario["view_2d"]["slice"]["slab"] = json!({
            "thickness_vox": 3,
            "mode": mode,
        });
        assert_cpu_gpu_parity(&router, &scenario, mode).await;
    }
}

#[tokio::test]
async fn gpu_cpu_parity_channel_modes_and_gamma() {
    let router = app();
    if !gpu_is_available(&router).await {
        return;
    }
    let dataset_path = unique_dataset_path("gpu-parity-channel-modes");
    create_render_omezarr(&dataset_path);
    let base_state = base_parity_view_state(open_view_state(&router, &dataset_path).await);

    for (mode, gamma) in [("single", 1.0), ("rgb", 0.9), ("composite", 1.4)] {
        let mut scenario = base_state.clone();
        scenario["layers"][0]["image"]["channel_mode"] = json!(mode);
        scenario["layers"][0]["image"]["channels"][0]["gamma"] = json!(gamma);
        assert_cpu_gpu_parity(&router, &scenario, &format!("{mode}-gamma-{gamma}")).await;
    }
}

#[tokio::test]
async fn gpu_cpu_parity_multilayer_alpha_compositing() {
    let router = app();
    if !gpu_is_available(&router).await {
        return;
    }
    let dataset_path = unique_dataset_path("gpu-parity-multilayer");
    create_render_omezarr(&dataset_path);
    let mut scenario = base_parity_view_state(open_view_state(&router, &dataset_path).await);

    let mut overlay = scenario["layers"][0].clone();
    overlay["layer_id"] = json!("overlay_layer");
    overlay["opacity"] = json!(0.45);
    overlay["image"]["channel_mode"] = json!("single");
    overlay["image"]["channels"] = json!([
        {
            "index": 2,
            "enabled": true,
            "color_rgba": [0.2, 0.6, 1.0, 1.0],
            "contrast": {
                "policy": "fixed",
                "min": 0.0,
                "max": 2500.0,
                "p_low": 1.0,
                "p_high": 99.0
            },
            "gamma": 1.1
        }
    ]);
    scenario["layers"] = json!([scenario["layers"][0].clone(), overlay]);

    assert_cpu_gpu_parity(&router, &scenario, "multilayer-alpha").await;
}

async fn assert_cpu_gpu_parity(router: &axum::Router, view_state: &Value, label: &str) {
    let cpu_payload = render_raw_rgba(router, view_state, false).await;
    let gpu_payload = render_raw_rgba(router, view_state, true).await;

    assert_eq!(cpu_payload["status"], "ok");
    assert_eq!(gpu_payload["status"], "ok");
    assert_eq!(cpu_payload["meta"]["backend_used"], "cpu");
    assert_eq!(gpu_payload["meta"]["backend_used"], "gpu");

    let cpu = decode_raw_rgba(&cpu_payload);
    let gpu = decode_raw_rgba(&gpu_payload);
    assert_eq!(cpu.len(), gpu.len(), "raw size mismatch for {label}");

    let (mean_abs_diff, peak_abs_diff) = rgba_diff_stats(&cpu, &gpu);
    assert!(
        mean_abs_diff <= MAX_MEAN_ABS_DIFF,
        "mean abs diff too high for {label}: {mean_abs_diff}",
    );
    assert!(
        peak_abs_diff <= MAX_PEAK_ABS_DIFF,
        "peak abs diff too high for {label}: {peak_abs_diff}",
    );
}

fn rgba_diff_stats(left: &[u8], right: &[u8]) -> (f64, u8) {
    let mut sum_abs: u64 = 0;
    let mut peak: u8 = 0;
    for (lhs, rhs) in left.iter().zip(right.iter()) {
        let diff = lhs.abs_diff(*rhs);
        sum_abs = sum_abs.saturating_add(u64::from(diff));
        peak = peak.max(diff);
    }
    let mean = if left.is_empty() {
        0.0
    } else {
        (sum_abs as f64) / (left.len() as f64)
    };
    (mean, peak)
}

fn decode_raw_rgba(payload: &Value) -> Vec<u8> {
    BASE64_STANDARD
        .decode(
            payload["images"][0]["bytes_base64"]
                .as_str()
                .expect("raw base64"),
        )
        .expect("decode raw rgba")
}

async fn render_raw_rgba(router: &axum::Router, view_state: &Value, prefer_gpu: bool) -> Value {
    let mut scenario = view_state.clone();
    scenario["performance"] = json!({
        "prefer_gpu": prefer_gpu,
        "lod_mode": "fixed",
        "fixed_level": 0,
    });

    let response = request_json(
        router,
        "POST",
        "/render/image",
        json!({
            "schema_version": 1,
            "view_state": scenario,
            "output": {
                "format": "raw_rgba",
                "delivery": "inline_base64",
                "width_px": PARITY_WIDTH,
                "height_px": PARITY_HEIGHT,
            },
        }),
    )
    .await;
    assert_eq!(response.status(), StatusCode::OK);
    read_json_body(response).await
}

fn base_parity_view_state(mut view_state: Value) -> Value {
    view_state["view_2d"]["orthogonal_views_enabled"] = json!(false);
    view_state["view_2d"]["camera"] = json!({
        "center_world": [2.5, 2.0],
        "zoom": 4.0,
        "rotation_deg": 0.0,
    });
    view_state["view_2d"]["slice"] = json!({
        "axis": "z",
        "index": 1,
        "slab": {
            "thickness_vox": 1,
            "mode": "single",
        },
    });
    view_state["selectors"] = json!([
        {"axis": "z", "kind": "index", "index": 1, "clamp": true},
        {"axis": "c", "kind": "index", "index": 0, "clamp": true},
        {"axis": "t", "kind": "index", "index": 0, "clamp": true},
    ]);
    view_state["layers"][0]["opacity"] = json!(0.9);
    view_state["layers"][0]["image"]["interpolation"] = json!("linear");
    view_state["layers"][0]["image"]["channel_mode"] = json!("composite");
    view_state["layers"][0]["image"]["channels"] = json!([
        {
            "index": 0,
            "enabled": true,
            "color_rgba": [1.0, 0.25, 0.25, 1.0],
            "contrast": {
                "policy": "fixed",
                "min": 0.0,
                "max": 2500.0,
                "p_low": 1.0,
                "p_high": 99.0
            },
            "gamma": 1.0
        },
        {
            "index": 1,
            "enabled": true,
            "color_rgba": [0.2, 1.0, 0.35, 1.0],
            "contrast": {
                "policy": "fixed",
                "min": 0.0,
                "max": 2500.0,
                "p_low": 1.0,
                "p_high": 99.0
            },
            "gamma": 1.0
        },
        {
            "index": 2,
            "enabled": true,
            "color_rgba": [0.3, 0.45, 1.0, 1.0],
            "contrast": {
                "policy": "fixed",
                "min": 0.0,
                "max": 2500.0,
                "p_low": 1.0,
                "p_high": 99.0
            },
            "gamma": 1.0
        }
    ]);
    view_state
}

async fn gpu_is_available(router: &axum::Router) -> bool {
    let response = request_get(router, "/capabilities").await;
    assert_eq!(response.status(), StatusCode::OK);
    let payload = read_json_body(response).await;
    payload["gpu"]["available"].as_bool().unwrap_or(false)
}

async fn open_view_state(router: &axum::Router, dataset_path: &Path) -> Value {
    let opened = request_json(
        router,
        "POST",
        "/dataset/open",
        json!({"schema_version": 1, "uri": dataset_path.to_string_lossy()}),
    )
    .await;
    assert_eq!(opened.status(), StatusCode::OK);
    let dataset_id = read_json_body(opened).await["dataset_summary"]["dataset_id"]
        .as_str()
        .expect("dataset_id")
        .to_owned();

    let created = request_json(
        router,
        "POST",
        "/view/create",
        json!({"schema_version": 1, "dataset_id": dataset_id, "mode": "2d"}),
    )
    .await;
    assert_eq!(created.status(), StatusCode::OK);
    read_json_body(created).await["view_state"].clone()
}

async fn request_json(
    router: &axum::Router,
    method: &str,
    path: &str,
    payload: Value,
) -> axum::response::Response {
    router
        .clone()
        .oneshot(
            Request::builder()
                .method(method)
                .uri(path)
                .header("content-type", "application/json")
                .body(Body::from(payload.to_string()))
                .expect("valid request"),
        )
        .await
        .expect("response")
}

async fn request_get(router: &axum::Router, path: &str) -> axum::response::Response {
    router
        .clone()
        .oneshot(
            Request::builder()
                .method("GET")
                .uri(path)
                .body(Body::empty())
                .expect("valid request"),
        )
        .await
        .expect("response")
}

async fn read_json_body(response: axum::response::Response) -> Value {
    let body_bytes = response
        .into_body()
        .collect()
        .await
        .expect("read body")
        .to_bytes();
    serde_json::from_slice(&body_bytes).expect("json")
}

fn unique_dataset_path(name: &str) -> PathBuf {
    let path = std::env::temp_dir()
        .join("lucida-daemon-tests")
        .join(format!("{name}-{}", Uuid::new_v4().simple()));
    if path.exists() {
        fs::remove_dir_all(&path).expect("cleanup old directory");
    }
    path
}
