use std::fs;
use std::net::SocketAddr;
use std::path::Path;

use futures::{SinkExt, StreamExt};
use lucida_engine::{
    ChannelBlockPackaging, ChunkAssetKind, ChunkKey, EngineRuntimeConfig, PayloadCodec,
    run_runtime_server,
};
use reqwest::StatusCode;
use serde_json::json;
use tiff::tags::Tag;
use tokio::net::TcpListener;
use tokio::sync::oneshot;
use tokio::time::{Duration, timeout};
use tokio_tungstenite::tungstenite::Message;

struct RuntimeFixture {
    address: SocketAddr,
    shutdown: Option<oneshot::Sender<()>>,
    task: tokio::task::JoinHandle<()>,
}

impl RuntimeFixture {
    async fn start(cache_root: &Path) -> Self {
        Self::start_with_config(EngineRuntimeConfig {
            cache_root: cache_root.to_path_buf(),
            ..EngineRuntimeConfig::default()
        })
        .await
    }

    async fn start_with_config(config: EngineRuntimeConfig) -> Self {
        let listener = TcpListener::bind("127.0.0.1:0")
            .await
            .expect("test runtime should bind an ephemeral port");
        let address = listener
            .local_addr()
            .expect("bound runtime should expose local addr");
        let (shutdown_tx, shutdown_rx) = oneshot::channel();
        let task = tokio::spawn(async move {
            run_runtime_server(listener, config, shutdown_rx)
                .await
                .expect("runtime should run cleanly");
        });
        Self {
            address,
            shutdown: Some(shutdown_tx),
            task,
        }
    }

    fn http_base(&self) -> String {
        format!("http://{}", self.address)
    }

    fn ws_base(&self) -> String {
        format!("ws://{}", self.address)
    }

    async fn stop(mut self) {
        if let Some(shutdown) = self.shutdown.take() {
            let _ = shutdown.send(());
        }
        let _ = self.task.await;
    }
}

fn unique_path(prefix: &str) -> std::path::PathBuf {
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .expect("clock should be after unix epoch")
        .as_nanos();
    std::env::temp_dir().join(format!(
        "lucida_runtime_integration_{prefix}_{}_{}",
        std::process::id(),
        nanos
    ))
}

fn preview_payload_path(
    cache_root: &Path,
    source_id: &str,
    generation_seq: u64,
    lod: u8,
) -> String {
    cache_root
        .join(source_id)
        .join(format!("gen_{generation_seq:08}"))
        .join("preview2d")
        .join(format!("lod_{lod}.pgm"))
        .display()
        .to_string()
}

fn data_plane_url(runtime: &RuntimeFixture, chunk_key: ChunkKey) -> String {
    format!(
        "{}/v1/data/{}",
        runtime.http_base(),
        chunk_key.format_path().trim_start_matches('/')
    )
}

fn write_minimal_rgb_tiff(path: &Path) {
    write_rgb_tiff(path, 32, 16);
}

fn write_rgb_tiff(path: &Path, width: u32, height: u32) {
    let file = fs::File::create(path).expect("tiff fixture file should be created");
    let mut encoder =
        tiff::encoder::TiffEncoder::new(file).expect("tiff fixture encoder should be created");
    let mut pixels = Vec::with_capacity((width as usize) * (height as usize) * 3);
    for y in 0..height {
        for x in 0..width {
            pixels.push((x as u8).wrapping_mul(7));
            pixels.push((y as u8).wrapping_mul(9));
            pixels.push((x as u8).wrapping_add(y as u8));
        }
    }
    encoder
        .new_image::<tiff::encoder::colortype::RGB8>(width, height)
        .expect("tiff fixture image should be created")
        .write_data(&pixels)
        .expect("tiff fixture pixels should be written");
}

async fn recv_text_frame(
    stream: &mut tokio_tungstenite::WebSocketStream<
        tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>,
    >,
) -> serde_json::Value {
    let frame = timeout(Duration::from_secs(2), stream.next())
        .await
        .expect("runtime should respond within timeout")
        .expect("websocket stream should stay open")
        .expect("websocket frame should be valid");
    match frame {
        Message::Text(text) => {
            serde_json::from_str(&text).expect("runtime should send valid JSON text frames")
        }
        other => panic!("unexpected non-text websocket frame: {other:?}"),
    }
}

fn parse_pgm(payload: &[u8]) -> (u64, u64, u16, Vec<u16>) {
    let mut newline_indices = payload
        .iter()
        .enumerate()
        .filter_map(|(index, byte)| (*byte == b'\n').then_some(index));
    let magic_end = newline_indices
        .next()
        .expect("pgm payload should include magic line");
    let dims_end = newline_indices
        .next()
        .expect("pgm payload should include dimensions line");
    let max_value_end = newline_indices
        .next()
        .expect("pgm payload should include max-value line");

    let magic = std::str::from_utf8(&payload[..magic_end]).expect("pgm magic should be utf-8");
    assert_eq!(magic, "P5");

    let dims = std::str::from_utf8(&payload[(magic_end + 1)..dims_end])
        .expect("pgm dimensions should be utf-8");
    let mut dims_parts = dims.split_ascii_whitespace();
    let width = dims_parts
        .next()
        .expect("pgm dimensions should include width")
        .parse::<u64>()
        .expect("pgm width should parse as u64");
    let height = dims_parts
        .next()
        .expect("pgm dimensions should include height")
        .parse::<u64>()
        .expect("pgm height should parse as u64");

    let max_value = std::str::from_utf8(&payload[(dims_end + 1)..max_value_end])
        .expect("pgm max value should be utf-8");
    let max_value = max_value
        .parse::<u16>()
        .expect("pgm max value should parse as u16");

    let expected_pixel_len = (width as usize)
        .checked_mul(height as usize)
        .expect("pgm dimensions should not overflow");
    let payload_body = &payload[(max_value_end + 1)..];
    let pixels = if max_value <= 255 {
        assert_eq!(
            payload_body.len(),
            expected_pixel_len,
            "8-bit pgm payload length should match declared dimensions"
        );
        payload_body
            .iter()
            .copied()
            .map(u16::from)
            .collect::<Vec<_>>()
    } else {
        assert_eq!(
            payload_body.len(),
            expected_pixel_len * 2,
            "16-bit pgm payload length should match declared dimensions"
        );
        payload_body
            .chunks_exact(2)
            .map(|chunk| u16::from_be_bytes([chunk[0], chunk[1]]))
            .collect::<Vec<_>>()
    };
    (width, height, max_value, pixels)
}

fn expected_tiff_fixture_luma(width: usize, height: usize) -> Vec<u16> {
    let mut pixels = Vec::with_capacity(width * height);
    for _y in 0..height {
        for x in 0..width {
            pixels.push(u16::from((x as u8).wrapping_mul(7)));
        }
    }
    pixels
}

