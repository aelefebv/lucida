//! The CLI's headless browser driver.
//!
//! One owner for the three things every browser-driving command needs: the
//! headless launch, CDP evaluation against a loaded page, and waiting until the
//! viewer has actually rendered. `viewer screenshot` and `dataset montage`
//! (both its capture pass and its auto-contrast pre-pass) route through here
//! rather than carrying a copy each, and the trace driver joins them as a
//! caller rather than a fourth copy.
//!
//! Viewport and device pixel ratio are [`Viewport`] parameters, not constants
//! baked into the launch: screenshot and montage want scale factor 1 because
//! their DPR is an output-image-size decision, while a workload measurement
//! wants the ratio the defect appears at.

use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::Duration;

use base64::Engine as _;
use futures_util::stream::{SplitSink, SplitStream};
use futures_util::{SinkExt, StreamExt};
use serde_json::{Value, json};
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::net::TcpStream;
use tokio::process::{Child, Command as TokioCommand};
use tokio_tungstenite::tungstenite::protocol::Message;
use tokio_tungstenite::{MaybeTlsStream, WebSocketStream, connect_async};

use crate::credentials::EffectiveToken;
use crate::error::{CliError, ErrorKind};

const PNG_SIGNATURE: &[u8; 8] = b"\x89PNG\r\n\x1a\n";

/// The window a driven page renders into.
///
/// `device_scale_factor` is the page's `devicePixelRatio`: 1 renders one buffer
/// pixel per CSS pixel (what an output image wants), 2 quadruples the pixels
/// the render pipeline must fill (what a retina workload looks like).
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Viewport {
    pub width: u32,
    pub height: u32,
    pub device_scale_factor: f64,
}

impl Viewport {
    pub fn new(width: u32, height: u32, device_scale_factor: f64) -> Self {
        Self {
            width,
            height,
            device_scale_factor,
        }
    }
}

/// Chrome command-line arguments for a headless run in `viewport`, writing its
/// throwaway profile to `user_data_dir`. Split out from the spawn so the launch
/// shape (headless mode, GPU flags, window size) is assertable without a
/// browser on the machine.
fn launch_args(viewport: Viewport, user_data_dir: &Path) -> Vec<String> {
    vec![
        "--headless=new".to_string(),
        "--enable-unsafe-webgpu".to_string(),
        "--ignore-gpu-blocklist".to_string(),
        "--no-first-run".to_string(),
        "--no-default-browser-check".to_string(),
        "--remote-debugging-port=0".to_string(),
        format!("--user-data-dir={}", user_data_dir.display()),
        format!("--window-size={},{}", viewport.width, viewport.height),
        "about:blank".to_string(),
    ]
}

/// `Emulation.setDeviceMetricsOverride` parameters for `viewport`. The device
/// scale factor reaches the page from here, so it is the one place a caller's
/// DPR choice takes effect.
fn device_metrics_params(viewport: Viewport) -> Value {
    json!({
        "width": viewport.width,
        "height": viewport.height,
        "deviceScaleFactor": viewport.device_scale_factor,
        "mobile": false
    })
}

/// A running headless browser with its DevTools endpoint discovered.
///
/// Owns a throwaway profile directory; call [`HeadlessBrowser::close`] to kill
/// the process and remove it. Open as many pages as needed against one launch —
/// each [`Page`] is a fresh CDP target, which is much cheaper than relaunching
/// per URL.
pub struct HeadlessBrowser {
    child: Child,
    user_data_dir: PathBuf,
    endpoint: String,
    viewport: Viewport,
}

