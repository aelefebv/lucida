//! Headless browser ownership and Chrome DevTools Protocol capture.
//!
//! The public surface is intentionally small: callers provide an explicit
//! [`CaptureOptions`] value and either capture one PNG, capture a bounded
//! sequence of PNGs in one browser process, or probe the rendered contrast
//! window. Browser processes, temporary profiles, DevTools sockets, browser
//! contexts, targets, and sessions are owned here so dispatch code cannot
//! accidentally leak or outlive them.

use std::future::Future;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::Duration;

use base64::Engine as _;
use futures_util::stream::{SplitSink, SplitStream};
use futures_util::{SinkExt, StreamExt};
use serde_json::{Value, json};
use tempfile::TempDir;
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::net::TcpStream;
use tokio::process::{Child, Command as TokioCommand};
use tokio_tungstenite::tungstenite::protocol::Message;
use tokio_tungstenite::{MaybeTlsStream, WebSocketStream, connect_async};

use crate::error::{CliError, ErrorKind};
use crate::transport::TransportLimits;

const PNG_SIGNATURE: &[u8; 8] = b"\x89PNG\r\n\x1a\n";
const CLEANUP_TIMEOUT: Duration = Duration::from_secs(5);
const HEADLESS_BROWSER_ARGS: &[&str] = &[
    "--headless=new",
    "--enable-unsafe-webgpu",
    "--ignore-gpu-blocklist",
    "--no-first-run",
    "--no-default-browser-check",
];
const LINUX_SOFTWARE_WEBGPU_ARGS: &[&str] = &[
    "--enable-features=CDPScreenshotNewSurface,Vulkan,WebGPU",
    "--enable-unsafe-swiftshader",
    "--use-angle=swiftshader",
    "--use-webgpu-adapter=swiftshader",
];

fn headless_browser_args() -> Vec<&'static str> {
    headless_browser_args_for(cfg!(target_os = "linux"))
}

fn headless_browser_args_for(is_linux: bool) -> Vec<&'static str> {
    let mut arguments = HEADLESS_BROWSER_ARGS.to_vec();
    if is_linux {
        arguments.extend_from_slice(LINUX_SOFTWARE_WEBGPU_ARGS);
    }
    arguments
}

/// Retina is the durable capture default. Every call still passes the value
/// explicitly through [`CaptureOptions`], so the CDP layer never silently
/// falls back to Chromium's DPR1 default.
pub(crate) const DEFAULT_DEVICE_SCALE_FACTOR: f64 = 2.0;

/// Complete, explicit inputs for one browser capture run.
#[derive(Debug, Clone, Copy)]
pub(crate) struct CaptureOptions<'a> {
    width: u32,
    height: u32,
    device_scale_factor: f64,
    timeout: Duration,
    bearer_token: Option<&'a str>,
}

impl<'a> CaptureOptions<'a> {
    pub(crate) fn new(
        width: u32,
        height: u32,
        device_scale_factor: f64,
        timeout: Duration,
    ) -> Self {
        Self {
            width,
            height,
            device_scale_factor,
            timeout,
            bearer_token: None,
        }
    }

    pub(crate) fn with_bearer_token(mut self, bearer_token: Option<&'a str>) -> Self {
        self.bearer_token = bearer_token;
        self
    }

    /// Physical-pixel viewport for a SavedView that will be rendered by this
    /// capture. The browser dimensions above are CSS pixels, but Lucida's scene
    /// camera is deliberately expressed in backing pixels: the web client sets
    /// its viewport to `clientWidth * devicePixelRatio` and scales pointer
    /// deltas the same way. Headless view synthesis must cross that boundary in
    /// one place or DPR 2 silently doubles the world field of view.
    pub(crate) fn scene_viewport(self) -> Result<[u32; 2], CliError> {
        self.validate()?;
        Ok([
            (f64::from(self.width) * self.device_scale_factor).ceil() as u32,
            (f64::from(self.height) * self.device_scale_factor).ceil() as u32,
        ])
    }

    fn validate(self) -> Result<CaptureGeometry, CliError> {
        if self.width == 0 || self.height == 0 {
            return Err(CliError::config(
                "viewer capture width and height must be positive",
            ));
        }
        if !self.device_scale_factor.is_finite() || !(1.0..=4.0).contains(&self.device_scale_factor)
        {
            return Err(CliError::config(
                "viewer capture device scale factor must be finite and between 1 and 4",
            ));
        }

        let physical_width = (f64::from(self.width) * self.device_scale_factor).ceil() as u64;
        let physical_height = (f64::from(self.height) * self.device_scale_factor).ceil() as u64;
        let pixels = physical_width.saturating_mul(physical_height);
        let limits = TransportLimits::from_env()?;
        if pixels > limits.capture_pixels {
            return Err(CliError::new(
                ErrorKind::RejectedCommand,
                format!(
                    "viewer capture is {pixels} physical pixels; limit is {} pixels",
                    limits.capture_pixels
                ),
            )
            .with_context("capture_pixels", pixels)
            .with_context("capture_pixel_limit", limits.capture_pixels)
            .with_context("device_scale_factor", self.device_scale_factor)
            .with_context("physical_width", physical_width)
            .with_context("physical_height", physical_height));
        }

        Ok(CaptureGeometry {
            width: self.width,
            height: self.height,
            device_scale_factor: self.device_scale_factor,
            physical_pixels: pixels,
        })
    }
}

#[derive(Debug, Clone, Copy, PartialEq)]
struct CaptureGeometry {
    width: u32,
    height: u32,
    device_scale_factor: f64,
    physical_pixels: u64,
}

#[derive(Debug, Clone, Copy)]
struct CaptureDeadline {
    expires_at: tokio::time::Instant,
    budget: Duration,
}

impl CaptureDeadline {
    fn new(budget: Duration) -> Result<Self, CliError> {
        if budget.is_zero() {
            return Err(CliError::config("capture timeout must be positive"));
        }
        Ok(Self {
            expires_at: tokio::time::Instant::now() + budget,
            budget,
        })
    }

    fn remaining(self, phase: &'static str) -> Result<Duration, CliError> {
        self.expires_at
            .checked_duration_since(tokio::time::Instant::now())
            .filter(|remaining| !remaining.is_zero())
            .ok_or_else(|| self.error(phase))
    }

    fn error(self, phase: &'static str) -> CliError {
        CliError::new(
            ErrorKind::DeadlineExceeded,
            format!(
                "viewer capture exceeded its end-to-end {}s deadline during {phase}",
                self.budget.as_secs_f64()
            ),
        )
        .with_context("operation", "viewer_capture")
        .with_context("phase", phase)
        .with_context("deadline_ms", self.budget.as_millis())
    }

    async fn sleep(self, duration: Duration, phase: &'static str) -> Result<(), CliError> {
        tokio::time::timeout(self.remaining(phase)?, tokio::time::sleep(duration))
            .await
            .map_err(|_| self.error(phase))?;
        Ok(())
    }
}

/// Capture one rendered viewer URL and write its PNG.
pub(crate) async fn screenshot_to_path(
    url: &str,
    output_path: &Path,
    options: CaptureOptions<'_>,
) -> Result<(), CliError> {
    interruptible(screenshot_to_path_inner(url, output_path, options)).await
}

