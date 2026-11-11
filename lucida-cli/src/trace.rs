//! `lucida trace`: an agent measures an open with no human present.
//!
//! The command drives headless Chrome and reads the already-merged trace off
//! the page seam. The server pushes its rows to the browser, so
//! there is no server-side trace endpoint to ask. Thresholds, attribution, the
//! verdict and both renderings are the page's. This module composes the
//! workload, records what only the driver knows, persists the run and prints
//! what it was handed: a verdict computed here would make an agent driving its
//! own browser a second-class citizen.

use std::path::{Path, PathBuf};
use std::time::Duration;

use futures_util::StreamExt;
use lucida_content::ChannelInfo;
use lucida_core::DatasetId;
use lucida_core::camera::{Camera, Framing};
use lucida_core::saved_view::{SavedView, normalize_dataset_url};
use lucida_core::scene::{Colormap, DatasetDisplaySettings, DocumentState, RenderMode, Scene};
use lucida_protocol::codec::ChunkRelayReport;
use lucida_protocol::{
    DatasetSourceCacheStats, DatasetSourceHealth, LinkThrottleReport, SourceThrottleReport,
};
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::browser::{self, Viewport};
use crate::credentials::EffectiveToken;
use crate::error::{CliError, ErrorKind};
use crate::montage::with_render_param;
use crate::session::{connect_workspace_socket, incoming_messages, wait_for_workspace_snapshot};
use crate::trace_knobs::KnobSettings;
use crate::trace_replay::{ReplayRecord, format_replay_block};
use crate::trace_script::{
    Script, ScriptRecord, describe_script, failing_verdict, format_script_human, run_script,
    script_gate_failure,
};

/// The run file's own version, independent of the trace schema it carries.
/// A reader that does not know this number should say so rather than guess.
pub const RUN_FILE_VERSION: u32 = 1;

/// What a bundle file says it is, so `show` can tell it from a run
/// file without guessing from the name.
pub const BUNDLE_FORMAT: &str = "lucida-trace-bundle";

/// The bundle's own version, independent of the trace schema and of the run
/// file version. The page writes it, and this reader refuses any other.
pub const BUNDLE_VERSION: u32 = 1;

/// A representative window rather than a capture cell: the viewport is part of
/// the workload, not an output-image size.
pub const DEFAULT_WIDTH: u32 = 1440;
pub const DEFAULT_HEIGHT: u32 = 900;

/// Device pixel ratio defaults to 2 because that is where the defects this
/// monitor exists to find appear: DPR 2 quadruples the pixels the pipeline
/// must fill, and DPR-1-only verification hides whole defect classes.
pub const DEFAULT_DEVICE_PIXEL_RATIO: f64 = 2.0;

/// Only used when the page is too old to publish one; the page's own value wins.
pub const DEFAULT_QUIESCENCE_HOLD_MS: f64 = 500.0;

const CHROME_TRACE_EXPORT_EXPRESSION: &str =
    "window.lucidaTrace ? window.lucidaTrace.exportChromeTrace() : null";

/// Close a run the driver gave up on as what it was. `explicit` would claim
/// somebody asked for the document; the end reason is the field a later reader
/// trusts about whether the page ever finished.
pub(crate) const CLOSE_AS_TIMEOUT: &str =
    "window.lucidaTrace ? (window.lucidaTrace.closeRun('timeout'), true) : false";

/// Read the frame the waited-for run settled on through the page's own
/// capture, the page's scroll, and where its chrome sits, and record them on
/// that run, where its diagnostic reads them. Done before the export, which
/// is where the diagnostic is derived. A page too old to read any of them is
/// left alone.
const FRAME_READ_EXPRESSION: &str = r#"(async () => {
  const seam = window.lucidaTrace;
  if (!seam || typeof seam.readFrame !== 'function') return null;
  const waited = window.__lucidaTraceRunId || seam.runState.lastConcludedRunId || undefined;
  if (typeof seam.readPageScroll === 'function') seam.readPageScroll(waited);
  if (typeof seam.readChrome === 'function') seam.readChrome(waited);
  return JSON.stringify(await seam.readFrame(waited));
})()"#;

/// Whether a labelled run is open, and how many have closed. Read every poll,
/// and never by exporting — an export closes the run being asked about.
const RUN_STATE_PROBE: &str =
    "window.lucidaTrace ? JSON.stringify(window.lucidaTrace.runState) : null";

/// One evaluation for the whole artifact: the merged document, the diagnostic
/// derived from it, and every rendering of that diagnostic anyone can later
/// ask for. Taking them together keeps them describing one run — a second round
/// trip would export again after the page had moved on — and taking the deeper
/// depths *now* is the only chance to: the browser that can render them is dead
/// by the time the file is read.
const RUN_EXPORT_EXPRESSION: &str = r#"(() => {
  const seam = window.lucidaTrace;
  if (!seam) return null;
  // The run the driver waited for, named before the export closes an interval
  // of its own — "the newest run" would be that empty interval.
  const waited = window.__lucidaTraceRunId || seam.runState.lastConcludedRunId;
  const trace = seam.exportTrace();
  const runs = trace.runs || [];
  const run =
    (waited ? runs.find(r => r.header.runId === waited) : null) ||
    (runs.length > 0 ? runs[runs.length - 1] : null);
  const runId = run ? run.header.runId : null;
  const diagnostic = runId ? seam.diagnose(runId) : null;
  // A page the workload has pushed out of memory can still hand over the
  // document and the diagnostic while a text rendering fails to allocate, so
  // a failed rendering reports itself in place instead of losing the run.
  const render = (make) => {
    try { return make(); } catch (error) { return 'rendering failed: ' + String(error); }
  };
  const perPhase = {};
  // Render a chunk reading now for every chunk the document points at: its
  // own lookup, which the default text's follow-up names, and each browser
  // phase's worst row. The page is gone by the time the file is read, so a
  // chunk not rendered here cannot be read then.
  const chunkSelectors = new Set();
  if (runId && diagnostic) {
    for (const phase of diagnostic.phases || []) {
      perPhase[phase.id] = render(() => seam.diagnoseText(runId, { depth: 'phase', phase: phase.id }));
      if (phase.side === 'browser' && phase.worst && phase.worst.label) chunkSelectors.add(phase.worst.label);
    }
    if (diagnostic.chunk && diagnostic.chunk.selector) chunkSelectors.add(diagnostic.chunk.selector);
  }
  const perChunk = {};
  for (const selector of chunkSelectors) {
    let section = null;
    try { section = seam.diagnose(runId, { chunk: selector }).chunk; } catch (error) { section = null; }
    perChunk[selector] = {
      text: render(() => seam.diagnoseText(runId, { depth: 'chunk', chunk: selector })),
      section
    };
  }
  // Each step that opened a run takes that run's header fields, verdict,
  // lag, load reading and attribution from the document just exported.
  // Filled in place: the bundle export that follows reads the same object.
  const script = window.__lucidaTraceScript || null;
  if (script && Array.isArray(script.steps)) {
    for (const step of script.steps) {
      if (!step.runId) continue;
      const stepRun = runs.find(r => r.header.runId === step.runId);
      if (!stepRun) continue;
      step.cause = stepRun.header.cause || null;
      step.endReason = stepRun.header.endReason || null;
      step.durationUs = typeof stepRun.header.durationUs === 'number' ? stepRun.header.durationUs : null;
      try {
        const stepDiagnostic = seam.diagnoseTrace(trace, { runId: step.runId });
        const verdict = stepDiagnostic.verdict;
        step.verdict = verdict ? { kind: verdict.kind, text: verdict.text } : null;
        step.lag = stepDiagnostic.lag || null;
        step.load = stepDiagnostic.load || null;
        step.attribution = stepDiagnostic.attribution || null;
      } catch (error) {
        step.verdict = { kind: 'unread', text: 'diagnosis failed: ' + String(error) };
      }
    }
  }
  return JSON.stringify({
    schemaVersion: seam.schemaVersion,
    runId,
    quiescenceHoldMs: seam.quiescenceHoldMs,
    endReason: run ? run.header.endReason : null,
    stallReason: run ? (run.header.stallReason || null) : null,
    diagnostic,
    summary: runId ? render(() => seam.diagnoseText(runId)) : null,
    phases: runId ? render(() => seam.diagnoseText(runId, { depth: 'phases' })) : null,
    perPhase,
    spatial: runId ? render(() => seam.diagnoseText(runId, { depth: 'spatial' })) : null,
    perChunk,
    script,
    trace
  });
})()"#;

/// The same export with the run's Perfetto projection alongside it, composed
/// rather than written out twice. Only for a caller who asked for the raw-span
/// file: the projection is megabytes nobody else should pay to move. The
/// projection is taken after the export has closed the run, so both describe
/// the same closed run.
fn run_export_expression(with_chrome_trace: bool) -> String {
    if !with_chrome_trace {
        return RUN_EXPORT_EXPRESSION.to_string();
    }
    format!(
        "(() => {{ const inner = {RUN_EXPORT_EXPRESSION}; if (inner === null) return null; \
         const parsed = JSON.parse(inner); \
         parsed.chromeTrace = window.lucidaTrace.exportChromeTrace(); \
         return JSON.stringify(parsed); }})()"
    )
}

/// One evaluation for the bundle. It calls the page's own bundle
/// function with the run the driver waited for, so the file the driver
/// writes is the file the monitor's **Save bundle** writes. Awaited, because
/// the page asks the server for its health and the render worker for its
/// canvas before it exports.
///
/// The page's own capture is the bundle's frame, as it is for **Send
/// report**: the worker copies the canvas texture from inside a rendered
/// frame. The driver's screenshot rides along as `fallbackFrame`, because it
/// exists even when the render worker never came up, and a page that never
/// drew is the finding. The page carries it only when its own capture
/// fails, and not when its canvas region is one flat colour, since a
/// DevTools screenshot can leave the WebGPU canvas out.
///
/// The script the driver ran, if any, rides along as the run export left it
/// on the page, so the bundle's steps carry the same runs and verdicts the
/// run file's do.
fn bundle_export_expression(fallback_frame: &BundleFrame, perfetto: bool) -> String {
    let frame_json = serde_json::to_string(fallback_frame).unwrap_or_else(|_| "null".to_string());
    format!(
        r#"(async () => {{
  const seam = window.lucidaTrace;
  if (!seam || typeof seam.exportBundle !== 'function') return null;
  const waited = window.__lucidaTraceRunId || seam.runState.lastConcludedRunId || undefined;
  const script = window.__lucidaTraceScript || null;
  const bundle = await seam.exportBundle({{ runId: waited, fallbackFrame: {frame_json}, perfetto: {perfetto}, script }});
  return JSON.stringify(bundle);
}})()"#
    )
}

/// The evaluation behind `show --window`: the run file's own document, handed
/// back to a page's seam for the derivation over one interval, with every
/// rendering this CLI can print taken in the same evaluation, as the driver's
/// export does.
///
/// The file carries the whole-run reading and no other, and a window cannot
/// be rendered at export because there is no finite set of them. So a page
/// derives the reading, where the derivation lives, and this CLI still
/// computes nothing. The page's own recording is never read. The
/// document is the file's, and the run is named so a document holding several
/// reads the one the file is about.
fn window_read_expression(trace: &Value, run_id: Option<&str>, window: WindowRequest) -> String {
    let scope = serde_json::json!({
        "runId": run_id,
        "window": { "startMs": window.start_ms, "endMs": window.end_ms },
    });
    format!(
        r#"(() => {{
  const seam = window.lucidaTrace;
  if (!seam || typeof seam.diagnoseTrace !== 'function') return null;
  const trace = {trace};
  const scope = {scope};
  const render = (make) => {{
    try {{ return make(); }} catch (error) {{ return 'rendering failed: ' + String(error); }}
  }};
  const diagnostic = seam.diagnoseTrace(trace, scope);
  const perPhase = {{}};
  for (const phase of diagnostic.phases || []) {{
    perPhase[phase.id] = render(() => seam.diagnoseTraceText(trace, {{ ...scope, depth: 'phase', phase: phase.id }}));
  }}
  return JSON.stringify({{
    diagnostic,
    summary: render(() => seam.diagnoseTraceText(trace, scope)),
    phases: render(() => seam.diagnoseTraceText(trace, {{ ...scope, depth: 'phases' }})),
    perPhase
  }});
}})()"#
    )
}

/// Whether the page can read a supplied document over a window. Null until
/// the bundle has installed the seam; false on a page older than this flag.
const WINDOWED_SEAM_PROBE: &str =
    "window.lucidaTrace ? (typeof window.lucidaTrace.diagnoseTrace === 'function') : null";

/// Whether the page can compare two supplied documents. Null until
/// the bundle has installed the seam; false on a page older than the diff.
const COMPARE_SEAM_PROBE: &str =
    "window.lucidaTrace ? (typeof window.lucidaTrace.compareTraces === 'function') : null";

/// The evaluation behind `trace diff` and `--versus`: two documents handed
/// to the page's compare function. The subtraction lives behind the seam as
/// the diagnostic does, so this CLI holds no diff of its own: the
/// page derives each side and subtracts, and this CLI hands over the
/// documents and what it alone knows about them, and prints what comes back.
fn compare_read_expression(left: &CompareSide<'_>, right: &CompareSide<'_>) -> String {
    let left_side = serde_json::to_string(&left.side).unwrap_or_else(|_| "{}".to_string());
    let right_side = serde_json::to_string(&right.side).unwrap_or_else(|_| "{}".to_string());
    let left_trace = left.trace;
    let right_trace = right.trace;
    format!(
        r#"(() => {{
  const seam = window.lucidaTrace;
  if (!seam || typeof seam.compareTraces !== 'function') return null;
  const left = {left_side};
  left.trace = {left_trace};
  const right = {right_side};
  right.trace = {right_trace};
  const comparison = seam.compareTraces(left, right);
  let text;
  try {{ text = seam.compareTracesText(left, right); }} catch (error) {{ text = 'rendering failed: ' + String(error); }}
  return JSON.stringify({{ comparison, text }});
}})()"#
    )
}
/// The window the run was driven in, recorded because "cold open of dataset X"
/// is not a reproducible workload without it.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ComposedView {
    /// The dataset as opened, in canonical form.
    pub dataset: String,
    /// The URL the driver navigated to, view fragment and all.
    pub url: String,
    pub width: u32,
    pub height: u32,
    pub device_pixel_ratio: f64,
    /// The memory the page was told the device has, in GiB, when the driver
    /// overrode it. The page fits its memory budgets to it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub device_memory_gib: Option<f64>,
    /// The logical cores the page was told the device has, when the driver
    /// overrode them. The page sizes its decode workers to them.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cores: Option<u32>,
    /// The camera the driver composed, when the caller asked for one rather
    /// than the page's own framing, and the level the core says it calls for.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub camera: Option<ComposedCamera>,
    /// Whether the driver drove the page as a phone: a mobile layout, touch
    /// input, and a mobile user agent.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub mobile: bool,
    /// Whether the driver loaded the full viewer page, chrome and all,
    /// rather than the chrome-free capture surface.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub full_ui: bool,
}

/// The page a run drives at `viewer_url`: the capture surface, or with
/// `full_ui` the full viewer page, which lays its chrome out around the canvas
/// and writes what a person's page writes.
pub fn driven_page_url(viewer_url: &str, full_ui: bool) -> String {
    if full_ui {
        viewer_url.to_string()
    } else {
        with_render_param(viewer_url)
    }
}

/// `--device-memory`: a positive number of GiB.
pub fn parse_device_memory(text: &str) -> Result<f64, String> {
    match text.parse::<f64>() {
        Ok(gib) if gib.is_finite() && gib > 0.0 => Ok(gib),
        _ => Err(format!("{text} is not a positive number of GiB")),
    }
}

/// A script that makes the page read `gib` as the device's memory. It runs
/// before the page's own scripts, which read the memory once at startup.
fn device_memory_script(gib: f64) -> String {
    format!(
        "Object.defineProperty(Navigator.prototype, \"deviceMemory\", {{ get: () => {gib}, configurable: true }});"
    )
}

/// A script that makes the page read `cores` as the device's logical cores.
/// It runs before the page's own scripts, which read them once at startup.
fn cores_script(cores: u32) -> String {
    format!(
        "Object.defineProperty(Navigator.prototype, \"hardwareConcurrency\", {{ get: () => {cores}, configurable: true }});"
    )
}

/// Which camera the driver frames the dataset with: the slice camera of the
/// page's 2D mode, or the orbiting camera of its 3D mode.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, clap::ValueEnum)]
#[serde(rename_all = "lowercase")]
pub enum CameraKind {
    Slice,
    Arcball,
}

impl std::fmt::Display for CameraKind {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(match self {
            CameraKind::Slice => "slice",
            CameraKind::Arcball => "arcball",
        })
    }
}

/// The finest and coarsest level across a dataset's visible image-bearing
/// entities, the shape the trace's per-tick aggregate reports it in.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct LevelRange {
    pub min: u32,
    pub max: u32,
}

/// A camera the driver composed, described by the one number the target
/// level is chosen from.
///
/// Recorded so a reader can hold the page to it: the browser measures the
/// same camera itself and reports its own target on every tick, and the two
/// must agree, or the level rule has two homes after all.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ComposedCamera {
    pub mode: CameraKind,
    /// Device pixels per level-0 sample where the center of the view meets
    /// the data, the measure the target level is chosen from. A slice camera
    /// spaces every sample this far apart; a volume camera measures it where
    /// the center ray meets the volume.
    pub zoom: f64,
    /// The target level lucida-core computes for this camera, across the
    /// dataset's visible image-bearing entities.
    pub target_level: LevelRange,
}

/// What the caller asked the camera to be.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct CameraRequest {
    pub kind: CameraKind,
    /// Device pixels per level-0 sample, or `None` to keep the fit.
    pub zoom: Option<f64>,
}

/// The camera to put in the view, and the record of it for the header.
#[derive(Debug, Clone, PartialEq)]
pub struct ComposedFraming {
    pub camera: Camera,
    pub record: ComposedCamera,
}

/// Display settings the caller pins for the run instead of leaving to the
/// page's defaults. Each is applied to every channel of the dataset.
#[derive(Debug, Clone, Copy, PartialEq, Default)]
pub struct DisplayPins {
    /// The contrast window, `(min, max)`. Pinning it also turns the page's
    /// contrast fit off for the dataset.
    pub contrast: Option<(f64, f64)>,
    pub colormap: Option<Colormap>,
    pub render_mode: Option<RenderMode>,
    /// The level pin. Absent leaves the target following the screen, and a
    /// number holds it at that level however the camera moves.
    pub level: Option<u32>,
}

impl DisplayPins {
    pub fn is_empty(&self) -> bool {
        self.contrast.is_none()
            && self.colormap.is_none()
            && self.render_mode.is_none()
            && self.level.is_none()
    }
}

/// What the *server* already held when the run started.
///
/// A browser-cold open can run against an arbitrarily warm server: a repeat
/// open measured 5.8 s against 0.02 s through the source cache. Without this,
/// two runs are incomparable *and look comparable*, which is worse than being
/// obviously incomparable. Browser-side warmth is the page's own header field
/// and is not restated here.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ServerWarmth {
    /// Whether the server already had this dataset open when the run started.
    pub dataset_open_before_run: bool,
    /// Whether this command opened it on the server to make the run possible.
    /// Recorded rather than hidden: it is the difference between measuring a
    /// server that happened to be warm and one this command warmed.
    #[serde(default)]
    pub opened_by_driver: bool,
    /// The server's source cache for this dataset, when it had one.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source_cache: Option<DatasetSourceCacheStats>,
    /// One line a reader can put beside a duration.
    pub summary: String,
}

impl ServerWarmth {
    /// Record that the driver put the dataset into the workspace itself.
    ///
    /// A dataset that is not a member of the workspace never reaches a scene in
    /// the page, so the composed view has nothing to apply to and the run
    /// measures an empty viewer. Opening it first is what makes a first-time
    /// dataset measurable at all — and it warms the server, which is exactly
    /// the thing this block exists to disclose. The browser stays cold: it is a
    /// fresh profile with an empty cache either way.
    pub fn note_driver_open(&mut self) {
        self.opened_by_driver = true;
        self.summary =
            "server warmed by this command: the dataset was not in the workspace, so the driver \
             opened it before the run (the browser is still cold)"
                .to_string();
    }
}

/// The throttle the server put on its source reads during the run.
///
/// A throttled server makes every source read wait on purpose, so a run
/// measured under one must never read as a run measured without.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SourceThrottleRecord {
    /// The server's settings, absent when it read sources unthrottled.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub settings: Option<SourceThrottleReport>,
    /// One line a reader can put beside a duration.
    pub summary: String,
}

impl SourceThrottleRecord {
    pub fn from_report(settings: Option<SourceThrottleReport>) -> Self {
        let summary = match &settings {
            Some(report) => format!("source reads throttled on the server: {}", report.label()),
            None => "source reads unthrottled".to_string(),
        };
        Self { settings, summary }
    }
}

/// A side's source throttle as the page's comparison reads it.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct CompareThrottle {
    /// The server's settings, null when it read sources unthrottled.
    pub settings: Option<SourceThrottleReport>,
}

/// The throttle the server put on the session socket during the run, which
/// every chunk the page waited for crossed. Recorded for the same reason as
/// [`SourceThrottleRecord`].
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LinkThrottleRecord {
    /// The server's settings, absent when it sent at full speed.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub settings: Option<LinkThrottleReport>,
    /// One line a reader can put beside a duration.
    pub summary: String,
}

impl LinkThrottleRecord {
    pub fn from_report(settings: Option<LinkThrottleReport>) -> Self {
        let summary = match &settings {
            Some(report) => format!("session socket throttled on the server: {}", report.label()),
            None => "session socket unthrottled".to_string(),
        };
        Self { settings, summary }
    }
}

/// A side's link throttle as the page's comparison reads it.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct CompareLinkThrottle {
    /// The server's settings, null when it sent at full speed.
    pub settings: Option<LinkThrottleReport>,
}

/// What only the driver knows. The page's own header carries everything it can
/// observe from inside; this is the rest.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TraceRunHeader {
    pub run_id: Option<String>,
    pub composed_view: ComposedView,
    /// Baked into every duration the run reports, so it travels with them.
    pub quiescence_hold_ms: f64,
    /// Whether `quiescent` ever held for the hold window before the deadline.
    pub settled: bool,
    /// The run's own end reason, read back off the document rather than
    /// asserted here.
    pub end_reason: Option<String>,
    /// What a stalled run waited on, such as `server_pending`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub stall_reason: Option<String>,
    pub server_warmth: ServerWarmth,
    /// The throttle the server put on every source read. Absent from a run
    /// file written before the driver recorded it, which then cannot say.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source_throttle: Option<SourceThrottleRecord>,
    /// The throttle the server put on the session socket. Absent from a run
    /// file written before the driver recorded it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub link_throttle: Option<LinkThrottleRecord>,
    /// Whether the server sent chunks still encoded, and by which setting, as
    /// it answered the driver. The driver and the page it launches connect
    /// from one machine, so the page's connection resolved the same way.
    /// Absent from a run file written before the relay, and from a server
    /// that predates it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub chunk_relay: Option<ChunkRelayReport>,
    pub server_url: String,
    pub workspace_id: String,
    /// The settled frame, when the caller asked for one: a PNG of the page
    /// at the composed view's device pixel ratio, taken after the wait and
    /// before the export. A run that never settled still gets its frame,
    /// because what the page showed at the deadline is part of the finding.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub screenshot: Option<PathBuf>,
    /// The script the driver ran and what each step did, when it ran one.
    /// Absent for the driver's default: an open and nothing after it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub script: Option<ScriptRecord>,
    /// The Dev controls knobs the driver set before the page loaded, by
    /// store field. Absent when it set none, and the run took the page's
    /// defaults: the driver's profile is thrown away with its browser, so
    /// nothing else could have steered the planner.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub knobs: Option<KnobSettings>,
    /// The bundle this run replayed, and which of its header's replay
    /// inputs the driver restored and could not. Absent for a run
    /// the driver composed from the command line.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub replay: Option<ReplayRecord>,
    /// Every error the page and its workers raised during the trace, from
    /// every interval of the document, oldest first, each with the step it
    /// fell in. Absent when there were none.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub errors: Vec<RunError>,
}

/// One error the page or a worker raised, as the run file lists it. The page
/// recorded it, allow list and all. The driver adds only the step, because it
/// alone timed the steps.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RunError {
    /// The interval it was raised in, a run or a steady-state interval, or
    /// None when the page had none open.
    pub interval: Option<String>,
    /// Milliseconds from that interval's start.
    pub at_ms: Option<f64>,
    /// The script step it fell in, counted from 1: the last step that had
    /// begun when it was raised. None when it came before the first step, or
    /// the run had no script.
    pub step: Option<usize>,
    pub source: String,
    pub message: String,
    #[serde(default)]
    pub location: Option<String>,
    /// How many times it was raised: the page folds repeats into one record.
    pub count: u64,
    /// The allow list's reason, when the error is known benign output.
    #[serde(default)]
    pub allowed: Option<String>,
}