fn id_sequence(id: &str, prefix: &str) -> u64 {
    let expected_prefix = format!("{prefix}_");
    id.strip_prefix(&expected_prefix)
        .expect("id should include expected prefix")
        .parse::<u64>()
        .expect("id suffix should parse as u64")
}

fn write_gray16_tiff(path: &Path, width: u32, height: u32, pixels: &[u16]) {
    let file = fs::File::create(path).expect("tiff fixture file should be created");
    let mut encoder =
        tiff::encoder::TiffEncoder::new(file).expect("tiff fixture encoder should be created");
    encoder
        .new_image::<tiff::encoder::colortype::Gray16>(width, height)
        .expect("tiff fixture image should be created")
        .write_data(pixels)
        .expect("tiff fixture pixels should be written");
}

fn write_tczyx_ome_tiff(
    path: &Path,
    size_t: u64,
    size_c: u64,
    size_z: u64,
    width: u32,
    height: u32,
) {
    let file = fs::File::create(path).expect("OME-TIFF fixture file should be created");
    let mut encoder =
        tiff::encoder::TiffEncoder::new(file).expect("OME-TIFF fixture encoder should be created");

    let mut wrote_description = false;
    for t in 0..size_t {
        for c in 0..size_c {
            for z in 0..size_z {
                let mut image = encoder
                    .new_image::<tiff::encoder::colortype::Gray16>(width, height)
                    .expect("OME-TIFF image should be created");
                if !wrote_description {
                    let image_description = format!(
                        r#"<?xml version="1.0" encoding="UTF-8"?>
<OME>
  <Image ID="Image:0">
    <Pixels DimensionOrder="XYZCT" SizeT="{size_t}" SizeC="{size_c}" SizeZ="{size_z}" SizeY="{height}" SizeX="{width}" Type="uint16"/>
  </Image>
</OME>"#
                    );
                    image
                        .encoder()
                        .write_tag(Tag::ImageDescription, image_description.as_str())
                        .expect("OME metadata should be written");
                    wrote_description = true;
                }

                let mut pixels = Vec::with_capacity((width as usize) * (height as usize));
                for y in 0..height as u64 {
                    for x in 0..width as u64 {
                        let value = (t * 1000) + (c * 100) + (z * 10) + (y * width as u64) + x;
                        pixels.push(
                            u16::try_from(value)
                                .expect("fixture pixel values should fit in uint16"),
                        );
                    }
                }

                image
                    .write_data(&pixels)
                    .expect("OME-TIFF image pixels should be written");
            }
        }
    }
}

fn expected_tczyx_pixels(t: u64, c: u64, z: u64, width: u32, height: u32) -> Vec<u16> {
    let mut pixels = Vec::with_capacity((width as usize) * (height as usize));
    for y in 0..height as u64 {
        for x in 0..width as u64 {
            let value = (t * 1000) + (c * 100) + (z * 10) + (y * width as u64) + x;
            pixels.push(u16::try_from(value).expect("fixture pixel values should fit in uint16"));
        }
    }
    pixels
}

#[tokio::test]
async fn runtime_supports_attach_command_events_and_reconnect() {
    let cache_root = unique_path("ws");
    fs::create_dir_all(&cache_root).expect("cache root should be created");
    let runtime = RuntimeFixture::start(&cache_root).await;
    let client = reqwest::Client::new();

    let create_response = client
        .post(format!("{}/v1/sessions", runtime.http_base()))
        .json(&json!({ "name": "runtime-session" }))
        .send()
        .await
        .expect("session creation request should succeed");
    assert_eq!(create_response.status(), StatusCode::CREATED);
    let created: serde_json::Value = create_response
        .json()
        .await
        .expect("create response should parse as JSON");
    let session_id = created["session_id"]
        .as_str()
        .expect("created session id should be present")
        .to_owned();

    let connect_url = format!("{}/v1/sessions/{session_id}/connect", runtime.ws_base());
    let (mut socket, _) = tokio_tungstenite::connect_async(connect_url)
        .await
        .expect("websocket connect should succeed");

    socket
        .send(Message::Text(
            json!({
                "message_type": "attach",
                "client_label": "browser-a",
                "requested_permission": "control",
                "auth": {
                    "mode": "control",
                    "token": "control-token"
                }
            })
            .to_string()
            .into(),
        ))
        .await
        .expect("attach frame should send");

    let snapshot = recv_text_frame(&mut socket).await;
    assert_eq!(snapshot["message_type"], "session.snapshot");
    assert_eq!(snapshot["session_id"], session_id);
    assert_eq!(
        snapshot["snapshot"]["session"]["session_id"],
        session_id.as_str()
    );

    let client_id = snapshot["snapshot"]["client_view"]["client_id"]
        .as_str()
        .expect("snapshot should include client id")
        .to_owned();

    socket
        .send(Message::Text(
            json!({
                "message_type": "command",
                "schema_version": "lucida-proto-0.1",
                "session_id": session_id,
                "request_id": "req_lease_1",
                "client_id": client_id,
                "client_seq": 1,
                "op": "lease.request",
                "scope": "scene_shared",
                "requires_lease": false,
                "args": {}
            })
            .to_string()
            .into(),
        ))
        .await
        .expect("lease request frame should send");

    socket
        .send(Message::Text(
            json!({
                "message_type": "command",
                "schema_version": "lucida-proto-0.1",
                "session_id": session_id,
                "request_id": "req_layer_1",
                "client_id": client_id,
                "client_seq": 2,
                "op": "scene.layer_add",
                "scope": "scene_shared",
                "requires_lease": true,
                "args": { "name": "runtime-layer" }
            })
            .to_string()
            .into(),
        ))
        .await
        .expect("layer add frame should send");

    let mut layer_event_seen = false;
    let mut event_revisions: Vec<u64> = Vec::new();
    for _ in 0..8 {
        let maybe_frame = timeout(Duration::from_millis(500), socket.next()).await;
        let frame = match maybe_frame {
            Ok(Some(Ok(Message::Text(text)))) => serde_json::from_str::<serde_json::Value>(&text)
                .expect("runtime should send valid JSON text frames"),
            Ok(Some(Ok(Message::Binary(_))))
            | Ok(Some(Ok(Message::Ping(_))))
            | Ok(Some(Ok(Message::Pong(_)))) => continue,
            Ok(Some(Ok(Message::Close(_)))) | Ok(None) | Err(_) => break,
            Ok(Some(Err(error))) => panic!("websocket frame should be valid: {error}"),
            Ok(Some(Ok(other))) => panic!("unexpected frame variant: {other:?}"),
        };
        if frame["message_type"] == "event" {
            let session_rev = frame["session_rev"]
                .as_u64()
                .expect("event should include session_rev");
            event_revisions.push(session_rev);
            if frame["event_type"] == "scene_layer_upsert" {
                layer_event_seen = true;
            }
        }
    }
    assert!(
        layer_event_seen,
        "expected scene_layer_upsert event from layer_add"
    );
    assert!(
        event_revisions
            .windows(2)
            .all(|window| window[0] <= window[1]),
        "event session revisions should be monotonic"
    );

    socket
        .close(None)
        .await
        .expect("closing first websocket should succeed");

    let reconnect_url = format!("{}/v1/sessions/{session_id}/connect", runtime.ws_base());
    let (mut reconnect_socket, _) = tokio_tungstenite::connect_async(reconnect_url)
        .await
        .expect("reconnect websocket should succeed");
    reconnect_socket
        .send(Message::Text(
            json!({
                "message_type": "reconnect",
                "client_label": "browser-a",
                "requested_permission": "control",
                "previous_client_id": client_id,
                "auth": {
                    "mode": "control",
                    "token": "control-token"
                }
            })
            .to_string()
            .into(),
        ))
        .await
        .expect("reconnect frame should send");
    let reconnect_snapshot = recv_text_frame(&mut reconnect_socket).await;
    assert_eq!(reconnect_snapshot["message_type"], "session.snapshot");
    assert_eq!(
        reconnect_snapshot["snapshot"]["session"]["session_id"],
        session_id.as_str()
    );
    let reconnected_client_id = reconnect_snapshot["snapshot"]["client_view"]["client_id"]
        .as_str()
        .expect("reconnect snapshot should include client id");
    assert_ne!(reconnected_client_id, client_id.as_str());

    reconnect_socket
        .close(None)
        .await
        .expect("closing reconnect websocket should succeed");
    runtime.stop().await;
    fs::remove_dir_all(cache_root).expect("cache root cleanup should succeed");
}

