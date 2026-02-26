mod support;

use std::fs;
use std::path::{Path, PathBuf};

use axum::body::Body;
use axum::http::{Request, StatusCode};
use base64::engine::general_purpose::STANDARD as BASE64_STANDARD;
use base64::Engine;
use http_body_util::BodyExt;
use image::{ImageReader, RgbaImage};
use lucida_daemon::app;
use serde_json::{json, Value};
use support::create_render_omezarr;
use tower::ServiceExt;
use uuid::Uuid;

#[tokio::test]
async fn render_image_stateful_and_stateless_success() {
    let router = app();
    let dataset_path = unique_dataset_path("render-success");
    create_render_omezarr(&dataset_path);

    let view_id = open_view(&router, &dataset_path).await;

    let stateful = request_json(
        &router,
        "POST",
        "/render/image",
        json!({
            "schema_version": 1,
            "view_id": view_id,
            "output": {
                "format": "png",
                "delivery": "inline_base64",
                "width_px": 64,
                "height_px": 48,
            },
        }),
    )
    .await;
    assert_eq!(stateful.status(), StatusCode::OK);
    let stateful_payload = read_json_body(stateful).await;
    assert_eq!(stateful_payload["status"], "ok");
    assert_eq!(stateful_payload["view_id"], view_id);
    assert!(stateful_payload["state_version"].as_u64().is_some());
    assert_eq!(stateful_payload["images"][0]["mime"], "image/png");
    assert_eq!(
        decode_png_size(
            stateful_payload["images"][0]["bytes_base64"]
                .as_str()
                .expect("base64 payload"),
        ),
        (64, 48)
    );

    let fetched = request_get(&router, &format!("/view/{view_id}"), None).await;
    assert_eq!(fetched.status(), StatusCode::OK);
    let view_state = read_json_body(fetched).await["view_state"].clone();

    let stateless = request_json(
        &router,
        "POST",
        "/render/image",
        json!({
            "schema_version": 1,
            "view_state": view_state,
            "output": {
                "format": "png",
                "delivery": "inline_base64",
                "width_px": 40,
                "height_px": 30,
            },
        }),
    )
    .await;
    assert_eq!(stateless.status(), StatusCode::OK);
    let stateless_payload = read_json_body(stateless).await;
    assert!(stateless_payload.get("view_id").is_none());
    assert!(stateless_payload.get("state_version").is_none());
    assert_eq!(
        decode_png_size(
            stateless_payload["images"][0]["bytes_base64"]
                .as_str()
                .expect("base64 payload"),
        ),
        (40, 30)
    );
}

#[tokio::test]
async fn render_image_contract_and_error_paths() {
    let router = app();
    let dataset_path = unique_dataset_path("render-errors");
    create_render_omezarr(&dataset_path);
    let view_id = open_view(&router, &dataset_path).await;

    let view_state = read_json_body(request_get(&router, &format!("/view/{view_id}"), None).await)
        .await["view_state"]
        .clone();

    let invalid_patch = request_json(
        &router,
        "POST",
        "/render/image",
        json!({
            "schema_version": 1,
            "view_id": view_id,
            "overrides_json_patch": [{"op": "replace", "path": "/selectors/100/index", "value": 1}],
            "output": {
                "format": "png",
                "delivery": "inline_base64",
                "width_px": 64,
                "height_px": 48,
            },
        }),
    )
    .await;
    assert_eq!(invalid_patch.status(), StatusCode::UNPROCESSABLE_ENTITY);
    assert_eq!(read_json_body(invalid_patch).await["code"], "invalid_patch");

    let both = request_json(
        &router,
        "POST",
        "/render/image",
        json!({
            "schema_version": 1,
            "view_id": view_id,
            "view_state": view_state,
            "output": {
                "format": "png",
                "delivery": "inline_base64",
                "width_px": 64,
                "height_px": 48,
            },
        }),
    )
    .await;
    assert_eq!(both.status(), StatusCode::UNPROCESSABLE_ENTITY);
    assert_eq!(read_json_body(both).await["code"], "invalid_render_request");

    let neither = request_json(
        &router,
        "POST",
        "/render/image",
        json!({
            "schema_version": 1,
            "output": {
                "format": "png",
                "delivery": "inline_base64",
                "width_px": 64,
                "height_px": 48,
            },
        }),
    )
    .await;
    assert_eq!(neither.status(), StatusCode::UNPROCESSABLE_ENTITY);
    assert_eq!(
        read_json_body(neither).await["code"],
        "invalid_render_request"
    );

    let too_large = request_json(
        &router,
        "POST",
        "/render/image",
        json!({
            "schema_version": 1,
            "view_id": view_id,
            "output": {
                "format": "png",
                "delivery": "inline_base64",
                "width_px": 5000,
                "height_px": 48,
            },
        }),
    )
    .await;
    assert_eq!(too_large.status(), StatusCode::UNPROCESSABLE_ENTITY);
    assert_eq!(
        read_json_body(too_large).await["code"],
        "render_output_too_large"
    );
}

