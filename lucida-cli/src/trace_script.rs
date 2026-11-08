//! The trace driver's script: an ordered list of steps
//! the driver performs on the page once the open has settled, so an agent
//! can reproduce what a person does headlessly: pan, zoom, orbit, scrub,
//! select, switch mode, fit, resize, set contrast, and add or remove a
//! dataset.
//!
//! Steps go through the page's own input handling. Pan, zoom, and orbit are
//! synthesized as the pointer and wheel events a mouse would raise, over the
//! DevTools protocol, in CSS pixels at the run's device pixel ratio, so a
//! scripted orbit measures the path a person's orbit takes. A mode switch
//! and a fit press the viewer's keys, or tap where the view has no key, and
//! a resize changes the window the page lays out in. Scrub, select,
//! contrast, and adding or removing a dataset have nothing to click on the
//! capture surface, where the selectors, the layer panel, and the add-data
//! dialog are hidden, so they go through the handlers those controls call,
//! which the page exposes on the trace seam for this purpose.
//!
//! By default a pan, zoom, or orbit lands as one quick burst and a scrub as
//! one jump. A duration spreads the gesture's events across that time at
//! display rate, and an interval plays a scrub one position at a time, so
//! the lag a sustained drag or playback shows is exercised.
//!
//! After each step the driver reads the view from the seam and records it
//! beside the view before the step, the run the step opened, and what the
//! page said if it refused the step. A step that did not land is a fact in
//! the run rather than a silence. Each gesture step then waits for the run it
//! opened to conclude, which is what makes one step one interaction run: an
//! input during an open run extends that run rather than opening another.

use std::path::PathBuf;
use std::time::Duration;

use clap::{Arg, ArgAction, ArgMatches, Command};
use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

use lucida_core::saved_view::normalize_dataset_url;

use crate::browser::{Page, Viewport};
use crate::error::{CliError, ErrorKind};
use crate::trace::{CLOSE_AS_TIMEOUT, RunState, json_string, pin_run};

// ---------------------------------------------------------------------------
// The steps
// ---------------------------------------------------------------------------

/// The selectors a scrub moves.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ScrubAxis {
    Z,
    T,
    C,
}

impl std::str::FromStr for ScrubAxis {
    type Err = String;

    fn from_str(text: &str) -> Result<Self, Self::Err> {
        match text {
            "z" | "Z" => Ok(Self::Z),
            "t" | "T" => Ok(Self::T),
            "c" | "C" => Ok(Self::C),
            other => Err(format!(
                "no selector is called {other}; the axes are z, t, and c"
            )),
        }
    }
}

impl std::fmt::Display for ScrubAxis {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(match self {
            Self::Z => "z",
            Self::T => "t",
            Self::C => "c",
        })
    }
}

/// The two views a mode switch moves between.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum ViewMode {
    #[serde(rename = "2d")]
    Slice,
    #[serde(rename = "3d")]
    Volume,
}

impl ViewMode {
    /// The view a camera mode belongs to: the slice camera is 2D, and both
    /// the orbit and the fly camera are 3D.
    pub fn of_camera(mode: &str) -> Option<Self> {
        match mode {
            "slice" => Some(Self::Slice),
            "arcball" | "fly" => Some(Self::Volume),
            _ => None,
        }
    }
}

impl std::str::FromStr for ViewMode {
    type Err = String;

    fn from_str(text: &str) -> Result<Self, Self::Err> {
        match text.to_ascii_lowercase().as_str() {
            "2d" => Ok(Self::Slice),
            "3d" => Ok(Self::Volume),
            _ => Err(format!("a mode is 2d or 3d, not {text}")),
        }
    }
}

impl std::fmt::Display for ViewMode {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(match self {
            Self::Slice => "2d",
            Self::Volume => "3d",
        })
    }
}

/// One step of a script. The same shape is a script file entry and the
/// identity of a step's record, so a record reads back as the step that made
/// it and a bundle's script can be run again.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum ScriptStep {
    /// Wait until the page is quiescent with no run open.
    Wait,
    /// Leave the page alone for this long.
    Hold { ms: u64 },
    /// Drag the pointer by a screen delta, in CSS pixels, as one burst or
    /// spread over `durationMs`.
    Pan {
        dx: f64,
        dy: f64,
        #[serde(
            rename = "durationMs",
            default,
            skip_serializing_if = "Option::is_none"
        )]
        duration_ms: Option<u64>,
    },
    /// Multiply the view's scale by `factor`, about a point in CSS pixels
    /// from the canvas's top-left corner, or about its center when absent,
    /// as one burst or spread over `durationMs`.
    Zoom {
        factor: f64,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        at: Option<[f64; 2]>,
        #[serde(
            rename = "durationMs",
            default,
            skip_serializing_if = "Option::is_none"
        )]
        duration_ms: Option<u64>,
    },
    /// Orbit by two angles in degrees: around the vertical axis, then the
    /// horizontal, as one burst or spread over `durationMs`.
    Orbit {
        theta: f64,
        phi: f64,
        #[serde(
            rename = "durationMs",
            default,
            skip_serializing_if = "Option::is_none"
        )]
        duration_ms: Option<u64>,
    },
    /// Move a selector by a count of positions. On `c` it moves the solo of
    /// the dataset in hand, the composite counting as the position before
    /// the first channel. One jump, or one position every `intervalMs`.
    Scrub {
        axis: ScrubAxis,
        count: i64,
        #[serde(
            rename = "intervalMs",
            default,
            skip_serializing_if = "Option::is_none"
        )]
        interval_ms: Option<u64>,
    },
    /// Show or hide a channel of the dataset in hand, or a layer by dataset id.
    Select {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        channel: Option<u32>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        layer: Option<String>,
        #[serde(default = "visible_by_default")]
        visible: bool,
    },
    /// Switch to the 2D slice view or the 3D volume view.
    Mode { to: ViewMode },
    /// Fit the view to everything visible.
    Fit,
    /// Resize the viewport to this many CSS pixels, at the run's device pixel ratio.
    Resize { width: u32, height: u32 },
    /// Set the contrast window of a channel of the dataset in hand.
    Contrast { channel: u32, min: f64, max: f64 },
    /// Add a dataset to the workspace by its source URL.
    Add { url: String },
    /// Remove the dataset opened from this source URL from the workspace.
    Remove { url: String },
}

fn visible_by_default() -> bool {
    true
}

impl ScriptStep {
    /// The step kind, as the script file and the flags spell it.
    pub fn kind(&self) -> &'static str {
        match self {
            Self::Wait => "wait",
            Self::Hold { .. } => "hold",
            Self::Pan { .. } => "pan",
            Self::Zoom { .. } => "zoom",
            Self::Orbit { .. } => "orbit",
            Self::Scrub { .. } => "scrub",
            Self::Select { .. } => "select",
            Self::Mode { .. } => "mode",
            Self::Fit => "fit",
            Self::Resize { .. } => "resize",
            Self::Contrast { .. } => "contrast",
            Self::Add { .. } => "add",
            Self::Remove { .. } => "remove",
        }
    }

    /// Whether the step is one a person could make. A script is checked
    /// before the browser launches, so a step that could never land is an
    /// error at the command line rather than a run with a silent step.
    pub fn validate(&self) -> Result<(), String> {
        match self {
            Self::Wait => Ok(()),
            Self::Hold { ms: 0 } => Err("a hold of 0 ms holds nothing".to_string()),
            Self::Hold { .. } => Ok(()),
            Self::Pan {
                dx,
                dy,
                duration_ms,
            } => {
                if !dx.is_finite() || !dy.is_finite() {
                    return Err("a pan delta is two finite numbers".to_string());
                }
                if *dx == 0.0 && *dy == 0.0 {
                    return Err("a pan by 0,0 moves nothing".to_string());
                }
                validate_duration("a pan", *duration_ms)
            }
            Self::Zoom {
                factor,
                at,
                duration_ms,
            } => {
                if !factor.is_finite() || *factor <= 0.0 {
                    return Err(format!("a zoom factor is a positive number, not {factor}"));
                }
                if *factor == 1.0 {
                    return Err("a zoom by 1 changes nothing".to_string());
                }
                if let Some(point) = at
                    && !(point[0].is_finite() && point[1].is_finite())
                {
                    return Err("a zoom point is two finite numbers".to_string());
                }
                validate_duration("a zoom", *duration_ms)
            }
            Self::Orbit {
                theta,
                phi,
                duration_ms,
            } => {
                if !theta.is_finite() || !phi.is_finite() {
                    return Err("orbit angles are two finite numbers".to_string());
                }
                if *theta == 0.0 && *phi == 0.0 {
                    return Err("an orbit by 0,0 moves nothing".to_string());
                }
                validate_duration("an orbit", *duration_ms)
            }
            Self::Scrub { count: 0, .. } => Err("a scrub by 0 moves nothing".to_string()),
            Self::Scrub {
                interval_ms: Some(0),
                ..
            } => Err(
                "a scrub interval of 0 ms is a jump; leave the interval out for one".to_string(),
            ),
            Self::Scrub { .. } => Ok(()),
            Self::Select { channel, layer, .. } => match (channel, layer) {
                (Some(_), None) => Ok(()),
                (None, Some(layer)) if !layer.is_empty() => Ok(()),
                (None, Some(_)) => Err("a layer is named by its dataset id".to_string()),
                (Some(_), Some(_)) => {
                    Err("a select names a channel or a layer, not both".to_string())
                }
                (None, None) => Err("a select names a channel or a layer".to_string()),
            },
            Self::Mode { .. } | Self::Fit => Ok(()),
            Self::Resize { width, height } => {
                if *width == 0 || *height == 0 {
                    return Err(format!(
                        "a viewport is at least 1x1 CSS pixels, not {width}x{height}"
                    ));
                }
                Ok(())
            }
            Self::Contrast { min, max, .. } => {
                if !min.is_finite() || !max.is_finite() {
                    return Err("a contrast window is two finite numbers".to_string());
                }
                if min >= max {
                    return Err(format!(
                        "a contrast window's minimum is below its maximum, not {min},{max}"
                    ));
                }
                Ok(())
            }
            Self::Add { url } | Self::Remove { url } => {
                if url.trim().is_empty() {
                    return Err("a dataset is named by its source URL".to_string());
                }
                Ok(())
            }
        }
    }

    /// How long the gesture's events are spread over, or None for a burst.
    fn pace(&self) -> Option<Duration> {
        match self {
            Self::Pan { duration_ms, .. }
            | Self::Zoom { duration_ms, .. }
            | Self::Orbit { duration_ms, .. } => duration_ms.map(Duration::from_millis),
            _ => None,
        }
    }
}

fn validate_duration(what: &str, duration_ms: Option<u64>) -> Result<(), String> {
    if duration_ms == Some(0) {
        return Err(format!(
            "{what} over 0 ms is a burst; leave the duration out for one"
        ));
    }
    Ok(())
}

impl std::fmt::Display for ScriptStep {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Wait => f.write_str("wait"),
            Self::Hold { ms } => write!(f, "hold {ms} ms"),
            Self::Pan {
                dx,
                dy,
                duration_ms,
            } => write!(f, "pan {dx},{dy}{}", pace_suffix(*duration_ms)),
            Self::Zoom {
                factor,
                at: None,
                duration_ms,
            } => write!(f, "zoom ×{factor}{}", pace_suffix(*duration_ms)),
            Self::Zoom {
                factor,
                at: Some([x, y]),
                duration_ms,
            } => write!(f, "zoom ×{factor} at {x},{y}{}", pace_suffix(*duration_ms)),
            Self::Orbit {
                theta,
                phi,
                duration_ms,
            } => write!(f, "orbit {theta}°,{phi}°{}", pace_suffix(*duration_ms)),
            Self::Scrub {
                axis,
                count,
                interval_ms,
            } => write!(f, "scrub {axis}:{count:+}{}", pace_suffix(*interval_ms)),
            Self::Select {
                channel: Some(channel),
                visible,
                ..
            } => write!(f, "select channel:{channel}{}", off_suffix(*visible)),
            Self::Select { layer, visible, .. } => write!(
                f,
                "select layer:{}{}",
                layer.as_deref().unwrap_or(""),
                off_suffix(*visible)
            ),
            Self::Mode { to } => write!(f, "mode {to}"),
            Self::Fit => f.write_str("fit"),
            Self::Resize { width, height } => write!(f, "resize {width}x{height}"),
            Self::Contrast { channel, min, max } => write!(f, "contrast {channel}:{min},{max}"),
            Self::Add { url } => write!(f, "add {url}"),
            Self::Remove { url } => write!(f, "remove {url}"),
        }
    }
}

fn off_suffix(visible: bool) -> &'static str {
    if visible { "" } else { "=off" }
}

/// A duration or an interval as its flag spells it: `/MS` after the step.
fn pace_suffix(ms: Option<u64>) -> String {
    ms.map(|ms| format!("/{ms}")).unwrap_or_default()
}

/// A script: the steps in the order they run.
#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
pub struct Script {
    pub steps: Vec<ScriptStep>,
}

impl Script {
    /// Read a script file: `{"steps": [...]}`, or a bare array of steps.
    /// Every step is validated, so the error names the step that could never
    /// land rather than the run recording that it did not.
    pub fn from_json(text: &str) -> Result<Self, String> {
        let value: Value =
            serde_json::from_str(text).map_err(|error| format!("not JSON: {error}"))?;
        let steps = match value {
            Value::Array(_) => value,
            Value::Object(mut object) => object.remove("steps").ok_or_else(|| {
                "a script is {\"steps\": [...]} or a bare array of steps".to_string()
            })?,
            _ => return Err("a script is {\"steps\": [...]} or a bare array of steps".to_string()),
        };
        let steps: Vec<ScriptStep> = serde_json::from_value(steps).map_err(|error| {
            format!(
                "a step could not be read: {error}; the kinds are wait, hold, pan, zoom, orbit, \
                 scrub, select, mode, fit, resize, contrast, add, and remove"
            )
        })?;
        let script = Self { steps };
        script.validate()?;
        Ok(script)
    }