/// An error as the trace document records it.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RecordedError {
    at_us: Option<f64>,
    page_ms: f64,
    source: String,
    message: String,
    #[serde(default)]
    location: Option<String>,
    count: u64,
    #[serde(default)]
    allowed: Option<String>,
}

/// Every error in `trace`, from each run, each steady-state interval and
/// outside them all, oldest first. A step's start is on the page's clock, as
/// each error's `pageMs` is, so the step an error fell in is read off the two.
pub fn collect_errors(trace: &Value, script: Option<&ScriptRecord>) -> Vec<RunError> {
    let starts: Vec<f64> = script
        .map(|script| script.steps.iter().map(|step| step.started_at_ms).collect())
        .unwrap_or_default();
    let intervals = ["runs", "steadyState"]
        .into_iter()
        .filter_map(|key| trace.get(key).and_then(Value::as_array))
        .flatten()
        .map(|interval| {
            let id = interval.pointer("/header/runId").and_then(Value::as_str);
            (id.map(str::to_string), interval.get("errors"))
        });
    let outside = std::iter::once((None, trace.get("errorsOutsideRun")));
    let mut errors: Vec<(f64, RunError)> = Vec::new();
    for (interval, recorded) in intervals.chain(outside) {
        for value in recorded.and_then(Value::as_array).into_iter().flatten() {
            let Ok(error) = RecordedError::deserialize(value) else {
                continue;
            };
            let step = starts
                .iter()
                .rposition(|started| *started <= error.page_ms)
                .map(|index| index + 1);
            errors.push((
                error.page_ms,
                RunError {
                    interval: interval.clone(),
                    at_ms: error.at_us.map(|us| (us / 100.0).round() / 10.0),
                    step,
                    source: error.source,
                    message: error.message,
                    location: error.location,
                    count: error.count,
                    allowed: error.allowed,
                },
            ));
        }
    }
    errors.sort_by(|a, b| a.0.total_cmp(&b.0));
    errors.into_iter().map(|(_, error)| error).collect()
}

/// One error on one line: when, what raised it, and what it said.
fn describe_error(error: &RunError) -> String {
    let when = match (error.step, error.at_ms) {
        (Some(step), Some(ms)) => format!("step {step}, {ms} ms into its interval"),
        (Some(step), None) => format!("step {step}"),
        (None, Some(ms)) => format!("before any step, {ms} ms into its interval"),
        (None, None) => "outside every interval".to_string(),
    };
    let times = if error.count > 1 {
        format!(" (x{})", error.count)
    } else {
        String::new()
    };
    let location = error
        .location
        .as_deref()
        .map(|location| format!(" at {location}"))
        .unwrap_or_default();
    format!(
        "{when}: {}: {}{location}{times}",
        error.source, error.message
    )
}

/// Why the page's errors fail the gate, or None when every one it raised is
/// on the allow list. Errors from every interval count, not only the run's:
/// a page that throws while it exports still threw.
fn error_failure(errors: &[RunError]) -> Option<String> {
    const LISTED: usize = 3;
    let failing: Vec<&RunError> = errors
        .iter()
        .filter(|error| error.allowed.is_none())
        .collect();
    if failing.is_empty() {
        return None;
    }
    let total: u64 = failing.iter().map(|error| error.count).sum();
    let listed: Vec<String> = failing
        .iter()
        .take(LISTED)
        .map(|error| describe_error(error))
        .collect();
    let more = if failing.len() > LISTED {
        format!("; +{} more in the run file", failing.len() - LISTED)
    } else {
        String::new()
    };
    Some(format!(
        "the page raised {total} error(s): {}{more}",
        listed.join("; ")
    ))
}

/// The errors block of the default rendering, or nothing when there were none.
fn format_errors(errors: &[RunError]) -> String {
    const LISTED: usize = 5;
    if errors.is_empty() {
        return String::new();
    }
    let allowed = errors
        .iter()
        .filter(|error| error.allowed.is_some())
        .count();
    let allowed = if allowed > 0 {
        format!(", {allowed} on the allow list")
    } else {
        String::new()
    };
    let mut lines = vec![format!("errors    {} raised{allowed}", errors.len())];
    for error in errors.iter().take(LISTED) {
        let reason = error
            .allowed
            .as_deref()
            .map(|why| format!(" [allowed: {why}]"))
            .unwrap_or_default();
        lines.push(format!("          {}{reason}", describe_error(error)));
    }
    if errors.len() > LISTED {
        lines.push(format!(
            "          +{} more in the run file",
            errors.len() - LISTED
        ));
    }
    format!("{}\n", lines.join("\n"))
}

/// Both renderings, taken at export time from the page's one renderer. The
/// browser that produced them is dead by the time anyone reads the file, so a
/// depth that is not captured here is a depth nobody can reach.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TraceRenderings {
    pub summary: String,
    pub phases: String,
    /// One reading per phase, keyed by phase id — the "shape behind X" depth
    /// the default rendering names. Taken at export because the renderer lives
    /// on a page that no longer exists when the file is read.
    #[serde(default)]
    pub per_phase: std::collections::BTreeMap<String, String>,
    /// What is where: rows by state and level with their boxes. Empty on a
    /// file written before the reading existed.
    #[serde(default)]
    pub spatial: String,
    /// One chunk reading per selector the document pointed at: its own
    /// lookup, which the default text's follow-up names, and the worst row of
    /// each browser phase. Any other chunk needs the page, and `render_show`
    /// says so rather than guessing.
    #[serde(default)]
    pub per_chunk: std::collections::BTreeMap<String, ChunkReading>,
}

/// One chunk's reading, in both forms the page renders it: the text, and the
/// document section the text was rendered from, so `--json` describes the
/// same chunk the text does.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChunkReading {
    pub text: String,
    #[serde(default)]
    pub section: Value,
}

impl TraceRenderings {
    /// The page's renderings as it handed them over, with a page that recorded
    /// no run saying so in place of each missing depth.
    fn from_export(
        summary: Option<String>,
        phases: Option<String>,
        per_phase: std::collections::BTreeMap<String, String>,
        spatial: Option<String>,
        per_chunk: std::collections::BTreeMap<String, ChunkReading>,
    ) -> Self {
        Self {
            summary: summary.unwrap_or_else(|| NO_RUN_RECORDED.to_string()),
            phases: phases.unwrap_or_else(|| NO_RUN_RECORDED.to_string()),
            per_phase,
            spatial: spatial.unwrap_or_else(|| NO_RUN_RECORDED.to_string()),
            per_chunk,
        }
    }
}

/// The artifact. The driver kills its browser at teardown, taking the resident
/// buffer with it, so unless the run is persisted the follow-up commands the
/// default rendering prints are unreachable from the path that produced them.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TraceRunFile {
    pub file_version: u32,
    pub header: TraceRunHeader,
    pub renderings: TraceRenderings,
    /// The diagnostic exactly as the page derived it.
    pub diagnostic: Value,
    /// The full trace document the diagnostic was derived from.
    pub trace: Value,
}

/// What the page handed back in one evaluation.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SeamExport {
    run_id: Option<String>,
    quiescence_hold_ms: Option<f64>,
    end_reason: Option<String>,
    #[serde(default)]
    stall_reason: Option<String>,
    diagnostic: Option<Value>,
    summary: Option<String>,
    phases: Option<String>,
    #[serde(default)]
    per_phase: std::collections::BTreeMap<String, String>,
    #[serde(default)]
    spatial: Option<String>,
    #[serde(default)]
    per_chunk: std::collections::BTreeMap<String, ChunkReading>,
    /// Present only when the caller asked for the raw-span file.
    #[serde(default)]
    chrome_trace: Option<String>,
    /// The driver's script with each step's run filled in, when it ran one.
    #[serde(default)]
    script: Option<ScriptRecord>,
    trace: Value,
}

/// A bundle as the page writes it: the trace document, the diagnostic
/// with its renderings, the settled frame, the server's dataset health, and a
/// header sufficient to replay the run. This CLI reads it and adds nothing.
/// The page is the one writer, whichever caller asked.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TraceBundle {
    pub format: String,
    pub bundle_version: u32,
    /// The trace document's schema version.
    pub schema_version: u32,
    pub header: BundleHeader,
    pub renderings: TraceRenderings,
    /// The diagnostic exactly as the page derived it, or null when there was no run.
    pub diagnostic: Value,
    /// The full trace document.
    pub trace: Value,
    #[serde(default)]
    pub frame: Option<BundleFrame>,
    #[serde(default)]
    pub health: Option<BundleHealth>,
    /// Sections the page could not capture, each with its reason.
    #[serde(default)]
    pub absent: Vec<BundleAbsence>,
    /// The Perfetto projection, only when the caller asked for it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub perfetto: Option<String>,
    /// The driver's script and what each step did, when the driver ran one.
    /// Null for a bundle the monitor saved. Replay runs the same steps.
    #[serde(default)]
    pub script: Option<ScriptRecord>,
}

/// The bundle's header. The replay fields are typed where the driver reads
/// them and kept as values where it only carries them.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BundleHeader {
    pub run_id: Option<String>,
    pub cause: Value,
    pub end_reason: Option<String>,
    pub started_at_epoch_ms: Option<f64>,
    pub duration_us: Option<f64>,
    pub quiescence_hold_ms: Option<f64>,
    /// When the bundle was made. The planning configuration and the health were read then.
    pub saved_at_epoch_ms: f64,
    pub datasets: Vec<BundleDataset>,
    /// The page the run happened on, absolute, view fragment and all.
    pub view_url: Option<String>,
    /// The canvas the run drew into, which on the full viewer page is the
    /// page less its chrome.
    pub viewport: Option<BundleViewport>,
    /// The window the page laid out in. None on a bundle older than the field.
    pub page_size: Option<BundlePageSize>,
    pub device_pixel_ratio: Option<f64>,
    /// The memory the page fitted its budgets to, in GiB: what the browser
    /// reported, or the driver's override of it. None when the page read
    /// none, or the bundle is older than the field.
    pub device_memory_gib: Option<f64>,
    /// Whether the run happened on the full viewer page rather than the
    /// capture surface. None when the page recorded no run, or the bundle is
    /// older than the field.
    pub full_ui: Option<bool>,
    /// Whether the browser reported itself as a phone's. None on a bundle
    /// older than the field.
    pub mobile: Option<bool>,
    /// `slice` or `volume`.
    pub mode: Option<String>,
    /// The planning configuration, by the names the Dev controls panel shows.
    pub planning: Value,
    pub pins: Vec<DatasetPins>,
    pub build: Option<BundleBuild>,
    pub gpu: Option<BundleGpu>,
    /// What the browser already held when the run opened.
    pub cache_warmth: Value,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BundleDataset {
    pub id: String,
    pub name: Option<String>,
    /// The canonical source URL, the form `lucida trace <dataset>` takes.
    pub source_url: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BundleViewport {
    pub css_width: f64,
    pub css_height: f64,
    pub device_width: f64,
    pub device_height: f64,
}

/// A window's size in CSS pixels.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BundlePageSize {
    pub css_width: f64,
    pub css_height: f64,
}

/// One dataset's pins in the run's view. Null means the view URL carried
/// nothing for the dataset, not that nothing was pinned.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DatasetPins {
    pub dataset_id: String,
    pub level: Option<u32>,
    pub render_mode: Option<String>,
    /// One window per channel.
    pub contrast: Option<Vec<ContrastWindow>>,
    /// One colormap per channel.
    pub colormap: Option<Vec<String>>,
    pub auto_contrast: Option<bool>,
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct ContrastWindow {
    pub min: f64,
    pub max: f64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct BundleBuild {
    pub version: String,
    pub mode: String,
    pub dev: bool,
}

/// The adapter, as the page's header records it.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BundleGpu {
    pub vendor: String,
    pub architecture: String,
    pub device: String,
    pub description: String,
    /// True for a software fallback, false for hardware, null when the browser said neither.
    pub fallback: Option<bool>,
    pub timestamp_queries: bool,
}

/// The settled frame. The page takes its own through the render worker, from
/// inside a rendered frame, and that is the bundle's frame from any caller.
/// The driver also takes a screenshot over the DevTools protocol, which
/// exists even when the worker never came up, and hands it to the page as
/// the fallback. The page carries it only when its own capture fails, and
/// not when its canvas region is one flat colour, since a screenshot that
/// left the canvas out is not a frame. `captured_by` says which was
/// kept, and `fallback_reason` says why the page's own was not.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BundleFrame {
    /// PNG bytes, base64.
    pub png: String,
    /// Device pixels.
    pub width: u32,
    pub height: u32,
    /// The page's ratio when the frame was taken, or null where no page was there to say.
    pub device_pixel_ratio: Option<f64>,
    /// `page` or `driver`.
    pub captured_by: String,
    /// Why the page's own capture failed, on a frame the driver's screenshot
    /// stood in for. Absent on a frame the page took.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub fallback_reason: Option<String>,
}

impl BundleFrame {
    /// The driver's screenshot, at the ratio the driver drove the page at.
    pub fn from_driver(png: &[u8], viewport: Viewport) -> Self {
        use base64::Engine as _;
        let scale = viewport.device_scale_factor;
        Self {
            png: base64::engine::general_purpose::STANDARD.encode(png),
            width: (f64::from(viewport.width) * scale).round() as u32,
            height: (f64::from(viewport.height) * scale).round() as u32,
            device_pixel_ratio: Some(scale),
            captured_by: "driver".to_string(),
            fallback_reason: None,
        }
    }

    /// The frame without its bytes, for a JSON rendering that should not
    /// carry megabytes of base64 to say a frame exists.
    pub fn describe(&self) -> Value {
        let padding = self
            .png
            .bytes()
            .rev()
            .take_while(|byte| *byte == b'=')
            .count();
        let mut described = serde_json::json!({
            "width": self.width,
            "height": self.height,
            "devicePixelRatio": self.device_pixel_ratio,
            "capturedBy": self.captured_by,
            "pngBytes": self.png.len() / 4 * 3 - padding,
        });
        if let Some(reason) = &self.fallback_reason {
            described["fallbackReason"] = Value::String(reason.clone());
        }
        described
    }
}

/// The server's dataset health when the bundle was made, for the run's
/// datasets, in the same shape `lucida dataset health` reads.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BundleHealth {
    pub fetched_at_epoch_ms: f64,
    pub datasets: Vec<DatasetSourceHealth>,
    /// The throttle the server put on every source read, null when none.
    #[serde(default)]
    pub source_throttle: Option<SourceThrottleReport>,
    /// The throttle the server put on the session socket, null when none.
    #[serde(default)]
    pub link_throttle: Option<LinkThrottleReport>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct BundleAbsence {
    pub section: String,
    pub reason: String,
}

/// One thing the driver needs to replay a bundle, and the header field that
/// carries it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ReplayInput {
    /// The driver's input, in the words the spec uses.
    pub input: &'static str,
    /// The bundle header field that carries it.
    pub field: &'static str,
}

/// What the driver needs from a bundle's header to replay the run,
/// each named by the header field that carries it. The page keeps the same
/// list beside its bundle function, and the golden bundle under
/// `trace-fixtures/` is where a test holds the two to each other.
pub const REPLAY_INPUTS: &[ReplayInput] = &[
    ReplayInput {
        input: "dataset",
        field: "datasets",
    },
    ReplayInput {
        input: "view URL",
        field: "viewUrl",
    },
    ReplayInput {
        input: "viewport",
        field: "viewport",
    },
    ReplayInput {
        input: "page size",
        field: "pageSize",
    },
    ReplayInput {
        input: "device pixel ratio",
        field: "devicePixelRatio",
    },
    ReplayInput {
        input: "device memory",
        field: "deviceMemoryGib",
    },
    ReplayInput {
        input: "full UI",
        field: "fullUi",
    },
    ReplayInput {
        input: "phone emulation",
        field: "mobile",
    },
    ReplayInput {
        input: "slice or volume mode",
        field: "mode",
    },
    ReplayInput {
        input: "planning configuration",
        field: "planning",
    },
    ReplayInput {
        input: "level, render mode, contrast, and colormap pins",
        field: "pins",
    },
    ReplayInput {
        input: "build",
        field: "build",
    },
    ReplayInput {
        input: "adapter",
        field: "gpu",
    },
    ReplayInput {
        input: "cache warmth",
        field: "cacheWarmth",
    },
];

/// The replay inputs a bundle's header does not carry, by the spec's names.
/// Empty for a bundle of a run with a view. A bundle saved from a page that
/// recorded no run lacks most of them, and the text says which.
pub fn missing_replay_inputs(header: &BundleHeader) -> Vec<&'static str> {
    let value = serde_json::to_value(header).unwrap_or(Value::Null);
    REPLAY_INPUTS
        .iter()
        .filter(|input| {
            let field = value.get(input.field).unwrap_or(&Value::Null);
            field.is_null() || field.as_array().is_some_and(Vec::is_empty)
        })
        .map(|input| input.input)
        .collect()
}

/// What a follow-up command reads: the run file the driver writes, or the
/// bundle either entry point writes. One reader, so `show` takes either at
/// every depth. Boxed because both carry a whole trace document.
#[derive(Debug, Clone, PartialEq)]
pub enum TraceArtifact {
    Run(Box<TraceRunFile>),
    Bundle(Box<TraceBundle>),
}

impl TraceArtifact {
    pub fn renderings(&self) -> &TraceRenderings {
        match self {
            TraceArtifact::Run(file) => &file.renderings,
            TraceArtifact::Bundle(bundle) => &bundle.renderings,
        }
    }

    pub fn diagnostic(&self) -> &Value {
        match self {
            TraceArtifact::Run(file) => &file.diagnostic,
            TraceArtifact::Bundle(bundle) => &bundle.diagnostic,
        }
    }

    /// The full trace document either artifact carries.
    pub fn trace(&self) -> &Value {
        match self {
            TraceArtifact::Run(file) => &file.trace,
            TraceArtifact::Bundle(bundle) => &bundle.trace,
        }
    }

    /// The run the artifact is about, when it recorded one.
    pub fn run_id(&self) -> Option<&str> {
        match self {
            TraceArtifact::Run(file) => file.header.run_id.as_deref(),
            TraceArtifact::Bundle(bundle) => bundle.header.run_id.as_deref(),
        }
    }
}

/// Which reading of a persisted run to print.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ShowDepth {
    Summary,
    Phases,
    /// One phase, selected out of the document by id.
    Phase(String),
    /// One chunk, as `[entity/]level/t/c/z/y/x`.
    Chunk(String),
    /// Rows by state and level, with their boxes.
    Spatial,
}

/// An interval of a run's clock, as `show --window` takes it: `START..END`
/// in milliseconds from run start. That is the unit every duration in the
/// text is printed in, and the spelling the text's own follow-up commands use.
#[derive(Debug, Clone, Copy, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WindowRequest {
    pub start_ms: f64,
    pub end_ms: f64,
}

impl std::str::FromStr for WindowRequest {
    type Err = String;

    fn from_str(text: &str) -> Result<Self, Self::Err> {
        let Some((start, end)) = text.split_once("..") else {
            return Err(format!(
                "a window is START..END in milliseconds from run start, not {text:?}"
            ));
        };
        let offset = |part: &str, name: &str| -> Result<f64, String> {
            let value: f64 = part.trim().parse().map_err(|_| {
                format!("the window's {name} {part:?} is not a number of milliseconds")
            })?;
            if !value.is_finite() || value < 0.0 {
                return Err(format!(
                    "the window's {name} must be a finite offset at or after run start, not {part:?}"
                ));
            }
            Ok(value)
        };
        let start_ms = offset(start, "start")?;
        let end_ms = offset(end, "end")?;
        if end_ms <= start_ms {
            return Err(format!("window {text} is empty: END must be after START"));
        }
        Ok(Self { start_ms, end_ms })
    }
}

impl std::fmt::Display for WindowRequest {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}..{}", self.start_ms, self.end_ms)
    }
}

/// What the page hands back for one window: the diagnostic over it and the
/// same renderings a run file carries for the whole run.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct WindowExport {
    diagnostic: Value,
    summary: Option<String>,
    phases: Option<String>,
    #[serde(default)]
    per_phase: std::collections::BTreeMap<String, String>,
}

/// A persisted run read over one interval of its clock.
#[derive(Debug, Clone, PartialEq)]
pub struct WindowedRun {
    pub window: WindowRequest,
    /// The diagnostic exactly as the page derived it over the window.
    pub diagnostic: Value,
    pub renderings: TraceRenderings,
}

fn windowed_run(export: WindowExport, window: WindowRequest) -> WindowedRun {
    WindowedRun {
        window,
        diagnostic: export.diagnostic,
        // A windowed read renders the summary and the phases only; the chunk
        // and spatial depths cannot be asked for beside a window.
        renderings: TraceRenderings::from_export(
            export.summary,
            export.phases,
            export.per_phase,
            None,
            std::collections::BTreeMap::new(),
        ),
    }
}

/// What this CLI knows about one side of a comparison that the trace document
/// does not: which run, how the side is named, and the conditions the
/// driver or the bundle recorded around the run. The page's compare function
/// takes this beside the document.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CompareSideFacts {
    /// The file the side was read from, as the text names it.
    pub label: String,
    pub run_id: Option<String>,
    /// The planning fields known for the run. A bundle carries the whole
    /// configuration. A run file carries the knobs the driver set, and every
    /// other field ran at the page's default, because the driver's profile
    /// starts empty; the page fills those in from its own defaults.
    pub planning: Value,
    /// The CPU cache knobs the driver set, or null for a bundle, whose
    /// header does not carry them.
    pub cache: Value,
    /// Conditions only the driver knows, listed by the diff and never judged.
    pub conditions: Value,
    /// The server's source throttle, or null when the file does not say.
    /// Unlike a condition, a difference here makes the two runs incomparable.
    pub source_throttle: Option<CompareThrottle>,
    /// The server's link throttle, or null when the file does not say, and
    /// judged as the source throttle is.
    pub link_throttle: Option<CompareLinkThrottle>,
}

/// One side as the page is handed it: the document, and the side around it.
#[derive(Debug, Clone, PartialEq)]
pub struct CompareSide<'a> {
    pub trace: &'a Value,
    pub side: CompareSideFacts,
}

impl<'a> CompareSide<'a> {
    pub fn from_artifact(artifact: &'a TraceArtifact, path: &Path) -> Self {
        match artifact {
            TraceArtifact::Run(file) => Self::from_run_file(file, path),
            TraceArtifact::Bundle(bundle) => Self::from_bundle(bundle, path),
        }
    }

    pub fn from_run_file(file: &'a TraceRunFile, path: &Path) -> Self {
        let knobs = file.header.knobs.clone().unwrap_or_default();
        Self {
            trace: &file.trace,
            side: CompareSideFacts {
                label: path.display().to_string(),
                run_id: file.header.run_id.clone(),
                planning: Value::Object(knobs.planning.into_iter().collect()),
                cache: Value::Object(knobs.cache.into_iter().collect()),
                conditions: serde_json::json!({
                    "server warmth": file.header.server_warmth.summary,
                }),
                source_throttle: file.header.source_throttle.as_ref().map(|record| {
                    CompareThrottle {
                        settings: record.settings.clone(),
                    }
                }),
                link_throttle: file.header.link_throttle.as_ref().map(|record| {
                    CompareLinkThrottle {
                        settings: record.settings.clone(),
                    }
                }),
            },
        }
    }

    fn from_bundle(bundle: &'a TraceBundle, path: &Path) -> Self {
        Self {
            trace: &bundle.trace,
            side: CompareSideFacts {
                label: path.display().to_string(),
                run_id: bundle.header.run_id.clone(),
                planning: bundle.header.planning.clone(),
                cache: Value::Null,
                conditions: serde_json::json!({}),
                source_throttle: bundle.health.as_ref().map(|health| CompareThrottle {
                    settings: health.source_throttle.clone(),
                }),
                link_throttle: bundle.health.as_ref().map(|health| CompareLinkThrottle {
                    settings: health.link_throttle.clone(),
                }),
            },
        }
    }
}

/// What the page handed back for a comparison.
#[derive(Debug, Deserialize)]
struct CompareExport {
    comparison: Value,
    text: String,
}

/// Two runs compared, exactly as the page derived it: the document, and the
/// page's text rendering of it.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Comparison {
    pub comparison: Value,
    pub text: String,
}