/// Capture each URL in order while reusing one browser process. Every cell
/// still gets an isolated, explicitly disposed browser context and target, so
/// target/session memory stays O(1) across arbitrarily long montages.
pub(crate) async fn capture_many(
    urls: &[String],
    options: CaptureOptions<'_>,
) -> Result<Vec<Vec<u8>>, CliError> {
    interruptible(capture_many_inner(urls, options)).await
}

/// Render one URL and read the viewer-published auto-contrast window.
pub(crate) async fn probe_auto_contrast(
    url: &str,
    options: CaptureOptions<'_>,
) -> Result<Option<[f64; 2]>, CliError> {
    interruptible(probe_auto_contrast_inner(url, options)).await
}

async fn screenshot_to_path_inner(
    url: &str,
    output_path: &Path,
    options: CaptureOptions<'_>,
) -> Result<(), CliError> {
    let geometry = options.validate()?;
    let deadline = CaptureDeadline::new(options.timeout)?;
    let browser = BrowserProcess::launch(geometry, &deadline).await?;
    let result = capture_cdp_png(
        browser.endpoint(),
        url,
        options.bearer_token,
        geometry,
        &deadline,
    )
    .await;
    let png = finish_browser(result, browser).await?;

    if let Some(parent) = output_path.parent()
        && !parent.as_os_str().is_empty()
    {
        tokio::time::timeout(
            deadline.remaining("screenshot output setup")?,
            tokio::fs::create_dir_all(parent),
        )
        .await
        .map_err(|_| deadline.error("screenshot output setup"))??;
    }
    tokio::time::timeout(
        deadline.remaining("screenshot output write")?,
        tokio::fs::write(output_path, png),
    )
    .await
    .map_err(|_| deadline.error("screenshot output write"))??;
    Ok(())
}

async fn capture_many_inner(
    urls: &[String],
    options: CaptureOptions<'_>,
) -> Result<Vec<Vec<u8>>, CliError> {
    if urls.is_empty() {
        return Err(CliError::config("montage has no cells to render"));
    }
    let geometry = options.validate()?;
    let deadline = CaptureDeadline::new(options.timeout)?;
    let browser = BrowserProcess::launch(geometry, &deadline).await?;
    let result = async {
        let mut pngs = Vec::with_capacity(urls.len());
        for url in urls {
            pngs.push(
                capture_cdp_png(
                    browser.endpoint(),
                    url,
                    options.bearer_token,
                    geometry,
                    &deadline,
                )
                .await?,
            );
        }
        Ok::<_, CliError>(pngs)
    }
    .await;
    finish_browser(result, browser).await
}

async fn probe_auto_contrast_inner(
    url: &str,
    options: CaptureOptions<'_>,
) -> Result<Option<[f64; 2]>, CliError> {
    let geometry = options.validate()?;
    let deadline = CaptureDeadline::new(options.timeout)?;
    let browser = BrowserProcess::launch(geometry, &deadline).await?;
    let result = capture_cdp_auto_contrast(
        browser.endpoint(),
        url,
        options.bearer_token,
        geometry,
        &deadline,
    )
    .await;
    finish_browser(result, browser).await
}

async fn interruptible<T, F>(operation: F) -> Result<T, CliError>
where
    F: Future<Output = Result<T, CliError>>,
{
    interruptible_with(operation, tokio::signal::ctrl_c()).await
}

async fn interruptible_with<T, F, I>(operation: F, interrupt: I) -> Result<T, CliError>
where
    F: Future<Output = Result<T, CliError>>,
    I: Future<Output = std::io::Result<()>>,
{
    tokio::pin!(operation);
    tokio::pin!(interrupt);
    tokio::select! {
        biased;
        result = &mut operation => result,
        signal = &mut interrupt => {
            signal.map_err(CliError::from)?;
            Err(CliError::new(
                ErrorKind::RejectedCommand,
                "viewer capture interrupted",
            )
            .with_context("operation", "viewer_capture")
            .with_context("phase", "interrupt"))
        }
    }
}

/// Owns the child and its on-disk profile as one cancellation-safe unit.
/// `kill_on_drop` plus this Drop implementation cover future cancellation and
/// Ctrl-C; normal completion additionally waits for exit and reports cleanup
/// errors through [`Self::shutdown`].
struct BrowserProcess {
    child: Option<Child>,
    profile: Option<TempDir>,
    endpoint: String,
}

impl BrowserProcess {
    async fn launch(
        geometry: CaptureGeometry,
        deadline: &CaptureDeadline,
    ) -> Result<Self, CliError> {
        let binary = find_browser_binary()?;
        let profile = tempfile::Builder::new()
            .prefix("lucida-cli-chrome-")
            .tempdir()
            .map_err(CliError::from)?;
        Self::launch_with_profile(&binary, profile, geometry, deadline).await
    }

    async fn launch_with_profile(
        binary: &Path,
        profile: TempDir,
        geometry: CaptureGeometry,
        deadline: &CaptureDeadline,
    ) -> Result<Self, CliError> {
        let mut command = TokioCommand::new(binary);
        for argument in headless_browser_args() {
            command.arg(argument);
        }
        command
            .arg("--remote-debugging-port=0")
            .arg(format!("--user-data-dir={}", profile.path().display()))
            .arg(format!(
                "--window-size={},{}",
                geometry.width, geometry.height
            ))
            .arg("about:blank")
            .stderr(Stdio::piped())
            .stdout(Stdio::null())
            .stdin(Stdio::null())
            .kill_on_drop(true);
        let child = command.spawn().map_err(|error| {
            CliError::new(
                ErrorKind::Config,
                format!("failed to launch browser {binary:?}: {error}"),
            )
        })?;
        let mut process = Self {
            child: Some(child),
            profile: Some(profile),
            endpoint: String::new(),
        };
        let stderr = process
            .child
            .as_mut()
            .and_then(|child| child.stderr.take())
            .ok_or_else(|| {
                CliError::new(
                    ErrorKind::Protocol,
                    "browser stderr was not available for DevTools discovery",
                )
            })?;
        process.endpoint = wait_for_devtools_endpoint(stderr, deadline).await?;
        Ok(process)
    }

    fn endpoint(&self) -> &str {
        &self.endpoint
    }

    #[cfg(test)]
    fn pid(&self) -> Option<u32> {
        self.child.as_ref().and_then(Child::id)
    }

    async fn shutdown(mut self) -> Result<(), CliError> {
        let mut first_error = None;
        if let Some(mut child) = self.child.take() {
            let _ = child.start_kill();
            match tokio::time::timeout(CLEANUP_TIMEOUT, child.wait()).await {
                Ok(Ok(_)) => {}
                Ok(Err(error)) => first_error = Some(CliError::from(error)),
                Err(_) => {
                    first_error = Some(
                        CliError::new(
                            ErrorKind::DeadlineExceeded,
                            "browser process cleanup timed out",
                        )
                        .with_context("operation", "viewer_capture")
                        .with_context("phase", "browser cleanup"),
                    );
                }
            }
        }
        if let Some(profile) = self.profile.take() {
            let close = tokio::task::spawn_blocking(move || profile.close());
            match tokio::time::timeout(CLEANUP_TIMEOUT, close).await {
                Ok(Ok(Ok(()))) => {}
                Ok(Ok(Err(error))) if first_error.is_none() => {
                    first_error = Some(CliError::from(error));
                }
                Ok(Err(error)) if first_error.is_none() => {
                    first_error = Some(CliError::new(ErrorKind::Unexpected, error.to_string()));
                }
                Err(_) if first_error.is_none() => {
                    first_error = Some(
                        CliError::new(
                            ErrorKind::DeadlineExceeded,
                            "browser profile cleanup timed out",
                        )
                        .with_context("operation", "viewer_capture")
                        .with_context("phase", "browser profile cleanup"),
                    );
                }
                _ => {}
            }
        }
        match first_error {
            Some(error) => Err(error),
            None => Ok(()),
        }
    }
}