    /// A script from steps already in hand: a bundle's, to run again.
    /// Validated as a file's steps are, so a step that could never land is
    /// refused before a browser is launched.
    pub fn from_steps(steps: Vec<ScriptStep>) -> Result<Self, String> {
        let script = Self { steps };
        script.validate()?;
        Ok(script)
    }

    pub fn is_empty(&self) -> bool {
        self.steps.is_empty()
    }

    fn validate(&self) -> Result<(), String> {
        for (index, step) in self.steps.iter().enumerate() {
            step.validate()
                .map_err(|reason| format!("step {} ({}): {reason}", index + 1, step.kind()))?;
        }
        Ok(())
    }

    /// The source URLs the add and remove steps name, for a caller to
    /// resolve before they leave this process: a relative path means this
    /// process's working directory, which the server cannot know.
    pub fn dataset_urls_mut(&mut self) -> impl Iterator<Item = &mut String> {
        self.steps.iter_mut().filter_map(|step| match step {
            ScriptStep::Add { url } | ScriptStep::Remove { url } => Some(url),
            _ => None,
        })
    }

    /// What the workspace has to hold before the script runs for each add
    /// and remove to land, in canonical form: a dataset the script adds
    /// before any step removes it has to be absent, and one it removes
    /// before any step adds it has to be present. Adding and removing change
    /// the workspace itself, so without this a script would land once and
    /// be refused on every run after.
    pub fn dataset_preconditions(&self) -> DatasetPreconditions {
        let mut seen = Vec::new();
        let mut preconditions = DatasetPreconditions::default();
        for step in &self.steps {
            let (url, added) = match step {
                ScriptStep::Add { url } => (url, true),
                ScriptStep::Remove { url } => (url, false),
                _ => continue,
            };
            let url = normalize_dataset_url(url);
            if seen.contains(&url) {
                continue;
            }
            seen.push(url.clone());
            if added {
                preconditions.absent.push(url);
            } else {
                preconditions.present.push(url);
            }
        }
        preconditions
    }

    /// The datasets open before the script ran, from those open after it,
    /// in canonical form: each add undone and each remove put back, last
    /// step first. A replay reads the bundle's datasets at its close and
    /// starts from these.
    pub fn datasets_before(&self, after: &[String]) -> Vec<String> {
        let mut open: Vec<String> = after.iter().map(|url| normalize_dataset_url(url)).collect();
        for step in self.steps.iter().rev() {
            match step {
                ScriptStep::Add { url } => {
                    let url = normalize_dataset_url(url);
                    open.retain(|open| *open != url);
                }
                ScriptStep::Remove { url } => {
                    let url = normalize_dataset_url(url);
                    if !open.contains(&url) {
                        open.push(url);
                    }
                }
                _ => {}
            }
        }
        open
    }
}

/// The datasets a script needs the workspace to lack and to hold before it
/// runs, by canonical source URL.
#[derive(Debug, Clone, PartialEq, Default)]
pub struct DatasetPreconditions {
    pub absent: Vec<String>,
    pub present: Vec<String>,
}

// ---------------------------------------------------------------------------
// The flags
// ---------------------------------------------------------------------------

/// The per-step flags, each one kind, and the script file. Flattened onto
/// `lucida trace`. The flags keep their command-line order, which is the
/// order the steps run in: `--orbit 30,0 --wait --scrub t:1` is those three
/// steps in that order, however clap groups them by name.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct ScriptArgs {
    /// Steps from the per-step flags, in command-line order.
    pub steps: Vec<ScriptStep>,
    /// A script file, when one was named instead of flags.
    pub file: Option<PathBuf>,
}

/// The flag ids, in the order their help prints. `wait`, `hold`, and `fit`
/// carry no text to parse; the rest go through `step_from_flag`.
const STEP_FLAGS: [&str; 13] = [
    "wait",
    "hold",
    "pan",
    "zoom_by",
    "orbit",
    "scrub",
    "select",
    "mode",
    "fit",
    "resize",
    "set_contrast",
    "add",
    "remove",
];

/// The flags that carry no value, each occurrence one step.
const BARE_FLAGS: [(&str, ScriptStep); 2] = [("wait", ScriptStep::Wait), ("fit", ScriptStep::Fit)];

impl clap::Args for ScriptArgs {
    fn augment_args(cmd: Command) -> Command {
        cmd.next_help_heading("Script steps, run in command-line order after the open settles")
            .arg(
                Arg::new("script")
                    .long("script")
                    .value_name("PATH")
                    .value_parser(clap::value_parser!(PathBuf))
                    .conflicts_with_all(STEP_FLAGS)
                    .help("Run the steps in this JSON file: {\"steps\": [{\"kind\": \"orbit\", \"theta\": 30, \"phi\": 0}, ...]}"),
            )
            .arg(
                // Appended rather than counted: a count keeps one index for
                // the whole flag, and the steps need the index of each
                // occurrence to keep their command-line order.
                Arg::new("wait")
                    .long("wait")
                    .action(ArgAction::Append)
                    .num_args(0)
                    .default_missing_value("wait")
                    .value_parser(clap::value_parser!(String))
                    .help("Wait until the page is quiescent with no run open"),
            )
            .arg(
                Arg::new("hold")
                    .long("hold")
                    .value_name("MS")
                    .action(ArgAction::Append)
                    .value_parser(clap::value_parser!(u64))
                    .help("Leave the page alone for this many milliseconds"),
            )
            .arg(
                Arg::new("pan")
                    .long("pan")
                    .value_name("DX,DY[/MS]")
                    .action(ArgAction::Append)
                    .allow_hyphen_values(true)
                    .help(
                        "Drag the pointer by this screen delta, in CSS pixels: a plain drag in \
                         slice mode, a shift drag in volume mode. Add /MS to spread the drag over \
                         that many milliseconds at display rate",
                    ),
            )
            .arg(
                Arg::new("zoom_by")
                    .long("zoom-by")
                    .value_name("FACTOR[@X,Y][/MS]")
                    .action(ArgAction::Append)
                    .help(
                        "Multiply the view's scale by FACTOR, about a point in CSS pixels from the \
                         canvas's top-left corner, or about its center. Wheel events in slice mode, \
                         quantised to the viewer's notch; one wheel event in volume mode. Add /MS \
                         to spread the wheel events over that many milliseconds",
                    ),
            )
            .arg(
                Arg::new("orbit")
                    .long("orbit")
                    .value_name("THETA,PHI[/MS]")
                    .action(ArgAction::Append)
                    .allow_hyphen_values(true)
                    .help(
                        "Orbit by two angles in degrees, as a drag in volume mode. Add /MS to \
                         spread the drag over that many milliseconds at display rate",
                    ),
            )
            .arg(
                Arg::new("scrub")
                    .long("scrub")
                    .value_name("AXIS:COUNT[/MS]")
                    .action(ArgAction::Append)
                    .allow_hyphen_values(true)
                    .help(
                        "Move the z or t selector by COUNT positions, for example t:1 or z:-5. \
                         c solos the channels of the dataset in hand in turn: the composite \
                         counts as the position before channel 1, so c:1 from the composite \
                         solos channel 1 and c:-1 from channel 1 returns to the composite. Add \
                         /MS to move one position every MS milliseconds instead of jumping",
                    ),
            )
            .arg(
                Arg::new("select")
                    .long("select")
                    .value_name("TARGET[=off]")
                    .action(ArgAction::Append)
                    .help(
                        "Show a channel of the dataset in hand or a layer by dataset id: channel:1 or \
                         layer:ID. Add =off to hide it instead",
                    ),
            )
            .arg(
                Arg::new("mode")
                    .long("mode")
                    .value_name("2d|3d")
                    .action(ArgAction::Append)
                    .help("Switch to the slice view or the volume view, as the M key does"),
            )
            .arg(
                Arg::new("fit")
                    .long("fit")
                    .action(ArgAction::Append)
                    .num_args(0)
                    .default_missing_value("fit")
                    .value_parser(clap::value_parser!(String))
                    .help(
                        "Fit the view to everything visible: the 0 key in slice mode, a double tap \
                         in volume mode",
                    ),
            )
            .arg(
                Arg::new("resize")
                    .long("resize")
                    .value_name("WIDTHxHEIGHT")
                    .action(ArgAction::Append)
                    .help("Resize the viewport to this many CSS pixels, at the run's device pixel ratio"),
            )
            .arg(
                Arg::new("set_contrast")
                    .long("set-contrast")
                    .value_name("CHANNEL:MIN,MAX")
                    .action(ArgAction::Append)
                    .allow_hyphen_values(true)
                    .help(
                        "Set the contrast window of a channel of the dataset in hand, as dragging \
                         its limits does, which stops auto-contrast for the dataset",
                    ),
            )
            .arg(
                Arg::new("add")
                    .long("add")
                    .value_name("URL")
                    .action(ArgAction::Append)
                    .help(
                        "Add a dataset to the run's workspace, as the add-data dialog does. The \
                         driver removes it from the workspace before the run if it is there",
                    ),
            )
            .arg(
                Arg::new("remove")
                    .long("remove")
                    .value_name("URL")
                    .action(ArgAction::Append)
                    .help(
                        "Remove the dataset opened from this source URL from the run's workspace, \
                         as the layer panel does. The driver opens it before the run if it is not \
                         there",
                    ),
            )
            .next_help_heading(None)
    }

    fn augment_args_for_update(cmd: Command) -> Command {
        Self::augment_args(cmd)
    }
}

impl clap::FromArgMatches for ScriptArgs {
    fn from_arg_matches(matches: &ArgMatches) -> Result<Self, clap::Error> {
        let mut ordered: Vec<(usize, ScriptStep)> = Vec::new();
        for (id, step) in &BARE_FLAGS {
            if let Some(indices) = matches.indices_of(id) {
                ordered.extend(indices.map(|index| (index, step.clone())));
            }
        }
        if let (Some(values), Some(indices)) =
            (matches.get_many::<u64>("hold"), matches.indices_of("hold"))
        {
            ordered.extend(
                values
                    .zip(indices)
                    .map(|(ms, index)| (index, ScriptStep::Hold { ms: *ms })),
            );
        }
        for id in STEP_FLAGS {
            if id == "hold" || BARE_FLAGS.iter().any(|(bare, _)| *bare == id) {
                continue;
            }
            let (Some(values), Some(indices)) =
                (matches.get_many::<String>(id), matches.indices_of(id))
            else {
                continue;
            };
            for (text, index) in values.zip(indices) {
                let step = step_from_flag(id, text).map_err(|reason| {
                    clap::Error::raw(
                        clap::error::ErrorKind::ValueValidation,
                        format!(
                            "invalid value '{text}' for '--{}': {reason}\n",
                            id.replace('_', "-")
                        ),
                    )
                })?;
                ordered.push((index, step));
            }
        }
        ordered.sort_by_key(|(index, _)| *index);
        let steps: Vec<ScriptStep> = ordered.into_iter().map(|(_, step)| step).collect();
        for (n, step) in steps.iter().enumerate() {
            step.validate().map_err(|reason| {
                clap::Error::raw(
                    clap::error::ErrorKind::ValueValidation,
                    format!("step {} (--{}): {reason}\n", n + 1, flag_of(step)),
                )
            })?;
        }
        Ok(Self {
            steps,
            file: matches.get_one::<PathBuf>("script").cloned(),
        })
    }

    fn update_from_arg_matches(&mut self, matches: &ArgMatches) -> Result<(), clap::Error> {
        *self = Self::from_arg_matches(matches)?;
        Ok(())
    }
}

impl ScriptArgs {
    /// The script to run: the file's steps when a file was named, else the
    /// flags' steps in order. Empty when neither was given, which is the
    /// driver's default: an open and nothing after it.
    pub fn resolve(&self) -> Result<Script, CliError> {
        let Some(path) = &self.file else {
            return Ok(Script {
                steps: self.steps.clone(),
            });
        };
        let text = std::fs::read_to_string(path).map_err(|error| {
            CliError::new(
                ErrorKind::Io,
                format!("could not read the script {}: {error}", path.display()),
            )
        })?;
        Script::from_json(&text).map_err(|reason| {
            CliError::new(
                ErrorKind::Config,
                format!("the script {} could not be used: {reason}", path.display()),
            )
        })
    }
}

/// The flag a step is typed with, without its dashes.
fn flag_of(step: &ScriptStep) -> &'static str {
    match step {
        ScriptStep::Zoom { .. } => "zoom-by",
        ScriptStep::Contrast { .. } => "set-contrast",
        other => other.kind(),
    }
}