#[tokio::test]
async fn render_image_unsupported_codec_fails() {
    let router = app();
    let dataset_path = unique_dataset_path("render-unsupported-codec");
    create_render_omezarr(&dataset_path);

    let level0_metadata_path = dataset_path.join("0").join("zarr.json");
    let mut level0_metadata: Value = serde_json::from_str(
        &fs::read_to_string(&level0_metadata_path).expect("read level metadata"),
    )
    .expect("parse level metadata");
    level0_metadata["codecs"] = json!([
        {"name": "bytes", "configuration": {"endian": "little"}},
        {"name": "unsupported_codec", "configuration": {}},
    ]);
    fs::write(
        &level0_metadata_path,
        serde_json::to_string_pretty(&level0_metadata).expect("serialize level metadata"),
    )
    .expect("write level metadata");

    let view_id = open_view(&router, &dataset_path).await;
    let rendered = request_json(
        &router,
        "POST",
        "/render/image",
        json!({
            "schema_version": 1,
            "view_id": view_id,
            "output": {
                "format": "png",
                "delivery": "inline_base64",
                "width_px": 64,
                "height_px": 48,
            },
        }),
    )
    .await;
    assert_eq!(rendered.status(), StatusCode::UNPROCESSABLE_ENTITY);
    let payload = read_json_body(rendered).await;
    assert_eq!(payload["code"], "render_failed");
    let reason = payload["details"]["reason"]
        .as_str()
        .expect("failure reason");
    assert!(reason.contains("unsupported codec"));
}

#[tokio::test]
async fn render_image_decodes_only_required_chunks() {
    let router = app();
    let dataset_path = unique_dataset_path("render-required-chunks");
    create_render_omezarr(&dataset_path);

    let unused_chunk = dataset_path.join("0/c/0/0/1/1/1");
    fs::write(&unused_chunk, b"not-a-valid-zstd-payload").expect("corrupt off-viewport chunk");

    let view_id = open_view(&router, &dataset_path).await;
    let update = request_json(
        &router,
        "POST",
        "/view/update",
        json!({
            "schema_version": 1,
            "view_id": view_id,
            "patch": [
                {
                    "op": "replace",
                    "path": "/performance",
                    "value": {"lod_mode": "fixed", "fixed_level": 0},
                },
                {
                    "op": "replace",
                    "path": "/view_2d/camera",
                    "value": {"center_world": [0.0, 0.0], "zoom": 64.0, "rotation_deg": 0.0},
                }
            ],
        }),
    )
    .await;
    assert_eq!(update.status(), StatusCode::OK);

    let rendered = request_json(
        &router,
        "POST",
        "/render/image",
        json!({
            "schema_version": 1,
            "view_id": view_id,
            "output": {
                "format": "png",
                "delivery": "inline_base64",
                "width_px": 64,
                "height_px": 48,
            },
        }),
    )
    .await;
    assert_eq!(rendered.status(), StatusCode::OK);
}

