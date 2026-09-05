//! `lucida trace`: an agent measures an open with no human present.
//!
//! The command drives headless Chrome itself and reads the trace off the page
//! seam (ADR 0051). It fetches no trace from the server, because the server
//! pushes its rows to the browser (ADR 0050) and the document handed back is
//! already merged — there is deliberately no server-side trace endpoint to ask.
//!
//! Everything diagnostic happens behind the seam. Thresholds, the attribution
//! back-walk and the verdict are the page's, and both renderings are the page's
//! renderer; this module composes the workload, records what only the driver
//! knows (the composed view, the hold window, server warmth), persists the run
//! and prints what it was handed. A verdict computed here would quietly make an
//! agent driving its own browser a second-class citizen.
//!
//! `lucida debug state` is not this pipe and is left alone: it opens a socket to
//! the *server*, computes its answer inside the CLI and reaches no renderer.

use std::path::{Path, PathBuf};
use std::time::Duration;

use futures_util::StreamExt;
use lucida_core::DatasetId;
use lucida_core::camera::Camera;
use lucida_core::saved_view::{SavedView, normalize_dataset_url};
use lucida_core::scene::{Colormap, DatasetDisplaySettings, DocumentState, RenderMode, Scene};
use lucida_core::transform::VolumeTransform;
use lucida_protocol::{DatasetSourceCacheStats, DatasetSourceHealth};
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::browser::{self, Viewport};
use crate::credentials::EffectiveToken;
use crate::error::{CliError, ErrorKind};
use crate::session::{connect_workspace_socket, incoming_messages, wait_for_workspace_snapshot};

/// The run file's own version, independent of the trace schema it carries.
/// A reader that does not know this number should say so rather than guess.
pub const RUN_FILE_VERSION: u32 = 1;

/// A representative window rather than a capture cell: the viewport is part of
/// the workload, not an output-image size.
pub const DEFAULT_WIDTH: u32 = 1440;
pub const DEFAULT_HEIGHT: u32 = 900;

/// Device pixel ratio defaults to 2 because that is the condition under which
/// the defects this monitor exists to find actually appear — DPR 2 quadruples
/// the pixels the pipeline must fill, and DPR-1-only verification has hidden
/// whole defect classes in this project more than once.
pub const DEFAULT_DEVICE_PIXEL_RATIO: f64 = 2.0;

/// Only used when the page is too old to publish one; the page's own value wins.
pub const DEFAULT_QUIESCENCE_HOLD_MS: f64 = 500.0;

const CHROME_TRACE_EXPORT_EXPRESSION: &str =
    "window.lucidaTrace ? window.lucidaTrace.exportChromeTrace() : null";

/// Close a run the driver gave up on as what it was. `explicit` would claim
/// somebody asked for the document; the end reason is the field a later reader
/// trusts about whether the page ever finished.
const CLOSE_AS_TIMEOUT: &str =
    "window.lucidaTrace ? (window.lucidaTrace.closeRun('timeout'), true) : false";

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
  if (runId && diagnostic) {
    for (const phase of diagnostic.phases || []) {
      perPhase[phase.id] = render(() => seam.diagnoseText(runId, { depth: 'phase', phase: phase.id }));
    }
  }
  return JSON.stringify({
    schemaVersion: seam.schemaVersion,
    runId,
    quiescenceHoldMs: seam.quiescenceHoldMs,
    endReason: run ? run.header.endReason : null,
    diagnostic,
    summary: runId ? render(() => seam.diagnoseText(runId)) : null,
    phases: runId ? render(() => seam.diagnoseText(runId, { depth: 'phases' })) : null,
    perPhase,
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

/// The window the run was driven in, recorded because "cold open of dataset X"
/// is not a reproducible workload without it.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ComposedView {
    /// The dataset as opened, in canonical form (ADR 0042).
    pub dataset: String,
    /// The URL the driver navigated to, view fragment and all.
    pub url: String,
    pub width: u32,
    pub height: u32,
    pub device_pixel_ratio: f64,
    /// The camera the driver composed, when the caller asked for one rather
    /// than the page's own framing, and the level the core says it calls for.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub camera: Option<ComposedCamera>,
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
    /// number holds it at that level however the camera moves. Pinning to
    /// level 0 is how a run measures the behavior ADR 0061 replaced.
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
/// A browser-cold open can run against an arbitrarily warm server — a repeat
/// open measured 5.8 s against 0.02 s through the source cache (#902) — so
/// without this two runs are incomparable *and look comparable*, which is worse
/// than being obviously incomparable. Browser-side warmth is the page's own
/// header field and is not restated here.
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
    pub server_warmth: ServerWarmth,
    pub server_url: String,
    pub workspace_id: String,
    /// The settled frame, when the caller asked for one: a PNG of the page
    /// at the composed view's device pixel ratio, taken after the wait and
    /// before the export. A run that never settled still gets its frame,
    /// because what the page showed at the deadline is part of the finding.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub screenshot: Option<PathBuf>,
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
    /// The full ADR 0047 document the diagnostic was derived from.
    pub trace: Value,
}

/// What the page handed back in one evaluation.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SeamExport {
    run_id: Option<String>,
    quiescence_hold_ms: Option<f64>,
    end_reason: Option<String>,
    diagnostic: Option<Value>,
    summary: Option<String>,
    phases: Option<String>,
    #[serde(default)]
    per_phase: std::collections::BTreeMap<String, String>,
    /// Present only when the caller asked for the raw-span file.
    #[serde(default)]
    chrome_trace: Option<String>,
    trace: Value,
}