/// One flag's text as a step: `DX,DY`, `FACTOR[@X,Y]`, `THETA,PHI`, or
/// `AXIS:COUNT`, each with an optional `/MS`; `channel:N[=off]` /
/// `layer:ID[=off]`; `2d` / `3d`; `WIDTHxHEIGHT`; `CHANNEL:MIN,MAX`; or a
/// dataset URL.
pub fn step_from_flag(id: &str, text: &str) -> Result<ScriptStep, String> {
    match id {
        "pan" => {
            let (text, duration_ms) = split_pace(text)?;
            let (dx, dy) = parse_pair(text)?;
            Ok(ScriptStep::Pan {
                dx,
                dy,
                duration_ms,
            })
        }
        "orbit" => {
            let (text, duration_ms) = split_pace(text)?;
            let (theta, phi) = parse_pair(text)?;
            Ok(ScriptStep::Orbit {
                theta,
                phi,
                duration_ms,
            })
        }
        "zoom_by" => {
            let (text, duration_ms) = split_pace(text)?;
            let (factor, at) = match text.split_once('@') {
                Some((factor, point)) => (factor, Some(parse_pair(point)?)),
                None => (text, None),
            };
            let factor = parse_number(factor)?;
            Ok(ScriptStep::Zoom {
                factor,
                at: at.map(|(x, y)| [x, y]),
                duration_ms,
            })
        }
        "scrub" => {
            let (text, interval_ms) = split_pace(text)?;
            let (axis, count) = text
                .split_once(':')
                .ok_or_else(|| "a scrub is AXIS:COUNT, for example t:1".to_string())?;
            let axis: ScrubAxis = axis.parse()?;
            let count: i64 = count
                .parse()
                .map_err(|_| format!("a scrub count is a whole number, not {count}"))?;
            Ok(ScriptStep::Scrub {
                axis,
                count,
                interval_ms,
            })
        }
        "mode" => Ok(ScriptStep::Mode { to: text.parse()? }),
        "resize" => {
            let (width, height) = text.split_once(['x', 'X']).ok_or_else(|| {
                format!("a size is WIDTHxHEIGHT, for example 1280x720, not {text}")
            })?;
            let pixels = |side: &str| {
                side.trim()
                    .parse::<u32>()
                    .map_err(|_| format!("a size is two whole numbers of CSS pixels, not {text}"))
            };
            Ok(ScriptStep::Resize {
                width: pixels(width)?,
                height: pixels(height)?,
            })
        }
        "set_contrast" => {
            let (channel, window) = text.split_once(':').ok_or_else(|| {
                "a contrast window is CHANNEL:MIN,MAX, for example 0:100,2000".to_string()
            })?;
            let channel: u32 = channel
                .parse()
                .map_err(|_| format!("a channel is a whole number from 0, not {channel}"))?;
            let (min, max) = parse_pair(window)?;
            Ok(ScriptStep::Contrast { channel, min, max })
        }
        "add" => Ok(ScriptStep::Add {
            url: text.to_string(),
        }),
        "remove" => Ok(ScriptStep::Remove {
            url: text.to_string(),
        }),
        "select" => {
            let (target, visible) = match text.rsplit_once('=') {
                Some((target, "off")) => (target, false),
                Some((_, other)) => {
                    return Err(format!("a select ends in =off to hide, not ={other}"));
                }
                None => (text, true),
            };
            let (kind, name) = target
                .split_once(':')
                .ok_or_else(|| "a select is channel:N or layer:ID".to_string())?;
            match kind {
                "channel" => {
                    let channel: u32 = name
                        .parse()
                        .map_err(|_| format!("a channel is a whole number from 0, not {name}"))?;
                    Ok(ScriptStep::Select {
                        channel: Some(channel),
                        layer: None,
                        visible,
                    })
                }
                "layer" if !name.is_empty() => Ok(ScriptStep::Select {
                    channel: None,
                    layer: Some(name.to_string()),
                    visible,
                }),
                "layer" => Err("a layer is named by its dataset id".to_string()),
                other => Err(format!("a select is channel:N or layer:ID, not {other}:…")),
            }
        }
        other => Err(format!("no step flag is called {other}")),
    }
}

/// A flag's text and the `/MS` after it, when it has one.
fn split_pace(text: &str) -> Result<(&str, Option<u64>), String> {
    let Some((step, ms)) = text.rsplit_once('/') else {
        return Ok((text, None));
    };
    let ms = ms
        .trim()
        .parse::<u64>()
        .map_err(|_| format!("a pace is /MS, whole milliseconds, not /{ms}"))?;
    Ok((step, Some(ms)))
}

fn parse_pair(text: &str) -> Result<(f64, f64), String> {
    let (a, b) = text
        .split_once(',')
        .ok_or_else(|| format!("two numbers separated by a comma, not {text}"))?;
    Ok((parse_number(a)?, parse_number(b)?))
}

fn parse_number(text: &str) -> Result<f64, String> {
    text.trim()
        .parse::<f64>()
        .map_err(|_| format!("a number, not {text}"))
}

// ---------------------------------------------------------------------------
// How a step becomes input
// ---------------------------------------------------------------------------

/// How far a drag or a wheel event moves the view, as the viewers apply it.
/// The page publishes its own on the seam, and the driver uses those, so a
/// scripted orbit is the drag a person would make with the constants the
/// page applies. The defaults are the viewers' values for a page too old to
/// publish any.
#[derive(Debug, Clone, Copy, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InputScale {
    /// Radians of orbit per CSS pixel of drag in the volume view.
    pub orbit_radians_per_pixel: f64,
    /// The slice view's zoom per wheel event, in and out.
    pub slice_zoom_in_per_notch: f64,
    pub slice_zoom_out_per_notch: f64,
    /// The volume view scales its camera distance by `1 + deltaY × this` per wheel event.
    pub volume_zoom_per_wheel_delta: f64,
}

impl Default for InputScale {
    fn default() -> Self {
        Self {
            orbit_radians_per_pixel: 0.005,
            slice_zoom_in_per_notch: 1.1,
            slice_zoom_out_per_notch: 0.9,
            volume_zoom_per_wheel_delta: 0.001,
        }
    }
}

/// The wheel delta of one notch, the value a mouse wheel raises.
pub const WHEEL_NOTCH_DELTA: f64 = 100.0;

/// Moves per drag: about one per this many CSS pixels, one frame apart, so a
/// scripted drag has a duration and a frame-time shape like a person's.
const PIXELS_PER_MOVE: f64 = 8.0;
const MIN_MOVES: usize = 4;
const MAX_MOVES: usize = 60;
const MOVE_INTERVAL: Duration = Duration::from_millis(16);

/// The DevTools protocol's modifier bit for Shift, which turns a drag in the
/// volume view from an orbit into a pan.
const SHIFT_MODIFIER: u32 = 8;

/// The drag, in CSS pixels, that orbits by the two angles in degrees. The
/// viewer negates the drag, so the sign here undoes that.
pub fn orbit_drag(theta_degrees: f64, phi_degrees: f64, scale: InputScale) -> (f64, f64) {
    (
        -theta_degrees.to_radians() / scale.orbit_radians_per_pixel,
        -phi_degrees.to_radians() / scale.orbit_radians_per_pixel,
    )
}

/// The wheel notches that zoom a slice view by about `factor`: positive in,
/// negative out, with the factor the notches reach, since the viewer zooms
/// by a fixed step per notch. A factor between one notch out and one in
/// still sends one notch, because a zoom step that sent nothing would not
/// be a zoom.
pub fn slice_zoom_notches(factor: f64, scale: InputScale) -> (i64, f64) {
    if factor > 1.0 {
        let step = scale.slice_zoom_in_per_notch;
        let notches = (factor.ln() / step.ln()).round().max(1.0) as i64;
        (notches, step.powi(notches as i32))
    } else {
        let step = scale.slice_zoom_out_per_notch;
        let notches = (factor.ln() / step.ln()).round().max(1.0) as i64;
        (-notches, step.powi(notches as i32))
    }
}

/// The wheel delta each of `events` equal wheel events carries so that
/// together they scale a volume view by `factor`: the camera distance
/// divides by the factor, so zooming in by 2 halves it. The viewer scales
/// the distance per event, so the events compound rather than add.
pub fn volume_zoom_step(factor: f64, events: u32, scale: InputScale) -> f64 {
    ((1.0 / factor).powf(1.0 / f64::from(events.max(1))) - 1.0) / scale.volume_zoom_per_wheel_delta
}

/// The interval paced input is sent at: one event per frame of a 60 Hz
/// display, the rate a person's pointer reports at.
pub const DISPLAY_INTERVAL: Duration = Duration::from_micros(16_667);

/// How many display intervals fit in `span`, and at least one, so a paced
/// gesture shorter than a frame still moves.
pub fn paced_moves(span: Duration) -> usize {
    ((span.as_secs_f64() / DISPLAY_INTERVAL.as_secs_f64()).round() as usize).max(1)
}

/// When the `n`th of `count` evenly spaced events falls in `span`, the
/// first at its start and the last at its end.
pub fn paced_offset(n: usize, count: usize, span: Duration) -> Duration {
    if count <= 1 {
        return Duration::ZERO;
    }
    span.mul_f64(n as f64 / (count - 1) as f64)
}

/// The pointer's offsets from where it pressed, one per move, ending exactly
/// on the delta.
pub fn drag_path(delta: (f64, f64), moves: usize) -> Vec<(f64, f64)> {
    let moves = moves.max(1);
    (1..=moves)
        .map(|n| {
            let fraction = n as f64 / moves as f64;
            (delta.0 * fraction, delta.1 * fraction)
        })
        .collect()
}

/// How many moves a drag of `delta` takes.
pub fn drag_moves(delta: (f64, f64)) -> usize {
    let length = (delta.0 * delta.0 + delta.1 * delta.1).sqrt();
    ((length / PIXELS_PER_MOVE).ceil() as usize).clamp(MIN_MOVES, MAX_MOVES)
}

/// The canvas as the page lays it out, in CSS pixels.
#[derive(Debug, Clone, Copy, PartialEq, Deserialize)]
pub struct CanvasRect {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

impl CanvasRect {
    pub fn center(&self) -> (f64, f64) {
        (self.x + self.width / 2.0, self.y + self.height / 2.0)
    }

    /// A point given relative to the canvas's top-left corner, in page coordinates.
    pub fn point(&self, at: [f64; 2]) -> (f64, f64) {
        (self.x + at[0], self.y + at[1])
    }

    /// Where a drag of `delta` starts so that it is centered on the canvas
    /// and stays inside it where it can: half the delta before the center,
    /// clamped to the canvas.
    pub fn drag_origin(&self, delta: (f64, f64)) -> (f64, f64) {
        let (cx, cy) = self.center();
        let x = (cx - delta.0 / 2.0).clamp(self.x, self.x + self.width);
        let y = (cy - delta.1 / 2.0).clamp(self.y, self.y + self.height);
        (x, y)
    }
}

/// What the driver sent for a step, so a reader can check the mapping from
/// the step's parameters to the input the page received.
///
/// `span_ms` is set on paced input only: the time from sending the first
/// event to sending the last, by the driver's clock, which a reader holds
/// against the step's duration or interval.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "sent", rename_all = "camelCase")]
pub enum SentInput {
    /// A pointer drag from `from` to `to` in CSS pixels, over `moves` move
    /// events, with Shift held when `shift` is true.
    #[serde(rename_all = "camelCase")]
    Drag {
        from: [f64; 2],
        to: [f64; 2],
        moves: usize,
        shift: bool,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        span_ms: Option<f64>,
    },
    /// `notches` wheel events at `at`, each carrying `delta_y`, which amount
    /// to a zoom by `factor`: the asked-for factor in volume mode, and the
    /// nearest the slice view's fixed step reaches otherwise.
    #[serde(rename_all = "camelCase")]
    Wheel {
        at: [f64; 2],
        delta_y: f64,
        notches: u32,
        factor: f64,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        span_ms: Option<f64>,
    },
    /// A call on the seam's control entry, and what the page answered. A
    /// paced scrub calls it once per position, and `moves` counts the
    /// positions that landed.
    #[serde(rename_all = "camelCase")]
    Control {
        applied: bool,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        reason: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        moves: Option<u32>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        span_ms: Option<f64>,
    },
    /// A key pressed and released, named as the viewer's shortcuts name it.
    Key { key: String },
    /// `taps` touch taps at `at`, in CSS pixels.
    Tap { at: [f64; 2], taps: u32 },
    /// The viewport changed from `from` to `to`, in CSS pixels, at the same
    /// device pixel ratio.
    Resize { from: [u32; 2], to: [u32; 2] },
    /// Nothing: the step cannot land in the view the page is showing, so
    /// the driver sent no input rather than one the page would take as
    /// another gesture. An orbit on a slice view is the case.
    Withheld { reason: String },
}

impl SentInput {
    fn span_ms(&self) -> Option<f64> {
        match self {
            Self::Drag { span_ms, .. }
            | Self::Wheel { span_ms, .. }
            | Self::Control { span_ms, .. } => *span_ms,
            _ => None,
        }
    }
}

// ---------------------------------------------------------------------------
// The record
// ---------------------------------------------------------------------------

/// The verdict of the run a step opened, as the page derived it at export.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct StepVerdict {
    pub kind: String,
    pub text: String,
}

/// Whether a verdict kind fails the gate: a stall, a run that never
/// settled, or a steady-state finding after the view settled. The kinds are
/// the page's ruleset's.
pub fn failing_verdict(kind: &str) -> bool {
    kind == "stall" || kind == "unsettled" || kind == "steady-state"
}

/// One step and what it did. The step's own fields are flattened in, so the
/// record reads back as a `ScriptStep` and a bundle's script can run again.
/// The run fields are filled by the page at export, from the run the step
/// opened; the rest the driver observed.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StepRecord {
    #[serde(flatten)]
    pub step: ScriptStep,
    /// The page's clock when the step began and ended, in milliseconds since
    /// the page's time origin, the clock the trace's rows are on.
    pub started_at_ms: f64,
    pub ended_at_ms: f64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub input: Option<SentInput>,
    /// The run the step opened, or null when its input opened none.
    pub run_id: Option<String>,
    #[serde(default)]
    pub cause: Option<Value>,
    #[serde(default)]
    pub end_reason: Option<String>,
    #[serde(default)]
    pub duration_us: Option<f64>,
    #[serde(default)]
    pub verdict: Option<StepVerdict>,
    /// The lag reading of the run the step opened, as the page's diagnostic
    /// states it: input to frame, long tasks and dropped frames. Absent when
    /// the run took no input.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub lag: Option<Value>,
    /// Whether the driver's deadline passed while waiting for this step: for
    /// a wait, for quiescence; for a gesture, for its run to conclude.
    pub timed_out: bool,
    /// The view as the page would save it, before and after.
    pub view_before: Value,
    pub view_after: Value,
    /// Whether the page's view signature differs between the two: camera,
    /// selectors, and what is shown, by the page's own rule.
    pub view_changed: bool,
}