impl Drop for BrowserProcess {
    fn drop(&mut self) {
        if let Some(child) = self.child.as_mut() {
            let _ = child.start_kill();
        }
        // `profile` is a TempDir and is removed by its own Drop after this.
    }
}

async fn finish_browser<T>(
    result: Result<T, CliError>,
    browser: BrowserProcess,
) -> Result<T, CliError> {
    let cleanup = browser.shutdown().await;
    match result {
        Ok(value) => {
            cleanup?;
            Ok(value)
        }
        Err(error) => Err(error),
    }
}

fn find_browser_binary() -> Result<PathBuf, CliError> {
    if let Some(path) = std::env::var_os("LUCIDA_BROWSER") {
        let path = PathBuf::from(path);
        if path.exists() {
            return Ok(path);
        }
        return Err(CliError::new(
            ErrorKind::Config,
            format!(
                "LUCIDA_BROWSER points to a missing executable: {}",
                path.display()
            ),
        ));
    }

    for candidate in [
        "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
        "/Applications/Chromium.app/Contents/MacOS/Chromium",
        "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
    ] {
        let candidate = PathBuf::from(candidate);
        if candidate.exists() {
            return Ok(candidate);
        }
    }

    if let Some(paths) = std::env::var_os("PATH") {
        for dir in std::env::split_paths(&paths) {
            for candidate in [
                "google-chrome",
                "google-chrome-stable",
                "chromium",
                "chromium-browser",
                "microsoft-edge",
                "msedge",
            ] {
                let executable = dir.join(candidate);
                if executable.is_file() {
                    return Ok(executable);
                }
            }
        }
    }

    Err(CliError::new(
        ErrorKind::Config,
        "could not find Chrome/Chromium; set LUCIDA_BROWSER to a browser executable",
    ))
}

async fn wait_for_devtools_endpoint<R>(
    stderr: R,
    deadline: &CaptureDeadline,
) -> Result<String, CliError>
where
    R: tokio::io::AsyncRead + Unpin,
{
    let mut lines = BufReader::new(stderr).lines();
    tokio::time::timeout(deadline.remaining("DevTools discovery")?, async {
        while let Some(line) = lines.next_line().await? {
            if let Some(endpoint) = line
                .strip_prefix("DevTools listening on ")
                .map(str::trim)
                .filter(|value| !value.is_empty())
            {
                return Ok(endpoint.to_string());
            }
        }
        Err(CliError::new(
            ErrorKind::Protocol,
            "browser exited before printing a DevTools endpoint",
        ))
    })
    .await
    .map_err(|_| deadline.error("DevTools discovery"))?
}

type BrowserSocket = WebSocketStream<MaybeTlsStream<TcpStream>>;

struct CdpClient {
    write: SplitSink<BrowserSocket, Message>,
    read: SplitStream<BrowserSocket>,
    next_id: u64,
}

impl CdpClient {
    async fn connect(endpoint: &str, deadline: &CaptureDeadline) -> Result<Self, CliError> {
        let (socket, _response) = tokio::time::timeout(
            deadline.remaining("CDP connection")?,
            connect_async(endpoint),
        )
        .await
        .map_err(|_| deadline.error("CDP connection"))?
        .map_err(|error| CliError::new(ErrorKind::SessionDisconnect, error.to_string()))?;
        let (write, read) = socket.split();
        Ok(Self {
            write,
            read,
            next_id: 1,
        })
    }

    async fn call(
        &mut self,
        session_id: Option<&str>,
        method: &str,
        params: Value,
        deadline: &CaptureDeadline,
        auth_scope: Option<&CdpAuthScope>,
    ) -> Result<Value, CliError> {
        let request_id = self.next_id;
        self.next_id = self
            .next_id
            .checked_add(1)
            .ok_or_else(|| CliError::new(ErrorKind::Protocol, "CDP request id space exhausted"))?;
        let mut message = json!({
            "id": request_id,
            "method": method,
            "params": params,
        });
        if let Some(session_id) = session_id {
            message["sessionId"] = json!(session_id);
        }
        tokio::time::timeout(
            deadline.remaining("CDP request send")?,
            self.write.send(Message::Text(message.to_string().into())),
        )
        .await
        .map_err(|_| deadline.error("CDP request send"))?
        .map_err(|error| CliError::new(ErrorKind::SessionDisconnect, error.to_string()))?;

        tokio::time::timeout(deadline.remaining("CDP response")?, async {
            while let Some(message) = self.read.next().await {
                let Message::Text(text) = message.map_err(|error| {
                    CliError::new(ErrorKind::SessionDisconnect, error.to_string())
                })?
                else {
                    continue;
                };
                let value: Value = serde_json::from_str(&text).map_err(|error| {
                    CliError::new(ErrorKind::Protocol, format!("invalid CDP message: {error}"))
                })?;
                if value.get("method").and_then(Value::as_str) == Some("Fetch.requestPaused") {
                    if let Some(auth_scope) = auth_scope {
                        self.continue_fetch_request(session_id, &value, auth_scope, deadline)
                            .await?;
                    }
                    continue;
                }
                if value.get("id").and_then(Value::as_u64) != Some(request_id) {
                    continue;
                }
                if let Some(error) = value.get("error") {
                    return Err(CliError::new(
                        ErrorKind::Protocol,
                        format!("CDP {method} failed: {error}"),
                    ));
                }
                return Ok(value.get("result").cloned().unwrap_or_else(|| json!({})));
            }
            Err(CliError::new(
                ErrorKind::SessionDisconnect,
                "browser DevTools connection closed",
            ))
        })
        .await
        .map_err(|_| {
            deadline
                .error("CDP response")
                .with_context("cdp_method", method)
        })?
    }