#[tokio::test]
async fn runtime_persists_id_allocator_counters_across_restarts() {
    let cache_root = unique_path("id_persistence");
    fs::create_dir_all(&cache_root).expect("cache root should be created");
    let client = reqwest::Client::new();

    let runtime_first = RuntimeFixture::start(&cache_root).await;
    let first_create = client
        .post(format!("{}/v1/sessions", runtime_first.http_base()))
        .json(&json!({ "name": "first-runtime-session" }))
        .send()
        .await
        .expect("first runtime create session request should succeed");
    assert_eq!(first_create.status(), StatusCode::CREATED);
    let first_body: serde_json::Value = first_create
        .json()
        .await
        .expect("first runtime create response should parse as JSON");
    let first_session_id = first_body["session_id"]
        .as_str()
        .expect("first runtime create response should include session id")
        .to_owned();
    runtime_first.stop().await;

    let runtime_second = RuntimeFixture::start(&cache_root).await;
    let second_create = client
        .post(format!("{}/v1/sessions", runtime_second.http_base()))
        .json(&json!({ "name": "second-runtime-session" }))
        .send()
        .await
        .expect("second runtime create session request should succeed");
    assert_eq!(second_create.status(), StatusCode::CREATED);
    let second_body: serde_json::Value = second_create
        .json()
        .await
        .expect("second runtime create response should parse as JSON");
    let second_session_id = second_body["session_id"]
        .as_str()
        .expect("second runtime create response should include session id")
        .to_owned();
    runtime_second.stop().await;

    assert_eq!(first_session_id, "sess_00000001");
    assert_eq!(second_session_id, "sess_00000002");
    assert!(id_sequence(&second_session_id, "sess") > id_sequence(&first_session_id, "sess"));

    fs::remove_dir_all(cache_root).expect("cache root cleanup should succeed");
}

#[tokio::test]
async fn runtime_serves_data_plane_get_and_head() {
    let cache_root = unique_path("data");
    fs::create_dir_all(&cache_root).expect("cache root should be created");

    let source_id = "src_runtime";
    let generation_seq = 1_u64;
    let lod = 0_u8;
    let preview_path = preview_payload_path(&cache_root, source_id, generation_seq, lod);
    let preview_parent = Path::new(&preview_path)
        .parent()
        .expect("preview path should have parent");
    fs::create_dir_all(preview_parent).expect("preview dir should be created");
    fs::write(&preview_path, b"P5\n1 1\n255\n\x80").expect("preview payload write should succeed");

    let runtime = RuntimeFixture::start(&cache_root).await;
    let client = reqwest::Client::new();
    let chunk_path = ChunkKey {
        source_id: source_id.to_owned(),
        generation_seq,
        asset_kind: ChunkAssetKind::Preview2d,
        lod,
        t: 0,
        z: 0,
        channel_block: 0,
        y: 0,
        x: 0,
    }
    .format_path();
    let escaped_path = chunk_path.trim_start_matches('/');
    let url = format!("{}/v1/data/{escaped_path}", runtime.http_base());

    let get_response = client
        .get(&url)
        .send()
        .await
        .expect("data GET should succeed");
    assert_eq!(get_response.status(), StatusCode::OK);
    assert_eq!(
        get_response
            .headers()
            .get("access-control-allow-origin")
            .and_then(|value| value.to_str().ok()),
        Some("*")
    );
    assert_eq!(
        get_response
            .headers()
            .get("content-type")
            .and_then(|value| value.to_str().ok()),
        Some("image/x-portable-graymap")
    );
    let get_body = get_response
        .bytes()
        .await
        .expect("GET body should be readable");
    assert_eq!(get_body.as_ref(), b"P5\n1 1\n255\n\x80");

    let head_response = client
        .head(&url)
        .send()
        .await
        .expect("data HEAD should succeed");
    assert_eq!(head_response.status(), StatusCode::OK);
    assert_eq!(
        head_response
            .headers()
            .get("access-control-allow-origin")
            .and_then(|value| value.to_str().ok()),
        Some("*")
    );
    let head_body = head_response
        .bytes()
        .await
        .expect("HEAD body should be readable");
    assert!(
        head_body.is_empty(),
        "HEAD response should not include a body"
    );

    runtime.stop().await;
    fs::remove_dir_all(cache_root).expect("cache root cleanup should succeed");
}

