//! Replaying a bundle in the trace driver (ADR 0051 as amended).
//!
//! A field report becomes a reproducible run. A bundle's header carries what
//! the driver needs to replay the view (#1055): the dataset, the view URL,
//! the viewport and device pixel ratio, the planning configuration, and the
//! pins. [`ReplayPlan`] reads them and says, input by input, which the
//! driver restores and which it cannot — the build is whatever the server
//! serves, the adapter is this machine's, and a fresh browser profile is
//! cold whatever the run's browser held. The plan guesses nothing. An input
//! the header lacks runs at the driver's default, and the record in the new
//! run's header lists it as unrestored, with the reason.
//!
//! The replay restores the view by re-hosting a view fragment on the
//! configured workspace rather than by navigating to the bundle's URL. The
//! fragment carries the camera, the mode, and every pin, keyed by dataset
//! ids derived from the source URL (ADR 0042), so it reads the same on
//! another server. Which fragment depends on whether the bundle carries a
//! script. Without one, it is the header's own, byte for byte, so on the
//! machine that wrote the bundle the replay navigates to the page the run
//! happened on. With one, the header's URL is the view *after* the script:
//! the page keeps its location in step with its view, and the header is
//! read at the run's close. The replay starts instead from the view the
//! first step recorded before it ran.
//!
//! The diff of the original and the replay is the page's (#1059). The
//! header fields that break comparability, the adapter among them, are the
//! page's to warn about, so a bundle replayed on a different adapter reads
//! as not comparable without this module judging anything (ADR 0051).

use std::io::Read as _;
use std::path::{Path, PathBuf};

use base64::Engine as _;
use lucida_core::saved_view::normalize_dataset_url;
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::encode_saved_view_url_payload;
use crate::error::CliError;
use crate::montage::with_render_param;
use crate::trace::{
    DEFAULT_DEVICE_PIXEL_RATIO, DEFAULT_HEIGHT, DEFAULT_WIDTH, REPLAY_INPUTS, TraceBundle,
    TraceRunFile, describe_adapter, format_run_facts,
};
use crate::trace_knobs::KnobSettings;
use crate::trace_script::{Script, ScriptRecord};

/// One replay input the driver could not restore, and why.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Unrestored {
    /// The input, in the words the spec uses and the bundle's own text prints.
    pub input: String,
    pub reason: String,
}

/// Where the replay's starting view came from.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum ViewSource {
    /// The header's view URL: the view the run closed at, which for a run
    /// without a script is the view it settled at after opening.
    HeaderUrl,
    /// The view the first step recorded before it ran. A scripted bundle's
    /// header URL is the view after the script, and a script run again from
    /// there would land every step somewhere else.
    FirstStep,
}

/// What a replayed run's header records about the bundle it replayed:
/// which of the header's replay inputs the driver restored and which it
/// could not, under the names the bundle's text uses for them.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReplayRecord {
    /// The bundle, as the command was given it.
    pub bundle: PathBuf,
    /// The run the bundle was of.
    pub run_id: Option<String>,
    /// Where the starting view came from, or None when no view was restored.
    pub view: Option<ViewSource>,
    /// The inputs restored, in the header's order.
    pub restored: Vec<String>,
    /// The inputs the driver could not restore, each with why, in the header's order.
    pub unrestored: Vec<Unrestored>,
}

/// What the driver does to replay a bundle. Composed from the bundle alone,
/// before a browser or a server is reached, so it is assertable without
/// either, and a bundle that cannot be replayed is refused before anything
/// is opened on its behalf.
#[derive(Debug, Clone, PartialEq)]
pub struct ReplayPlan {
    /// The dataset the run was of, by canonical source URL: the one the
    /// server's warmth is read for and the composed view names.
    pub dataset_url: String,
    /// The other datasets the header names by URL, in its order. Each is in
    /// the workspace before the page loads, as the first is.
    pub other_dataset_urls: Vec<String>,
    /// The view fragment for [`rehost_view`]. None when the bundle carries
    /// no view the driver can start from; the page then frames the dataset
    /// itself, as it does for a cold open.
    pub view_fragment: Option<String>,
    /// The viewport in CSS pixels, and the ratio to drive the page at.
    pub width: u32,
    pub height: u32,
    pub device_pixel_ratio: f64,
    /// The planning configuration, as the knobs the driver writes before
    /// the page loads. Empty when the header carries none.
    pub knobs: KnobSettings,
    /// The bundle's steps, or empty for a cold open.
    pub script: Script,
    pub record: ReplayRecord,
}