#[tokio::test]
async fn render_image_session_dataset_and_output_path_guards() {
    let router = app();
    let dataset_path = unique_dataset_path("render-scoping");
    create_render_omezarr(&dataset_path);
    let view_id = open_view(&router, &dataset_path).await;

    let view_state = read_json_body(request_get(&router, &format!("/view/{view_id}"), None).await)
        .await["view_state"]
        .clone();

    let missing_session = request_json(
        &router,
        "POST",
        "/render/image",
        json!({
            "schema_version": 1,
            "view_id": view_id,
            "session_id": "session_missing",
            "output": {
                "format": "png",
                "delivery": "inline_base64",
                "width_px": 64,
                "height_px": 48,
            },
        }),
    )
    .await;
    assert_eq!(missing_session.status(), StatusCode::NOT_FOUND);
    assert_eq!(
        read_json_body(missing_session).await["code"],
        "session_not_found"
    );

    let bad_path = request_json(
        &router,
        "POST",
        "/render/image",
        json!({
            "schema_version": 1,
            "view_id": view_id,
            "output": {
                "format": "png",
                "delivery": "file_path",
                "file_path": "../outside-root.png",
                "width_px": 64,
                "height_px": 48,
            },
        }),
    )
    .await;
    assert_eq!(bad_path.status(), StatusCode::UNPROCESSABLE_ENTITY);
    assert_eq!(
        read_json_body(bad_path).await["code"],
        "render_output_path_invalid"
    );

    let mut invalid_state = view_state;
    invalid_state["datasets"][0]["dataset_id"] = json!("ds_missing");
    let missing_dataset = request_json(
        &router,
        "POST",
        "/render/image",
        json!({
            "schema_version": 1,
            "view_state": invalid_state,
            "output": {
                "format": "png",
                "delivery": "inline_base64",
                "width_px": 64,
                "height_px": 48,
            },
        }),
    )
    .await;
    assert_eq!(missing_dataset.status(), StatusCode::NOT_FOUND);
    assert_eq!(
        read_json_body(missing_dataset).await["code"],
        "dataset_not_found"
    );
}

#[tokio::test]
async fn render_image_file_delivery_and_ephemeral_patch() {
    let router = app();
    let dataset_path = unique_dataset_path("render-files");
    create_render_omezarr(&dataset_path);
    let view_id = open_view(&router, &dataset_path).await;
    let output_root = normalize_lexical(
        &Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("..")
            .join("..")
            .join("output"),
    );

    let explicit_relative = format!("snapshots/test-render-{}.png", Uuid::new_v4().simple());
    let explicit = request_json(
        &router,
        "POST",
        "/render/image",
        json!({
            "schema_version": 1,
            "view_id": view_id,
            "output": {
                "format": "png",
                "delivery": "file_path",
                "file_path": explicit_relative,
                "width_px": 32,
                "height_px": 24,
            },
        }),
    )
    .await;
    assert_eq!(explicit.status(), StatusCode::OK);
    let explicit_payload = read_json_body(explicit).await;
    let explicit_path = PathBuf::from(
        explicit_payload["images"][0]["file_path"]
            .as_str()
            .expect("explicit output path"),
    );
    assert!(explicit_path.exists());
    assert!(explicit_path.starts_with(&output_root));

    let auto = request_json(
        &router,
        "POST",
        "/render/image",
        json!({
            "schema_version": 1,
            "view_id": view_id,
            "output": {
                "format": "png",
                "delivery": "file_path",
                "width_px": 32,
                "height_px": 24,
            },
        }),
    )
    .await;
    assert_eq!(auto.status(), StatusCode::OK);
    let auto_payload = read_json_body(auto).await;
    let auto_path = PathBuf::from(
        auto_payload["images"][0]["file_path"]
            .as_str()
            .expect("auto output path"),
    );
    assert!(auto_path.exists());
    assert!(auto_path.starts_with(output_root.join("snapshots")));

    let before =
        read_json_body(request_get(&router, &format!("/view/{view_id}"), None).await).await;
    let before_hash = before["view_state"]["state_hash"].clone();
    let before_version = before["view_state"]["state_version"].clone();

    let patched = request_json(
        &router,
        "POST",
        "/render/image",
        json!({
            "schema_version": 1,
            "view_id": view_id,
            "overrides_json_patch": [
                {
                    "op": "replace",
                    "path": "/selectors",
                    "value": [{"axis": "z", "kind": "index", "index": 3, "clamp": true}],
                }
            ],
            "output": {
                "format": "png",
                "delivery": "inline_base64",
                "width_px": 32,
                "height_px": 24,
            },
        }),
    )
    .await;
    assert_eq!(patched.status(), StatusCode::OK);
    let patched_payload = read_json_body(patched).await;
    assert_ne!(patched_payload["state_hash"], before_hash);

    let after = read_json_body(request_get(&router, &format!("/view/{view_id}"), None).await).await;
    assert_eq!(after["view_state"]["state_hash"], before_hash);
    assert_eq!(after["view_state"]["state_version"], before_version);

    if explicit_path.exists() {
        fs::remove_file(explicit_path).expect("cleanup explicit output");
    }
    if auto_path.exists() {
        fs::remove_file(auto_path).expect("cleanup auto output");
    }
}