/// Which reading of a persisted run to print.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ShowDepth {
    Summary,
    Phases,
    /// One phase, selected out of the document by id.
    Phase(String),
}

// ---------------------------------------------------------------------------
// Composing the workload
// ---------------------------------------------------------------------------

/// The view the driver opens: one dataset, nothing else, at the run's viewport.
///
/// Composed rather than borrowed from a viewer profile, because a run has to be
/// reproducible from the command that produced it. The camera is left at the
/// default so the page's own fit-on-open decides the framing, exactly as it
/// would for a person opening the same URL.
///
/// `pin_contrast_for` names the dataset whose contrast window is to stay at
/// its default rather than being fitted to the data as it arrives. The fit
/// samples whatever is resident when it runs, so two runs of one dataset can
/// draw the same data a level apart; a frame that is to be compared with
/// another run's needs the window pinned.
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
/// of its `channel_count` channels.
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
        for index in 0..channel_count.max(1) {
            let channel = settings.ensure_channel(index);
            channel.colormap = pins
                .colormap
                .unwrap_or_else(|| Colormap::default_for_channel(index));
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
    scene.document = document.clone();
    crate::view::hydrate_scene_document_defaults(&mut scene);
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
    if let Some(zoom) = request.zoom {
        match &mut scene.camera {
            Camera::Slice(slice) => slice.set_zoom(zoom),
            _ => realize_volume_zoom(&mut scene, dataset_id, zoom)?,
        }
    }

    let zoom = measure_zoom(&scene, dataset_id).ok_or_else(|| {
        CliError::new(
            ErrorKind::MissingResource,
            format!("dataset {} has no image to measure", dataset_id.0),
        )
    })?;
    let levels: Vec<u32> = scene
        .view_query(dataset_id)
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
        camera: scene.camera.clone(),
        record: ComposedCamera {
            mode: request.kind,
            zoom,
            target_level: LevelRange { min, max },
        },
    })
}

/// Device pixels per level-0 sample of the dataset's first image under the
/// scene's camera: the measure the view query hands the level rule.
fn measure_zoom(scene: &Scene, dataset_id: &DatasetId) -> Option<f64> {
    let member = scene
        .derived
        .get(dataset_id)?
        .members
        .iter()
        .find(|member| !member.levels.is_empty())?;
    let level0 = &member.levels[0];
    let (forward, inverse) = scene.rendering_transform(member);
    let placed = VolumeTransform {
        model: forward.model,
        inv_model: inverse.inv_model,
        max_physical_extent: forward.max_physical_extent,
    };
    Some(scene.camera.pixels_per_sample(
        &placed,
        [
            level0.shape[2] as u32,
            level0.shape[3] as u32,
            level0.shape[4] as u32,
        ],
    ))
}