impl ReplayPlan {
    /// Read `bundle`, as the command was given it at `path`, into a plan.
    ///
    /// Refuses a bundle that names no dataset source URL, because there is
    /// nothing to open, and a script whose steps could never land again.
    /// Every other shortfall is a default and an entry in the record.
    pub fn from_bundle(bundle: &TraceBundle, path: &Path) -> Result<Self, CliError> {
        let header = &bundle.header;

        let mut named = header
            .datasets
            .iter()
            .filter_map(|dataset| dataset.source_url.as_deref())
            .map(normalize_dataset_url);
        let Some(dataset_url) = named.next() else {
            return Err(CliError::config(format!(
                "{} names no dataset source URL, so there is nothing to open; a bundle of a \
                 page that recorded no run cannot be replayed",
                path.display()
            )));
        };
        let other_dataset_urls: Vec<String> = named.collect();
        let unnamed: Vec<&str> = header
            .datasets
            .iter()
            .filter(|dataset| dataset.source_url.is_none())
            .map(|dataset| dataset.id.as_str())
            .collect();
        let dataset = if unnamed.is_empty() {
            Ok(())
        } else {
            Err(format!(
                "the header carries no source URL for {}, so only the datasets it names by URL \
                 are opened",
                unnamed.join(", ")
            ))
        };

        let script = match &bundle.script {
            None => Script::default(),
            Some(record) => {
                Script::from_steps(record.steps.iter().map(|step| step.step.clone()).collect())
                    .map_err(|reason| {
                        CliError::config(format!(
                            "the script in {} could not be run again: {reason}",
                            path.display()
                        ))
                    })?
            }
        };

        let (view, source) = match (&bundle.script, header.view_url.as_deref()) {
            (Some(record), _) if !record.steps.is_empty() => {
                (first_step_view(record), ViewSource::FirstStep)
            }
            (_, Some(url)) => (readable_view_fragment(url), ViewSource::HeaderUrl),
            (_, None) => (
                Err(
                    "the header carries no view URL, so the page frames the dataset itself"
                        .to_string(),
                ),
                ViewSource::HeaderUrl,
            ),
        };
        let view_fragment = view.as_ref().ok().cloned();
        // The mode and the pins ride the view: the camera says which mode,
        // and the dataset settings say what is pinned. Neither has a channel
        // of its own to the page.
        let through_view = |what: &str| {
            view.as_ref()
                .map(|_| ())
                .map_err(|_| format!("{what} is carried by the view, which was not restored"))
        };
        let mode = through_view("the mode");
        let pins = through_view("every pin");

        let viewport = match header.viewport {
            Some(viewport) if viewport.css_width >= 1.0 && viewport.css_height >= 1.0 => Ok((
                viewport.css_width.round() as u32,
                viewport.css_height.round() as u32,
            )),
            Some(viewport) => Err(format!(
                "the header's viewport is {}x{} CSS pixels, which is not a window; the driver's \
                 default {DEFAULT_WIDTH}x{DEFAULT_HEIGHT} runs",
                viewport.css_width, viewport.css_height
            )),
            None => Err(format!(
                "the header carries no viewport; the driver's default {DEFAULT_WIDTH}x{DEFAULT_HEIGHT} runs"
            )),
        };
        let (width, height) = viewport.clone().unwrap_or((DEFAULT_WIDTH, DEFAULT_HEIGHT));

        let ratio = match header.device_pixel_ratio {
            Some(ratio) if ratio.is_finite() && ratio > 0.0 => Ok(ratio),
            Some(ratio) => Err(format!(
                "the header's device pixel ratio is {ratio}; the driver's default \
                 {DEFAULT_DEVICE_PIXEL_RATIO} runs"
            )),
            None => Err(format!(
                "the header carries no device pixel ratio; the driver's default \
                 {DEFAULT_DEVICE_PIXEL_RATIO} runs"
            )),
        };
        let device_pixel_ratio = ratio.clone().unwrap_or(DEFAULT_DEVICE_PIXEL_RATIO);

        // The whole configuration, not the fields that differ from this
        // build's defaults: the run's defaults may not be this build's, and
        // the run file records exactly what was written.
        let planning = match header.planning.as_object() {
            Some(fields) if !fields.is_empty() => Ok(KnobSettings {
                planning: fields.clone().into_iter().collect(),
                cache: Default::default(),
            }),
            _ => Err(
                "the header carries no planning configuration; the page's defaults run".to_string(),
            ),
        };
        let knobs = planning.clone().unwrap_or_default();

        let build = Err(match &header.build {
            Some(build) => format!(
                "the page runs the build the server serves; the run's was {} {}",
                build.version, build.mode
            ),
            None => "the page runs the build the server serves; the header does not say which \
                     the run had"
                .to_string(),
        });
        let adapter = Err(match &header.gpu {
            Some(gpu) => format!(
                "the page runs on this machine's adapter; the run's was {}",
                describe_adapter(gpu)
            ),
            None => "the page runs on this machine's adapter; the header does not say which the \
                     run had"
                .to_string(),
        });
        let warmth = cold_as_the_run_was(&header.cache_warmth);

        let outcomes = [
            ("datasets", dataset),
            ("viewUrl", view.map(|_| ())),
            ("viewport", viewport.map(|_| ())),
            ("devicePixelRatio", ratio.map(|_| ())),
            ("mode", mode),
            ("planning", planning.map(|_| ())),
            ("pins", pins),
            ("build", build),
            ("gpu", adapter),
            ("cacheWarmth", warmth),
        ];
        let mut restored = Vec::new();
        let mut unrestored = Vec::new();
        for (field, outcome) in outcomes {
            let input = input_named(field).to_string();
            match outcome {
                Ok(()) => restored.push(input),
                Err(reason) => unrestored.push(Unrestored { input, reason }),
            }
        }

        Ok(Self {
            dataset_url,
            other_dataset_urls,
            view_fragment: view_fragment.clone(),
            width,
            height,
            device_pixel_ratio,
            knobs,
            script,
            record: ReplayRecord {
                bundle: path.to_path_buf(),
                run_id: header.run_id.clone(),
                view: view_fragment.is_some().then_some(source),
                restored,
                unrestored,
            },
        })
    }
}