/// The script and its records, as the run file's header and the bundle carry it.
#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
pub struct ScriptRecord {
    pub steps: Vec<StepRecord>,
}

impl ScriptRecord {
    /// The run the last step opened, which the export reads as the run the
    /// file is about. None when no step opened one, so the open's run stays.
    pub fn last_run_id(&self) -> Option<&str> {
        self.steps
            .iter()
            .rev()
            .find_map(|step| step.run_id.as_deref())
    }
}

// ---------------------------------------------------------------------------
// Driving the steps
// ---------------------------------------------------------------------------

/// Whether the seam on this page has the entries the steps need. Null until
/// the bundle has installed the seam; false on a page older than them.
const SCRIPT_SEAM_PROBE: &str = "window.lucidaTrace ? (typeof window.lucidaTrace.view === 'function' \
     && typeof window.lucidaTrace.viewSignature === 'function' \
     && typeof window.lucidaTrace.scrub === 'function' \
     && typeof window.lucidaTrace.select === 'function') : null";

/// One evaluation for everything a step is judged by: the page's clock, the
/// run state, the published quiescence, the hold window, the input scale,
/// the view, and its signature.
const STEP_STATE_PROBE: &str = r#"(() => {
  const seam = window.lucidaTrace;
  if (!seam) return null;
  const quiescence = seam.quiescence;
  return JSON.stringify({
    now: performance.now(),
    runState: seam.runState,
    quiescent: quiescence ? quiescence.quiescent : null,
    holdMs: seam.quiescenceHoldMs,
    inputScale: seam.inputScale || null,
    view: seam.view(),
    signature: seam.viewSignature()
  });
})()"#;

/// The viewer's canvas, and not an overlay's: the one in the canvas wrap,
/// with a bare canvas as the fallback on an older page.
const CANVAS_RECT_PROBE: &str = r#"(() => {
  const canvas = document.querySelector('.viewer-canvas-wrap canvas') || document.querySelector('canvas');
  if (!canvas) return null;
  const rect = canvas.getBoundingClientRect();
  return JSON.stringify({ x: rect.left, y: rect.top, width: rect.width, height: rect.height });
})()"#;

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct StepState {
    now: f64,
    run_state: RunState,
    quiescent: Option<bool>,
    hold_ms: Option<f64>,
    #[serde(default)]
    input_scale: Option<InputScale>,
    #[serde(default)]
    view: Value,
    #[serde(default)]
    signature: Value,
}

impl StepState {
    fn camera_mode(&self) -> Option<&str> {
        self.view.get("camera")?.get("mode")?.as_str()
    }
}

const POLL: Duration = Duration::from_millis(100);

/// How long a step whose input lands a frame or a render later waits for
/// the run it opens before reporting that it opened none. A mode switch
/// opens its run when the new view mounts, and a resize when the page next
/// lays out; both are well inside this.
const RUN_OPEN_GRACE: Duration = Duration::from_secs(2);

/// How long the page is given to answer an add beyond the run's deadline:
/// the page gives up at the deadline and says so, and the protocol call
/// waits a little longer for that answer.
const ADD_ANSWER_MARGIN: Duration = Duration::from_secs(5);

/// The gap between the two taps of a double tap, well inside the viewer's
/// double-tap window.
const TAP_GAP: Duration = Duration::from_millis(80);

/// A key as the DevTools protocol sends it.
struct KeyPress {
    /// The combo the viewer's shortcut table names it by.
    combo: &'static str,
    key: &'static str,
    code: &'static str,
    virtual_key: u32,
}

/// The keys the viewer binds to switching mode and to fitting the slice
/// view. A rebinding in the viewer has to be made here as well.
const MODE_KEY: KeyPress = KeyPress {
    combo: "M",
    key: "m",
    code: "KeyM",
    virtual_key: 77,
};
const FIT_KEY: KeyPress = KeyPress {
    combo: "0",
    key: "0",
    code: "Digit0",
    virtual_key: 48,
};

/// Run `script` on `page`, which has finished its open at `viewport`. Each
/// gesture step waits for the run it opened to conclude, under the same
/// deadline the open had, and closes it as `timeout` when it does not. The
/// record is left on the page for the export to fill in each step's run and
/// hand back, and the last step's run is pinned as the run the file is
/// about. Returns the viewport the page is left at, which a resize step
/// changes.
pub async fn run_script(
    page: &mut Page,
    script: &Script,
    viewport: Viewport,
    wait: Duration,
) -> Result<Viewport, CliError> {
    wait_for_script_seam(page, wait).await?;
    let mut viewport = viewport;
    let mut steps = Vec::with_capacity(script.steps.len());
    for step in &script.steps {
        steps.push(run_step(page, step, &mut viewport, wait).await?);
    }
    let record = ScriptRecord { steps };
    let json = serde_json::to_string(&record)?;
    page.evaluate(
        &format!("(window.__lucidaTraceScript = {json}, true)"),
        wait,
    )
    .await?;
    pin_run(page, record.last_run_id(), wait).await?;
    Ok(viewport)
}

async fn run_step(
    page: &mut Page,
    step: &ScriptStep,
    viewport: &mut Viewport,
    wait: Duration,
) -> Result<StepRecord, CliError> {
    let before = read_step_state(page, wait).await?;
    let scale = before.input_scale.unwrap_or_default();
    let mode = before.camera_mode();
    let pace = step.pace();
    let mut input = None;
    let mut run_id = None;
    let mut timed_out = false;
    // Whether the page opens the step's run after the input's own task.
    let mut lands_later = false;
    match step {
        ScriptStep::Wait => {
            timed_out = !wait_for_quiescence(page, wait, before.hold_ms).await?;
        }
        ScriptStep::Hold { ms } => tokio::time::sleep(Duration::from_millis(*ms)).await,
        // A drag pans the slice view and orbits the volume view, where a
        // shift drag pans instead. Sent only where it means what the step
        // says, so a step never lands as another gesture under another name.
        ScriptStep::Pan { dx, dy, .. } => {
            input = Some(match mode {
                Some("slice") => drag(page, (*dx, *dy), false, pace, wait).await?,
                Some("arcball") => drag(page, (*dx, *dy), true, pace, wait).await?,
                other => withheld("a pan", "the slice or the volume view", other),
            });
        }
        ScriptStep::Orbit { theta, phi, .. } => {
            input = Some(match mode {
                Some("arcball") => {
                    drag(page, orbit_drag(*theta, *phi, scale), false, pace, wait).await?
                }
                other => withheld("an orbit", "the volume view", other),
            });
        }
        ScriptStep::Zoom { factor, at, .. } => {
            input = Some(wheel_zoom(page, *factor, *at, mode, scale, pace, wait).await?);
        }
        ScriptStep::Scrub {
            axis,
            count,
            interval_ms: None,
        } => {
            let expression = format!(
                "JSON.stringify(window.lucidaTrace.scrub({}, {count}))",
                json_string(&axis.to_string())
            );
            input = Some(control_outcome(page, &expression, wait).await?);
        }
        ScriptStep::Scrub {
            axis,
            count,
            interval_ms: Some(ms),
        } => {
            input = Some(paced_scrub(page, *axis, *count, Duration::from_millis(*ms), wait).await?);
        }
        ScriptStep::Select {
            channel,
            layer,
            visible,
        } => {
            let target = match (channel, layer) {
                (Some(channel), _) => json!({ "channel": channel }),
                (None, layer) => json!({ "layer": layer }),
            };
            let expression =
                format!("JSON.stringify(window.lucidaTrace.select({target}, {visible}))");
            input = Some(control_outcome(page, &expression, wait).await?);
        }
        ScriptStep::Mode { to } => {
            input = Some(match mode.map(|mode| (mode, ViewMode::of_camera(mode))) {
                Some((_, Some(current))) if current == *to => SentInput::Withheld {
                    reason: format!("the page already shows the {to} view"),
                },
                Some((_, Some(_))) => {
                    lands_later = true;
                    press_key(page, &MODE_KEY, wait).await?
                }
                other => withheld(
                    "a mode switch",
                    "the slice or the volume view",
                    other.map(|(mode, _)| mode),
                ),
            });
        }
        // The volume view binds no fit key; a double tap is how a person
        // fits it there, and the slice view's double tap zooms instead.
        ScriptStep::Fit => {
            input = Some(match mode {
                Some("slice") => press_key(page, &FIT_KEY, wait).await?,
                Some("arcball") => double_tap(page, wait).await?,
                other => withheld("a fit", "the slice view or the orbit camera", other),
            });
        }
        // A headless window has no frame to drag, and the device metrics
        // the launch set are the window the page lays out in, so a resize
        // changes those, at the run's device pixel ratio.
        ScriptStep::Resize { width, height } => {
            let from = [viewport.width, viewport.height];
            input = Some(if from == [*width, *height] {
                SentInput::Withheld {
                    reason: format!("the viewport is already {width}x{height}"),
                }
            } else {
                let to = Viewport::new(*width, *height, viewport.device_scale_factor);
                page.set_viewport(to, wait).await?;
                *viewport = to;
                lands_later = true;
                SentInput::Resize {
                    from,
                    to: [*width, *height],
                }
            });
        }
        ScriptStep::Contrast { channel, min, max } => {
            let expression = seam_call("contrast", &format!("{channel}, {min}, {max}"));
            input = Some(control_outcome(page, &expression, wait).await?);
        }
        // The page answers once the dataset has opened or failed to, and the
        // open's run is already open by then, so the run waited for below is
        // the open's.
        ScriptStep::Add { url } => {
            let expression = seam_call(
                "addDataset",
                &format!("{}, {}", json_string(url), wait.as_millis()),
            );
            input = Some(control_outcome(page, &expression, wait + ADD_ANSWER_MARGIN).await?);
        }
        ScriptStep::Remove { url } => {
            let expression = seam_call("removeDataset", &json_string(url));
            input = Some(control_outcome(page, &expression, wait).await?);
        }
    }
    if !matches!(step, ScriptStep::Wait | ScriptStep::Hold { .. }) {
        if lands_later {
            wait_for_run_to_open(page, &before.run_state, wait).await?;
        }
        (run_id, timed_out) = settle_gesture(page, &before.run_state, wait).await?;
    }
    let after = read_step_state(page, wait).await?;
    Ok(StepRecord {
        step: step.clone(),
        started_at_ms: before.now,
        ended_at_ms: after.now,
        input,
        run_id,
        cause: None,
        end_reason: None,
        duration_us: None,
        verdict: None,
        lag: None,
        timed_out,
        view_changed: before.signature != after.signature,
        view_before: before.view,
        view_after: after.view,
    })
}

fn withheld(what: &str, needs: &str, mode: Option<&str>) -> SentInput {
    SentInput::Withheld {
        reason: format!(
            "{what} needs {needs}; the page is in {} mode",
            mode.unwrap_or("no")
        ),
    }
}

/// An expression calling one of the seam's step entries with `args`, which
/// answers with a refusal on a page whose seam predates the entry, so the
/// step is a fact in the run rather than an exception that ends it.
fn seam_call(entry: &str, args: &str) -> String {
    let older = json_string(&format!(
        "this page's trace seam has no {entry} entry; the server is running a build older than \
         this CLI"
    ));
    format!(
        "(async () => {{ const seam = window.lucidaTrace; \
         if (!seam || typeof seam.{entry} !== 'function') return JSON.stringify({{ applied: false, reason: {older} }}); \
         return JSON.stringify(await seam.{entry}({args})); }})()"
    )
}

/// Whether a run has concluded between two readings. Read by the last
/// concluded run's id rather than by the count: the recorder drops its
/// oldest intervals to stay within its memory cap, so over a long step the
/// count can fall back to where it was while the newest run stays named.
fn concluded_since(before: &RunState, now: &RunState) -> bool {
    now.last_concluded_run_id.is_some() && now.last_concluded_run_id != before.last_concluded_run_id
}

/// After an input whose run the page opens a frame or a render later: wait
/// until that run has opened, or concluded already, or the grace has passed.
async fn wait_for_run_to_open(
    page: &mut Page,
    before: &RunState,
    wait: Duration,
) -> Result<(), CliError> {
    let deadline = tokio::time::Instant::now() + RUN_OPEN_GRACE.min(wait);
    loop {
        let state = read_step_state(page, wait).await?.run_state;
        if state.open || concluded_since(before, &state) {
            return Ok(());
        }
        if tokio::time::Instant::now() >= deadline {
            return Ok(());
        }
        tokio::time::sleep(POLL).await;
    }
}

/// After a gesture's input: the run it opened, once concluded, and whether
/// the deadline passed first. An input that opened no run, because it landed
/// on nothing or the page refused it, is reported as none rather than waited
/// for. A paced step can outlast a run, so a run still open is the one waited
/// for: the step's record is about the run its last input left.
async fn settle_gesture(
    page: &mut Page,
    before: &RunState,
    wait: Duration,
) -> Result<(Option<String>, bool), CliError> {
    let deadline = tokio::time::Instant::now() + wait;
    let state = read_step_state(page, wait).await?.run_state;
    if !state.open && !concluded_since(before, &state) {
        return Ok((None, false));
    }
    let since = if state.open { &state } else { before };
    loop {
        let now = read_step_state(page, wait).await?.run_state;
        if concluded_since(since, &now) {
            return Ok((now.last_concluded_run_id, false));
        }
        if tokio::time::Instant::now() >= deadline {
            page.evaluate(CLOSE_AS_TIMEOUT, wait).await?;
            let closed = read_step_state(page, wait).await?.run_state;
            return Ok((closed.last_concluded_run_id, true));
        }
        tokio::time::sleep(POLL).await;
    }
}