#[tokio::test]
async fn runtime_source_open_endpoint_accepts_cors_preflight() {
    let cache_root = unique_path("cors_preflight");
    fs::create_dir_all(&cache_root).expect("cache root should be created");
    let runtime = RuntimeFixture::start(&cache_root).await;
    let client = reqwest::Client::new();

    let create_response = client
        .post(format!("{}/v1/sessions", runtime.http_base()))
        .json(&json!({ "name": "runtime-cors-preflight" }))
        .send()
        .await
        .expect("session creation request should succeed");
    assert_eq!(create_response.status(), StatusCode::CREATED);
    let created: serde_json::Value = create_response
        .json()
        .await
        .expect("create response should parse as JSON");
    let session_id = created["session_id"]
        .as_str()
        .expect("created session id should be present");

    let response = client
        .request(
            reqwest::Method::OPTIONS,
            format!("{}/v1/sessions/{session_id}/sources", runtime.http_base()),
        )
        .header("origin", "http://127.0.0.1:5173")
        .header("access-control-request-method", "POST")
        .header("access-control-request-headers", "content-type")
        .send()
        .await
        .expect("OPTIONS preflight request should succeed");
    assert_eq!(response.status(), StatusCode::NO_CONTENT);
    assert_eq!(
        response
            .headers()
            .get("access-control-allow-origin")
            .and_then(|value| value.to_str().ok()),
        Some("*")
    );
    assert_eq!(
        response
            .headers()
            .get("access-control-allow-methods")
            .and_then(|value| value.to_str().ok()),
        Some("GET, HEAD, POST, OPTIONS")
    );
    assert_eq!(
        response
            .headers()
            .get("access-control-allow-headers")
            .and_then(|value| value.to_str().ok()),
        Some("content-type")
    );

    runtime.stop().await;
    fs::remove_dir_all(cache_root).expect("cache root cleanup should succeed");
}

#[tokio::test]
async fn runtime_open_source_emits_progress_and_serves_source_derived_preview_and_tile() {
    let cache_root = unique_path("open_source_cache");
    fs::create_dir_all(&cache_root).expect("cache root should be created");
    let fixture_dir = unique_path("open_source_fixture");
    fs::create_dir_all(&fixture_dir).expect("fixture root should be created");
    let source_path = fixture_dir.join("runtime-open-source.tiff");
    write_minimal_rgb_tiff(&source_path);

    let runtime = RuntimeFixture::start(&cache_root).await;
    let client = reqwest::Client::new();

    let create_response = client
        .post(format!("{}/v1/sessions", runtime.http_base()))
        .json(&json!({ "name": "runtime-open-source" }))
        .send()
        .await
        .expect("session creation request should succeed");
    assert_eq!(create_response.status(), StatusCode::CREATED);
    let created: serde_json::Value = create_response
        .json()
        .await
        .expect("create response should parse as JSON");
    let session_id = created["session_id"]
        .as_str()
        .expect("created session id should be present")
        .to_owned();

    let connect_url = format!("{}/v1/sessions/{session_id}/connect", runtime.ws_base());
    let (mut socket, _) = tokio_tungstenite::connect_async(connect_url)
        .await
        .expect("websocket connect should succeed");
    socket
        .send(Message::Text(
            json!({
                "message_type": "attach",
                "client_label": "browser-open-source",
                "requested_permission": "view",
                "auth": {
                    "mode": "open_view",
                    "token": null
                }
            })
            .to_string()
            .into(),
        ))
        .await
        .expect("attach frame should send");
    let _snapshot = recv_text_frame(&mut socket).await;

    let open_source_response = client
        .post(format!(
            "{}/v1/sessions/{session_id}/sources",
            runtime.http_base()
        ))
        .json(&json!({
            "name": "runtime-source",
            "uri": source_path.display().to_string(),
        }))
        .send()
        .await
        .expect("open source request should succeed");
    assert_eq!(open_source_response.status(), StatusCode::CREATED);
    let open_source_body: serde_json::Value = open_source_response
        .json()
        .await
        .expect("open source response should parse as JSON");
    let source_id = open_source_body["source_id"]
        .as_str()
        .expect("source id should be returned");
    let generation_seq = open_source_body["generation_seq"]
        .as_u64()
        .expect("generation seq should be returned");
    assert_eq!(generation_seq, 1);

    let mut event_types = Vec::<String>::new();
    let mut preview_available = false;
    let mut dataset_dtype: Option<String> = None;
    let mut generation_tile_layout_lod0: Option<(u64, u64, u32, u32)> = None;
    let started_at = tokio::time::Instant::now();
    while started_at.elapsed() < Duration::from_secs(3) {
        let maybe_frame = timeout(Duration::from_millis(250), socket.next()).await;
        let frame = match maybe_frame {
            Ok(Some(Ok(Message::Text(text)))) => serde_json::from_str::<serde_json::Value>(&text)
                .expect("runtime should send valid JSON text frames"),
            Ok(Some(Ok(Message::Binary(_))))
            | Ok(Some(Ok(Message::Ping(_))))
            | Ok(Some(Ok(Message::Pong(_)))) => continue,
            Ok(Some(Ok(Message::Close(_)))) | Ok(None) => break,
            Ok(Some(Err(error))) => panic!("websocket frame should be valid: {error}"),
            Ok(Some(Ok(other))) => panic!("unexpected frame variant: {other:?}"),
            Err(_) => continue,
        };
        if frame["message_type"] != "event" {
            continue;
        }
        let event_type = frame["event_type"]
            .as_str()
            .expect("event should include event_type")
            .to_owned();
        if event_type == "scene_dataset_upsert" {
            dataset_dtype = frame["payload"]["dtype"].as_str().map(ToOwned::to_owned);
        }
        if event_type == "source_generation_progress" || event_type == "source_generation_ready" {
            preview_available = frame["payload"]["previewReady"].as_bool().unwrap_or(false);
            let lod0 = frame["payload"]["tileLayout"]["lods"]
                .as_array()
                .and_then(|lods| lods.first())
                .cloned();
            if let Some(lod0) = lod0 {
                let width = lod0["width"].as_u64();
                let height = lod0["height"].as_u64();
                let rows = lod0["rows"]
                    .as_u64()
                    .and_then(|value| u32::try_from(value).ok());
                let cols = lod0["cols"]
                    .as_u64()
                    .and_then(|value| u32::try_from(value).ok());
                if let (Some(width), Some(height), Some(rows), Some(cols)) =
                    (width, height, rows, cols)
                {
                    generation_tile_layout_lod0 = Some((width, height, rows, cols));
                }
            }
        }
        event_types.push(event_type.clone());
        if event_type == "source_generation_ready" {
            break;
        }
    }

    assert!(
        event_types
            .iter()
            .any(|event| event == "scene_source_upsert")
    );
    assert!(
        event_types
            .iter()
            .any(|event| event == "scene_dataset_upsert")
    );
    assert!(
        event_types
            .iter()
            .any(|event| event == "source_generation_detected")
    );
    assert!(
        event_types
            .iter()
            .any(|event| event == "source_generation_started")
    );
    assert!(
        event_types
            .iter()
            .any(|event| event == "source_generation_progress")
    );
    assert!(
        event_types
            .iter()
            .any(|event| event == "source_generation_ready")
    );
    assert_eq!(dataset_dtype.as_deref(), Some("uint8"));
    assert!(preview_available);
    assert_eq!(generation_tile_layout_lod0, Some((32, 16, 1, 1)));

    let snapshot_response = client
        .get(format!(
            "{}/v1/sessions/{session_id}/snapshot",
            runtime.http_base()
        ))
        .send()
        .await
        .expect("snapshot request should succeed");
    assert_eq!(snapshot_response.status(), StatusCode::OK);
    let snapshot_body: serde_json::Value = snapshot_response
        .json()
        .await
        .expect("snapshot response should parse as JSON");
    let source_generations = snapshot_body["snapshot"]["shared_scene"]["source_generations"]
        .as_object()
        .expect("snapshot should include source_generations map");
    assert!(
        !source_generations.is_empty(),
        "source_generations should include at least one generation payload"
    );
    let first_generation = source_generations
        .values()
        .next()
        .expect("source generation payload should be present");
    assert_eq!(
        first_generation["tileLayout"]["lods"][0]["width"].as_u64(),
        Some(32)
    );
    assert_eq!(
        first_generation["tileLayout"]["lods"][0]["height"].as_u64(),
        Some(16)
    );

    let expected_pixels = expected_tiff_fixture_luma(32, 16);

    let preview_url = data_plane_url(
        &runtime,
        ChunkKey {
            source_id: source_id.to_owned(),
            generation_seq,
            asset_kind: ChunkAssetKind::Preview2d,
            lod: 0,
            t: 0,
            z: 0,
            channel_block: 0,
            y: 0,
            x: 0,
        },
    );
    let preview_response = client
        .get(&preview_url)
        .send()
        .await
        .expect("preview request should succeed");
    assert_eq!(preview_response.status(), StatusCode::OK);
    assert_eq!(
        preview_response
            .headers()
            .get("content-type")
            .and_then(|value| value.to_str().ok()),
        Some("image/x-portable-graymap")
    );
    let preview_payload = preview_response
        .bytes()
        .await
        .expect("preview payload should be readable");
    let (preview_width, preview_height, preview_max_value, preview_pixels) =
        parse_pgm(preview_payload.as_ref());
    assert_eq!(preview_width, 32);
    assert_eq!(preview_height, 16);
    assert_eq!(preview_max_value, 255);
    assert_eq!(preview_pixels, expected_pixels);

    let tile_url = data_plane_url(
        &runtime,
        ChunkKey {
            source_id: source_id.to_owned(),
            generation_seq,
            asset_kind: ChunkAssetKind::Tile2d,
            lod: 0,
            t: 0,
            z: 0,
            channel_block: 0,
            y: 0,
            x: 0,
        },
    );
    let tile_response = client
        .get(&tile_url)
        .send()
        .await
        .expect("tile request should succeed");
    assert_eq!(tile_response.status(), StatusCode::OK);
    assert_eq!(
        tile_response
            .headers()
            .get("content-encoding")
            .and_then(|value| value.to_str().ok()),
        Some("identity")
    );
    let tile_payload = tile_response
        .bytes()
        .await
        .expect("tile payload should be readable");
    let channel_packaging = ChannelBlockPackaging::default();
    let decoded_tile = channel_packaging
        .decode(tile_payload.as_ref())
        .expect("tile payload should decode as channel block");
    assert_eq!(decoded_tile.codec, PayloadCodec::Raw);
    let (tile_width, tile_height, tile_max_value, tile_pixels) = parse_pgm(&decoded_tile.payload);
    assert_eq!(tile_width, 32);
    assert_eq!(tile_height, 16);
    assert_eq!(tile_max_value, 255);
    assert_eq!(tile_pixels, expected_pixels);

    socket
        .close(None)
        .await
        .expect("closing websocket should succeed");
    runtime.stop().await;
    fs::remove_dir_all(cache_root).expect("cache root cleanup should succeed");
    fs::remove_dir_all(fixture_dir).expect("fixture cleanup should succeed");
}

