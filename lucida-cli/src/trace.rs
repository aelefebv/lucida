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

use lucida_core::saved_view::{SavedView, normalize_dataset_url};
use lucida_protocol::{DatasetSourceCacheStats, DatasetSourceHealth};
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::browser::{self, Viewport};
use crate::credentials::EffectiveToken;
use crate::error::{CliError, ErrorKind};

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

const QUIESCENT_PROBE: &str = "!!(window.lucidaTrace && window.lucidaTrace.quiescence \
     && window.lucidaTrace.quiescence.quiescent)";

const QUIESCENCE_HOLD_PROBE: &str =
    "window.lucidaTrace ? window.lucidaTrace.quiescenceHoldMs : null";

const CHROME_TRACE_EXPORT_EXPRESSION: &str =
    "window.lucidaTrace ? window.lucidaTrace.exportChromeTrace() : null";

/// Close a run the driver gave up on as what it was. `explicit` would claim
/// somebody asked for the document; the end reason is the field a later reader
/// trusts about whether the page ever finished.
const CLOSE_AS_TIMEOUT: &str =
    "window.lucidaTrace ? (window.lucidaTrace.closeRun('timeout'), true) : false";

/// One evaluation for the whole artifact: the merged document, the diagnostic
/// derived from it and both renderings of that diagnostic. Taking them together
/// keeps them describing one run — a second round trip would export again after
/// the page had moved on.
const RUN_EXPORT_EXPRESSION: &str = r#"(() => {
  const seam = window.lucidaTrace;
  if (!seam) return null;
  const trace = seam.exportTrace();
  const runs = trace.runs || [];
  const runId = runs.length > 0 ? runs[runs.length - 1].header.runId : undefined;
  return JSON.stringify({
    schemaVersion: seam.schemaVersion,
    runId: runId || null,
    quiescenceHoldMs: seam.quiescenceHoldMs,
    endReason: runId ? runs[runs.length - 1].header.endReason : null,
    diagnostic: runId ? seam.diagnose(runId) : null,
    summary: runId ? seam.diagnoseText(runId) : null,
    phases: runId ? seam.diagnoseText(runId, { depth: 'phases' }) : null,
    trace
  });
})()"#;

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
    /// The server's source cache for this dataset, when it had one.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source_cache: Option<DatasetSourceCacheStats>,
    /// One line a reader can put beside a duration.
    pub summary: String,
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
}

/// Both renderings, taken at export time from the page's one renderer. The
/// browser that produced them is dead by the time anyone reads the file, so a
/// depth that is not captured here is a depth nobody can reach.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TraceRenderings {
    pub summary: String,
    pub phases: String,
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
pub fn compose_dataset_view(dataset_url: &str, width: u32, height: u32) -> SavedView {
    let mut view = SavedView::empty([width, height]);
    view.datasets = vec![normalize_dataset_url(dataset_url)];
    view
}

/// Read the server's warmth for `dataset_url` out of a health snapshot taken
/// before the run.
pub fn summarise_server_warmth(dataset_url: &str, health: &[DatasetSourceHealth]) -> ServerWarmth {
    let canonical = normalize_dataset_url(dataset_url);
    let entry = health.iter().find(|dataset| {
        dataset
            .source_url
            .as_deref()
            .map(|url| normalize_dataset_url(url) == canonical)
            .unwrap_or(false)
    });

    match entry {
        None => ServerWarmth {
            dataset_open_before_run: false,
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
                source_cache: dataset.source_cache.clone(),
                summary,
            }
        }
    }
}

// ---------------------------------------------------------------------------
// Where a run lands
// ---------------------------------------------------------------------------