#[tokio::test]
async fn render_image_slab_and_lod_warnings() {
    let router = app();
    let dataset_path = unique_dataset_path("render-warnings");
    create_render_omezarr(&dataset_path);
    let view_id = open_view(&router, &dataset_path).await;

    let update = request_json(
        &router,
        "POST",
        "/view/update",
        json!({
            "schema_version": 1,
            "view_id": view_id,
            "patch": [
                {
                    "op": "replace",
                    "path": "/selectors",
                    "value": [
                        {"axis": "z", "kind": "range", "start": 1, "end_exclusive": 4, "clamp": true},
                        {"axis": "c", "kind": "index", "index": 0, "clamp": true},
                        {"axis": "t", "kind": "range", "start": 0, "end_exclusive": 1, "clamp": true}
                    ],
                },
                {
                    "op": "replace",
                    "path": "/view_2d/slice/slab",
                    "value": {"thickness_vox": 5, "mode": "single"},
                },
                {
                    "op": "replace",
                    "path": "/performance",
                    "value": {"lod_mode": "fixed", "fixed_level": 99},
                }
            ],
        }),
    )
    .await;
    assert_eq!(update.status(), StatusCode::OK);

    let rendered = request_json(
        &router,
        "POST",
        "/render/image",
        json!({
            "schema_version": 1,
            "view_id": view_id,
            "output": {
                "format": "png",
                "delivery": "inline_base64",
                "width_px": 64,
                "height_px": 48,
            },
        }),
    )
    .await;
    assert_eq!(rendered.status(), StatusCode::OK);
    let payload = read_json_body(rendered).await;
    let warning_codes: Vec<&str> = payload["warnings"]
        .as_array()
        .expect("warnings array")
        .iter()
        .filter_map(|item| item.get("code").and_then(Value::as_str))
        .collect();
    assert!(warning_codes.contains(&"slab_thickness_ignored"));
    assert!(warning_codes.contains(&"lod_level_fallback_auto"));
    assert!(warning_codes.contains(&"selector_reduced_to_index"));
}

#[tokio::test]
async fn render_image_explicit_gpu_preference_routes_to_gpu_or_emits_fallback_warning() {
    let router = app();
    let dataset_path = unique_dataset_path("render-backend-fallback");
    create_render_omezarr(&dataset_path);
    let view_id = open_view(&router, &dataset_path).await;
    let capabilities = read_json_body(request_get(&router, "/capabilities", None).await).await;
    let gpu_available = capabilities["gpu"]["available"]
        .as_bool()
        .expect("gpu.available bool");

    let update = request_json(
        &router,
        "POST",
        "/view/update",
        json!({
            "schema_version": 1,
            "view_id": view_id,
            "patch": [
                {
                    "op": "replace",
                    "path": "/performance",
                    "value": {"prefer_gpu": true},
                }
            ],
        }),
    )
    .await;
    assert_eq!(update.status(), StatusCode::OK);

    let rendered = request_json(
        &router,
        "POST",
        "/render/image",
        json!({
            "schema_version": 1,
            "view_id": view_id,
            "output": {
                "format": "png",
                "delivery": "inline_base64",
                "width_px": 64,
                "height_px": 48,
            },
        }),
    )
    .await;
    assert_eq!(rendered.status(), StatusCode::OK);

    let payload = read_json_body(rendered).await;
    let warning_codes: Vec<&str> = payload["warnings"]
        .as_array()
        .expect("warnings array")
        .iter()
        .filter_map(|item| item.get("code").and_then(Value::as_str))
        .collect();
    if gpu_available {
        assert!(!warning_codes.contains(&"gpu_unavailable_fallback_cpu"));
        assert!(!warning_codes.contains(&"gpu_render_failed_fallback_cpu"));
        assert!(
            payload["meta"]["timing_ms"]["gpu_upload"]
                .as_f64()
                .expect("gpu_upload timing")
                > 0.0
        );
    } else {
        assert!(warning_codes.contains(&"gpu_unavailable_fallback_cpu"));
    }
}

