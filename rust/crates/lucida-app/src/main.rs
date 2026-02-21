use anyhow::Result;

#[cfg(unix)]
mod unix_app {
    use std::borrow::Cow;
    use std::collections::{BTreeMap, BTreeSet};
    use std::io::{BufRead, BufReader, BufWriter, Read, Write};
    use std::os::unix::net::UnixStream;
    use std::sync::mpsc::{self, Receiver, Sender, TryRecvError};
    use std::sync::Arc;
    use std::time::{Duration, Instant};

    use anyhow::{anyhow, bail, Context, Result};
    use lucida_protocol::{
        now_utc, EventEnvelope, FrameAxisIndices, FrameRequestHeader, FrameResponseHeader,
        FrameViewport, RpcRequestEnvelope, RpcResponseEnvelope, SamplingMode,
        FRAME_PROTOCOL_VERSION, PROTOCOL_VERSION,
    };
    use serde::Deserialize;
    use serde_json::{json, Value};
    use uuid::Uuid;
    use wgpu::SurfaceError;
    use winit::application::ApplicationHandler;
    use winit::event::{ElementState, MouseButton, MouseScrollDelta, WindowEvent};
    use winit::event_loop::{ActiveEventLoop, EventLoop};
    use winit::keyboard::{KeyCode, PhysicalKey};
    use winit::window::{Window, WindowAttributes, WindowId};

    const DEFAULT_CONTROL_SOCKET_PATH: &str = "/tmp/lucida.sock";
    const DEFAULT_CONTRAST_LIMITS: [u16; 2] = [0, u16::MAX];
    const FREEFLY_CANONICAL_POSITION: [f64; 3] = [0.0, 0.0, 3.2];
    const FREEFLY_CANONICAL_YPR: [f64; 3] = [0.0, 0.0, 0.0];
    const FREEFLY_CANONICAL_SPEED: f64 = 1.5;
    const INTERACTIVE_LONG_SIDE_CAP_MAX: u32 = 640;
    const INTERACTIVE_LONG_SIDE_CAP_MIN: u32 = 360;
    const INTERACTIVE_LONG_SIDE_CAP_REDUCE_FACTOR: f64 = 0.85;
    const INTERACTIVE_LONG_SIDE_CAP_INCREASE_FACTOR: f64 = 1.10;
    const RAYMARCH_MS_DECREASE_THRESHOLD: f64 = 24.0;
    const RAYMARCH_MS_INCREASE_THRESHOLD: f64 = 14.0;
    const RAYMARCH_MS_HARD_SPIKE_THRESHOLD: f64 = 80.0;
    const RAYMARCH_MS_SETTLE_THRESHOLD: f64 = 26.0;
    const INTERACTIVE_SHORT_SIDE_MIN: u32 = 180;
    const INTERACTIVE_IDLE_TO_SETTLE: Duration = Duration::from_millis(150);
    const INTERACTIVE_SETTLE_HYSTERESIS: Duration = Duration::from_millis(120);
    const INTERACTIVE_SPIKE_HOLD: Duration = Duration::from_millis(600);
    const HUD_MARGIN_X: u32 = 12;
    const HUD_MARGIN_Y: u32 = 12;
    const HUD_PADDING_X: u32 = 8;
    const HUD_PADDING_Y: u32 = 8;
    const HUD_GLYPH_W: u32 = 5;
    const HUD_GLYPH_H: u32 = 7;
    const HUD_GLYPH_SPACING_X: u32 = 1;
    const HUD_LINE_SPACING_Y: u32 = 3;
    const HUD_PIXEL_SCALE: u32 = 2;

    const SHADER_SOURCE: &str = r#"
struct RenderParams {
  camera: vec4<f32>,   // center_x, center_y, zoom, sampling_mode (0 nearest, 1 linear)
  contrast: vec4<f32>, // min, max, inv_range, use_camera_transform (1=true)
  image: vec4<f32>,    // image_w, image_h, viewport_w, viewport_h
};

@group(0) @binding(0) var frame_tex: texture_2d<u32>;
@group(0) @binding(1) var<uniform> params: RenderParams;

struct VertexOut {
  @builtin(position) position: vec4<f32>,
  @location(0) uv: vec2<f32>,
};

@vertex
fn vs_main(@builtin(vertex_index) vertex_index: u32) -> VertexOut {
  var positions = array<vec2<f32>, 3>(
    vec2<f32>(-1.0, -3.0),
    vec2<f32>(-1.0,  1.0),
    vec2<f32>( 3.0,  1.0),
  );
  var uvs = array<vec2<f32>, 3>(
    vec2<f32>(0.0, 2.0),
    vec2<f32>(0.0, 0.0),
    vec2<f32>(2.0, 0.0),
  );

  var out: VertexOut;
  out.position = vec4<f32>(positions[vertex_index], 0.0, 1.0);
  out.uv = uvs[vertex_index];
  return out;
}

fn in_bounds(x: i32, y: i32, width: i32, height: i32) -> bool {
  return x >= 0 && y >= 0 && x < width && y < height;
}

fn load_texel(x: i32, y: i32, width: i32, height: i32) -> f32 {
  if !in_bounds(x, y, width, height) {
    return 0.0;
  }
  return f32(textureLoad(frame_tex, vec2<i32>(x, y), 0).x);
}

fn sample_nearest(texel: vec2<f32>, width: i32, height: i32) -> f32 {
  let ix = i32(round(texel.x));
  let iy = i32(round(texel.y));
  return load_texel(ix, iy, width, height);
}

fn sample_linear(texel: vec2<f32>, width: i32, height: i32) -> f32 {
  let x0 = i32(floor(texel.x));
  let y0 = i32(floor(texel.y));
  let x1 = x0 + 1;
  let y1 = y0 + 1;
  let fx = fract(texel.x);
  let fy = fract(texel.y);
  let v00 = load_texel(x0, y0, width, height);
  let v10 = load_texel(x1, y0, width, height);
  let v01 = load_texel(x0, y1, width, height);
  let v11 = load_texel(x1, y1, width, height);
  let v0 = mix(v00, v10, fx);
  let v1 = mix(v01, v11, fx);
  return mix(v0, v1, fy);
}

@fragment
fn fs_main(input: VertexOut) -> @location(0) vec4<f32> {
  let image_w = max(params.image.x, 1.0);
  let image_h = max(params.image.y, 1.0);
  let viewport_w = max(params.image.z, 1.0);
  let viewport_h = max(params.image.w, 1.0);
  var texel = vec2<f32>(input.uv.x * image_w - 0.5, input.uv.y * image_h - 0.5);
  if (params.contrast.w >= 0.5) {
    let scale_x = viewport_w / image_w;
    let scale_y = viewport_h / image_h;
    let nx = input.uv.x * 2.0 - 1.0;
    let ny = 1.0 - input.uv.y * 2.0;
    let zoom = max(params.camera.z, 0.05);
    let world_x = nx * scale_x / zoom + params.camera.x;
    let world_y = ny * scale_y / zoom + params.camera.y;
    let sample_x = world_x * 0.5 + 0.5;
    let sample_y = 0.5 - world_y * 0.5;
    texel = vec2<f32>(sample_x * image_w - 0.5, sample_y * image_h - 0.5);
  }

  let width_i = i32(image_w);
  let height_i = i32(image_h);
  let use_linear = params.camera.w >= 0.5;
  let value = select(
    sample_nearest(texel, width_i, height_i),
    sample_linear(texel, width_i, height_i),
    use_linear
  );

  let normalized = clamp((value - params.contrast.x) * params.contrast.z, 0.0, 1.0);
  return vec4<f32>(normalized, normalized, normalized, 1.0);
}
"#;

    const OVERLAY_SHADER_SOURCE: &str = r#"
struct OverlayParams {
  viewport: vec4<f32>, // viewport_w, viewport_h, enabled, _
  rect: vec4<f32>,     // origin_x, origin_y, size_w, size_h
};

@group(0) @binding(0) var overlay_tex: texture_2d<f32>;
@group(0) @binding(1) var overlay_sampler: sampler;
@group(0) @binding(2) var<uniform> params: OverlayParams;

struct VertexOut {
  @builtin(position) position: vec4<f32>,
  @location(0) uv: vec2<f32>,
};

@vertex
fn vs_main(@builtin(vertex_index) vertex_index: u32) -> VertexOut {
  var positions = array<vec2<f32>, 3>(
    vec2<f32>(-1.0, -3.0),
    vec2<f32>(-1.0,  1.0),
    vec2<f32>( 3.0,  1.0),
  );
  var uvs = array<vec2<f32>, 3>(
    vec2<f32>(0.0, 2.0),
    vec2<f32>(0.0, 0.0),
    vec2<f32>(2.0, 0.0),
  );

  var out: VertexOut;
  out.position = vec4<f32>(positions[vertex_index], 0.0, 1.0);
  out.uv = uvs[vertex_index];
  return out;
}

@fragment
fn fs_main(input: VertexOut) -> @location(0) vec4<f32> {
  if (params.viewport.z < 0.5) {
    return vec4<f32>(0.0, 0.0, 0.0, 0.0);
  }

  let px = vec2<f32>(input.uv.x * params.viewport.x, input.uv.y * params.viewport.y);
  let rel = px - params.rect.xy;
  if (rel.x < 0.0 || rel.y < 0.0 || rel.x >= params.rect.z || rel.y >= params.rect.w) {
    return vec4<f32>(0.0, 0.0, 0.0, 0.0);
  }

  let uv = vec2<f32>(
    rel.x / max(params.rect.z, 1.0),
    rel.y / max(params.rect.w, 1.0)
  );
  return textureSample(overlay_tex, overlay_sampler, uv);
}
"#;

    #[derive(Debug)]
    struct AppArgs {
        socket_path: String,
        session_id: String,
    }

    impl AppArgs {
        fn parse(raw_args: &[String]) -> Result<Self> {
            let mut socket_path = DEFAULT_CONTROL_SOCKET_PATH.to_string();
            let mut session_id: Option<String> = None;

            let mut index = 1usize;
            while index < raw_args.len() {
                match raw_args[index].as_str() {
                    "--socket" if index + 1 < raw_args.len() => {
                        socket_path = raw_args[index + 1].clone();
                        index += 2;
                    }
                    "--session-id" if index + 1 < raw_args.len() => {
                        session_id = Some(raw_args[index + 1].clone());
                        index += 2;
                    }
                    "--help" | "-h" => {
                        print_usage();
                        std::process::exit(0);
                    }
                    unknown => {
                        bail!("unknown argument: {unknown}");
                    }
                }
            }

            let session_id = session_id.ok_or_else(|| {
                anyhow!("--session-id is required (app attaches to an existing daemon session)")
            })?;
            Ok(Self {
                socket_path,
                session_id,
            })
        }
    }

    fn print_usage() {
        eprintln!("Usage: lucida-app --session-id <id> [--socket <control.sock>]");
    }

    struct ControlClient {
        reader: BufReader<UnixStream>,
        writer: BufWriter<UnixStream>,
    }

    impl ControlClient {
        fn connect(path: &str) -> Result<Self> {
            let stream = UnixStream::connect(path)
                .with_context(|| format!("connect control socket {path}"))?;
            let reader = BufReader::new(stream.try_clone()?);
            let writer = BufWriter::new(stream);
            Ok(Self { reader, writer })
        }

        fn request(
            &mut self,
            method: &str,
            session_id: Option<&str>,
            params: Value,
        ) -> Result<Value> {
            let request = RpcRequestEnvelope {
                jsonrpc: "2.0".to_string(),
                protocol_version: PROTOCOL_VERSION.to_string(),
                session_id: session_id.map(ToString::to_string),
                request_id: Uuid::new_v4().to_string(),
                method: method.to_string(),
                params,
                timestamp: now_utc(),
            };

            serde_json::to_writer(&mut self.writer, &request)?;
            self.writer.write_all(b"\n")?;
            self.writer.flush()?;

            let mut line = String::new();
            self.reader.read_line(&mut line)?;
            if line.trim().is_empty() {
                bail!("control socket closed while waiting for {method} response");
            }

            let response: RpcResponseEnvelope =
                serde_json::from_str(&line).with_context(|| format!("parse {method} response"))?;
            if let Some(error) = response.error {
                bail!("{method} failed: {}", error.message);
            }
            Ok(response.result.unwrap_or(Value::Null))
        }
    }

    #[derive(Clone, Debug)]
    struct FrameImage {
        width: u32,
        height: u32,
        payload: Vec<u8>,
        state_hash: String,
    }

    #[derive(Clone, Debug)]
    struct FrameRequestSpec {
        render_mode: String,
        axis_indices: FrameAxisIndices,
        viewport: FrameViewport,
        camera_generation: u64,
    }

    impl FrameRequestSpec {
        fn same_as(&self, other: &Self) -> bool {
            self.render_mode == other.render_mode
                && self.axis_indices.t == other.axis_indices.t
                && self.axis_indices.c == other.axis_indices.c
                && self.axis_indices.z == other.axis_indices.z
                && self.viewport.width == other.viewport.width
                && self.viewport.height == other.viewport.height
                && self.camera_generation == other.camera_generation
        }
    }

    #[derive(Clone, Debug)]
    struct FrameRequestEnvelope {
        seq: u64,
        spec: FrameRequestSpec,
        reason: String,
    }

    #[derive(Debug)]
    struct FrameWorkerResult {
        seq: u64,
        reason: String,
        frame: Result<FrameImage, String>,
        roundtrip_ms: f64,
    }

    struct FrameRequestCompletion {
        apply_result: bool,
        dispatch_next: Option<FrameRequestEnvelope>,
    }

    #[derive(Default)]
    struct FrameRequestScheduler {
        next_seq: u64,
        in_flight: Option<FrameRequestEnvelope>,
        pending_latest: Option<FrameRequestSpec>,
        dropped_stale: u64,
    }

    impl FrameRequestScheduler {
        fn request(
            &mut self,
            spec: FrameRequestSpec,
            reason: &str,
        ) -> Option<FrameRequestEnvelope> {
            if let Some(current) = self.in_flight.as_ref() {
                if current.spec.same_as(&spec) {
                    return None;
                }
                if let Some(pending) = self.pending_latest.as_ref() {
                    if pending.same_as(&spec) {
                        return None;
                    }
                    self.dropped_stale = self.dropped_stale.saturating_add(1);
                }
                self.pending_latest = Some(spec);
                return None;
            }
            Some(self.dispatch(spec, reason))
        }

        fn complete(&mut self, seq: u64) -> FrameRequestCompletion {
            let Some(in_flight) = self.in_flight.take() else {
                self.dropped_stale = self.dropped_stale.saturating_add(1);
                return FrameRequestCompletion {
                    apply_result: false,
                    dispatch_next: None,
                };
            };
            if in_flight.seq != seq {
                self.dropped_stale = self.dropped_stale.saturating_add(1);
                self.in_flight = Some(in_flight);
                return FrameRequestCompletion {
                    apply_result: false,
                    dispatch_next: None,
                };
            }

            let dispatch_next = self.pending_latest.take().and_then(|next| {
                if next.same_as(&in_flight.spec) {
                    None
                } else {
                    Some(self.dispatch(next, "latest"))
                }
            });

            FrameRequestCompletion {
                apply_result: true,
                dispatch_next,
            }
        }

        fn is_in_flight(&self) -> bool {
            self.in_flight.is_some()
        }

        fn has_pending_latest(&self) -> bool {
            self.pending_latest.is_some()
        }

        fn dropped_stale(&self) -> u64 {
            self.dropped_stale
        }

        fn dispatch(&mut self, spec: FrameRequestSpec, reason: &str) -> FrameRequestEnvelope {
            self.next_seq = self.next_seq.saturating_add(1);
            let envelope = FrameRequestEnvelope {
                seq: self.next_seq,
                spec,
                reason: reason.to_string(),
            };
            self.in_flight = Some(envelope.clone());
            envelope
        }
    }

    struct FrameClient {
        stream: UnixStream,
        channel_token: String,
        session_id: String,
    }

    impl FrameClient {
        fn connect(socket_path: &str, channel_token: String, session_id: String) -> Result<Self> {
            let stream = UnixStream::connect(socket_path)
                .with_context(|| format!("connect frame socket {socket_path}"))?;
            Ok(Self {
                stream,
                channel_token,
                session_id,
            })
        }

        fn request_frame(
            &mut self,
            request_id: String,
            axis_indices: FrameAxisIndices,
            viewport: FrameViewport,
        ) -> Result<FrameImage> {
            let header = FrameRequestHeader {
                frame_protocol_version: FRAME_PROTOCOL_VERSION.to_string(),
                request_id,
                channel_token: self.channel_token.clone(),
                session_id: self.session_id.clone(),
                axis_indices,
                viewport,
            };
            let encoded = serde_json::to_vec(&header)?;
            self.stream
                .write_all(&(encoded.len() as u32).to_le_bytes())
                .context("write frame request header length")?;
            self.stream
                .write_all(&encoded)
                .context("write frame request header")?;
            self.stream.flush().context("flush frame request")?;

            let mut response_header_len = [0u8; 4];
            self.stream
                .read_exact(&mut response_header_len)
                .context("read frame response header length")?;
            let header_len = u32::from_le_bytes(response_header_len) as usize;
            let mut response_header_bytes = vec![0u8; header_len];
            self.stream
                .read_exact(&mut response_header_bytes)
                .context("read frame response header")?;
            let response_header: FrameResponseHeader =
                serde_json::from_slice(&response_header_bytes)
                    .context("parse frame response header")?;

            if response_header.status != "ok" {
                bail!(
                    "frame request failed: {}",
                    response_header
                        .error
                        .unwrap_or_else(|| "unknown frame error".to_string())
                );
            }

            let mut payload = vec![0u8; response_header.payload_len as usize];
            if !payload.is_empty() {
                self.stream
                    .read_exact(&mut payload)
                    .context("read frame payload bytes")?;
            }

            Ok(FrameImage {
                width: response_header.width,
                height: response_header.height,
                payload,
                state_hash: response_header.state_hash,
            })
        }
    }

    fn spawn_frame_worker(
        mut frame: FrameClient,
    ) -> (Sender<FrameRequestEnvelope>, Receiver<FrameWorkerResult>) {
        let (request_tx, request_rx) = mpsc::channel::<FrameRequestEnvelope>();
        let (result_tx, result_rx) = mpsc::channel::<FrameWorkerResult>();
        std::thread::spawn(move || {
            while let Ok(request) = request_rx.recv() {
                let started = Instant::now();
                let frame_result = frame
                    .request_frame(
                        Uuid::new_v4().to_string(),
                        request.spec.axis_indices.clone(),
                        request.spec.viewport.clone(),
                    )
                    .map_err(|err| err.to_string());
                let roundtrip_ms = started.elapsed().as_secs_f64() * 1_000.0;
                if result_tx
                    .send(FrameWorkerResult {
                        seq: request.seq,
                        reason: request.reason,
                        frame: frame_result,
                        roundtrip_ms,
                    })
                    .is_err()
                {
                    break;
                }
            }
        });
        (request_tx, result_rx)
    }

    #[derive(Debug, Deserialize)]
    struct SessionInspectResponse {
        exists: bool,
        dataset: Option<Value>,
        layers: Vec<LayerSummary>,
        view: Option<ViewSummary>,
        camera: Option<CameraSummary>,
        #[serde(default)]
        render_mode: Option<String>,
    }