/// The replay input a header field carries, in the spec's words, from the
/// one list the bundle's text also reads. Every field named here is in it.
fn input_named(field: &str) -> &'static str {
    REPLAY_INPUTS
        .iter()
        .find(|input| input.field == field)
        .map(|input| input.input)
        .expect("every replay field is declared in REPLAY_INPUTS")
}

/// `url`'s fragment, verbatim, when it carries a view this driver can read.
///
/// The check is here because a page that cannot decode its view fragment
/// falls back to its own framing without a word, and the replay would then
/// measure a different view while its header claimed the bundle's. Parts of
/// the fragment beside the view ride along as they were.
fn readable_view_fragment(url: &str) -> Result<String, String> {
    const NO_VIEW: &str =
        "the header's view URL carries no view, so the page frames the dataset itself";
    let Some((_, fragment)) = url.split_once('#') else {
        return Err(NO_VIEW.to_string());
    };
    let Some(payload) = fragment
        .split('&')
        .find_map(|part| part.strip_prefix("view="))
        .filter(|payload| !payload.is_empty())
    else {
        return Err(NO_VIEW.to_string());
    };
    let view = read_view_payload(payload).map_err(|reason| {
        format!(
            "the view in the header's URL could not be read, so the page frames the dataset \
             itself: {reason}"
        )
    })?;
    if !is_saved_view(&view) {
        return Err(
            "the view in the header's URL could not be read, so the page frames the dataset \
             itself: not a saved view"
                .to_string(),
        );
    }
    Ok(fragment.to_string())
}

/// A view fragment for the view the script's first step recorded before it
/// ran, encoded as the page encodes one.
fn first_step_view(record: &ScriptRecord) -> Result<String, String> {
    let before = &record.steps[0].view_before;
    if !is_saved_view(before) {
        return Err(
            "the first step of the bundle's script recorded no view before it, and the \
                    header's view URL is the view after the script, so the page frames the \
                    dataset itself"
                .to_string(),
        );
    }
    let payload = encode_saved_view_url_payload(before).map_err(|error| {
        format!(
            "the view before the script's first step could not be encoded, so the page frames \
             the dataset itself: {error}"
        )
    })?;
    Ok(format!("view={payload}"))
}

/// Read a view payload as the page does: base64url without padding, then
/// gzip, then JSON.
fn read_view_payload(payload: &str) -> Result<Value, String> {
    let bytes = base64::engine::general_purpose::URL_SAFE_NO_PAD
        .decode(payload)
        .map_err(|error| format!("not base64url: {error}"))?;
    let mut json = String::new();
    flate2::read::GzDecoder::new(bytes.as_slice())
        .read_to_string(&mut json)
        .map_err(|error| format!("not gzip: {error}"))?;
    serde_json::from_str(&json).map_err(|error| format!("not JSON: {error}"))
}

/// The page's own test of a view payload: an object with a positive
/// version. No stricter than that, because the page's encoder strips every
/// default field and its decoder fills them back, so a payload the page
/// reads must never be refused here for lacking one.
fn is_saved_view(value: &Value) -> bool {
    value.is_object()
        && value
            .get("v")
            .and_then(Value::as_f64)
            .is_some_and(|version| version.is_finite() && version > 0.0)
}