#[tokio::test]
async fn render_image_orthogonal_triptych_default_on_and_toggle_off() {
    let router = app();
    let dataset_path = unique_dataset_path("render-triptych-toggle");
    create_render_omezarr(&dataset_path);
    let view_id = open_view(&router, &dataset_path).await;

    let created_state =
        read_json_body(request_get(&router, &format!("/view/{view_id}"), None).await).await;
    assert_eq!(
        created_state["view_state"]["view_2d"]["orthogonal_views_enabled"],
        json!(true)
    );

    let enabled_render = request_json(
        &router,
        "POST",
        "/render/image",
        json!({
            "schema_version": 1,
            "view_id": view_id,
            "output": {
                "format": "png",
                "delivery": "inline_base64",
                "width_px": 180,
                "height_px": 180,
            },
        }),
    )
    .await;
    assert_eq!(enabled_render.status(), StatusCode::OK);
    let enabled_payload = read_json_body(enabled_render).await;
    let enabled_codes: Vec<&str> = enabled_payload["warnings"]
        .as_array()
        .expect("warnings array")
        .iter()
        .filter_map(|item| item.get("code").and_then(Value::as_str))
        .collect();
    assert!(enabled_codes.contains(&"orthogonal_triptych_enabled"));

    let update = request_json(
        &router,
        "POST",
        "/view/update",
        json!({
            "schema_version": 1,
            "view_id": view_id,
            "patch": [
                {
                    "op": "replace",
                    "path": "/view_2d/orthogonal_views_enabled",
                    "value": false,
                }
            ],
        }),
    )
    .await;
    assert_eq!(update.status(), StatusCode::OK);

    let disabled_render = request_json(
        &router,
        "POST",
        "/render/image",
        json!({
            "schema_version": 1,
            "view_id": view_id,
            "output": {
                "format": "png",
                "delivery": "inline_base64",
                "width_px": 180,
                "height_px": 180,
            },
        }),
    )
    .await;
    assert_eq!(disabled_render.status(), StatusCode::OK);
    let disabled_payload = read_json_body(disabled_render).await;
    let disabled_codes: Vec<&str> = disabled_payload["warnings"]
        .as_array()
        .expect("warnings array")
        .iter()
        .filter_map(|item| item.get("code").and_then(Value::as_str))
        .collect();
    assert!(!disabled_codes.contains(&"orthogonal_triptych_enabled"));
    assert_ne!(
        enabled_payload["images"][0]["sha256"],
        disabled_payload["images"][0]["sha256"]
    );
}

#[tokio::test]
async fn render_image_orthogonal_triptych_small_output_falls_back() {
    let router = app();
    let dataset_path = unique_dataset_path("render-triptych-fallback");
    create_render_omezarr(&dataset_path);
    let view_id = open_view(&router, &dataset_path).await;

    let rendered = request_json(
        &router,
        "POST",
        "/render/image",
        json!({
            "schema_version": 1,
            "view_id": view_id,
            "output": {
                "format": "png",
                "delivery": "inline_base64",
                "width_px": 40,
                "height_px": 40,
            },
        }),
    )
    .await;
    assert_eq!(rendered.status(), StatusCode::OK);
    let payload = read_json_body(rendered).await;
    let warning_codes: Vec<&str> = payload["warnings"]
        .as_array()
        .expect("warnings array")
        .iter()
        .filter_map(|item| item.get("code").and_then(Value::as_str))
        .collect();
    assert!(warning_codes.contains(&"orthogonal_triptych_fallback_single_plane"));
    assert!(!warning_codes.contains(&"orthogonal_triptych_enabled"));
}