    async fn continue_fetch_request(
        &mut self,
        fallback_session_id: Option<&str>,
        event: &Value,
        auth_scope: &CdpAuthScope,
        deadline: &CaptureDeadline,
    ) -> Result<(), CliError> {
        let params = event.get("params").ok_or_else(|| {
            CliError::new(
                ErrorKind::Protocol,
                "CDP Fetch.requestPaused params were missing",
            )
        })?;
        let fetch_request_id =
            params
                .get("requestId")
                .and_then(Value::as_str)
                .ok_or_else(|| {
                    CliError::new(
                        ErrorKind::Protocol,
                        "CDP Fetch.requestPaused requestId was missing",
                    )
                })?;
        let request = params.get("request").ok_or_else(|| {
            CliError::new(
                ErrorKind::Protocol,
                "CDP Fetch.requestPaused request was missing",
            )
        })?;
        let headers = scoped_fetch_headers(request, auth_scope);
        let command_id = self.next_id;
        self.next_id = self
            .next_id
            .checked_add(1)
            .ok_or_else(|| CliError::new(ErrorKind::Protocol, "CDP request id space exhausted"))?;
        let mut command = json!({
            "id": command_id,
            "method": "Fetch.continueRequest",
            "params": {
                "requestId": fetch_request_id,
                "headers": headers,
            },
        });
        if let Some(session_id) = event
            .get("sessionId")
            .and_then(Value::as_str)
            .or(fallback_session_id)
        {
            command["sessionId"] = json!(session_id);
        }
        tokio::time::timeout(
            deadline.remaining("CDP intercepted request continuation")?,
            self.write.send(Message::Text(command.to_string().into())),
        )
        .await
        .map_err(|_| deadline.error("CDP intercepted request continuation"))?
        .map_err(|error| CliError::new(ErrorKind::SessionDisconnect, error.to_string()))
    }
}

/// One disposable CDP browser context + target + attached session. The
/// context is created with `disposeOnDetach`, which is the async-drop backstop:
/// if a future is cancelled before [`Self::close`] runs, dropping `client`
/// closes the socket and Chromium disposes the context and every target in it.
struct CdpPage {
    client: CdpClient,
    browser_context_id: String,
    target_id: String,
    session_id: String,
    auth_scope: Option<CdpAuthScope>,
}

impl CdpPage {
    async fn open(
        endpoint: &str,
        url: &str,
        bearer_token: Option<&str>,
        geometry: CaptureGeometry,
        deadline: &CaptureDeadline,
    ) -> Result<Self, CliError> {
        let mut client = CdpClient::connect(endpoint, deadline).await?;
        let context = client
            .call(
                None,
                "Target.createBrowserContext",
                json!({ "disposeOnDetach": true }),
                deadline,
                None,
            )
            .await?;
        let browser_context_id = context
            .get("browserContextId")
            .and_then(Value::as_str)
            .ok_or_else(|| CliError::new(ErrorKind::Protocol, "CDP browserContextId was missing"))?
            .to_string();
        let created = client
            .call(
                None,
                "Target.createTarget",
                json!({
                    "url": "about:blank",
                    "browserContextId": browser_context_id,
                }),
                deadline,
                None,
            )
            .await?;
        let target_id = created
            .get("targetId")
            .and_then(Value::as_str)
            .ok_or_else(|| CliError::new(ErrorKind::Protocol, "CDP targetId was missing"))?
            .to_string();
        let attached = client
            .call(
                None,
                "Target.attachToTarget",
                json!({ "targetId": target_id, "flatten": true }),
                deadline,
                None,
            )
            .await?;
        let session_id = attached
            .get("sessionId")
            .and_then(Value::as_str)
            .ok_or_else(|| CliError::new(ErrorKind::Protocol, "CDP sessionId was missing"))?
            .to_string();
        let auth_scope = bearer_token
            .map(|token| CdpAuthScope::new(url, token))
            .transpose()?;
        let mut page = Self {
            client,
            browser_context_id,
            target_id,
            session_id,
            auth_scope,
        };
        if let Err(error) = page.prepare(url, geometry, deadline).await {
            let _ = page.close().await;
            return Err(error);
        }
        Ok(page)
    }

    async fn prepare(
        &mut self,
        url: &str,
        geometry: CaptureGeometry,
        deadline: &CaptureDeadline,
    ) -> Result<(), CliError> {
        self.call("Network.enable", json!({}), deadline, false)
            .await?;
        if let Some(scope) = self.auth_scope.as_ref() {
            self.client
                .call(
                    Some(&self.session_id),
                    "Fetch.enable",
                    json!({
                        "patterns": [{
                            "urlPattern": scope.fetch_pattern(),
                            "requestStage": "Request"
                        }]
                    }),
                    deadline,
                    None,
                )
                .await?;
        }
        self.call(
            "Emulation.setDeviceMetricsOverride",
            json!({
                "width": geometry.width,
                "height": geometry.height,
                "deviceScaleFactor": geometry.device_scale_factor,
                "mobile": false,
            }),
            deadline,
            true,
        )
        .await?;
        self.call("Page.enable", json!({}), deadline, true).await?;
        self.call("Page.navigate", json!({ "url": url }), deadline, true)
            .await?;
        self.wait_for_page_ready(deadline).await?;
        self.wait_for_lucida_capture_ready(deadline).await
    }

    async fn call(
        &mut self,
        method: &str,
        params: Value,
        deadline: &CaptureDeadline,
        authenticate: bool,
    ) -> Result<Value, CliError> {
        self.client
            .call(
                Some(&self.session_id),
                method,
                params,
                deadline,
                authenticate.then_some(()).and(self.auth_scope.as_ref()),
            )
            .await
    }

    async fn wait_for_page_ready(&mut self, deadline: &CaptureDeadline) -> Result<(), CliError> {
        loop {
            let ready = self
                .call(
                    "Runtime.evaluate",
                    json!({
                        "expression": "document.readyState === 'complete' && !!document.querySelector('canvas')",
                        "returnByValue": true
                    }),
                    deadline,
                    true,
                )
                .await?;
            if ready
                .get("result")
                .and_then(|value| value.get("value"))
                .and_then(Value::as_bool)
                .unwrap_or(false)
            {
                deadline
                    .sleep(Duration::from_millis(500), "viewer canvas settle")
                    .await?;
                return Ok(());
            }
            deadline
                .sleep(Duration::from_millis(250), "viewer canvas readiness")
                .await?;
        }
    }

    async fn wait_for_lucida_capture_ready(
        &mut self,
        deadline: &CaptureDeadline,
    ) -> Result<(), CliError> {
        loop {
            let result = self
                .call(
                    "Runtime.evaluate",
                    json!({
                        "expression": LUCIDA_CAPTURE_READY_PROBE,
                        "returnByValue": true
                    }),
                    deadline,
                    true,
                )
                .await?;
            let probe = capture_ready_probe_from_cdp_result(&result)?;
            if probe.ready {
                return Ok(());
            }
            deadline
                .sleep(Duration::from_millis(250), "Lucida render readiness")
                .await
                .map_err(|error| {
                    error.with_context("last_probe", capture_ready_probe_summary(&probe))
                })?;
        }
    }

    async fn capture_png(&mut self, deadline: &CaptureDeadline) -> Result<Vec<u8>, CliError> {
        let captured = self
            .call(
                "Page.captureScreenshot",
                json!({ "format": "png", "fromSurface": true }),
                deadline,
                true,
            )
            .await?;
        let data = captured
            .get("data")
            .and_then(Value::as_str)
            .ok_or_else(|| CliError::new(ErrorKind::Protocol, "CDP screenshot data was missing"))?;
        decode_capture_png(data, TransportLimits::from_env()?.capture_bytes)
    }

    async fn auto_contrast(
        &mut self,
        deadline: &CaptureDeadline,
    ) -> Result<Option<[f64; 2]>, CliError> {
        let evaluated = self
            .call(
                "Runtime.evaluate",
                json!({
                    "expression": "(() => { const a = window.__lucidaAutoContrast; return (a && Number.isFinite(a.min) && Number.isFinite(a.max)) ? [a.min, a.max] : null; })()",
                    "returnByValue": true
                }),
                deadline,
                true,
            )
            .await?;
        Ok(evaluated
            .get("result")
            .and_then(|value| value.get("value"))
            .and_then(Value::as_array)
            .and_then(|values| Some([values.first()?.as_f64()?, values.get(1)?.as_f64()?])))
    }