#[tokio::test]
async fn runtime_open_source_returns_before_background_generation_finishes() {
    let cache_root = unique_path("open_source_async_cache");
    fs::create_dir_all(&cache_root).expect("cache root should be created");
    let fixture_dir = unique_path("open_source_async_fixture");
    fs::create_dir_all(&fixture_dir).expect("fixture root should be created");
    let source_path = fixture_dir.join("runtime-open-source-async.tiff");
    write_rgb_tiff(&source_path, 600, 600);

    let runtime = RuntimeFixture::start_with_config(EngineRuntimeConfig {
        cache_root: cache_root.clone(),
        generation_worker_startup_delay_ms: 250,
    })
    .await;
    let client = reqwest::Client::new();

    let create_response = client
        .post(format!("{}/v1/sessions", runtime.http_base()))
        .json(&json!({ "name": "runtime-open-source-async" }))
        .send()
        .await
        .expect("session creation request should succeed");
    assert_eq!(create_response.status(), StatusCode::CREATED);
    let created: serde_json::Value = create_response
        .json()
        .await
        .expect("create response should parse as JSON");
    let session_id = created["session_id"]
        .as_str()
        .expect("created session id should be present")
        .to_owned();

    let connect_url = format!("{}/v1/sessions/{session_id}/connect", runtime.ws_base());
    let (mut socket, _) = tokio_tungstenite::connect_async(connect_url)
        .await
        .expect("websocket connect should succeed");
    socket
        .send(Message::Text(
            json!({
                "message_type": "attach",
                "client_label": "browser-open-source-async",
                "requested_permission": "view",
                "auth": {
                    "mode": "open_view",
                    "token": null
                }
            })
            .to_string()
            .into(),
        ))
        .await
        .expect("attach frame should send");
    let _snapshot = recv_text_frame(&mut socket).await;

    let request_started_at = tokio::time::Instant::now();
    let open_source_response = client
        .post(format!(
            "{}/v1/sessions/{session_id}/sources",
            runtime.http_base()
        ))
        .json(&json!({
            "name": "runtime-source-async",
            "uri": source_path.display().to_string(),
        }))
        .send()
        .await
        .expect("open source request should succeed");
    let request_elapsed = request_started_at.elapsed();

    assert_eq!(open_source_response.status(), StatusCode::CREATED);
    assert!(
        request_elapsed < Duration::from_millis(200),
        "source open should return before delayed background generation completes; elapsed={request_elapsed:?}"
    );
    let open_source_body: serde_json::Value = open_source_response
        .json()
        .await
        .expect("open source response should parse as JSON");
    assert_eq!(
        open_source_body["generation_seq"]
            .as_u64()
            .expect("generation seq should be returned"),
        1
    );

    let mut saw_detected = false;
    let mut saw_started = false;
    let mut saw_progress = false;
    let mut saw_ready = false;
    let started_at = tokio::time::Instant::now();
    while started_at.elapsed() < Duration::from_secs(5) {
        let frame = timeout(Duration::from_millis(500), socket.next())
            .await
            .expect("websocket should receive generation event in time")
            .expect("websocket stream should stay open")
            .expect("websocket frame should be valid");
        let Message::Text(text) = frame else {
            continue;
        };
        let payload: serde_json::Value =
            serde_json::from_str(&text).expect("runtime should send valid JSON events");
        if payload["message_type"] != "event" {
            continue;
        }
        match payload["event_type"].as_str() {
            Some("source_generation_detected") => saw_detected = true,
            Some("source_generation_started") => saw_started = true,
            Some("source_generation_progress") => saw_progress = true,
            Some("source_generation_ready") => {
                saw_ready = true;
                break;
            }
            _ => {}
        }
    }
    assert!(saw_detected, "source_generation_detected should be emitted");
    assert!(saw_started, "source_generation_started should be emitted");
    assert!(saw_progress, "source_generation_progress should be emitted");
    assert!(saw_ready, "source_generation_ready should be emitted");

    runtime.stop().await;
    fs::remove_dir_all(cache_root).expect("cache root cleanup should succeed");
    fs::remove_dir_all(fixture_dir).expect("fixture cleanup should succeed");
}