impl HeadlessBrowser {
    /// Spawn Chrome headless and wait (up to `wait`) for it to print its
    /// DevTools endpoint. Cleans up the process and profile directory if the
    /// endpoint never arrives.
    pub async fn launch(viewport: Viewport, wait: Duration) -> Result<Self, CliError> {
        let binary = find_browser_binary()?;
        let user_data_dir = chrome_user_data_dir();
        tokio::fs::create_dir_all(&user_data_dir).await?;
        let mut child = TokioCommand::new(&binary)
            .args(launch_args(viewport, &user_data_dir))
            .stderr(Stdio::piped())
            .stdout(Stdio::null())
            .stdin(Stdio::null())
            .spawn()
            .map_err(|error| {
                CliError::new(
                    ErrorKind::Config,
                    format!("failed to launch browser {binary:?}: {error}"),
                )
            })?;

        let discovered = async {
            let stderr = child.stderr.take().ok_or_else(|| {
                CliError::new(
                    ErrorKind::Protocol,
                    "browser stderr was not available for DevTools discovery",
                )
            })?;
            wait_for_devtools_endpoint(stderr, wait).await
        }
        .await;

        match discovered {
            Ok(endpoint) => Ok(Self {
                child,
                user_data_dir,
                endpoint,
                viewport,
            }),
            Err(error) => {
                let _ = child.kill().await;
                let _ = child.wait().await;
                let _ = tokio::fs::remove_dir_all(&user_data_dir).await;
                Err(error)
            }
        }
    }

    /// Load `url` in a fresh target and return once the viewer has rendered.
    ///
    /// Applies the launch viewport's device metrics, attaches `token` as a
    /// bearer header when present, then waits for the document and for the
    /// page's capture-ready signal.
    pub async fn open_page(
        &self,
        url: &str,
        token: Option<&EffectiveToken>,
        wait: Duration,
    ) -> Result<Page, CliError> {
        let mut page = Page::attach(&self.endpoint, wait).await?;
        page.call("Network.enable", json!({}), wait).await?;
        if let Some(token) = token {
            page.call(
                "Network.setExtraHTTPHeaders",
                json!({ "headers": { "Authorization": format!("Bearer {}", token.token) } }),
                wait,
            )
            .await?;
        }
        page.call(
            "Emulation.setDeviceMetricsOverride",
            device_metrics_params(self.viewport),
            wait,
        )
        .await?;
        page.call("Page.enable", json!({}), wait).await?;
        page.call("Page.navigate", json!({ "url": url }), wait)
            .await?;
        page.wait_for_document(wait).await?;
        page.wait_for_capture_ready(wait).await?;
        Ok(page)
    }

    /// Kill the browser and remove its profile directory. Best effort — a
    /// failure to reap is not worth failing a command over.
    pub async fn close(mut self) {
        let _ = self.child.kill().await;
        let _ = self.child.wait().await;
        let _ = tokio::fs::remove_dir_all(&self.user_data_dir).await;
    }
}

/// Launch a headless browser, run `body` against it, and tear it down whatever
/// `body` did. Every caller wants this shape, and the teardown is the part that
/// is easy to forget: a leaked Chrome keeps a throwaway profile on disk.
pub async fn with_browser<F, T>(viewport: Viewport, wait: Duration, body: F) -> Result<T, CliError>
where
    F: AsyncFnOnce(&HeadlessBrowser) -> Result<T, CliError>,
{
    let browser = HeadlessBrowser::launch(viewport, wait).await?;
    let result = body(&browser).await;
    browser.close().await;
    result
}

/// A CDP session attached to one loaded page.
pub struct Page {
    write: SplitSink<WebSocketStream<MaybeTlsStream<TcpStream>>, Message>,
    read: SplitStream<WebSocketStream<MaybeTlsStream<TcpStream>>>,
    next_id: u64,
    session_id: String,
}

impl Page {
    async fn attach(browser_ws_url: &str, wait: Duration) -> Result<Self, CliError> {
        let (socket, _response) = connect_async(browser_ws_url)
            .await
            .map_err(|error| CliError::new(ErrorKind::SessionDisconnect, error.to_string()))?;
        let (write, read) = socket.split();
        let mut page = Self {
            write,
            read,
            next_id: 1,
            session_id: String::new(),
        };

        let created = page
            .send(
                None,
                "Target.createTarget",
                json!({ "url": "about:blank" }),
                wait,
            )
            .await?;
        let target_id = created
            .get("targetId")
            .and_then(|value| value.as_str())
            .ok_or_else(|| CliError::new(ErrorKind::Protocol, "CDP targetId was missing"))?
            .to_string();
        let attached = page
            .send(
                None,
                "Target.attachToTarget",
                json!({ "targetId": target_id, "flatten": true }),
                wait,
            )
            .await?;
        page.session_id = attached
            .get("sessionId")
            .and_then(|value| value.as_str())
            .ok_or_else(|| CliError::new(ErrorKind::Protocol, "CDP sessionId was missing"))?
            .to_string();
        Ok(page)
    }