/// Compare `right` against `left` through the page at `url`.
///
/// As with [`read_window`], a headless page is opened only to reach the
/// derivation: the two files carry whole-run readings of two different runs,
/// and this CLI holds no derivation of its own to subtract with. The page's
/// own recording is never read. Every delta is right minus left, so a
/// baseline on the left and a candidate on the right read as what the
/// candidate changed.
pub async fn read_comparison(
    url: &str,
    token: Option<&EffectiveToken>,
    wait: Duration,
    left: &CompareSide<'_>,
    right: &CompareSide<'_>,
) -> Result<Comparison, CliError> {
    let expression = compare_read_expression(left, right);
    let viewport = Viewport::new(DEFAULT_WIDTH, DEFAULT_HEIGHT, 1.0);
    let json = browser::with_browser(viewport, wait, async |browser| {
        let mut page = browser.open_page_unrendered(url, token, wait).await?;
        wait_for_seam_entry(&mut page, COMPARE_SEAM_PROBE, "compare two documents", wait).await?;
        let value = page.evaluate(&expression, wait).await?;
        value.as_str().map(str::to_string).ok_or_else(|| {
            CliError::new(
                ErrorKind::Protocol,
                "the page did not return a comparison; window.lucidaTrace was missing",
            )
        })
    })
    .await?;
    let export: CompareExport = serde_json::from_str(&json).map_err(|error| {
        CliError::new(
            ErrorKind::Protocol,
            format!("the page returned a comparison this CLI cannot read: {error}"),
        )
    })?;
    Ok(Comparison {
        comparison: export.comparison,
        text: export.text,
    })
}

/// The suffix the second run's files take under `--versus`.
pub const VERSUS_SUFFIX: &str = "versus";

/// `path` with `suffix` inserted before its extension: `run.json` becomes
/// `run.versus.json`, and `frame` becomes `frame.versus`. The second run of
/// a `--versus` pair writes its sidecars here, beside the first's.
pub fn suffixed(path: &Path, suffix: &str) -> PathBuf {
    let Some(name) = path.file_name().and_then(|name| name.to_str()) else {
        return path.to_path_buf();
    };
    let renamed = match name.rsplit_once('.') {
        Some((stem, extension)) if !stem.is_empty() => format!("{stem}.{suffix}.{extension}"),
        _ => format!("{name}.{suffix}"),
    };
    path.with_file_name(renamed)
}

/// One run of a `--versus` pair, for the human rendering.
#[derive(Debug, Clone, Copy)]
pub struct VersusSide<'a> {
    pub file: &'a TraceRunFile,
    pub path: &'a Path,
    pub bundle: Option<&'a Path>,
}

/// The two runs of a `--versus` pair and the page's diff of them. The knobs
/// each ran under lead, because they are the experiment; the diff's own text
/// says which conditions differed besides.
pub fn format_versus_human(first: VersusSide<'_>, second: VersusSide<'_>, text: &str) -> String {
    let side = |name: &str, side: VersusSide<'_>| {
        let knobs = side
            .file
            .header
            .knobs
            .as_ref()
            .map(KnobSettings::describe)
            .filter(|knobs| !knobs.is_empty())
            .unwrap_or_else(|| "the page's defaults".to_string());
        let bundle = side
            .bundle
            .map(|bundle| format!(" · bundle {}", bundle.display()))
            .unwrap_or_default();
        format!("{name:<9} {} · {knobs}{bundle}", side.path.display())
    };
    format!(
        "{}\n{}\n\n{text}\n\nlucida trace diff {} {}   # the same diff again, from the files\n",
        side("left", first),
        side("right", second),
        first.path.display(),
        second.path.display(),
    )
}

/// The view the driver opens: one dataset, nothing else, at the run's viewport.
///
/// Composed rather than borrowed from a viewer profile, because a run has to be
/// reproducible from the command that produced it. The camera is left at the
/// default so the page's own fit-on-open decides the framing, exactly as it
/// would for a person opening the same URL.
///
/// `pin_contrast_for` names the dataset whose contrast limits are to stay at
/// their default rather than being fitted to the data. The fit depends only on
/// the view, so two runs of one view draw alike without the pin.
pub fn compose_dataset_view(
    dataset_url: &str,
    width: u32,
    height: u32,
    pin_contrast_for: Option<&DatasetId>,
) -> SavedView {
    let mut view = SavedView::empty([width, height]);
    view.datasets = vec![normalize_dataset_url(dataset_url)];
    if let Some(dataset_id) = pin_contrast_for {
        view.auto_contrast.insert(dataset_id.clone(), false);
    }
    view
}

/// The workspace's id for the dataset at `dataset_url`, out of a health
/// snapshot, when the workspace holds it. The composed view keys everything
/// it says about a dataset's display and camera on this id.
pub fn dataset_id_for_source(
    dataset_url: &str,
    health: &[DatasetSourceHealth],
) -> Option<DatasetId> {
    health_entry_for(dataset_url, health).map(|dataset| dataset.workspace_dataset_id.clone())
}

/// The workspace's document, read off the connect handshake. The driver
/// needs it to frame a dataset: the fit and the level rule both read the
/// image geometry, which only the document carries.
pub async fn workspace_document(
    ws_url: &str,
    token: Option<&EffectiveToken>,
    wait: Duration,
) -> Result<DocumentState, CliError> {
    let socket = connect_workspace_socket(ws_url, token.map(|token| token.token.as_str())).await?;
    let (_write, read) = socket.split();
    let mut incoming = incoming_messages(read);
    Ok(wait_for_workspace_snapshot(&mut incoming, wait)
        .await?
        .document)
}

/// How many channels the dataset's first image has at level 0, or one when
/// the document does not say. Every display pin is written per channel,
/// because a channel's own settings win over the dataset's.
pub fn channel_count(document: &DocumentState, dataset_id: &DatasetId) -> usize {
    document
        .manifests
        .get(dataset_id)
        .and_then(|manifest| manifest.images().first())
        .and_then(|image| image.multiscale.levels.first())
        .map_or(1, |level| level.shape[1] as usize)
        .max(1)
}

/// A contrast window as the command line gives it: two finite numbers, the
/// second larger than the first.
pub fn contrast_window(values: &[f64]) -> Result<(f64, f64), CliError> {
    match values {
        [min, max] if min.is_finite() && max.is_finite() && min < max => Ok((*min, *max)),
        _ => Err(CliError::config(format!(
            "--contrast takes a window MIN MAX with MIN below MAX, not {values:?}"
        ))),
    }
}

/// Write `pins` into the view for `dataset_id`, on the dataset and on each
/// of its `channel_count` channels, whose metadata is `declared`.
///
/// A pinned window turns the page's contrast fit off for the dataset. The
/// fit samples whatever is resident when it runs, so two runs of one dataset
/// can otherwise draw the same data a level apart, and a frame that is to be
/// read or compared needs the window held still. A channel the pins do not
/// name keeps the colormap the page would have given it.
pub fn pin_display(
    view: &mut SavedView,
    dataset_id: &DatasetId,
    channel_count: usize,
    declared: &[ChannelInfo],
    pins: DisplayPins,
) {
    if pins.is_empty() {
        return;
    }
    let mut settings = DatasetDisplaySettings::default();
    if let Some((min, max)) = pins.contrast {
        settings.contrast_min = min;
        settings.contrast_max = max;
        view.auto_contrast.insert(dataset_id.clone(), false);
    }
    if let Some(render_mode) = pins.render_mode {
        settings.render_mode = render_mode;
    }
    settings.detail_level_override = pins.level;
    if pins.contrast.is_some() || pins.colormap.is_some() {
        let channel_count = channel_count.max(1);
        for index in 0..channel_count {
            let channel = settings.ensure_channel(index, channel_count, declared);
            if let Some(colormap) = pins.colormap {
                channel.colormap = colormap;
            }
            if let Some((min, max)) = pins.contrast {
                channel.contrast_min = min;
                channel.contrast_max = max;
            }
        }
    }
    view.dataset_settings.insert(dataset_id.clone(), settings);
}

/// Frame `dataset_id` in `document` for a viewport of `device_viewport`
/// device pixels, and say what the core makes of that framing.
///
/// The camera starts as the fit the page itself would make for the mode,
/// and then, when a zoom is asked for, moves until the view's center
/// measures exactly that many device pixels per level-0 sample. That is the
/// one number the target level is chosen from, so asking for it directly is
/// what lets a caller name the level they expect the page to reach. The
/// composition runs through `lucida-core`'s own scene, so the recorded
/// target is the rule's answer and not a restatement of it here.
pub fn compose_camera(
    document: &DocumentState,
    dataset_id: &DatasetId,
    device_viewport: [u32; 2],
    request: CameraRequest,
) -> Result<ComposedFraming, CliError> {
    if let Some(zoom) = request.zoom
        && !(zoom.is_finite() && zoom > 0.0)
    {
        return Err(CliError::config(format!(
            "--zoom takes a positive number of device pixels per level-0 sample, not {zoom}"
        )));
    }
    if !document.manifests.contains_key(dataset_id) {
        return Err(CliError::new(
            ErrorKind::MissingResource,
            format!("the workspace does not hold dataset {}", dataset_id.0),
        ));
    }

    let mut scene = Scene::new(device_viewport);
    scene.load_document(document.clone());
    match request.kind {
        CameraKind::Slice => scene.set_mode_2d(),
        CameraKind::Arcball => scene.set_mode_3d(),
    }
    if !scene.fit_camera_to_dataset(&dataset_id.0) {
        return Err(CliError::new(
            ErrorKind::MissingResource,
            format!(
                "dataset {} has no image with a level 0 to frame",
                dataset_id.0
            ),
        ));
    }
    if let Some(zoom) = request.zoom
        && !scene.zoom_to_pixels_per_sample(dataset_id, zoom)
    {
        return Err(CliError::config(format!(
            "cannot place the camera at {zoom} device pixels per level-0 sample of dataset {}",
            dataset_id.0
        )));
    }
    // The driver records the level this exact camera targets, so the page
    // must keep it rather than fit its own.
    scene.active_view_mut().camera.set_framing(Framing::Placed);

    let view = scene.active_view().id();
    let zoom = scene.pixels_per_sample(view, dataset_id).ok_or_else(|| {
        CliError::new(
            ErrorKind::MissingResource,
            format!("dataset {} has no image to measure", dataset_id.0),
        )
    })?;
    let levels: Vec<u32> = scene
        .view_query(view, dataset_id)
        .map(|query| {
            query
                .visible_entities
                .iter()
                .filter(|entity| entity.visible)
                .map(|entity| entity.target_level)
                .collect()
        })
        .unwrap_or_default();
    let (Some(&min), Some(&max)) = (levels.iter().min(), levels.iter().max()) else {
        return Err(CliError::config(format!(
            "the composed camera leaves no image of dataset {} on screen",
            dataset_id.0
        )));
    };

    Ok(ComposedFraming {
        camera: scene.active_view().camera.clone(),
        record: ComposedCamera {
            mode: request.kind,
            zoom,
            target_level: LevelRange { min, max },
        },
    })
}

fn health_entry_for<'a>(
    dataset_url: &str,
    health: &'a [DatasetSourceHealth],
) -> Option<&'a DatasetSourceHealth> {
    let canonical = normalize_dataset_url(dataset_url);
    health.iter().find(|dataset| {
        dataset
            .source_url
            .as_deref()
            .map(|url| normalize_dataset_url(url) == canonical)
            .unwrap_or(false)
    })
}

/// Read the server's warmth for `dataset_url` out of a health snapshot taken
/// before the run.
pub fn summarise_server_warmth(dataset_url: &str, health: &[DatasetSourceHealth]) -> ServerWarmth {
    match health_entry_for(dataset_url, health) {
        None => ServerWarmth {
            dataset_open_before_run: false,
            opened_by_driver: false,
            source_cache: None,
            summary: "server cold for this dataset (not open before the run)".to_string(),
        },
        Some(dataset) => {
            let summary = match &dataset.source_cache {
                Some(cache) => format!(
                    "server warm: dataset already open, {} cache entries, {} hits / {} misses, {} backend reads",
                    cache.entry_count, cache.hits, cache.misses, cache.source_reads
                ),
                None => "server warm: dataset already open, no source cache reported".to_string(),
            };
            ServerWarmth {
                dataset_open_before_run: true,
                opened_by_driver: false,
                source_cache: dataset.source_cache.clone(),
                summary,
            }
        }
    }
}

/// Where runs land: what the caller asked for, or beside the config.
///
/// Beside the config rather than in the working directory, because the
/// follow-up commands take a run id and a run id has to resolve from anywhere.
pub fn resolve_trace_dir(asked_for: Option<&Path>, config_path: &Path) -> PathBuf {
    match asked_for {
        Some(dir) => dir.to_path_buf(),
        None => config_path
            .parent()
            .unwrap_or_else(|| Path::new("."))
            .join("traces"),
    }
}

/// A run's file, named by the id the default rendering prints.
pub fn run_file_path(dir: &Path, run_id: &str) -> PathBuf {
    dir.join(format!("{run_id}.json"))
}

/// Resolve what a follow-up command was given: a run id, or a path to a run
/// file written somewhere else.
pub fn resolve_run_file(dir: &Path, run: &str) -> PathBuf {
    let as_given = Path::new(run);
    if run.contains(std::path::MAIN_SEPARATOR) || as_given.extension().is_some() {
        return as_given.to_path_buf();
    }
    run_file_path(dir, run)
}

/// Read whichever artifact `path` holds. A bundle says what it is in its
/// first field. Anything else is read as a run file, and the run file's own
/// version check then says whether it is one.
pub fn read_artifact(path: &Path) -> Result<TraceArtifact, CliError> {
    let text = read_artifact_text(path)?;
    let format = serde_json::from_str::<Value>(&text)
        .ok()
        .and_then(|value| value.get("format")?.as_str().map(str::to_string));
    if format.as_deref() == Some(BUNDLE_FORMAT) {
        return parse_bundle(&text, path).map(|bundle| TraceArtifact::Bundle(Box::new(bundle)));
    }
    parse_run_file(&text, path).map(|file| TraceArtifact::Run(Box::new(file)))
}

fn read_artifact_text(path: &Path) -> Result<String, CliError> {
    std::fs::read_to_string(path).map_err(|error| {
        CliError::new(
            ErrorKind::MissingResource,
            format!("no trace run at {}: {error}", path.display()),
        )
    })
}

fn parse_bundle(text: &str, path: &Path) -> Result<TraceBundle, CliError> {
    let bundle: TraceBundle = serde_json::from_str(text).map_err(|error| {
        CliError::new(
            ErrorKind::Protocol,
            format!("{} is not a lucida trace bundle: {error}", path.display()),
        )
    })?;
    if bundle.bundle_version != BUNDLE_VERSION {
        return Err(CliError::new(
            ErrorKind::Protocol,
            format!(
                "{} was written by bundle version {}, and this CLI reads version {BUNDLE_VERSION}",
                path.display(),
                bundle.bundle_version
            ),
        ));
    }
    Ok(bundle)
}

fn parse_run_file(text: &str, path: &Path) -> Result<TraceRunFile, CliError> {
    let file: TraceRunFile = serde_json::from_str(text).map_err(|error| {
        CliError::new(
            ErrorKind::Protocol,
            format!("{} is not a lucida trace run file: {error}", path.display()),
        )
    })?;
    if file.file_version != RUN_FILE_VERSION {
        return Err(CliError::new(
            ErrorKind::Protocol,
            format!(
                "{} was written by run file version {}, and this CLI reads version {RUN_FILE_VERSION}",
                path.display(),
                file.file_version
            ),
        ));
    }
    Ok(file)
}

/// Why an opt-in gate should fail, or `None`.
///
/// A failing verdict and a run that never finished are one result in CI, so
/// they share one flag. Coverage never fails a gate: 87% of a healthy local
/// cold open is pre-instrument boot, so a gate that fires on coverage fires on
/// every green run. Nor does a bound verdict: every run spends most of itself
/// somewhere, and the ceilings judge whether that phase was too slow. A
/// steady-state verdict fails: the view settled and the pipeline went on, and
/// a regression there is as much a build failure as a ceiling crossed.
///
/// The gate reads four things: the header's settled flag, the socket outages
/// the document records, the errors the page raised, and the closed run's
/// verdict, which carries a blank settled frame. A run that closed without
/// going quiescent fails before its verdict is consulted, and a provisional
/// reading over an open run carries no verdict, so nothing read while a run
/// was still open can fail a build. Every ceiling, and the allow list of
/// benign errors, live in the page's ruleset, not here.
pub fn gate_failure(file: &TraceRunFile) -> Option<String> {
    if !file.header.settled {
        let ended = file.header.end_reason.as_deref().unwrap_or("no end reason");
        return Some(match file.header.stall_reason.as_deref() {
            Some(reason) => format!("the run never settled ({ended}: {reason})"),
            None => format!("the run never settled ({ended})"),
        });
    }
    if let Some(reason) = socket_outage_failure(&file.trace) {
        return Some(reason);
    }
    if let Some(reason) = error_failure(&file.header.errors) {
        return Some(reason);
    }
    if let Some(kind) = file
        .diagnostic
        .get("verdict")
        .and_then(|verdict| verdict.get("kind"))
        .and_then(Value::as_str)
        && failing_verdict(kind)
    {
        let text = file
            .diagnostic
            .get("verdict")
            .and_then(|verdict| verdict.get("text"))
            .and_then(Value::as_str)
            .unwrap_or("no verdict text");
        return Some(format!("{kind}: {text}"));
    }
    // The file's run is the last step's. Every earlier step's run is read
    // from the record the page filled at export, so a slow orbit fails the
    // gate whether or not a scrub came after it.
    file.header.script.as_ref().and_then(script_gate_failure)
}

/// Why a page that lost its session socket fails the gate, or `None` when it
/// never did.
///
/// A run measured across a lost socket settled on a different pipeline from
/// the one the gate judges: requests in flight were dropped and retried, and
/// the server discarded what it had buffered for the page. The server closes
/// a client that falls too far behind, so the drop is itself the regression.
///
/// Every interval in the document is read, not only the run the driver waited
/// for. The drop is recorded in the interval open when the socket died and
/// the reconnect in the one open when the page got back, and those need not
/// be the waited run.
fn socket_outage_failure(trace: &Value) -> Option<String> {
    let set = |record: &Value, field: &str| record.get(field).is_some_and(|value| !value.is_null());
    let mut drops = 0_usize;
    let mut reconnects = 0_usize;
    let mut closes: Vec<String> = Vec::new();
    let connections = trace
        .get("runs")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|run| run.pointer("/header/connections").and_then(Value::as_array))
        .flatten();
    for connection in connections {
        if set(connection, "closedAtUs") {
            drops += 1;
            if let Some(code) = connection.pointer("/close/code").and_then(Value::as_u64) {
                let reason = connection
                    .pointer("/close/reason")
                    .and_then(Value::as_str)
                    .unwrap_or("");
                let close = format!("{code} {reason}").trim_end().to_string();
                if !closes.contains(&close) {
                    closes.push(close);
                }
            }
        }
        if set(connection, "gapUs") {
            reconnects += 1;
        }
    }
    // A page that never reconnected records a drop and no reconnect, and one
    // whose drop fell outside every recorded interval records only the
    // reconnect, so each outage shows up in at least one of the two counts.
    let outages = drops.max(reconnects);
    if outages == 0 {
        return None;
    }
    let times = if outages == 1 {
        "once".to_string()
    } else {
        format!("{outages} times")
    };
    let closed = if closes.is_empty() {
        String::new()
    } else {
        format!(" (closed {})", closes.join(", "))
    };
    Some(format!(
        "the page lost its session socket {times} during the trace{closed}"
    ))
}

/// The default rendering: the page's own text, under the three things the page
/// could not know about its own run. `bundle` is where the bundle went, when
/// the caller asked for one.
pub fn format_run_human(file: &TraceRunFile, path: &Path, bundle: Option<&Path>) -> String {
    format!(
        "{}\n{}",
        format_run_facts(file, path, bundle),
        file.renderings.summary
    )
}

/// The lines of the default rendering above the page's summary: what the
/// driver knows about the run and where its files went. A replay leads
/// with what it replayed and what it could not restore, because the rest
/// reads differently under those conditions.
pub fn format_run_facts(file: &TraceRunFile, path: &Path, bundle: Option<&Path>) -> String {
    let header = &file.header;
    let view = &header.composed_view;
    let replay = header
        .replay
        .as_ref()
        .map(|record| {
            let steps = header.script.as_ref().map(|script| script.steps.len());
            format!("{}\n", format_replay_block(record, steps))
        })
        .unwrap_or_default();
    let bundle = bundle
        .map(|bundle| format!("bundle    {}\n", bundle.display()))
        .unwrap_or_default();
    let camera = view
        .camera
        .as_ref()
        .map(|camera| {
            format!(
                "camera    {} at {} device px per level-0 sample; the core calls for target level {}\n",
                camera.mode,
                camera.zoom,
                format_level_range(camera.target_level)
            )
        })
        .unwrap_or_default();
    let screenshot = header
        .screenshot
        .as_deref()
        .map(|shot| format!("frame     {}\n", shot.display()))
        .unwrap_or_default();
    let steps = header
        .script
        .as_ref()
        .map(|script| format!("{}\n", format_script_human(script)))
        .unwrap_or_default();
    let source_throttle = header
        .source_throttle
        .as_ref()
        .filter(|record| record.settings.is_some())
        .map(|record| record.summary.as_str());
    let link_throttle = header
        .link_throttle
        .as_ref()
        .filter(|record| record.settings.is_some())
        .map(|record| record.summary.as_str());
    let throttle: String = source_throttle
        .into_iter()
        .chain(link_throttle)
        .map(|summary| format!("throttle  {summary}\n"))
        .collect();
    let knobs = header
        .knobs
        .as_ref()
        .map(|knobs| format!("knobs     {}\n", knobs.describe()))
        .unwrap_or_default();
    let memory = view
        .device_memory_gib
        .map(|gib| format!(" · device memory {gib} GiB"))
        .unwrap_or_default();
    let cores = view
        .cores
        .map(|cores| format!(" · {cores} cores"))
        .unwrap_or_default();
    let phone = if view.mobile { " · phone" } else { "" };
    let full_ui = if view.full_ui { " · full UI" } else { "" };
    let errors = format_errors(&header.errors);
    format!(
        "{replay}\
         view      {} @ {}x{} DPR {}{phone}{full_ui}{memory}{cores}\n\
         {camera}\
         server    {}\n\
         {throttle}\
         hold      quiescent had to hold {} ms; every duration below is measured against that\n\
         {knobs}\
         {steps}\
         {errors}\
         run file  {}\n\
         {bundle}\
         {screenshot}",
        view.dataset,
        view.width,
        view.height,
        view.device_pixel_ratio,
        header.server_warmth.summary,
        header.quiescence_hold_ms,
        path.display(),
    )
}

/// A bundle's header block, above whichever rendering `show` was asked for.
///
/// This is where the health counters and the replay conditions reach the
/// text. The page's renderings are about the run. The bundle's header is
/// about the conditions the run happened under and what the server held at
/// the end. Every line reads a field of the file, and the one line that
/// derives anything, `replay`, only says which replay inputs the header
/// lacks. No verdict or threshold is computed here.
pub fn format_bundle_human(bundle: &TraceBundle, path: &Path, text: &str) -> String {
    let header = &bundle.header;
    let mut lines = vec![format!("bundle    {}", path.display())];
    lines.push(format!(
        "run       {} · ended: {} · saved at epoch ms {}",
        header.run_id.as_deref().unwrap_or("no run recorded"),
        header.end_reason.as_deref().unwrap_or("no end reason"),
        header.saved_at_epoch_ms,
    ));
    for dataset in &header.datasets {
        lines.push(format!(
            "dataset   {} ({}{})",
            dataset
                .source_url
                .as_deref()
                .unwrap_or("source URL unknown"),
            dataset.id,
            dataset
                .name
                .as_deref()
                .map(|name| format!(", {name}"))
                .unwrap_or_default(),
        ));
    }
    if let Some(url) = &header.view_url {
        let viewport = header
            .viewport
            .map(|viewport| format!(" @ {}x{}", viewport.css_width, viewport.css_height))
            .unwrap_or_default();
        let dpr = header
            .device_pixel_ratio
            .map(|dpr| format!(" DPR {dpr}"))
            .unwrap_or_default();
        let memory = header
            .device_memory_gib
            .map(|gib| format!(" · device memory {gib} GiB"))
            .unwrap_or_default();
        let mode = header
            .mode
            .as_deref()
            .map(|mode| format!(" · {mode}"))
            .unwrap_or_default();
        lines.push(format!("view      {url}{viewport}{dpr}{memory}{mode}"));
    }
    for pins in &header.pins {
        lines.push(format!("pins      {}", format_pins(pins)));
    }
    if let Some(script) = &bundle.script {
        lines.push(format!("script    {}", describe_script(script)));
    }
    if let Some(gpu) = &header.gpu {
        lines.push(format!("adapter   {}", describe_adapter(gpu)));
    }
    if let Some(build) = &header.build {
        lines.push(format!("build     {} {}", build.version, build.mode));
    }
    if !header.cache_warmth.is_null() {
        lines.push(format!(
            "warmth    browser held {}",
            format_flat(&header.cache_warmth)
        ));
    }
    if !header.planning.is_null() {
        lines.push(format!("planning  {}", format_flat(&header.planning)));
    }
    match &bundle.health {
        Some(health) => {
            if let Some(throttle) = &health.source_throttle {
                lines.push(format!(
                    "throttle  source reads throttled on the server: {}",
                    throttle.label()
                ));
            }
            if let Some(throttle) = &health.link_throttle {
                lines.push(format!(
                    "throttle  session socket throttled on the server: {}",
                    throttle.label()
                ));
            }
            for entry in &health.datasets {
                lines.push(format!("health    {}", format_health(entry)));
            }
        }
        None => lines.push("health    not in this bundle".to_string()),
    }
    match &bundle.frame {
        Some(frame) => {
            let ratio = frame
                .device_pixel_ratio
                .map(|ratio| format!(" at DPR {ratio}"))
                .unwrap_or_default();
            let stood_in = frame
                .fallback_reason
                .as_deref()
                .map(|reason| format!("; the page's capture failed: {reason}"))
                .unwrap_or_default();
            lines.push(format!(
                "frame     {}x{} PNG{ratio} (captured by {}{stood_in})",
                frame.width, frame.height, frame.captured_by
            ));
        }
        None => lines.push("frame     not in this bundle".to_string()),
    }
    for absence in &bundle.absent {
        lines.push(format!("absent    {}: {}", absence.section, absence.reason));
    }
    if bundle.perfetto.is_some() {
        lines.push("perfetto  projection included".to_string());
    }
    let missing = missing_replay_inputs(header);
    if !missing.is_empty() {
        lines.push(format!(
            "replay    the header lacks: {}",
            missing.join(", ")
        ));
    }
    lines.push(String::new());
    lines.push(text.to_string());
    lines.join("\n")
}