#[tokio::test]
async fn render_image_orthogonal_triptych_orientation_maps_z_outward() {
    let router = app();
    let dataset_path = unique_dataset_path("render-triptych-orientation");
    create_render_omezarr(&dataset_path);
    let view_id = open_view(&router, &dataset_path).await;

    let update = request_json(
        &router,
        "POST",
        "/view/update",
        json!({
            "schema_version": 1,
            "view_id": view_id,
            "patch": [
                {
                    "op": "replace",
                    "path": "/selectors",
                    "value": [
                        {"axis": "z", "kind": "index", "index": 1, "clamp": true},
                        {"axis": "c", "kind": "index", "index": 0, "clamp": true},
                        {"axis": "t", "kind": "index", "index": 0, "clamp": true}
                    ],
                },
                {
                    "op": "replace",
                    "path": "/view_2d/camera",
                    "value": {"center_world": [2.5, 2.0], "zoom": 24.0, "rotation_deg": 0.0},
                },
                {
                    "op": "replace",
                    "path": "/view_2d/slice",
                    "value": {"axis": "z", "index": 1, "slab": {"thickness_vox": 1, "mode": "single"}},
                },
                {
                    "op": "replace",
                    "path": "/view_2d/orthogonal_views_enabled",
                    "value": true,
                },
                {
                    "op": "replace",
                    "path": "/layers/0/image/interpolation",
                    "value": "nearest",
                }
            ],
        }),
    )
    .await;
    assert_eq!(update.status(), StatusCode::OK);

    let rendered = request_json(
        &router,
        "POST",
        "/render/image",
        json!({
            "schema_version": 1,
            "view_id": view_id,
            "output": {
                "format": "png",
                "delivery": "inline_base64",
                "width_px": 200,
                "height_px": 200,
            },
        }),
    )
    .await;
    assert_eq!(rendered.status(), StatusCode::OK);
    let payload = read_json_body(rendered).await;
    let warning_codes: Vec<&str> = payload["warnings"]
        .as_array()
        .expect("warnings array")
        .iter()
        .filter_map(|item| item.get("code").and_then(Value::as_str))
        .collect();
    assert!(warning_codes.contains(&"orthogonal_triptych_enabled"));

    let image = decode_png_rgba(
        payload["images"][0]["bytes_base64"]
            .as_str()
            .expect("base64 payload"),
    );
    let layout = test_triptych_layout(200, 200).expect("triptych layout");
    assert!(layout.xy.w > 0 && layout.xy.h > 0);
    let xy_border_luma = pixel_luma(&image, layout.xy.x, layout.xy.y);
    assert!(
        xy_border_luma > 0,
        "expected panel border/axis overlay to be visible at xy panel corner"
    );

    let xz_center_x = layout.xz.x + (layout.xz.w / 2);
    let xz_margin_y = (layout.xz.h / 6).max(2);
    let xz_top_luma = pixel_luma(&image, xz_center_x, layout.xz.y + xz_margin_y);
    let xz_bottom_luma = pixel_luma(
        &image,
        xz_center_x,
        layout.xz.y + layout.xz.h - xz_margin_y - 1,
    );
    assert!(
        xz_top_luma > xz_bottom_luma,
        "expected +z to map upward in xz panel: top={xz_top_luma} bottom={xz_bottom_luma}"
    );

    let yz_center_y = layout.yz.y + (layout.yz.h / 2);
    let yz_margin_x = (layout.yz.w / 6).max(2);
    let yz_left_luma = pixel_luma(&image, layout.yz.x + yz_margin_x, yz_center_y);
    let yz_right_luma = pixel_luma(
        &image,
        layout.yz.x + layout.yz.w - yz_margin_x - 1,
        yz_center_y,
    );
    assert!(
        yz_right_luma > yz_left_luma,
        "expected +z to map rightward in yz panel: left={yz_left_luma} right={yz_right_luma}"
    );

    let (xy_origin_x, xy_origin_y, xy_axis_len) = test_overlay_origin_and_len(layout.xy);
    let green_up = pixel_green_dominance(
        &image,
        xy_origin_x,
        xy_origin_y.saturating_sub(xy_axis_len / 2),
    );
    let green_down = pixel_green_dominance(
        &image,
        xy_origin_x,
        (xy_origin_y + (xy_axis_len / 2)).min(layout.xy.y + layout.xy.h - 2),
    );
    assert!(
        green_up > green_down,
        "expected +y overlay arrow to point upward in xy panel: up={green_up} down={green_down}"
    );
}