/// Whether a fresh browser profile, which is cold, matches what the run's
/// browser held. It does when the header says the browser held nothing.
fn cold_as_the_run_was(cache_warmth: &Value) -> Result<(), String> {
    let Some(fields) = cache_warmth.as_object() else {
        return Err(
            "the header does not say what the run's browser held; a fresh browser \
                    profile starts cold"
                .to_string(),
        );
    };
    let held = fields
        .values()
        .any(|value| value.as_f64().is_some_and(|number| number != 0.0));
    if !held {
        return Ok(());
    }
    let count = |key: &str| fields.get(key).and_then(Value::as_f64).unwrap_or(0.0);
    Err(format!(
        "the run's browser held {} detail chunks, {} coarse chunks, and {} proxy asset bytes; a \
         fresh browser profile starts cold",
        count("detailChunks"),
        count("coarseChunks"),
        count("proxyBytes")
    ))
}

/// The view fragment on the configured workspace's viewer page, with the
/// capture surface's flag, which is the URL a cold open composes.
pub fn rehost_view(web_url: &str, fragment: &str) -> String {
    with_render_param(&format!("{web_url}#{fragment}"))
}

/// The replay's lines among a run's facts: what was replayed, what was
/// restored, and what could not be. `steps` is how many the replay ran, or
/// None for a cold open.
pub fn format_replay_block(record: &ReplayRecord, steps: Option<usize>) -> String {
    let script = match (steps, record.view) {
        (None, _) => "no script, so a cold open".to_string(),
        (Some(steps), Some(ViewSource::FirstStep)) => {
            format!("the bundle's {steps}-step script, from the view before its first step")
        }
        (Some(steps), _) => format!("the bundle's {steps}-step script"),
    };
    let mut lines = vec![format!(
        "replay    {} · run {} · {script}",
        record.bundle.display(),
        record.run_id.as_deref().unwrap_or("no run recorded"),
    )];
    if !record.restored.is_empty() {
        lines.push(format!("restored  {}", record.restored.join(", ")));
    }
    if !record.unrestored.is_empty() {
        let parts: Vec<String> = record
            .unrestored
            .iter()
            .map(|entry| format!("{} ({})", entry.input, entry.reason))
            .collect();
        lines.push(format!("          not restored: {}", parts.join(" · ")));
    }
    lines.join("\n")
}