    async fn close(mut self) -> Result<(), CliError> {
        let deadline = CaptureDeadline::new(CLEANUP_TIMEOUT)?;
        let auth_scope = self.auth_scope.clone();
        let mut first_error = None;
        for (method, params) in [
            (
                "Target.detachFromTarget",
                json!({ "sessionId": self.session_id }),
            ),
            ("Target.closeTarget", json!({ "targetId": self.target_id })),
            (
                "Target.disposeBrowserContext",
                json!({ "browserContextId": self.browser_context_id }),
            ),
        ] {
            if let Err(error) = self
                .client
                .call(None, method, params, &deadline, auth_scope.as_ref())
                .await
                && first_error.is_none()
            {
                first_error = Some(error);
            }
        }
        match first_error {
            Some(error) => Err(error),
            None => Ok(()),
        }
    }
}

async fn capture_cdp_png(
    endpoint: &str,
    url: &str,
    bearer_token: Option<&str>,
    geometry: CaptureGeometry,
    deadline: &CaptureDeadline,
) -> Result<Vec<u8>, CliError> {
    let mut page = CdpPage::open(endpoint, url, bearer_token, geometry, deadline).await?;
    let result = page.capture_png(deadline).await;
    let cleanup = page.close().await;
    match result {
        Ok(value) => {
            cleanup?;
            Ok(value)
        }
        Err(error) => Err(error),
    }
}

async fn capture_cdp_auto_contrast(
    endpoint: &str,
    url: &str,
    bearer_token: Option<&str>,
    geometry: CaptureGeometry,
    deadline: &CaptureDeadline,
) -> Result<Option<[f64; 2]>, CliError> {
    let mut page = CdpPage::open(endpoint, url, bearer_token, geometry, deadline).await?;
    let result = page.auto_contrast(deadline).await;
    let cleanup = page.close().await;
    match result {
        Ok(value) => {
            cleanup?;
            Ok(value)
        }
        Err(error) => Err(error),
    }
}

#[derive(Debug, Clone)]
struct CdpAuthScope {
    origin: String,
    authorization: String,
}

impl CdpAuthScope {
    fn new(url: &str, bearer_token: &str) -> Result<Self, CliError> {
        let url = reqwest::Url::parse(url).map_err(|error| {
            CliError::new(
                ErrorKind::InvalidServer,
                format!("invalid viewer URL for browser authentication: {error}"),
            )
        })?;
        if !matches!(url.scheme(), "http" | "https") || url.host_str().is_none() {
            return Err(CliError::new(
                ErrorKind::InvalidServer,
                "viewer URL must have an HTTP(S) origin",
            ));
        }
        Ok(Self {
            origin: url.origin().ascii_serialization(),
            authorization: format!("Bearer {bearer_token}"),
        })
    }

    fn fetch_pattern(&self) -> String {
        format!("{}/*", self.origin.trim_end_matches('/'))
    }

    fn authorizes(&self, url: &str) -> bool {
        reqwest::Url::parse(url)
            .ok()
            .is_some_and(|url| url.origin().ascii_serialization() == self.origin)
    }
}

fn scoped_fetch_headers(request: &Value, auth_scope: &CdpAuthScope) -> Vec<Value> {
    let url = request
        .get("url")
        .and_then(Value::as_str)
        .unwrap_or_default();
    let mut headers = request
        .get("headers")
        .and_then(Value::as_object)
        .into_iter()
        .flat_map(|headers| headers.iter())
        .filter(|(name, _)| !name.eq_ignore_ascii_case("authorization"))
        .filter_map(|(name, value)| {
            value
                .as_str()
                .map(|value| json!({ "name": name, "value": value }))
        })
        .collect::<Vec<_>>();
    if auth_scope.authorizes(url) {
        headers.push(json!({
            "name": "Authorization",
            "value": auth_scope.authorization,
        }));
    }
    headers
}

fn decode_capture_png(data: &str, capture_byte_limit: usize) -> Result<Vec<u8>, CliError> {
    let max_base64_bytes = capture_byte_limit.saturating_mul(4).div_ceil(3) + 4;
    if data.len() > max_base64_bytes {
        return Err(CliError::new(
            ErrorKind::Protocol,
            format!("CDP screenshot exceeded the {capture_byte_limit}-byte decoded capture limit"),
        )
        .with_context("capture_byte_limit", capture_byte_limit));
    }
    let png = base64::engine::general_purpose::STANDARD
        .decode(data)
        .map_err(|error| {
            CliError::new(ErrorKind::Protocol, format!("invalid PNG data: {error}"))
        })?;
    if png.len() > capture_byte_limit {
        return Err(CliError::new(
            ErrorKind::Protocol,
            format!("CDP screenshot exceeded the {capture_byte_limit}-byte capture limit"),
        )
        .with_context("capture_bytes", png.len())
        .with_context("capture_byte_limit", capture_byte_limit));
    }
    ensure_png_signature(&png)?;
    Ok(png)
}

fn ensure_png_signature(bytes: &[u8]) -> Result<(), CliError> {
    if bytes.starts_with(PNG_SIGNATURE) {
        return Ok(());
    }
    Err(CliError::new(
        ErrorKind::Protocol,
        "CDP screenshot did not return a PNG",
    ))
}

const LUCIDA_CAPTURE_READY_PROBE: &str = r#"(() => {
  const canvas = document.querySelector('canvas');
  if (!canvas) {
    return {
      ready: false,
      reason: 'missing_canvas',
      frame_count: 0,
      dataset_count: 0,
      canvas_width: 0,
      canvas_height: 0,
      mode: null
    };
  }
  const canvasWidth = canvas.width || Math.floor(canvas.clientWidth);
  const canvasHeight = canvas.height || Math.floor(canvas.clientHeight);
  if (!canvasWidth || !canvasHeight) {
    return {
      ready: false,
      reason: 'zero_size_canvas',
      frame_count: 0,
      dataset_count: 0,
      canvas_width: canvasWidth || 0,
      canvas_height: canvasHeight || 0,
      mode: null
    };
  }
  const state = window.__lucidaCaptureReady;
  if (!state) {
    return {
      ready: false,
      reason: 'missing_lucida_capture_ready',
      frame_count: 0,
      dataset_count: 0,
      canvas_width: canvasWidth,
      canvas_height: canvasHeight,
      mode: null
    };
  }
  const frameCount = Number(state.frameCount || 0);
  const datasetCount = Number(state.datasetCount || 0);
  const ready = Boolean(state.ready) && frameCount > 0 && datasetCount > 0;
  return {
    ready,
    reason: ready ? 'rendered' : String(state.reason || 'not_ready'),
    frame_count: frameCount,
    dataset_count: datasetCount,
    canvas_width: canvasWidth,
    canvas_height: canvasHeight,
    mode: state.mode || null
  };
})()"#;