async fn open_view(router: &axum::Router, dataset_path: &Path) -> String {
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
        .expect("dataset id")
        .to_owned();

    let created = request_json(
        router,
        "POST",
        "/view/create",
        json!({"schema_version": 1, "dataset_id": dataset_id, "mode": "2d"}),
    )
    .await;
    assert_eq!(created.status(), StatusCode::OK);
    read_json_body(created).await["view_state"]["view_id"]
        .as_str()
        .expect("view id")
        .to_owned()
}

fn decode_png_size(bytes_base64: &str) -> (u32, u32) {
    let decoded = BASE64_STANDARD.decode(bytes_base64).expect("decode base64");
    let image = ImageReader::new(std::io::Cursor::new(decoded))
        .with_guessed_format()
        .expect("guess image format")
        .decode()
        .expect("decode png")
        .to_rgba8();
    image.dimensions()
}

fn decode_png_rgba(bytes_base64: &str) -> RgbaImage {
    let decoded = BASE64_STANDARD.decode(bytes_base64).expect("decode base64");
    ImageReader::new(std::io::Cursor::new(decoded))
        .with_guessed_format()
        .expect("guess image format")
        .decode()
        .expect("decode png")
        .to_rgba8()
}

fn pixel_luma(image: &RgbaImage, x: u32, y: u32) -> u32 {
    let pixel = image.get_pixel(x, y);
    u32::from(pixel[0]) + u32::from(pixel[1]) + u32::from(pixel[2])
}

fn pixel_green_dominance(image: &RgbaImage, x: u32, y: u32) -> i16 {
    let pixel = image.get_pixel(x, y);
    let g = i16::from(pixel[1]);
    let r = i16::from(pixel[0]);
    let b = i16::from(pixel[2]);
    g - r.max(b)
}

#[derive(Debug, Clone, Copy)]
struct TestRect {
    x: u32,
    y: u32,
    w: u32,
    h: u32,
}

#[derive(Debug, Clone, Copy)]
struct TestTriptychLayout {
    xy: TestRect,
    yz: TestRect,
    xz: TestRect,
}

fn test_triptych_layout(width: u32, height: u32) -> Option<TestTriptychLayout> {
    let side_w = width / 5;
    let side_h = height / 5;
    if side_w < 16 || side_h < 16 {
        return None;
    }
    let xy_w = width.checked_sub(side_w.checked_mul(2)?)?;
    let xy_h = height.checked_sub(side_h.checked_mul(2)?)?;
    if xy_w < 16 || xy_h < 16 {
        return None;
    }

    Some(TestTriptychLayout {
        xy: TestRect {
            x: side_w,
            y: side_h,
            w: xy_w,
            h: xy_h,
        },
        yz: TestRect {
            x: side_w + xy_w,
            y: side_h,
            w: side_w,
            h: xy_h,
        },
        xz: TestRect {
            x: side_w,
            y: 0,
            w: xy_w,
            h: side_h,
        },
    })
}

fn test_overlay_origin_and_len(panel: TestRect) -> (u32, u32, u32) {
    let min_dim = panel.w.min(panel.h);
    let axis_len = ((min_dim / 4).max(12)).min(36);
    let origin_x = (panel.x + 10).min(panel.x + panel.w - 2);
    let origin_y = (panel.y + panel.h - 10).max(panel.y + 1);
    (origin_x, origin_y, axis_len)
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

async fn request_get(
    router: &axum::Router,
    path: &str,
    params: Option<&[(&str, &str)]>,
) -> axum::response::Response {
    let uri = if let Some(params) = params {
        let query = params
            .iter()
            .map(|(key, value)| format!("{key}={value}"))
            .collect::<Vec<String>>()
            .join("&");
        format!("{path}?{query}")
    } else {
        path.to_owned()
    };

    router
        .clone()
        .oneshot(
            Request::builder()
                .method("GET")
                .uri(uri)
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

fn normalize_lexical(path: &Path) -> PathBuf {
    let mut normalized = PathBuf::new();
    for component in path.components() {
        match component {
            std::path::Component::Prefix(prefix) => normalized.push(prefix.as_os_str()),
            std::path::Component::RootDir => normalized.push(Path::new("/")),
            std::path::Component::CurDir => {}
            std::path::Component::ParentDir => {
                normalized.pop();
            }
            std::path::Component::Normal(segment) => normalized.push(segment),
        }
    }
    normalized
}
