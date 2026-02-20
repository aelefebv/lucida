use anyhow::Result;

#[cfg(unix)]
mod unix_app {
    use std::borrow::Cow;
    use std::collections::BTreeMap;
    use std::io::{BufRead, BufReader, BufWriter, Read, Write};
    use std::os::unix::net::UnixStream;
    use std::sync::mpsc::{self, Receiver, TryRecvError};
    use std::sync::Arc;

    use anyhow::{anyhow, bail, Context, Result};
    use lucida_protocol::{
        now_utc, EventEnvelope, FrameAxisIndices, FrameRequestHeader, FrameResponseHeader,
        FrameViewport, RpcRequestEnvelope, RpcResponseEnvelope, FRAME_PROTOCOL_VERSION,
        PROTOCOL_VERSION,
    };
    use serde::Deserialize;
    use serde_json::{json, Value};
    use uuid::Uuid;
    use wgpu::SurfaceError;
    use winit::application::ApplicationHandler;
    use winit::event::{ElementState, WindowEvent};
    use winit::event_loop::{ActiveEventLoop, EventLoop};
    use winit::keyboard::{KeyCode, PhysicalKey};
    use winit::window::{Window, WindowAttributes, WindowId};

    const DEFAULT_CONTROL_SOCKET_PATH: &str = "/tmp/lucida.sock";

    const SHADER_SOURCE: &str = r#"
@group(0) @binding(0) var frame_tex: texture_2d<f32>;
@group(0) @binding(1) var frame_sampler: sampler;

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
  let intensity = textureSample(frame_tex, frame_sampler, input.uv).r;
  return vec4<f32>(intensity, intensity, intensity, 1.0);
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