/// The adapter's name: its description, or its vendor and architecture
/// when the browser gave none. The browser gives most adapters an empty
/// description, so the vendor and architecture are the usual name. None
/// when the header names nothing at all. Every reading of a bundle's
/// adapter, the show command's and the inbox listing's alike, names it
/// through this one.
pub fn adapter_name(description: &str, vendor: &str, architecture: &str) -> Option<String> {
    let description = description.trim();
    let name = if description.is_empty() {
        format!("{} {}", vendor.trim(), architecture.trim())
    } else {
        description.to_string()
    };
    let name = name.trim();
    (!name.is_empty()).then(|| name.to_string())
}

/// The adapter in one phrase: its name, and whether it is a software
/// fallback.
pub fn describe_adapter(gpu: &BundleGpu) -> String {
    let name = adapter_name(&gpu.description, &gpu.vendor, &gpu.architecture)
        .unwrap_or_else(|| "unnamed adapter".to_string());
    let fallback = match gpu.fallback {
        Some(true) => "software fallback",
        Some(false) => "hardware adapter",
        None => "fallback status unknown",
    };
    format!("{name} · {fallback}")
}

fn format_pins(pins: &DatasetPins) -> String {
    let level = match pins.level {
        Some(level) => format!("level {level}"),
        None => "level follows the screen".to_string(),
    };
    let render_mode = pins
        .render_mode
        .as_deref()
        .map(|mode| format!(" · {mode}"))
        .unwrap_or_default();
    let contrast = pins
        .contrast
        .as_ref()
        .map(|windows| {
            let windows: Vec<String> = windows
                .iter()
                .map(|window| format!("{}..{}", window.min, window.max))
                .collect();
            format!(" · contrast {}", windows.join(", "))
        })
        .unwrap_or_default();
    let colormap = pins
        .colormap
        .as_ref()
        .map(|names| format!(" · colormap {}", names.join(", ")))
        .unwrap_or_default();
    let auto = match pins.auto_contrast {
        Some(true) => " · auto-contrast on",
        Some(false) => " · auto-contrast off",
        None => "",
    };
    if pins.level.is_none()
        && pins.render_mode.is_none()
        && pins.contrast.is_none()
        && pins.colormap.is_none()
        && pins.auto_contrast.is_none()
    {
        return format!("{}: the view URL carries no pins", pins.dataset_id);
    }
    format!(
        "{}: {level}{render_mode}{contrast}{colormap}{auto}",
        pins.dataset_id
    )
}

/// The counters the field report asks about first: whether the object store
/// was read at all, and what the generated coarse levels have ready.
fn format_health(entry: &DatasetSourceHealth) -> String {
    let cache = entry
        .source_cache
        .as_ref()
        .map(|cache| {
            format!(
                " · source reads {} · cache hits {} · misses {} · evictions {}",
                cache.source_reads, cache.hits, cache.misses, cache.evictions
            )
        })
        .unwrap_or_else(|| " · no source cache".to_string());
    let coarse = &entry.generated_coarse;
    // The status by its wire name, which is what `lucida dataset health` prints.
    let status = serde_json::to_value(entry.status)
        .ok()
        .and_then(|value| value.as_str().map(str::to_string))
        .unwrap_or_else(|| format!("{:?}", entry.status));
    format!(
        "{}: {status}{cache} · generated coarse ready {} · pending {} · failed {}",
        entry.workspace_dataset_id.0,
        coarse.ready_chunks,
        coarse.pending_chunks,
        coarse.failed_chunks
    )
}

/// A flat JSON object on one line, `key value` pairs in the file's order.
fn format_flat(value: &Value) -> String {
    match value.as_object() {
        Some(object) => object
            .iter()
            .map(|(key, value)| format!("{key} {value}"))
            .collect::<Vec<_>>()
            .join(" · "),
        None => value.to_string(),
    }
}

fn format_level_range(range: LevelRange) -> String {
    if range.min == range.max {
        range.min.to_string()
    } else {
        format!("{}..{}", range.min, range.max)
    }
}

/// A depth out of a set of renderings: a run file's, or a windowed reading's.
/// Every depth is the page's rendering verbatim; nothing here derives a number.
/// `Phase` and `Chunk` select a reading the page rendered for that id, and say
/// when the renderings hold none.
pub fn render_depth(renderings: &TraceRenderings, depth: &ShowDepth) -> String {
    match depth {
        ShowDepth::Summary => renderings.summary.clone(),
        ShowDepth::Phases => renderings.phases.clone(),
        ShowDepth::Phase(id) => renderings.per_phase.get(id).cloned().unwrap_or_else(|| {
            format!(
                "phase {id} is not in this run; the run carries: {}",
                renderings
                    .per_phase
                    .keys()
                    .cloned()
                    .collect::<Vec<_>>()
                    .join(", ")
            )
        }),
        ShowDepth::Chunk(selector) => renderings
            .per_chunk
            .get(selector)
            .map(|reading| reading.text.clone())
            .unwrap_or_else(|| format!("these renderings hold no reading for chunk {selector}")),
        ShowDepth::Spatial => {
            if renderings.spatial.is_empty() {
                "this run file carries no spatial reading; it was written before one existed. \
                 Drive the run again to get one."
                    .to_string()
            } else {
                renderings.spatial.clone()
            }
        }
    }
}

/// A depth of a persisted run. The run file's renderings, except that a chunk
/// the file holds no reading for is told apart from a chunk that is not in the
/// run by looking for the row, which is the one thing this side adds.
pub fn render_show(file: &TraceRunFile, depth: &ShowDepth) -> String {
    match depth {
        ShowDepth::Chunk(selector) if !file.renderings.per_chunk.contains_key(selector) => {
            chunk_reading_missing(file, selector)
        }
        _ => render_depth(&file.renderings, depth),
    }
}

/// What to say about a chunk the file holds no reading for. The file holds
/// every row, so it can say whether the chunk is in the run at all. It cannot
/// read the chunk, because the renderer lives on the page and the page is
/// gone, so the message names the seam call that can instead of deriving a
/// reading here.
fn chunk_reading_missing(file: &TraceRunFile, selector: &str) -> String {
    if !run_has_chunk_row(file, selector) {
        return format!("no lifecycle row in this run carries chunk {selector}");
    }
    let carried: Vec<&str> = file
        .renderings
        .per_chunk
        .keys()
        .map(String::as_str)
        .collect();
    let carried = if carried.is_empty() {
        "no chunk".to_string()
    } else {
        carried.join(", ")
    };
    format!(
        "chunk {selector} is in this run, but this run file holds a reading only for: {carried}. \
         The page reads any chunk: window.lucidaTrace.diagnoseText(runId, {{ depth: 'chunk', \
         chunk: '{selector}' }})."
    )
}

/// Whether any lifecycle row of the file's run is the chunk `selector` names,
/// as `level/t/c/z/y/x` or `entity/level/t/c/z/y/x`.
fn run_has_chunk_row(file: &TraceRunFile, selector: &str) -> bool {
    let Some(run_id) = file.header.run_id.as_deref() else {
        return false;
    };
    file.trace
        .get("runs")
        .and_then(Value::as_array)
        .and_then(|runs| {
            runs.iter()
                .find(|run| run["header"]["runId"].as_str() == Some(run_id))
        })
        .and_then(|run| run.get("rows"))
        .and_then(Value::as_array)
        .is_some_and(|rows| {
            rows.iter().any(|row| {
                let key = row["chunkKey"].as_str().unwrap_or_default();
                key == selector
                    || row["entityId"]
                        .as_str()
                        .is_some_and(|entity| format!("{entity}/{key}") == selector)
            })
        })
}

/// The JSON section behind a `Chunk` depth, so `--json` describes the same
/// chunk the text does. None for every other depth, whose section is the
/// document's own.
pub fn chunk_section<'a>(renderings: &'a TraceRenderings, depth: &ShowDepth) -> Option<&'a Value> {
    match depth {
        ShowDepth::Chunk(selector) => renderings
            .per_chunk
            .get(selector)
            .map(|reading| &reading.section),
        _ => None,
    }
}

/// Drive `url` at `viewport`, wait for the page to settle, and take the run.
///
/// The wait is the page's published `quiescent`, held for the page's own hold
/// window. A run that never settles is still closed, still exported and still
/// printed — the most diagnostic sample there is, is a run that never finished,
/// and a driver that emits nothing on it is the wrong tool.
pub async fn drive_run(
    url: &str,
    token: Option<&EffectiveToken>,
    viewport: Viewport,
    wait: Duration,
    facts: &DriverFacts,
    perfetto_path: Option<&str>,
    bundle: Option<&BundleRequest>,
) -> Result<DrivenRun, CliError> {
    // Every artifact comes out of one drive when several are wanted. The
    // default rendering points at Perfetto for raw spans, and a second drive
    // would send the reader to a different run than the one they were reading.
    let export_expression = run_export_expression(perfetto_path.is_some());
    let request = DriveRequest {
        knobs: (!facts.knobs.is_empty()).then_some(&facts.knobs),
        device_memory_gib: facts.composed_view.device_memory_gib,
        cores: facts.composed_view.cores,
        screenshot: facts.screenshot.as_deref(),
        script: (!facts.script.is_empty()).then_some(&facts.script),
    };
    let driven = drive_and_export(
        url,
        token,
        viewport,
        wait,
        &export_expression,
        request,
        bundle,
    )
    .await?;
    let export: SeamExport = serde_json::from_str(&driven.export).map_err(|error| {
        CliError::new(
            ErrorKind::Protocol,
            format!("the page returned a trace this CLI cannot read: {error}"),
        )
    })?;
    if let (Some(path), Some(projection)) = (perfetto_path, export.chrome_trace.as_deref()) {
        write_beside_its_parents(Path::new(path), projection.as_bytes()).await?;
    }
    // Written as the page returned it: the driver adds nothing to a bundle,
    // which is what makes it the same file the monitor saves.
    let mut bundle_path = None;
    if let (Some(request), Some(json)) = (bundle, driven.bundle_json.as_deref()) {
        write_beside_its_parents(&request.path, json.as_bytes()).await?;
        bundle_path = Some(request.path.clone());
    }
    Ok(DrivenRun {
        file: assemble_run_file(export, facts),
        bundle: bundle_path,
    })
}

/// A driven run's file, and where its bundle went when one was asked for.
#[derive(Debug, Clone, PartialEq)]
pub struct DrivenRun {
    pub file: TraceRunFile,
    pub bundle: Option<PathBuf>,
}

/// A bundle the caller asked the drive to write.
#[derive(Debug, Clone, PartialEq)]
pub struct BundleRequest {
    pub path: PathBuf,
    /// Include the Perfetto projection. Off by default.
    pub perfetto: bool,
}

/// What one drive handed back: the run export, and the bundle's JSON when one
/// was asked for.
struct Driven {
    export: String,
    bundle_json: Option<String>,
}

/// What a drive does on the page beyond the export: the knobs it sets before
/// the page loads, the frame it writes, and the script it runs once the open
/// has settled. Nothing, by default.
#[derive(Debug, Clone, Copy, Default)]
struct DriveRequest<'a> {
    knobs: Option<&'a KnobSettings>,
    device_memory_gib: Option<f64>,
    cores: Option<u32>,
    screenshot: Option<&'a Path>,
    script: Option<&'a Script>,
}

/// What runs in the page before its own scripts: the knobs' preference seed and
/// the device overrides, or None when the request has none of them.
fn new_document_script(request: &DriveRequest<'_>) -> Option<String> {
    let parts: Vec<String> = [
        request.device_memory_gib.map(device_memory_script),
        request.cores.map(cores_script),
        request.knobs.and_then(KnobSettings::new_document_script),
    ]
    .into_iter()
    .flatten()
    .collect();
    (!parts.is_empty()).then(|| parts.join("\n"))
}

/// Drive one run and hand back whatever `export` evaluated to.
///
/// The two exports — the document and its Perfetto projection — differ only in
/// that expression, so the launch, the settle wait, the timeout close and the
/// teardown live here once. Readiness is observed rather than demanded: a page
/// that never draws is a run this command still has to report.
///
/// `request.screenshot` is where to write the driver's screenshot of the page
/// after the wait, at the viewport's device pixel ratio. It is taken before
/// the export because the export closes the run: the screenshot is the run's
/// last state. A bundle's frame is the page's own capture of its canvas, and
/// the same screenshot rides along as the fallback for a page whose capture
/// fails, whether or not the caller also wanted it as a file.
///
/// `request.script` runs once the open has settled or been given up on,
/// step by step, each gesture settling before the next. The frame is then
/// the last step's, and the run the export reads is the last step's run.
///
/// `request.knobs` are handed to the page before it loads, as the preferences
/// the Dev controls panel writes, so the run starts under them. They ride a
/// page global rather than browser storage, so a knob set for one run cannot
/// steer the next.
async fn drive_and_export(
    url: &str,
    token: Option<&EffectiveToken>,
    viewport: Viewport,
    wait: Duration,
    export: &str,
    request: DriveRequest<'_>,
    bundle: Option<&BundleRequest>,
) -> Result<Driven, CliError> {
    let screenshot = request.screenshot;
    let seed = new_document_script(&request);
    browser::with_browser(viewport, wait, async |browser| {
        let mut page = match seed.as_deref() {
            Some(script) => {
                browser
                    .open_page_unrendered_with_script(url, token, script, wait)
                    .await?
            }
            None => browser.open_page_unrendered(url, token, wait).await?,
        };
        if !wait_for_settled_run(&mut page, wait).await? {
            page.evaluate(CLOSE_AS_TIMEOUT, wait).await?;
            let closed = read_run_state(&mut page, wait).await?;
            pin_run(&mut page, closed.last_concluded_run_id.as_deref(), wait).await?;
        }
        // A resize step leaves the page at another size, and the frame is
        // taken at the size the page is left at.
        let mut viewport = viewport;
        if let Some(script) = request.script {
            viewport = run_script(&mut page, script, viewport, wait).await?;
        }
        page.evaluate(FRAME_READ_EXPRESSION, wait).await?;
        let mut fallback_frame = None;
        if screenshot.is_some() || bundle.is_some() {
            let png = page.screenshot_png(wait).await?;
            if let Some(path) = screenshot {
                write_beside_its_parents(path, &png).await?;
            }
            fallback_frame = Some(BundleFrame::from_driver(&png, viewport));
        }
        let value = page.evaluate(export, wait).await?;
        let export = value.as_str().map(str::to_string).ok_or_else(|| {
            CliError::new(
                ErrorKind::Protocol,
                "the page did not return a trace; window.lucidaTrace was missing",
            )
        })?;
        // The bundle's document is the run export's plus the empty interval
        // the run export itself closed, so the two files name the same run
        // and differ by that interval and their export times.
        let mut bundle_json = None;
        if let (Some(request), Some(fallback)) = (bundle, fallback_frame.as_ref()) {
            let expression = bundle_export_expression(fallback, request.perfetto);
            let value = page.evaluate(&expression, wait).await?;
            bundle_json = Some(value.as_str().map(str::to_string).ok_or_else(|| {
                CliError::new(
                    ErrorKind::Protocol,
                    "the page did not return a bundle; window.lucidaTrace.exportBundle was missing",
                )
            })?);
        }
        Ok(Driven {
            export,
            bundle_json,
        })
    })
    .await
}

/// Read `file` over `window`, through the page at `url`.
///
/// A headless page is opened purely to reach the derivation: the file
/// carries the whole-run renderings, the browser that made them is gone, and
/// this CLI holds no derivation of its own to scope. Nothing on the page is
/// waited for except the seam, because the page's dataset work is not the
/// subject, and the page's own recording is never read: the document is the
/// file's. A window the derivation refuses (empty once clamped to the run)
/// surfaces as the page's own error.
pub async fn read_window(
    url: &str,
    token: Option<&EffectiveToken>,
    wait: Duration,
    trace: &Value,
    run_id: Option<&str>,
    window: WindowRequest,
) -> Result<WindowedRun, CliError> {
    let expression = window_read_expression(trace, run_id, window);
    let viewport = Viewport::new(DEFAULT_WIDTH, DEFAULT_HEIGHT, 1.0);
    let json = browser::with_browser(viewport, wait, async |browser| {
        let mut page = browser.open_page_unrendered(url, token, wait).await?;
        wait_for_windowed_seam(&mut page, wait).await?;
        let value = page.evaluate(&expression, wait).await?;
        value.as_str().map(str::to_string).ok_or_else(|| {
            CliError::new(
                ErrorKind::Protocol,
                "the page did not return a windowed reading; window.lucidaTrace was missing",
            )
        })
    })
    .await?;
    let export: WindowExport = serde_json::from_str(&json).map_err(|error| {
        CliError::new(
            ErrorKind::Protocol,
            format!("the page returned a windowed reading this CLI cannot read: {error}"),
        )
    })?;
    Ok(windowed_run(export, window))
}

/// Wait for the bundle to install a seam that can read a supplied document.
/// A page still loading is worth waiting for; a page whose seam predates the
/// window flag is not, and says which build is behind.
async fn wait_for_windowed_seam(page: &mut browser::Page, wait: Duration) -> Result<(), CliError> {
    wait_for_seam_entry(
        page,
        WINDOWED_SEAM_PROBE,
        "read a document over a window",
        wait,
    )
    .await
}