/// Wait until the page is quiescent with no run open, and still is after
/// the hold window. Returns whether it got there inside the deadline.
async fn wait_for_quiescence(
    page: &mut Page,
    wait: Duration,
    hold_ms: Option<f64>,
) -> Result<bool, CliError> {
    let deadline = tokio::time::Instant::now() + wait;
    let hold =
        Duration::from_millis(hold_ms.unwrap_or(crate::trace::DEFAULT_QUIESCENCE_HOLD_MS) as u64);
    loop {
        let state = read_step_state(page, wait).await?;
        if !state.run_state.open && state.quiescent == Some(true) {
            tokio::time::sleep(hold).await;
            let held = read_step_state(page, wait).await?;
            if !held.run_state.open && held.quiescent == Some(true) {
                return Ok(true);
            }
        }
        if tokio::time::Instant::now() >= deadline {
            return Ok(false);
        }
        tokio::time::sleep(POLL).await;
    }
}

/// A drag of `delta`: as a burst, one move a frame apart, or with `pace`, its
/// moves spread evenly over that span at display rate, the press at its
/// start and the last move at its end. Paced moves go out on time whether
/// or not the page has taken the one before, as a mouse's do, and the
/// release waits for the page, so the drag ends once the page has taken it
/// all.
async fn drag(
    page: &mut Page,
    delta: (f64, f64),
    shift: bool,
    pace: Option<Duration>,
    wait: Duration,
) -> Result<SentInput, CliError> {
    let rect = canvas_rect(page, wait).await?;
    let from = rect.drag_origin(delta);
    let moves = pace.map_or_else(|| drag_moves(delta), paced_moves);
    let modifiers = if shift { SHIFT_MODIFIER } else { 0 };
    let start = tokio::time::Instant::now();
    page.dispatch_mouse_event(
        json!({ "type": "mousePressed", "x": from.0, "y": from.1, "button": "left", "buttons": 1, "clickCount": 1, "modifiers": modifiers }),
        wait,
    )
    .await?;
    let mut to = from;
    for (n, offset) in drag_path(delta, moves).into_iter().enumerate() {
        if let Some(span) = pace {
            tokio::time::sleep_until(start + paced_offset(n + 1, moves + 1, span)).await;
        }
        to = (from.0 + offset.0, from.1 + offset.1);
        let event = json!({ "type": "mouseMoved", "x": to.0, "y": to.1, "button": "left", "buttons": 1, "modifiers": modifiers });
        if pace.is_some() {
            page.dispatch_mouse_event_unacknowledged(event).await?;
        } else {
            page.dispatch_mouse_event(event, wait).await?;
            tokio::time::sleep(MOVE_INTERVAL).await;
        }
    }
    let span_ms = pace.map(|_| elapsed_ms(start));
    page.dispatch_mouse_event(
        json!({ "type": "mouseReleased", "x": to.0, "y": to.1, "button": "left", "buttons": 0, "clickCount": 1, "modifiers": modifiers }),
        wait,
    )
    .await?;
    Ok(SentInput::Drag {
        from: [from.0, from.1],
        to: [to.0, to.1],
        moves,
        shift,
        span_ms,
    })
}

#[allow(clippy::too_many_arguments)]
async fn wheel_zoom(
    page: &mut Page,
    factor: f64,
    at: Option<[f64; 2]>,
    mode: Option<&str>,
    scale: InputScale,
    pace: Option<Duration>,
    wait: Duration,
) -> Result<SentInput, CliError> {
    let rect = canvas_rect(page, wait).await?;
    let point = at.map(|at| rect.point(at)).unwrap_or_else(|| rect.center());
    // The slice viewer zooms a fixed step per wheel event, so pacing spreads
    // its notches over the span. The volume viewer zooms by the event's
    // delta, so a paced zoom there is one event per frame, each a share of
    // the factor.
    let (delta_y, notches, reached) = if mode == Some("slice") {
        let (notches, reached) = slice_zoom_notches(factor, scale);
        let delta = if notches > 0 {
            -WHEEL_NOTCH_DELTA
        } else {
            WHEEL_NOTCH_DELTA
        };
        (delta, notches.unsigned_abs() as u32, reached)
    } else {
        let events = pace.map_or(1, |span| paced_moves(span) as u32 + 1);
        (volume_zoom_step(factor, events, scale), events, factor)
    };
    // Paced, every event but the last goes out on time without waiting for
    // the page, as a drag's moves do, and the last waits for it.
    let start = tokio::time::Instant::now();
    let mut span_ms = None;
    for n in 0..notches {
        let event = json!({ "type": "mouseWheel", "x": point.0, "y": point.1, "deltaX": 0, "deltaY": delta_y });
        match pace {
            Some(span) => {
                tokio::time::sleep_until(start + paced_offset(n as usize, notches as usize, span))
                    .await;
                span_ms = Some(elapsed_ms(start));
                if n + 1 < notches {
                    page.dispatch_mouse_event_unacknowledged(event).await?;
                } else {
                    page.dispatch_mouse_event(event, wait).await?;
                }
            }
            None => {
                page.dispatch_mouse_event(event, wait).await?;
                tokio::time::sleep(MOVE_INTERVAL).await;
            }
        }
    }
    Ok(SentInput::Wheel {
        at: [point.0, point.1],
        delta_y,
        notches,
        factor: reached,
        span_ms,
    })
}

/// A scrub played one position every `interval`, the first at once, through
/// the same seam entry a jump takes. It stops at the first position the page
/// refuses, as playback stops at the end of an axis, and says how far it got.
async fn paced_scrub(
    page: &mut Page,
    axis: ScrubAxis,
    count: i64,
    interval: Duration,
    wait: Duration,
) -> Result<SentInput, CliError> {
    let positions = count.unsigned_abs() as u32;
    let expression = format!(
        "JSON.stringify(window.lucidaTrace.scrub({}, {}))",
        json_string(&axis.to_string()),
        count.signum()
    );
    let start = tokio::time::Instant::now();
    let mut moves = 0;
    let mut refusal = None;
    let mut span_ms = 0.0;
    for n in 0..positions {
        tokio::time::sleep_until(start + interval * n).await;
        span_ms = elapsed_ms(start);
        let outcome = control_outcome(page, &expression, wait).await?;
        if let SentInput::Control {
            applied: false,
            reason,
            ..
        } = outcome
        {
            refusal = Some(reason.unwrap_or_else(|| "the page refused it".to_string()));
            break;
        }
        moves += 1;
    }
    Ok(SentInput::Control {
        applied: refusal.is_none(),
        reason: refusal.map(|reason| {
            if moves == 0 {
                reason
            } else {
                format!("after {moves} of {positions} positions: {reason}")
            }
        }),
        moves: Some(moves),
        span_ms: Some(span_ms),
    })
}

fn elapsed_ms(start: tokio::time::Instant) -> f64 {
    start.elapsed().as_secs_f64() * 1000.0
}

/// Press and release a key, as a keyboard sends it, on whatever the page has
/// focused: the viewer's shortcuts listen on the window.
async fn press_key(page: &mut Page, key: &KeyPress, wait: Duration) -> Result<SentInput, CliError> {
    page.dispatch_key_event(
        json!({ "type": "keyDown", "key": key.key, "code": key.code, "text": key.key, "unmodifiedText": key.key, "windowsVirtualKeyCode": key.virtual_key }),
        wait,
    )
    .await?;
    page.dispatch_key_event(
        json!({ "type": "keyUp", "key": key.key, "code": key.code, "windowsVirtualKeyCode": key.virtual_key }),
        wait,
    )
    .await?;
    Ok(SentInput::Key {
        key: key.combo.to_string(),
    })
}

/// Two taps on the canvas's center, as a finger makes them.
async fn double_tap(page: &mut Page, wait: Duration) -> Result<SentInput, CliError> {
    let rect = canvas_rect(page, wait).await?;
    let (x, y) = rect.center();
    for tap in 0..2 {
        if tap > 0 {
            tokio::time::sleep(TAP_GAP).await;
        }
        page.dispatch_touch_event(
            json!({ "type": "touchStart", "touchPoints": [{ "x": x, "y": y, "id": 0 }] }),
            wait,
        )
        .await?;
        page.dispatch_touch_event(json!({ "type": "touchEnd", "touchPoints": [] }), wait)
            .await?;
    }
    Ok(SentInput::Tap {
        at: [x, y],
        taps: 2,
    })
}

/// Call one of the seam's control entries and hand back what the page
/// answered: whether it applied the step, and why not when it did not.
async fn control_outcome(
    page: &mut Page,
    expression: &str,
    wait: Duration,
) -> Result<SentInput, CliError> {
    #[derive(Deserialize)]
    struct Outcome {
        applied: bool,
        #[serde(default)]
        reason: Option<String>,
    }
    let outcome: Outcome = evaluate_json(
        page,
        expression,
        "the page did not answer a scripted step; window.lucidaTrace was missing",
        "a scripted step's outcome",
        wait,
    )
    .await?;
    Ok(SentInput::Control {
        applied: outcome.applied,
        reason: outcome.reason,
        moves: None,
        span_ms: None,
    })
}

async fn canvas_rect(page: &mut Page, wait: Duration) -> Result<CanvasRect, CliError> {
    evaluate_json(
        page,
        CANVAS_RECT_PROBE,
        "the page has no canvas to send a pointer to",
        "its canvas",
        wait,
    )
    .await
}

async fn read_step_state(page: &mut Page, wait: Duration) -> Result<StepState, CliError> {
    evaluate_json(
        page,
        STEP_STATE_PROBE,
        "the page's trace seam went missing while a script was running",
        "a step state",
        wait,
    )
    .await
}

/// Evaluate an expression that answers with a JSON string, or with null
/// when the page has nothing to answer with, which is `missing`. `what` names
/// the answer in the error for one this CLI cannot read.
async fn evaluate_json<T: DeserializeOwned>(
    page: &mut Page,
    expression: &str,
    missing: &str,
    what: &str,
    wait: Duration,
) -> Result<T, CliError> {
    let value = page.evaluate(expression, wait).await?;
    let json = value
        .as_str()
        .ok_or_else(|| CliError::new(ErrorKind::Protocol, missing))?;
    serde_json::from_str(json).map_err(|error| {
        CliError::new(
            ErrorKind::Protocol,
            format!("the page returned {what} this CLI cannot read: {error}"),
        )
    })
}