/// The replay as a person reads it: the run's facts, led by what was
/// replayed and what could not be restored because the diff means nothing
/// without them, then the page's diff, then the command that prints the
/// same diff again from the files.
pub fn format_replay_human(
    file: &TraceRunFile,
    path: &Path,
    bundle: Option<&Path>,
    original: &Path,
    diff: &str,
) -> String {
    format!(
        "{}\n{diff}\n\nlucida trace diff {} {}   # the same diff again, from the files\n",
        format_run_facts(file, path, bundle),
        original.display(),
        path.display(),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::trace::{
        BundleDataset, ComposedView, DEFAULT_DEVICE_PIXEL_RATIO, DEFAULT_HEIGHT, DEFAULT_WIDTH,
        RUN_FILE_VERSION, ServerWarmth, TraceArtifact, TraceBundle, TraceRenderings,
        TraceRunHeader, read_artifact,
    };
    use crate::trace_script::{ScriptRecord, ScriptStep};
    use serde_json::{Value, json};
    use std::path::{Path, PathBuf};

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

    fn scripted(steps: Value) -> ScriptRecord {
        serde_json::from_value(json!({ "steps": steps })).unwrap()
    }

    /// A step record with the fields a plan reads, around `step`'s own.
    fn step(mut step: Value, view_before: Value) -> Value {
        let fields = step.as_object_mut().unwrap();
        fields.insert("startedAtMs".into(), json!(0.0));
        fields.insert("endedAtMs".into(), json!(1.0));
        fields.insert("runId".into(), Value::Null);
        fields.insert("timedOut".into(), json!(false));
        fields.insert("viewBefore".into(), view_before.clone());
        fields.insert("viewAfter".into(), view_before);
        fields.insert("viewChanged".into(), json!(false));
        step
    }

    fn a_view() -> Value {
        json!({
            "v": 1,
            "datasets": ["gs://bucket/sample.zarr"],
            "camera": { "mode": "arcball", "theta": 0.1, "phi": 0.4, "distance": 3.0 }
        })
    }

    /// The run file a replay writes, as far as the text reads it.
    fn replayed_run(record: ReplayRecord, script: Option<ScriptRecord>) -> TraceRunFile {
        TraceRunFile {
            file_version: RUN_FILE_VERSION,
            header: TraceRunHeader {
                run_id: Some("run-2".to_string()),
                composed_view: ComposedView {
                    dataset: "gs://bucket/sample.zarr".to_string(),
                    url: "https://lucida.example/w/ws-1?render=1#view=ABC".to_string(),
                    width: 1440,
                    height: 900,
                    device_pixel_ratio: 2.0,
                    camera: None,
                },
                quiescence_hold_ms: 500.0,
                settled: true,
                end_reason: Some("quiescent".to_string()),
                server_warmth: ServerWarmth {
                    dataset_open_before_run: false,
                    opened_by_driver: false,
                    source_cache: None,
                    summary: "server cold for this dataset (not open before the run)".to_string(),
                },
                server_url: "https://lucida.example".to_string(),
                workspace_id: "ws-1".to_string(),
                screenshot: None,
                script,
                knobs: None,
                replay: Some(record),
            },
            renderings: TraceRenderings {
                summary: "lucida trace run-2 — VERDICT: clear".to_string(),
                phases: String::new(),
                per_phase: Default::default(),
                spatial: String::new(),
                per_chunk: Default::default(),
            },
            diagnostic: Value::Null,
            trace: json!({ "runs": [] }),
        }
    }

    fn inputs(unrestored: &[Unrestored]) -> Vec<&str> {
        unrestored
            .iter()
            .map(|entry| entry.input.as_str())
            .collect()
    }

    fn reason<'a>(unrestored: &'a [Unrestored], input: &str) -> &'a str {
        unrestored
            .iter()
            .find(|entry| entry.input == input)
            .unwrap_or_else(|| panic!("{input} is not among the unrestored inputs"))
            .reason
            .as_str()
    }

    /// The plan reads every replay input the header carries, and the two
    /// it cannot restore are the two that belong to the machine rather
    /// than to the run: the build the server serves and the adapter.
    #[test]
    fn the_golden_bundle_plans_as_the_run_it_records() {
        let bundle = golden_bundle();
        let plan = ReplayPlan::from_bundle(&bundle, Path::new("field.bundle.json")).unwrap();

        assert_eq!(plan.dataset_url, "gs://bucket/sample.zarr");
        assert!(plan.other_dataset_urls.is_empty());
        let url = bundle.header.view_url.as_deref().unwrap();
        let fragment = url.split_once('#').unwrap().1;
        assert_eq!(plan.view_fragment.as_deref(), Some(fragment));
        assert!(fragment.starts_with("view="));
        assert_eq!((plan.width, plan.height), (1440, 900));
        assert_eq!(plan.device_pixel_ratio, 2.0);

        let planning: Value = plan.knobs.planning.clone().into_iter().collect();
        assert_eq!(planning, bundle.header.planning);
        assert!(plan.knobs.cache.is_empty());
        assert!(plan.script.is_empty());

        assert_eq!(plan.record.bundle, Path::new("field.bundle.json"));
        assert_eq!(plan.record.run_id.as_deref(), Some("local-healthy"));
        assert_eq!(plan.record.view, Some(ViewSource::HeaderUrl));
        assert_eq!(
            plan.record.restored,
            vec![
                "dataset",
                "view URL",
                "viewport",
                "device pixel ratio",
                "slice or volume mode",
                "planning configuration",
                "level, render mode, contrast, and colormap pins",
                "cache warmth",
            ]
        );
        assert_eq!(inputs(&plan.record.unrestored), vec!["build", "adapter"]);
        let build = reason(&plan.record.unrestored, "build");
        assert!(build.contains("the server serves"), "{build}");
        assert!(build.contains("0.2.0 production"), "{build}");
        let adapter = reason(&plan.record.unrestored, "adapter");
        assert!(adapter.contains("this machine's adapter"), "{adapter}");
        assert!(adapter.contains("apple metal-3"), "{adapter}");
        assert!(adapter.contains("hardware adapter"), "{adapter}");
    }

    /// Re-hosting the fragment on the workspace that wrote the bundle gives
    /// the bundle's own URL, byte for byte: on the same machine the replay
    /// navigates to exactly the page the run happened on.
    #[test]
    fn rehosting_the_view_on_the_workspace_that_wrote_it_gives_the_bundles_own_url() {
        let bundle = golden_bundle();
        let plan = ReplayPlan::from_bundle(&bundle, Path::new("b.json")).unwrap();
        let fragment = plan.view_fragment.as_deref().unwrap();
        assert_eq!(
            rehost_view("https://lucida.example/w/ws-1", fragment),
            bundle.header.view_url.unwrap()
        );
        assert_eq!(
            rehost_view("https://other.example/w/ws-9?x=1", "view=ABC"),
            "https://other.example/w/ws-9?x=1&render=1#view=ABC"
        );
    }

    /// The bundle's steps run again as the steps they were, and a bundle
    /// without a script replays as a cold open: the driver invents nothing.
    #[test]
    fn a_bundle_with_a_script_replays_its_steps_and_one_without_is_a_cold_open() {
        let mut bundle = golden_bundle();
        assert!(bundle.script.is_none());
        let cold = ReplayPlan::from_bundle(&bundle, Path::new("b.json")).unwrap();
        assert!(cold.script.is_empty());

        bundle.script = Some(scripted(json!([
            step(json!({ "kind": "wait" }), a_view()),
            step(json!({ "kind": "orbit", "theta": 30, "phi": 0 }), a_view()),
            step(
                json!({ "kind": "scrub", "axis": "t", "count": 3 }),
                a_view()
            ),
        ])));
        let again = ReplayPlan::from_bundle(&bundle, Path::new("b.json")).unwrap();
        assert_eq!(
            again.script.steps,
            vec![
                ScriptStep::Wait,
                ScriptStep::Orbit {
                    theta: 30.0,
                    phi: 0.0
                },
                ScriptStep::Scrub {
                    axis: crate::trace_script::ScrubAxis::T,
                    count: 3
                },
            ]
        );
    }

    /// A scripted bundle's header URL is the view after the script, so the
    /// replay starts from the view the first step recorded before it ran,
    /// encoded as the page encodes a view. A first step that recorded no
    /// view leaves the page to frame the dataset, and says why the header's
    /// URL is not used instead.
    #[test]
    fn a_scripted_bundle_starts_from_the_view_before_its_first_step() {
        let mut bundle = golden_bundle();
        let header_fragment = bundle
            .header
            .view_url
            .as_deref()
            .unwrap()
            .split_once('#')
            .unwrap()
            .1
            .to_string();
        bundle.script = Some(scripted(json!([
            step(json!({ "kind": "wait" }), a_view()),
            step(
                json!({ "kind": "orbit", "theta": 30, "phi": 0 }),
                json!({ "v": 1 })
            ),
        ])));

        let plan = ReplayPlan::from_bundle(&bundle, Path::new("b.json")).unwrap();
        let fragment = plan.view_fragment.as_deref().unwrap();
        assert_ne!(fragment, header_fragment);
        let payload = fragment.strip_prefix("view=").unwrap();
        assert_eq!(read_view_payload(payload).unwrap(), a_view());
        assert_eq!(plan.record.view, Some(ViewSource::FirstStep));
        assert!(plan.record.restored.contains(&"view URL".to_string()));
        assert!(
            plan.record
                .restored
                .contains(&"slice or volume mode".to_string())
        );

        bundle.script = Some(scripted(json!([step(
            json!({ "kind": "orbit", "theta": 30, "phi": 0 }),
            Value::Null
        ),])));
        let plan = ReplayPlan::from_bundle(&bundle, Path::new("b.json")).unwrap();
        assert_eq!(plan.view_fragment, None);
        assert_eq!(plan.record.view, None);
        let why = reason(&plan.record.unrestored, "view URL");
        assert!(why.contains("recorded no view before it"), "{why}");
        assert!(why.contains("the view after the script"), "{why}");
        assert_eq!(
            reason(&plan.record.unrestored, "slice or volume mode"),
            "the mode is carried by the view, which was not restored"
        );
    }

    /// A step that could never land again is refused before a browser is
    /// launched, naming the step, as a script file's bad step is.
    #[test]
    fn a_step_that_could_never_land_again_is_refused_before_the_page_opens() {
        let mut bundle = golden_bundle();
        bundle.script = Some(scripted(json!([step(
            json!({ "kind": "hold", "ms": 0 }),
            a_view()
        ),])));
        let error = ReplayPlan::from_bundle(&bundle, Path::new("b.json")).unwrap_err();
        let message = error.to_string();
        assert!(message.contains("b.json"), "{message}");
        assert!(message.contains("step 1 (hold)"), "{message}");
    }

    /// An input the header lacks runs at the driver's default and lands in
    /// the record with why, rather than failing the replay. A bundle a person
    /// saved from a page with no view fragment is still a run worth
    /// reproducing.
    #[test]
    fn a_header_missing_an_input_records_it_as_unrestored_and_runs_the_default() {
        let mut bundle = golden_bundle();
        bundle.header.view_url = None;
        bundle.header.viewport = None;
        bundle.header.device_pixel_ratio = None;
        bundle.header.planning = Value::Null;
        bundle.header.build = None;
        bundle.header.gpu = None;
        bundle.header.cache_warmth = json!({
            "detailChunks": 12, "detailBytes": 4096, "coarseChunks": 3, "coarseBytes": 512, "proxyBytes": 0
        });

        let plan = ReplayPlan::from_bundle(&bundle, Path::new("b.json")).unwrap();
        assert_eq!(plan.view_fragment, None);
        assert_eq!(plan.record.view, None);
        assert_eq!((plan.width, plan.height), (DEFAULT_WIDTH, DEFAULT_HEIGHT));
        assert_eq!(plan.device_pixel_ratio, DEFAULT_DEVICE_PIXEL_RATIO);
        assert!(plan.knobs.is_empty());
        assert_eq!(plan.record.restored, vec!["dataset"]);
        assert_eq!(
            inputs(&plan.record.unrestored),
            vec![
                "view URL",
                "viewport",
                "device pixel ratio",
                "slice or volume mode",
                "planning configuration",
                "level, render mode, contrast, and colormap pins",
                "build",
                "adapter",
                "cache warmth",
            ]
        );
        let unrestored = &plan.record.unrestored;
        assert!(reason(unrestored, "view URL").contains("no view URL"));
        assert!(reason(unrestored, "viewport").contains("1440x900"));
        assert!(reason(unrestored, "device pixel ratio").contains("2"));
        assert!(reason(unrestored, "slice or volume mode").contains("the view"));
        assert!(reason(unrestored, "planning configuration").contains("page's defaults"));
        assert!(reason(unrestored, "build").contains("does not say"));
        assert!(reason(unrestored, "adapter").contains("does not say"));
        let warmth = reason(unrestored, "cache warmth");
        assert!(warmth.contains("12 detail"), "{warmth}");
        assert!(warmth.contains("3 coarse"), "{warmth}");
        assert!(warmth.contains("starts cold"), "{warmth}");

        bundle.header.cache_warmth = Value::Null;
        let plan = ReplayPlan::from_bundle(&bundle, Path::new("b.json")).unwrap();
        assert!(reason(&plan.record.unrestored, "cache warmth").contains("does not say"));
    }

    /// A view the driver cannot read is not restored, and the reason says
    /// so, rather than the page being sent a fragment it will silently drop.
    #[test]
    fn a_view_the_driver_cannot_read_is_not_restored() {
        let mut bundle = golden_bundle();
        bundle.header.view_url = Some("https://h/w/ws?render=1#view=not-a-payload".to_string());
        let plan = ReplayPlan::from_bundle(&bundle, Path::new("b.json")).unwrap();
        assert_eq!(plan.view_fragment, None);
        let why = reason(&plan.record.unrestored, "view URL");
        assert!(why.contains("could not be read"), "{why}");

        bundle.header.view_url = Some("https://h/w/ws?render=1".to_string());
        let plan = ReplayPlan::from_bundle(&bundle, Path::new("b.json")).unwrap();
        assert_eq!(plan.view_fragment, None);
        let why = reason(&plan.record.unrestored, "view URL");
        assert!(why.contains("carries no view"), "{why}");

        let good = golden_bundle().header.view_url.unwrap();
        bundle.header.view_url = Some(format!("{good}&panel=open"));
        let plan = ReplayPlan::from_bundle(&bundle, Path::new("b.json")).unwrap();
        assert!(
            plan.view_fragment
                .as_deref()
                .unwrap()
                .ends_with("&panel=open")
        );
    }

    /// A bundle that names no dataset source has nothing to open. A dataset
    /// without a source URL beside one with is recorded, and the replay
    /// opens the ones it can.
    #[test]
    fn a_bundle_naming_no_dataset_source_cannot_be_replayed() {
        let mut bundle = golden_bundle();
        bundle.header.datasets.clear();
        let error = ReplayPlan::from_bundle(&bundle, Path::new("b.json")).unwrap_err();
        assert!(error.to_string().contains("no dataset"), "{error}");

        bundle.header.datasets = vec![BundleDataset {
            id: "a".to_string(),
            name: None,
            source_url: None,
        }];
        let error = ReplayPlan::from_bundle(&bundle, Path::new("b.json")).unwrap_err();
        assert!(error.to_string().contains("no dataset"), "{error}");

        bundle.header.datasets = vec![
            BundleDataset {
                id: "a".to_string(),
                name: None,
                source_url: Some("GS://bucket/first.zarr".to_string()),
            },
            BundleDataset {
                id: "b".to_string(),
                name: Some("second".to_string()),
                source_url: None,
            },
            BundleDataset {
                id: "c".to_string(),
                name: None,
                source_url: Some("gs://bucket/third.zarr".to_string()),
            },
        ];
        let plan = ReplayPlan::from_bundle(&bundle, Path::new("b.json")).unwrap();
        assert_eq!(plan.dataset_url, "gs://bucket/first.zarr");
        assert_eq!(
            plan.other_dataset_urls,
            vec!["gs://bucket/third.zarr".to_string()]
        );
        let why = reason(&plan.record.unrestored, "dataset");
        assert!(why.contains("b"), "{why}");
        assert!(!plan.record.restored.contains(&"dataset".to_string()));
    }

    /// The text leads with what was replayed and what could not be
    /// restored, carries the run's facts as any run's text does, then the
    /// page's diff, and ends with the command that prints the same diff
    /// again from the files.
    #[test]
    fn the_replay_text_leads_with_what_was_restored_and_ends_with_the_diff_command() {
        let bundle = golden_bundle();
        let original = Path::new("/field/report.bundle.json");
        let record = ReplayPlan::from_bundle(&bundle, original).unwrap().record;
        let file = replayed_run(record.clone(), None);
        let text = format_replay_human(
            &file,
            Path::new("/traces/run-2.json"),
            Some(Path::new("/traces/again.bundle.json")),
            original,
            "NOT COMPARABLE  adapter a vs b — the deltas below compare different conditions",
        );
        assert!(
            text.starts_with(
                "replay    /field/report.bundle.json · run local-healthy · no script, so a cold open\n"
            ),
            "{text}"
        );
        assert!(
            text.contains(
                "restored  dataset, view URL, viewport, device pixel ratio, slice or volume mode, \
                 planning configuration, level, render mode, contrast, and colormap pins, cache warmth\n"
            ),
            "{text}"
        );
        assert!(
            text.contains(
                "          not restored: build (the page runs the build the server serves"
            ),
            "{text}"
        );
        assert!(
            text.contains(" · adapter (the page runs on this machine's adapter"),
            "{text}"
        );
        assert!(
            text.contains("view      gs://bucket/sample.zarr @ 1440x900 DPR 2\n"),
            "{text}"
        );
        assert!(
            text.contains("hold      quiescent had to hold 500 ms"),
            "{text}"
        );
        assert!(text.contains("run file  /traces/run-2.json\n"), "{text}");
        assert!(
            text.contains("bundle    /traces/again.bundle.json\n"),
            "{text}"
        );
        assert!(!text.contains("frame     "), "{text}");
        assert!(!text.contains("VERDICT"), "{text}");
        assert!(text.contains("\nNOT COMPARABLE  adapter a vs b"), "{text}");
        assert!(
            text.ends_with(
                "lucida trace diff /field/report.bundle.json /traces/run-2.json   # the same diff again, from the files\n"
            ),
            "{text}"
        );

        let mut scripted_record = record;
        scripted_record.view = Some(ViewSource::FirstStep);
        let script = scripted(json!([
            step(json!({ "kind": "wait" }), a_view()),
            step(json!({ "kind": "orbit", "theta": 30, "phi": 0 }), a_view()),
            step(
                json!({ "kind": "scrub", "axis": "t", "count": 3 }),
                a_view()
            ),
        ]));
        let mut file = replayed_run(scripted_record, Some(script));
        file.header.screenshot = Some(PathBuf::from("frame.png"));
        let with_steps = format_replay_human(&file, Path::new("run.json"), None, original, "diff");
        assert!(
            with_steps
                .contains(" · the bundle's 3-step script, from the view before its first step\n"),
            "{with_steps}"
        );
        assert!(
            with_steps.contains("steps     3: wait, orbit, scrub\n"),
            "{with_steps}"
        );
        assert!(with_steps.contains("frame     frame.png\n"), "{with_steps}");
        assert!(!with_steps.contains("bundle    "), "{with_steps}");
    }

    /// The record round-trips through the run file's JSON, so a reader of
    /// the file learns what the replay could not restore without the text.
    #[test]
    fn the_record_reads_back_from_json() {
        let bundle = golden_bundle();
        let plan = ReplayPlan::from_bundle(&bundle, Path::new("b.json")).unwrap();
        let json = serde_json::to_value(&plan.record).unwrap();
        assert_eq!(json["bundle"], "b.json");
        assert_eq!(json["runId"], "local-healthy");
        assert_eq!(json["view"], "header-url");
        assert_eq!(json["restored"][0], "dataset");
        assert_eq!(json["unrestored"][0]["input"], "build");
        let back: ReplayRecord = serde_json::from_value(json).unwrap();
        assert_eq!(back, plan.record);
    }
}