/// Wait for the seam to have one entry, by `probe`: null while the page is
/// still loading, false on a page older than the entry, true once it is
/// there. `cannot` names the entry in the error for a page that is too old.
async fn wait_for_seam_entry(
    page: &mut browser::Page,
    probe: &str,
    cannot: &str,
    wait: Duration,
) -> Result<(), CliError> {
    let deadline = tokio::time::Instant::now() + wait;
    loop {
        match page.evaluate(probe, wait).await?.as_bool() {
            Some(true) => return Ok(()),
            Some(false) => {
                return Err(CliError::new(
                    ErrorKind::Protocol,
                    format!(
                        "this page's trace seam cannot {cannot}; the server is running a build \
                         older than this CLI"
                    ),
                ));
            }
            None => {}
        }
        if tokio::time::Instant::now() >= deadline {
            return Err(CliError::new(
                ErrorKind::SessionDisconnect,
                format!(
                    "timed out after {}s waiting for the page's trace seam",
                    wait.as_secs()
                ),
            ));
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
}

/// What the driver knows and the page cannot: the workload it composed, the
/// warmth it found on the server, and which server and workspace those were.
#[derive(Debug, Clone, PartialEq)]
pub struct DriverFacts {
    pub composed_view: ComposedView,
    pub server_warmth: ServerWarmth,
    pub source_throttle: SourceThrottleRecord,
    pub link_throttle: LinkThrottleRecord,
    pub chunk_relay: Option<ChunkRelayReport>,
    pub server_url: String,
    pub workspace_id: String,
    /// Where to write the settled frame, when the caller wants one.
    pub screenshot: Option<PathBuf>,
    /// The steps to run after the open settles. Empty for a cold open alone.
    pub script: Script,
    /// The Dev controls knobs to set before the page loads. Empty for the page's defaults.
    pub knobs: KnobSettings,
    /// The bundle being replayed and what of it was restored, when this run
    /// is a replay. None for a run composed from the command line.
    pub replay: Option<ReplayRecord>,
}

/// Fold what the page returned together with what only the driver knows. Split
/// from the drive so the assembly is assertable without a browser.
fn assemble_run_file(export: SeamExport, facts: &DriverFacts) -> TraceRunFile {
    // The run says whether it settled; the driver does not get an opinion. Its
    // own "quiescent held" observation would call a page that never opened a
    // run settled, because an idle page trivially satisfies the predicate.
    let settled = export.end_reason.as_deref() == Some("quiescent");
    let errors = collect_errors(&export.trace, export.script.as_ref());
    TraceRunFile {
        file_version: RUN_FILE_VERSION,
        header: TraceRunHeader {
            run_id: export.run_id,
            composed_view: facts.composed_view.clone(),
            quiescence_hold_ms: export
                .quiescence_hold_ms
                .unwrap_or(DEFAULT_QUIESCENCE_HOLD_MS),
            settled,
            end_reason: export.end_reason,
            stall_reason: export.stall_reason,
            server_warmth: facts.server_warmth.clone(),
            source_throttle: Some(facts.source_throttle.clone()),
            link_throttle: Some(facts.link_throttle.clone()),
            chunk_relay: facts.chunk_relay,
            server_url: facts.server_url.clone(),
            workspace_id: facts.workspace_id.clone(),
            screenshot: facts.screenshot.clone(),
            script: export.script,
            knobs: (!facts.knobs.is_empty()).then(|| facts.knobs.clone()),
            replay: facts.replay.clone(),
            errors,
        },
        renderings: TraceRenderings::from_export(
            export.summary,
            export.phases,
            export.per_phase,
            export.spatial,
            export.per_chunk,
        ),
        diagnostic: export.diagnostic.unwrap_or(Value::Null),
        trace: export.trace,
    }
}

/// What the renderings say when the page recorded no run at all. Not an error:
/// a driven page that never opened a run is itself the finding.
const NO_RUN_RECORDED: &str =
    "no run was recorded — the page never opened one, so there is nothing to read.";

/// Write `file` and return where it went.
pub async fn write_run_file(
    file: &TraceRunFile,
    dir: &Path,
    explicit_path: Option<&str>,
) -> Result<PathBuf, CliError> {
    let path = match explicit_path {
        Some(path) => PathBuf::from(path),
        None => run_file_path(
            dir,
            file.header
                .run_id
                .as_deref()
                .unwrap_or("run-with-no-recorded-id"),
        ),
    };
    write_beside_its_parents(&path, &serde_json::to_vec(file)?).await?;
    Ok(path)
}

/// Wait until the page has closed a run, and let it decide when that is.
///
/// Settled is the page's call: it publishes `quiescent`, holds it for its own
/// hold window, and closes the run itself. The driver waits for a *closed run*
/// rather than the boolean, because the boolean alone fails silently:
///
/// - Before a run opens the predicate is trivially true, so a cold remote open
///   reads as settled while the page is still shaking hands.
/// - Exporting on the first `true` pre-empts the page's own close, so every
///   run lands as `explicit`.
/// - A page torn down and rebuilt, as a development bundle is on every mount,
///   hands back a sub-millisecond run closed `explicit`.
///
/// So the wait is for a run that concluded on its own, by settling or by
/// timing out. Returns whether one did inside the deadline; the run's own end
/// reason says how.
async fn wait_for_settled_run(page: &mut browser::Page, wait: Duration) -> Result<bool, CliError> {
    let deadline = tokio::time::Instant::now() + wait;
    let concluded_before = read_run_state(page, wait).await?.concluded;
    let mut timeout_set = false;

    loop {
        if !timeout_set {
            timeout_set = set_run_timeout(page, wait).await?;
        }
        let state = read_run_state(page, wait).await?;
        if state.concluded > concluded_before {
            pin_run(page, state.last_concluded_run_id.as_deref(), wait).await?;
            return Ok(true);
        }
        if tokio::time::Instant::now() >= deadline {
            return Ok(false);
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
}

/// Give the page the driver's own deadline as its run timeout, so a run the
/// driver is still waiting on is not closed by the page's shorter default.
/// False until the seam is there; a page too old to take it ignores the
/// assignment and keeps its own.
async fn set_run_timeout(page: &mut browser::Page, wait: Duration) -> Result<bool, CliError> {
    let value = page.evaluate(&run_timeout_expression(wait), wait).await?;
    Ok(value.as_bool().unwrap_or(false))
}

fn run_timeout_expression(wait: Duration) -> String {
    format!(
        "window.lucidaTrace ? (window.lucidaTrace.runTimeoutMs = {}, true) : false",
        wait.as_millis()
    )
}

/// Leave the waited-for run's id on the page for the export to read.
///
/// A page can carry several runs — a workspace reload opens one, a later
/// dirty epoch opens another — so the export has to name the one the wait
/// observed rather than take the last in the list.
pub(crate) async fn pin_run(
    page: &mut browser::Page,
    run_id: Option<&str>,
    wait: Duration,
) -> Result<(), CliError> {
    let Some(run_id) = run_id else { return Ok(()) };
    page.evaluate(
        &format!(
            "(window.__lucidaTraceRunId = {}, true)",
            json_string(run_id)
        ),
        wait,
    )
    .await?;
    Ok(())
}

/// A JS string literal for `value`, quoted by the JSON encoder rather than by
/// hand — a run id reaches this from the page, and hand-quoting is how an
/// injected expression happens.
pub(crate) fn json_string(value: &str) -> String {
    Value::String(value.to_string()).to_string()
}

/// The page's run state, or a no-run stand-in when the seam is not there yet —
/// a page still loading its bundle is a page worth waiting for, not a failure.
async fn read_run_state(page: &mut browser::Page, wait: Duration) -> Result<RunState, CliError> {
    let value = page.evaluate(RUN_STATE_PROBE, wait).await?;
    let Some(json) = value.as_str() else {
        return Ok(RunState {
            open: false,
            concluded: 0,
            last_concluded_run_id: None,
        });
    };
    serde_json::from_str(json).map_err(|error| {
        CliError::new(
            ErrorKind::Protocol,
            format!("the page returned a run state this CLI cannot read: {error}"),
        )
    })
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RunState {
    /// Whether a labelled run is open. The script loop reads it to tell an
    /// input that opened a run from one that landed on nothing.
    pub(crate) open: bool,
    pub(crate) concluded: u64,
    /// The run the wait was waiting for. Named to the export, because the
    /// export closes an interval of its own and "newest" would be that one.
    #[serde(default)]
    pub(crate) last_concluded_run_id: Option<String>,
}

/// A Chrome Trace Event capture, summarised from the file it just wrote.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct ChromeTraceCapture {
    /// Whether the run ended by settling. Recorded rather than enforced: the
    /// run that never settles is still exported.
    pub settled: bool,
    /// The run's own end reason, when the projection carried one.
    pub end_reason: Option<String>,
    pub events: usize,
    pub bytes: usize,
    /// Repeated from the file's own header, so the surface says what the
    /// artifact says rather than asserting a cleanliness of its own.
    pub synthetic_values: Vec<String>,
    pub derived_values: Vec<String>,
}

/// Drive `url`, wait for the page to settle, and write its trace projected as
/// Chrome Trace Event JSON.
///
/// The projection lives on the page, behind the same export seam, so no surface
/// carries a privately shaped copy of the trace.
pub async fn capture_chrome_trace(
    url: &str,
    token: Option<&EffectiveToken>,
    output_path: &str,
    viewport: Viewport,
    wait: Duration,
) -> Result<ChromeTraceCapture, CliError> {
    let json = drive_and_export(
        url,
        token,
        viewport,
        wait,
        CHROME_TRACE_EXPORT_EXPRESSION,
        DriveRequest::default(),
        None,
    )
    .await?
    .export;
    write_beside_its_parents(Path::new(output_path), json.as_bytes()).await?;
    summarise_chrome_trace(&json, chrome_trace_end_reason(&json))
}

/// The end reason the projection carries in its own header, so the surface
/// reports what the file says rather than what the driver guessed.
fn chrome_trace_end_reason(json: &str) -> Option<String> {
    serde_json::from_str::<Value>(json)
        .ok()?
        .get("otherData")?
        .get("runs")?
        .as_array()?
        .last()?
        .get("endReason")?
        .as_str()
        .map(str::to_string)
}

/// Write `bytes` to `path`, making the directory the caller named.
async fn write_beside_its_parents(path: &Path, bytes: &[u8]) -> Result<(), CliError> {
    if let Some(parent) = path.parent()
        && !parent.as_os_str().is_empty()
    {
        tokio::fs::create_dir_all(parent).await?;
    }
    tokio::fs::write(path, bytes).await?;
    Ok(())
}

/// Read back what the file says about itself, rather than restating it.
fn summarise_chrome_trace(
    json: &str,
    end_reason: Option<String>,
) -> Result<ChromeTraceCapture, CliError> {
    let settled = end_reason.as_deref() == Some("quiescent");
    let parsed: Value = serde_json::from_str(json).map_err(|error| {
        CliError::new(
            ErrorKind::Protocol,
            format!("the page returned a trace that is not JSON: {error}"),
        )
    })?;
    Ok(ChromeTraceCapture {
        settled,
        end_reason,
        events: parsed
            .get("traceEvents")
            .and_then(|value| value.as_array())
            .map(Vec::len)
            .unwrap_or(0),
        bytes: json.len(),
        synthetic_values: other_data_strings(&parsed, "syntheticValues"),
        derived_values: other_data_strings(&parsed, "derivedValues"),
    })
}

fn other_data_strings(parsed: &Value, key: &str) -> Vec<String> {
    parsed
        .get("otherData")
        .and_then(|value| value.get(key))
        .and_then(|value| value.as_array())
        .map(|values| {
            values
                .iter()
                .filter_map(|value| value.as_str().map(str::to_string))
                .collect()
        })
        .unwrap_or_default()
}

/// The human rendering: a path, not rows. Perfetto is the raw-span surface;
/// this command's job is to hand it a file and say what the file is.
pub fn format_chrome_trace_human(output_path: &str, capture: &ChromeTraceCapture) -> String {
    let mut human = format!(
        "Wrote Chrome Trace Event JSON: {output_path}\n\
         {} events, {} bytes. Open it at https://ui.perfetto.dev (File → Open trace file).",
        capture.events, capture.bytes
    );
    if capture.end_reason.as_deref() == Some("stalled") {
        human.push_str(
            "\nThe view stopped making progress without settling; the run was closed as stalled.",
        );
    } else if !capture.settled {
        human.push_str(
            "\nThe page never published quiescent before the deadline; the run was closed as a timeout.",
        );
    }
    if capture.synthetic_values.is_empty() {
        human.push_str("\nConstructed rather than measured: nothing.");
    } else {
        for value in &capture.synthetic_values {
            human.push_str(&format!("\nConstructed, not measured: {value}"));
        }
    }
    for value in &capture.derived_values {
        human.push_str(&format!("\nDerived at export: {value}"));
    }
    human
}

#[cfg(test)]
mod tests {
    use super::*;
    use lucida_protocol::{DatasetHealthComponent, DatasetHealthStatus};
    use serde_json::json;
    use std::collections::BTreeMap;

    fn composed() -> ComposedView {
        ComposedView {
            dataset: "gs://bucket/set.zarr".to_string(),
            url: "http://host/w/ws?render=1#view=ABC".to_string(),
            width: DEFAULT_WIDTH,
            height: DEFAULT_HEIGHT,
            device_pixel_ratio: DEFAULT_DEVICE_PIXEL_RATIO,
            device_memory_gib: None,
            cores: None,
            camera: None,
            mobile: false,
            full_ui: false,
        }
    }

    fn cold() -> ServerWarmth {
        ServerWarmth {
            dataset_open_before_run: false,
            opened_by_driver: false,
            source_cache: None,
            summary: "server cold for this dataset (not open before the run)".to_string(),
        }
    }

    fn facts() -> DriverFacts {
        DriverFacts {
            composed_view: composed(),
            server_warmth: cold(),
            source_throttle: SourceThrottleRecord::from_report(None),
            link_throttle: LinkThrottleRecord::from_report(None),
            chunk_relay: None,
            server_url: "http://host".to_string(),
            workspace_id: "ws".to_string(),
            screenshot: None,
            script: Script::default(),
            knobs: KnobSettings::default(),
            replay: None,
        }
    }

    fn run_file(diagnostic: Value, settled: bool, end_reason: &str) -> TraceRunFile {
        TraceRunFile {
            file_version: RUN_FILE_VERSION,
            header: TraceRunHeader {
                run_id: Some("run-1-1".to_string()),
                composed_view: composed(),
                quiescence_hold_ms: 500.0,
                settled,
                end_reason: Some(end_reason.to_string()),
                stall_reason: None,
                server_warmth: cold(),
                source_throttle: Some(SourceThrottleRecord::from_report(None)),
                link_throttle: Some(LinkThrottleRecord::from_report(None)),
                chunk_relay: None,
                server_url: "http://host".to_string(),
                workspace_id: "ws".to_string(),
                screenshot: None,
                script: None,
                knobs: None,
                replay: None,
                errors: Vec::new(),
            },
            renderings: TraceRenderings {
                summary: "lucida trace run-1-1 — VERDICT: clear".to_string(),
                phases: "CRITICAL PATH\nRULESET v3".to_string(),
                per_phase: BTreeMap::from([(
                    "browser.wire".to_string(),
                    "PHASE     browser.wire\nFINDINGS  none against browser.wire.".to_string(),
                )]),
                spatial: "SPATIAL   120 rows · 1 group(s) · 1 level(s)".to_string(),
                per_chunk: BTreeMap::from([(
                    "member-7/1/0/0/0/119/0".to_string(),
                    ChunkReading {
                        text: "CHUNK     member-7/1/0/0/0/119/0 — the row that spent longest in browser.wire"
                            .to_string(),
                        section: json!({ "selector": "member-7/1/0/0/0/119/0", "rowCount": 1 }),
                    },
                )]),
            },
            diagnostic,
            trace: json!({ "runs": [] }),
        }
    }

    fn health_entry(
        source_url: &str,
        cache: Option<DatasetSourceCacheStats>,
    ) -> DatasetSourceHealth {
        DatasetSourceHealth {
            workspace_dataset_id: lucida_core::DatasetId("ds".to_string()),
            name: "set".to_string(),
            status: DatasetHealthStatus::Healthy,
            source_url: Some(source_url.to_string()),
            backend: None,
            binding: DatasetHealthComponent {
                status: DatasetHealthStatus::Healthy,
                message: None,
            },
            source_cache: cache,
            generated_coarse: lucida_protocol::DatasetGeneratedCoarseHealth {
                status: lucida_protocol::DatasetHealthStatus::Healthy,
                level_count: 0,
                ready_chunks: 0,
                pending_chunks: 0,
                failed_chunks: 0,
                unavailable_chunks: 0,
                message: None,
                cache: None,
                recent_failures: Vec::new(),
            },
            messages: Vec::new(),
            import_warnings: Vec::new(),
        }
    }

    fn cache_stats() -> DatasetSourceCacheStats {
        DatasetSourceCacheStats {
            max_bytes: 1024,
            current_bytes: 128,
            used_percent: 12,
            entry_count: 4,
            hits: 9,
            misses: 3,
            evictions: 0,
            backend_errors: 0,
            absent_reads: 0,
            source_reads: 12,
            source_read_millis: 1,
        }
    }

    /// The workload is the command's, not a viewer profile's: one dataset in
    /// canonical form, at the run's viewport, and no camera of its own.
    #[test]
    fn the_composed_view_carries_the_canonical_dataset_and_nothing_else() {
        let view = compose_dataset_view("GS://Bucket/set.zarr", 1440, 900, None);
        assert_eq!(view.datasets, vec!["gs://Bucket/set.zarr".to_string()]);
        assert!(view.dataset_order.is_empty());
        assert!(view.active_layouts.is_empty());
        assert!(view.auto_contrast.is_empty());
    }

    #[test]
    fn the_composed_view_pins_the_contrast_window_only_when_asked() {
        let id = DatasetId("wds-1".to_string());
        let view = compose_dataset_view("gs://bucket/set.zarr", 1440, 900, Some(&id));
        assert_eq!(view.auto_contrast.get(&id), Some(&false));
        assert_eq!(view.auto_contrast.len(), 1);
        assert_eq!(
            view.dataset_settings.len(),
            0,
            "the window itself stays the default"
        );
    }

    /// The pin is keyed on the workspace's dataset id, which only the health
    /// snapshot or the driver's own open knows.
    #[test]
    fn the_dataset_id_comes_from_the_health_entry_for_the_canonical_url() {
        let health = vec![health_entry("gs://bucket/set.zarr", None)];
        assert_eq!(
            dataset_id_for_source("GS://bucket/set.zarr", &health),
            Some(DatasetId("ds".to_string()))
        );
        assert_eq!(
            dataset_id_for_source("gs://bucket/other.zarr", &health),
            None
        );
    }

    /// A browser-cold open can run against an arbitrarily warm server, so the
    /// two cases have to be distinguishable in the header.
    #[test]
    fn server_warmth_separates_a_dataset_the_server_already_had_from_one_it_did_not() {
        let health = vec![health_entry("gs://bucket/set.zarr", Some(cache_stats()))];

        let warm = summarise_server_warmth("gs://bucket/set.zarr", &health);
        assert!(warm.dataset_open_before_run);
        assert_eq!(warm.source_cache.as_ref().map(|cache| cache.hits), Some(9));
        assert!(warm.summary.contains("server warm"));
        assert!(warm.summary.contains("12 backend reads"));

        let cold = summarise_server_warmth("gs://bucket/other.zarr", &health);
        assert!(!cold.dataset_open_before_run);
        assert!(cold.source_cache.is_none());
        assert!(cold.summary.contains("cold"));
    }

    /// A dataset the workspace does not have yet cannot reach a scene, so the
    /// driver opens it — and says so, because that warms the server it is about
    /// to measure against.
    #[test]
    fn a_driver_opened_dataset_says_so_in_the_warmth_it_reports() {
        let mut warmth = summarise_server_warmth("gs://bucket/set.zarr", &[]);
        assert!(!warmth.opened_by_driver);
        warmth.note_driver_open();

        assert!(warmth.opened_by_driver);
        assert!(!warmth.dataset_open_before_run);
        assert!(warmth.summary.contains("driver opened it before the run"));
        assert!(warmth.summary.contains("browser is still cold"));
    }

    /// Spelling is not warmth: the same dataset typed two legal ways is one
    /// dataset, and matching raw strings would report a warm server as cold.
    #[test]
    fn server_warmth_matches_across_canonical_spellings() {
        let health = vec![health_entry("file:///C:/data/set.zarr", None)];
        let warmth = summarise_server_warmth("c:\\data\\set.zarr", &health);
        assert!(warmth.dataset_open_before_run);
    }

    #[test]
    fn the_gate_fails_on_a_failing_verdict_and_on_a_run_that_never_settled() {
        let failed = run_file(
            json!({ "verdict": { "kind": "fail", "text": "browser.wire ran p95 1600 ms" } }),
            true,
            "quiescent",
        );
        assert_eq!(
            gate_failure(&failed).as_deref(),
            Some("fail: browser.wire ran p95 1600 ms")
        );

        // A page whose ruleset predates `fail` calls the same finding `stall`.
        let older = run_file(
            json!({ "verdict": { "kind": "stall", "text": "browser.wire ran p95 1600 ms" } }),
            true,
            "quiescent",
        );
        assert!(gate_failure(&older).unwrap().contains("browser.wire"));

        let unsettled = run_file(
            json!({ "verdict": { "kind": "clear", "text": "nothing crossed a threshold" } }),
            false,
            "timeout",
        );
        assert!(gate_failure(&unsettled).unwrap().contains("never settled"));
    }

    /// The page's diagnostic reads the page's scroll into a failure, so the
    /// gate fails a run that settled clear in every phase on a page that
    /// overflows its viewport.
    #[test]
    fn the_gate_fails_a_page_that_overflows_its_viewport() {
        let overflowing = run_file(
            json!({
                "verdict": {
                    "kind": "fail",
                    "text": "its document is 390x924 CSS pixels in a 390x844 viewport; \
                             the page under the viewer should neither scroll nor overflow"
                },
                "findings": [{ "rule": "page.scroll", "severity": "fail" }]
            }),
            true,
            "quiescent",
        );
        let failure = gate_failure(&overflowing).unwrap();
        assert!(
            failure.starts_with("fail: its document is 390x924"),
            "{failure}"
        );
    }

    /// A page the server dropped reconnects, retries what it lost and can
    /// settle clear, so the gate reads the outage off the document, and off
    /// every interval in it: the reconnect can land in a run other than the
    /// one the driver waited for.
    #[test]
    fn the_gate_fails_a_page_that_lost_its_socket_even_when_the_run_settled_clear() {
        let clear = json!({ "verdict": { "kind": "clear", "text": "no stall" } });
        let connection = |generation: u64, closed: Option<u64>, gap: Option<u64>| {
            json!({
                "generation": generation,
                "openedAtUs": gap.map(|_| 9_000_000),
                "closedAtUs": closed,
                "gapUs": gap,
                "firstRid": 0,
                "lastRid": 40,
            })
        };

        let mut steady = run_file(clear.clone(), true, "quiescent");
        steady.trace = json!({ "runs": [
            { "header": { "runId": "run-1-1", "connections": [connection(1, None, None)] } },
        ] });
        assert_eq!(gate_failure(&steady), None);

        let mut dropped = run_file(clear, true, "quiescent");
        dropped.trace = json!({ "runs": [
            { "header": { "runId": "run-1-1", "connections": [{
                "generation": 1,
                "openedAtUs": null,
                "closedAtUs": 7_000_000,
                "gapUs": null,
                "close": { "code": 1013, "reason": "client fell too far behind" },
            }] } },
            { "header": { "runId": "run-1-2", "connections": [connection(2, None, Some(2_000_000))] } },
        ] });
        assert_eq!(
            gate_failure(&dropped).as_deref(),
            Some(
                "the page lost its session socket once during the trace \
                 (closed 1013 client fell too far behind)"
            ),
        );

        // A page too old to record the close frame still fails, on the
        // reconnect alone.
        dropped.trace = json!({ "runs": [
            { "header": { "runId": "run-1-2", "connections": [
                connection(2, None, Some(2_000_000)),
                connection(3, None, Some(2_000_000)),
            ] } },
        ] });
        assert_eq!(
            gate_failure(&dropped).as_deref(),
            Some("the page lost its session socket 2 times during the trace"),
        );
    }

    /// An interaction run over the frame-time ceiling reaches the gate as a
    /// failing verdict naming the input, and only once the run has closed. A
    /// run that never went quiescent fails as unsettled before its verdict is
    /// read.
    #[test]
    fn the_gate_fails_a_slow_interaction_run_once_it_has_closed() {
        let verdict = json!({
            "verdict": {
                "kind": "fail",
                "text": "orbit ran at p95 80 ms per main-thread frame, over the 50 ms ceiling for an interaction run"
            },
            "run": { "cause": { "epoch": "view", "dirtyKind": "interactive", "source": "orbit" } }
        });
        let closed = run_file(verdict.clone(), true, "quiescent");
        let reason = gate_failure(&closed).unwrap();
        assert!(reason.contains("orbit"));
        assert!(reason.contains("ceiling for an interaction run"));

        let unsettled = run_file(verdict, false, "timeout");
        let reason = gate_failure(&unsettled).unwrap();
        assert!(reason.contains("never settled"));
        assert!(!reason.contains("ceiling for an interaction run"));
    }

    /// "The view settled and the pipeline went on" is a regression a build
    /// should catch, so a steady-state verdict fails the gate as a failing
    /// finding does.
    #[test]
    fn the_gate_fails_on_a_steady_state_verdict() {
        let refetching = run_file(
            json!({
                "verdict": {
                    "kind": "steady-state",
                    "text": "12 chunk(s) were fetched again after the view settled — 24 refetch(es) costing 49,152 B over the 8,000 ms window"
                }
            }),
            true,
            "quiescent",
        );
        let reason = gate_failure(&refetching).unwrap();
        assert!(reason.contains("steady-state"));
        assert!(reason.contains("fetched again after the view settled"));
    }

    /// A view whose budgets hold less than it wants settles covering less,
    /// and that is the planned behavior, so it passes, as a view bound by one
    /// phase does. A view that stopped without settling fails, and says what
    /// it waited on.
    #[test]
    fn the_gate_passes_a_view_that_settled_covering_less_or_bound_and_fails_a_stall() {
        let budget_bound = run_file(
            json!({
                "verdict": {
                    "kind": "clear",
                    "text": "no stall — the coarse tier is budget-bound at 62,914,560 B of 67,108,864 B (93% full) with nothing pending and nothing in flight, so 440 of 1,240 wanted chunk(s) cannot fit — the view settles covering less, a coverage loss of 35%"
                }
            }),
            true,
            "quiescent",
        );
        assert_eq!(gate_failure(&budget_bound), None);

        let bound = run_file(
            json!({
                "verdict": {
                    "kind": "bound",
                    "text": "bound by browser.upload: it held 270 ms, 31% of the chain, and nothing failed"
                },
                "findings": [{ "rule": "share.dominant", "severity": "bound", "subject": "browser.upload" }]
            }),
            true,
            "quiescent",
        );
        assert_eq!(gate_failure(&bound), None);

        let mut stalled = run_file(json!({}), false, "stalled");
        stalled.header.stall_reason = Some("server_pending".to_string());
        assert_eq!(
            gate_failure(&stalled).as_deref(),
            Some("the run never settled (stalled: server_pending)")
        );
    }

    #[test]
    fn the_run_timeout_expression_hands_the_page_the_drivers_deadline() {
        assert_eq!(
            run_timeout_expression(Duration::from_secs(180)),
            "window.lucidaTrace ? (window.lucidaTrace.runTimeoutMs = 180000, true) : false"
        );
    }

    /// The steady-state rules read closed intervals, and the gate reads the
    /// closed run's verdict. A provisional reading that named a steady-state
    /// finding over its moving window is not a verdict and cannot fail a
    /// build, exactly as any other provisional finding cannot.
    #[test]
    fn the_gate_ignores_a_steady_state_finding_in_a_provisional_window() {
        let file = run_file(
            json!({
                "verdict": { "kind": "clear", "text": "no stall — nothing crossed a threshold" },
                "provisional": {
                    "provisional": true,
                    "window": { "startMs": 7300, "endMs": 12300, "spanMs": 5000 },
                    "findings": [
                        { "severity": "steady-state", "rule": "steady.refetch", "subject": "refetch after settle" }
                    ],
                    "statement": "provisional — over the last 5000 ms, chunks were fetched again"
                }
            }),
            true,
            "quiescent",
        );
        assert_eq!(gate_failure(&file), None);
    }

    /// 87% of a healthy local cold open is pre-instrument boot, so a gate that
    /// fires on coverage fires on every green run.
    #[test]
    fn the_gate_never_fails_on_coverage_alone() {
        let clear = run_file(
            json!({
                "verdict": { "kind": "clear", "text": "nothing crossed a threshold" },
                "coverage": { "accountedPct": 13, "incomplete": true, "gapCount": 4 }
            }),
            true,
            "quiescent",
        );
        assert_eq!(gate_failure(&clear), None);
    }

    /// A provisional reading is a statement over a moving window of an open
    /// run, and the gate trusts only the verdict of a closed one, so a reading
    /// riding beside a clear verdict changes nothing, whatever its window saw.
    #[test]
    fn the_gate_ignores_a_provisional_window_beside_a_clear_verdict() {
        let provisional = json!({
            "provisional": true,
            "window": { "startMs": 7300, "endMs": 12300, "spanMs": 5000 },
            "topFinding": {
                "severity": "saturated",
                "rule": "queue.backlog",
                "subject": "scheduler.admission"
            },
            "findings": [
                { "severity": "bound", "rule": "share.dominant", "subject": "render.frame" },
                { "severity": "saturated", "rule": "queue.backlog", "subject": "scheduler.admission" }
            ],
            "statement": "provisional — over the last 5000 ms, scheduler.admission held 19,800 requests behind a cap of 24 and the backlog is not shrinking"
        });
        let file = run_file(
            json!({
                "verdict": { "kind": "clear", "text": "no stall — nothing crossed a threshold" },
                "provisional": provisional
            }),
            true,
            "quiescent",
        );
        assert_eq!(gate_failure(&file), None);
    }

    /// The hold window is baked into every duration the run reports, so it
    /// travels with them rather than living in this command's help text.
    #[test]
    fn the_default_rendering_leads_with_what_the_page_could_not_know() {
        let file = run_file(
            json!({ "verdict": { "kind": "clear", "text": "clear" } }),
            true,
            "quiescent",
        );
        let human = format_run_human(&file, Path::new("/traces/run-1-1.json"), None);

        assert!(human.contains("gs://bucket/set.zarr @ 1440x900 DPR 2"));
        assert!(human.contains("server cold for this dataset"));
        assert!(human.contains("quiescent had to hold 500 ms"));
        assert!(human.contains("/traces/run-1-1.json"));
        assert!(human.contains("VERDICT: clear"));
        // The document itself is the file's job, not stdout's.
        assert!(!human.contains("\"runs\""));
    }

    /// Every depth is the page's rendering, taken at export. The browser that
    /// could render another one is dead by the time this file is read, so a
    /// depth the CLI cannot find is a depth it says it cannot find.
    #[test]
    fn the_depths_print_the_pages_own_renderings() {
        let file = run_file(json!({}), true, "quiescent");
        let renderings = &file.renderings;
        assert_eq!(
            render_depth(renderings, &ShowDepth::Summary),
            renderings.summary
        );
        assert_eq!(
            render_depth(renderings, &ShowDepth::Phases),
            renderings.phases
        );
        assert_eq!(
            render_depth(renderings, &ShowDepth::Phase("browser.wire".to_string())),
            renderings.per_phase["browser.wire"]
        );

        let missing = render_depth(renderings, &ShowDepth::Phase("browser.decode".to_string()));
        assert!(missing.contains("browser.decode is not in this run"));
        assert!(missing.contains("browser.wire"));
    }

    /// The narrower-window follow-up the text prints has to parse back, in
    /// the same spelling, and an empty or backwards window is refused here
    /// rather than shipped to a page.
    #[test]
    fn a_window_is_two_ordered_millisecond_offsets() {
        assert_eq!(
            "1200..4120".parse::<WindowRequest>().unwrap(),
            WindowRequest {
                start_ms: 1200.0,
                end_ms: 4120.0
            }
        );
        assert_eq!(
            "1.5..4".parse::<WindowRequest>().unwrap().to_string(),
            "1.5..4"
        );
        assert_eq!(
            WindowRequest {
                start_ms: 60.0,
                end_ms: 1911.0
            }
            .to_string(),
            "60..1911"
        );
        for bad in [
            "",
            "1200",
            "..",
            "4120..1200",
            "5..5",
            "-1..5",
            "a..b",
            "1..inf",
        ] {
            assert!(bad.parse::<WindowRequest>().is_err(), "{bad:?} parsed");
        }
    }

    /// The page derives the window over the file's own document, which the
    /// CLI hands back rather than reads, and every depth comes out of the one
    /// evaluation, as the driver's export does.
    #[test]
    fn the_window_expression_hands_the_files_document_back_to_the_seam() {
        let trace = json!({ "runs": [{ "header": { "runId": "run-1-1" } }] });
        let expression = window_read_expression(
            &trace,
            Some("run-1-1"),
            WindowRequest {
                start_ms: 1200.0,
                end_ms: 4120.0,
            },
        );

        assert!(expression.contains("seam.diagnoseTrace(trace, scope)"));
        assert!(expression.contains("seam.diagnoseTraceText(trace, scope)"));
        assert!(expression.contains(&trace.to_string()));
        assert!(expression.contains(r#""runId":"run-1-1""#));
        assert!(expression.contains(r#""startMs":1200.0"#));
        assert!(expression.contains(r#""endMs":4120.0"#));
        assert!(expression.contains("depth: 'phases'"));
        assert!(expression.contains("depth: 'phase', phase: phase.id"));
        // Null rather than a throw when the seam is missing, so read_window
        // names the missing seam instead of a failed evaluation.
        assert!(expression.contains("typeof seam.diagnoseTrace !== 'function'"));
    }

    /// A windowed reading prints at every depth a run file prints at, through
    /// the same selection, so `--window` composes with `--phases` and
    /// `--phase` rather than being a depth of its own.
    #[test]
    fn a_windowed_reading_prints_the_pages_renderings_at_every_depth() {
        let export: WindowExport = serde_json::from_value(json!({
            "diagnostic": { "window": { "startMs": 1200.0, "endMs": 4120.0 } },
            "summary": "lucida trace run-1-1 — VERDICT: clear\nwindow    1200..4120 ms",
            "phases": "CRITICAL PATH  from 1200 ms to last chunk presented at 4050 ms",
            "perPhase": { "browser.wire": "PHASE     browser.wire" }
        }))
        .unwrap();
        let read = windowed_run(
            export,
            WindowRequest {
                start_ms: 1200.0,
                end_ms: 4120.0,
            },
        );

        assert_eq!(
            render_depth(&read.renderings, &ShowDepth::Summary),
            read.renderings.summary
        );
        assert!(render_depth(&read.renderings, &ShowDepth::Phases).contains("from 1200 ms"));
        assert_eq!(
            render_depth(
                &read.renderings,
                &ShowDepth::Phase("browser.wire".to_string())
            ),
            "PHASE     browser.wire"
        );
        assert_eq!(read.diagnostic["window"]["endMs"], 4120.0);
        assert_eq!(read.window.to_string(), "1200..4120");
    }

    /// The chunk and spatial depths are the page's readings too, taken at
    /// export for the chunks the document pointed at.
    #[test]
    fn the_chunk_and_spatial_depths_print_the_pages_own_readings() {
        let file = run_file(json!({}), true, "quiescent");
        assert_eq!(
            render_show(&file, &ShowDepth::Spatial),
            file.renderings.spatial
        );
        assert_eq!(
            render_show(
                &file,
                &ShowDepth::Chunk("member-7/1/0/0/0/119/0".to_string())
            ),
            file.renderings.per_chunk["member-7/1/0/0/0/119/0"].text
        );

        // A file from before the reading existed says so rather than printing nothing.
        let mut older = file.clone();
        older.renderings.spatial = String::new();
        assert!(render_show(&older, &ShowDepth::Spatial).contains("carries no spatial reading"));
    }

    /// The file holds every row, so it can say whether a chunk is in the run;
    /// what it cannot do is read a chunk the export did not render, and it
    /// names the seam call that can rather than deriving one here.
    #[test]
    fn a_chunk_the_file_holds_no_reading_for_is_answered_from_the_rows_it_has() {
        let mut file = run_file(json!({}), true, "quiescent");
        file.trace = json!({
            "runs": [
                { "header": { "runId": "run-0-9" }, "rows": [
                    { "entityId": "member-1", "chunkKey": "1/0/0/0/5/0" }
                ] },
                { "header": { "runId": "run-1-1" }, "rows": [
                    { "entityId": "member-7", "chunkKey": "1/0/0/0/119/0" },
                    { "entityId": "member-5", "chunkKey": "1/0/0/0/5/0" },
                    { "entityId": "tile-a", "chunkKey": "1/0/0/0/0/0" },
                    { "entityId": "tile-b", "chunkKey": "1/0/0/0/0/0" }
                ] }
            ]
        });

        let absent = render_show(&file, &ShowDepth::Chunk("1/0/0/0/999/0".to_string()));
        assert_eq!(
            absent,
            "no lifecycle row in this run carries chunk 1/0/0/0/999/0"
        );

        // The key is in the run under another entity; member-1 carries it only
        // in the other run.
        let other_entity =
            render_show(&file, &ShowDepth::Chunk("member-1/1/0/0/0/5/0".to_string()));
        assert!(other_entity.starts_with("no lifecycle row in this run carries"));

        // A selector that names no chunk matches no row, and says so the same way.
        let not_a_chunk = render_show(&file, &ShowDepth::Chunk("wire".to_string()));
        assert!(not_a_chunk.starts_with("no lifecycle row in this run carries chunk wire"));

        // In the run, by bare key and by entity-qualified key, with no reading.
        for selector in ["1/0/0/0/0/0", "tile-b/1/0/0/0/0/0", "member-5/1/0/0/0/5/0"] {
            let unread = render_show(&file, &ShowDepth::Chunk(selector.to_string()));
            assert!(
                unread.starts_with(&format!("chunk {selector} is in this run")),
                "{unread}"
            );
            assert!(unread.contains("holds a reading only for: member-7/1/0/0/0/119/0"));
            assert!(unread.contains("window.lucidaTrace.diagnoseText"));
            assert!(unread.contains(&format!("chunk: '{selector}'")));
            // A number the document does not carry is not printed here.
            assert!(!unread.contains("row(s)"));
        }
    }

    /// The export carries the spatial reading and one reading per chunk the
    /// document pointed at, text and section together, and both land in the
    /// file beside the phases.
    #[test]
    fn the_run_file_keeps_the_spatial_and_chunk_readings_the_page_rendered() {
        let export: SeamExport = serde_json::from_str(
            &json!({
                "schemaVersion": 1, "runId": "run-7-2", "quiescenceHoldMs": 500,
                "endReason": "quiescent", "diagnostic": {}, "summary": "ok", "phases": "ok",
                "spatial": "SPATIAL   40 rows",
                "perChunk": { "tile-3/1/0/0/0/0/0": {
                    "text": "CHUNK     tile-3/1/0/0/0/0/0",
                    "section": { "selector": "tile-3/1/0/0/0/0/0", "rowCount": 1 }
                } },
                "trace": { "runs": [] }
            })
            .to_string(),
        )
        .unwrap();

        let file = assemble_run_file(export, &facts());
        assert_eq!(file.renderings.spatial, "SPATIAL   40 rows");
        let depth = ShowDepth::Chunk("tile-3/1/0/0/0/0/0".to_string());
        assert_eq!(render_show(&file, &depth), "CHUNK     tile-3/1/0/0/0/0/0");
        assert_eq!(
            chunk_section(&file.renderings, &depth),
            Some(&json!({ "selector": "tile-3/1/0/0/0/0/0", "rowCount": 1 }))
        );
        // Every other depth's JSON is the document itself.
        assert_eq!(chunk_section(&file.renderings, &ShowDepth::Spatial), None);
        assert_eq!(
            chunk_section(
                &file.renderings,
                &ShowDepth::Chunk("9/9/9/9/9/9".to_string())
            ),
            None
        );

        // The export expression asks the page for both, so the file can carry them.
        assert!(RUN_EXPORT_EXPRESSION.contains("depth: 'spatial'"));
        assert!(RUN_EXPORT_EXPRESSION.contains("depth: 'chunk'"));
        assert!(RUN_EXPORT_EXPRESSION.contains("seam.diagnose(runId, { chunk: selector }).chunk"));
    }

    /// A run that never settled is still an artifact, and the driver's own
    /// fields have to survive into it.
    #[test]
    fn the_run_file_folds_the_pages_export_together_with_the_drivers_header() {
        let export: SeamExport = serde_json::from_str(
            &json!({
                "schemaVersion": 1,
                "runId": "run-7-2",
                "quiescenceHoldMs": 500,
                "endReason": "timeout",
                "diagnostic": { "verdict": { "kind": "unsettled", "text": "never settled" } },
                "summary": "lucida trace run-7-2 — VERDICT: never settled",
                "phases": "CRITICAL PATH",
                "trace": { "runs": [] }
            })
            .to_string(),
        )
        .unwrap();

        let file = assemble_run_file(export, &facts());

        assert_eq!(file.header.run_id.as_deref(), Some("run-7-2"));
        assert_eq!(file.header.end_reason.as_deref(), Some("timeout"));
        assert!(!file.header.settled);
        assert_eq!(file.header.quiescence_hold_ms, 500.0);
        assert!(gate_failure(&file).is_some());
    }

    /// A run driven without a frame carries no `screenshot` key at all, rather
    /// than a null a reader has to tell from "not written".
    #[test]
    fn the_header_names_the_screenshot_the_driver_wrote_and_omits_it_otherwise() {
        let export = || -> SeamExport {
            serde_json::from_str(
                &json!({ "schemaVersion": 1, "runId": "run-3-1", "quiescenceHoldMs": 500,
                         "endReason": "quiescent", "diagnostic": null, "summary": "ok",
                         "phases": "ok", "trace": { "runs": [] } })
                .to_string(),
            )
            .unwrap()
        };

        let with_frame = DriverFacts {
            screenshot: Some(PathBuf::from("/tmp/twins/sharded.png")),
            ..facts()
        };
        let file = assemble_run_file(export(), &with_frame);
        assert_eq!(
            file.header.screenshot.as_deref(),
            Some(Path::new("/tmp/twins/sharded.png"))
        );
        let json = serde_json::to_value(&file).unwrap();
        assert_eq!(json["header"]["screenshot"], "/tmp/twins/sharded.png");
        assert!(
            format_run_human(&file, Path::new("run.json"), None).contains("/tmp/twins/sharded.png")
        );

        let without = assemble_run_file(export(), &facts());
        assert_eq!(without.header.screenshot, None);
        let json = serde_json::to_value(&without).unwrap();
        assert!(json["header"].get("screenshot").is_none());
    }

    /// A page that recorded no run is a result, not a crash.
    /// A page that recorded nothing is trivially quiescent — nothing dirty,
    /// nothing wanted — so a run file must not call that settled. It is the
    /// cold-remote-open failure this command exists to measure.
    #[test]
    fn a_page_with_no_run_still_produces_a_readable_file() {
        let export: SeamExport = serde_json::from_str(
            &json!({ "schemaVersion": 1, "runId": null, "quiescenceHoldMs": null,
                     "endReason": null, "diagnostic": null, "summary": null,
                     "phases": null, "trace": { "runs": [] } })
            .to_string(),
        )
        .unwrap();

        let file = assemble_run_file(export, &facts());
        assert!(file.renderings.summary.contains("no run was recorded"));
        assert_eq!(file.header.quiescence_hold_ms, DEFAULT_QUIESCENCE_HOLD_MS);
        // A run that never happened did not settle, and a gate says so.
        assert!(!file.header.settled);
        assert!(gate_failure(&file).unwrap().contains("never settled"));
    }

    #[test]
    fn a_run_resolves_by_id_from_the_trace_directory_and_by_path_from_anywhere() {
        let dir = Path::new("/home/me/.config/lucida/traces");
        assert_eq!(
            resolve_run_file(dir, "run-17-3"),
            PathBuf::from("/home/me/.config/lucida/traces/run-17-3.json")
        );
        assert_eq!(
            resolve_run_file(dir, "/tmp/elsewhere.json"),
            PathBuf::from("/tmp/elsewhere.json")
        );
    }

    #[test]
    fn the_trace_directory_sits_beside_the_config_unless_asked_otherwise() {
        let config = Path::new("/home/me/.config/lucida/config.json");
        assert_eq!(
            resolve_trace_dir(None, config),
            PathBuf::from("/home/me/.config/lucida/traces")
        );
        assert_eq!(
            resolve_trace_dir(Some(Path::new("/runs")), config),
            PathBuf::from("/runs")
        );
    }

    #[test]
    fn a_run_file_from_another_version_is_refused_rather_than_half_read() {
        let dir = std::env::temp_dir().join(format!("lucida-trace-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("run-old.json");
        let mut file = run_file(json!({}), true, "quiescent");
        file.file_version = RUN_FILE_VERSION + 1;
        std::fs::write(&path, serde_json::to_vec(&file).unwrap()).unwrap();

        let error = read_artifact(&path).unwrap_err();
        assert_eq!(error.kind, ErrorKind::Protocol);
        assert!(error.message.contains("run file version"));

        file.file_version = RUN_FILE_VERSION;
        std::fs::write(&path, serde_json::to_vec(&file).unwrap()).unwrap();
        assert_eq!(
            read_artifact(&path).unwrap(),
            TraceArtifact::Run(Box::new(file))
        );

        std::fs::remove_dir_all(&dir).unwrap();
    }

    fn knobs_for(flags: &[(&str, f64)]) -> KnobSettings {
        let mut knobs = KnobSettings::default();
        for (flag, value) in flags {
            knobs
                .set(crate::trace_knobs::knob_for_flag(flag).unwrap(), *value)
                .unwrap();
        }
        knobs
    }

    fn minimal_export() -> SeamExport {
        serde_json::from_str(
            r#"{"runId":"run-1-1","endReason":"quiescent","diagnostic":{"verdict":{"kind":"clear"}},
                "summary":"s","phases":"p","spatial":"x","trace":{"runs":[]}}"#,
        )
        .unwrap()
    }

    /// The header records the knobs the driver set, and nothing when it set
    /// none: an absent field says the run took the page's defaults.
    #[test]
    fn the_run_header_records_the_knobs_only_when_some_were_set() {
        let plain = assemble_run_file(minimal_export(), &facts());
        assert_eq!(plain.header.knobs, None);
        assert!(
            !serde_json::to_string(&plain.header)
                .unwrap()
                .contains("knobs")
        );

        let knobs = knobs_for(&[("prefetch-depth", 0.0), ("max-fetches", 2.0)]);
        let with = DriverFacts {
            knobs: knobs.clone(),
            ..facts()
        };
        let file = assemble_run_file(minimal_export(), &with);
        assert_eq!(file.header.knobs, Some(knobs));
        let json = serde_json::to_value(&file.header).unwrap();
        assert_eq!(json["knobs"]["planning"]["prefetchDepth"], json!(0));
        assert_eq!(json["knobs"]["cache"]["maxConcurrentFetches"], json!(2));

        let text = format_run_human(&file, Path::new("/runs/run-1-1.json"), None);
        assert!(
            text.contains("knobs     prefetch-depth 0 · max-fetches 2\n"),
            "{text}"
        );
        let plain_text = format_run_human(&plain, Path::new("/runs/run-1-1.json"), None);
        assert!(!plain_text.contains("knobs"), "{plain_text}");
    }

    /// A device memory override reaches the page before its scripts, beside
    /// the knobs' seed, and the header says the run was driven under it.
    #[test]
    fn the_device_memory_override_runs_first_and_the_header_names_it() {
        assert_eq!(parse_device_memory("4"), Ok(4.0));
        assert_eq!(parse_device_memory("0.5"), Ok(0.5));
        for bad in ["0", "-2", "NaN", "inf", "four"] {
            assert!(parse_device_memory(bad).is_err(), "{bad}");
        }

        assert_eq!(new_document_script(&DriveRequest::default()), None);
        let knobs = knobs_for(&[("prefetch-depth", 0.0)]);
        let request = DriveRequest {
            knobs: Some(&knobs),
            device_memory_gib: Some(4.0),
            ..DriveRequest::default()
        };
        let script = new_document_script(&request).unwrap();
        assert!(
            script.starts_with(
                "Object.defineProperty(Navigator.prototype, \"deviceMemory\", { get: () => 4, configurable: true });"
            ),
            "{script}"
        );
        assert!(script.contains("lucidaPreferenceSeed"), "{script}");

        let with = DriverFacts {
            composed_view: ComposedView {
                device_memory_gib: Some(4.0),
                ..composed()
            },
            ..facts()
        };
        let file = assemble_run_file(minimal_export(), &with);
        let json = serde_json::to_value(&file.header).unwrap();
        assert_eq!(json["composedView"]["deviceMemoryGib"], json!(4.0));
        let text = format_run_human(&file, Path::new("/runs/run-1-1.json"), None);
        assert!(text.contains("DPR 2 · device memory 4 GiB\n"), "{text}");
        let plain = assemble_run_file(minimal_export(), &facts());
        assert!(
            !serde_json::to_string(&plain.header)
                .unwrap()
                .contains("deviceMemory")
        );
    }

    /// A core count override reaches the page before its scripts, and the
    /// header says the run was driven under it.
    #[test]
    fn the_cores_override_runs_before_the_page_and_the_header_names_it() {
        let request = DriveRequest {
            device_memory_gib: Some(4.0),
            cores: Some(8),
            ..DriveRequest::default()
        };
        let script = new_document_script(&request).unwrap();
        assert!(
            script.contains(
                "Object.defineProperty(Navigator.prototype, \"hardwareConcurrency\", { get: () => 8, configurable: true });"
            ),
            "{script}"
        );

        let with = DriverFacts {
            composed_view: ComposedView {
                device_memory_gib: Some(4.0),
                cores: Some(8),
                ..composed()
            },
            ..facts()
        };
        let file = assemble_run_file(minimal_export(), &with);
        let json = serde_json::to_value(&file.header).unwrap();
        assert_eq!(json["composedView"]["cores"], json!(8));
        let text = format_run_human(&file, Path::new("/runs/run-1-1.json"), None);
        assert!(
            text.contains("DPR 2 · device memory 4 GiB · 8 cores\n"),
            "{text}"
        );
        let plain = assemble_run_file(minimal_export(), &facts());
        assert!(
            !serde_json::to_string(&plain.header)
                .unwrap()
                .contains("cores")
        );
    }

    #[test]
    fn a_run_driven_as_a_phone_says_so_in_its_header() {
        let with = DriverFacts {
            composed_view: ComposedView {
                width: 390,
                height: 844,
                device_pixel_ratio: 3.0,
                mobile: true,
                ..composed()
            },
            ..facts()
        };
        let file = assemble_run_file(minimal_export(), &with);
        let json = serde_json::to_value(&file.header).unwrap();
        assert_eq!(json["composedView"]["mobile"], json!(true));
        let text = format_run_human(&file, Path::new("/runs/run-1-1.json"), None);
        assert!(text.contains("@ 390x844 DPR 3 · phone\n"), "{text}");
        let full = DriverFacts {
            composed_view: ComposedView {
                full_ui: true,
                ..with.composed_view.clone()
            },
            ..facts()
        };
        let file = assemble_run_file(minimal_export(), &full);
        let json = serde_json::to_value(&file.header).unwrap();
        assert_eq!(json["composedView"]["fullUi"], json!(true));
        let text = format_run_human(&file, Path::new("/runs/run-1-1.json"), None);
        assert!(
            text.contains("@ 390x844 DPR 3 · phone · full UI\n"),
            "{text}"
        );
        let plain = assemble_run_file(minimal_export(), &facts());
        assert!(
            !serde_json::to_string(&plain.header)
                .unwrap()
                .contains("mobile")
        );
    }

    /// The full page is the same viewer URL without the capture surface's flag.
    #[test]
    fn a_full_ui_run_drives_the_viewer_url_without_the_capture_flag() {
        assert_eq!(
            driven_page_url("http://h/w/ws#view=ABC", false),
            "http://h/w/ws?render=1#view=ABC"
        );
        assert_eq!(
            driven_page_url("http://h/w/ws#view=ABC", true),
            "http://h/w/ws#view=ABC"
        );
    }

    #[test]
    fn suffixed_inserts_before_the_extension() {
        assert_eq!(
            suffixed(Path::new("/runs/run.json"), VERSUS_SUFFIX),
            PathBuf::from("/runs/run.versus.json")
        );
        assert_eq!(
            suffixed(Path::new("frame.png"), VERSUS_SUFFIX),
            PathBuf::from("frame.versus.png")
        );
        assert_eq!(
            suffixed(Path::new("out/frame"), VERSUS_SUFFIX),
            PathBuf::from("out/frame.versus")
        );
        assert_eq!(
            suffixed(Path::new(".hidden"), VERSUS_SUFFIX),
            PathBuf::from(".hidden.versus")
        );
    }

    /// A throttled server's run says so in its header, in its text, and in
    /// the side it hands a comparison, so it can never read as an
    /// unthrottled one. A run file from before the record says nothing.
    #[test]
    fn a_run_under_a_source_throttle_says_so_everywhere_it_is_read() {
        let report = SourceThrottleReport {
            profile: Some("remote".into()),
            latency_ms: 180,
            jitter_ms: 100,
            bytes_per_sec: Some(18 * 1024 * 1024),
        };
        let throttled = DriverFacts {
            source_throttle: SourceThrottleRecord::from_report(Some(report.clone())),
            ..facts()
        };
        let file = assemble_run_file(minimal_export(), &throttled);
        let header = serde_json::to_value(&file.header).unwrap();
        assert_eq!(
            header["sourceThrottle"]["settings"]["latency_ms"],
            json!(180)
        );
        let text = format_run_human(&file, Path::new("/runs/run-1-1.json"), None);
        assert!(
            text.contains(
                "throttle  source reads throttled on the server: remote: 180-280 ms per request, 18 MiB/s across all reads\n"
            ),
            "{text}"
        );
        let side = CompareSide::from_run_file(&file, Path::new("runs/on.json"));
        assert_eq!(
            side.side.source_throttle,
            Some(CompareThrottle {
                settings: Some(report)
            })
        );

        let plain = assemble_run_file(minimal_export(), &facts());
        assert_eq!(
            serde_json::to_value(&plain.header).unwrap()["sourceThrottle"],
            json!({ "summary": "source reads unthrottled" })
        );
        let text = format_run_human(&plain, Path::new("/runs/run-1-1.json"), None);
        assert!(!text.contains("throttle"), "{text}");
        let side = CompareSide::from_run_file(&plain, Path::new("runs/off.json"));
        assert_eq!(
            side.side.source_throttle,
            Some(CompareThrottle { settings: None })
        );

        let mut older = serde_json::to_value(&plain).unwrap();
        older["header"]
            .as_object_mut()
            .unwrap()
            .remove("sourceThrottle");
        let older: TraceRunFile = serde_json::from_value(older).unwrap();
        let side = CompareSide::from_run_file(&older, Path::new("runs/old.json"));
        assert_eq!(side.side.source_throttle, None);

        let mut no_health = golden_bundle();
        no_health.health = None;
        let artifact = TraceArtifact::Bundle(Box::new(no_health));
        let side = CompareSide::from_artifact(&artifact, Path::new("field.bundle.json"));
        assert_eq!(side.side.source_throttle, None);
    }

    /// The link throttle is recorded and read the way the source throttle
    /// is, beside it.
    #[test]
    fn a_run_under_a_link_throttle_says_so_everywhere_it_is_read() {
        let report = LinkThrottleReport {
            profile: Some("broadband".into()),
            latency_ms: 40,
            bytes_per_sec: Some(12_500_000),
        };
        let throttled = DriverFacts {
            link_throttle: LinkThrottleRecord::from_report(Some(report.clone())),
            ..facts()
        };
        let file = assemble_run_file(minimal_export(), &throttled);
        let header = serde_json::to_value(&file.header).unwrap();
        assert_eq!(header["linkThrottle"]["settings"]["latency_ms"], json!(40));
        let text = format_run_human(&file, Path::new("/runs/run-1-1.json"), None);
        assert!(
            text.contains(
                "throttle  session socket throttled on the server: broadband: 40 ms round trip, 100 Mbit/s to each client\n"
            ),
            "{text}"
        );
        let side = CompareSide::from_run_file(&file, Path::new("runs/on.json"));
        assert_eq!(
            side.side.link_throttle,
            Some(CompareLinkThrottle {
                settings: Some(report)
            })
        );

        let plain = assemble_run_file(minimal_export(), &facts());
        assert_eq!(
            serde_json::to_value(&plain.header).unwrap()["linkThrottle"],
            json!({ "summary": "session socket unthrottled" })
        );
        let side = CompareSide::from_run_file(&plain, Path::new("runs/off.json"));
        assert_eq!(
            side.side.link_throttle,
            Some(CompareLinkThrottle { settings: None })
        );

        let mut older = serde_json::to_value(&plain).unwrap();
        older["header"]
            .as_object_mut()
            .unwrap()
            .remove("linkThrottle");
        let older: TraceRunFile = serde_json::from_value(older).unwrap();
        let side = CompareSide::from_run_file(&older, Path::new("runs/old.json"));
        assert_eq!(side.side.link_throttle, None);
    }

    /// A run file's side carries the knobs the driver set and the server's
    /// warmth; a bundle's carries its header's whole planning configuration
    /// and cannot say what the cache knobs were.
    #[test]
    fn a_comparison_side_carries_what_its_artifact_knows() {
        let mut file = run_file(json!({ "verdict": { "kind": "clear" } }), true, "quiescent");
        file.header.knobs = Some(knobs_for(&[
            ("prefetch-depth", 0.0),
            ("main-budget-mb", 64.0),
        ]));
        let run_side = CompareSide::from_run_file(&file, Path::new("runs/left.json"));
        assert_eq!(run_side.side.label, "runs/left.json");
        assert_eq!(run_side.side.run_id.as_deref(), Some("run-1-1"));
        assert_eq!(run_side.side.planning, json!({ "prefetchDepth": 0 }));
        assert_eq!(
            run_side.side.cache,
            json!({ "mainBudgetBytes": 67_108_864 })
        );
        assert_eq!(
            run_side.side.conditions["server warmth"],
            json!("server cold for this dataset (not open before the run)")
        );
        assert!(std::ptr::eq(run_side.trace, &file.trace));

        // An empty object, not null: the page reads it as every field at
        // its default, where null would leave the side out of the planning
        // rows.
        file.header.knobs = None;
        let plain = CompareSide::from_run_file(&file, Path::new("runs/left.json"));
        assert_eq!(plain.side.planning, json!({}));
        assert_eq!(plain.side.cache, json!({}));

        let bundle = golden_bundle();
        let artifact = TraceArtifact::Bundle(Box::new(bundle.clone()));
        let bundle_side = CompareSide::from_artifact(&artifact, Path::new("field.bundle.json"));
        assert_eq!(bundle_side.side.label, "field.bundle.json");
        assert_eq!(bundle_side.side.run_id, bundle.header.run_id);
        assert_eq!(bundle_side.side.planning, bundle.header.planning);
        assert_eq!(bundle_side.side.cache, Value::Null);
    }

    /// The expression hands the page both documents and both sides, and
    /// calls the page's compare function rather than computing anything.
    #[test]
    fn the_compare_expression_hands_the_page_both_sides() {
        let mut left = run_file(json!({}), true, "quiescent");
        left.trace = json!({ "runs": [{ "header": { "runId": "run-1-1" } }] });
        let mut right = run_file(json!({}), true, "quiescent");
        right.header.run_id = Some("run-2-1".to_string());
        right.trace = json!({ "runs": [{ "header": { "runId": "run-2-1" } }] });
        let expression = compare_read_expression(
            &CompareSide::from_run_file(&left, Path::new("a.json")),
            &CompareSide::from_run_file(&right, Path::new("b.json")),
        );
        assert!(expression.contains("seam.compareTraces(left, right)"));
        assert!(expression.contains("seam.compareTracesText(left, right)"));
        assert!(expression.contains(&format!("left.trace = {};", left.trace)));
        assert!(expression.contains(&format!("right.trace = {};", right.trace)));
        assert!(expression.contains(r#""label":"a.json""#));
        assert!(expression.contains(r#""label":"b.json""#));
        assert!(expression.contains(r#""runId":"run-2-1""#));
    }

    #[test]
    fn the_versus_rendering_leads_with_each_runs_knobs_and_ends_with_the_diff_command() {
        let first = run_file(json!({}), true, "quiescent");
        let mut second = run_file(json!({}), true, "quiescent");
        second.header.knobs = Some(knobs_for(&[("prefetch-depth", 0.0)]));
        let text = format_versus_human(
            VersusSide {
                file: &first,
                path: Path::new("/runs/run-1-1.json"),
                bundle: None,
            },
            VersusSide {
                file: &second,
                path: Path::new("/runs/run-1-1.versus.json"),
                bundle: Some(Path::new("/runs/b.versus.json")),
            },
            "lucida trace diff run-1-1 run-1-1 — every delta is right minus left",
        );
        assert!(
            text.starts_with("left      /runs/run-1-1.json · the page's defaults\n"),
            "{text}"
        );
        assert!(
            text.contains(
                "right     /runs/run-1-1.versus.json · prefetch-depth 0 · bundle /runs/b.versus.json\n"
            ),
            "{text}"
        );
        assert!(
            text.contains("\n\nlucida trace diff run-1-1 run-1-1 — every delta"),
            "{text}"
        );
        assert!(
            text.ends_with("lucida trace diff /runs/run-1-1.json /runs/run-1-1.versus.json   # the same diff again, from the files\n"),
            "{text}"
        );
    }

    /// The bundle the page writes from fixed inputs, checked in under
    /// `trace-fixtures/` by the web suite. This side reads it and adds
    /// nothing, so the golden is where the two sides are held together.
    fn golden_bundle_path() -> PathBuf {
        PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("..")
            .join("trace-fixtures")
            .join("bundle-v1.json")
    }

    fn golden_bundle() -> TraceBundle {
        match read_artifact(&golden_bundle_path()).unwrap() {
            TraceArtifact::Bundle(bundle) => *bundle,
            TraceArtifact::Run(_) => panic!("the golden bundle read as a run file"),
        }
    }

    /// `show` reads a bundle at every depth it reads a run, because the bundle
    /// carries the same renderings, taken by the same page.
    #[test]
    fn the_golden_bundle_reads_as_a_bundle_and_prints_at_every_depth() {
        let artifact = read_artifact(&golden_bundle_path()).unwrap();
        let TraceArtifact::Bundle(bundle) = &artifact else {
            panic!("expected a bundle");
        };
        assert_eq!(bundle.format, BUNDLE_FORMAT);
        assert_eq!(bundle.bundle_version, BUNDLE_VERSION);
        assert_eq!(bundle.header.run_id.as_deref(), Some("local-healthy"));
        assert!(artifact.diagnostic().get("verdict").is_some());

        let summary = render_depth(artifact.renderings(), &ShowDepth::Summary);
        assert!(summary.contains("local-healthy"), "{summary}");
        let phases = render_depth(artifact.renderings(), &ShowDepth::Phases);
        assert!(phases.contains("browser.wire"), "{phases}");
        let wire = render_depth(
            artifact.renderings(),
            &ShowDepth::Phase("browser.wire".to_string()),
        );
        assert!(wire.contains("browser.wire"), "{wire}");
        let missing = render_depth(artifact.renderings(), &ShowDepth::Phase("nope".to_string()));
        assert!(missing.contains("is not in this run"), "{missing}");
        let spatial = render_depth(artifact.renderings(), &ShowDepth::Spatial);
        assert!(spatial.contains("SPATIAL"), "{spatial}");
        let selector = bundle.renderings.per_chunk.keys().next().cloned().unwrap();
        let chunk = render_depth(artifact.renderings(), &ShowDepth::Chunk(selector.clone()));
        assert!(chunk.contains("CHUNK"), "{chunk}");
        assert!(chunk_section(artifact.renderings(), &ShowDepth::Chunk(selector)).is_some());
    }

    /// The header lists every field the replay needs, and the list is the
    /// driver's own. Each replay input names the header field that carries
    /// it, and the golden has a value under every one.
    #[test]
    fn the_golden_bundles_header_carries_every_replay_input() {
        let text = std::fs::read_to_string(golden_bundle_path()).unwrap();
        let value: Value = serde_json::from_str(&text).unwrap();
        let header = value["header"].as_object().unwrap();
        for input in REPLAY_INPUTS {
            let field = header.get(input.field).unwrap_or_else(|| {
                panic!(
                    "{} ({}) is not in the bundle header",
                    input.input, input.field
                )
            });
            assert!(
                !field.is_null(),
                "{} ({}) is null in the golden",
                input.input,
                input.field
            );
        }
        // The replay list and the identity fields partition the header, so a
        // field the page adds to the header fails here until it is declared
        // as one or the other. The page's own tests assert the same split.
        let identity = [
            "runId",
            "cause",
            "endReason",
            "startedAtEpochMs",
            "durationUs",
            "quiescenceHoldMs",
            "savedAtEpochMs",
        ];
        let mut declared: Vec<&str> = REPLAY_INPUTS.iter().map(|input| input.field).collect();
        declared.extend(identity);
        declared.sort_unstable();
        let mut present: Vec<&str> = header.keys().map(String::as_str).collect();
        present.sort_unstable();
        assert_eq!(present, declared);

        // The typed reading agrees with what the driver's flags write into
        // the view: the dataset URL, the viewport and ratio, and the four pins.
        let header = golden_bundle().header;
        assert_eq!(
            header.datasets[0].source_url.as_deref(),
            Some("gs://bucket/sample.zarr")
        );
        assert!(header.view_url.as_deref().unwrap().contains("#view="));
        assert_eq!(
            header
                .viewport
                .map(|viewport| (viewport.css_width, viewport.css_height)),
            Some((1440.0, 900.0))
        );
        assert_eq!(header.device_pixel_ratio, Some(2.0));
        assert_eq!(header.mode.as_deref(), Some("slice"));
        assert!(header.planning.get("prefetchDepth").is_some());
        let pins = &header.pins[0];
        assert_eq!(pins.dataset_id, "ds");
        assert_eq!(pins.level, Some(2));
        assert_eq!(pins.render_mode.as_deref(), Some("max_intensity"));
        assert_eq!(
            pins.contrast.as_deref(),
            Some(
                &[
                    ContrastWindow {
                        min: 100.0,
                        max: 2000.0
                    },
                    ContrastWindow {
                        min: 50.0,
                        max: 900.0
                    }
                ][..]
            )
        );
        assert_eq!(
            pins.colormap.as_deref(),
            Some(&["magenta".to_string(), "green".to_string()][..])
        );
        assert_eq!(pins.auto_contrast, Some(false));
        assert_eq!(
            header.build.as_ref().map(|build| build.version.as_str()),
            Some("0.2.0")
        );
        assert_eq!(
            header.gpu.as_ref().and_then(|gpu| gpu.fallback),
            Some(false)
        );
        assert!(!header.cache_warmth.is_null());
    }

    /// The side this CLI hands the page's compare function for the golden
    /// bundle, held to the side the page's own reader builds for the same
    /// file, which the web suite writes to `trace-fixtures/` beside the
    /// bundle. Two readers, one input, so the diff the dock shows and the
    /// diff this CLI prints are one function over one argument.
    #[test]
    fn the_golden_bundles_compare_side_is_the_one_the_page_builds() {
        let artifact = TraceArtifact::Bundle(Box::new(golden_bundle()));
        let side =
            CompareSide::from_artifact(&artifact, Path::new("trace-fixtures/bundle-v1.json"));
        let produced = serde_json::to_value(&side.side).unwrap();

        let path = golden_bundle_path().with_file_name("compare-side-v1.json");
        let expected: Value =
            serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
        assert_eq!(produced, expected);
    }

    /// The health counters at close are in the bundle and in the text, next
    /// to the conditions a reader needs before the verdict means anything.
    #[test]
    fn the_bundles_text_carries_the_health_counters_and_the_replay_conditions() {
        let bundle = golden_bundle();
        let health = bundle.health.as_ref().unwrap();
        assert_eq!(
            health.datasets[0]
                .source_cache
                .as_ref()
                .unwrap()
                .source_reads,
            12
        );

        let text = render_depth(&bundle.renderings, &ShowDepth::Summary);
        let human = format_bundle_human(
            &bundle,
            Path::new("lucida-local-healthy.bundle.json"),
            &text,
        );
        assert!(human.contains("source reads 12"), "{human}");
        assert!(human.contains("cache hits 40"), "{human}");
        assert!(human.contains("misses 12"), "{human}");
        assert!(human.contains("generated coarse ready 8"), "{human}");
        assert!(human.contains("gs://bucket/sample.zarr"), "{human}");
        assert!(
            human.contains("@ 1440x900 DPR 2 · device memory 4 GiB · slice"),
            "{human}"
        );
        assert!(human.contains("level 2 · max_intensity"), "{human}");
        assert!(human.contains("contrast 100..2000, 50..900"), "{human}");
        assert!(human.contains("hardware adapter"), "{human}");
        assert!(human.contains("build     0.2.0 production"), "{human}");
        assert!(human.contains("prefetchDepth 2"), "{human}");
        assert!(
            human.contains("throttle  source reads throttled on the server: remote: 180-280 ms"),
            "{human}"
        );
        assert!(
            human.contains("2880x1800 PNG at DPR 2 (captured by page)"),
            "{human}"
        );
        assert!(
            human.ends_with(&text),
            "the page's own rendering closes the text"
        );
        // The frame's bytes stay in the file. A header block is for reading.
        assert!(!human.contains("iVBORw0KGgo="), "{human}");
    }

    /// One rule names an adapter everywhere: the description when the
    /// browser gave one, the vendor and architecture when it did not,
    /// and nothing when the header names nothing.
    #[test]
    fn an_adapter_is_named_by_its_description_or_its_vendor_and_architecture() {
        assert_eq!(
            adapter_name("Example Adapter", "nvidia", "lovelace").as_deref(),
            Some("Example Adapter")
        );
        assert_eq!(
            adapter_name("", "nvidia", "lovelace").as_deref(),
            Some("nvidia lovelace")
        );
        assert_eq!(adapter_name("", "apple", "").as_deref(), Some("apple"));
        assert_eq!(adapter_name(" ", "", ""), None);

        let unnamed = BundleGpu {
            vendor: String::new(),
            architecture: String::new(),
            device: String::new(),
            description: String::new(),
            fallback: None,
            timestamp_queries: false,
        };
        assert_eq!(
            describe_adapter(&unnamed),
            "unnamed adapter · fallback status unknown"
        );
    }

    #[test]
    fn a_bundle_without_a_frame_or_health_says_so_in_the_text() {
        let mut bundle = golden_bundle();
        bundle.frame = None;
        bundle.health = None;
        bundle.absent = vec![
            BundleAbsence {
                section: "frame".to_string(),
                reason:
                    "the render worker could not read its canvas: InvalidStateError: the canvas \
                         has no current texture"
                        .to_string(),
            },
            BundleAbsence {
                section: "health".to_string(),
                reason: "the session socket is not connected".to_string(),
            },
        ];
        bundle.header.pins[0] = DatasetPins {
            dataset_id: "ds".to_string(),
            level: None,
            render_mode: None,
            contrast: None,
            colormap: None,
            auto_contrast: None,
        };

        let human = format_bundle_human(&bundle, Path::new("b.json"), "text");
        // The pins are still a field the replay reads; only their values are
        // unknown, so the replay line stays quiet.
        assert!(!human.contains("replay    "), "{human}");
        assert!(human.contains("frame     not in this bundle"), "{human}");
        assert!(human.contains("health    not in this bundle"), "{human}");
        assert!(
            human.contains(
                "absent    frame: the render worker could not read its canvas: InvalidStateError: \
                 the canvas has no current texture"
            ),
            "{human}"
        );
        assert!(
            human.contains("absent    health: the session socket is not connected"),
            "{human}"
        );
        assert!(
            human.contains("pins      ds: the view URL carries no pins"),
            "{human}"
        );
    }

    /// When the driver's screenshot stood in for the page's own capture, the
    /// text says so beside the frame, with the page's reason, and the JSON
    /// description carries the same reason. A frame the page took carries
    /// no such key, on the wire or in the text.
    #[test]
    fn a_frame_the_screenshot_stood_in_for_says_why_beside_it() {
        let mut bundle = golden_bundle();
        let page_frame = bundle.frame.clone().expect("the golden bundle has a frame");
        assert_eq!(page_frame.captured_by, "page");
        assert_eq!(page_frame.fallback_reason, None);
        let own = format_bundle_human(&bundle, Path::new("b.json"), "text");
        assert!(
            own.contains("frame     2880x1800 PNG at DPR 2 (captured by page)"),
            "{own}"
        );

        let reason =
            "the render worker could not read its canvas: the canvas has no current texture";
        let stood_in = BundleFrame {
            captured_by: "driver".to_string(),
            fallback_reason: Some(reason.to_string()),
            ..page_frame
        };
        let json = serde_json::to_value(&stood_in).unwrap();
        assert_eq!(json["fallbackReason"], reason);
        assert_eq!(stood_in.describe()["fallbackReason"], reason);
        let parsed: BundleFrame = serde_json::from_value(json).unwrap();
        assert_eq!(parsed, stood_in);

        bundle.frame = Some(stood_in);
        let human = format_bundle_human(&bundle, Path::new("b.json"), "text");
        assert!(
            human.contains(&format!(
                "frame     2880x1800 PNG at DPR 2 (captured by driver; the page's capture failed: {reason})"
            )),
            "{human}"
        );
        assert!(!human.contains("absent    frame"), "{human}");
    }

    /// A follow-up command takes a run file or a bundle by the same argument,
    /// and refuses what it cannot read with a reason instead of a half read.
    #[test]
    fn a_follow_up_command_reads_a_run_file_or_a_bundle_and_refuses_what_it_cannot() {
        let dir =
            std::env::temp_dir().join(format!("lucida-trace-artifact-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();

        let run_path = dir.join("run.json");
        let file = run_file(json!({}), true, "quiescent");
        std::fs::write(&run_path, serde_json::to_vec(&file).unwrap()).unwrap();
        assert_eq!(
            read_artifact(&run_path).unwrap(),
            TraceArtifact::Run(Box::new(file))
        );

        let bundle_path = dir.join("lucida-run.bundle.json");
        let mut value: Value =
            serde_json::from_str(&std::fs::read_to_string(golden_bundle_path()).unwrap()).unwrap();
        std::fs::write(&bundle_path, serde_json::to_vec(&value).unwrap()).unwrap();
        assert!(matches!(
            read_artifact(&bundle_path).unwrap(),
            TraceArtifact::Bundle(_)
        ));

        value["bundleVersion"] = json!(BUNDLE_VERSION + 1);
        std::fs::write(&bundle_path, serde_json::to_vec(&value).unwrap()).unwrap();
        let error = read_artifact(&bundle_path).unwrap_err();
        assert_eq!(error.kind, ErrorKind::Protocol);
        assert!(
            error.message.contains("bundle version"),
            "{}",
            error.message
        );

        let other_path = dir.join("other.json");
        std::fs::write(&other_path, br#"{"hello": 1}"#).unwrap();
        let error = read_artifact(&other_path).unwrap_err();
        assert_eq!(error.kind, ErrorKind::Protocol);
        assert!(
            error.message.contains("not a lucida trace run file"),
            "{}",
            error.message
        );

        std::fs::remove_dir_all(&dir).unwrap();
    }

    /// The driver hands the page its screenshot as the fallback frame, never
    /// as the frame, and asks for the run it waited for. The frame rides as
    /// JSON the encoder quoted, and the projection is off unless the caller
    /// asked.
    #[test]
    fn the_bundle_export_hands_the_page_the_drivers_screenshot_as_the_fallback_frame() {
        let frame = BundleFrame::from_driver(&[1, 2, 3], Viewport::new(1440, 900, 2.0));
        assert_eq!(frame.png, "AQID");
        assert_eq!((frame.width, frame.height), (2880, 1800));
        assert_eq!(frame.device_pixel_ratio, Some(2.0));
        assert_eq!(frame.captured_by, "driver");
        assert_eq!(frame.fallback_reason, None);
        assert_eq!(frame.describe()["pngBytes"], 3);
        assert!(frame.describe().get("fallbackReason").is_none());

        let expression = bundle_export_expression(&frame, false);
        assert!(expression.contains(r#""png":"AQID""#), "{expression}");
        assert!(
            expression.contains(r#""capturedBy":"driver""#),
            "{expression}"
        );
        assert!(
            expression.contains(r#"fallbackFrame: {"png":"AQID""#),
            "{expression}"
        );
        assert!(!expression.contains(" frame: {"), "{expression}");
        assert!(!expression.contains("fallbackReason"), "{expression}");
        assert!(expression.contains("perfetto: false"), "{expression}");
        assert!(expression.contains("__lucidaTraceRunId"), "{expression}");
        assert!(expression.contains("seam.exportBundle("), "{expression}");
        assert!(bundle_export_expression(&frame, true).contains("perfetto: true"));
        // The script the run export filled in on the page rides into the
        // bundle, so both files carry the same steps.
        assert!(
            expression.contains("const script = window.__lucidaTraceScript || null;"),
            "{expression}"
        );
        assert!(
            expression.contains("perfetto: false, script }"),
            "{expression}"
        );
    }

    /// A driven script lands in the run file's header as the page filled it
    /// in: each step's run, cause, end reason, and verdict come from the
    /// export, and the gate reads every step, not only the last.
    #[test]
    fn the_run_file_carries_the_script_and_the_gate_reads_every_step() {
        let step = |kind: &str, run_id: Option<&str>, verdict: Value| {
            json!({
                "kind": kind, "theta": 30, "phi": 0, "axis": "t", "count": 1,
                "startedAtMs": 1000.0, "endedAtMs": 2400.0,
                "runId": run_id,
                "cause": run_id.map(|_| json!({ "epoch": "view", "dirtyKind": "interactive", "source": kind })),
                "endReason": run_id.map(|_| "quiescent"),
                "durationUs": run_id.map(|_| 1_300_000.0),
                "verdict": verdict,
                "timedOut": false,
                "viewBefore": { "camera": { "mode": "arcball", "theta": 0.1 } },
                "viewAfter": { "camera": { "mode": "arcball", "theta": 0.6 } },
                "viewChanged": true
            })
        };
        let export: SeamExport = serde_json::from_str(
            &json!({
                "schemaVersion": 1,
                "runId": "run-7-4",
                "quiescenceHoldMs": 500,
                "endReason": "quiescent",
                "diagnostic": { "verdict": { "kind": "clear", "text": "fine" } },
                "summary": "lucida trace run-7-4 — VERDICT: fine",
                "phases": "CRITICAL PATH",
                "script": { "steps": [
                    step("wait", None, Value::Null),
                    step("orbit", Some("run-7-3"), json!({ "kind": "fail", "text": "frame time over the ceiling" })),
                    step("scrub", Some("run-7-4"), json!({ "kind": "clear", "text": "fine" })),
                ] },
                "trace": { "runs": [] }
            })
            .to_string(),
        )
        .unwrap();

        let file = assemble_run_file(export, &facts());
        let script = file
            .header
            .script
            .as_ref()
            .expect("the header carries the script");
        assert_eq!(script.steps.len(), 3);
        assert_eq!(script.steps[1].run_id.as_deref(), Some("run-7-3"));
        assert_eq!(script.steps[1].cause.as_ref().unwrap()["source"], "orbit");
        assert_eq!(script.steps[1].end_reason.as_deref(), Some("quiescent"));
        assert_eq!(script.last_run_id(), Some("run-7-4"));
        assert!(file.header.settled);
        assert_eq!(
            gate_failure(&file).as_deref(),
            Some("step 2 (orbit 30°,0°) fail: frame time over the ceiling")
        );

        let text = format_run_human(&file, Path::new("/tmp/run.json"), None);
        assert!(text.contains("steps     3: wait, orbit, scrub\n"), "{text}");
        assert!(text.contains("run run-7-3 (orbit) · quiescent"), "{text}");
        assert!(text.contains("verdict fail"), "{text}");

        let json = serde_json::to_string(&file).unwrap();
        let back = parse_run_file(&json, Path::new("run.json")).unwrap();
        assert_eq!(back.header.script, file.header.script);
    }

    /// A run driven without a script has no `script` key, so a reader never
    /// has to tell an empty script from none, and a bundle the monitor saved
    /// reads with `script: null`.
    #[test]
    fn a_run_without_a_script_omits_the_key_and_a_bundle_says_what_it_ran() {
        let file = run_file(json!({ "verdict": { "kind": "clear" } }), true, "quiescent");
        let json = serde_json::to_value(&file).unwrap();
        assert!(json["header"].get("script").is_none());
        assert!(!format_run_human(&file, Path::new("/tmp/run.json"), None).contains("steps"));

        let mut bundle = golden_bundle();
        assert!(bundle.script.is_none());
        let text = format_bundle_human(&bundle, Path::new("/tmp/b.json"), "");
        assert!(!text.contains("script    "), "{text}");

        let scripted: ScriptRecord = serde_json::from_value(json!({ "steps": [
            { "kind": "wait", "startedAtMs": 0.0, "endedAtMs": 1.0, "runId": null,
              "timedOut": false, "viewBefore": null, "viewAfter": null, "viewChanged": false },
            { "kind": "orbit", "theta": 30, "phi": 0, "startedAtMs": 1.0, "endedAtMs": 2.0,
              "runId": "run-2", "timedOut": false, "viewBefore": null, "viewAfter": null, "viewChanged": true }
        ] }))
        .unwrap();
        bundle.script = Some(scripted);
        let text = format_bundle_human(&bundle, Path::new("/tmp/b.json"), "");
        assert!(
            text.contains("script    2 step(s): wait, orbit\n"),
            "{text}"
        );
        let json = serde_json::to_string(&bundle).unwrap();
        let back = parse_bundle(&json, Path::new("b.json")).unwrap();
        assert_eq!(back.script, bundle.script);
    }

    #[test]
    fn the_run_export_fills_each_steps_run_in_from_the_document_it_exported() {
        let expression = run_export_expression(false);
        assert!(
            expression.contains("window.__lucidaTraceScript"),
            "{expression}"
        );
        assert!(
            expression.contains("runs.find(r => r.header.runId === step.runId)"),
            "{expression}"
        );
        assert!(
            expression.contains("seam.diagnoseTrace(trace, { runId: step.runId })"),
            "{expression}"
        );
        assert!(
            expression.contains("    script,\n    trace\n"),
            "{expression}"
        );
    }

    /// A bundle from a page that recorded no run has a header with little in
    /// it. The text names the replay inputs it lacks, by the spec's words.
    #[test]
    fn a_bundle_with_no_run_names_the_replay_inputs_its_header_lacks() {
        let mut bundle = golden_bundle();
        bundle.header.run_id = None;
        bundle.header.datasets.clear();
        bundle.header.view_url = None;
        bundle.header.viewport = None;
        bundle.header.device_pixel_ratio = None;
        bundle.header.mode = None;
        bundle.header.pins.clear();
        bundle.header.build = None;
        bundle.header.gpu = None;
        bundle.header.cache_warmth = Value::Null;

        assert_eq!(
            missing_replay_inputs(&bundle.header),
            vec![
                "dataset",
                "view URL",
                "viewport",
                "device pixel ratio",
                "slice or volume mode",
                "level, render mode, contrast, and colormap pins",
                "build",
                "adapter",
                "cache warmth",
            ]
        );
        assert!(missing_replay_inputs(&golden_bundle().header).is_empty());

        let human = format_bundle_human(&bundle, Path::new("b.json"), "text");
        assert!(human.contains("run       no run recorded"), "{human}");
        assert!(
            human.contains("replay    the header lacks: dataset, view URL, viewport"),
            "{human}"
        );
    }

    #[test]
    fn the_default_rendering_names_the_bundle_when_one_was_written() {
        let file = run_file(json!({}), true, "quiescent");
        let with = format_run_human(
            &file,
            Path::new("run.json"),
            Some(Path::new("/tmp/out.bundle.json")),
        );
        assert!(with.contains("bundle    /tmp/out.bundle.json"), "{with}");
        let without = format_run_human(&file, Path::new("run.json"), None);
        assert!(!without.contains("bundle    "), "{without}");
    }

    #[test]
    fn the_perfetto_summary_reads_the_file_back_rather_than_restating_it() {
        let json = json!({
            "traceEvents": [{ "ph": "X" }, { "ph": "X" }],
            "otherData": { "syntheticValues": ["upload end"], "derivedValues": ["wall clock"] }
        })
        .to_string();

        let capture = summarise_chrome_trace(&json, Some("timeout".to_string())).unwrap();
        assert_eq!(capture.events, 2);
        assert_eq!(capture.synthetic_values, vec!["upload end".to_string()]);
        assert!(!capture.settled);
        let human = format_chrome_trace_human("out.json", &capture);
        assert!(human.contains("ui.perfetto.dev"));
        assert!(human.contains("closed as a timeout"));

        // The end reason comes out of the projection's own header.
        let settled = json!({
            "traceEvents": [],
            "otherData": { "runs": [{ "endReason": "quiescent" }] }
        })
        .to_string();
        assert_eq!(
            chrome_trace_end_reason(&settled).as_deref(),
            Some("quiescent")
        );
        assert!(
            summarise_chrome_trace(&settled, chrome_trace_end_reason(&settled))
                .unwrap()
                .settled
        );
    }

    /// A 64 × 512 × 512 volume with four levels halving every axis, in 32³
    /// chunks: the shape of the level-index pyramid the end-to-end check
    /// generates.
    fn document_with_volume() -> DocumentState {
        let level = |index: u32, z: u64, yx: u64| {
            json!({
                "level_index": index,
                "shape": [1, 1, z, yx, yx],
                "chunk_shape": [1, 1, 32, 32, 32],
                "grid_shape": [1, 1, z.div_ceil(32), yx.div_ceil(32), yx.div_ceil(32)],
                "scale": [1.0, 1.0, 1.0, 1.0, 1.0]
            })
        };
        serde_json::from_value(json!({
            "manifests": {
                "wds-vol": {
                    "dataset_id": "wds-vol",
                    "name": "volume.zarr",
                    "kind": "Single",
                    "entities": [
                        { "id": "entity-v", "kind": "Image", "parent": null, "labels": { "name": "volume" } }
                    ],
                    "transforms": [],
                    "images": [{
                        "image_id": "image-v",
                        "owner": "entity-v",
                        "multiscale": {
                            "axes": [],
                            "levels": [level(0, 64, 512), level(1, 32, 256), level(2, 16, 128), level(3, 8, 64)],
                            "coarse_level_index": null,
                            "generated_levels": [],
                            "data_type": "Uint16",
                            "pinned_axes": []
                        }
                    }],
                    "source_layouts": [],
                    "default_layout_id": null
                }
            },
            "registered_layouts": {},
            "active_layout_ids": {}
        }))
        .unwrap()
    }

    /// The default viewport at device pixel ratio 2.
    const RETINA: [u32; 2] = [2880, 1800];

    fn volume_id() -> DatasetId {
        DatasetId("wds-vol".to_string())
    }

    fn compose(kind: CameraKind, zoom: Option<f64>) -> ComposedFraming {
        compose_camera(
            &document_with_volume(),
            &volume_id(),
            RETINA,
            CameraRequest { kind, zoom },
        )
        .unwrap()
    }

    /// A slice camera spaces its samples exactly `zoom` device pixels apart,
    /// so the rule reads the zoom directly; the frame is the image's middle.
    #[test]
    fn a_slice_camera_frames_the_image_and_realizes_the_zoom() {
        let framing = compose(CameraKind::Slice, Some(2.0));
        let Camera::Slice(slice) = &framing.camera else {
            panic!("expected a slice camera, got {:?}", framing.camera)
        };
        assert_eq!(slice.zoom, 2.0);
        assert_eq!(slice.center, [256.0, 256.0]);
        assert_eq!(
            framing.record,
            ComposedCamera {
                mode: CameraKind::Slice,
                zoom: 2.0,
                target_level: LevelRange { min: 0, max: 0 },
            }
        );
    }

    /// Two pixels per sample oversamples level 0. At 0.177 pixels per sample
    /// level 2 is the coarsest that still fills every pixel (0.177 × 4 ≤ 1 <
    /// 0.177 × 8), and at 0.08 even level 3 does (0.08 × 8 ≤ 1).
    #[test]
    fn the_recorded_target_is_the_rules_answer_for_the_zoom() {
        assert_eq!(
            compose(CameraKind::Slice, Some(0.177)).record.target_level,
            LevelRange { min: 2, max: 2 }
        );
        assert_eq!(
            compose(CameraKind::Slice, Some(0.08)).record.target_level,
            LevelRange { min: 3, max: 3 }
        );
    }

    /// A volume camera has no zoom of its own. The driver moves the orbit
    /// distance until the center ray meets the volume at the asked pixels
    /// per sample, so the rule sees the same measure in either mode.
    #[test]
    fn an_arcball_camera_realizes_the_zoom_where_the_center_ray_meets_the_volume() {
        for (zoom, level) in [(2.0, 0), (0.177, 2), (0.08, 3)] {
            let framing = compose(CameraKind::Arcball, Some(zoom));
            assert!(matches!(framing.camera, Camera::Arcball(_)));
            assert!(
                (framing.record.zoom - zoom).abs() <= zoom * 1e-6,
                "zoom {zoom}: the camera measures {}",
                framing.record.zoom
            );
            assert_eq!(
                framing.record.target_level,
                LevelRange {
                    min: level,
                    max: level
                },
                "zoom {zoom}"
            );
        }
    }

    /// Without a zoom the camera is the fit the page would make, and the
    /// record still says what that framing measures and calls for.
    #[test]
    fn without_a_zoom_the_camera_is_the_fit_and_the_record_still_measures_it() {
        let slice = compose(CameraKind::Slice, None);
        let Camera::Slice(camera) = &slice.camera else {
            panic!("expected a slice camera")
        };
        assert_eq!(camera.center, [256.0, 256.0]);
        assert_eq!(slice.record.zoom, camera.zoom);
        assert!(slice.record.zoom.is_finite() && slice.record.zoom > 0.0);

        let arcball = compose(CameraKind::Arcball, None);
        assert!(arcball.record.zoom.is_finite() && arcball.record.zoom > 0.0);
        assert!(arcball.record.target_level.min <= arcball.record.target_level.max);
        assert!(arcball.record.target_level.max <= 3);
    }

    #[test]
    fn a_camera_needs_a_dataset_the_workspace_holds_and_a_positive_zoom() {
        let missing = compose_camera(
            &document_with_volume(),
            &DatasetId("wds-none".to_string()),
            RETINA,
            CameraRequest {
                kind: CameraKind::Slice,
                zoom: None,
            },
        )
        .unwrap_err();
        assert_eq!(missing.kind, ErrorKind::MissingResource);

        for zoom in [0.0, -1.0, f64::NAN, f64::INFINITY] {
            let error = compose_camera(
                &document_with_volume(),
                &volume_id(),
                RETINA,
                CameraRequest {
                    kind: CameraKind::Slice,
                    zoom: Some(zoom),
                },
            )
            .unwrap_err();
            assert_eq!(error.kind, ErrorKind::Config, "zoom {zoom}");
        }
    }

    #[test]
    fn the_channel_count_is_read_off_level_0() {
        assert_eq!(channel_count(&document_with_volume(), &volume_id()), 1);
        assert_eq!(
            channel_count(&document_with_volume(), &DatasetId("wds-none".to_string())),
            1
        );
    }

    #[test]
    fn a_contrast_window_is_two_ordered_finite_numbers() {
        assert_eq!(contrast_window(&[1.0, 3.0]).unwrap(), (1.0, 3.0));
        for bad in [&[3.0, 1.0][..], &[2.0, 2.0], &[f64::NAN, 1.0], &[1.0]] {
            assert_eq!(contrast_window(bad).unwrap_err().kind, ErrorKind::Config);
        }
    }

    /// Pinning the window turns the page's fit off, because the fit samples
    /// whatever is resident when it runs and would overwrite the pin, and it
    /// writes every channel, because a channel's own window wins over the
    /// dataset's.
    #[test]
    fn pinning_the_contrast_window_turns_auto_contrast_off_and_writes_every_channel() {
        let id = volume_id();
        let mut view = compose_dataset_view("gs://bucket/set.zarr", 1440, 900, None);
        pin_display(
            &mut view,
            &id,
            2,
            &[],
            DisplayPins {
                contrast: Some((1.0, 3.0)),
                ..Default::default()
            },
        );

        assert_eq!(view.auto_contrast.get(&id), Some(&false));
        let settings = &view.dataset_settings[&id];
        assert_eq!((settings.contrast_min, settings.contrast_max), (1.0, 3.0));
        assert_eq!(settings.channel_settings.len(), 2);
        let defaults = Colormap::defaults_for_channels(2, &[]);
        for (channel, default) in settings.channel_settings.iter().zip(defaults) {
            assert_eq!((channel.contrast_min, channel.contrast_max), (1.0, 3.0));
            assert_eq!(channel.colormap, default);
        }
        assert!(settings.visible);
        assert_eq!(settings.render_mode, RenderMode::Translucent);
        assert_eq!(settings.detail_level_override, None);
    }

    /// A pinned window keeps each channel in the colormap the page opens it
    /// with: its declared color, else the first colormap no channel holds.
    #[test]
    fn a_pinned_window_keeps_the_colormaps_the_dataset_declares() {
        let id = volume_id();
        let mut view = compose_dataset_view("gs://bucket/set.zarr", 1440, 900, None);
        let declared = [
            ChannelInfo {
                label: "a".into(),
                color: Some("00FFFF".into()),
            },
            ChannelInfo {
                label: "b".into(),
                color: None,
            },
        ];
        pin_display(
            &mut view,
            &id,
            2,
            &declared,
            DisplayPins {
                contrast: Some((1.0, 3.0)),
                ..Default::default()
            },
        );

        let colormaps: Vec<Colormap> = view.dataset_settings[&id]
            .channel_settings
            .iter()
            .map(|channel| channel.colormap)
            .collect();
        assert_eq!(colormaps, [Colormap::Cyan, Colormap::Magenta]);
    }

    #[test]
    fn a_colormap_and_a_render_mode_pin_without_touching_the_window() {
        let id = volume_id();
        let mut view = compose_dataset_view("gs://bucket/set.zarr", 1440, 900, None);
        pin_display(
            &mut view,
            &id,
            3,
            &[],
            DisplayPins {
                colormap: Some(Colormap::Gray),
                render_mode: Some(RenderMode::MaxIntensity),
                ..Default::default()
            },
        );

        let settings = &view.dataset_settings[&id];
        assert_eq!(settings.render_mode, RenderMode::MaxIntensity);
        assert_eq!(settings.channel_settings.len(), 3);
        assert!(
            settings
                .channel_settings
                .iter()
                .all(|channel| channel.colormap == Colormap::Gray)
        );
        assert!(
            settings
                .channel_settings
                .iter()
                .all(|channel| (channel.contrast_min, channel.contrast_max) == (0.0, 65535.0))
        );
        assert!(
            view.auto_contrast.is_empty(),
            "the window still follows the data"
        );
    }

    #[test]
    fn empty_pins_leave_the_view_alone() {
        let mut view = compose_dataset_view("gs://bucket/set.zarr", 1440, 900, None);
        pin_display(&mut view, &volume_id(), 1, &[], DisplayPins::default());
        assert!(view.dataset_settings.is_empty());
        assert!(view.auto_contrast.is_empty());
    }

    /// Level 0 is a pin like any other, so a run can hold the view at full
    /// resolution however the camera moves.
    #[test]
    fn a_level_pin_rides_the_view_and_level_0_is_one_of_them() {
        let id = volume_id();
        for level in [0, 2] {
            let mut view = compose_dataset_view("gs://bucket/set.zarr", 1440, 900, None);
            pin_display(
                &mut view,
                &id,
                1,
                &[],
                DisplayPins {
                    level: Some(level),
                    ..Default::default()
                },
            );
            assert_eq!(
                view.dataset_settings[&id].detail_level_override,
                Some(level)
            );
        }
    }

    /// The frame and the composed camera are the driver's facts, so the header
    /// names them beside the view they belong to. A run driven without them
    /// carries no key at all, rather than a null a reader has to distinguish
    /// from "not written".
    #[test]
    fn the_header_names_the_screenshot_and_the_camera_and_omits_them_otherwise() {
        let export = || -> SeamExport {
            serde_json::from_str(
                &json!({ "schemaVersion": 1, "runId": "run-3-1", "quiescenceHoldMs": 500,
                         "endReason": "quiescent", "diagnostic": null, "summary": "ok",
                         "phases": "ok", "trace": { "runs": [] } })
                .to_string(),
            )
            .unwrap()
        };
        let camera = ComposedCamera {
            mode: CameraKind::Arcball,
            zoom: 0.08,
            target_level: LevelRange { min: 3, max: 3 },
        };

        let with = DriverFacts {
            composed_view: ComposedView {
                camera: Some(camera.clone()),
                ..composed()
            },
            screenshot: Some(PathBuf::from("/tmp/levels/volume-out.png")),
            ..facts()
        };
        let file = assemble_run_file(export(), &with);
        assert_eq!(
            file.header.screenshot.as_deref(),
            Some(Path::new("/tmp/levels/volume-out.png"))
        );
        assert_eq!(file.header.composed_view.camera, Some(camera));
        let json = serde_json::to_value(&file).unwrap();
        assert_eq!(json["header"]["screenshot"], "/tmp/levels/volume-out.png");
        assert_eq!(json["header"]["composedView"]["camera"]["mode"], "arcball");
        assert_eq!(json["header"]["composedView"]["camera"]["zoom"], 0.08);
        assert_eq!(
            json["header"]["composedView"]["camera"]["targetLevel"],
            json!({ "min": 3, "max": 3 })
        );
        let human = format_run_human(&file, Path::new("run.json"), None);
        assert!(human.contains("/tmp/levels/volume-out.png"), "{human}");
        assert!(human.contains("arcball"), "{human}");
        assert!(human.contains("target level 3"), "{human}");

        let without = assemble_run_file(export(), &facts());
        assert_eq!(without.header.screenshot, None);
        assert_eq!(without.header.composed_view.camera, None);
        let json = serde_json::to_value(&without).unwrap();
        assert!(json["header"].get("screenshot").is_none());
        assert!(json["header"]["composedView"].get("camera").is_none());
    }

    fn recorded_error(source: &str, message: &str, page_ms: f64, at_us: Option<f64>) -> Value {
        json!({
            "atUs": at_us, "pageMs": page_ms, "source": source, "message": message,
            "location": "/assets/index.js:1:2", "count": 1, "allowed": null
        })
    }

    fn export_with_errors(trace: Value, steps: Option<Value>) -> SeamExport {
        let mut export = json!({
            "runId": "run-1-2",
            "endReason": "quiescent",
            "diagnostic": { "verdict": { "kind": "clear", "text": "fine" } },
            "summary": "s", "phases": "p", "spatial": "x",
            "trace": trace
        });
        if let Some(steps) = steps {
            export["script"] = json!({ "steps": steps });
        }
        serde_json::from_value(export).unwrap()
    }

    fn pan_step(started_at_ms: f64, run_id: &str) -> Value {
        json!({
            "kind": "pan", "dx": 120, "dy": 60,
            "startedAtMs": started_at_ms, "endedAtMs": started_at_ms + 900.0,
            "runId": run_id, "endReason": "quiescent",
            "verdict": { "kind": "clear", "text": "fine" },
            "timedOut": false, "viewBefore": {}, "viewAfter": {}, "viewChanged": true
        })
    }

    /// The run file lists every interval's errors, and the errors raised
    /// with none open, oldest first, each with the step whose start came
    /// before it on the page's clock.
    #[test]
    fn the_run_file_lists_every_intervals_errors_with_the_step_each_fell_in() {
        let trace = json!({
            "runs": [
                { "header": { "runId": "run-1-1" }, "errors": [recorded_error("console", "late in the open", 900.0, Some(400_000.0))] },
                { "header": { "runId": "run-1-2" }, "errors": [recorded_error("exception", "during the pan", 2_100.0, Some(60_000.0))] }
            ],
            "steadyState": [
                { "header": { "runId": "steady-1-3" }, "errors": [recorded_error("rejection", "between", 2_000.0, Some(12_345.0))] }
            ],
            "errorsOutsideRun": [recorded_error("console", "at startup", 10.0, None)]
        });
        let file = assemble_run_file(
            export_with_errors(trace, Some(json!([pan_step(1_950.0, "run-1-2")]))),
            &facts(),
        );
        let listed: Vec<_> = file
            .header
            .errors
            .iter()
            .map(|error| {
                (
                    error.interval.as_deref(),
                    error.at_ms,
                    error.step,
                    error.message.as_str(),
                )
            })
            .collect();
        assert_eq!(
            listed,
            vec![
                (None, None, None, "at startup"),
                (Some("run-1-1"), Some(400.0), None, "late in the open"),
                (Some("steady-1-3"), Some(12.3), Some(1), "between"),
                (Some("run-1-2"), Some(60.0), Some(1), "during the pan"),
            ]
        );

        let json = serde_json::to_string(&file).unwrap();
        let back = parse_run_file(&json, Path::new("run.json")).unwrap();
        assert_eq!(back.header.errors, file.header.errors);
    }

    /// Any error the allow list does not name fails the gate, wherever it
    /// fell, and the reason lists them. An allowed one fails nothing, and a
    /// run file without errors carries no key for them.
    #[test]
    fn the_gate_fails_on_an_error_the_allow_list_does_not_name() {
        let mut allowed = recorded_error("console", "known noise", 500.0, Some(1_000.0));
        allowed["allowed"] = json!("a library logs it on every start");
        let trace = json!({
            "runs": [{ "header": { "runId": "run-1-2" }, "errors": [allowed] }],
            "steadyState": [{ "header": { "runId": "steady-1-3" }, "errors": [
                recorded_error("exception", "Uncaught Error: boom", 2_000.0, Some(5_000.0))
            ] }]
        });
        let file = assemble_run_file(export_with_errors(trace.clone(), None), &facts());
        assert_eq!(
            gate_failure(&file).as_deref(),
            Some(
                "the page raised 1 error(s): before any step, 5 ms into its interval: \
                 exception: Uncaught Error: boom at /assets/index.js:1:2"
            )
        );
        let text = format_run_human(&file, Path::new("run.json"), None);
        assert!(
            text.contains("errors    2 raised, 1 on the allow list\n"),
            "{text}"
        );
        assert!(
            text.contains("console: known noise at /assets/index.js:1:2 [allowed: a library logs it on every start]"),
            "{text}"
        );

        let mut only_allowed = trace;
        only_allowed["steadyState"] = json!([]);
        let file = assemble_run_file(export_with_errors(only_allowed, None), &facts());
        assert_eq!(gate_failure(&file), None);

        let clean = assemble_run_file(minimal_export(), &facts());
        assert!(clean.header.errors.is_empty());
        let json = serde_json::to_value(&clean).unwrap();
        assert!(json["header"].get("errors").is_none());
    }

    /// The driver reads the settled frame through the page's own capture
    /// before the export derives the diagnostic, and a page too old to read
    /// it is left alone.
    #[test]
    fn the_frame_read_asks_the_page_for_the_run_the_driver_waited_for() {
        assert!(FRAME_READ_EXPRESSION.contains("seam.readFrame(waited)"));
        assert!(FRAME_READ_EXPRESSION.contains("seam.readPageScroll(waited)"));
        assert!(FRAME_READ_EXPRESSION.contains("seam.readChrome(waited)"));
        assert!(FRAME_READ_EXPRESSION.contains("__lucidaTraceRunId"));
        assert!(FRAME_READ_EXPRESSION.contains("typeof seam.readFrame !== 'function'"));
    }
}