#[derive(Debug, Clone, PartialEq, Eq)]
struct CaptureReadyProbe {
    ready: bool,
    reason: String,
    frame_count: u64,
    dataset_count: u64,
    canvas_width: u64,
    canvas_height: u64,
    mode: Option<String>,
}

fn capture_ready_probe_from_cdp_result(value: &Value) -> Result<CaptureReadyProbe, CliError> {
    let probe = value
        .get("result")
        .and_then(|value| value.get("value"))
        .ok_or_else(|| {
            CliError::new(
                ErrorKind::Protocol,
                "capture-ready probe result was missing",
            )
        })?;
    Ok(CaptureReadyProbe {
        ready: probe.get("ready").and_then(Value::as_bool).unwrap_or(false),
        reason: probe
            .get("reason")
            .and_then(Value::as_str)
            .unwrap_or("unknown")
            .to_string(),
        frame_count: probe
            .get("frame_count")
            .and_then(Value::as_u64)
            .unwrap_or(0),
        dataset_count: probe
            .get("dataset_count")
            .and_then(Value::as_u64)
            .unwrap_or(0),
        canvas_width: probe
            .get("canvas_width")
            .and_then(Value::as_u64)
            .unwrap_or(0),
        canvas_height: probe
            .get("canvas_height")
            .and_then(Value::as_u64)
            .unwrap_or(0),
        mode: probe
            .get("mode")
            .and_then(Value::as_str)
            .map(str::to_string),
    })
}