    #[derive(Debug, Deserialize)]
    struct LayerSummary {
        id: String,
        visible: bool,
        kind: LayerKindSummary,
    }

    #[derive(Debug, Deserialize)]
    #[serde(tag = "type", rename_all = "snake_case")]
    enum LayerKindSummary {
        Image {
            #[allow(dead_code)]
            dataset_id: Option<String>,
            channel: Option<usize>,
            #[serde(default)]
            render_state: ImageRenderStateSummary,
        },
        Points {
            #[allow(dead_code)]
            points_count: usize,
            #[allow(dead_code)]
            color_by: Option<String>,
        },
    }

    #[derive(Debug, Clone, Deserialize)]
    struct ImageRenderStateSummary {
        #[serde(default)]
        sampling_mode: SamplingMode,
        #[serde(default = "default_contrast_limits")]
        contrast_limits: [u16; 2],
    }

    impl Default for ImageRenderStateSummary {
        fn default() -> Self {
            Self {
                sampling_mode: SamplingMode::Nearest,
                contrast_limits: default_contrast_limits(),
            }
        }
    }

    #[derive(Debug, Deserialize)]
    #[serde(tag = "mode", rename_all = "snake_case")]
    enum CameraSummary {
        PanZoom {
            center: [f64; 2],
            zoom: f64,
        },
        Arcball {
            #[allow(dead_code)]
            target: [f64; 3],
            #[allow(dead_code)]
            distance: f64,
            #[allow(dead_code)]
            yaw_pitch: [f64; 2],
        },
        Freefly {
            position: [f64; 3],
            yaw_pitch_roll: [f64; 3],
            speed: f64,
        },
    }

    #[derive(Debug, Deserialize)]
    struct ViewSummary {
        axis_indices: BTreeMap<String, usize>,
    }

    #[derive(Debug, Deserialize)]
    struct FrameChannelOpenResponse {
        frame_protocol_version: String,
        frame_socket_path: String,
        channel_token: String,
        max_frame_bytes: usize,
    }

    struct AppClient {
        session_id: String,
        control: ControlClient,
        frame_socket_path: String,
        frame_channel_token: String,
        frame_request_tx: Sender<FrameRequestEnvelope>,
        frame_result_rx: Receiver<FrameWorkerResult>,
        events_rx: Receiver<EventEnvelope>,
        active_image_layer_id: String,
        axis_bounds: AxisBounds,
        axis_indices: FrameAxisIndices,
        last_good_axis_indices: FrameAxisIndices,
        render_mode: String,
        camera_mode: String,
        mode_label: String,
        zoom: f64,
        pan_center: [f64; 2],
        sampling_mode: SamplingMode,
        contrast_limits: [u16; 2],
        freefly_pose: FreeflyPose,
        last_state_hash: String,
        daemon_frame_perf: Option<DaemonFramePerf>,
        daemon_frame_perf_version: u64,
    }

    #[derive(Clone, Copy)]
    struct FreeflyPose {
        position: [f64; 3],
        yaw_pitch_roll: [f64; 3],
        speed: f64,
    }

    #[derive(Clone, Copy, Debug, Default)]
    struct AxisBounds {
        t_max: Option<usize>,
        c_max: Option<usize>,
        z_max: Option<usize>,
    }

    impl Default for FreeflyPose {
        fn default() -> Self {
            Self {
                position: FREEFLY_CANONICAL_POSITION,
                yaw_pitch_roll: FREEFLY_CANONICAL_YPR,
                speed: FREEFLY_CANONICAL_SPEED,
            }
        }
    }

    #[derive(Clone, Copy, Debug, Default)]
    struct DaemonFramePerf {
        total_ms: f64,
        raymarch_ms: f64,
        cache_ms: f64,
        encode_write_ms: f64,
        bricks_traversed: u64,
        bricks_sampled: u64,
        samples_taken: u64,
        skip_ratio: f64,
        raymarch_parallel: bool,
        raymarch_workers: u64,
        rows_parallelized: u64,
    }

    #[derive(Clone, Copy, Debug, PartialEq, Eq)]
    enum RenderUpdate {
        None,
        RedrawOnly,
        FrameAndRedraw,
    }

    #[derive(Clone, Copy, Debug, PartialEq, Eq)]
    enum FrameQualityTier {
        Interactive,
        Settled,
    }