#[tokio::test]
async fn runtime_background_generation_surfaces_failed_stage_event_on_build_error() {
    let cache_root = unique_path("open_source_failure_cache");
    fs::create_dir_all(&cache_root).expect("cache root should be created");
    let fixture_dir = unique_path("open_source_failure_fixture");
    fs::create_dir_all(&fixture_dir).expect("fixture root should be created");
    let source_path = fixture_dir.join("runtime-open-source-failure.tiff");
    write_rgb_tiff(&source_path, 64, 64);

    let runtime = RuntimeFixture::start_with_config(EngineRuntimeConfig {
        cache_root: cache_root.clone(),
        generation_worker_startup_delay_ms: 250,
    })
    .await;
    let client = reqwest::Client::new();

    let create_response = client
        .post(format!("{}/v1/sessions", runtime.http_base()))
        .json(&json!({ "name": "runtime-open-source-failure" }))
        .send()
        .await
        .expect("session creation request should succeed");
    assert_eq!(create_response.status(), StatusCode::CREATED);
    let created: serde_json::Value = create_response
        .json()
        .await
        .expect("create response should parse as JSON");
    let session_id = created["session_id"]
        .as_str()
        .expect("created session id should be present")
        .to_owned();

    let connect_url = format!("{}/v1/sessions/{session_id}/connect", runtime.ws_base());
    let (mut socket, _) = tokio_tungstenite::connect_async(connect_url)
        .await
        .expect("websocket connect should succeed");
    socket
        .send(Message::Text(
            json!({
                "message_type": "attach",
                "client_label": "browser-open-source-failure",
                "requested_permission": "view",
                "auth": {
                    "mode": "open_view",
                    "token": null
                }
            })
            .to_string()
            .into(),
        ))
        .await
        .expect("attach frame should send");
    let _snapshot = recv_text_frame(&mut socket).await;

    let open_source_response = client
        .post(format!(
            "{}/v1/sessions/{session_id}/sources",
            runtime.http_base()
        ))
        .json(&json!({
            "name": "runtime-source-failure",
            "uri": source_path.display().to_string(),
        }))
        .send()
        .await
        .expect("open source request should succeed");
    assert_eq!(open_source_response.status(), StatusCode::CREATED);

    fs::remove_file(&source_path).expect("fixture source should be removable after source open");

    let started_at = tokio::time::Instant::now();
    let mut saw_failed = false;
    let mut saw_source_error_status = false;
    while started_at.elapsed() < Duration::from_secs(5) {
        let frame = timeout(Duration::from_millis(500), socket.next())
            .await
            .expect("websocket should receive generation failure event in time")
            .expect("websocket stream should stay open")
            .expect("websocket frame should be valid");
        let Message::Text(text) = frame else {
            continue;
        };
        let payload: serde_json::Value =
            serde_json::from_str(&text).expect("runtime should send valid JSON events");
        if payload["message_type"] != "event" {
            continue;
        }
        if payload["event_type"] == "source_generation_failed" {
            assert_eq!(
                payload["payload"]["stage"]
                    .as_str()
                    .expect("failed payload stage should be string"),
                "failed"
            );
            saw_failed = true;
        }
        if payload["event_type"] == "scene_source_upsert" && payload["payload"]["status"] == "error"
        {
            saw_source_error_status = true;
        }
        if saw_failed && saw_source_error_status {
            break;
        }
    }
    assert!(
        saw_failed,
        "background generation should emit source_generation_failed when build errors"
    );
    assert!(
        saw_source_error_status,
        "source should transition to error status on generation failure"
    );

    runtime.stop().await;
    fs::remove_dir_all(cache_root).expect("cache root cleanup should succeed");
    fs::remove_dir_all(fixture_dir).expect("fixture cleanup should succeed");
}