fn capture_ready_probe_summary(probe: &CaptureReadyProbe) -> String {
    format!(
        "last probe: reason={}, frame_count={}, dataset_count={}, canvas={}x{}, mode={}",
        probe.reason,
        probe.frame_count,
        probe.dataset_count,
        probe.canvas_width,
        probe.canvas_height,
        probe.mode.as_deref().unwrap_or("unknown"),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Arc;
    use std::sync::atomic::{AtomicU32, Ordering};

    use tokio::net::TcpListener;
    use tokio::sync::oneshot;
    use tokio_tungstenite::accept_async;

    #[test]
    fn linux_browser_launch_enables_the_software_webgpu_backend() {
        let portable = headless_browser_args_for(false);
        let linux = headless_browser_args_for(true);

        assert_eq!(
            portable,
            vec![
                "--headless=new",
                "--enable-unsafe-webgpu",
                "--ignore-gpu-blocklist",
                "--no-first-run",
                "--no-default-browser-check",
            ]
        );
        assert_eq!(
            linux,
            vec![
                "--headless=new",
                "--enable-unsafe-webgpu",
                "--ignore-gpu-blocklist",
                "--no-first-run",
                "--no-default-browser-check",
                "--enable-features=CDPScreenshotNewSurface,Vulkan,WebGPU",
                "--enable-unsafe-swiftshader",
                "--use-angle=swiftshader",
                "--use-webgpu-adapter=swiftshader",
            ]
        );
        assert_eq!(
            headless_browser_args(),
            headless_browser_args_for(cfg!(target_os = "linux"))
        );
    }

    #[test]
    fn capture_options_require_explicit_supported_dpr_and_count_physical_pixels() {
        let dpr1_options = CaptureOptions::new(100, 50, 1.0, Duration::from_secs(1));
        let dpr2_options = CaptureOptions::new(100, 50, 2.0, Duration::from_secs(1));
        let dpr1 = dpr1_options.validate().unwrap();
        let dpr2 = dpr2_options.validate().unwrap();
        assert_eq!(dpr1.physical_pixels, 5_000);
        assert_eq!(dpr2.physical_pixels, 20_000);
        assert_eq!(dpr1_options.scene_viewport().unwrap(), [100, 50]);
        assert_eq!(dpr2_options.scene_viewport().unwrap(), [200, 100]);
        assert!(
            CaptureOptions::new(100, 50, f64::NAN, Duration::from_secs(1))
                .validate()
                .is_err()
        );
        assert!(
            CaptureOptions::new(100, 50, 0.0, Duration::from_secs(1))
                .validate()
                .is_err()
        );
    }

    #[test]
    fn capture_ready_probe_parser_distinguishes_ready_and_waiting_results() {
        let ready = capture_ready_probe_from_cdp_result(&json!({
            "result": { "value": {
                "ready": true,
                "reason": "rendered",
                "frame_count": 2,
                "dataset_count": 1,
                "canvas_width": 900,
                "canvas_height": 700,
                "mode": "slice"
            }}
        }))
        .unwrap();
        assert!(ready.ready);
        assert_eq!(ready.frame_count, 2);
        assert_eq!(ready.mode.as_deref(), Some("slice"));

        let waiting = capture_ready_probe_from_cdp_result(&json!({
            "result": { "value": {
                "ready": false,
                "reason": "dataset_added_waiting_for_render",
                "frame_count": 0,
                "dataset_count": 1,
                "canvas_width": 900,
                "canvas_height": 700,
                "mode": "slice"
            }}
        }))
        .unwrap();
        assert!(!waiting.ready);
        assert!(capture_ready_probe_summary(&waiting).contains("dataset_added_waiting_for_render"));
    }

    #[test]
    fn capture_bytes_are_signature_and_size_checked() {
        let mut png = Vec::from(PNG_SIGNATURE.as_slice());
        png.extend_from_slice(b"rest of fake png");
        ensure_png_signature(&png).unwrap();
        assert_eq!(
            ensure_png_signature(b"not a png").unwrap_err().kind,
            ErrorKind::Protocol
        );

        let encoded_limit_error = decode_capture_png(&"A".repeat(17), 8).unwrap_err();
        assert_eq!(encoded_limit_error.kind, ErrorKind::Protocol);
        assert_eq!(
            encoded_limit_error.to_json()["error"]["capture_byte_limit"],
            8
        );
        let decoded_limit_error = decode_capture_png("AAAAAAAAAAAA", 8).unwrap_err();
        assert_eq!(decoded_limit_error.to_json()["error"]["capture_bytes"], 9);
    }

    #[test]
    fn bearer_header_is_scoped_to_the_viewer_origin() {
        let scope = CdpAuthScope::new(
            "https://viewer.example.test/lucida/w/workspace",
            "top-secret",
        )
        .unwrap();
        assert_eq!(scope.fetch_pattern(), "https://viewer.example.test/*");
        let same_origin = scoped_fetch_headers(
            &json!({
                "url": "https://viewer.example.test/lucida/api/workspaces",
                "headers": {"Accept": "application/json", "authorization": "stale"}
            }),
            &scope,
        );
        assert!(same_origin.iter().any(|header| {
            header["name"] == "Authorization" && header["value"] == "Bearer top-secret"
        }));
        assert_eq!(
            same_origin
                .iter()
                .filter(|header| header["name"] == "Authorization")
                .count(),
            1
        );
        let cross_origin = scoped_fetch_headers(
            &json!({
                "url": "https://cdn.example.test/asset.js",
                "headers": {"Accept": "*/*", "Authorization": "stale"}
            }),
            &scope,
        );
        assert!(cross_origin.iter().all(|header| {
            header["name"]
                .as_str()
                .is_none_or(|name| !name.eq_ignore_ascii_case("authorization"))
        }));
    }

    #[derive(Clone, Copy)]
    enum MockFailure {
        None,
        Navigate,
        ReadinessTimeout,
    }

    async fn serve_mock_cdp(stream: TcpStream, failure: MockFailure) -> Vec<Value> {
        let mut socket = accept_async(stream).await.unwrap();
        let mut requests = Vec::new();
        while let Some(message) = socket.next().await {
            let Message::Text(text) = message.unwrap() else {
                continue;
            };
            let request: Value = serde_json::from_str(&text).unwrap();
            let method = request["method"].as_str().unwrap_or_default();
            let id = request["id"].as_u64().unwrap();
            requests.push(request.clone());
            if matches!(failure, MockFailure::ReadinessTimeout) && method == "Runtime.evaluate" {
                continue;
            }
            let response = if matches!(failure, MockFailure::Navigate) && method == "Page.navigate"
            {
                json!({ "id": id, "error": { "message": "navigate failed" } })
            } else {
                let result = match method {
                    "Target.createBrowserContext" => json!({ "browserContextId": "context" }),
                    "Target.createTarget" => json!({ "targetId": "target" }),
                    "Target.attachToTarget" => json!({ "sessionId": "session" }),
                    "Runtime.evaluate" => {
                        let expression =
                            request["params"]["expression"].as_str().unwrap_or_default();
                        if expression.contains("document.readyState") {
                            json!({ "result": { "value": true } })
                        } else if expression.contains("__lucidaCaptureReady") {
                            json!({ "result": { "value": {
                                "ready": true,
                                "reason": "rendered",
                                "frame_count": 1,
                                "dataset_count": 1,
                                "canvas_width": 100,
                                "canvas_height": 50,
                                "mode": "slice"
                            }}})
                        } else {
                            json!({ "result": { "value": [1.0, 2.0] } })
                        }
                    }
                    "Page.captureScreenshot" => json!({
                        "data": base64::engine::general_purpose::STANDARD.encode(PNG_SIGNATURE)
                    }),
                    _ => json!({}),
                };
                json!({ "id": id, "result": result })
            };
            socket
                .send(Message::Text(response.to_string().into()))
                .await
                .unwrap();
            if method == "Target.disposeBrowserContext" {
                break;
            }
        }
        requests
    }

    async fn mock_cdp(failure: MockFailure) -> (String, tokio::task::JoinHandle<Vec<Value>>) {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let handle = tokio::spawn(async move {
            let (stream, _) = listener.accept().await.unwrap();
            serve_mock_cdp(stream, failure).await
        });
        (format!("ws://{address}"), handle)
    }

    async fn mock_cdp_many(
        connection_count: usize,
    ) -> (String, tokio::task::JoinHandle<Vec<Vec<Value>>>) {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let handle = tokio::spawn(async move {
            let mut batches = Vec::with_capacity(connection_count);
            for _ in 0..connection_count {
                let (stream, _) = listener.accept().await.unwrap();
                batches.push(serve_mock_cdp(stream, MockFailure::None).await);
            }
            batches
        });
        (format!("ws://{address}"), handle)
    }

    fn method_names(requests: &[Value]) -> Vec<&str> {
        requests
            .iter()
            .filter_map(|request| request["method"].as_str())
            .collect()
    }

    #[tokio::test]
    async fn cdp_contract_covers_dpr1_and_dpr2_and_disposes_each_target() {
        for dpr in [1.0, 2.0] {
            let (endpoint, server) = mock_cdp(MockFailure::None).await;
            let geometry = CaptureGeometry {
                width: 100,
                height: 50,
                device_scale_factor: dpr,
                physical_pixels: (100.0 * dpr * 50.0 * dpr) as u64,
            };
            let deadline = CaptureDeadline::new(Duration::from_secs(2)).unwrap();
            capture_cdp_png(
                &endpoint,
                "https://viewer.example.test/w/workspace",
                None,
                geometry,
                &deadline,
            )
            .await
            .unwrap();
            let requests = server.await.unwrap();
            let metrics = requests
                .iter()
                .find(|request| request["method"] == "Emulation.setDeviceMetricsOverride")
                .unwrap();
            assert_eq!(metrics["params"]["deviceScaleFactor"].as_f64(), Some(dpr));
            let methods = method_names(&requests);
            assert!(methods.contains(&"Target.detachFromTarget"));
            assert!(methods.contains(&"Target.closeTarget"));
            assert!(methods.contains(&"Target.disposeBrowserContext"));
        }
    }

    #[tokio::test]
    async fn cdp_target_is_disposed_after_protocol_error_and_timeout() {
        for failure in [MockFailure::Navigate, MockFailure::ReadinessTimeout] {
            let (endpoint, server) = mock_cdp(failure).await;
            let geometry = CaptureGeometry {
                width: 100,
                height: 50,
                device_scale_factor: 2.0,
                physical_pixels: 20_000,
            };
            let timeout = if matches!(failure, MockFailure::ReadinessTimeout) {
                Duration::from_millis(750)
            } else {
                Duration::from_secs(2)
            };
            let deadline = CaptureDeadline::new(timeout).unwrap();
            assert!(
                capture_cdp_png(
                    &endpoint,
                    "https://viewer.example.test/w/workspace",
                    None,
                    geometry,
                    &deadline,
                )
                .await
                .is_err()
            );
            let requests = server.await.unwrap();
            let methods = method_names(&requests);
            assert!(methods.contains(&"Target.detachFromTarget"));
            assert!(methods.contains(&"Target.closeTarget"));
            assert!(methods.contains(&"Target.disposeBrowserContext"));
        }
    }

    #[tokio::test]
    async fn montage_style_capture_keeps_at_most_one_target_live() {
        const CELL_COUNT: usize = 5;
        let (endpoint, server) = mock_cdp_many(CELL_COUNT).await;
        let geometry = CaptureGeometry {
            width: 100,
            height: 50,
            device_scale_factor: 2.0,
            physical_pixels: 20_000,
        };
        let deadline = CaptureDeadline::new(Duration::from_secs(5)).unwrap();
        for index in 0..CELL_COUNT {
            capture_cdp_png(
                &endpoint,
                &format!("https://viewer.example.test/w/workspace#cell={index}"),
                None,
                geometry,
                &deadline,
            )
            .await
            .unwrap();
        }

        let batches = server.await.unwrap();
        let mut live_targets = 0_u32;
        let mut peak_targets = 0_u32;
        for request in batches.iter().flatten() {
            match request["method"].as_str() {
                Some("Target.createTarget") => {
                    live_targets += 1;
                    peak_targets = peak_targets.max(live_targets);
                }
                Some("Target.closeTarget") => live_targets -= 1,
                _ => {}
            }
        }
        assert_eq!(batches.len(), CELL_COUNT);
        assert_eq!(live_targets, 0);
        assert_eq!(peak_targets, 1);
    }

    #[tokio::test]
    async fn cancellation_drops_cdp_socket_with_disposable_context() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let endpoint = format!("ws://{}", listener.local_addr().unwrap());
        let (blocked_tx, blocked_rx) = oneshot::channel();
        let server = tokio::spawn(async move {
            let (stream, _) = listener.accept().await.unwrap();
            let mut socket = accept_async(stream).await.unwrap();
            let mut requests = Vec::new();
            let mut blocked_tx = Some(blocked_tx);
            while let Some(message) = socket.next().await {
                let message = match message {
                    Ok(message) => message,
                    // Cancellation intentionally drops the client socket
                    // without spending time on a WebSocket close handshake.
                    // ResetWithoutClosingHandshake is therefore expected.
                    Err(_) => break,
                };
                let Message::Text(text) = message else {
                    continue;
                };
                let request: Value = serde_json::from_str(&text).unwrap();
                let method = request["method"].as_str().unwrap_or_default();
                let id = request["id"].as_u64().unwrap();
                requests.push(request.clone());
                if method == "Runtime.evaluate" {
                    if let Some(tx) = blocked_tx.take() {
                        let _ = tx.send(());
                    }
                    continue;
                }
                let result = match method {
                    "Target.createBrowserContext" => json!({ "browserContextId": "context" }),
                    "Target.createTarget" => json!({ "targetId": "target" }),
                    "Target.attachToTarget" => json!({ "sessionId": "session" }),
                    _ => json!({}),
                };
                socket
                    .send(Message::Text(
                        json!({ "id": id, "result": result }).to_string().into(),
                    ))
                    .await
                    .unwrap();
            }
            requests
        });
        let geometry = CaptureGeometry {
            width: 100,
            height: 50,
            device_scale_factor: 2.0,
            physical_pixels: 20_000,
        };
        let deadline = CaptureDeadline::new(Duration::from_secs(5)).unwrap();
        let operation = capture_cdp_png(
            &endpoint,
            "https://viewer.example.test/w/workspace",
            None,
            geometry,
            &deadline,
        );
        let interrupt = async move {
            blocked_rx
                .await
                .map_err(|_| std::io::Error::other("CDP operation did not block"))?;
            Ok(())
        };
        let error = interruptible_with(operation, interrupt).await.unwrap_err();
        assert_eq!(error.kind, ErrorKind::RejectedCommand);

        let requests = tokio::time::timeout(Duration::from_secs(1), server)
            .await
            .expect("cancellation must close the CDP socket")
            .unwrap();
        let context = requests
            .iter()
            .find(|request| request["method"] == "Target.createBrowserContext")
            .unwrap();
        assert_eq!(context["params"]["disposeOnDetach"].as_bool(), Some(true));
        assert!(method_names(&requests).contains(&"Target.attachToTarget"));
    }

    #[cfg(unix)]
    fn fake_browser(script_dir: &Path, pid_file: &Path, print_endpoint: bool) -> PathBuf {
        use std::os::unix::fs::PermissionsExt as _;

        let tail = ["/usr/bin/tail", "/bin/tail"]
            .into_iter()
            .find(|path| Path::new(path).exists())
            .expect("tail executable");
        let script = script_dir.join("fake-browser");
        let endpoint = if print_endpoint {
            "echo 'DevTools listening on ws://127.0.0.1:9/devtools/browser/fake' >&2"
        } else {
            ""
        };
        std::fs::write(
            &script,
            format!(
                "#!/bin/sh\necho $$ > '{}'\n{}\nexec '{}' -f /dev/null\n",
                pid_file.display(),
                endpoint,
                tail,
            ),
        )
        .unwrap();
        let mut permissions = std::fs::metadata(&script).unwrap().permissions();
        permissions.set_mode(0o755);
        std::fs::set_permissions(&script, permissions).unwrap();
        script
    }

    #[cfg(unix)]
    fn process_is_alive(pid: u32) -> bool {
        std::process::Command::new("kill")
            .args(["-0", &pid.to_string()])
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
            .is_ok_and(|status| status.success())
    }

    #[cfg(unix)]
    async fn assert_process_stops(pid: u32) {
        for _ in 0..100 {
            if !process_is_alive(pid) {
                return;
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
        panic!("fake browser process {pid} was orphaned");
    }

    #[cfg(unix)]
    async fn read_pid(path: &Path) -> u32 {
        for _ in 0..100 {
            if let Ok(raw) = tokio::fs::read_to_string(path).await {
                return raw.trim().parse().unwrap();
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        panic!("fake browser never wrote its pid");
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn browser_process_and_profile_are_removed_on_success_and_timeout() {
        let fixture = tempfile::tempdir().unwrap();
        let geometry = CaptureGeometry {
            width: 100,
            height: 50,
            device_scale_factor: 2.0,
            physical_pixels: 20_000,
        };

        let success_pid_file = fixture.path().join("success.pid");
        let success_script = fake_browser(fixture.path(), &success_pid_file, true);
        let success_profile = tempfile::tempdir().unwrap();
        let success_profile_path = success_profile.path().to_path_buf();
        let deadline = CaptureDeadline::new(Duration::from_secs(1)).unwrap();
        let browser = BrowserProcess::launch_with_profile(
            &success_script,
            success_profile,
            geometry,
            &deadline,
        )
        .await
        .unwrap();
        let success_pid = browser.pid().unwrap();
        browser.shutdown().await.unwrap();
        assert_process_stops(success_pid).await;
        assert!(!success_profile_path.exists());

        let timeout_pid_file = fixture.path().join("timeout.pid");
        let timeout_script = fake_browser(fixture.path(), &timeout_pid_file, false);
        let timeout_profile = tempfile::tempdir().unwrap();
        let timeout_profile_path = timeout_profile.path().to_path_buf();
        let deadline = CaptureDeadline::new(Duration::from_millis(100)).unwrap();
        let error = BrowserProcess::launch_with_profile(
            &timeout_script,
            timeout_profile,
            geometry,
            &deadline,
        )
        .await
        .err()
        .expect("DevTools discovery must time out");
        assert_eq!(error.kind, ErrorKind::DeadlineExceeded);
        let timeout_pid = read_pid(&timeout_pid_file).await;
        assert_process_stops(timeout_pid).await;
        assert!(!timeout_profile_path.exists());
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn simulated_ctrl_c_cancels_without_orphaning_browser_or_profile() {
        let fixture = tempfile::tempdir().unwrap();
        let pid_file = fixture.path().join("cancel.pid");
        let script = fake_browser(fixture.path(), &pid_file, true);
        let profile = tempfile::tempdir().unwrap();
        let profile_path = profile.path().to_path_buf();
        let geometry = CaptureGeometry {
            width: 100,
            height: 50,
            device_scale_factor: 2.0,
            physical_pixels: 20_000,
        };
        let pid = Arc::new(AtomicU32::new(0));
        let operation_pid = Arc::clone(&pid);
        let (ready_tx, ready_rx) = oneshot::channel();
        let operation = async move {
            let deadline = CaptureDeadline::new(Duration::from_secs(2)).unwrap();
            let browser =
                BrowserProcess::launch_with_profile(&script, profile, geometry, &deadline).await?;
            operation_pid.store(browser.pid().unwrap(), Ordering::SeqCst);
            let _ = ready_tx.send(());
            std::future::pending::<Result<(), CliError>>().await
        };
        let interrupt = async move {
            ready_rx
                .await
                .map_err(|_| std::io::Error::other("capture did not start"))?;
            Ok(())
        };
        let error = interruptible_with(operation, interrupt).await.unwrap_err();
        assert_eq!(error.kind, ErrorKind::RejectedCommand);
        let pid = pid.load(Ordering::SeqCst);
        assert_ne!(pid, 0);
        assert_process_stops(pid).await;
        assert!(!profile_path.exists());
    }
}