    impl FrameQualityTier {
        fn label(self) -> &'static str {
            match self {
                Self::Interactive => "I",
                Self::Settled => "S",
            }
        }
    }

    impl RenderUpdate {
        fn merge(self, other: Self) -> Self {
            match (self, other) {
                (Self::FrameAndRedraw, _) | (_, Self::FrameAndRedraw) => Self::FrameAndRedraw,
                (Self::RedrawOnly, _) | (_, Self::RedrawOnly) => Self::RedrawOnly,
                _ => Self::None,
            }
        }

        fn needs_frame(self) -> bool {
            matches!(self, Self::FrameAndRedraw)
        }

        fn needs_redraw(self) -> bool {
            !matches!(self, Self::None)
        }
    }

    impl AppClient {
        fn connect(control_socket_path: String, session_id: String) -> Result<Self> {
            let mut control = ControlClient::connect(&control_socket_path)?;

            let inspect_value = control.request("session.inspect", Some(&session_id), json!({}))?;
            let inspect: SessionInspectResponse = serde_json::from_value(inspect_value)?;
            if !inspect.exists {
                bail!("session {session_id} does not exist");
            }
            if inspect.dataset.is_none() {
                bail!("session {session_id} has no open dataset");
            }
            let (active_image_layer_id, image_channel, image_render_state) =
                first_visible_image_layer(&inspect.layers)
                    .ok_or_else(|| anyhow!("session {session_id} has no visible image layer"))?;

            let axis_bounds = axis_bounds_from_dataset(inspect.dataset.as_ref());
            let mut axis_indices = frame_axis_from_view(inspect.view.as_ref());
            if let Some(channel) = image_channel {
                axis_indices.c = channel;
            }
            axis_indices = clamp_axis_indices(axis_indices, axis_bounds);
            let render_mode = inspect.render_mode.unwrap_or_else(|| "2d".to_string());
            let (camera_mode, pan_center, zoom, freefly_pose) =
                camera_state_from_inspect(inspect.camera.as_ref());

            let frame_open_value =
                control.request("frame.channel.open", Some(&session_id), json!({}))?;
            let frame_channel: FrameChannelOpenResponse = serde_json::from_value(frame_open_value)?;
            if frame_channel.frame_protocol_version != FRAME_PROTOCOL_VERSION {
                bail!(
                    "unsupported frame protocol {}, expected {}",
                    frame_channel.frame_protocol_version,
                    FRAME_PROTOCOL_VERSION
                );
            }
            if frame_channel.max_frame_bytes == 0 {
                bail!("daemon returned invalid max_frame_bytes");
            }

            let frame = FrameClient::connect(
                &frame_channel.frame_socket_path,
                frame_channel.channel_token.clone(),
                session_id.clone(),
            )?;
            let (frame_request_tx, frame_result_rx) = spawn_frame_worker(frame);
            let events_rx = spawn_event_listener(&control_socket_path, &session_id)?;

            Ok(Self {
                session_id,
                control,
                frame_socket_path: frame_channel.frame_socket_path,
                frame_channel_token: frame_channel.channel_token,
                frame_request_tx,
                frame_result_rx,
                events_rx,
                active_image_layer_id,
                axis_bounds,
                last_good_axis_indices: axis_indices.clone(),
                axis_indices,
                mode_label: render_mode_label(&render_mode),
                render_mode,
                camera_mode,
                zoom,
                pan_center,
                sampling_mode: image_render_state.sampling_mode,
                contrast_limits: image_render_state.contrast_limits,
                freefly_pose,
                last_state_hash: "uninitialized".to_string(),
                daemon_frame_perf: None,
                daemon_frame_perf_version: 0,
            })
        }

        fn enqueue_frame_request(&self, request: FrameRequestEnvelope) -> Result<()> {
            self.frame_request_tx
                .send(request)
                .map_err(|_| anyhow!("frame worker request channel is closed, restart lucida-app"))
        }

        fn poll_frame_result(&self) -> Result<Option<FrameWorkerResult>> {
            match self.frame_result_rx.try_recv() {
                Ok(result) => Ok(Some(result)),
                Err(TryRecvError::Empty) => Ok(None),
                Err(TryRecvError::Disconnected) => {
                    bail!("frame worker disconnected, restart lucida-app");
                }
            }
        }

        fn record_frame_state(&mut self, frame: &FrameImage) {
            self.last_state_hash = frame.state_hash.clone();
            self.last_good_axis_indices = self.axis_indices.clone();
        }

        fn recover_axis_bounds(&mut self) -> Result<bool> {
            let clamped = clamp_axis_indices(self.axis_indices.clone(), self.axis_bounds);
            if !same_axis_indices(&clamped, &self.axis_indices) {
                self.axis_indices = clamped;
                for (axis, index) in [
                    ("t", self.axis_indices.t),
                    ("c", self.axis_indices.c),
                    ("z", self.axis_indices.z),
                ] {
                    self.control.request(
                        "view.set_axis",
                        Some(&self.session_id),
                        json!({"axis": axis, "index": index}),
                    )?;
                }
                return Ok(true);
            }
            if !same_axis_indices(&self.axis_indices, &self.last_good_axis_indices) {
                self.restore_last_good_axes()?;
                return Ok(true);
            }
            if self.axis_indices.z > 0 {
                self.axis_indices.z = self.axis_indices.z.saturating_sub(1);
                self.control.request(
                    "view.set_axis",
                    Some(&self.session_id),
                    json!({"axis": "z", "index": self.axis_indices.z}),
                )?;
                return Ok(true);
            }
            Ok(false)
        }

        fn reconnect_frame_worker(&mut self) -> Result<()> {
            let frame = FrameClient::connect(
                &self.frame_socket_path,
                self.frame_channel_token.clone(),
                self.session_id.clone(),
            )?;
            let (request_tx, result_rx) = spawn_frame_worker(frame);
            self.frame_request_tx = request_tx;
            self.frame_result_rx = result_rx;
            Ok(())
        }

        fn apply_key(&mut self, key_code: KeyCode) -> Result<RenderUpdate> {
            match key_code {
                KeyCode::BracketRight | KeyCode::PageUp => self.step_z(1),
                KeyCode::BracketLeft | KeyCode::PageDown => self.step_z(-1),
                KeyCode::ArrowLeft => self.step_c(-1),
                KeyCode::ArrowRight => self.step_c(1),
                KeyCode::Comma => self.step_t(-1),
                KeyCode::Period => self.step_t(1),
                KeyCode::Equal => {
                    if self.render_mode == "3d" {
                        self.freefly_pose.speed = (self.freefly_pose.speed * 1.1).min(10.0);
                        self.commit_freefly_pose()?;
                        Ok(RenderUpdate::FrameAndRedraw)
                    } else {
                        self.zoom *= 1.1;
                        self.commit_panzoom_pose()?;
                        Ok(self.camera_motion_update())
                    }
                }
                KeyCode::Minus => {
                    if self.render_mode == "3d" {
                        self.freefly_pose.speed = (self.freefly_pose.speed * 0.9).max(0.1);
                        self.commit_freefly_pose()?;
                        Ok(RenderUpdate::FrameAndRedraw)
                    } else {
                        self.zoom *= 0.9;
                        self.commit_panzoom_pose()?;
                        Ok(self.camera_motion_update())
                    }
                }
                KeyCode::Digit1 => {
                    self.control.request(
                        "view.set_render_mode",
                        Some(&self.session_id),
                        json!({"mode": "2d"}),
                    )?;
                    self.render_mode = "2d".to_string();
                    self.mode_label = render_mode_label(&self.render_mode);
                    Ok(RenderUpdate::FrameAndRedraw)
                }
                KeyCode::Digit2 => {
                    self.control.request(
                        "view.set_render_mode",
                        Some(&self.session_id),
                        json!({"mode": "3d"}),
                    )?;
                    self.render_mode = "3d".to_string();
                    self.mode_label = render_mode_label(&self.render_mode);
                    Ok(RenderUpdate::FrameAndRedraw)
                }
                KeyCode::Digit3 => {
                    self.control.request(
                        "view.set_render_mode",
                        Some(&self.session_id),
                        json!({"mode": "graph_stub"}),
                    )?;
                    self.render_mode = "graph_stub".to_string();
                    self.mode_label = render_mode_label(&self.render_mode);
                    Ok(RenderUpdate::FrameAndRedraw)
                }
                KeyCode::Digit4 => {
                    self.control.request(
                        "view.set_render_mode",
                        Some(&self.session_id),
                        json!({"mode": "2d_stub"}),
                    )?;
                    self.render_mode = "2d_stub".to_string();
                    self.mode_label = render_mode_label(&self.render_mode);
                    Ok(RenderUpdate::FrameAndRedraw)
                }
                KeyCode::KeyM => self.toggle_sampling(),
                KeyCode::KeyC => self.auto_contrast(),
                KeyCode::KeyV => self.set_contrast_limits(0, u16::MAX),
                KeyCode::KeyZ => self.scale_contrast_window(0.9),
                KeyCode::KeyX => self.scale_contrast_window(1.1),
                KeyCode::KeyR => {
                    if self.is_3d_mode() {
                        self.set_canonical_3d_pose()?;
                        Ok(RenderUpdate::FrameAndRedraw)
                    } else {
                        Ok(RenderUpdate::None)
                    }
                }
                KeyCode::ArrowUp => self.step_z(1),
                KeyCode::ArrowDown => self.step_z(-1),
                _ => Ok(RenderUpdate::None),
            }
        }

        fn step_z(&mut self, delta: i32) -> Result<RenderUpdate> {
            let next = next_axis_index(self.axis_indices.z, delta);
            let bounded = clamp_axis_index(next, self.axis_bounds.z_max);
            if bounded == self.axis_indices.z {
                return Ok(RenderUpdate::None);
            }
            self.axis_indices.z = bounded;
            self.control.request(
                "view.set_axis",
                Some(&self.session_id),
                json!({"axis": "z", "index": self.axis_indices.z}),
            )?;
            Ok(RenderUpdate::FrameAndRedraw)
        }

        fn step_t(&mut self, delta: i32) -> Result<RenderUpdate> {
            let next = next_axis_index(self.axis_indices.t, delta);
            let bounded = clamp_axis_index(next, self.axis_bounds.t_max);
            if bounded == self.axis_indices.t {
                return Ok(RenderUpdate::None);
            }
            self.axis_indices.t = bounded;
            self.control.request(
                "view.set_axis",
                Some(&self.session_id),
                json!({"axis": "t", "index": self.axis_indices.t}),
            )?;
            Ok(RenderUpdate::FrameAndRedraw)
        }

        fn step_c(&mut self, delta: i32) -> Result<RenderUpdate> {
            let next = next_axis_index(self.axis_indices.c, delta);
            let bounded = clamp_axis_index(next, self.axis_bounds.c_max);
            if bounded == self.axis_indices.c {
                return Ok(RenderUpdate::None);
            }
            self.axis_indices.c = bounded;
            self.control.request(
                "view.set_axis",
                Some(&self.session_id),
                json!({"axis": "c", "index": self.axis_indices.c}),
            )?;
            Ok(RenderUpdate::FrameAndRedraw)
        }

        fn apply_held_freefly(&mut self, held_keys: &BTreeSet<KeyCode>, dt_s: f64) -> Result<bool> {
            if self.render_mode != "3d" {
                return Ok(false);
            }

            let mut move_local = [0.0f64, 0.0, 0.0];
            if held_keys.contains(&KeyCode::KeyW) {
                move_local[2] += 1.0;
            }
            if held_keys.contains(&KeyCode::KeyS) {
                move_local[2] -= 1.0;
            }
            if held_keys.contains(&KeyCode::KeyA) {
                move_local[0] -= 1.0;
            }
            if held_keys.contains(&KeyCode::KeyD) {
                move_local[0] += 1.0;
            }
            if held_keys.contains(&KeyCode::KeyQ) {
                move_local[1] -= 1.0;
            }
            if held_keys.contains(&KeyCode::KeyE) {
                move_local[1] += 1.0;
            }

            let mut rotate_local = [0.0f64, 0.0, 0.0];
            if held_keys.contains(&KeyCode::KeyJ) {
                rotate_local[0] += 1.0;
            }
            if held_keys.contains(&KeyCode::KeyL) {
                rotate_local[0] -= 1.0;
            }
            if held_keys.contains(&KeyCode::KeyI) {
                rotate_local[1] += 1.0;
            }
            if held_keys.contains(&KeyCode::KeyK) {
                rotate_local[1] -= 1.0;
            }
            if held_keys.contains(&KeyCode::KeyU) {
                rotate_local[2] -= 1.0;
            }
            if held_keys.contains(&KeyCode::KeyO) {
                rotate_local[2] += 1.0;
            }

            let moving = move_local.iter().any(|value| value.abs() > 0.0);
            let rotating = rotate_local.iter().any(|value| value.abs() > 0.0);
            if !moving && !rotating {
                return Ok(false);
            }

            let basis = freefly_pose_to_basis(self.freefly_pose.yaw_pitch_roll);
            if moving {
                let length = length3(move_local).max(1e-9);
                let move_local = [
                    move_local[0] / length,
                    move_local[1] / length,
                    move_local[2] / length,
                ];
                let step = self.freefly_pose.speed * dt_s * 2.5;
                let world_delta = [
                    basis.right[0] * move_local[0]
                        + basis.up[0] * move_local[1]
                        + basis.forward[0] * move_local[2],
                    basis.right[1] * move_local[0]
                        + basis.up[1] * move_local[1]
                        + basis.forward[1] * move_local[2],
                    basis.right[2] * move_local[0]
                        + basis.up[2] * move_local[1]
                        + basis.forward[2] * move_local[2],
                ];
                self.freefly_pose.position[0] += world_delta[0] * step;
                self.freefly_pose.position[1] += world_delta[1] * step;
                self.freefly_pose.position[2] += world_delta[2] * step;
            }

            if rotating {
                let length = length3(rotate_local).max(1e-9);
                let rotate_local = [
                    rotate_local[0] / length,
                    rotate_local[1] / length,
                    rotate_local[2] / length,
                ];
                let rotation_speed = dt_s * 1.8;
                self.freefly_pose.yaw_pitch_roll = apply_local_look_deltas(
                    self.freefly_pose.yaw_pitch_roll,
                    rotate_local[0] * rotation_speed,
                    rotate_local[1] * rotation_speed,
                    rotate_local[2] * rotation_speed,
                );
            }

            self.commit_freefly_pose()?;
            Ok(true)
        }

        fn is_3d_mode(&self) -> bool {
            self.render_mode == "3d"
        }

        fn can_mouse_look_3d(&self) -> bool {
            self.is_3d_mode()
        }

        fn set_canonical_3d_pose(&mut self) -> Result<()> {
            self.freefly_pose = FreeflyPose::default();
            self.commit_freefly_pose()
        }

        fn has_non_default_contrast_limits(&self) -> bool {
            self.contrast_limits != DEFAULT_CONTRAST_LIMITS
        }

        fn has_non_default_freefly_pose(&self) -> bool {
            !approx_vec3(self.freefly_pose.position, FREEFLY_CANONICAL_POSITION, 1e-6)
                || !approx_vec3(
                    self.freefly_pose.yaw_pitch_roll,
                    FREEFLY_CANONICAL_YPR,
                    1e-6,
                )
                || (self.freefly_pose.speed - FREEFLY_CANONICAL_SPEED).abs() > 1e-6
        }

        fn should_skip_3d_entry_bootstrap(&self) -> bool {
            self.camera_mode == "freefly"
                && self.has_non_default_freefly_pose()
                && self.has_non_default_contrast_limits()
        }

        fn apply_mouse_look(&mut self, delta_x: f64, delta_y: f64) -> Result<RenderUpdate> {
            if !self.can_mouse_look_3d() {
                return Ok(RenderUpdate::None);
            }
            if delta_x.abs() < f64::EPSILON && delta_y.abs() < f64::EPSILON {
                return Ok(RenderUpdate::None);
            }
            let sensitivity = 0.004;
            self.freefly_pose.yaw_pitch_roll = apply_local_look_deltas(
                self.freefly_pose.yaw_pitch_roll,
                delta_x * sensitivity,
                delta_y * sensitivity,
                0.0,
            );
            self.commit_freefly_pose()?;
            Ok(RenderUpdate::FrameAndRedraw)
        }

        fn adjust_3d_speed_from_scroll(&mut self, raw_steps: f64) -> Result<RenderUpdate> {
            if !self.is_3d_mode() || raw_steps.abs() < f64::EPSILON {
                return Ok(RenderUpdate::None);
            }
            let speed_scale = 1.1_f64.powf(raw_steps);
            self.freefly_pose.speed = (self.freefly_pose.speed * speed_scale).clamp(0.1, 20.0);
            self.commit_freefly_pose()?;
            Ok(RenderUpdate::RedrawOnly)
        }

        fn can_pan_with_mouse(&self) -> bool {
            matches!(self.render_mode.as_str(), "2d" | "2d_stub")
        }

        fn apply_scroll_zoom(
            &mut self,
            delta_steps: f64,
            cursor_x: f64,
            cursor_y: f64,
            viewport_width: f64,
            viewport_height: f64,
            image_width: u32,
            image_height: u32,
        ) -> Result<RenderUpdate> {
            if !self.can_pan_with_mouse() || delta_steps.abs() < f64::EPSILON {
                return Ok(RenderUpdate::None);
            }
            if viewport_width <= 0.0 || viewport_height <= 0.0 {
                return Ok(RenderUpdate::None);
            }

            let before = self.screen_to_world(
                cursor_x,
                cursor_y,
                viewport_width,
                viewport_height,
                image_width,
                image_height,
            );
            let scale = zoom_scale_factor(delta_steps);
            self.zoom = (self.zoom * scale).clamp(0.05, 200.0);
            self.pan_center = pan_center_for_cursor_anchor(
                before,
                cursor_x,
                cursor_y,
                viewport_width,
                viewport_height,
                image_width,
                image_height,
                self.zoom,
            );
            self.commit_panzoom_pose()?;
            Ok(self.camera_motion_update())
        }

        fn pan_by_pixels(
            &mut self,
            delta_x: f64,
            delta_y: f64,
            viewport_width: f64,
            viewport_height: f64,
            image_width: u32,
            image_height: u32,
        ) -> Result<RenderUpdate> {
            if !self.can_pan_with_mouse() {
                return Ok(RenderUpdate::None);
            }
            if viewport_width <= 0.0 || viewport_height <= 0.0 {
                return Ok(RenderUpdate::None);
            }
            if delta_x.abs() < f64::EPSILON && delta_y.abs() < f64::EPSILON {
                return Ok(RenderUpdate::None);
            }

            let pixel_scale = pixel_scales(
                viewport_width,
                viewport_height,
                image_width as f64,
                image_height as f64,
            );
            let zoom = self.zoom.max(0.05);
            self.pan_center[0] -= 2.0 * delta_x * pixel_scale[0] / (viewport_width * zoom);
            self.pan_center[1] += 2.0 * delta_y * pixel_scale[1] / (viewport_height * zoom);
            self.commit_panzoom_pose()?;
            Ok(self.camera_motion_update())
        }

        fn camera_motion_update(&self) -> RenderUpdate {
            if self.render_mode == "2d" {
                RenderUpdate::RedrawOnly
            } else {
                RenderUpdate::FrameAndRedraw
            }
        }

        fn toggle_sampling(&mut self) -> Result<RenderUpdate> {
            let next = toggle_sampling_mode(self.sampling_mode);
            let response = self.control.request(
                "layer.set_sampling",
                Some(&self.session_id),
                json!({
                    "layer_id": self.active_image_layer_id,
                    "sampling_mode": next.as_str(),
                }),
            )?;
            self.sampling_mode =
                parse_sampling_mode_value(response.get("sampling_mode")).unwrap_or(next);
            Ok(RenderUpdate::RedrawOnly)
        }

        fn set_contrast_limits(&mut self, min: u16, max: u16) -> Result<RenderUpdate> {
            let response = self.control.request(
                "layer.set_contrast_limits",
                Some(&self.session_id),
                json!({
                    "layer_id": self.active_image_layer_id,
                    "min": min,
                    "max": max,
                }),
            )?;
            if let Some(parsed) = parse_contrast_limits_value(response.get("contrast_limits")) {
                self.contrast_limits = parsed;
            } else {
                self.contrast_limits = [min, max];
            }
            Ok(RenderUpdate::RedrawOnly)
        }

        fn auto_contrast(&mut self) -> Result<RenderUpdate> {
            let response = self.control.request(
                "layer.auto_contrast",
                Some(&self.session_id),
                json!({
                    "layer_id": self.active_image_layer_id,
                    "method": "robust_percentile_1_99",
                }),
            )?;
            if let Some(parsed) = parse_contrast_limits_value(response.get("contrast_limits")) {
                self.contrast_limits = parsed;
            }
            Ok(RenderUpdate::RedrawOnly)
        }

        fn scale_contrast_window(&mut self, scale: f64) -> Result<RenderUpdate> {
            let min = self.contrast_limits[0] as f64;
            let max = self.contrast_limits[1] as f64;
            let center = (min + max) * 0.5;
            let half = ((max - min) * 0.5 * scale).clamp(8.0, (u16::MAX as f64) * 0.5);
            let mut next_min = (center - half).round().clamp(0.0, u16::MAX as f64) as u16;
            let mut next_max = (center + half).round().clamp(0.0, u16::MAX as f64) as u16;
            if next_min >= next_max {
                if next_max == u16::MAX {
                    next_min = next_max.saturating_sub(1);
                } else {
                    next_max = next_min.saturating_add(1);
                }
            }
            self.set_contrast_limits(next_min, next_max)
        }

        fn screen_to_world(
            &self,
            cursor_x: f64,
            cursor_y: f64,
            viewport_width: f64,
            viewport_height: f64,
            image_width: u32,
            image_height: u32,
        ) -> [f64; 2] {
            world_point_from_cursor(
                cursor_x,
                cursor_y,
                viewport_width,
                viewport_height,
                image_width,
                image_height,
                self.pan_center,
                self.zoom,
            )
        }

        fn apply_inspect_state(&mut self, inspect: &SessionInspectResponse) {
            self.axis_bounds = axis_bounds_from_dataset(inspect.dataset.as_ref());
            self.axis_indices = frame_axis_from_view(inspect.view.as_ref());
            if let Some((layer_id, channel, image_render_state)) =
                first_visible_image_layer(&inspect.layers)
            {
                self.active_image_layer_id = layer_id;
                if let Some(channel) = channel {
                    self.axis_indices.c = channel;
                }
                self.sampling_mode = image_render_state.sampling_mode;
                self.contrast_limits = image_render_state.contrast_limits;
            }
            self.axis_indices = clamp_axis_indices(self.axis_indices.clone(), self.axis_bounds);
            if let Some(camera) = inspect.camera.as_ref() {
                match camera {
                    CameraSummary::PanZoom { center, zoom } => {
                        self.camera_mode = "panzoom".to_string();
                        self.pan_center = *center;
                        self.zoom = zoom.abs().max(0.05);
                    }
                    CameraSummary::Freefly {
                        position,
                        yaw_pitch_roll,
                        speed,
                    } => {
                        self.camera_mode = "freefly".to_string();
                        self.freefly_pose = FreeflyPose {
                            position: *position,
                            yaw_pitch_roll: *yaw_pitch_roll,
                            speed: *speed,
                        };
                    }
                    CameraSummary::Arcball { .. } => {
                        self.camera_mode = "arcball".to_string();
                    }
                }
            }
            self.last_good_axis_indices = self.axis_indices.clone();
            self.render_mode = inspect
                .render_mode
                .clone()
                .unwrap_or_else(|| "2d".to_string());
            self.mode_label = render_mode_label(&self.render_mode);
        }

        fn restore_last_good_axes(&mut self) -> Result<()> {
            self.axis_indices = self.last_good_axis_indices.clone();
            for (axis, index) in [
                ("t", self.axis_indices.t),
                ("c", self.axis_indices.c),
                ("z", self.axis_indices.z),
            ] {
                self.control.request(
                    "view.set_axis",
                    Some(&self.session_id),
                    json!({"axis": axis, "index": index}),
                )?;
            }
            Ok(())
        }

        fn commit_freefly_pose(&mut self) -> Result<()> {
            self.control.request(
                "camera.set_mode",
                Some(&self.session_id),
                json!({"mode": "freefly"}),
            )?;
            self.control.request(
                "camera.set_pose",
                Some(&self.session_id),
                json!({
                    "pose": {
                        "position": self.freefly_pose.position,
                        "yaw_pitch_roll": self.freefly_pose.yaw_pitch_roll,
                        "speed": self.freefly_pose.speed,
                    }
                }),
            )?;
            self.camera_mode = "freefly".to_string();
            Ok(())
        }

        fn commit_panzoom_pose(&mut self) -> Result<()> {
            self.control.request(
                "camera.set_mode",
                Some(&self.session_id),
                json!({"mode": "panzoom"}),
            )?;
            self.control.request(
                "camera.set_pose",
                Some(&self.session_id),
                json!({
                    "pose": {
                        "center": self.pan_center,
                        "zoom": self.zoom,
                    }
                }),
            )?;
            self.camera_mode = "panzoom".to_string();
            Ok(())
        }

        fn poll_control_events(&mut self) -> Result<RenderUpdate> {
            let mut update = RenderUpdate::None;
            loop {
                match self.events_rx.try_recv() {
                    Ok(event) => {
                        if !event_is_for_session(&event, &self.session_id) {
                            continue;
                        }
                        if event.event == "state.changed" {
                            let method = event
                                .payload
                                .get("method")
                                .and_then(Value::as_str)
                                .unwrap_or_default();
                            if is_render_relevant_method(method) {
                                self.sync_axis_state()?;
                                let event_update =
                                    if method == "camera.set_pose" || method == "camera.set_mode" {
                                        self.camera_motion_update()
                                    } else if method == "layer.set_sampling"
                                        || method == "layer.set_contrast_limits"
                                        || method == "layer.auto_contrast"
                                    {
                                        RenderUpdate::RedrawOnly
                                    } else {
                                        RenderUpdate::FrameAndRedraw
                                    };
                                update = update.merge(event_update);
                            }
                        } else if event.event == "perf.frame" {
                            if let Some(perf) = parse_daemon_frame_perf(&event.payload) {
                                self.daemon_frame_perf = Some(perf);
                                self.daemon_frame_perf_version =
                                    self.daemon_frame_perf_version.saturating_add(1);
                            }
                        }
                    }
                    Err(TryRecvError::Empty) => break,
                    Err(TryRecvError::Disconnected) => {
                        bail!("events stream disconnected");
                    }
                }
            }
            Ok(update)
        }

        fn sync_axis_state(&mut self) -> Result<()> {
            let inspect_value =
                self.control
                    .request("session.inspect", Some(&self.session_id), json!({}))?;
            let inspect: SessionInspectResponse = serde_json::from_value(inspect_value)?;
            self.apply_inspect_state(&inspect);
            Ok(())
        }
    }

    fn event_is_for_session(event: &EventEnvelope, session_id: &str) -> bool {
        event
            .session_id
            .as_deref()
            .map(|value| value == session_id)
            .unwrap_or(false)
    }

    fn is_render_relevant_method(method: &str) -> bool {
        matches!(
            method,
            "dataset.open"
                | "layer.add_image"
                | "layer.set_sampling"
                | "layer.set_contrast_limits"
                | "layer.auto_contrast"
                | "view.set_axis"
                | "view.reorder_axes"
                | "view.set_render_mode"
                | "camera.set_pose"
                | "camera.set_mode"
        )
    }

    fn render_mode_label(mode: &str) -> String {
        match mode {
            "2d" => "2D".to_string(),
            "2d_stub" => "2D(stub)".to_string(),
            "3d" => "3D".to_string(),
            "graph_stub" => "Graph(stub)".to_string(),
            other => format!("Unknown({other})"),
        }
    }

    fn compact_error_for_hud(message: &str) -> String {
        let trimmed = message.trim();
        if trimmed.is_empty() {
            return "unknown".to_string();
        }
        let first_line = trimmed.split('\n').next().unwrap_or(trimmed);
        first_line.chars().take(56).collect()
    }

    fn uses_camera_transform(render_mode: &str) -> bool {
        matches!(render_mode, "2d" | "2d_stub")
    }

    fn same_axis_indices(left: &FrameAxisIndices, right: &FrameAxisIndices) -> bool {
        left.t == right.t && left.c == right.c && left.z == right.z
    }

    fn next_axis_index(current: usize, delta: i32) -> usize {
        if delta >= 0 {
            current.saturating_add(delta as usize)
        } else {
            current.saturating_sub((-delta) as usize)
        }
    }

    fn is_continuous_3d_key(code: KeyCode) -> bool {
        matches!(
            code,
            KeyCode::KeyW
                | KeyCode::KeyA
                | KeyCode::KeyS
                | KeyCode::KeyD
                | KeyCode::KeyQ
                | KeyCode::KeyE
                | KeyCode::KeyI
                | KeyCode::KeyJ
                | KeyCode::KeyK
                | KeyCode::KeyL
                | KeyCode::KeyU
                | KeyCode::KeyO
        )
    }

    #[derive(Clone, Copy, Debug)]
    struct OrientationBasis {
        forward: [f64; 3],
        right: [f64; 3],
        up: [f64; 3],
    }

    fn freefly_pose_to_basis(yaw_pitch_roll: [f64; 3]) -> OrientationBasis {
        let yaw = yaw_pitch_roll[0];
        let pitch = yaw_pitch_roll[1].clamp(-1.45, 1.45);
        let roll = yaw_pitch_roll[2];

        let mut forward = [
            yaw.sin() * pitch.cos(),
            pitch.sin(),
            -yaw.cos() * pitch.cos(),
        ];
        forward = normalize3(forward);

        let mut reference = reference_basis_from_forward(forward);
        let right = reference.right;
        let up = reference.up;

        let (sin_roll, cos_roll) = roll.sin_cos();
        let rolled_right = normalize3([
            right[0] * cos_roll + up[0] * sin_roll,
            right[1] * cos_roll + up[1] * sin_roll,
            right[2] * cos_roll + up[2] * sin_roll,
        ]);
        reference.up = normalize3([
            up[0] * cos_roll - right[0] * sin_roll,
            up[1] * cos_roll - right[1] * sin_roll,
            up[2] * cos_roll - right[2] * sin_roll,
        ]);
        OrientationBasis {
            forward,
            right: rolled_right,
            up: reference.up,
        }
    }

    fn cross3(a: [f64; 3], b: [f64; 3]) -> [f64; 3] {
        [
            a[1] * b[2] - a[2] * b[1],
            a[2] * b[0] - a[0] * b[2],
            a[0] * b[1] - a[1] * b[0],
        ]
    }

    fn length3(v: [f64; 3]) -> f64 {
        (v[0] * v[0] + v[1] * v[1] + v[2] * v[2]).sqrt()
    }

    fn normalize3(v: [f64; 3]) -> [f64; 3] {
        let len = length3(v).max(1e-9);
        [v[0] / len, v[1] / len, v[2] / len]
    }

    fn dot3(a: [f64; 3], b: [f64; 3]) -> f64 {
        a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
    }

    fn scale3(v: [f64; 3], s: f64) -> [f64; 3] {
        [v[0] * s, v[1] * s, v[2] * s]
    }

    fn add3(a: [f64; 3], b: [f64; 3]) -> [f64; 3] {
        [a[0] + b[0], a[1] + b[1], a[2] + b[2]]
    }

    fn reference_basis_from_forward(forward: [f64; 3]) -> OrientationBasis {
        let mut right = cross3(forward, [0.0, 1.0, 0.0]);
        if length3(right) < 1e-6 {
            right = cross3(forward, [1.0, 0.0, 0.0]);
        }
        right = normalize3(right);
        let up = normalize3(cross3(right, forward));
        OrientationBasis { forward, right, up }
    }

    fn orthonormalize_basis(basis: OrientationBasis) -> OrientationBasis {
        let mut forward = normalize3(basis.forward);
        let right_candidate = cross3(forward, basis.up);
        let mut right = if length3(right_candidate) < 1e-6 {
            reference_basis_from_forward(forward).right
        } else {
            normalize3(right_candidate)
        };
        if dot3(right, basis.right) < 0.0 {
            right = scale3(right, -1.0);
        }
        let up = normalize3(cross3(right, forward));
        if dot3(forward, basis.forward) < 0.0 {
            forward = scale3(forward, -1.0);
        }
        OrientationBasis { forward, right, up }
    }

    fn rotate_vec_around_axis(vector: [f64; 3], axis: [f64; 3], angle: f64) -> [f64; 3] {
        if angle.abs() < 1e-12 {
            return vector;
        }
        let axis = normalize3(axis);
        let (sin_theta, cos_theta) = angle.sin_cos();
        let term_a = scale3(vector, cos_theta);
        let term_b = scale3(cross3(axis, vector), sin_theta);
        let term_c = scale3(axis, dot3(axis, vector) * (1.0 - cos_theta));
        add3(add3(term_a, term_b), term_c)
    }

    fn basis_to_yaw_pitch_roll(basis: OrientationBasis) -> [f64; 3] {
        let basis = orthonormalize_basis(basis);
        let pitch = basis.forward[1].clamp(-1.0, 1.0).asin().clamp(-1.45, 1.45);
        let yaw = basis.forward[0].atan2(-basis.forward[2]);
        let reference = reference_basis_from_forward(basis.forward);
        let sin_roll = dot3(basis.right, reference.up);
        let cos_roll = dot3(basis.right, reference.right);
        let roll = sin_roll.atan2(cos_roll);
        [yaw, pitch, roll]
    }

    fn apply_local_look_deltas(
        yaw_pitch_roll: [f64; 3],
        yaw_delta: f64,
        pitch_delta: f64,
        roll_delta: f64,
    ) -> [f64; 3] {
        let mut basis = freefly_pose_to_basis(yaw_pitch_roll);

        basis.forward = rotate_vec_around_axis(basis.forward, basis.up, yaw_delta);
        basis.right = rotate_vec_around_axis(basis.right, basis.up, yaw_delta);
        basis.up = rotate_vec_around_axis(basis.up, basis.up, yaw_delta);
        basis = orthonormalize_basis(basis);

        basis.forward = rotate_vec_around_axis(basis.forward, basis.right, pitch_delta);
        basis.up = rotate_vec_around_axis(basis.up, basis.right, pitch_delta);
        basis.right = rotate_vec_around_axis(basis.right, basis.right, pitch_delta);
        basis = orthonormalize_basis(basis);

        basis.right = rotate_vec_around_axis(basis.right, basis.forward, roll_delta);
        basis.up = rotate_vec_around_axis(basis.up, basis.forward, roll_delta);
        basis.forward = rotate_vec_around_axis(basis.forward, basis.forward, roll_delta);
        basis = orthonormalize_basis(basis);

        basis_to_yaw_pitch_roll(basis)
    }

    fn approx_vec3(left: [f64; 3], right: [f64; 3], eps: f64) -> bool {
        (left[0] - right[0]).abs() <= eps
            && (left[1] - right[1]).abs() <= eps
            && (left[2] - right[2]).abs() <= eps
    }

    fn frame_axis_from_view(view: Option<&ViewSummary>) -> FrameAxisIndices {
        let empty = BTreeMap::new();
        let axis = view.map(|v| &v.axis_indices).unwrap_or(&empty);
        FrameAxisIndices {
            t: *axis.get("t").unwrap_or(&0),
            c: *axis.get("c").unwrap_or(&0),
            z: *axis.get("z").unwrap_or(&0),
        }
    }

    fn axis_bounds_from_dataset(dataset: Option<&Value>) -> AxisBounds {
        let Some(dataset) = dataset else {
            return AxisBounds::default();
        };
        let canonical_axes = dataset
            .get("multiscale_metadata")
            .and_then(|metadata| metadata.get("canonical_axes"))
            .and_then(Value::as_array);
        AxisBounds {
            t_max: axis_max_index(canonical_axes, "t"),
            c_max: axis_max_index(canonical_axes, "c"),
            z_max: axis_max_index(canonical_axes, "z"),
        }
    }

    fn axis_max_index(canonical_axes: Option<&Vec<Value>>, label: &str) -> Option<usize> {
        let axes = canonical_axes?;
        for axis in axes {
            if axis.get("label").and_then(Value::as_str) != Some(label) {
                continue;
            }
            let size = axis.get("size").and_then(Value::as_u64)?;
            if size == 0 {
                return Some(0);
            }
            return Some(size.saturating_sub(1) as usize);
        }
        None
    }

    fn clamp_axis_index(index: usize, axis_max: Option<usize>) -> usize {
        axis_max.map(|max| index.min(max)).unwrap_or(index)
    }

    fn clamp_axis_indices(indices: FrameAxisIndices, bounds: AxisBounds) -> FrameAxisIndices {
        FrameAxisIndices {
            t: clamp_axis_index(indices.t, bounds.t_max),
            c: clamp_axis_index(indices.c, bounds.c_max),
            z: clamp_axis_index(indices.z, bounds.z_max),
        }
    }

    fn default_contrast_limits() -> [u16; 2] {
        DEFAULT_CONTRAST_LIMITS
    }

    fn parse_sampling_mode_value(value: Option<&Value>) -> Option<SamplingMode> {
        let mode = value?.as_str()?;
        match mode {
            "nearest" => Some(SamplingMode::Nearest),
            "linear" => Some(SamplingMode::Linear),
            _ => None,
        }
    }

    fn parse_contrast_limits_value(value: Option<&Value>) -> Option<[u16; 2]> {
        let values = value?.as_array()?;
        if values.len() != 2 {
            return None;
        }
        let min = values[0].as_u64()?;
        let max = values[1].as_u64()?;
        if min >= max || max > u16::MAX as u64 {
            return None;
        }
        Some([min as u16, max as u16])
    }

    fn parse_daemon_frame_perf(payload: &Value) -> Option<DaemonFramePerf> {
        if payload.get("source")?.as_str()? != "frame_socket" {
            return None;
        }
        if payload.get("render_mode")?.as_str()? != "3d" {
            return None;
        }
        let total_ms = payload.get("frame_total_ms")?.as_f64()?;
        let raymarch_ms = payload.get("raymarch_ms")?.as_f64()?;
        let cache_lookup_ms = payload.get("cache_lookup_ms")?.as_f64().unwrap_or(0.0);
        let cache_load_ms = payload.get("cache_load_ms")?.as_f64().unwrap_or(0.0);
        let encode_write_ms = payload.get("encode_write_ms")?.as_f64().unwrap_or(0.0);
        let bricks_traversed = payload
            .get("bricks_traversed")
            .and_then(Value::as_u64)
            .unwrap_or(0);
        let bricks_sampled = payload
            .get("bricks_sampled")
            .and_then(Value::as_u64)
            .unwrap_or(0);
        let samples_taken = payload
            .get("samples_taken")
            .and_then(Value::as_u64)
            .unwrap_or(0);
        let skip_ratio = payload
            .get("skip_ratio")
            .and_then(Value::as_f64)
            .unwrap_or(0.0);
        let raymarch_parallel = payload
            .get("raymarch_parallel")
            .and_then(Value::as_bool)
            .unwrap_or(false);
        let raymarch_workers = payload
            .get("raymarch_workers")
            .and_then(Value::as_u64)
            .unwrap_or(0);
        let rows_parallelized = payload
            .get("rows_parallelized")
            .and_then(Value::as_u64)
            .unwrap_or(0);
        Some(DaemonFramePerf {
            total_ms,
            raymarch_ms,
            cache_ms: cache_lookup_ms + cache_load_ms,
            encode_write_ms,
            bricks_traversed,
            bricks_sampled,
            samples_taken,
            skip_ratio,
            raymarch_parallel,
            raymarch_workers,
            rows_parallelized,
        })
    }

    fn payload_has_nonzero_u16(payload: &[u8]) -> bool {
        payload
            .chunks_exact(2)
            .any(|bytes| bytes[0] != 0 || bytes[1] != 0)
    }

    fn robust_percentile_limits_u16(payload: &[u8], low: f64, high: f64) -> Option<[u16; 2]> {
        if payload.len() < 2 {
            return None;
        }
        let mut histogram = vec![0u32; (u16::MAX as usize) + 1];
        let mut count: u64 = 0;
        for bytes in payload.chunks_exact(2) {
            let value = u16::from_le_bytes([bytes[0], bytes[1]]);
            histogram[value as usize] += 1;
            count += 1;
        }
        if count == 0 {
            return None;
        }

        let max_rank = (count - 1) as f64;
        let low_rank = (max_rank * low).round().clamp(0.0, max_rank) as u64;
        let high_rank = (max_rank * high).round().clamp(low_rank as f64, max_rank) as u64;

        let mut cumulative: u64 = 0;
        let mut min_value: Option<u16> = None;
        let mut max_value: u16 = u16::MAX;
        for (value, bin_count) in histogram.iter().enumerate() {
            cumulative += *bin_count as u64;
            if min_value.is_none() && cumulative > low_rank {
                min_value = Some(value as u16);
            }
            if cumulative > high_rank {
                max_value = value as u16;
                break;
            }
        }

        let min_value = min_value?;
        let max_value = if min_value >= max_value {
            min_value.saturating_add(1).max(min_value)
        } else {
            max_value
        };
        Some([min_value.min(max_value.saturating_sub(1)), max_value])
    }

    fn toggle_sampling_mode(mode: SamplingMode) -> SamplingMode {
        match mode {
            SamplingMode::Nearest => SamplingMode::Linear,
            SamplingMode::Linear => SamplingMode::Nearest,
        }
    }

    fn first_visible_image_layer(
        layers: &[LayerSummary],
    ) -> Option<(String, Option<usize>, ImageRenderStateSummary)> {
        for layer in layers {
            if !layer.visible {
                continue;
            }
            if let LayerKindSummary::Image {
                channel,
                render_state,
                ..
            } = &layer.kind
            {
                return Some((layer.id.clone(), *channel, render_state.clone()));
            }
        }
        None
    }

    fn pixel_scales(
        viewport_width: f64,
        viewport_height: f64,
        image_width: f64,
        image_height: f64,
    ) -> [f64; 2] {
        [
            viewport_width.max(1.0) / image_width.max(1.0),
            viewport_height.max(1.0) / image_height.max(1.0),
        ]
    }

    fn cursor_to_ndc(
        cursor_x: f64,
        cursor_y: f64,
        viewport_width: f64,
        viewport_height: f64,
    ) -> [f64; 2] {
        [
            2.0 * ((cursor_x + 0.5) / viewport_width.max(1.0)) - 1.0,
            1.0 - 2.0 * ((cursor_y + 0.5) / viewport_height.max(1.0)),
        ]
    }

    fn world_point_from_cursor(
        cursor_x: f64,
        cursor_y: f64,
        viewport_width: f64,
        viewport_height: f64,
        image_width: u32,
        image_height: u32,
        pan_center: [f64; 2],
        zoom: f64,
    ) -> [f64; 2] {
        let [nx, ny] = cursor_to_ndc(cursor_x, cursor_y, viewport_width, viewport_height);
        let pixel_scale = pixel_scales(
            viewport_width,
            viewport_height,
            image_width.max(1) as f64,
            image_height.max(1) as f64,
        );
        [
            nx * pixel_scale[0] / zoom.max(0.05) + pan_center[0],
            ny * pixel_scale[1] / zoom.max(0.05) + pan_center[1],
        ]
    }

    fn pan_center_for_cursor_anchor(
        world_before_zoom: [f64; 2],
        cursor_x: f64,
        cursor_y: f64,
        viewport_width: f64,
        viewport_height: f64,
        image_width: u32,
        image_height: u32,
        zoom: f64,
    ) -> [f64; 2] {
        let [nx, ny] = cursor_to_ndc(cursor_x, cursor_y, viewport_width, viewport_height);
        let pixel_scale = pixel_scales(
            viewport_width,
            viewport_height,
            image_width.max(1) as f64,
            image_height.max(1) as f64,
        );
        [
            world_before_zoom[0] - nx * pixel_scale[0] / zoom.max(0.05),
            world_before_zoom[1] - ny * pixel_scale[1] / zoom.max(0.05),
        ]
    }

    #[cfg(test)]
    fn texel_coords_from_uv_for_mode(
        uv: [f64; 2],
        viewport_width: f64,
        viewport_height: f64,
        image_width: f64,
        image_height: f64,
        pan_center: [f64; 2],
        zoom: f64,
        render_mode: &str,
    ) -> [f64; 2] {
        if uses_camera_transform(render_mode) {
            let scale_x = viewport_width.max(1.0) / image_width.max(1.0);
            let scale_y = viewport_height.max(1.0) / image_height.max(1.0);
            let nx = uv[0] * 2.0 - 1.0;
            let ny = 1.0 - uv[1] * 2.0;
            let world_x = nx * scale_x / zoom.max(0.05) + pan_center[0];
            let world_y = ny * scale_y / zoom.max(0.05) + pan_center[1];
            let sample_x = world_x * 0.5 + 0.5;
            let sample_y = 0.5 - world_y * 0.5;
            [
                sample_x * image_width.max(1.0) - 0.5,
                sample_y * image_height.max(1.0) - 0.5,
            ]
        } else {
            [
                uv[0] * image_width.max(1.0) - 0.5,
                uv[1] * image_height.max(1.0) - 0.5,
            ]
        }
    }

    fn zoom_scale_factor(delta_steps: f64) -> f64 {
        1.1_f64.powf(delta_steps)
    }

    fn normalized_scroll_steps(raw_steps: f64) -> f64 {
        -raw_steps
    }

    fn interactive_3d_viewport(
        full_width: u32,
        full_height: u32,
        long_side_cap: u32,
    ) -> (u32, u32) {
        let full_width = full_width.max(1);
        let full_height = full_height.max(1);
        let long = full_width.max(full_height) as f64;
        let short = full_width.min(full_height) as f64;
        let mut scale = (long_side_cap.max(1) as f64 / long).min(1.0);
        let scaled_short = short * scale;
        if scaled_short < INTERACTIVE_SHORT_SIDE_MIN as f64
            && short >= INTERACTIVE_SHORT_SIDE_MIN as f64
        {
            let min_scale = INTERACTIVE_SHORT_SIDE_MIN as f64 / short;
            scale = scale.max(min_scale).min(1.0);
        }
        let width = ((full_width as f64 * scale).round() as u32).clamp(1, full_width);
        let height = ((full_height as f64 * scale).round() as u32).clamp(1, full_height);
        (width, height)
    }

    fn next_interactive_long_side_cap(current: u32, raymarch_ms: f64) -> u32 {
        let current = current.clamp(INTERACTIVE_LONG_SIDE_CAP_MIN, INTERACTIVE_LONG_SIDE_CAP_MAX);
        let next = if raymarch_ms > RAYMARCH_MS_DECREASE_THRESHOLD {
            (current as f64 * INTERACTIVE_LONG_SIDE_CAP_REDUCE_FACTOR).round() as u32
        } else if raymarch_ms < RAYMARCH_MS_INCREASE_THRESHOLD {
            (current as f64 * INTERACTIVE_LONG_SIDE_CAP_INCREASE_FACTOR).round() as u32
        } else {
            current
        };
        next.clamp(INTERACTIVE_LONG_SIDE_CAP_MIN, INTERACTIVE_LONG_SIDE_CAP_MAX)
    }

    fn can_settle_interactive_tier(
        now: Instant,
        last_input_at: Option<Instant>,
        entered_at: Option<Instant>,
    ) -> bool {
        let Some(last_input_at) = last_input_at else {
            return false;
        };
        let Some(entered_at) = entered_at else {
            return false;
        };
        now.duration_since(last_input_at) >= INTERACTIVE_IDLE_TO_SETTLE
            && now.duration_since(entered_at) >= INTERACTIVE_SETTLE_HYSTERESIS
    }

    fn should_hold_interactive(now: Instant, hold_until: Option<Instant>) -> bool {
        hold_until.map(|until| now < until).unwrap_or(false)
    }

    fn should_dispatch_settled_frame(
        is_3d_mode: bool,
        tier: FrameQualityTier,
        daemon_perf: Option<DaemonFramePerf>,
    ) -> bool {
        if !is_3d_mode || tier != FrameQualityTier::Settled {
            return true;
        }
        daemon_perf
            .map(|perf| perf.raymarch_ms <= RAYMARCH_MS_SETTLE_THRESHOLD)
            .unwrap_or(true)
    }

    fn auto_fit_zoom(
        viewport_width: u32,
        viewport_height: u32,
        image_width: u32,
        image_height: u32,
    ) -> f64 {
        let scale = pixel_scales(
            viewport_width.max(1) as f64,
            viewport_height.max(1) as f64,
            image_width.max(1) as f64,
            image_height.max(1) as f64,
        );
        scale[0].min(scale[1]).clamp(0.05, 200.0)
    }

    fn camera_is_default_for_auto_fit(center: [f64; 2], zoom: f64) -> bool {
        center[0].abs() < 1e-6 && center[1].abs() < 1e-6 && (zoom - 1.0).abs() < 1e-3
    }

    fn camera_state_from_inspect(
        camera: Option<&CameraSummary>,
    ) -> (String, [f64; 2], f64, FreeflyPose) {
        match camera {
            Some(CameraSummary::PanZoom { center, zoom }) => (
                "panzoom".to_string(),
                *center,
                zoom.abs().max(0.05),
                FreeflyPose::default(),
            ),
            Some(CameraSummary::Freefly {
                position,
                yaw_pitch_roll,
                speed,
            }) => (
                "freefly".to_string(),
                [0.0, 0.0],
                1.0,
                FreeflyPose {
                    position: *position,
                    yaw_pitch_roll: *yaw_pitch_roll,
                    speed: *speed,
                },
            ),
            Some(CameraSummary::Arcball { .. }) => (
                "arcball".to_string(),
                [0.0, 0.0],
                1.0,
                FreeflyPose::default(),
            ),
            None => (
                "panzoom".to_string(),
                [0.0, 0.0],
                1.0,
                FreeflyPose::default(),
            ),
        }
    }

    fn spawn_event_listener(
        control_socket_path: &str,
        session_id: &str,
    ) -> Result<Receiver<EventEnvelope>> {
        let stream = UnixStream::connect(control_socket_path)
            .with_context(|| format!("connect event stream {control_socket_path}"))?;
        let mut reader = BufReader::new(stream.try_clone()?);
        let mut writer = BufWriter::new(stream);

        let subscribe_request = RpcRequestEnvelope {
            jsonrpc: "2.0".to_string(),
            protocol_version: PROTOCOL_VERSION.to_string(),
            session_id: Some(session_id.to_string()),
            request_id: Uuid::new_v4().to_string(),
            method: "events.subscribe".to_string(),
            params: json!({}),
            timestamp: now_utc(),
        };
        serde_json::to_writer(&mut writer, &subscribe_request)?;
        writer.write_all(b"\n")?;
        writer.flush()?;

        let mut subscribe_response_line = String::new();
        reader.read_line(&mut subscribe_response_line)?;
        if subscribe_response_line.trim().is_empty() {
            bail!("events.subscribe did not return a response");
        }
        let subscribe_response: RpcResponseEnvelope =
            serde_json::from_str(&subscribe_response_line)
                .context("parse events.subscribe response")?;
        if let Some(error) = subscribe_response.error {
            bail!("events.subscribe failed: {}", error.message);
        }

        let (tx, rx) = mpsc::channel::<EventEnvelope>();
        std::thread::spawn(move || {
            let mut local_reader = reader;
            loop {
                let mut line = String::new();
                if local_reader.read_line(&mut line).is_err() {
                    break;
                }
                if line.trim().is_empty() {
                    continue;
                }
                let parsed = serde_json::from_str::<EventEnvelope>(&line);
                if let Ok(event) = parsed {
                    if tx.send(event).is_err() {
                        break;
                    }
                }
            }
        });

        Ok(rx)
    }

    #[derive(Clone, Copy)]
    struct RenderParamsUniform {
        camera: [f32; 4],
        contrast: [f32; 4],
        image: [f32; 4],
    }

    impl RenderParamsUniform {
        fn new() -> Self {
            Self {
                camera: [0.0, 0.0, 1.0, 0.0],
                contrast: [0.0, u16::MAX as f32, 1.0 / u16::MAX as f32, 0.0],
                image: [1.0, 1.0, 1.0, 1.0],
            }
        }

        fn encode_bytes(&self) -> [u8; 48] {
            let mut bytes = [0u8; 48];
            let mut write_f32 = |offset: usize, value: f32| {
                bytes[offset..offset + 4].copy_from_slice(&value.to_ne_bytes());
            };
            for (idx, value) in self.camera.iter().enumerate() {
                write_f32(idx * 4, *value);
            }
            for (idx, value) in self.contrast.iter().enumerate() {
                write_f32(16 + idx * 4, *value);
            }
            for (idx, value) in self.image.iter().enumerate() {
                write_f32(32 + idx * 4, *value);
            }
            bytes
        }
    }

    #[derive(Clone, Copy)]
    struct OverlayParamsUniform {
        viewport: [f32; 4],
        rect: [f32; 4],
    }

    impl OverlayParamsUniform {
        fn new() -> Self {
            Self {
                viewport: [1.0, 1.0, 1.0, 0.0],
                rect: [HUD_MARGIN_X as f32, HUD_MARGIN_Y as f32, 1.0, 1.0],
            }
        }

        fn encode_bytes(&self) -> [u8; 32] {
            let mut bytes = [0u8; 32];
            let mut write_f32 = |offset: usize, value: f32| {
                bytes[offset..offset + 4].copy_from_slice(&value.to_ne_bytes());
            };
            for (idx, value) in self.viewport.iter().enumerate() {
                write_f32(idx * 4, *value);
            }
            for (idx, value) in self.rect.iter().enumerate() {
                write_f32(16 + idx * 4, *value);
            }
            bytes
        }
    }

    struct OverlayRaster {
        width: u32,
        height: u32,
        rgba: Vec<u8>,
    }

    struct GpuRenderer {
        _instance: wgpu::Instance,
        surface: wgpu::Surface<'static>,
        device: wgpu::Device,
        queue: wgpu::Queue,
        config: wgpu::SurfaceConfiguration,
        render_pipeline: wgpu::RenderPipeline,
        overlay_pipeline: wgpu::RenderPipeline,
        bind_group_layout: wgpu::BindGroupLayout,
        bind_group: wgpu::BindGroup,
        overlay_bind_group_layout: wgpu::BindGroupLayout,
        overlay_bind_group: wgpu::BindGroup,
        texture: wgpu::Texture,
        texture_view: wgpu::TextureView,
        overlay_texture: wgpu::Texture,
        overlay_texture_view: wgpu::TextureView,
        overlay_sampler: wgpu::Sampler,
        texture_size: (u32, u32),
        overlay_size: (u32, u32),
        render_params: RenderParamsUniform,
        render_params_buffer: wgpu::Buffer,
        overlay_params: OverlayParamsUniform,
        overlay_params_buffer: wgpu::Buffer,
    }

    impl GpuRenderer {
        fn new(window: Arc<Window>) -> Result<Self> {
            let instance = wgpu::Instance::default();
            let surface = instance.create_surface(window.clone())?;

            let adapter =
                pollster::block_on(instance.request_adapter(&wgpu::RequestAdapterOptions {
                    power_preference: wgpu::PowerPreference::HighPerformance,
                    compatible_surface: Some(&surface),
                    force_fallback_adapter: false,
                }))
                .ok_or_else(|| anyhow!("unable to acquire suitable GPU adapter"))?;

            let (device, queue) = pollster::block_on(adapter.request_device(
                &wgpu::DeviceDescriptor {
                    label: Some("lucida-device"),
                    required_features: wgpu::Features::empty(),
                    required_limits: wgpu::Limits::default(),
                },
                None,
            ))?;

            let size = window.inner_size();
            let capabilities = surface.get_capabilities(&adapter);
            let format = capabilities
                .formats
                .iter()
                .copied()
                .find(|candidate| candidate.is_srgb())
                .unwrap_or(capabilities.formats[0]);
            let present_mode = capabilities
                .present_modes
                .iter()
                .copied()
                .find(|mode| *mode == wgpu::PresentMode::Fifo)
                .unwrap_or(capabilities.present_modes[0]);
            let alpha_mode = capabilities.alpha_modes[0];

            let mut config = wgpu::SurfaceConfiguration {
                usage: wgpu::TextureUsages::RENDER_ATTACHMENT,
                format,
                width: size.width.max(1),
                height: size.height.max(1),
                present_mode,
                alpha_mode,
                view_formats: vec![],
                desired_maximum_frame_latency: 2,
            };
            surface.configure(&device, &config);

            let shader = device.create_shader_module(wgpu::ShaderModuleDescriptor {
                label: Some("lucida-frame-shader"),
                source: wgpu::ShaderSource::Wgsl(Cow::Borrowed(SHADER_SOURCE)),
            });
            let overlay_shader = device.create_shader_module(wgpu::ShaderModuleDescriptor {
                label: Some("lucida-overlay-shader"),
                source: wgpu::ShaderSource::Wgsl(Cow::Borrowed(OVERLAY_SHADER_SOURCE)),
            });

            let bind_group_layout =
                device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
                    label: Some("lucida-frame-bind-group-layout"),
                    entries: &[
                        wgpu::BindGroupLayoutEntry {
                            binding: 0,
                            visibility: wgpu::ShaderStages::FRAGMENT,
                            ty: wgpu::BindingType::Texture {
                                sample_type: wgpu::TextureSampleType::Uint,
                                view_dimension: wgpu::TextureViewDimension::D2,
                                multisampled: false,
                            },
                            count: None,
                        },
                        wgpu::BindGroupLayoutEntry {
                            binding: 1,
                            visibility: wgpu::ShaderStages::FRAGMENT,
                            ty: wgpu::BindingType::Buffer {
                                ty: wgpu::BufferBindingType::Uniform,
                                has_dynamic_offset: false,
                                min_binding_size: Some(
                                    std::num::NonZeroU64::new(48).expect("nonzero"),
                                ),
                            },
                            count: None,
                        },
                    ],
                });

            let pipeline_layout = device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor {
                label: Some("lucida-frame-pipeline-layout"),
                bind_group_layouts: &[&bind_group_layout],
                push_constant_ranges: &[],
            });

            let render_pipeline = device.create_render_pipeline(&wgpu::RenderPipelineDescriptor {
                label: Some("lucida-frame-pipeline"),
                layout: Some(&pipeline_layout),
                vertex: wgpu::VertexState {
                    module: &shader,
                    entry_point: "vs_main",
                    buffers: &[],
                    compilation_options: wgpu::PipelineCompilationOptions::default(),
                },
                fragment: Some(wgpu::FragmentState {
                    module: &shader,
                    entry_point: "fs_main",
                    targets: &[Some(wgpu::ColorTargetState {
                        format: config.format,
                        blend: Some(wgpu::BlendState::REPLACE),
                        write_mask: wgpu::ColorWrites::ALL,
                    })],
                    compilation_options: wgpu::PipelineCompilationOptions::default(),
                }),
                primitive: wgpu::PrimitiveState::default(),
                depth_stencil: None,
                multisample: wgpu::MultisampleState::default(),
                multiview: None,
            });

            let overlay_bind_group_layout =
                device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
                    label: Some("lucida-overlay-bind-group-layout"),
                    entries: &[
                        wgpu::BindGroupLayoutEntry {
                            binding: 0,
                            visibility: wgpu::ShaderStages::FRAGMENT,
                            ty: wgpu::BindingType::Texture {
                                sample_type: wgpu::TextureSampleType::Float { filterable: true },
                                view_dimension: wgpu::TextureViewDimension::D2,
                                multisampled: false,
                            },
                            count: None,
                        },
                        wgpu::BindGroupLayoutEntry {
                            binding: 1,
                            visibility: wgpu::ShaderStages::FRAGMENT,
                            ty: wgpu::BindingType::Sampler(wgpu::SamplerBindingType::Filtering),
                            count: None,
                        },
                        wgpu::BindGroupLayoutEntry {
                            binding: 2,
                            visibility: wgpu::ShaderStages::FRAGMENT,
                            ty: wgpu::BindingType::Buffer {
                                ty: wgpu::BufferBindingType::Uniform,
                                has_dynamic_offset: false,
                                min_binding_size: Some(
                                    std::num::NonZeroU64::new(32).expect("nonzero"),
                                ),
                            },
                            count: None,
                        },
                    ],
                });
            let overlay_pipeline_layout =
                device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor {
                    label: Some("lucida-overlay-pipeline-layout"),
                    bind_group_layouts: &[&overlay_bind_group_layout],
                    push_constant_ranges: &[],
                });
            let overlay_pipeline = device.create_render_pipeline(&wgpu::RenderPipelineDescriptor {
                label: Some("lucida-overlay-pipeline"),
                layout: Some(&overlay_pipeline_layout),
                vertex: wgpu::VertexState {
                    module: &overlay_shader,
                    entry_point: "vs_main",
                    buffers: &[],
                    compilation_options: wgpu::PipelineCompilationOptions::default(),
                },
                fragment: Some(wgpu::FragmentState {
                    module: &overlay_shader,
                    entry_point: "fs_main",
                    targets: &[Some(wgpu::ColorTargetState {
                        format: config.format,
                        blend: Some(wgpu::BlendState::ALPHA_BLENDING),
                        write_mask: wgpu::ColorWrites::ALL,
                    })],
                    compilation_options: wgpu::PipelineCompilationOptions::default(),
                }),
                primitive: wgpu::PrimitiveState::default(),
                depth_stencil: None,
                multisample: wgpu::MultisampleState::default(),
                multiview: None,
            });

            let render_params = RenderParamsUniform::new();
            let render_params_buffer = device.create_buffer(&wgpu::BufferDescriptor {
                label: Some("lucida-render-params"),
                size: 48,
                usage: wgpu::BufferUsages::UNIFORM | wgpu::BufferUsages::COPY_DST,
                mapped_at_creation: false,
            });
            queue.write_buffer(&render_params_buffer, 0, &render_params.encode_bytes());
            let overlay_params = OverlayParamsUniform::new();
            let overlay_params_buffer = device.create_buffer(&wgpu::BufferDescriptor {
                label: Some("lucida-overlay-params"),
                size: 32,
                usage: wgpu::BufferUsages::UNIFORM | wgpu::BufferUsages::COPY_DST,
                mapped_at_creation: false,
            });
            queue.write_buffer(&overlay_params_buffer, 0, &overlay_params.encode_bytes());

            let (texture, texture_view) = create_frame_texture(&device, 1, 1);
            let bind_group = create_frame_bind_group(
                &device,
                &bind_group_layout,
                &texture_view,
                &render_params_buffer,
            );
            let (overlay_texture, overlay_texture_view) = create_overlay_texture(&device, 1, 1);
            let overlay_sampler = device.create_sampler(&wgpu::SamplerDescriptor {
                label: Some("lucida-overlay-sampler"),
                address_mode_u: wgpu::AddressMode::ClampToEdge,
                address_mode_v: wgpu::AddressMode::ClampToEdge,
                address_mode_w: wgpu::AddressMode::ClampToEdge,
                mag_filter: wgpu::FilterMode::Nearest,
                min_filter: wgpu::FilterMode::Nearest,
                mipmap_filter: wgpu::FilterMode::Nearest,
                ..Default::default()
            });
            let overlay_bind_group = create_overlay_bind_group(
                &device,
                &overlay_bind_group_layout,
                &overlay_texture_view,
                &overlay_sampler,
                &overlay_params_buffer,
            );

            config.width = size.width.max(1);
            config.height = size.height.max(1);

            Ok(Self {
                _instance: instance,
                surface,
                device,
                queue,
                config,
                render_pipeline,
                overlay_pipeline,
                bind_group_layout,
                bind_group,
                overlay_bind_group_layout,
                overlay_bind_group,
                texture,
                texture_view,
                overlay_texture,
                overlay_texture_view,
                overlay_sampler,
                texture_size: (1, 1),
                overlay_size: (1, 1),
                render_params,
                render_params_buffer,
                overlay_params,
                overlay_params_buffer,
            })
        }

        fn image_dimensions(&self) -> (u32, u32) {
            self.texture_size
        }

        fn resize(&mut self, width: u32, height: u32) {
            self.config.width = width.max(1);
            self.config.height = height.max(1);
            self.surface.configure(&self.device, &self.config);
        }

        fn update_frame(&mut self, frame: &FrameImage) -> Result<()> {
            if frame.width == 0 || frame.height == 0 {
                return Ok(());
            }
            if frame.payload.len() != (frame.width as usize * frame.height as usize * 2) {
                bail!(
                    "u16 payload length mismatch: got {}, expected {}",
                    frame.payload.len(),
                    frame.width as usize * frame.height as usize * 2
                );
            }
            if self.texture_size != (frame.width, frame.height) {
                let (texture, texture_view) =
                    create_frame_texture(&self.device, frame.width, frame.height);
                self.texture = texture;
                self.texture_view = texture_view;
                self.texture_size = (frame.width, frame.height);
                self.bind_group = create_frame_bind_group(
                    &self.device,
                    &self.bind_group_layout,
                    &self.texture_view,
                    &self.render_params_buffer,
                );
            }

            let unpadded_bytes_per_row = frame.width as usize * 2;
            let padded_bytes_per_row =
                ((unpadded_bytes_per_row + wgpu::COPY_BYTES_PER_ROW_ALIGNMENT as usize - 1)
                    / wgpu::COPY_BYTES_PER_ROW_ALIGNMENT as usize)
                    * wgpu::COPY_BYTES_PER_ROW_ALIGNMENT as usize;
            let mut padded = vec![0u8; padded_bytes_per_row * frame.height as usize];
            for row in 0..frame.height as usize {
                let src_start = row * unpadded_bytes_per_row;
                let src_end = src_start + unpadded_bytes_per_row;
                let dst_start = row * padded_bytes_per_row;
                let dst_end = dst_start + unpadded_bytes_per_row;
                padded[dst_start..dst_end].copy_from_slice(&frame.payload[src_start..src_end]);
            }

            self.queue.write_texture(
                wgpu::ImageCopyTexture {
                    texture: &self.texture,
                    mip_level: 0,
                    origin: wgpu::Origin3d::ZERO,
                    aspect: wgpu::TextureAspect::All,
                },
                &padded,
                wgpu::ImageDataLayout {
                    offset: 0,
                    bytes_per_row: Some(padded_bytes_per_row as u32),
                    rows_per_image: Some(frame.height),
                },
                wgpu::Extent3d {
                    width: frame.width,
                    height: frame.height,
                    depth_or_array_layers: 1,
                },
            );
            Ok(())
        }

        fn update_view_params(
            &mut self,
            viewport_width: u32,
            viewport_height: u32,
            render_mode: &str,
            pan_center: [f64; 2],
            zoom: f64,
            sampling_mode: SamplingMode,
            contrast_limits: [u16; 2],
        ) {
            let contrast_min = contrast_limits[0].min(contrast_limits[1].saturating_sub(1));
            let contrast_max = contrast_limits[1].max(contrast_min.saturating_add(1));
            let contrast_range = (contrast_max as f32 - contrast_min as f32).max(1.0);
            let use_camera_transform = uses_camera_transform(render_mode);
            self.render_params.camera = [
                if use_camera_transform {
                    pan_center[0] as f32
                } else {
                    0.0
                },
                if use_camera_transform {
                    pan_center[1] as f32
                } else {
                    0.0
                },
                if use_camera_transform {
                    zoom.max(0.05) as f32
                } else {
                    1.0
                },
                if matches!(sampling_mode, SamplingMode::Linear) {
                    1.0
                } else {
                    0.0
                },
            ];
            self.render_params.contrast = [
                contrast_min as f32,
                contrast_max as f32,
                1.0 / contrast_range,
                if use_camera_transform { 1.0 } else { 0.0 },
            ];
            self.render_params.image = [
                self.texture_size.0.max(1) as f32,
                self.texture_size.1.max(1) as f32,
                viewport_width.max(1) as f32,
                viewport_height.max(1) as f32,
            ];
            self.queue.write_buffer(
                &self.render_params_buffer,
                0,
                &self.render_params.encode_bytes(),
            );
            self.overlay_params.viewport[0] = viewport_width.max(1) as f32;
            self.overlay_params.viewport[1] = viewport_height.max(1) as f32;
            self.queue.write_buffer(
                &self.overlay_params_buffer,
                0,
                &self.overlay_params.encode_bytes(),
            );
        }

        fn update_debug_overlay(&mut self, lines: &[String], show: bool) {
            self.overlay_params.viewport[2] = if show { 1.0 } else { 0.0 };
            if show {
                let raster = build_debug_overlay_raster(lines);
                self.overlay_params.rect[2] = raster.width as f32;
                self.overlay_params.rect[3] = raster.height as f32;
                if self.overlay_size != (raster.width, raster.height) {
                    let (overlay_texture, overlay_texture_view) =
                        create_overlay_texture(&self.device, raster.width, raster.height);
                    self.overlay_texture = overlay_texture;
                    self.overlay_texture_view = overlay_texture_view;
                    self.overlay_size = (raster.width, raster.height);
                    self.overlay_bind_group = create_overlay_bind_group(
                        &self.device,
                        &self.overlay_bind_group_layout,
                        &self.overlay_texture_view,
                        &self.overlay_sampler,
                        &self.overlay_params_buffer,
                    );
                }

                let unpadded_bytes_per_row = raster.width as usize * 4;
                let padded_bytes_per_row =
                    ((unpadded_bytes_per_row + wgpu::COPY_BYTES_PER_ROW_ALIGNMENT as usize - 1)
                        / wgpu::COPY_BYTES_PER_ROW_ALIGNMENT as usize)
                        * wgpu::COPY_BYTES_PER_ROW_ALIGNMENT as usize;
                let mut padded = vec![0u8; padded_bytes_per_row * raster.height as usize];
                for row in 0..raster.height as usize {
                    let src_start = row * unpadded_bytes_per_row;
                    let src_end = src_start + unpadded_bytes_per_row;
                    let dst_start = row * padded_bytes_per_row;
                    let dst_end = dst_start + unpadded_bytes_per_row;
                    padded[dst_start..dst_end].copy_from_slice(&raster.rgba[src_start..src_end]);
                }
                self.queue.write_texture(
                    wgpu::ImageCopyTexture {
                        texture: &self.overlay_texture,
                        mip_level: 0,
                        origin: wgpu::Origin3d::ZERO,
                        aspect: wgpu::TextureAspect::All,
                    },
                    &padded,
                    wgpu::ImageDataLayout {
                        offset: 0,
                        bytes_per_row: Some(padded_bytes_per_row as u32),
                        rows_per_image: Some(raster.height),
                    },
                    wgpu::Extent3d {
                        width: raster.width,
                        height: raster.height,
                        depth_or_array_layers: 1,
                    },
                );
            }
            self.queue.write_buffer(
                &self.overlay_params_buffer,
                0,
                &self.overlay_params.encode_bytes(),
            );
        }

        fn render(&mut self) -> Result<()> {
            let surface_texture = match self.surface.get_current_texture() {
                Ok(texture) => texture,
                Err(SurfaceError::Outdated | SurfaceError::Lost) => {
                    self.surface.configure(&self.device, &self.config);
                    return Ok(());
                }
                Err(SurfaceError::Timeout) => return Ok(()),
                Err(SurfaceError::OutOfMemory) => bail!("GPU surface out of memory"),
            };

            let view = surface_texture
                .texture
                .create_view(&wgpu::TextureViewDescriptor::default());
            let mut encoder = self
                .device
                .create_command_encoder(&wgpu::CommandEncoderDescriptor {
                    label: Some("lucida-render-encoder"),
                });
            {
                let mut render_pass = encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
                    label: Some("lucida-render-pass"),
                    color_attachments: &[Some(wgpu::RenderPassColorAttachment {
                        view: &view,
                        resolve_target: None,
                        ops: wgpu::Operations {
                            load: wgpu::LoadOp::Clear(wgpu::Color {
                                r: 0.02,
                                g: 0.03,
                                b: 0.04,
                                a: 1.0,
                            }),
                            store: wgpu::StoreOp::Store,
                        },
                    })],
                    depth_stencil_attachment: None,
                    timestamp_writes: None,
                    occlusion_query_set: None,
                });
                render_pass.set_pipeline(&self.render_pipeline);
                render_pass.set_bind_group(0, &self.bind_group, &[]);
                render_pass.draw(0..3, 0..1);
                render_pass.set_pipeline(&self.overlay_pipeline);
                render_pass.set_bind_group(0, &self.overlay_bind_group, &[]);
                render_pass.draw(0..3, 0..1);
            }
            self.queue.submit(Some(encoder.finish()));
            surface_texture.present();
            Ok(())
        }
    }

    fn create_frame_texture(
        device: &wgpu::Device,
        width: u32,
        height: u32,
    ) -> (wgpu::Texture, wgpu::TextureView) {
        let texture = device.create_texture(&wgpu::TextureDescriptor {
            label: Some("lucida-frame-texture"),
            size: wgpu::Extent3d {
                width: width.max(1),
                height: height.max(1),
                depth_or_array_layers: 1,
            },
            mip_level_count: 1,
            sample_count: 1,
            dimension: wgpu::TextureDimension::D2,
            format: wgpu::TextureFormat::R16Uint,
            usage: wgpu::TextureUsages::TEXTURE_BINDING | wgpu::TextureUsages::COPY_DST,
            view_formats: &[],
        });
        let texture_view = texture.create_view(&wgpu::TextureViewDescriptor::default());
        (texture, texture_view)
    }

    fn create_frame_bind_group(
        device: &wgpu::Device,
        bind_group_layout: &wgpu::BindGroupLayout,
        texture_view: &wgpu::TextureView,
        render_params_buffer: &wgpu::Buffer,
    ) -> wgpu::BindGroup {
        device.create_bind_group(&wgpu::BindGroupDescriptor {
            label: Some("lucida-frame-bind-group"),
            layout: bind_group_layout,
            entries: &[
                wgpu::BindGroupEntry {
                    binding: 0,
                    resource: wgpu::BindingResource::TextureView(texture_view),
                },
                wgpu::BindGroupEntry {
                    binding: 1,
                    resource: wgpu::BindingResource::Buffer(wgpu::BufferBinding {
                        buffer: render_params_buffer,
                        offset: 0,
                        size: Some(std::num::NonZeroU64::new(48).expect("nonzero")),
                    }),
                },
            ],
        })
    }

    fn create_overlay_texture(
        device: &wgpu::Device,
        width: u32,
        height: u32,
    ) -> (wgpu::Texture, wgpu::TextureView) {
        let texture = device.create_texture(&wgpu::TextureDescriptor {
            label: Some("lucida-overlay-texture"),
            size: wgpu::Extent3d {
                width: width.max(1),
                height: height.max(1),
                depth_or_array_layers: 1,
            },
            mip_level_count: 1,
            sample_count: 1,
            dimension: wgpu::TextureDimension::D2,
            format: wgpu::TextureFormat::Rgba8UnormSrgb,
            usage: wgpu::TextureUsages::TEXTURE_BINDING | wgpu::TextureUsages::COPY_DST,
            view_formats: &[],
        });
        let texture_view = texture.create_view(&wgpu::TextureViewDescriptor::default());
        (texture, texture_view)
    }

    fn create_overlay_bind_group(
        device: &wgpu::Device,
        bind_group_layout: &wgpu::BindGroupLayout,
        texture_view: &wgpu::TextureView,
        sampler: &wgpu::Sampler,
        overlay_params_buffer: &wgpu::Buffer,
    ) -> wgpu::BindGroup {
        device.create_bind_group(&wgpu::BindGroupDescriptor {
            label: Some("lucida-overlay-bind-group"),
            layout: bind_group_layout,
            entries: &[
                wgpu::BindGroupEntry {
                    binding: 0,
                    resource: wgpu::BindingResource::TextureView(texture_view),
                },
                wgpu::BindGroupEntry {
                    binding: 1,
                    resource: wgpu::BindingResource::Sampler(sampler),
                },
                wgpu::BindGroupEntry {
                    binding: 2,
                    resource: wgpu::BindingResource::Buffer(wgpu::BufferBinding {
                        buffer: overlay_params_buffer,
                        offset: 0,
                        size: Some(std::num::NonZeroU64::new(32).expect("nonzero")),
                    }),
                },
            ],
        })
    }

    fn build_debug_overlay_raster(lines: &[String]) -> OverlayRaster {
        let lines = if lines.is_empty() {
            vec![String::from("NO METRICS")]
        } else {
            lines.to_vec()
        };
        let max_chars = lines
            .iter()
            .map(|line| line.len())
            .max()
            .unwrap_or(1)
            .max(1) as u32;
        let scaled_glyph_w = HUD_GLYPH_W * HUD_PIXEL_SCALE;
        let scaled_glyph_h = HUD_GLYPH_H * HUD_PIXEL_SCALE;
        let scaled_glyph_spacing_x = HUD_GLYPH_SPACING_X * HUD_PIXEL_SCALE;
        let scaled_line_spacing_y = HUD_LINE_SPACING_Y * HUD_PIXEL_SCALE;
        let char_w = scaled_glyph_w + scaled_glyph_spacing_x;
        let line_h = scaled_glyph_h + scaled_line_spacing_y;
        let width = HUD_PADDING_X * 2 + max_chars * char_w + 1;
        let height = HUD_PADDING_Y * 2 + lines.len() as u32 * line_h + 1;
        let mut rgba = vec![0u8; (width * height * 4) as usize];

        fill_rect(
            &mut rgba,
            width,
            height,
            0,
            0,
            width,
            height,
            [6, 10, 14, 205],
        );
        stroke_rect(
            &mut rgba,
            width,
            height,
            0,
            0,
            width,
            height,
            [70, 92, 108, 240],
        );

        for (line_idx, line) in lines.iter().enumerate() {
            let y = HUD_PADDING_Y + line_idx as u32 * line_h;
            draw_overlay_text(
                &mut rgba,
                width,
                height,
                HUD_PADDING_X,
                y,
                &line.to_ascii_uppercase(),
                [215, 226, 235, 255],
            );
        }

        OverlayRaster {
            width: width.max(1),
            height: height.max(1),
            rgba,
        }
    }

    fn fill_rect(
        rgba: &mut [u8],
        width: u32,
        height: u32,
        x: u32,
        y: u32,
        rect_w: u32,
        rect_h: u32,
        color: [u8; 4],
    ) {
        let max_x = (x + rect_w).min(width);
        let max_y = (y + rect_h).min(height);
        for yy in y..max_y {
            for xx in x..max_x {
                let idx = ((yy * width + xx) * 4) as usize;
                rgba[idx..idx + 4].copy_from_slice(&color);
            }
        }
    }

    fn stroke_rect(
        rgba: &mut [u8],
        width: u32,
        height: u32,
        x: u32,
        y: u32,
        rect_w: u32,
        rect_h: u32,
        color: [u8; 4],
    ) {
        if rect_w == 0 || rect_h == 0 {
            return;
        }
        fill_rect(rgba, width, height, x, y, rect_w, 1, color);
        fill_rect(
            rgba,
            width,
            height,
            x,
            y + rect_h.saturating_sub(1),
            rect_w,
            1,
            color,
        );
        fill_rect(rgba, width, height, x, y, 1, rect_h, color);
        fill_rect(
            rgba,
            width,
            height,
            x + rect_w.saturating_sub(1),
            y,
            1,
            rect_h,
            color,
        );
    }

    fn draw_overlay_text(
        rgba: &mut [u8],
        width: u32,
        height: u32,
        mut x: u32,
        y: u32,
        text: &str,
        color: [u8; 4],
    ) {
        for ch in text.chars() {
            draw_overlay_char(rgba, width, height, x, y, ch, color);
            x += (HUD_GLYPH_W + HUD_GLYPH_SPACING_X) * HUD_PIXEL_SCALE;
        }
    }

    fn draw_overlay_char(
        rgba: &mut [u8],
        width: u32,
        height: u32,
        x: u32,
        y: u32,
        ch: char,
        color: [u8; 4],
    ) {
        let glyph = hud_glyph(ch);
        for (row, bits) in glyph.iter().enumerate() {
            for col in 0..HUD_GLYPH_W {
                let mask = 1 << (HUD_GLYPH_W - 1 - col);
                if (bits & mask) == 0 {
                    continue;
                }
                let px = x + col * HUD_PIXEL_SCALE;
                let py = y + row as u32 * HUD_PIXEL_SCALE;
                fill_rect(
                    rgba,
                    width,
                    height,
                    px,
                    py,
                    HUD_PIXEL_SCALE,
                    HUD_PIXEL_SCALE,
                    color,
                );
            }
        }
    }

    fn hud_glyph(ch: char) -> [u8; 7] {
        match ch {
            '0' => [
                0b01110, 0b10001, 0b10011, 0b10101, 0b11001, 0b10001, 0b01110,
            ],
            '1' => [
                0b00100, 0b01100, 0b00100, 0b00100, 0b00100, 0b00100, 0b01110,
            ],
            '2' => [
                0b01110, 0b10001, 0b00001, 0b00010, 0b00100, 0b01000, 0b11111,
            ],
            '3' => [
                0b11110, 0b00001, 0b00001, 0b01110, 0b00001, 0b00001, 0b11110,
            ],
            '4' => [
                0b00010, 0b00110, 0b01010, 0b10010, 0b11111, 0b00010, 0b00010,
            ],
            '5' => [
                0b11111, 0b10000, 0b10000, 0b11110, 0b00001, 0b00001, 0b11110,
            ],
            '6' => [
                0b01110, 0b10000, 0b10000, 0b11110, 0b10001, 0b10001, 0b01110,
            ],
            '7' => [
                0b11111, 0b00001, 0b00010, 0b00100, 0b01000, 0b01000, 0b01000,
            ],
            '8' => [
                0b01110, 0b10001, 0b10001, 0b01110, 0b10001, 0b10001, 0b01110,
            ],
            '9' => [
                0b01110, 0b10001, 0b10001, 0b01111, 0b00001, 0b00001, 0b01110,
            ],
            'A' => [
                0b01110, 0b10001, 0b10001, 0b11111, 0b10001, 0b10001, 0b10001,
            ],
            'B' => [
                0b11110, 0b10001, 0b10001, 0b11110, 0b10001, 0b10001, 0b11110,
            ],
            'C' => [
                0b01110, 0b10001, 0b10000, 0b10000, 0b10000, 0b10001, 0b01110,
            ],
            'D' => [
                0b11100, 0b10010, 0b10001, 0b10001, 0b10001, 0b10010, 0b11100,
            ],
            'E' => [
                0b11111, 0b10000, 0b10000, 0b11110, 0b10000, 0b10000, 0b11111,
            ],
            'F' => [
                0b11111, 0b10000, 0b10000, 0b11110, 0b10000, 0b10000, 0b10000,
            ],
            'G' => [
                0b01111, 0b10000, 0b10000, 0b10011, 0b10001, 0b10001, 0b01110,
            ],
            'I' => [
                0b01110, 0b00100, 0b00100, 0b00100, 0b00100, 0b00100, 0b01110,
            ],
            'K' => [
                0b10001, 0b10010, 0b10100, 0b11000, 0b10100, 0b10010, 0b10001,
            ],
            'L' => [
                0b10000, 0b10000, 0b10000, 0b10000, 0b10000, 0b10000, 0b11111,
            ],
            'M' => [
                0b10001, 0b11011, 0b10101, 0b10101, 0b10001, 0b10001, 0b10001,
            ],
            'N' => [
                0b10001, 0b10001, 0b11001, 0b10101, 0b10011, 0b10001, 0b10001,
            ],
            'O' => [
                0b01110, 0b10001, 0b10001, 0b10001, 0b10001, 0b10001, 0b01110,
            ],
            'P' => [
                0b11110, 0b10001, 0b10001, 0b11110, 0b10000, 0b10000, 0b10000,
            ],
            'Q' => [
                0b01110, 0b10001, 0b10001, 0b10001, 0b10101, 0b10010, 0b01101,
            ],
            'R' => [
                0b11110, 0b10001, 0b10001, 0b11110, 0b10100, 0b10010, 0b10001,
            ],
            'S' => [
                0b01111, 0b10000, 0b10000, 0b01110, 0b00001, 0b00001, 0b11110,
            ],
            'T' => [
                0b11111, 0b00100, 0b00100, 0b00100, 0b00100, 0b00100, 0b00100,
            ],
            'U' => [
                0b10001, 0b10001, 0b10001, 0b10001, 0b10001, 0b10001, 0b01110,
            ],
            'Y' => [
                0b10001, 0b10001, 0b01010, 0b00100, 0b00100, 0b00100, 0b00100,
            ],
            'Z' => [
                0b11111, 0b00001, 0b00010, 0b00100, 0b01000, 0b10000, 0b11111,
            ],
            ':' => [
                0b00000, 0b00100, 0b00100, 0b00000, 0b00100, 0b00100, 0b00000,
            ],
            '.' => [
                0b00000, 0b00000, 0b00000, 0b00000, 0b00000, 0b00100, 0b00100,
            ],
            '-' => [
                0b00000, 0b00000, 0b00000, 0b11111, 0b00000, 0b00000, 0b00000,
            ],
            '(' => [
                0b00010, 0b00100, 0b01000, 0b01000, 0b01000, 0b00100, 0b00010,
            ],
            ')' => [
                0b01000, 0b00100, 0b00010, 0b00010, 0b00010, 0b00100, 0b01000,
            ],
            '[' => [
                0b01110, 0b01000, 0b01000, 0b01000, 0b01000, 0b01000, 0b01110,
            ],
            ']' => [
                0b01110, 0b00010, 0b00010, 0b00010, 0b00010, 0b00010, 0b01110,
            ],
            '/' => [
                0b00001, 0b00010, 0b00100, 0b01000, 0b10000, 0b00000, 0b00000,
            ],
            ' ' => [0, 0, 0, 0, 0, 0, 0],
            _ => [
                0b11111, 0b10001, 0b00100, 0b00100, 0b00100, 0b10001, 0b11111,
            ],
        }
    }

    struct LucidaApp {
        client: AppClient,
        window: Option<Arc<Window>>,
        window_id: Option<WindowId>,
        renderer: Option<GpuRenderer>,
        needs_frame: bool,
        needs_redraw: bool,
        pending_auto_fit: bool,
        pending_3d_bootstrap: bool,
        frame_quality_tier: FrameQualityTier,
        interactive_long_side_cap: u32,
        camera_generation: u64,
        show_debug_hud: bool,
        force_interactive_until: Option<Instant>,
        interactive_since: Option<Instant>,
        last_3d_input_at: Option<Instant>,
        last_adapted_perf_version: u64,
        tracked_image_layer_id: Option<String>,
        tracked_render_mode: String,
        frame_scheduler: FrameRequestScheduler,
        mouse_pan_active: bool,
        mouse_look_active: bool,
        last_cursor_pos: Option<(f64, f64)>,
        held_keys: BTreeSet<KeyCode>,
        last_input_tick: Instant,
        last_render_at: Option<Instant>,
        fps_ema: f64,
        frame_rtt_ms_ema: f64,
        upload_ms_ema: f64,
        present_ms_ema: f64,
        last_worker_error: Option<String>,
    }

    impl LucidaApp {
        fn new(client: AppClient) -> Self {
            let pending_auto_fit = camera_is_default_for_auto_fit(client.pan_center, client.zoom);
            let tracked_image_layer_id = Some(client.active_image_layer_id.clone());
            let tracked_render_mode = client.render_mode.clone();
            Self {
                client,
                window: None,
                window_id: None,
                renderer: None,
                needs_frame: true,
                needs_redraw: true,
                pending_auto_fit,
                pending_3d_bootstrap: false,
                frame_quality_tier: FrameQualityTier::Settled,
                interactive_long_side_cap: INTERACTIVE_LONG_SIDE_CAP_MAX,
                camera_generation: 0,
                show_debug_hud: true,
                force_interactive_until: None,
                interactive_since: None,
                last_3d_input_at: None,
                last_adapted_perf_version: 0,
                tracked_image_layer_id,
                tracked_render_mode,
                frame_scheduler: FrameRequestScheduler::default(),
                mouse_pan_active: false,
                mouse_look_active: false,
                last_cursor_pos: None,
                held_keys: BTreeSet::new(),
                last_input_tick: Instant::now(),
                last_render_at: None,
                fps_ema: 0.0,
                frame_rtt_ms_ema: 0.0,
                upload_ms_ema: 0.0,
                present_ms_ema: 0.0,
                last_worker_error: None,
            }
        }

        fn apply_render_update(&mut self, update: RenderUpdate) {
            if update.needs_frame() {
                self.needs_frame = true;
            }
            if update.needs_redraw() {
                self.needs_redraw = true;
            }
        }

        fn smooth_ema(previous: f64, value: f64) -> f64 {
            if previous <= 0.0 {
                value
            } else {
                previous * 0.85 + value * 0.15
            }
        }

        fn note_3d_camera_input(&mut self) {
            if !self.client.is_3d_mode() {
                return;
            }
            let now = Instant::now();
            self.camera_generation = self.camera_generation.saturating_add(1);
            self.last_3d_input_at = Some(now);
            if self.frame_quality_tier != FrameQualityTier::Interactive {
                self.frame_quality_tier = FrameQualityTier::Interactive;
                self.interactive_since = Some(now);
            }
            self.needs_frame = true;
            self.needs_redraw = true;
        }

        fn maybe_settle_3d_quality(&mut self) {
            if !self.client.is_3d_mode() {
                self.frame_quality_tier = FrameQualityTier::Settled;
                self.interactive_long_side_cap = INTERACTIVE_LONG_SIDE_CAP_MAX;
                self.force_interactive_until = None;
                self.interactive_since = None;
                self.last_3d_input_at = None;
                return;
            }
            if self.frame_quality_tier != FrameQualityTier::Interactive {
                return;
            }
            let now = Instant::now();
            if should_hold_interactive(now, self.force_interactive_until) {
                return;
            }
            self.force_interactive_until = None;
            if let Some(perf) = self.client.daemon_frame_perf {
                if perf.raymarch_ms > RAYMARCH_MS_SETTLE_THRESHOLD {
                    return;
                }
            }
            if can_settle_interactive_tier(now, self.last_3d_input_at, self.interactive_since) {
                self.frame_quality_tier = FrameQualityTier::Settled;
                self.needs_frame = true;
                self.needs_redraw = true;
            }
        }

        fn maybe_adapt_interactive_quality(&mut self) {
            if !self.client.is_3d_mode() {
                self.interactive_long_side_cap = INTERACTIVE_LONG_SIDE_CAP_MAX;
                self.last_adapted_perf_version = self.client.daemon_frame_perf_version;
                self.force_interactive_until = None;
                return;
            }
            if self.last_adapted_perf_version == self.client.daemon_frame_perf_version {
                return;
            }
            self.last_adapted_perf_version = self.client.daemon_frame_perf_version;
            let Some(perf) = self.client.daemon_frame_perf else {
                return;
            };
            let now = Instant::now();
            if perf.raymarch_ms >= RAYMARCH_MS_HARD_SPIKE_THRESHOLD {
                self.interactive_long_side_cap = INTERACTIVE_LONG_SIDE_CAP_MIN;
                self.force_interactive_until = Some(now + INTERACTIVE_SPIKE_HOLD);
                if self.frame_quality_tier != FrameQualityTier::Interactive {
                    self.frame_quality_tier = FrameQualityTier::Interactive;
                    self.interactive_since = Some(now);
                }
                self.needs_frame = true;
                self.needs_redraw = true;
                return;
            }
            let next_cap =
                next_interactive_long_side_cap(self.interactive_long_side_cap, perf.raymarch_ms);
            if next_cap == self.interactive_long_side_cap {
                return;
            }
            self.interactive_long_side_cap = next_cap;
            if self.frame_quality_tier == FrameQualityTier::Interactive {
                self.needs_frame = true;
                self.needs_redraw = true;
            }
        }

        fn frame_request_size(&self, full_width: u32, full_height: u32) -> (u32, u32) {
            if self.client.is_3d_mode() && self.frame_quality_tier == FrameQualityTier::Interactive
            {
                interactive_3d_viewport(full_width, full_height, self.interactive_long_side_cap)
            } else {
                (full_width.max(1), full_height.max(1))
            }
        }

        fn track_layer_changes(&mut self) {
            let current_layer = Some(self.client.active_image_layer_id.clone());
            if self.tracked_image_layer_id != current_layer {
                self.tracked_image_layer_id = current_layer;
                self.pending_auto_fit = true;
            }
        }

        fn track_render_mode_changes(&mut self) {
            let current_mode = self.client.render_mode.clone();
            if self.tracked_render_mode == current_mode {
                return;
            }
            let entering_3d = self.tracked_render_mode != "3d" && current_mode == "3d";
            self.tracked_render_mode = current_mode;
            if entering_3d {
                self.pending_3d_bootstrap = true;
                self.frame_quality_tier = FrameQualityTier::Settled;
                self.interactive_long_side_cap = INTERACTIVE_LONG_SIDE_CAP_MAX;
                self.force_interactive_until = None;
                self.interactive_since = None;
                self.last_3d_input_at = None;
                self.needs_frame = true;
                self.needs_redraw = true;
            } else if self.tracked_render_mode != "3d" {
                self.pending_3d_bootstrap = false;
                self.frame_quality_tier = FrameQualityTier::Settled;
                self.interactive_long_side_cap = INTERACTIVE_LONG_SIDE_CAP_MAX;
                self.force_interactive_until = None;
                self.interactive_since = None;
                self.last_3d_input_at = None;
            }
        }

        fn maybe_bootstrap_3d_entry(&mut self, frame_payload: &[u8]) -> Result<()> {
            if !self.pending_3d_bootstrap || !self.client.is_3d_mode() {
                return Ok(());
            }
            if self.client.should_skip_3d_entry_bootstrap() {
                self.pending_3d_bootstrap = false;
                return Ok(());
            }
            let contrast_limits = if payload_has_nonzero_u16(frame_payload) {
                robust_percentile_limits_u16(frame_payload, 0.01, 0.99)
                    .unwrap_or(DEFAULT_CONTRAST_LIMITS)
            } else {
                DEFAULT_CONTRAST_LIMITS
            };
            let update = self
                .client
                .set_contrast_limits(contrast_limits[0], contrast_limits[1])?;
            self.apply_render_update(update);
            self.pending_3d_bootstrap = false;
            Ok(())
        }

        fn maybe_apply_auto_fit(
            &mut self,
            viewport_width: u32,
            viewport_height: u32,
            image_width: u32,
            image_height: u32,
        ) -> Result<()> {
            if !self.pending_auto_fit {
                return Ok(());
            }
            if !self.client.can_pan_with_mouse() {
                return Ok(());
            }
            if image_width == 0 || image_height == 0 {
                return Ok(());
            }

            self.client.pan_center = [0.0, 0.0];
            self.client.zoom =
                auto_fit_zoom(viewport_width, viewport_height, image_width, image_height);
            self.client.commit_panzoom_pose()?;
            self.pending_auto_fit = false;
            Ok(())
        }

        fn debug_overlay_lines(&self) -> Vec<String> {
            let daemon_perf = self.client.daemon_frame_perf.unwrap_or_default();
            let mode = match self.client.render_mode.as_str() {
                "2d" => "2D",
                "2d_stub" => "2S",
                "3d" => "3D",
                "graph_stub" => "GR",
                _ => "??",
            };
            let sampling = if matches!(self.client.sampling_mode, SamplingMode::Linear) {
                "L"
            } else {
                "N"
            };
            let quality_label = if self.client.is_3d_mode() {
                self.frame_quality_tier.label()
            } else {
                "-"
            };
            vec![
                format!(
                    "M:{} Q:{}({}) A:{}/{}/{} ZM:{:.2}",
                    mode,
                    quality_label,
                    self.interactive_long_side_cap,
                    self.client.axis_indices.t,
                    self.client.axis_indices.c,
                    self.client.axis_indices.z,
                    self.client.zoom
                ),
                format!(
                    "FPS:{:.1} SPD:{:.2} SMP:{}",
                    self.fps_ema.max(0.0),
                    self.client.freefly_pose.speed,
                    sampling
                ),
                format!(
                    "NET:{:.1} UP:{:.1} PR:{:.1}",
                    self.frame_rtt_ms_ema.max(0.0),
                    self.upload_ms_ema.max(0.0),
                    self.present_ms_ema.max(0.0),
                ),
                format!(
                    "D:{:.1} R:{:.1} C:{:.1} E:{:.1}",
                    daemon_perf.total_ms.max(0.0),
                    daemon_perf.raymarch_ms.max(0.0),
                    daemon_perf.cache_ms.max(0.0),
                    daemon_perf.encode_write_ms.max(0.0),
                ),
                format!(
                    "SK:{:.2} BT:{} BS:{} SM:{}",
                    daemon_perf.skip_ratio.clamp(0.0, 1.0),
                    daemon_perf.bricks_traversed,
                    daemon_perf.bricks_sampled,
                    daemon_perf.samples_taken
                ),
                format!(
                    "PAR:{} W:{} RW:{}",
                    if daemon_perf.raymarch_parallel { 1 } else { 0 },
                    daemon_perf.raymarch_workers,
                    daemon_perf.rows_parallelized
                ),
                format!(
                    "WK:IF{} P{} DS{}",
                    if self.frame_scheduler.is_in_flight() {
                        1
                    } else {
                        0
                    },
                    if self.frame_scheduler.has_pending_latest() {
                        1
                    } else {
                        0
                    },
                    self.frame_scheduler.dropped_stale()
                ),
                format!(
                    "CT:{}-{} SID:{}",
                    self.client.contrast_limits[0],
                    self.client.contrast_limits[1],
                    self.client.session_id.chars().last().unwrap_or('?')
                ),
                format!(
                    "ERR:{}",
                    self.last_worker_error
                        .as_deref()
                        .map(compact_error_for_hud)
                        .unwrap_or_else(|| "none".to_string())
                ),
            ]
        }

        fn can_dispatch_settled_request(&self) -> bool {
            should_dispatch_settled_frame(
                self.client.is_3d_mode(),
                self.frame_quality_tier,
                self.client.daemon_frame_perf,
            )
        }

        fn build_desired_frame_request(&self) -> Option<FrameRequestSpec> {
            if !self.needs_frame {
                return None;
            }
            let size = self.window.as_ref().map(|window| window.inner_size())?;
            let (request_width, request_height) =
                self.frame_request_size(size.width.max(1), size.height.max(1));
            Some(FrameRequestSpec {
                render_mode: self.client.render_mode.clone(),
                axis_indices: self.client.axis_indices.clone(),
                viewport: FrameViewport {
                    width: request_width.max(1),
                    height: request_height.max(1),
                },
                camera_generation: self.camera_generation,
            })
        }

        fn dispatch_frame_request_if_needed(&mut self) -> Result<()> {
            if !self.needs_frame {
                return Ok(());
            }
            if self.pending_3d_bootstrap && self.client.is_3d_mode() {
                if self.client.should_skip_3d_entry_bootstrap() {
                    self.pending_3d_bootstrap = false;
                } else {
                    self.client.set_canonical_3d_pose()?;
                    self.note_3d_camera_input();
                }
            }
            if !self.can_dispatch_settled_request() {
                return Ok(());
            }
            let Some(spec) = self.build_desired_frame_request() else {
                return Ok(());
            };
            if let Some(request) = self.frame_scheduler.request(spec, "update") {
                self.client.enqueue_frame_request(request)?;
            }
            self.needs_frame = false;
            Ok(())
        }

        fn apply_frame_to_renderer(&mut self, frame: &FrameImage, frame_rtt_ms: f64) -> Result<()> {
            self.frame_rtt_ms_ema = Self::smooth_ema(self.frame_rtt_ms_ema, frame_rtt_ms);
            let size = self
                .window
                .as_ref()
                .map(|window| window.inner_size())
                .ok_or_else(|| anyhow!("window is not initialized"))?;
            let (image_width, image_height) = {
                let renderer = self
                    .renderer
                    .as_mut()
                    .ok_or_else(|| anyhow!("renderer is not initialized"))?;
                let upload_started = Instant::now();
                renderer.update_frame(frame)?;
                let upload_ms = upload_started.elapsed().as_secs_f64() * 1_000.0;
                self.upload_ms_ema = Self::smooth_ema(self.upload_ms_ema, upload_ms);
                renderer.image_dimensions()
            };
            self.client.record_frame_state(frame);
            self.maybe_bootstrap_3d_entry(&frame.payload)?;
            self.maybe_apply_auto_fit(
                size.width.max(1),
                size.height.max(1),
                image_width,
                image_height,
            )?;
            self.needs_redraw = true;
            Ok(())
        }

        fn drain_frame_worker(&mut self) -> Result<()> {
            loop {
                let Some(result) = self.client.poll_frame_result()? else {
                    break;
                };
                let completion = self.frame_scheduler.complete(result.seq);
                if let Some(next) = completion.dispatch_next {
                    self.client.enqueue_frame_request(next)?;
                }
                if !completion.apply_result {
                    continue;
                }
                match result.frame {
                    Ok(frame) => {
                        self.last_worker_error = None;
                        self.apply_frame_to_renderer(&frame, result.roundtrip_ms)?;
                    }
                    Err(message) => {
                        if message.contains("axis index out of bounds")
                            && self.client.recover_axis_bounds()?
                        {
                            self.needs_frame = true;
                            self.needs_redraw = true;
                            continue;
                        }
                        self.last_worker_error = Some(format!(
                            "{} [{}]",
                            compact_error_for_hud(&message),
                            compact_error_for_hud(&result.reason)
                        ));
                        self.needs_redraw = true;
                    }
                }
            }
            Ok(())
        }

        fn on_render_presented(&mut self) {
            let now = Instant::now();
            if let Some(last) = self.last_render_at {
                let dt = (now - last).as_secs_f64();
                if dt > 0.0 {
                    let fps = 1.0 / dt;
                    self.fps_ema = Self::smooth_ema(self.fps_ema, fps);
                    self.present_ms_ema = Self::smooth_ema(self.present_ms_ema, dt * 1_000.0);
                }
            }
            self.last_render_at = Some(now);
        }
    }

    impl ApplicationHandler for LucidaApp {
        fn resumed(&mut self, event_loop: &ActiveEventLoop) {
            if self.window.is_none() {
                let window = match event_loop
                    .create_window(WindowAttributes::default().with_title("Lucida Viewer"))
                {
                    Ok(window) => Arc::new(window),
                    Err(err) => {
                        eprintln!("unable to create window: {err}");
                        event_loop.exit();
                        return;
                    }
                };
                let renderer = match GpuRenderer::new(window.clone()) {
                    Ok(renderer) => renderer,
                    Err(err) => {
                        eprintln!("unable to initialize renderer: {err}");
                        event_loop.exit();
                        return;
                    }
                };

                self.window_id = Some(window.id());
                update_window_title(&window, self);
                self.renderer = Some(renderer);
                self.window = Some(window.clone());
                self.needs_frame = true;
                self.needs_redraw = true;
                window.request_redraw();
            }
        }

        fn window_event(
            &mut self,
            event_loop: &ActiveEventLoop,
            window_id: WindowId,
            event: WindowEvent,
        ) {
            if Some(window_id) != self.window_id {
                return;
            }

            match event {
                WindowEvent::CloseRequested => event_loop.exit(),
                WindowEvent::Resized(size) => {
                    if let Some(renderer) = self.renderer.as_mut() {
                        renderer.resize(size.width, size.height);
                    }
                    if matches!(self.client.render_mode.as_str(), "2d" | "2d_stub") {
                        self.needs_redraw = true;
                    } else {
                        self.needs_frame = true;
                    }
                    self.needs_redraw = true;
                    if let Some(window) = &self.window {
                        window.request_redraw();
                    }
                }
                WindowEvent::MouseWheel { delta, .. } => {
                    let raw_steps = match delta {
                        MouseScrollDelta::LineDelta(_, y) => y as f64,
                        MouseScrollDelta::PixelDelta(position) => position.y as f64 / 60.0,
                    };
                    if self.client.is_3d_mode() {
                        match self.client.adjust_3d_speed_from_scroll(raw_steps) {
                            Ok(update) => {
                                self.apply_render_update(update);
                                if !matches!(update, RenderUpdate::None) {
                                    self.note_3d_camera_input();
                                }
                                if self.needs_redraw {
                                    if let Some(window) = &self.window {
                                        window.request_redraw();
                                    }
                                }
                            }
                            Err(err) => {
                                eprintln!("3d speed scroll failed: {err}");
                                event_loop.exit();
                            }
                        }
                    } else {
                        let zoom_steps = normalized_scroll_steps(raw_steps);
                        let (cursor_x, cursor_y) = self.last_cursor_pos.unwrap_or_else(|| {
                            let size = self
                                .window
                                .as_ref()
                                .map(|w| w.inner_size())
                                .unwrap_or_default();
                            (size.width as f64 * 0.5, size.height as f64 * 0.5)
                        });
                        let viewport = self
                            .window
                            .as_ref()
                            .map(|window| window.inner_size())
                            .unwrap_or_default();
                        let image_dims = self
                            .renderer
                            .as_ref()
                            .map(|renderer| renderer.image_dimensions())
                            .unwrap_or((1, 1));
                        match self.client.apply_scroll_zoom(
                            zoom_steps,
                            cursor_x,
                            cursor_y,
                            viewport.width.max(1) as f64,
                            viewport.height.max(1) as f64,
                            image_dims.0.max(1),
                            image_dims.1.max(1),
                        ) {
                            Ok(update) => {
                                self.apply_render_update(update);
                                if self.needs_redraw {
                                    if let Some(window) = &self.window {
                                        window.request_redraw();
                                    }
                                }
                            }
                            Err(err) => {
                                eprintln!("scroll zoom failed: {err}");
                                event_loop.exit();
                            }
                        }
                    }
                }
                WindowEvent::MouseInput {
                    state,
                    button: MouseButton::Left,
                    ..
                } => match state {
                    ElementState::Pressed => {
                        self.mouse_pan_active = self.client.can_pan_with_mouse();
                        self.mouse_look_active = self.client.can_mouse_look_3d();
                        self.last_cursor_pos = None;
                    }
                    ElementState::Released => {
                        self.mouse_pan_active = false;
                        self.mouse_look_active = false;
                        self.last_cursor_pos = None;
                    }
                },
                WindowEvent::CursorMoved { position, .. } => {
                    let current = (position.x, position.y);
                    if self.mouse_pan_active {
                        if let Some((last_x, last_y)) = self.last_cursor_pos {
                            let delta_x = current.0 - last_x;
                            let delta_y = current.1 - last_y;
                            if let Some(size) =
                                self.window.as_ref().map(|window| window.inner_size())
                            {
                                let image_dims = self
                                    .renderer
                                    .as_ref()
                                    .map(|renderer| renderer.image_dimensions())
                                    .unwrap_or((1, 1));
                                match self.client.pan_by_pixels(
                                    delta_x,
                                    delta_y,
                                    size.width.max(1) as f64,
                                    size.height.max(1) as f64,
                                    image_dims.0.max(1),
                                    image_dims.1.max(1),
                                ) {
                                    Ok(update) => {
                                        self.apply_render_update(update);
                                        if self.needs_redraw {
                                            if let Some(window) = &self.window {
                                                window.request_redraw();
                                            }
                                        }
                                    }
                                    Err(err) => {
                                        eprintln!("drag pan failed: {err}");
                                        event_loop.exit();
                                        return;
                                    }
                                }
                            }
                        }
                    } else if self.mouse_look_active {
                        if let Some((last_x, last_y)) = self.last_cursor_pos {
                            let delta_x = current.0 - last_x;
                            let delta_y = current.1 - last_y;
                            match self.client.apply_mouse_look(delta_x, delta_y) {
                                Ok(update) => {
                                    self.apply_render_update(update);
                                    if !matches!(update, RenderUpdate::None) {
                                        self.note_3d_camera_input();
                                    }
                                    if self.needs_redraw {
                                        if let Some(window) = &self.window {
                                            window.request_redraw();
                                        }
                                    }
                                }
                                Err(err) => {
                                    eprintln!("mouse look failed: {err}");
                                    event_loop.exit();
                                    return;
                                }
                            }
                        }
                    }
                    self.last_cursor_pos = Some(current);
                }
                WindowEvent::KeyboardInput { event, .. } => {
                    if let PhysicalKey::Code(code) = event.physical_key {
                        match event.state {
                            ElementState::Pressed => {
                                if code == KeyCode::KeyH && !event.repeat {
                                    self.show_debug_hud = !self.show_debug_hud;
                                    self.needs_redraw = true;
                                    if let Some(window) = &self.window {
                                        window.request_redraw();
                                    }
                                } else if is_continuous_3d_key(code) {
                                    self.held_keys.insert(code);
                                } else {
                                    match self.client.apply_key(code) {
                                        Ok(update) => {
                                            self.apply_render_update(update);
                                            if code == KeyCode::Digit2 {
                                                self.pending_3d_bootstrap = true;
                                            }
                                            if self.client.is_3d_mode()
                                                && matches!(
                                                    code,
                                                    KeyCode::Digit2
                                                        | KeyCode::Equal
                                                        | KeyCode::Minus
                                                        | KeyCode::KeyR
                                                )
                                                && !matches!(update, RenderUpdate::None)
                                            {
                                                self.note_3d_camera_input();
                                            }
                                            if self.needs_redraw {
                                                if let Some(window) = &self.window {
                                                    window.request_redraw();
                                                }
                                            }
                                        }
                                        Err(err) => {
                                            eprintln!("keyboard command failed: {err}");
                                            event_loop.exit();
                                        }
                                    }
                                }
                            }
                            ElementState::Released => {
                                self.held_keys.remove(&code);
                            }
                        }
                    }
                }
                WindowEvent::RedrawRequested => {
                    if let Some(window) = self.window.as_ref() {
                        let size = window.inner_size();
                        let debug_lines = self.debug_overlay_lines();
                        if let Some(renderer) = self.renderer.as_mut() {
                            renderer.update_view_params(
                                size.width.max(1),
                                size.height.max(1),
                                &self.client.render_mode,
                                self.client.pan_center,
                                self.client.zoom,
                                self.client.sampling_mode,
                                self.client.contrast_limits,
                            );
                            renderer.update_debug_overlay(&debug_lines, self.show_debug_hud);
                        }
                    }
                    let render_result = if let Some(renderer) = self.renderer.as_mut() {
                        renderer.render()
                    } else {
                        Ok(())
                    };
                    if let Err(err) = render_result {
                        eprintln!("render failed: {err}");
                        event_loop.exit();
                        return;
                    }
                    self.on_render_presented();
                    if let Some(window) = &self.window {
                        update_window_title(window, self);
                    }
                    self.needs_redraw = false;
                }
                _ => {}
            }
        }

        fn about_to_wait(&mut self, event_loop: &ActiveEventLoop) {
            let now = Instant::now();
            let dt_s = (now - self.last_input_tick).as_secs_f64().clamp(0.0, 0.05);
            self.last_input_tick = now;

            match self.client.apply_held_freefly(&self.held_keys, dt_s) {
                Ok(changed) => {
                    if changed {
                        self.note_3d_camera_input();
                        self.needs_frame = true;
                        self.needs_redraw = true;
                    }
                }
                Err(err) => {
                    eprintln!("continuous input failed: {err}");
                    event_loop.exit();
                    return;
                }
            }

            match self.client.poll_control_events() {
                Ok(update) => {
                    if self.client.is_3d_mode() && update.needs_frame() {
                        self.camera_generation = self.camera_generation.saturating_add(1);
                    }
                    self.apply_render_update(update);
                    self.track_layer_changes();
                    self.track_render_mode_changes();
                }
                Err(err) => {
                    eprintln!("event stream failed: {err}");
                    event_loop.exit();
                    return;
                }
            }

            self.maybe_adapt_interactive_quality();
            self.maybe_settle_3d_quality();
            if let Err(err) = self.dispatch_frame_request_if_needed() {
                let message = compact_error_for_hud(&err.to_string());
                match self.client.reconnect_frame_worker() {
                    Ok(()) => {
                        self.last_worker_error = Some(format!("{} [reconnected]", message));
                        self.frame_scheduler = FrameRequestScheduler::default();
                        self.needs_frame = true;
                    }
                    Err(reconnect_err) => {
                        self.last_worker_error = Some(format!(
                            "{} [reconnect:{}]",
                            message,
                            compact_error_for_hud(&reconnect_err.to_string())
                        ));
                    }
                }
                self.needs_redraw = true;
            }
            if let Err(err) = self.drain_frame_worker() {
                let message = compact_error_for_hud(&err.to_string());
                match self.client.reconnect_frame_worker() {
                    Ok(()) => {
                        self.last_worker_error = Some(format!("{} [reconnected]", message));
                        self.frame_scheduler = FrameRequestScheduler::default();
                        self.needs_frame = true;
                    }
                    Err(reconnect_err) => {
                        self.last_worker_error = Some(format!(
                            "{} [reconnect:{}]",
                            message,
                            compact_error_for_hud(&reconnect_err.to_string())
                        ));
                    }
                }
                self.needs_redraw = true;
            }
            if self.frame_scheduler.is_in_flight() {
                self.needs_redraw = true;
            }

            if self.needs_redraw || self.needs_frame {
                if let Some(window) = &self.window {
                    window.request_redraw();
                }
            }
        }
    }

    fn update_window_title(window: &Window, app: &LucidaApp) {
        let client = &app.client;
        let hotkeys = mode_hotkeys_hint(&client.render_mode);
        let title = format!(
            "Lucida Viewer | session={} | mode={} | hud={} | fps={:.1} | hotkeys: {}",
            client.session_id,
            client.mode_label,
            if app.show_debug_hud { "ON" } else { "OFF" },
            app.fps_ema.max(0.0),
            hotkeys,
        );
        window.set_title(&title);
    }

    fn mode_hotkeys_hint(mode: &str) -> &'static str {
        if mode == "3d" {
            "1/2/3/4 mode, [/]/PgUp/PgDn or up/down z, left/right c, ,/. t, left-drag look, wheel speed, R reset pose, WASD move, E/Q up/down, IJKL pitch/yaw, U/O roll, +/- speed, M sampling, C auto-contrast, V reset contrast, Z/X contrast width, H HUD"
        } else {
            "1/2/3/4 mode, [/]/PgUp/PgDn or up/down z, left/right c, ,/. t, wheel up=in/down=out, left-drag pan (2D), +/- zoom, M sampling, C auto-contrast, V reset contrast, Z/X contrast width, H HUD, WASD/EQ/IJKL/UO only in 3D"
        }
    }

    #[cfg(test)]
    mod tests {
        use super::{
            apply_local_look_deltas, axis_bounds_from_dataset, basis_to_yaw_pitch_roll,
            can_settle_interactive_tier, clamp_axis_indices, freefly_pose_to_basis,
            interactive_3d_viewport, next_axis_index, next_interactive_long_side_cap,
            normalized_scroll_steps, pan_center_for_cursor_anchor, payload_has_nonzero_u16,
            robust_percentile_limits_u16, rotate_vec_around_axis, should_dispatch_settled_frame,
            should_hold_interactive, texel_coords_from_uv_for_mode, world_point_from_cursor,
            zoom_scale_factor, AxisBounds, DaemonFramePerf, FrameQualityTier,
            FrameRequestScheduler, FrameRequestSpec,
        };
        use lucida_protocol::{FrameAxisIndices, FrameViewport};
        use serde_json::json;
        use std::{
            f64::consts::{FRAC_PI_2, PI},
            time::{Duration, Instant},
        };

        fn approx_eq(left: f64, right: f64, eps: f64) {
            assert!(
                (left - right).abs() <= eps,
                "left={left}, right={right}, eps={eps}"
            );
        }

        fn approx_vec3(left: [f64; 3], right: [f64; 3], eps: f64) {
            approx_eq(left[0], right[0], eps);
            approx_eq(left[1], right[1], eps);
            approx_eq(left[2], right[2], eps);
        }

        #[test]
        fn scroll_steps_are_inverted_and_positive_zoom_steps_zoom_in() {
            assert_eq!(normalized_scroll_steps(1.5), -1.5);
            assert_eq!(normalized_scroll_steps(-0.75), 0.75);
            assert!(zoom_scale_factor(1.0) > 1.0);
        }

        #[test]
        fn next_axis_index_is_saturating_for_both_directions() {
            assert_eq!(next_axis_index(0, -1), 0);
            assert_eq!(next_axis_index(2, -1), 1);
            assert_eq!(next_axis_index(3, 2), 5);
        }

        #[test]
        fn axis_bounds_parse_from_canonical_layout_metadata() {
            let dataset = json!({
                "multiscale_metadata": {
                    "canonical_axes": [
                        {"label": "t", "size": 3},
                        {"label": "c", "size": 2},
                        {"label": "z", "size": 24},
                        {"label": "y", "size": 128},
                        {"label": "x", "size": 128}
                    ]
                }
            });
            let bounds = axis_bounds_from_dataset(Some(&dataset));
            assert_eq!(bounds.t_max, Some(2));
            assert_eq!(bounds.c_max, Some(1));
            assert_eq!(bounds.z_max, Some(23));
        }

        #[test]
        fn clamp_axis_indices_honors_configured_bounds() {
            let bounded = clamp_axis_indices(
                FrameAxisIndices { t: 5, c: 9, z: 30 },
                AxisBounds {
                    t_max: Some(2),
                    c_max: Some(1),
                    z_max: Some(23),
                },
            );
            assert_eq!(bounded.t, 2);
            assert_eq!(bounded.c, 1);
            assert_eq!(bounded.z, 23);
        }

        #[test]
        fn pixel_density_is_invariant_across_viewport_resize_for_fixed_zoom() {
            let image_width = 512u32;
            let image_height = 256u32;
            let zoom = 2.0f64;
            let center = [0.0f64, 0.0f64];

            let world_a0 = world_point_from_cursor(
                399.0,
                299.0,
                800.0,
                600.0,
                image_width,
                image_height,
                center,
                zoom,
            );
            let world_a1 = world_point_from_cursor(
                400.0,
                299.0,
                800.0,
                600.0,
                image_width,
                image_height,
                center,
                zoom,
            );
            let dtexel_a = (world_a1[0] - world_a0[0]) * (image_width as f64) * 0.5;

            let world_b0 = world_point_from_cursor(
                799.0,
                599.0,
                1600.0,
                1200.0,
                image_width,
                image_height,
                center,
                zoom,
            );
            let world_b1 = world_point_from_cursor(
                800.0,
                599.0,
                1600.0,
                1200.0,
                image_width,
                image_height,
                center,
                zoom,
            );
            let dtexel_b = (world_b1[0] - world_b0[0]) * (image_width as f64) * 0.5;

            approx_eq(dtexel_a, dtexel_b, 1e-9);
            approx_eq(dtexel_a, 1.0 / zoom, 1e-9);
        }

        #[test]
        fn cursor_anchor_keeps_world_point_fixed_across_zoom_change() {
            let cursor_x = 321.0;
            let cursor_y = 187.0;
            let viewport_width = 1280.0;
            let viewport_height = 720.0;
            let image_width = 640u32;
            let image_height = 320u32;
            let initial_center = [0.17, -0.11];
            let initial_zoom = 1.4;

            let world_before = world_point_from_cursor(
                cursor_x,
                cursor_y,
                viewport_width,
                viewport_height,
                image_width,
                image_height,
                initial_center,
                initial_zoom,
            );

            let zoom_after = initial_zoom * zoom_scale_factor(1.25);
            let center_after = pan_center_for_cursor_anchor(
                world_before,
                cursor_x,
                cursor_y,
                viewport_width,
                viewport_height,
                image_width,
                image_height,
                zoom_after,
            );
            let world_after = world_point_from_cursor(
                cursor_x,
                cursor_y,
                viewport_width,
                viewport_height,
                image_width,
                image_height,
                center_after,
                zoom_after,
            );

            approx_eq(world_before[0], world_after[0], 1e-9);
            approx_eq(world_before[1], world_after[1], 1e-9);
        }

        #[test]
        fn three_d_mode_uses_identity_texture_mapping_regardless_of_2d_pan_zoom() {
            let uv = [0.37, 0.62];
            let texel_a = texel_coords_from_uv_for_mode(
                uv,
                1280.0,
                720.0,
                320.0,
                240.0,
                [0.0, 0.0],
                1.0,
                "3d",
            );
            let texel_b = texel_coords_from_uv_for_mode(
                uv,
                1280.0,
                720.0,
                320.0,
                240.0,
                [9.5, -7.0],
                53.0,
                "3d",
            );
            approx_eq(texel_a[0], texel_b[0], 1e-9);
            approx_eq(texel_a[1], texel_b[1], 1e-9);
        }

        #[test]
        fn robust_percentile_limits_are_monotonic_and_non_degenerate() {
            let mut payload = Vec::new();
            for value in [0u16, 5, 20, 80, 500, 2000, 10000, 40000, 65535] {
                for _ in 0..8 {
                    payload.extend_from_slice(&value.to_le_bytes());
                }
            }
            let limits = robust_percentile_limits_u16(&payload, 0.01, 0.99)
                .expect("percentile limits should exist");
            assert!(limits[0] < limits[1]);
            assert!(limits[1] <= u16::MAX);
            assert!(payload_has_nonzero_u16(&payload));
            assert!(!payload_has_nonzero_u16(&vec![0u8; 64]));
        }

        #[test]
        fn interactive_viewport_respects_quality_caps() {
            let (w, h) = interactive_3d_viewport(1920, 1080, 640);
            assert_eq!(w, 640);
            assert_eq!(h, 360);
        }

        #[test]
        fn interactive_viewport_does_not_exceed_native_dimensions() {
            let (w, h) = interactive_3d_viewport(320, 200, 640);
            assert_eq!(w, 320);
            assert_eq!(h, 200);
        }

        #[test]
        fn interactive_cap_adapts_up_and_down_with_raymarch_time() {
            let down = next_interactive_long_side_cap(640, 30.0);
            assert!(down < 640);
            assert!(down >= 360);

            let up = next_interactive_long_side_cap(360, 8.0);
            assert!(up > 360);
            assert!(up <= 640);

            let stable = next_interactive_long_side_cap(500, 18.0);
            assert_eq!(stable, 500);
        }

        #[test]
        fn settle_transition_requires_idle_and_hysteresis() {
            let start = Instant::now();
            let entered = Some(start);
            let short_idle = Some(start + Duration::from_millis(80));
            let enough_idle = Some(start + Duration::from_millis(5));
            let early_now = start + Duration::from_millis(100);
            let settled_now = start + Duration::from_millis(180);
            assert!(!can_settle_interactive_tier(early_now, short_idle, entered));
            assert!(can_settle_interactive_tier(
                settled_now,
                enough_idle,
                entered
            ));
        }

        #[test]
        fn interactive_hold_window_blocks_settle_until_expired() {
            let start = Instant::now();
            assert!(should_hold_interactive(
                start + Duration::from_millis(100),
                Some(start + Duration::from_millis(200))
            ));
            assert!(!should_hold_interactive(
                start + Duration::from_millis(220),
                Some(start + Duration::from_millis(200))
            ));
            assert!(!should_hold_interactive(start, None));
        }

        #[test]
        fn local_yaw_is_camera_aligned_after_ninety_degree_roll() {
            let pose = [0.0, 0.0, FRAC_PI_2];
            let before = freefly_pose_to_basis(pose);
            let yaw_delta = 0.3;
            let after_pose = apply_local_look_deltas(pose, yaw_delta, 0.0, 0.0);
            let after = freefly_pose_to_basis(after_pose);
            let expected_forward = rotate_vec_around_axis(before.forward, before.up, yaw_delta);
            approx_vec3(after.forward, expected_forward, 1e-6);
        }

        #[test]
        fn local_pitch_is_camera_aligned_after_arbitrary_roll_and_yaw() {
            let pose = [0.7, 0.2, 1.1];
            let before = freefly_pose_to_basis(pose);
            let pitch_delta = -0.25;
            let after_pose = apply_local_look_deltas(pose, 0.0, pitch_delta, 0.0);
            let after = freefly_pose_to_basis(after_pose);
            let expected_forward =
                rotate_vec_around_axis(before.forward, before.right, pitch_delta);
            approx_vec3(after.forward, expected_forward, 1e-6);
        }

        #[test]
        fn pose_basis_roundtrip_is_orientation_stable() {
            let pose = [0.9, -0.3, PI * 0.42];
            let basis_a = freefly_pose_to_basis(pose);
            let pose_b = basis_to_yaw_pitch_roll(basis_a);
            let basis_b = freefly_pose_to_basis(pose_b);
            approx_vec3(basis_a.forward, basis_b.forward, 1e-6);
            approx_vec3(basis_a.right, basis_b.right, 1e-6);
            approx_vec3(basis_a.up, basis_b.up, 1e-6);
        }

        #[test]
        fn mouse_and_keyboard_look_match_for_equal_local_deltas() {
            let pose = [0.3, -0.1, 0.8];
            let yaw_delta = 0.14;
            let pitch_delta = -0.09;

            let keyboard_pose = apply_local_look_deltas(pose, yaw_delta, pitch_delta, 0.0);

            let mouse_sensitivity = 0.004;
            let dx = yaw_delta / mouse_sensitivity;
            let dy = -pitch_delta / mouse_sensitivity;
            let mouse_pose =
                apply_local_look_deltas(pose, dx * mouse_sensitivity, -dy * mouse_sensitivity, 0.0);

            let keyboard_basis = freefly_pose_to_basis(keyboard_pose);
            let mouse_basis = freefly_pose_to_basis(mouse_pose);
            approx_vec3(keyboard_basis.forward, mouse_basis.forward, 1e-8);
            approx_vec3(keyboard_basis.right, mouse_basis.right, 1e-8);
            approx_vec3(keyboard_basis.up, mouse_basis.up, 1e-8);
        }

        fn make_spec(z: usize, width: u32, height: u32) -> FrameRequestSpec {
            FrameRequestSpec {
                render_mode: "3d".to_string(),
                axis_indices: FrameAxisIndices { t: 0, c: 0, z },
                viewport: FrameViewport { width, height },
                camera_generation: z as u64,
            }
        }

        #[test]
        fn frame_scheduler_latest_wins_and_coalesces_duplicates() {
            let mut scheduler = FrameRequestScheduler::default();
            let first = scheduler
                .request(make_spec(0, 640, 360), "camera")
                .expect("first request should dispatch");
            assert_eq!(first.seq, 1);
            assert!(scheduler.is_in_flight());

            assert!(scheduler
                .request(make_spec(1, 640, 360), "camera")
                .is_none());
            assert!(scheduler.has_pending_latest());
            assert!(scheduler
                .request(make_spec(1, 640, 360), "camera")
                .is_none());

            let completion = scheduler.complete(1);
            assert!(completion.apply_result);
            let next = completion
                .dispatch_next
                .expect("latest pending request should dispatch");
            assert_eq!(next.seq, 2);
            assert!(next.spec.same_as(&make_spec(1, 640, 360)));
        }

        #[test]
        fn frame_scheduler_replacing_pending_latest_increments_drop_counter() {
            let mut scheduler = FrameRequestScheduler::default();
            let first = scheduler
                .request(make_spec(0, 640, 360), "camera")
                .expect("first request should dispatch");
            assert_eq!(first.seq, 1);
            assert!(scheduler
                .request(make_spec(1, 640, 360), "camera")
                .is_none());
            assert!(scheduler
                .request(make_spec(2, 640, 360), "camera")
                .is_none());
            assert_eq!(scheduler.dropped_stale(), 1);
        }

        #[test]
        fn frame_scheduler_discards_stale_result_seq() {
            let mut scheduler = FrameRequestScheduler::default();
            let first = scheduler
                .request(make_spec(0, 640, 360), "camera")
                .expect("first request should dispatch");
            assert_eq!(first.seq, 1);

            let stale = scheduler.complete(999);
            assert!(!stale.apply_result);
            assert_eq!(scheduler.dropped_stale(), 1);
            assert!(scheduler.is_in_flight(), "in-flight request should remain");

            let valid = scheduler.complete(first.seq);
            assert!(valid.apply_result);
            assert!(valid.dispatch_next.is_none());
            assert!(!scheduler.is_in_flight());
        }

        #[test]
        fn settled_dispatch_is_blocked_when_raymarch_cost_is_too_high() {
            let high_cost = DaemonFramePerf {
                raymarch_ms: 40.0,
                ..DaemonFramePerf::default()
            };
            let low_cost = DaemonFramePerf {
                raymarch_ms: 10.0,
                ..DaemonFramePerf::default()
            };
            assert!(!should_dispatch_settled_frame(
                true,
                FrameQualityTier::Settled,
                Some(high_cost),
            ));
            assert!(should_dispatch_settled_frame(
                true,
                FrameQualityTier::Settled,
                Some(low_cost),
            ));
            assert!(should_dispatch_settled_frame(
                true,
                FrameQualityTier::Interactive,
                Some(high_cost),
            ));
            assert!(should_dispatch_settled_frame(
                false,
                FrameQualityTier::Settled,
                Some(high_cost),
            ));
        }
    }

    pub fn run() -> Result<()> {
        let args = AppArgs::parse(&std::env::args().collect::<Vec<String>>())?;
        let client = AppClient::connect(args.socket_path, args.session_id)?;

        let event_loop = EventLoop::new()?;
        let mut app = LucidaApp::new(client);
        event_loop.run_app(&mut app)?;
        Ok(())
    }
}

#[cfg(unix)]
fn main() -> Result<()> {
    unix_app::run()
}

#[cfg(not(unix))]
fn main() -> Result<()> {
    Err(anyhow::anyhow!(
        "lucida-app currently supports Unix platforms only in this slice"
    ))
}