        fn request(&mut self, method: &str, session_id: Option<&str>, params: Value) -> Result<Value> {
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

            let response: RpcResponseEnvelope = serde_json::from_str(&line)
                .with_context(|| format!("parse {method} response"))?;
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

    struct FrameClient {
        stream: UnixStream,
        channel_token: String,
        session_id: String,
    }

    impl FrameClient {
        fn connect(socket_path: &str, channel_token: String, session_id: String) -> Result<Self> {
            let stream =
                UnixStream::connect(socket_path).with_context(|| format!("connect frame socket {socket_path}"))?;
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
            let response_header: FrameResponseHeader = serde_json::from_slice(&response_header_bytes)
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

    #[derive(Debug, Deserialize)]
    struct SessionInspectResponse {
        exists: bool,
        dataset: Option<Value>,
        layers: Vec<LayerSummary>,
        view: Option<ViewSummary>,
    }

    #[derive(Debug, Deserialize)]
    struct LayerSummary {
        visible: bool,
        kind: LayerKindSummary,
    }

    #[derive(Debug, Deserialize)]
    struct LayerKindSummary {
        #[serde(rename = "type")]
        layer_type: String,
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
        frame: FrameClient,
        events_rx: Receiver<EventEnvelope>,
        axis_indices: FrameAxisIndices,
        mode_label: String,
        zoom: f64,
        last_state_hash: String,
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
            let has_visible_image = inspect
                .layers
                .iter()
                .any(|layer| layer.visible && layer.kind.layer_type == "image");
            if !has_visible_image {
                bail!("session {session_id} has no visible image layer");
            }

            let axis_indices = frame_axis_from_view(inspect.view.as_ref());

            let frame_open_value = control.request("frame.channel.open", Some(&session_id), json!({}))?;
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
                frame_channel.channel_token,
                session_id.clone(),
            )?;
            let events_rx = spawn_event_listener(&control_socket_path, &session_id)?;

            Ok(Self {
                session_id,
                control,
                frame,
                events_rx,
                axis_indices,
                mode_label: "2D".to_string(),
                zoom: 1.0,
                last_state_hash: "uninitialized".to_string(),
            })
        }

        fn request_frame(&mut self, viewport_width: u32, viewport_height: u32) -> Result<FrameImage> {
            let frame = self.frame.request_frame(
                Uuid::new_v4().to_string(),
                self.axis_indices.clone(),
                FrameViewport {
                    width: viewport_width.max(1),
                    height: viewport_height.max(1),
                },
            )?;
            self.last_state_hash = frame.state_hash.clone();
            Ok(frame)
        }

        fn apply_key(&mut self, key_code: KeyCode) -> Result<bool> {
            match key_code {
                KeyCode::ArrowUp => {
                    self.axis_indices.z = self.axis_indices.z.saturating_add(1);
                    self.control.request(
                        "view.set_axis",
                        Some(&self.session_id),
                        json!({"axis": "z", "index": self.axis_indices.z}),
                    )?;
                    Ok(true)
                }
                KeyCode::ArrowDown => {
                    self.axis_indices.z = self.axis_indices.z.saturating_sub(1);
                    self.control.request(
                        "view.set_axis",
                        Some(&self.session_id),
                        json!({"axis": "z", "index": self.axis_indices.z}),
                    )?;
                    Ok(true)
                }
                KeyCode::Equal => {
                    self.zoom *= 1.1;
                    self.control.request(
                        "camera.set_mode",
                        Some(&self.session_id),
                        json!({"mode": "panzoom"}),
                    )?;
                    self.control.request(
                        "camera.set_pose",
                        Some(&self.session_id),
                        json!({"pose": {"center": [0.0, 0.0], "zoom": self.zoom}}),
                    )?;
                    self.mode_label = "2D".to_string();
                    Ok(true)
                }
                KeyCode::Minus => {
                    self.zoom *= 0.9;
                    self.control.request(
                        "camera.set_mode",
                        Some(&self.session_id),
                        json!({"mode": "panzoom"}),
                    )?;
                    self.control.request(
                        "camera.set_pose",
                        Some(&self.session_id),
                        json!({"pose": {"center": [0.0, 0.0], "zoom": self.zoom}}),
                    )?;
                    self.mode_label = "2D".to_string();
                    Ok(true)
                }
                KeyCode::Digit1 => {
                    self.control.request(
                        "camera.set_mode",
                        Some(&self.session_id),
                        json!({"mode": "panzoom"}),
                    )?;
                    self.mode_label = "2D".to_string();
                    Ok(true)
                }
                KeyCode::Digit2 => {
                    self.control.request(
                        "camera.set_mode",
                        Some(&self.session_id),
                        json!({"mode": "arcball"}),
                    )?;
                    self.mode_label = "3D(stub)".to_string();
                    Ok(true)
                }
                KeyCode::Digit3 => {
                    self.control.request(
                        "camera.set_mode",
                        Some(&self.session_id),
                        json!({"mode": "freefly"}),
                    )?;
                    self.mode_label = "Graph(stub)".to_string();
                    Ok(true)
                }
                _ => Ok(false),
            }
        }

        fn poll_control_events(&mut self) -> Result<bool> {
            let mut changed = false;
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
                                changed = true;
                            }
                        }
                    }
                    Err(TryRecvError::Empty) => break,
                    Err(TryRecvError::Disconnected) => {
                        bail!("events stream disconnected");
                    }
                }
            }
            Ok(changed)
        }

        fn sync_axis_state(&mut self) -> Result<()> {
            let inspect_value = self
                .control
                .request("session.inspect", Some(&self.session_id), json!({}))?;
            let inspect: SessionInspectResponse = serde_json::from_value(inspect_value)?;
            self.axis_indices = frame_axis_from_view(inspect.view.as_ref());
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
                | "view.set_axis"
                | "view.reorder_axes"
                | "camera.set_pose"
                | "camera.set_mode"
        )
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

    fn spawn_event_listener(control_socket_path: &str, session_id: &str) -> Result<Receiver<EventEnvelope>> {
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
        let subscribe_response: RpcResponseEnvelope = serde_json::from_str(&subscribe_response_line)
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

    struct GpuRenderer {
        _instance: wgpu::Instance,
        surface: wgpu::Surface<'static>,
        device: wgpu::Device,
        queue: wgpu::Queue,
        config: wgpu::SurfaceConfiguration,
        render_pipeline: wgpu::RenderPipeline,
        bind_group_layout: wgpu::BindGroupLayout,
        bind_group: wgpu::BindGroup,
        sampler: wgpu::Sampler,
        texture: wgpu::Texture,
        texture_view: wgpu::TextureView,
        texture_size: (u32, u32),
    }

    impl GpuRenderer {
        fn new(window: Arc<Window>) -> Result<Self> {
            let instance = wgpu::Instance::default();
            let surface = instance.create_surface(window.clone())?;

            let adapter = pollster::block_on(instance.request_adapter(&wgpu::RequestAdapterOptions {
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

            let bind_group_layout =
                device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
                    label: Some("lucida-frame-bind-group-layout"),
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

            let sampler = device.create_sampler(&wgpu::SamplerDescriptor {
                label: Some("lucida-frame-sampler"),
                address_mode_u: wgpu::AddressMode::ClampToEdge,
                address_mode_v: wgpu::AddressMode::ClampToEdge,
                address_mode_w: wgpu::AddressMode::ClampToEdge,
                mag_filter: wgpu::FilterMode::Linear,
                min_filter: wgpu::FilterMode::Linear,
                mipmap_filter: wgpu::FilterMode::Nearest,
                ..Default::default()
            });

            let (texture, texture_view) = create_frame_texture(&device, 1, 1);
            let bind_group = create_frame_bind_group(
                &device,
                &bind_group_layout,
                &texture_view,
                &sampler,
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
                bind_group_layout,
                bind_group,
                sampler,
                texture,
                texture_view,
                texture_size: (1, 1),
            })
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
            let rgba = normalize_u16_to_rgba8(&frame.payload)?;
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
                    &self.sampler,
                );
            }

            let unpadded_bytes_per_row = frame.width as usize * 4;
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
                padded[dst_start..dst_end].copy_from_slice(&rgba[src_start..src_end]);
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
            format: wgpu::TextureFormat::Rgba8UnormSrgb,
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
        sampler: &wgpu::Sampler,
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
                    resource: wgpu::BindingResource::Sampler(sampler),
                },
            ],
        })
    }

    fn normalize_u16_to_rgba8(payload: &[u8]) -> Result<Vec<u8>> {
        if payload.len() % 2 != 0 {
            bail!("u16 payload length must be even");
        }
        let mut values = Vec::with_capacity(payload.len() / 2);
        for chunk in payload.chunks_exact(2) {
            values.push(u16::from_le_bytes([chunk[0], chunk[1]]));
        }
        let max_value = values.iter().copied().max().unwrap_or(1).max(1);

        let mut rgba = Vec::with_capacity(values.len() * 4);
        for value in values {
            let normalized = ((value as f32 / max_value as f32) * 255.0).round() as u8;
            rgba.extend_from_slice(&[normalized, normalized, normalized, 255]);
        }
        Ok(rgba)
    }

    struct LucidaApp {
        client: AppClient,
        window: Option<Arc<Window>>,
        window_id: Option<WindowId>,
        renderer: Option<GpuRenderer>,
        needs_frame: bool,
    }

    impl LucidaApp {
        fn new(client: AppClient) -> Self {
            Self {
                client,
                window: None,
                window_id: None,
                renderer: None,
                needs_frame: true,
            }
        }

        fn refresh_frame_and_title(&mut self) -> Result<()> {
            let window = self
                .window
                .as_ref()
                .ok_or_else(|| anyhow!("window is not initialized"))?;
            let renderer = self
                .renderer
                .as_mut()
                .ok_or_else(|| anyhow!("renderer is not initialized"))?;
            let size = window.inner_size();
            let frame = self.client.request_frame(size.width.max(1), size.height.max(1))?;
            renderer.update_frame(&frame)?;
            update_window_title(window, &self.client);
            self.needs_frame = false;
            Ok(())
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
                update_window_title(&window, &self.client);
                self.renderer = Some(renderer);
                self.window = Some(window.clone());
                self.needs_frame = true;
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
                    self.needs_frame = true;
                    if let Some(window) = &self.window {
                        window.request_redraw();
                    }
                }
                WindowEvent::KeyboardInput { event, .. } if event.state == ElementState::Pressed => {
                    if let PhysicalKey::Code(code) = event.physical_key {
                        match self.client.apply_key(code) {
                            Ok(changed) => {
                                if changed {
                                    self.needs_frame = true;
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
                WindowEvent::RedrawRequested => {
                    if self.needs_frame {
                        if let Err(err) = self.refresh_frame_and_title() {
                            eprintln!("frame refresh failed: {err}");
                            event_loop.exit();
                            return;
                        }
                    }
                    if let Some(renderer) = self.renderer.as_mut() {
                        if let Err(err) = renderer.render() {
                            eprintln!("render failed: {err}");
                            event_loop.exit();
                        }
                    }
                }
                _ => {}
            }
        }

        fn about_to_wait(&mut self, event_loop: &ActiveEventLoop) {
            match self.client.poll_control_events() {
                Ok(changed) => {
                    if changed {
                        self.needs_frame = true;
                    }
                }
                Err(err) => {
                    eprintln!("event stream failed: {err}");
                    event_loop.exit();
                    return;
                }
            }

            if self.needs_frame {
                if let Some(window) = &self.window {
                    window.request_redraw();
                }
            }
        }
    }

    fn update_window_title(window: &Window, client: &AppClient) {
        let title = format!(
            "Lucida Viewer | session={} | mode={} | z={} | zoom={:.2} | state={} | hotkeys: +/- zoom, up/down z, 1/2/3 mode",
            client.session_id,
            client.mode_label,
            client.axis_indices.z,
            client.zoom,
            &client.last_state_hash.chars().take(12).collect::<String>(),
        );
        window.set_title(&title);
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