/// Move the arcball camera until the center ray meets the volume at `zoom`
/// device pixels per level-0 sample.
///
/// The measure falls off as `k / (distance − t)`: the center ray enters the
/// volume `t` world units in front of the orbit target whatever the distance,
/// and `k` is the camera's perspective scale over the volume's sample
/// density. Two measures pin `k` and `t`, and the third solves for the
/// distance that gives the asked zoom. The clip planes are rebuilt around
/// the new distance so the volume is neither clipped nor starved of depth.
fn realize_volume_zoom(
    scene: &mut Scene,
    dataset_id: &DatasetId,
    zoom: f64,
) -> Result<(), CliError> {
    let cannot = |why: String| {
        CliError::config(format!(
            "cannot place the volume camera at {zoom} device pixels per level-0 sample: {why}"
        ))
    };
    let Camera::Arcball(arcball) = &scene.camera else {
        return Err(cannot("the camera is not an arcball".to_string()));
    };
    let d1 = arcball.distance;
    let d2 = d1 * 2.0;
    let p1 = measure_zoom(scene, dataset_id)
        .ok_or_else(|| cannot("the dataset has no image".to_string()))?;
    if let Camera::Arcball(arcball) = &mut scene.camera {
        arcball.distance = d2;
    }
    let p2 = measure_zoom(scene, dataset_id)
        .ok_or_else(|| cannot("the dataset has no image".to_string()))?;
    if !(p1.is_finite() && p2.is_finite() && p1 > p2 && p2 > 0.0) {
        return Err(cannot(
            "the center ray does not meet the volume".to_string(),
        ));
    }

    let t = (p1 * d1 - p2 * d2) / (p1 - p2);
    let k = p1 * (d1 - t);
    let distance = t + k / zoom;
    if !(distance.is_finite() && distance > t && distance > 0.0) {
        return Err(cannot("no orbit distance reaches it".to_string()));
    }
    let radius = scene
        .dataset_world_bounds(&dataset_id.0)
        .map(|(min, max)| {
            0.5 * ((max[0] - min[0]).powi(2)
                + (max[1] - min[1]).powi(2)
                + (max[2] - min[2]).powi(2))
            .sqrt()
        })
        .unwrap_or(1.0);
    if let Camera::Arcball(arcball) = &mut scene.camera {
        arcball.distance = distance;
        arcball.near = (distance - radius).max(distance * 1e-3).max(1e-4);
        arcball.far = (distance + radius) * 1.05;
    }

    let realized = measure_zoom(scene, dataset_id)
        .ok_or_else(|| cannot("the dataset has no image".to_string()))?;
    if (realized - zoom).abs() > zoom * 1e-6 {
        return Err(cannot(format!("the camera measures {realized} there")));
    }
    Ok(())
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

// ---------------------------------------------------------------------------
// Where a run lands
// ---------------------------------------------------------------------------

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

pub fn read_run_file(path: &Path) -> Result<TraceRunFile, CliError> {
    let text = std::fs::read_to_string(path).map_err(|error| {
        CliError::new(
            ErrorKind::MissingResource,
            format!("no trace run at {}: {error}", path.display()),
        )
    })?;
    let file: TraceRunFile = serde_json::from_str(&text).map_err(|error| {
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

// ---------------------------------------------------------------------------
// The gate
// ---------------------------------------------------------------------------

/// Why an opt-in gate should fail, or `None`.
///
/// A stall verdict and a run that never finished are one result in CI, so they
/// share one flag. Coverage never fails a gate: 87% of a healthy local cold
/// open is pre-instrument boot, so a gate that fires on coverage fires on every
/// green run.
pub fn gate_failure(file: &TraceRunFile) -> Option<String> {
    if !file.header.settled {
        return Some(format!(
            "the run never settled ({})",
            file.header.end_reason.as_deref().unwrap_or("no end reason")
        ));
    }
    let verdict = file.diagnostic.get("verdict")?;
    let kind = verdict.get("kind").and_then(Value::as_str)?;
    if kind == "stall" || kind == "unsettled" {
        let text = verdict
            .get("text")
            .and_then(Value::as_str)
            .unwrap_or("no verdict text");
        return Some(format!("{kind}: {text}"));
    }
    None
}

// ---------------------------------------------------------------------------
// Printing
// ---------------------------------------------------------------------------

/// The default rendering: the page's own text, under the three things the page
/// could not know about its own run.
pub fn format_run_human(file: &TraceRunFile, path: &Path) -> String {
    let header = &file.header;
    let view = &header.composed_view;
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
    format!(
        "view      {} @ {}x{} DPR {}\n\
         {camera}\
         server    {}\n\
         hold      quiescent had to hold {} ms; every duration below is measured against that\n\
         run file  {}\n\
         {screenshot}\n\
         {}",
        view.dataset,
        view.width,
        view.height,
        view.device_pixel_ratio,
        header.server_warmth.summary,
        header.quiescence_hold_ms,
        path.display(),
        file.renderings.summary,
    )
}

fn format_level_range(range: LevelRange) -> String {
    if range.min == range.max {
        range.min.to_string()
    } else {
        format!("{}..{}", range.min, range.max)
    }
}

/// A depth of a persisted run. `Summary` and `Phases` are the page's renderings
/// verbatim; `Phase` selects one phase's already-computed numbers out of the
/// document rather than deriving anything.
pub fn render_show(file: &TraceRunFile, depth: &ShowDepth) -> String {
    match depth {
        ShowDepth::Summary => file.renderings.summary.clone(),
        ShowDepth::Phases => file.renderings.phases.clone(),
        ShowDepth::Phase(id) => file
            .renderings
            .per_phase
            .get(id)
            .cloned()
            .unwrap_or_else(|| {
                format!(
                    "phase {id} is not in this run; the run carries: {}",
                    file.renderings
                        .per_phase
                        .keys()
                        .cloned()
                        .collect::<Vec<_>>()
                        .join(", ")
                )
            }),
    }
}

// ---------------------------------------------------------------------------
// Driving
// ---------------------------------------------------------------------------

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
) -> Result<TraceRunFile, CliError> {
    // Both artifacts come out of one drive when they are both wanted. The
    // default rendering points at Perfetto for raw spans, and a second drive
    // would send the reader to a different run than the one they were reading.
    let export_expression = run_export_expression(perfetto_path.is_some());
    let json = drive_and_export(
        url,
        token,
        viewport,
        wait,
        &export_expression,
        facts.screenshot.as_deref(),
    )
    .await?;
    let export: SeamExport = serde_json::from_str(&json).map_err(|error| {
        CliError::new(
            ErrorKind::Protocol,
            format!("the page returned a trace this CLI cannot read: {error}"),
        )
    })?;
    if let (Some(path), Some(projection)) = (perfetto_path, export.chrome_trace.as_deref()) {
        write_beside_its_parents(Path::new(path), projection.as_bytes()).await?;
    }
    Ok(assemble_run_file(export, facts))
}

/// Drive one run and hand back whatever `export` evaluated to.
///
/// The two exports — the document and its Perfetto projection — differ only in
/// that expression, so the launch, the settle wait, the timeout close and the
/// teardown live here once. Readiness is observed rather than demanded: a page
/// that never draws is a run this command still has to report.
///
/// `screenshot` is where to write the page's frame after the wait, at the
/// viewport's device pixel ratio. It is taken before the export because the
/// export closes the run: the frame is the run's last state.
async fn drive_and_export(
    url: &str,
    token: Option<&EffectiveToken>,
    viewport: Viewport,
    wait: Duration,
    export: &str,
    screenshot: Option<&Path>,
) -> Result<String, CliError> {
    browser::with_browser(viewport, wait, async |browser| {
        let mut page = browser.open_page_unrendered(url, token, wait).await?;
        if !wait_for_settled_run(&mut page, wait).await? {
            page.evaluate(CLOSE_AS_TIMEOUT, wait).await?;
            let closed = read_run_state(&mut page, wait).await?;
            pin_run(&mut page, closed.last_concluded_run_id.as_deref(), wait).await?;
        }
        if let Some(path) = screenshot {
            let png = page.screenshot_png(wait).await?;
            write_beside_its_parents(path, &png).await?;
        }
        let value = page.evaluate(export, wait).await?;
        value.as_str().map(str::to_string).ok_or_else(|| {
            CliError::new(
                ErrorKind::Protocol,
                "the page did not return a trace; window.lucidaTrace was missing",
            )
        })
    })
    .await
}

/// What the driver knows and the page cannot: the workload it composed, the
/// warmth it found on the server, and which server and workspace those were.
#[derive(Debug, Clone, PartialEq)]
pub struct DriverFacts {
    pub composed_view: ComposedView,
    pub server_warmth: ServerWarmth,
    pub server_url: String,
    pub workspace_id: String,
    /// Where to write the settled frame, when the caller wants one.
    pub screenshot: Option<PathBuf>,
}

/// Fold what the page returned together with what only the driver knows. Split
/// from the drive so the assembly is assertable without a browser.
fn assemble_run_file(export: SeamExport, facts: &DriverFacts) -> TraceRunFile {
    // The run says whether it settled; the driver does not get an opinion. Its
    // own "quiescent held" observation would call a page that never opened a
    // run settled, because an idle page trivially satisfies the predicate.
    let settled = export.end_reason.as_deref() == Some("quiescent");
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
            server_warmth: facts.server_warmth.clone(),
            server_url: facts.server_url.clone(),
            workspace_id: facts.workspace_id.clone(),
            screenshot: facts.screenshot.clone(),
        },
        renderings: TraceRenderings {
            summary: export
                .summary
                .unwrap_or_else(|| NO_RUN_RECORDED.to_string()),
            phases: export.phases.unwrap_or_else(|| NO_RUN_RECORDED.to_string()),
            per_phase: export.per_phase,
        },
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
/// The definition of settled is the page's: it publishes `quiescent`, holds it
/// for its own hold window, and closes the run itself. So the driver waits for
/// a *closed run* rather than for the boolean. Two traps make the boolean alone
/// the wrong thing to watch, and both are silent:
///
/// - **Before a run opens the predicate is trivially true.** Nothing is dirty
///   and nothing is wanted, so a driver polling `quiescent` can declare a cold
///   remote open settled while the page is still shaking hands, and export a
///   trace with no run in it.
/// - **Exporting on the first `true` pre-empts the page's own close**, so every
///   run it takes lands as `explicit` when it settled.
///
/// A third trap sits behind the second: a page torn down and rebuilt — which
/// a development bundle does on every mount — hands back a run that lived under
/// a millisecond and closed `explicit`. So the wait is for a run that concluded
/// *on its own*, by settling or by timing out.
///
/// Returns whether one did, inside the deadline. It does not say *how* — the
/// run's own end reason does, and the recorder's own timeout can conclude a run
/// without this wait ever reaching its deadline.
async fn wait_for_settled_run(page: &mut browser::Page, wait: Duration) -> Result<bool, CliError> {
    let deadline = tokio::time::Instant::now() + wait;
    let concluded_before = read_run_state(page, wait).await?.concluded;

    loop {
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

/// Leave the waited-for run's id on the page for the export to read.
///
/// A page can carry several runs — a workspace reload opens one, a later
/// dirty epoch opens another — so the export has to name the one the wait
/// observed rather than take the last in the list.
async fn pin_run(
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
fn json_string(value: &str) -> String {
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
struct RunState {
    #[allow(dead_code)]
    open: bool,
    concluded: u64,
    /// The run the wait was waiting for. Named to the export, because the
    /// export closes an interval of its own and "newest" would be that one.
    #[serde(default)]
    last_concluded_run_id: Option<String>,
}

// ---------------------------------------------------------------------------
// The Perfetto projection
// ---------------------------------------------------------------------------

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
        None,
    )
    .await?;
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
    if !capture.settled {
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
            camera: None,
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
            server_url: "http://host".to_string(),
            workspace_id: "ws".to_string(),
            screenshot: None,
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
                server_warmth: cold(),
                server_url: "http://host".to_string(),
                workspace_id: "ws".to_string(),
                screenshot: None,
            },
            renderings: TraceRenderings {
                summary: "lucida trace run-1-1 — VERDICT: clear".to_string(),
                phases: "CRITICAL PATH\nRULESET v3".to_string(),
                per_phase: BTreeMap::from([(
                    "browser.wire".to_string(),
                    "PHASE     browser.wire\nFINDINGS  none against browser.wire.".to_string(),
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
    /// dataset (ADR 0042), and matching raw strings would report a warm server
    /// as cold.
    #[test]
    fn server_warmth_matches_across_canonical_spellings() {
        let health = vec![health_entry("file:///C:/data/set.zarr", None)];
        let warmth = summarise_server_warmth("c:\\data\\set.zarr", &health);
        assert!(warmth.dataset_open_before_run);
    }

    #[test]
    fn the_gate_fails_on_a_stall_and_on_a_run_that_never_settled() {
        let stalled = run_file(
            json!({ "verdict": { "kind": "stall", "text": "wire held 4,200 ms" } }),
            true,
            "quiescent",
        );
        assert!(gate_failure(&stalled).unwrap().contains("wire held"));

        let unsettled = run_file(
            json!({ "verdict": { "kind": "clear", "text": "nothing crossed a threshold" } }),
            false,
            "timeout",
        );
        assert!(gate_failure(&unsettled).unwrap().contains("never settled"));
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

    /// The hold window is baked into every duration the run reports, so it
    /// travels with them rather than living in this command's help text.
    #[test]
    fn the_default_rendering_leads_with_what_the_page_could_not_know() {
        let file = run_file(
            json!({ "verdict": { "kind": "clear", "text": "clear" } }),
            true,
            "quiescent",
        );
        let human = format_run_human(&file, Path::new("/traces/run-1-1.json"));

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
        assert_eq!(
            render_show(&file, &ShowDepth::Summary),
            file.renderings.summary
        );
        assert_eq!(
            render_show(&file, &ShowDepth::Phases),
            file.renderings.phases
        );
        assert_eq!(
            render_show(&file, &ShowDepth::Phase("browser.wire".to_string())),
            file.renderings.per_phase["browser.wire"]
        );

        let missing = render_show(&file, &ShowDepth::Phase("browser.decode".to_string()));
        assert!(missing.contains("browser.decode is not in this run"));
        assert!(missing.contains("browser.wire"));
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
        assert!(format_run_human(&file, Path::new("run.json")).contains("/tmp/twins/sharded.png"));

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

        let error = read_run_file(&path).unwrap_err();
        assert_eq!(error.kind, ErrorKind::Protocol);
        assert!(error.message.contains("run file version"));

        file.file_version = RUN_FILE_VERSION;
        std::fs::write(&path, serde_json::to_vec(&file).unwrap()).unwrap();
        assert_eq!(read_run_file(&path).unwrap(), file);

        std::fs::remove_dir_all(&dir).unwrap();
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
            "active_layout_ids": {},
            "asset_catalogs": {}
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
            DisplayPins {
                contrast: Some((1.0, 3.0)),
                ..Default::default()
            },
        );

        assert_eq!(view.auto_contrast.get(&id), Some(&false));
        let settings = &view.dataset_settings[&id];
        assert_eq!((settings.contrast_min, settings.contrast_max), (1.0, 3.0));
        assert_eq!(settings.channel_settings.len(), 2);
        for (index, channel) in settings.channel_settings.iter().enumerate() {
            assert_eq!((channel.contrast_min, channel.contrast_max), (1.0, 3.0));
            assert_eq!(channel.colormap, Colormap::default_for_channel(index));
        }
        assert!(settings.visible);
        assert_eq!(settings.render_mode, RenderMode::Translucent);
        assert_eq!(settings.detail_level_override, None);
    }

    #[test]
    fn a_colormap_and_a_render_mode_pin_without_touching_the_window() {
        let id = volume_id();
        let mut view = compose_dataset_view("gs://bucket/set.zarr", 1440, 900, None);
        pin_display(
            &mut view,
            &id,
            3,
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
        pin_display(&mut view, &volume_id(), 1, DisplayPins::default());
        assert!(view.dataset_settings.is_empty());
        assert!(view.auto_contrast.is_empty());
    }

    /// Level 0 is a pin like any other, and pinning to it is how a run
    /// measures the level-0 default ADR 0061 replaced.
    #[test]
    fn a_level_pin_rides_the_view_and_level_0_is_one_of_them() {
        let id = volume_id();
        for level in [0, 2] {
            let mut view = compose_dataset_view("gs://bucket/set.zarr", 1440, 900, None);
            pin_display(
                &mut view,
                &id,
                1,
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
        let human = format_run_human(&file, Path::new("run.json"));
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
}