#[tokio::test]
async fn runtime_data_plane_serves_non_zero_row_col_tiles_and_404s_missing_tiles() {
    let cache_root = unique_path("non_zero_tile_data_cache");
    fs::create_dir_all(&cache_root).expect("cache root should be created");
    let fixture_dir = unique_path("non_zero_tile_data_fixture");
    fs::create_dir_all(&fixture_dir).expect("fixture root should be created");
    let source_path = fixture_dir.join("runtime-non-zero-row-col.tiff");
    write_rgb_tiff(&source_path, 600, 600);

    let runtime = RuntimeFixture::start(&cache_root).await;
    let client = reqwest::Client::new();

    let create_response = client
        .post(format!("{}/v1/sessions", runtime.http_base()))
        .json(&json!({ "name": "runtime-non-zero-row-col" }))
        .send()
        .await
        .expect("session creation request should succeed");
    assert_eq!(create_response.status(), StatusCode::CREATED);
    let created: serde_json::Value = create_response
        .json()
        .await
        .expect("create response should parse as JSON");
    let session_id = created["session_id"]
        .as_str()
        .expect("created session id should be present")
        .to_owned();

    let open_source_response = client
        .post(format!(
            "{}/v1/sessions/{session_id}/sources",
            runtime.http_base()
        ))
        .json(&json!({
            "name": "runtime-non-zero-row-col-source",
            "uri": source_path.display().to_string(),
        }))
        .send()
        .await
        .expect("open source request should succeed");
    assert_eq!(open_source_response.status(), StatusCode::CREATED);
    let open_source_body: serde_json::Value = open_source_response
        .json()
        .await
        .expect("open source response should parse as JSON");
    let source_id = open_source_body["source_id"]
        .as_str()
        .expect("source id should be returned")
        .to_owned();
    let generation_seq = open_source_body["generation_seq"]
        .as_u64()
        .expect("generation seq should be returned");

    let served_tile_url = data_plane_url(
        &runtime,
        ChunkKey {
            source_id: source_id.clone(),
            generation_seq,
            asset_kind: ChunkAssetKind::Tile2d,
            lod: 0,
            t: 0,
            z: 0,
            channel_block: 0,
            y: 1,
            x: 1,
        },
    );
    let served_tile_response = client
        .get(&served_tile_url)
        .send()
        .await
        .expect("non-zero tile request should succeed");
    assert_eq!(served_tile_response.status(), StatusCode::OK);
    assert_eq!(
        served_tile_response
            .headers()
            .get("content-encoding")
            .and_then(|value| value.to_str().ok()),
        Some("identity")
    );
    assert_eq!(
        served_tile_response
            .headers()
            .get("cache-control")
            .and_then(|value| value.to_str().ok()),
        Some("public, max-age=31536000, immutable")
    );
    assert!(
        served_tile_response.headers().contains_key("etag"),
        "tile response should include immutable etag"
    );
    let served_payload = served_tile_response
        .bytes()
        .await
        .expect("served tile payload should be readable");
    let packaging = ChannelBlockPackaging::default();
    let decoded_tile = packaging
        .decode(served_payload.as_ref())
        .expect("served tile payload should decode as channel block");
    let (tile_width, tile_height, _, _) = parse_pgm(&decoded_tile.payload);
    assert_eq!(tile_width, 88);
    assert_eq!(tile_height, 88);

    let missing_tile_url = data_plane_url(
        &runtime,
        ChunkKey {
            source_id,
            generation_seq,
            asset_kind: ChunkAssetKind::Tile2d,
            lod: 0,
            t: 0,
            z: 0,
            channel_block: 0,
            y: 2,
            x: 1,
        },
    );
    let missing_response = client
        .get(&missing_tile_url)
        .send()
        .await
        .expect("missing non-zero tile request should return http response");
    assert_eq!(missing_response.status(), StatusCode::NOT_FOUND);

    runtime.stop().await;
    fs::remove_dir_all(cache_root).expect("cache root cleanup should succeed");
    fs::remove_dir_all(fixture_dir).expect("fixture cleanup should succeed");
}

#[tokio::test]
async fn runtime_open_uint16_source_serves_16bit_preview_and_tile_payloads() {
    let cache_root = unique_path("open_source_uint16_cache");
    fs::create_dir_all(&cache_root).expect("cache root should be created");
    let fixture_dir = unique_path("open_source_uint16_fixture");
    fs::create_dir_all(&fixture_dir).expect("fixture root should be created");
    let source_path = fixture_dir.join("runtime-open-source-uint16.tiff");
    let source_pixels: Vec<u16> = vec![87, 98, 109, 121];
    write_gray16_tiff(&source_path, 2, 2, &source_pixels);

    let runtime = RuntimeFixture::start(&cache_root).await;
    let client = reqwest::Client::new();

    let create_response = client
        .post(format!("{}/v1/sessions", runtime.http_base()))
        .json(&json!({ "name": "runtime-open-source-uint16" }))
        .send()
        .await
        .expect("session creation request should succeed");
    assert_eq!(create_response.status(), StatusCode::CREATED);
    let created: serde_json::Value = create_response
        .json()
        .await
        .expect("create response should parse as JSON");
    let session_id = created["session_id"]
        .as_str()
        .expect("created session id should be present")
        .to_owned();

    let open_source_response = client
        .post(format!(
            "{}/v1/sessions/{session_id}/sources",
            runtime.http_base()
        ))
        .json(&json!({
            "name": "runtime-source-uint16",
            "uri": source_path.display().to_string(),
        }))
        .send()
        .await
        .expect("open source request should succeed");
    assert_eq!(open_source_response.status(), StatusCode::CREATED);
    let open_source_body: serde_json::Value = open_source_response
        .json()
        .await
        .expect("open source response should parse as JSON");
    let source_id = open_source_body["source_id"]
        .as_str()
        .expect("source id should be returned");
    let generation_seq = open_source_body["generation_seq"]
        .as_u64()
        .expect("generation seq should be returned");
    assert_eq!(generation_seq, 1);

    let preview_url = data_plane_url(
        &runtime,
        ChunkKey {
            source_id: source_id.to_owned(),
            generation_seq,
            asset_kind: ChunkAssetKind::Preview2d,
            lod: 0,
            t: 0,
            z: 0,
            channel_block: 0,
            y: 0,
            x: 0,
        },
    );
    let preview_response = client
        .get(&preview_url)
        .send()
        .await
        .expect("preview request should succeed");
    assert_eq!(preview_response.status(), StatusCode::OK);
    let preview_payload = preview_response
        .bytes()
        .await
        .expect("preview payload should be readable");
    let (preview_width, preview_height, preview_max, preview_pixels) =
        parse_pgm(preview_payload.as_ref());
    assert_eq!(preview_width, 2);
    assert_eq!(preview_height, 2);
    assert_eq!(preview_max, u16::MAX);
    assert_eq!(preview_pixels, source_pixels);

    let tile_url = data_plane_url(
        &runtime,
        ChunkKey {
            source_id: source_id.to_owned(),
            generation_seq,
            asset_kind: ChunkAssetKind::Tile2d,
            lod: 0,
            t: 0,
            z: 0,
            channel_block: 0,
            y: 0,
            x: 0,
        },
    );
    let tile_response = client
        .get(&tile_url)
        .send()
        .await
        .expect("tile request should succeed");
    assert_eq!(tile_response.status(), StatusCode::OK);
    let tile_payload = tile_response
        .bytes()
        .await
        .expect("tile payload should be readable");
    let channel_packaging = ChannelBlockPackaging::default();
    let decoded_tile = channel_packaging
        .decode(tile_payload.as_ref())
        .expect("tile payload should decode as channel block");
    let (tile_width, tile_height, tile_max, tile_pixels) = parse_pgm(&decoded_tile.payload);
    assert_eq!(tile_width, 2);
    assert_eq!(tile_height, 2);
    assert_eq!(tile_max, u16::MAX);
    assert_eq!(tile_pixels, source_pixels);

    runtime.stop().await;
    fs::remove_dir_all(cache_root).expect("cache root cleanup should succeed");
    fs::remove_dir_all(fixture_dir).expect("fixture cleanup should succeed");
}