/// The directory runs are written to when the caller does not name a file.
/// Beside the config rather than in the working directory: the follow-up
/// commands take a run id, and a run id has to resolve from anywhere.
pub fn default_trace_dir(config_path: &Path) -> PathBuf {
    if let Some(dir) = std::env::var_os("LUCIDA_TRACE_DIR") {
        return PathBuf::from(dir);
    }
    config_path
        .parent()
        .unwrap_or_else(|| Path::new("."))
        .join("traces")
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
    format!(
        "view      {} @ {}x{} DPR {}\n\
         server    {}\n\
         hold      quiescent had to hold {} ms; every duration below is measured against that\n\
         run file  {}\n\n\
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

/// A depth of a persisted run. `Summary` and `Phases` are the page's renderings
/// verbatim; `Phase` selects one phase's already-computed numbers out of the
/// document rather than deriving anything.
pub fn render_show(file: &TraceRunFile, depth: &ShowDepth) -> String {
    match depth {
        ShowDepth::Summary => file.renderings.summary.clone(),
        ShowDepth::Phases => file.renderings.phases.clone(),
        ShowDepth::Phase(id) => render_one_phase(file, id),
    }
}

fn render_one_phase(file: &TraceRunFile, id: &str) -> String {
    let mut out = Vec::new();
    let phase = file
        .diagnostic
        .get("phases")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .find(|phase| phase.get("id").and_then(Value::as_str) == Some(id));

    match phase {
        None => out.push(format!("phase {id} is not in this run")),
        Some(phase) => {
            out.push(format!(
                "phase     {id} ({})",
                phase
                    .get("class")
                    .and_then(Value::as_str)
                    .unwrap_or("unclassed")
            ));
            out.push(format!(
                "          n={} p50 {} ms p95 {} ms max {} ms total {} ms {}x concurrent",
                number(phase, "n"),
                number(phase, "p50Ms"),
                number(phase, "p95Ms"),
                number(phase, "maxMs"),
                number(phase, "totalMs"),
                number(phase, "concurrencyFactor"),
            ));
        }
    }

    let findings: Vec<&Value> = file
        .diagnostic
        .get("findings")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter(|finding| finding.get("subject").and_then(Value::as_str) == Some(id))
        .collect();
    if findings.is_empty() {
        out.push("findings  none against this phase".to_string());
    } else {
        for finding in findings {
            out.push(format!(
                "finding   {} [{}] — {}",
                finding
                    .get("severity")
                    .and_then(Value::as_str)
                    .unwrap_or("unknown"),
                finding
                    .get("rule")
                    .and_then(Value::as_str)
                    .unwrap_or("no rule"),
                finding
                    .get("threshold")
                    .and_then(|threshold| threshold.get("why"))
                    .and_then(Value::as_str)
                    .unwrap_or("no rationale"),
            ));
            if let Some(why) = finding
                .get("attribution")
                .and_then(|attribution| attribution.get("why"))
                .and_then(Value::as_str)
            {
                out.push(format!("          why: {why}"));
            }
        }
    }
    out.push("raw spans are never inlined at any depth; use lucida trace perfetto".to_string());
    out.join("\n")
}

fn number(value: &Value, key: &str) -> String {
    value
        .get(key)
        .map(|value| value.to_string())
        .unwrap_or_else(|| "?".to_string())
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
) -> Result<TraceRunFile, CliError> {
    browser::with_browser(viewport, wait, async |browser| {
        let mut page = browser.open_page(url, token, wait).await?;
        let settled = wait_for_quiescent(&mut page, wait).await?;
        if !settled {
            page.evaluate(CLOSE_AS_TIMEOUT, wait).await?;
        }

        let value = page.evaluate(RUN_EXPORT_EXPRESSION, wait).await?;
        let json = value.as_str().ok_or_else(|| {
            CliError::new(
                ErrorKind::Protocol,
                "the page did not return a trace; window.lucidaTrace was missing or threw",
            )
        })?;
        let export: SeamExport = serde_json::from_str(json).map_err(|error| {
            CliError::new(
                ErrorKind::Protocol,
                format!("the page returned a trace this CLI cannot read: {error}"),
            )
        })?;

        Ok(assemble_run_file(export, settled, facts))
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
}

/// Fold what the page returned together with what only the driver knows. Split
/// from the drive so the assembly is assertable without a browser.
fn assemble_run_file(export: SeamExport, settled: bool, facts: &DriverFacts) -> TraceRunFile {
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
        },
        renderings: TraceRenderings {
            summary: export
                .summary
                .unwrap_or_else(|| NO_RUN_RECORDED.to_string()),
            phases: export.phases.unwrap_or_else(|| NO_RUN_RECORDED.to_string()),
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
    if let Some(parent) = path.parent()
        && !parent.as_os_str().is_empty()
    {
        tokio::fs::create_dir_all(parent).await?;
    }
    tokio::fs::write(&path, serde_json::to_vec(file)?).await?;
    Ok(path)
}

/// Poll the page's published quiescence until it has *held*, and let the page
/// close its own run.
///
/// Never inferred from outside — a stalled pipeline and a finished one both
/// stop drawing, so watching the frame counter would call the interesting case
/// settled. And never exported on the first `true`: the recorder closes a run
/// as `quiescent` only once the boolean has held for its own hold window, so a
/// driver that exports the instant it flips pre-empts that close and every run
/// it takes records `explicit` — losing the one field that says the page
/// settled. The hold window comes from the page rather than a constant here,
/// because it is baked into every duration the run reports.
pub async fn wait_for_quiescent(
    page: &mut browser::Page,
    wait: Duration,
) -> Result<bool, CliError> {
    let deadline = tokio::time::Instant::now() + wait;
    let hold = read_hold_ms(page, wait).await?;
    // Past the hold itself, so the recorder's timer has fired and the run is
    // closed before the export asks for it.
    let settle_for = Duration::from_millis(hold as u64) + Duration::from_millis(250);

    loop {
        if page.evaluate(QUIESCENT_PROBE, wait).await?.as_bool() == Some(true) {
            tokio::time::sleep(settle_for).await;
            // Still settled after the hold, or the page found more work and
            // the wait starts again.
            if page.evaluate(QUIESCENT_PROBE, wait).await?.as_bool() == Some(true) {
                return Ok(true);
            }
        }
        if tokio::time::Instant::now() >= deadline {
            return Ok(false);
        }
        tokio::time::sleep(Duration::from_millis(250)).await;
    }
}

async fn read_hold_ms(page: &mut browser::Page, wait: Duration) -> Result<f64, CliError> {
    Ok(page
        .evaluate(QUIESCENCE_HOLD_PROBE, wait)
        .await?
        .as_f64()
        .filter(|value| *value > 0.0)
        .unwrap_or(DEFAULT_QUIESCENCE_HOLD_MS))
}

// ---------------------------------------------------------------------------
// The Perfetto projection
// ---------------------------------------------------------------------------

/// A Chrome Trace Event capture, summarised from the file it just wrote.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct ChromeTraceCapture {
    /// Whether the page ever published `quiescent`. Recorded rather than
    /// enforced: the run that never settles is still exported.
    pub settled: bool,
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
    browser::with_browser(viewport, wait, async |browser| {
        let mut page = browser.open_page(url, token, wait).await?;
        let settled = wait_for_quiescent(&mut page, wait).await?;
        if !settled {
            page.evaluate(CLOSE_AS_TIMEOUT, wait).await?;
        }

        let value = page.evaluate(CHROME_TRACE_EXPORT_EXPRESSION, wait).await?;
        let json = value.as_str().ok_or_else(|| {
            CliError::new(
                ErrorKind::Protocol,
                "the page did not return a trace; window.lucidaTrace was missing or threw",
            )
        })?;

        if let Some(parent) = Path::new(output_path).parent()
            && !parent.as_os_str().is_empty()
        {
            tokio::fs::create_dir_all(parent).await?;
        }
        tokio::fs::write(output_path, json).await?;
        summarise_chrome_trace(json, settled)
    })
    .await
}

/// Read back what the file says about itself, rather than restating it.
fn summarise_chrome_trace(json: &str, settled: bool) -> Result<ChromeTraceCapture, CliError> {
    let parsed: Value = serde_json::from_str(json).map_err(|error| {
        CliError::new(
            ErrorKind::Protocol,
            format!("the page returned a trace that is not JSON: {error}"),
        )
    })?;
    Ok(ChromeTraceCapture {
        settled,
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

    fn composed() -> ComposedView {
        ComposedView {
            dataset: "gs://bucket/set.zarr".to_string(),
            url: "http://host/w/ws?render=1#view=ABC".to_string(),
            width: DEFAULT_WIDTH,
            height: DEFAULT_HEIGHT,
            device_pixel_ratio: DEFAULT_DEVICE_PIXEL_RATIO,
        }
    }

    fn cold() -> ServerWarmth {
        ServerWarmth {
            dataset_open_before_run: false,
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
            },
            renderings: TraceRenderings {
                summary: "lucida trace run-1-1 — VERDICT: clear".to_string(),
                phases: "CRITICAL PATH\nRULESET v3".to_string(),
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
        let view = compose_dataset_view("GS://Bucket/set.zarr", 1440, 900);
        assert_eq!(view.datasets, vec!["gs://Bucket/set.zarr".to_string()]);
        assert!(view.dataset_order.is_empty());
        assert!(view.active_layouts.is_empty());
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
    }

    #[test]
    fn one_phase_reads_its_already_computed_numbers_out_of_the_document() {
        let file = run_file(
            json!({
                "phases": [
                    { "id": "wire", "class": "timed", "n": 21, "p50Ms": 4, "p95Ms": 90,
                      "maxMs": 120, "totalMs": 900, "concurrencyFactor": 3 }
                ],
                "findings": [
                    { "id": 1, "subject": "wire", "severity": "stall", "rule": "phase-share",
                      "threshold": { "why": "a phase over a third of the chain" },
                      "attribution": { "why": "the reads were queued behind the admission window" } }
                ]
            }),
            true,
            "quiescent",
        );

        let text = render_show(&file, &ShowDepth::Phase("wire".to_string()));
        assert!(text.contains("phase     wire (timed)"));
        assert!(text.contains("n=21"));
        assert!(text.contains("p95 90 ms"));
        assert!(text.contains("stall [phase-share]"));
        assert!(text.contains("queued behind the admission window"));
        assert!(text.contains("lucida trace perfetto"));

        let missing = render_show(&file, &ShowDepth::Phase("decode".to_string()));
        assert!(missing.contains("phase decode is not in this run"));
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

        let file = assemble_run_file(export, false, &facts());

        assert_eq!(file.header.run_id.as_deref(), Some("run-7-2"));
        assert_eq!(file.header.end_reason.as_deref(), Some("timeout"));
        assert!(!file.header.settled);
        assert_eq!(file.header.quiescence_hold_ms, 500.0);
        assert!(gate_failure(&file).is_some());
    }

    /// A page that recorded no run is a result, not a crash.
    #[test]
    fn a_page_with_no_run_still_produces_a_readable_file() {
        let export: SeamExport = serde_json::from_str(
            &json!({ "schemaVersion": 1, "runId": null, "quiescenceHoldMs": null,
                     "endReason": null, "diagnostic": null, "summary": null,
                     "phases": null, "trace": { "runs": [] } })
            .to_string(),
        )
        .unwrap();

        let file = assemble_run_file(export, true, &facts());
        assert!(file.renderings.summary.contains("no run was recorded"));
        assert_eq!(file.header.quiescence_hold_ms, DEFAULT_QUIESCENCE_HOLD_MS);
        // Nothing to gate on: the absence of a run is not a stall verdict.
        assert_eq!(gate_failure(&file), None);
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
    fn the_trace_directory_sits_beside_the_config() {
        let dir = default_trace_dir(Path::new("/home/me/.config/lucida/config.json"));
        assert_eq!(dir, PathBuf::from("/home/me/.config/lucida/traces"));
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

        let capture = summarise_chrome_trace(&json, false).unwrap();
        assert_eq!(capture.events, 2);
        assert_eq!(capture.synthetic_values, vec!["upload end".to_string()]);
        let human = format_chrome_trace_human("out.json", &capture);
        assert!(human.contains("ui.perfetto.dev"));
        assert!(human.contains("closed as a timeout"));
    }
}