    /// Send `method` to this page's session and await its reply.
    async fn call(
        &mut self,
        method: &str,
        params: Value,
        wait: Duration,
    ) -> Result<Value, CliError> {
        let session_id = self.session_id.clone();
        self.send(Some(&session_id), method, params, wait).await
    }

    /// Send one CDP request and await the reply carrying its id, skipping the
    /// events that interleave with it. `session_id` is `None` only for the
    /// browser-level calls that set this page up.
    async fn send(
        &mut self,
        session_id: Option<&str>,
        method: &str,
        params: Value,
        wait: Duration,
    ) -> Result<Value, CliError> {
        let request_id = self.next_id;
        self.next_id += 1;
        let mut message = json!({
            "id": request_id,
            "method": method,
            "params": params,
        });
        if let Some(session_id) = session_id {
            message["sessionId"] = json!(session_id);
        }
        self.write
            .send(Message::Text(message.to_string().into()))
            .await
            .map_err(|error| CliError::new(ErrorKind::SessionDisconnect, error.to_string()))?;

        let read = &mut self.read;
        tokio::time::timeout(wait, async {
            while let Some(message) = read.next().await {
                let Message::Text(text) = message.map_err(|error| {
                    CliError::new(ErrorKind::SessionDisconnect, error.to_string())
                })?
                else {
                    continue;
                };
                let value: Value = serde_json::from_str(&text).map_err(|error| {
                    CliError::new(ErrorKind::Protocol, format!("invalid CDP message: {error}"))
                })?;
                if value.get("id").and_then(|value| value.as_u64()) != Some(request_id) {
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
            CliError::new(
                ErrorKind::SessionDisconnect,
                format!(
                    "timed out waiting for CDP {method} after {}s",
                    wait.as_secs()
                ),
            )
        })?
    }

    /// Evaluate `expression` in the page and return its value (JSON `null` when
    /// the expression evaluated to null).
    pub async fn evaluate(&mut self, expression: &str, wait: Duration) -> Result<Value, CliError> {
        Ok(self
            .evaluate_value(expression, wait)
            .await?
            .unwrap_or(Value::Null))
    }

    /// Evaluate `expression` and return its value, `None` when the reply
    /// carried no value at all. The distinction matters to the readiness
    /// probes: an expression that evaluates to null is a page that has not
    /// answered yet and is worth re-polling, while a reply with no value is a
    /// broken evaluation.
    async fn evaluate_value(
        &mut self,
        expression: &str,
        wait: Duration,
    ) -> Result<Option<Value>, CliError> {
        let evaluated = self
            .call(
                "Runtime.evaluate",
                json!({ "expression": expression, "returnByValue": true }),
                wait,
            )
            .await?;
        Ok(evaluated
            .get("result")
            .and_then(|value| value.get("value"))
            .cloned())
    }

    /// Capture the page as a PNG.
    pub async fn screenshot_png(&mut self, wait: Duration) -> Result<Vec<u8>, CliError> {
        let captured = self
            .call(
                "Page.captureScreenshot",
                json!({ "format": "png", "fromSurface": true }),
                wait,
            )
            .await?;
        let data = captured
            .get("data")
            .and_then(|value| value.as_str())
            .ok_or_else(|| CliError::new(ErrorKind::Protocol, "CDP screenshot data was missing"))?;
        let png = base64::engine::general_purpose::STANDARD
            .decode(data)
            .map_err(|error| {
                CliError::new(ErrorKind::Protocol, format!("invalid PNG data: {error}"))
            })?;
        ensure_png_signature(&png)?;
        Ok(png)
    }

    /// Poll until the document is complete and a canvas exists.
    async fn wait_for_document(&mut self, wait: Duration) -> Result<(), CliError> {
        let deadline = tokio::time::Instant::now() + wait;
        loop {
            let ready = self
                .evaluate_value(
                    "document.readyState === 'complete' && !!document.querySelector('canvas')",
                    wait,
                )
                .await?;
            if ready.as_ref().and_then(Value::as_bool).unwrap_or(false) {
                tokio::time::sleep(Duration::from_millis(500)).await;
                return Ok(());
            }
            if tokio::time::Instant::now() >= deadline {
                return Err(CliError::new(
                    ErrorKind::SessionDisconnect,
                    format!(
                        "timed out waiting for viewer canvas after {}s",
                        wait.as_secs()
                    ),
                ));
            }
            tokio::time::sleep(Duration::from_millis(250)).await;
        }
    }

    /// Poll the viewer's capture-ready signal until it reports a rendered
    /// frame, reporting the last probe in the timeout message.
    async fn wait_for_capture_ready(&mut self, wait: Duration) -> Result<(), CliError> {
        let deadline = tokio::time::Instant::now() + wait;
        loop {
            let value = self.evaluate_value(CAPTURE_READY_PROBE, wait).await?;
            let probe = capture_ready_probe_from_value(value.as_ref())?;
            if probe.ready {
                return Ok(());
            }
            if tokio::time::Instant::now() >= deadline {
                let reason = capture_ready_probe_summary(&probe);
                return Err(CliError::new(
                    ErrorKind::SessionDisconnect,
                    format!(
                        "timed out waiting for Lucida viewer render after {}s ({reason})",
                        wait.as_secs()
                    ),
                ));
            }
            tokio::time::sleep(Duration::from_millis(250)).await;
        }
    }
}

fn find_browser_binary() -> Result<String, CliError> {
    if let Some(path) = std::env::var_os("LUCIDA_BROWSER") {
        let path = path.to_string_lossy().to_string();
        if Path::new(&path).exists() {
            return Ok(path);
        }
        return Err(CliError::new(
            ErrorKind::Config,
            format!("LUCIDA_BROWSER points to a missing executable: {path}"),
        ));
    }

    let absolute_candidates = [
        "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
        "/Applications/Chromium.app/Contents/MacOS/Chromium",
        "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
    ];
    for candidate in absolute_candidates {
        if Path::new(candidate).exists() {
            return Ok(candidate.to_string());
        }
    }

    let path_candidates = [
        "google-chrome",
        "google-chrome-stable",
        "chromium",
        "chromium-browser",
        "microsoft-edge",
        "msedge",
    ];
    if let Some(paths) = std::env::var_os("PATH") {
        for dir in std::env::split_paths(&paths) {
            for candidate in path_candidates {
                let executable = dir.join(candidate);
                if executable.is_file() {
                    return Ok(executable.to_string_lossy().to_string());
                }
            }
        }
    }

    Err(CliError::new(
        ErrorKind::Config,
        "could not find Chrome/Chromium; set LUCIDA_BROWSER to a browser executable",
    ))
}

fn chrome_user_data_dir() -> PathBuf {
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_nanos())
        .unwrap_or_default();
    std::env::temp_dir().join(format!("lucida-cli-chrome-{}-{nanos}", std::process::id()))
}

async fn wait_for_devtools_endpoint<R>(stderr: R, wait: Duration) -> Result<String, CliError>
where
    R: tokio::io::AsyncRead + Unpin,
{
    let mut lines = BufReader::new(stderr).lines();
    tokio::time::timeout(wait, async {
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
    .map_err(|_| {
        CliError::new(
            ErrorKind::SessionDisconnect,
            format!(
                "timed out waiting for browser DevTools endpoint after {}s",
                wait.as_secs()
            ),
        )
    })?
}

const CAPTURE_READY_PROBE: &str = r#"(() => {
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

fn capture_ready_probe_from_value(probe: Option<&Value>) -> Result<CaptureReadyProbe, CliError> {
    let probe = probe.ok_or_else(|| {
        CliError::new(
            ErrorKind::Protocol,
            "capture-ready probe result was missing",
        )
    })?;
    Ok(CaptureReadyProbe {
        ready: probe
            .get("ready")
            .and_then(|value| value.as_bool())
            .unwrap_or(false),
        reason: probe
            .get("reason")
            .and_then(|value| value.as_str())
            .unwrap_or("unknown")
            .to_string(),
        frame_count: probe
            .get("frame_count")
            .and_then(|value| value.as_u64())
            .unwrap_or(0),
        dataset_count: probe
            .get("dataset_count")
            .and_then(|value| value.as_u64())
            .unwrap_or(0),
        canvas_width: probe
            .get("canvas_width")
            .and_then(|value| value.as_u64())
            .unwrap_or(0),
        canvas_height: probe
            .get("canvas_height")
            .and_then(|value| value.as_u64())
            .unwrap_or(0),
        mode: probe
            .get("mode")
            .and_then(|value| value.as_str())
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

fn ensure_png_signature(bytes: &[u8]) -> Result<(), CliError> {
    if bytes.starts_with(PNG_SIGNATURE) {
        return Ok(());
    }
    Err(CliError::new(
        ErrorKind::Protocol,
        "CDP screenshot did not return a PNG",
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn launch_args_carry_the_viewport_and_profile_directory() {
        let args = launch_args(Viewport::new(640, 480, 1.0), Path::new("/tmp/profile"));

        assert!(args.contains(&"--headless=new".to_string()));
        assert!(args.contains(&"--window-size=640,480".to_string()));
        assert!(args.contains(&"--user-data-dir=/tmp/profile".to_string()));
        assert_eq!(args.last().map(String::as_str), Some("about:blank"));
    }

    #[test]
    fn device_metrics_carry_the_callers_scale_factor() {
        let one = device_metrics_params(Viewport::new(800, 600, 1.0));
        assert_eq!(one["width"], json!(800));
        assert_eq!(one["height"], json!(600));
        assert_eq!(one["deviceScaleFactor"], json!(1.0));
        assert_eq!(one["mobile"], json!(false));

        let retina = device_metrics_params(Viewport::new(800, 600, 2.0));
        assert_eq!(retina["deviceScaleFactor"], json!(2.0));
    }

    #[test]
    fn capture_ready_probe_parser_distinguishes_ready_and_waiting_results() {
        let ready = capture_ready_probe_from_value(Some(&json!({
            "ready": true,
            "reason": "rendered",
            "frame_count": 12,
            "dataset_count": 1,
            "canvas_width": 512,
            "canvas_height": 512,
            "mode": "2d"
        })))
        .unwrap();
        assert!(ready.ready);
        assert_eq!(ready.reason, "rendered");
        assert_eq!(ready.frame_count, 12);

        let waiting = capture_ready_probe_from_value(Some(&json!({
            "ready": false,
            "reason": "dataset_added_waiting_for_render",
            "frame_count": 0,
            "dataset_count": 1,
            "canvas_width": 512,
            "canvas_height": 512,
            "mode": null
        })))
        .unwrap();
        assert!(!waiting.ready);
        assert_eq!(waiting.mode, None);
        assert!(capture_ready_probe_summary(&waiting).contains("dataset_added_waiting_for_render"));
    }

    /// A reply with no value at all is a broken evaluation, but an expression
    /// that evaluated to null is a page that has not answered yet — the
    /// readiness wait must keep polling rather than abort.
    #[test]
    fn capture_ready_probe_parser_separates_a_missing_reply_from_a_null_one() {
        let error = capture_ready_probe_from_value(None).unwrap_err();
        assert_eq!(error.kind, ErrorKind::Protocol);

        let null_probe = capture_ready_probe_from_value(Some(&Value::Null)).unwrap();
        assert!(!null_probe.ready);
        assert_eq!(null_probe.reason, "unknown");
    }

    #[test]
    fn png_signature_guard_accepts_png_and_rejects_other_bytes() {
        let mut png = Vec::from(PNG_SIGNATURE.as_slice());
        png.extend_from_slice(b"rest");
        ensure_png_signature(&png).unwrap();

        let error = ensure_png_signature(b"not a png").unwrap_err();
        assert_eq!(error.kind, ErrorKind::Protocol);
    }
}