/// Wait for a seam that has the steps' entries. A page still loading is
/// worth waiting for; a page whose seam predates them is not, and says so.
async fn wait_for_script_seam(page: &mut Page, wait: Duration) -> Result<(), CliError> {
    let deadline = tokio::time::Instant::now() + wait;
    loop {
        match page.evaluate(SCRIPT_SEAM_PROBE, wait).await?.as_bool() {
            Some(true) => return Ok(()),
            Some(false) => {
                return Err(CliError::new(
                    ErrorKind::Protocol,
                    "this page's trace seam has no entries for scripted steps; the server is \
                     running a build older than this CLI",
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
        tokio::time::sleep(POLL).await;
    }
}

// ---------------------------------------------------------------------------
// Reading the record
// ---------------------------------------------------------------------------

/// Why an opt-in gate should fail on the script, or `None`: a step whose
/// run never settled, or whose run's verdict is a stall. Read from the same
/// fields the page filled at export; nothing is derived here.
pub fn script_gate_failure(script: &ScriptRecord) -> Option<String> {
    for (index, step) in script.steps.iter().enumerate() {
        let label = format!("step {} ({})", index + 1, step.step);
        if step.timed_out {
            return Some(format!("{label} never settled"));
        }
        if let Some(reason) = step.end_reason.as_deref()
            && reason != "quiescent"
        {
            return Some(format!("{label} never settled ({reason})"));
        }
        if let Some(verdict) = &step.verdict
            && failing_verdict(&verdict.kind)
        {
            return Some(format!("{label} {}: {}", verdict.kind, verdict.text));
        }
    }
    None
}

/// The steps as lines under the run's header: one per step, naming the run
/// it opened and its cause, how it ended, and whether the view changed. A
/// step that did not change the view says so in words, because that is the
/// case the record exists to make visible.
pub fn format_script_human(script: &ScriptRecord) -> String {
    let mut lines = Vec::with_capacity(script.steps.len() + 1);
    let kinds: Vec<&str> = script.steps.iter().map(|step| step.step.kind()).collect();
    lines.push(format!(
        "steps     {}: {}",
        script.steps.len(),
        kinds.join(", ")
    ));
    for (index, step) in script.steps.iter().enumerate() {
        let seconds = ((step.ended_at_ms - step.started_at_ms) / 1000.0).max(0.0);
        let mut parts = Vec::new();
        match (&step.run_id, &step.step) {
            (Some(run_id), _) => {
                let cause = step
                    .cause
                    .as_ref()
                    .and_then(|cause| cause.get("source"))
                    .and_then(Value::as_str)
                    .unwrap_or("cause unread");
                parts.push(format!("run {run_id} ({cause})"));
                parts.push(
                    step.end_reason
                        .clone()
                        .unwrap_or_else(|| "end reason unread".to_string()),
                );
            }
            (None, ScriptStep::Wait) => parts.push(
                if step.timed_out {
                    "never quiescent"
                } else {
                    "quiescent"
                }
                .to_string(),
            ),
            (None, ScriptStep::Hold { .. }) => parts.push("held".to_string()),
            (None, _) => parts.push("no run opened".to_string()),
        }
        if step.timed_out {
            parts.push("deadline passed".to_string());
        }
        parts.push(format!("{seconds:.2} s"));
        if let Some(span) = step.input.as_ref().and_then(SentInput::span_ms) {
            parts.push(format!("input over {:.2} s", span / 1000.0));
        }
        match &step.input {
            Some(SentInput::Control {
                applied: false,
                reason: Some(reason),
                ..
            }) => parts.push(format!("the page refused it: {reason}")),
            Some(SentInput::Withheld { reason }) => {
                parts.push(format!("the driver sent nothing: {reason}"));
            }
            _ => {}
        }
        parts.push(
            if step.view_changed {
                "view changed"
            } else {
                "view unchanged; the step did not change the view"
            }
            .to_string(),
        );
        if let Some(lag) = step.lag.as_ref().and_then(describe_lag) {
            parts.push(lag);
        }
        if let Some(verdict) = &step.verdict
            && verdict.kind != "clear"
        {
            parts.push(format!("verdict {}", verdict.kind));
        }
        lines.push(format!(
            "          {:<2} {:<22} {}",
            index + 1,
            step.step.to_string(),
            parts.join(" · ")
        ));
    }
    lines.join("\n")
}

/// A step's lag reading in a few words, read off the page's fields: input to
/// frame at p95 and max, and the frames dropped when any were.
fn describe_lag(lag: &Value) -> Option<String> {
    let timing = lag.get("inputToFrame")?;
    let p95 = timing.get("p95Ms")?.as_f64()?;
    let max = timing.get("maxMs")?.as_f64()?;
    let mut text = format!("input to frame p95 {p95} ms, max {max} ms");
    if let Some(dropped) = lag
        .pointer("/frames/dropped")
        .and_then(Value::as_u64)
        .filter(|dropped| *dropped > 0)
    {
        text.push_str(&format!(", {dropped} frame(s) dropped"));
    }
    Some(text)
}

/// One line for a bundle's header block: how many steps and which kinds.
pub fn describe_script(script: &ScriptRecord) -> String {
    let kinds: Vec<&str> = script.steps.iter().map(|step| step.step.kind()).collect();
    format!("{} step(s): {}", script.steps.len(), kinds.join(", "))
}

#[cfg(test)]
mod tests {
    use super::*;
    use clap::{Args, FromArgMatches};
    use std::path::Path;

    /// A script file as a tool would write one: the same shape the reader takes.
    fn write_script(path: &Path, script: &Script) {
        std::fs::write(path, serde_json::to_vec_pretty(script).unwrap()).unwrap();
    }

    fn parse_flags(args: &[&str]) -> Result<ScriptArgs, clap::Error> {
        let command = ScriptArgs::augment_args(Command::new("trace").arg(Arg::new("dataset")));
        let matches =
            command.try_get_matches_from(std::iter::once("trace").chain(args.iter().copied()))?;
        ScriptArgs::from_arg_matches(&matches)
    }

    /// `scripts/perf.py` hands each scenario file to `--script` as it is, so
    /// every one has to read as a script.
    #[test]
    fn every_perf_scenario_reads_as_a_script() {
        let dir = Path::new(env!("CARGO_MANIFEST_DIR")).join("../scripts/perf/scenarios");
        let mut read = 0;
        for entry in std::fs::read_dir(&dir).unwrap() {
            let path = entry.unwrap().path();
            if path.extension().is_some_and(|ext| ext == "json") {
                let text = std::fs::read_to_string(&path).unwrap();
                if let Err(reason) = Script::from_json(&text) {
                    panic!("{}: {reason}", path.display());
                }
                read += 1;
            }
        }
        assert!(read > 0, "no scenarios in {}", dir.display());
    }

    #[test]
    fn a_script_file_reads_every_kind_and_keeps_its_order() {
        let script = Script::from_json(
            r#"{"steps": [
                {"kind": "wait"},
                {"kind": "hold", "ms": 250},
                {"kind": "pan", "dx": 100, "dy": -50},
                {"kind": "zoom", "factor": 2},
                {"kind": "zoom", "factor": 0.5, "at": [10, 20]},
                {"kind": "orbit", "theta": 30, "phi": 15},
                {"kind": "scrub", "axis": "t", "count": -2},
                {"kind": "select", "channel": 1},
                {"kind": "select", "layer": "ds-1", "visible": false}
            ]}"#,
        )
        .unwrap();
        assert_eq!(
            script.steps,
            vec![
                ScriptStep::Wait,
                ScriptStep::Hold { ms: 250 },
                ScriptStep::Pan {
                    dx: 100.0,
                    dy: -50.0,
                    duration_ms: None,
                },
                ScriptStep::Zoom {
                    factor: 2.0,
                    at: None,
                    duration_ms: None,
                },
                ScriptStep::Zoom {
                    factor: 0.5,
                    at: Some([10.0, 20.0]),
                    duration_ms: None,
                },
                ScriptStep::Orbit {
                    theta: 30.0,
                    phi: 15.0,
                    duration_ms: None,
                },
                ScriptStep::Scrub {
                    axis: ScrubAxis::T,
                    count: -2,
                    interval_ms: None,
                },
                ScriptStep::Select {
                    channel: Some(1),
                    layer: None,
                    visible: true
                },
                ScriptStep::Select {
                    channel: None,
                    layer: Some("ds-1".to_string()),
                    visible: false
                },
            ]
        );
        let bare = Script::from_json(r#"[{"kind": "wait"}]"#).unwrap();
        assert_eq!(bare.steps, vec![ScriptStep::Wait]);
    }

    #[test]
    fn a_script_file_names_the_step_it_cannot_use() {
        let unknown = Script::from_json(r#"[{"kind": "fly"}]"#).unwrap_err();
        assert!(
            unknown.contains(
                "wait, hold, pan, zoom, orbit, scrub, select, mode, fit, resize, contrast, add, \
                 and remove"
            ),
            "{unknown}"
        );
        let both = Script::from_json(
            r#"[{"kind": "wait"}, {"kind": "select", "channel": 1, "layer": "ds"}]"#,
        )
        .unwrap_err();
        assert_eq!(
            both,
            "step 2 (select): a select names a channel or a layer, not both"
        );
        let neither = Script::from_json(r#"[{"kind": "select"}]"#).unwrap_err();
        assert_eq!(
            neither,
            "step 1 (select): a select names a channel or a layer"
        );
        let still = Script::from_json(r#"[{"kind": "zoom", "factor": 1}]"#).unwrap_err();
        assert_eq!(still, "step 1 (zoom): a zoom by 1 changes nothing");
        let negative = Script::from_json(r#"[{"kind": "zoom", "factor": -2}]"#).unwrap_err();
        assert_eq!(
            negative,
            "step 1 (zoom): a zoom factor is a positive number, not -2"
        );
        let nothing =
            Script::from_json(r#"[{"kind": "scrub", "axis": "z", "count": 0}]"#).unwrap_err();
        assert_eq!(nothing, "step 1 (scrub): a scrub by 0 moves nothing");
        let shape = Script::from_json(r#"{"kind": "wait"}"#).unwrap_err();
        assert!(shape.contains("\"steps\""), "{shape}");
        let not_json = Script::from_json("wait").unwrap_err();
        assert!(not_json.starts_with("not JSON"), "{not_json}");
    }

    #[test]
    fn each_flag_reads_its_text_form() {
        assert_eq!(
            step_from_flag("pan", "100,-50").unwrap(),
            ScriptStep::Pan {
                dx: 100.0,
                dy: -50.0,
                duration_ms: None,
            }
        );
        assert_eq!(
            step_from_flag("orbit", "30,15").unwrap(),
            ScriptStep::Orbit {
                theta: 30.0,
                phi: 15.0,
                duration_ms: None,
            }
        );
        assert_eq!(
            step_from_flag("zoom_by", "2").unwrap(),
            ScriptStep::Zoom {
                factor: 2.0,
                at: None,
                duration_ms: None,
            }
        );
        assert_eq!(
            step_from_flag("zoom_by", "0.5@100,200").unwrap(),
            ScriptStep::Zoom {
                factor: 0.5,
                at: Some([100.0, 200.0]),
                duration_ms: None,
            }
        );
        assert_eq!(
            step_from_flag("scrub", "t:1").unwrap(),
            ScriptStep::Scrub {
                axis: ScrubAxis::T,
                count: 1,
                interval_ms: None,
            }
        );
        assert_eq!(
            step_from_flag("scrub", "Z:-5").unwrap(),
            ScriptStep::Scrub {
                axis: ScrubAxis::Z,
                count: -5,
                interval_ms: None,
            }
        );
        assert_eq!(
            step_from_flag("select", "channel:1").unwrap(),
            ScriptStep::Select {
                channel: Some(1),
                layer: None,
                visible: true
            }
        );
        assert_eq!(
            step_from_flag("select", "channel:1=off").unwrap(),
            ScriptStep::Select {
                channel: Some(1),
                layer: None,
                visible: false
            }
        );
        assert_eq!(
            step_from_flag("select", "layer:ds-1").unwrap(),
            ScriptStep::Select {
                channel: None,
                layer: Some("ds-1".to_string()),
                visible: true
            }
        );

        assert_eq!(
            step_from_flag("pan", "100").unwrap_err(),
            "two numbers separated by a comma, not 100"
        );
        assert_eq!(
            step_from_flag("orbit", "a,b").unwrap_err(),
            "a number, not a"
        );
        assert_eq!(
            step_from_flag("scrub", "t").unwrap_err(),
            "a scrub is AXIS:COUNT, for example t:1"
        );
        assert_eq!(
            step_from_flag("scrub", "q:1").unwrap_err(),
            "no selector is called q; the axes are z, t, and c"
        );
        assert_eq!(
            step_from_flag("scrub", "t:1.5").unwrap_err(),
            "a scrub count is a whole number, not 1.5"
        );
        assert_eq!(
            step_from_flag("select", "channel:1=on").unwrap_err(),
            "a select ends in =off to hide, not =on"
        );
        assert_eq!(
            step_from_flag("select", "layer:").unwrap_err(),
            "a layer is named by its dataset id"
        );
        assert_eq!(
            step_from_flag("select", "label:1").unwrap_err(),
            "a select is channel:N or layer:ID, not label:…"
        );
        assert_eq!(
            step_from_flag("select", "1").unwrap_err(),
            "a select is channel:N or layer:ID"
        );
    }

    /// The order the flags were typed in is the order the steps run in,
    /// across kinds, which clap's per-name grouping would otherwise lose.
    #[test]
    fn the_flags_keep_their_command_line_order_across_kinds() {
        let args = parse_flags(&[
            "--orbit",
            "30,0",
            "--wait",
            "--scrub",
            "t:1",
            "--hold",
            "250",
            "--wait",
            "--pan",
            "-100,0",
            "--zoom-by",
            "2@10,10",
            "--select",
            "channel:0=off",
            "ds.zarr",
        ])
        .unwrap();
        assert_eq!(
            args.steps,
            vec![
                ScriptStep::Orbit {
                    theta: 30.0,
                    phi: 0.0,
                    duration_ms: None,
                },
                ScriptStep::Wait,
                ScriptStep::Scrub {
                    axis: ScrubAxis::T,
                    count: 1,
                    interval_ms: None,
                },
                ScriptStep::Hold { ms: 250 },
                ScriptStep::Wait,
                ScriptStep::Pan {
                    dx: -100.0,
                    dy: 0.0,
                    duration_ms: None,
                },
                ScriptStep::Zoom {
                    factor: 2.0,
                    at: Some([10.0, 10.0]),
                    duration_ms: None,
                },
                ScriptStep::Select {
                    channel: Some(0),
                    layer: None,
                    visible: false
                },
            ]
        );
        assert!(args.file.is_none());
        assert_eq!(args.resolve().unwrap().steps.len(), 8);
    }

    #[test]
    fn no_flags_is_an_empty_script_and_a_file_excludes_the_flags() {
        let none = parse_flags(&["ds.zarr"]).unwrap();
        assert_eq!(none, ScriptArgs::default());
        assert!(none.resolve().unwrap().is_empty());

        let file = parse_flags(&["--script", "steps.json", "ds.zarr"]).unwrap();
        assert_eq!(file.file, Some(PathBuf::from("steps.json")));
        assert!(file.steps.is_empty());

        assert!(parse_flags(&["--script", "steps.json", "--wait", "ds.zarr"]).is_err());
    }

    #[test]
    fn a_flag_that_could_never_land_is_refused_at_the_command_line() {
        let error = parse_flags(&["--pan", "0,0", "ds.zarr"]).unwrap_err();
        assert!(
            error.to_string().contains("a pan by 0,0 moves nothing"),
            "{error}"
        );
        let error = parse_flags(&["--zoom-by", "x", "ds.zarr"]).unwrap_err();
        assert!(
            error
                .to_string()
                .contains("invalid value 'x' for '--zoom-by'"),
            "{error}"
        );
        let error = parse_flags(&["--hold", "0", "ds.zarr"]).unwrap_err();
        assert!(
            error.to_string().contains("a hold of 0 ms holds nothing"),
            "{error}"
        );
    }

    #[test]
    fn a_script_file_resolves_through_the_same_reader() {
        let dir = std::env::temp_dir().join(format!("lucida-script-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("steps.json");
        write_script(
            &path,
            &Script {
                steps: vec![
                    ScriptStep::Wait,
                    ScriptStep::Orbit {
                        theta: 30.0,
                        phi: 0.0,
                        duration_ms: None,
                    },
                ],
            },
        );
        let args = ScriptArgs {
            steps: vec![],
            file: Some(path.clone()),
        };
        assert_eq!(args.resolve().unwrap().steps.len(), 2);

        std::fs::write(&path, "[{\"kind\": \"hold\", \"ms\": 0}]").unwrap();
        let error = args.resolve().unwrap_err();
        assert!(
            error
                .to_string()
                .contains("step 1 (hold): a hold of 0 ms holds nothing"),
            "{error}"
        );
        let missing = ScriptArgs {
            steps: vec![],
            file: Some(dir.join("nowhere.json")),
        };
        assert!(
            missing
                .resolve()
                .unwrap_err()
                .to_string()
                .contains("could not read the script")
        );
        std::fs::remove_dir_all(&dir).unwrap();
    }

    /// The page publishes its input scale; the defaults are the viewers'
    /// values for a page too old to, and the mapping from a step's
    /// parameters to pixels is checked against them here.
    #[test]
    fn an_orbit_is_a_drag_at_the_pages_sensitivity() {
        let scale = InputScale::default();
        let (dx, dy) = orbit_drag(30.0, -15.0, scale);
        assert!((dx - (-30.0_f64.to_radians() / 0.005)).abs() < 1e-9);
        assert!((dy - (15.0_f64.to_radians() / 0.005)).abs() < 1e-9);
        assert!((dx + 104.72).abs() < 0.01, "{dx}");
        assert!((dy - 52.36).abs() < 0.01, "{dy}");

        let coarser = InputScale {
            orbit_radians_per_pixel: 0.01,
            ..scale
        };
        assert!((orbit_drag(30.0, 0.0, coarser).0 + 52.36).abs() < 0.01);
        let published: InputScale = serde_json::from_value(json!({
            "orbitRadiansPerPixel": 0.01,
            "sliceZoomInPerNotch": 1.2,
            "sliceZoomOutPerNotch": 0.8,
            "volumeZoomPerWheelDelta": 0.002
        }))
        .unwrap();
        assert_eq!(published.slice_zoom_in_per_notch, 1.2);
    }

    #[test]
    fn a_slice_zoom_is_a_count_of_notches_and_says_what_it_reaches() {
        let scale = InputScale::default();
        assert_eq!(slice_zoom_notches(2.0, scale).0, 7);
        assert!((slice_zoom_notches(2.0, scale).1 - 1.1_f64.powi(7)).abs() < 1e-9);
        assert_eq!(slice_zoom_notches(0.5, scale).0, -7);
        assert!((slice_zoom_notches(0.5, scale).1 - 0.9_f64.powi(7)).abs() < 1e-9);
        // A factor short of one notch still sends one: a zoom sends something.
        assert_eq!(slice_zoom_notches(1.01, scale), (1, 1.1));
        assert_eq!(slice_zoom_notches(0.99, scale), (-1, 0.9));
    }

    #[test]
    fn a_volume_zoom_is_one_wheel_event_that_divides_the_distance() {
        let scale = InputScale::default();
        assert!((volume_zoom_step(2.0, 1, scale) - (-500.0)).abs() < 1e-9);
        assert!((volume_zoom_step(0.5, 1, scale) - 1000.0).abs() < 1e-9);
    }

    #[test]
    fn a_drag_ends_exactly_on_its_delta_and_starts_centered() {
        assert_eq!(
            drag_path((100.0, -50.0), 4),
            vec![(25.0, -12.5), (50.0, -25.0), (75.0, -37.5), (100.0, -50.0)]
        );
        assert_eq!(drag_moves((10.0, 0.0)), MIN_MOVES);
        assert_eq!(drag_moves((100.0, 0.0)), 13);
        assert_eq!(drag_moves((10_000.0, 0.0)), MAX_MOVES);

        let rect = CanvasRect {
            x: 0.0,
            y: 0.0,
            width: 1440.0,
            height: 900.0,
        };
        assert_eq!(rect.center(), (720.0, 450.0));
        assert_eq!(rect.drag_origin((100.0, -50.0)), (670.0, 475.0));
        assert_eq!(rect.drag_origin((4000.0, 0.0)), (0.0, 450.0));
        assert_eq!(rect.point([10.0, 20.0]), (10.0, 20.0));
    }

    /// A pan or an orbit is sent only in a view where a drag means that: a
    /// drag orbits the volume view, so a pan there needs Shift, and the
    /// slice view has no orbit at all.
    #[test]
    fn a_gesture_outside_its_view_is_withheld_and_says_why() {
        match withheld("an orbit", "the volume view", Some("slice")) {
            SentInput::Withheld { reason } => {
                assert_eq!(
                    reason,
                    "an orbit needs the volume view; the page is in slice mode"
                );
            }
            other => panic!("{other:?}"),
        }
        match withheld("a pan", "the slice or the volume view", None) {
            SentInput::Withheld { reason } => {
                assert_eq!(
                    reason,
                    "a pan needs the slice or the volume view; the page is in no mode"
                );
            }
            other => panic!("{other:?}"),
        }
        let state: StepState = serde_json::from_value(json!({
            "now": 1.0,
            "runState": { "open": false, "concluded": 1, "lastConcludedRunId": "run-1" },
            "quiescent": true,
            "holdMs": 500,
            "view": { "camera": { "mode": "arcball" } },
            "signature": { "camera": { "mode": "arcball" } }
        }))
        .unwrap();
        assert_eq!(state.camera_mode(), Some("arcball"));
        assert!(state.input_scale.is_none());
    }

    fn record(step: ScriptStep, run_id: Option<&str>, changed: bool) -> StepRecord {
        StepRecord {
            step,
            started_at_ms: 1000.0,
            ended_at_ms: 2500.0,
            input: None,
            run_id: run_id.map(str::to_string),
            cause: run_id
                .map(|_| json!({ "epoch": "view", "dirtyKind": "interactive", "source": "orbit" })),
            end_reason: run_id.map(|_| "quiescent".to_string()),
            duration_us: run_id.map(|_| 1_400_000.0),
            verdict: run_id.map(|_| StepVerdict {
                kind: "clear".to_string(),
                text: "fine".to_string(),
            }),
            lag: None,
            timed_out: false,
            view_before: Value::Null,
            view_after: Value::Null,
            view_changed: changed,
        }
    }

    /// A record is a step with its results around it, so a bundle's script
    /// reads back as the steps that made it.
    #[test]
    fn a_step_record_reads_back_as_the_step_that_made_it() {
        let recorded = record(
            ScriptStep::Orbit {
                theta: 30.0,
                phi: 0.0,
                duration_ms: None,
            },
            Some("run-3"),
            true,
        );
        let json = serde_json::to_value(&recorded).unwrap();
        assert_eq!(json["kind"], "orbit");
        assert_eq!(json["theta"], 30.0);
        assert_eq!(json["runId"], "run-3");
        assert_eq!(json["viewChanged"], true);
        assert_eq!(json["verdict"]["kind"], "clear");
        let step: ScriptStep = serde_json::from_value(json.clone()).unwrap();
        assert_eq!(
            step,
            ScriptStep::Orbit {
                theta: 30.0,
                phi: 0.0,
                duration_ms: None,
            }
        );
        let back: StepRecord = serde_json::from_value(json).unwrap();
        assert_eq!(back, recorded);

        let select = record(
            ScriptStep::Select {
                channel: Some(1),
                layer: None,
                visible: false,
            },
            None,
            false,
        );
        let json = serde_json::to_value(&select).unwrap();
        assert_eq!(json["kind"], "select");
        assert_eq!(json["channel"], 1);
        assert!(json.get("layer").is_none());
        assert_eq!(json["visible"], false);
        assert!(json["runId"].is_null());

        let sent = serde_json::to_value(SentInput::Wheel {
            at: [720.0, 450.0],
            delta_y: -100.0,
            notches: 7,
            factor: 1.1_f64.powi(7),
            span_ms: None,
        })
        .unwrap();
        assert_eq!(sent["sent"], "wheel");
        assert_eq!(sent["notches"], 7);
        assert!((sent["factor"].as_f64().unwrap() - 1.9487).abs() < 1e-3);
    }

    #[test]
    fn the_last_run_a_step_opened_is_the_run_the_file_is_about() {
        let script = ScriptRecord {
            steps: vec![
                record(ScriptStep::Wait, None, false),
                record(
                    ScriptStep::Orbit {
                        theta: 30.0,
                        phi: 0.0,
                        duration_ms: None,
                    },
                    Some("run-3"),
                    true,
                ),
                record(
                    ScriptStep::Scrub {
                        axis: ScrubAxis::T,
                        count: 1,
                        interval_ms: None,
                    },
                    Some("run-4"),
                    true,
                ),
                record(ScriptStep::Hold { ms: 100 }, None, false),
            ],
        };
        assert_eq!(script.last_run_id(), Some("run-4"));
        assert_eq!(ScriptRecord::default().last_run_id(), None);
    }

    #[test]
    fn the_gate_fails_on_a_step_that_never_settled_or_stalled_and_names_it() {
        let mut script = ScriptRecord {
            steps: vec![
                record(ScriptStep::Wait, None, false),
                record(
                    ScriptStep::Orbit {
                        theta: 30.0,
                        phi: 0.0,
                        duration_ms: None,
                    },
                    Some("run-3"),
                    true,
                ),
            ],
        };
        assert_eq!(script_gate_failure(&script), None);

        script.steps[1].verdict = Some(StepVerdict {
            kind: "stall".to_string(),
            text: "frame time over the ceiling".to_string(),
        });
        assert_eq!(
            script_gate_failure(&script).as_deref(),
            Some("step 2 (orbit 30°,0°) stall: frame time over the ceiling")
        );

        script.steps[1].verdict = None;
        script.steps[1].end_reason = Some("timeout".to_string());
        assert_eq!(
            script_gate_failure(&script).as_deref(),
            Some("step 2 (orbit 30°,0°) never settled (timeout)")
        );

        script.steps[0].timed_out = true;
        assert_eq!(
            script_gate_failure(&script).as_deref(),
            Some("step 1 (wait) never settled")
        );
    }

    #[test]
    fn a_step_carries_its_runs_lag_reading_and_the_text_states_it() {
        let mut pan = record(
            ScriptStep::Pan {
                dx: 200.0,
                dy: 0.0,
                duration_ms: None,
            },
            Some("run-5"),
            true,
        );
        pan.lag = Some(json!({
            "inputs": 25,
            "inputToFrame": { "samples": 25, "p50Ms": 21.3, "p95Ms": 34.1, "maxMs": 40.0 },
            "unanswered": 0,
            "longTasks": { "count": 0, "longestMs": 0, "totalMs": 0 },
            "frames": { "presented": 25, "dropped": 2, "displayIntervalMs": 16.7 },
            "unrecorded": 0,
            "statement": "measured"
        }));
        let json = serde_json::to_value(&pan).unwrap();
        assert_eq!(json["lag"]["inputToFrame"]["p95Ms"], 34.1);
        let back: StepRecord = serde_json::from_value(json).unwrap();
        assert_eq!(back, pan);
        // A step whose run took no input carries no key at all.
        let wait = serde_json::to_value(record(ScriptStep::Wait, None, false)).unwrap();
        assert!(wait.get("lag").is_none());

        let text = format_script_human(&ScriptRecord { steps: vec![pan] });
        assert!(
            text.contains(
                "view changed · input to frame p95 34.1 ms, max 40 ms, 2 frame(s) dropped"
            ),
            "{text}"
        );
    }

    #[test]
    fn the_text_names_each_steps_run_and_says_when_the_view_did_not_change() {
        let mut refused = record(
            ScriptStep::Select {
                channel: Some(3),
                layer: None,
                visible: true,
            },
            None,
            false,
        );
        refused.input = Some(SentInput::Control {
            applied: false,
            reason: Some("ds-1 has 2 channel(s), so there is no channel 3".to_string()),
            moves: None,
            span_ms: None,
        });
        let mut withheld_orbit = record(
            ScriptStep::Orbit {
                theta: 30.0,
                phi: 0.0,
                duration_ms: None,
            },
            None,
            false,
        );
        withheld_orbit.input = Some(withheld("an orbit", "the volume view", Some("slice")));
        let script = ScriptRecord {
            steps: vec![
                record(ScriptStep::Wait, None, false),
                record(
                    ScriptStep::Orbit {
                        theta: 30.0,
                        phi: 0.0,
                        duration_ms: None,
                    },
                    Some("run-3"),
                    true,
                ),
                record(
                    ScriptStep::Scrub {
                        axis: ScrubAxis::T,
                        count: 1,
                        interval_ms: None,
                    },
                    Some("run-4"),
                    false,
                ),
                refused,
                withheld_orbit,
            ],
        };
        let text = format_script_human(&script);
        assert!(
            text.starts_with("steps     5: wait, orbit, scrub, select, orbit\n"),
            "{text}"
        );
        assert!(
            text.contains("1  wait                   quiescent · 1.50 s · view unchanged"),
            "{text}"
        );
        assert!(
            text.contains(
                "2  orbit 30°,0°           run run-3 (orbit) · quiescent · 1.50 s · view changed"
            ),
            "{text}"
        );
        assert!(
            text.contains(
                "3  scrub t:+1             run run-4 (orbit) · quiescent · 1.50 s · view unchanged; the step did not change the view"
            ),
            "{text}"
        );
        assert!(
            text.contains(
                "4  select channel:3       no run opened · 1.50 s · the page refused it: ds-1 has 2 channel(s), so there is no channel 3 · view unchanged"
            ),
            "{text}"
        );
        assert!(
            text.contains(
                "5  orbit 30°,0°           no run opened · 1.50 s · the driver sent nothing: an orbit needs the volume view; the page is in slice mode · view unchanged"
            ),
            "{text}"
        );
        assert_eq!(
            describe_script(&script),
            "5 step(s): wait, orbit, scrub, select, orbit"
        );
    }

    #[test]
    fn a_step_prints_the_way_its_flag_was_typed() {
        assert_eq!(ScriptStep::Wait.to_string(), "wait");
        assert_eq!(ScriptStep::Hold { ms: 250 }.to_string(), "hold 250 ms");
        assert_eq!(
            ScriptStep::Pan {
                dx: 100.0,
                dy: -50.0,
                duration_ms: None,
            }
            .to_string(),
            "pan 100,-50"
        );
        assert_eq!(
            ScriptStep::Zoom {
                factor: 2.0,
                at: None,
                duration_ms: None,
            }
            .to_string(),
            "zoom ×2"
        );
        assert_eq!(
            ScriptStep::Zoom {
                factor: 0.5,
                at: Some([10.0, 20.0]),
                duration_ms: None,
            }
            .to_string(),
            "zoom ×0.5 at 10,20"
        );
        assert_eq!(
            ScriptStep::Orbit {
                theta: 30.0,
                phi: 15.0,
                duration_ms: None,
            }
            .to_string(),
            "orbit 30°,15°"
        );
        assert_eq!(
            ScriptStep::Scrub {
                axis: ScrubAxis::Z,
                count: -5,
                interval_ms: None,
            }
            .to_string(),
            "scrub z:-5"
        );
        assert_eq!(
            ScriptStep::Select {
                channel: Some(1),
                layer: None,
                visible: false
            }
            .to_string(),
            "select channel:1=off"
        );
        assert_eq!(
            ScriptStep::Select {
                channel: None,
                layer: Some("ds-1".to_string()),
                visible: true
            }
            .to_string(),
            "select layer:ds-1"
        );
    }

    #[test]
    fn a_script_file_reads_the_new_steps_and_the_paces() {
        let script = Script::from_json(
            r#"[
                {"kind": "mode", "to": "3d"},
                {"kind": "fit"},
                {"kind": "resize", "width": 1280, "height": 720},
                {"kind": "contrast", "channel": 1, "min": -5, "max": 2000.5},
                {"kind": "add", "url": "/data/b.zarr"},
                {"kind": "remove", "url": "/data/b.zarr"},
                {"kind": "pan", "dx": 120, "dy": 60, "durationMs": 2000},
                {"kind": "zoom", "factor": 2, "durationMs": 500},
                {"kind": "orbit", "theta": 30, "phi": 0, "durationMs": 1000},
                {"kind": "scrub", "axis": "t", "count": 3, "intervalMs": 200}
            ]"#,
        )
        .unwrap();
        assert_eq!(
            script.steps,
            vec![
                ScriptStep::Mode {
                    to: ViewMode::Volume
                },
                ScriptStep::Fit,
                ScriptStep::Resize {
                    width: 1280,
                    height: 720
                },
                ScriptStep::Contrast {
                    channel: 1,
                    min: -5.0,
                    max: 2000.5
                },
                ScriptStep::Add {
                    url: "/data/b.zarr".to_string()
                },
                ScriptStep::Remove {
                    url: "/data/b.zarr".to_string()
                },
                ScriptStep::Pan {
                    dx: 120.0,
                    dy: 60.0,
                    duration_ms: Some(2000)
                },
                ScriptStep::Zoom {
                    factor: 2.0,
                    at: None,
                    duration_ms: Some(500)
                },
                ScriptStep::Orbit {
                    theta: 30.0,
                    phi: 0.0,
                    duration_ms: Some(1000)
                },
                ScriptStep::Scrub {
                    axis: ScrubAxis::T,
                    count: 3,
                    interval_ms: Some(200)
                },
            ]
        );
        // A burst step writes no pace, so a script written before paces
        // existed reads and writes back unchanged.
        let burst = serde_json::to_value(ScriptStep::Pan {
            dx: 1.0,
            dy: 0.0,
            duration_ms: None,
        })
        .unwrap();
        assert_eq!(burst, json!({ "kind": "pan", "dx": 1.0, "dy": 0.0 }));
        let paced = serde_json::to_value(&script.steps[9]).unwrap();
        assert_eq!(
            paced,
            json!({ "kind": "scrub", "axis": "t", "count": 3, "intervalMs": 200 })
        );
    }

    #[test]
    fn a_new_step_that_could_never_land_is_named() {
        let cases = [
            (
                r#"[{"kind": "resize", "width": 0, "height": 720}]"#,
                "step 1 (resize): a viewport is at least 1x1 CSS pixels, not 0x720",
            ),
            (
                r#"[{"kind": "contrast", "channel": 0, "min": 10, "max": 10}]"#,
                "step 1 (contrast): a contrast window's minimum is below its maximum, not 10,10",
            ),
            (
                r#"[{"kind": "add", "url": "  "}]"#,
                "step 1 (add): a dataset is named by its source URL",
            ),
            (
                r#"[{"kind": "pan", "dx": 1, "dy": 0, "durationMs": 0}]"#,
                "step 1 (pan): a pan over 0 ms is a burst; leave the duration out for one",
            ),
            (
                r#"[{"kind": "scrub", "axis": "t", "count": 2, "intervalMs": 0}]"#,
                "step 1 (scrub): a scrub interval of 0 ms is a jump; leave the interval out for one",
            ),
        ];
        for (text, expected) in cases {
            assert_eq!(Script::from_json(text).unwrap_err(), expected);
        }
        let mode = Script::from_json(r#"[{"kind": "mode", "to": "4d"}]"#).unwrap_err();
        assert!(mode.starts_with("a step could not be read"), "{mode}");
    }

    #[test]
    fn the_new_flags_read_their_text_forms() {
        let cases = [
            (
                "mode",
                "3D",
                ScriptStep::Mode {
                    to: ViewMode::Volume,
                },
            ),
            (
                "mode",
                "2d",
                ScriptStep::Mode {
                    to: ViewMode::Slice,
                },
            ),
            (
                "resize",
                "1280x720",
                ScriptStep::Resize {
                    width: 1280,
                    height: 720,
                },
            ),
            (
                "set_contrast",
                "0:-10,2000",
                ScriptStep::Contrast {
                    channel: 0,
                    min: -10.0,
                    max: 2000.0,
                },
            ),
            (
                "add",
                "C:/data/b.zarr",
                ScriptStep::Add {
                    url: "C:/data/b.zarr".to_string(),
                },
            ),
            (
                "remove",
                "C:/data/b.zarr",
                ScriptStep::Remove {
                    url: "C:/data/b.zarr".to_string(),
                },
            ),
            (
                "pan",
                "120,60/2000",
                ScriptStep::Pan {
                    dx: 120.0,
                    dy: 60.0,
                    duration_ms: Some(2000),
                },
            ),
            (
                "zoom_by",
                "2@10,20/500",
                ScriptStep::Zoom {
                    factor: 2.0,
                    at: Some([10.0, 20.0]),
                    duration_ms: Some(500),
                },
            ),
            (
                "orbit",
                "-30,15/1000",
                ScriptStep::Orbit {
                    theta: -30.0,
                    phi: 15.0,
                    duration_ms: Some(1000),
                },
            ),
            (
                "scrub",
                "t:+3/250",
                ScriptStep::Scrub {
                    axis: ScrubAxis::T,
                    count: 3,
                    interval_ms: Some(250),
                },
            ),
        ];
        for (id, text, step) in cases {
            assert_eq!(step_from_flag(id, text).unwrap(), step, "--{id} {text}");
        }
        // A step prints as its flag was typed, pace included.
        assert_eq!(
            ScriptStep::Pan {
                dx: 120.0,
                dy: 60.0,
                duration_ms: Some(2000)
            }
            .to_string(),
            "pan 120,60/2000"
        );
        assert_eq!(
            ScriptStep::Scrub {
                axis: ScrubAxis::T,
                count: 3,
                interval_ms: Some(250)
            }
            .to_string(),
            "scrub t:+3/250"
        );
        assert_eq!(
            ScriptStep::Mode {
                to: ViewMode::Volume
            }
            .to_string(),
            "mode 3d"
        );
        assert_eq!(
            ScriptStep::Contrast {
                channel: 0,
                min: -10.0,
                max: 2000.0
            }
            .to_string(),
            "contrast 0:-10,2000"
        );

        assert_eq!(
            step_from_flag("mode", "4d").unwrap_err(),
            "a mode is 2d or 3d, not 4d"
        );
        assert_eq!(
            step_from_flag("resize", "1280").unwrap_err(),
            "a size is WIDTHxHEIGHT, for example 1280x720, not 1280"
        );
        assert_eq!(
            step_from_flag("set_contrast", "0").unwrap_err(),
            "a contrast window is CHANNEL:MIN,MAX, for example 0:100,2000"
        );
        assert_eq!(
            step_from_flag("pan", "1,0/fast").unwrap_err(),
            "a pace is /MS, whole milliseconds, not /fast"
        );
    }

    #[test]
    fn the_new_flags_keep_their_place_among_the_others() {
        let args = parse_flags(&[
            "--mode",
            "3d",
            "--fit",
            "--orbit",
            "30,0/1500",
            "--resize",
            "800x600",
            "--fit",
            "--set-contrast",
            "1:0,500",
            "--add",
            "/data/b.zarr",
            "--remove",
            "/data/b.zarr",
            "ds.zarr",
        ])
        .unwrap();
        let kinds: Vec<&str> = args.steps.iter().map(ScriptStep::kind).collect();
        assert_eq!(
            kinds,
            [
                "mode", "fit", "orbit", "resize", "fit", "contrast", "add", "remove"
            ]
        );
        let error = parse_flags(&["--set-contrast", "0:5,1", "ds.zarr"]).unwrap_err();
        assert!(
            error.to_string().contains(
                "step 1 (--set-contrast): a contrast window's minimum is below its maximum"
            ),
            "{error}"
        );
        assert!(parse_flags(&["--script", "steps.json", "--fit", "ds.zarr"]).is_err());
    }

    /// A paced gesture sends one event per display frame across its span,
    /// the first at the start and the last at the end, and a paced volume
    /// zoom's events compound to the asked-for factor.
    #[test]
    fn a_paced_gesture_spreads_its_events_across_its_span() {
        let span = Duration::from_millis(2000);
        assert_eq!(paced_moves(span), 120);
        assert_eq!(paced_moves(Duration::from_millis(1)), 1);
        assert_eq!(paced_offset(0, 121, span), Duration::ZERO);
        assert_eq!(paced_offset(120, 121, span), span);
        assert_eq!(paced_offset(60, 121, span), Duration::from_millis(1000));
        assert_eq!(paced_offset(0, 1, span), Duration::ZERO);

        let scale = InputScale::default();
        let events = 31;
        let step = volume_zoom_step(2.0, events, scale);
        let distance = (1.0 + step * scale.volume_zoom_per_wheel_delta).powi(events as i32);
        assert!((distance - 0.5).abs() < 1e-9, "{distance}");
    }

    #[test]
    fn a_script_says_what_the_workspace_has_to_hold_before_it_runs() {
        let script = Script::from_json(
            r#"[
                {"kind": "add", "url": "C:\\data\\b.zarr"},
                {"kind": "remove", "url": "c:/data/b.zarr"},
                {"kind": "remove", "url": "/data/c.zarr"},
                {"kind": "add", "url": "/data/c.zarr"},
                {"kind": "fit"}
            ]"#,
        )
        .unwrap();
        let needs = script.dataset_preconditions();
        assert_eq!(needs.absent, vec![normalize_dataset_url("C:/data/b.zarr")]);
        assert_eq!(needs.present, vec![normalize_dataset_url("/data/c.zarr")]);

        // The datasets at the close, with each add undone and each remove
        // put back, are the datasets at the start.
        let a = normalize_dataset_url("/data/a.zarr");
        let c = normalize_dataset_url("/data/c.zarr");
        assert_eq!(
            script.datasets_before(&[a.clone(), c.clone()]),
            vec![a.clone(), c.clone()]
        );
        let adds = Script::from_json(r#"[{"kind": "add", "url": "/data/c.zarr"}]"#).unwrap();
        assert_eq!(
            adds.datasets_before(&[a.clone(), c.clone()]),
            vec![a.clone()]
        );
        let removes = Script::from_json(r#"[{"kind": "remove", "url": "/data/a.zarr"}]"#).unwrap();
        assert_eq!(
            removes.datasets_before(std::slice::from_ref(&c)),
            vec![c, a]
        );
        assert!(Script::default().dataset_preconditions().absent.is_empty());
    }

    #[test]
    fn a_paced_steps_text_says_how_long_its_input_took() {
        let mut paced = record(
            ScriptStep::Pan {
                dx: 120.0,
                dy: 60.0,
                duration_ms: Some(2000),
            },
            Some("run-5"),
            true,
        );
        paced.input = Some(SentInput::Drag {
            from: [660.0, 420.0],
            to: [780.0, 480.0],
            moves: 120,
            shift: false,
            span_ms: Some(2012.4),
        });
        let mut resized = record(
            ScriptStep::Resize {
                width: 800,
                height: 600,
            },
            Some("run-6"),
            true,
        );
        resized.input = Some(SentInput::Resize {
            from: [1440, 900],
            to: [800, 600],
        });
        let text = format_script_human(&ScriptRecord {
            steps: vec![paced, resized],
        });
        assert!(
            text.contains(
                "1  pan 120,60/2000        run run-5 (orbit) · quiescent · 1.50 s · input over 2.01 s · view changed"
            ),
            "{text}"
        );
        assert!(text.contains("2  resize 800x600"), "{text}");
        let sent = serde_json::to_value(SentInput::Control {
            applied: true,
            reason: None,
            moves: Some(3),
            span_ms: Some(400.0),
        })
        .unwrap();
        assert_eq!(
            sent,
            json!({ "sent": "control", "applied": true, "moves": 3, "spanMs": 400.0 })
        );
    }
}