#[tokio::test]
async fn runtime_open_ome_tiff_serves_selected_t_z_c_planes() {
    let cache_root = unique_path("open_source_tczyx_cache");
    fs::create_dir_all(&cache_root).expect("cache root should be created");
    let fixture_dir = unique_path("open_source_tczyx_fixture");
    fs::create_dir_all(&fixture_dir).expect("fixture root should be created");
    let source_path = fixture_dir.join("runtime-open-source-tczyx.ome.tif");
    let width = 2_u32;
    let height = 1_u32;
    write_tczyx_ome_tiff(&source_path, 2, 2, 2, width, height);

    let runtime = RuntimeFixture::start(&cache_root).await;
    let client = reqwest::Client::new();

    let create_response = client
        .post(format!("{}/v1/sessions", runtime.http_base()))
        .json(&json!({ "name": "runtime-open-source-tczyx" }))
        .send()
        .await
        .expect("session creation request should succeed");
    assert_eq!(create_response.status(), StatusCode::CREATED);
    let created: serde_json::Value = create_response
        .json()
        .await
        .expect("create response should parse as JSON");
    let session_id = created["session_id"]
        .as_str()
        .expect("created session id should be present")
        .to_owned();

    let open_source_response = client
        .post(format!(
            "{}/v1/sessions/{session_id}/sources",
            runtime.http_base()
        ))
        .json(&json!({
            "name": "runtime-source-tczyx",
            "uri": source_path.display().to_string(),
        }))
        .send()
        .await
        .expect("open source request should succeed");
    assert_eq!(open_source_response.status(), StatusCode::CREATED);
    let open_source_body: serde_json::Value = open_source_response
        .json()
        .await
        .expect("open source response should parse as JSON");
    let source_id = open_source_body["source_id"]
        .as_str()
        .expect("source id should be returned");
    let generation_seq = open_source_body["generation_seq"]
        .as_u64()
        .expect("generation seq should be returned");
    assert_eq!(generation_seq, 1);

    let selections = [
        (0_u64, 0_u64, 0_u64),
        (1_u64, 0_u64, 0_u64),
        (0_u64, 1_u64, 0_u64),
        (1_u64, 1_u64, 1_u64),
    ];
    let channel_packaging = ChannelBlockPackaging::default();
    for (t, z, channel) in selections {
        let tile_url = data_plane_url(
            &runtime,
            ChunkKey {
                source_id: source_id.to_owned(),
                generation_seq,
                asset_kind: ChunkAssetKind::Tile2d,
                lod: 0,
                t: u32::try_from(t).expect("fixture t index should fit u32"),
                z: u32::try_from(z).expect("fixture z index should fit u32"),
                channel_block: u16::try_from(channel)
                    .expect("fixture channel index should fit u16"),
                y: 0,
                x: 0,
            },
        );

        let tile_response = client
            .get(&tile_url)
            .send()
            .await
            .expect("tile request should succeed");
        assert_eq!(tile_response.status(), StatusCode::OK);
        let tile_payload = tile_response
            .bytes()
            .await
            .expect("tile payload should be readable");
        let decoded_tile = channel_packaging
            .decode(tile_payload.as_ref())
            .expect("tile payload should decode as channel block");
        let (tile_width, tile_height, tile_max, tile_pixels) = parse_pgm(&decoded_tile.payload);
        assert_eq!(tile_width, u64::from(width));
        assert_eq!(tile_height, u64::from(height));
        assert_eq!(tile_max, u16::MAX);
        assert_eq!(
            tile_pixels,
            expected_tczyx_pixels(t, channel, z, width, height)
        );

        let preview_url = data_plane_url(
            &runtime,
            ChunkKey {
                source_id: source_id.to_owned(),
                generation_seq,
                asset_kind: ChunkAssetKind::Preview2d,
                lod: 0,
                t: u32::try_from(t).expect("fixture t index should fit u32"),
                z: u32::try_from(z).expect("fixture z index should fit u32"),
                channel_block: u16::try_from(channel)
                    .expect("fixture channel index should fit u16"),
                y: 0,
                x: 0,
            },
        );

        let preview_response = client
            .get(&preview_url)
            .send()
            .await
            .expect("preview request should succeed");
        assert_eq!(preview_response.status(), StatusCode::OK);
        let preview_payload = preview_response
            .bytes()
            .await
            .expect("preview payload should be readable");
        let (preview_width, preview_height, preview_max, preview_pixels) =
            parse_pgm(preview_payload.as_ref());
        assert_eq!(preview_width, u64::from(width));
        assert_eq!(preview_height, u64::from(height));
        assert_eq!(preview_max, u16::MAX);
        assert_eq!(
            preview_pixels,
            expected_tczyx_pixels(t, channel, z, width, height)
        );
    }

    runtime.stop().await;
    fs::remove_dir_all(cache_root).expect("cache root cleanup should succeed");
    fs::remove_dir_all(fixture_dir).expect("fixture cleanup should succeed");
}

#[tokio::test]
async fn runtime_rejects_attach_when_auth_mode_requires_token() {
    let cache_root = unique_path("invalid_auth");
    fs::create_dir_all(&cache_root).expect("cache root should be created");
    let runtime = RuntimeFixture::start(&cache_root).await;
    let client = reqwest::Client::new();

    let create_response = client
        .post(format!("{}/v1/sessions", runtime.http_base()))
        .json(&json!({ "name": "runtime-invalid-auth" }))
        .send()
        .await
        .expect("session creation request should succeed");
    assert_eq!(create_response.status(), StatusCode::CREATED);
    let created: serde_json::Value = create_response
        .json()
        .await
        .expect("create response should parse as JSON");
    let session_id = created["session_id"]
        .as_str()
        .expect("created session id should be present")
        .to_owned();

    let connect_url = format!("{}/v1/sessions/{session_id}/connect", runtime.ws_base());
    let (mut socket, _) = tokio_tungstenite::connect_async(connect_url)
        .await
        .expect("websocket connect should succeed");
    socket
        .send(Message::Text(
            json!({
                "message_type": "attach",
                "client_label": "browser-invalid-auth",
                "requested_permission": "view",
                "auth": {
                    "mode": "token_view",
                    "token": null
                }
            })
            .to_string()
            .into(),
        ))
        .await
        .expect("attach frame should send");
    let error_frame = recv_text_frame(&mut socket).await;
    assert_eq!(error_frame["message_type"], "error");
    assert_eq!(error_frame["code"], "validation_error");
    assert!(
        error_frame["message"]
            .as_str()
            .expect("error message should be a string")
            .contains("auth.token is required"),
    );

    socket
        .close(None)
        .await
        .expect("closing websocket should succeed");
    runtime.stop().await;
    fs::remove_dir_all(cache_root).expect("cache root cleanup should succeed");
}
