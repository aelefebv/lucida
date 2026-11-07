//! The trace driver's script (ADR 0051, as amended): an ordered list of steps
//! the driver performs on the page once the open has settled, so an agent
//! can reproduce a pan, a zoom, an orbit, a scrub, or a select headlessly.
//!
//! Steps go through the page's own input handling. Pan, zoom, and orbit are
//! synthesized as the pointer and wheel events a mouse would raise, over the
//! DevTools protocol, in CSS pixels at the run's device pixel ratio, so a
//! scripted orbit measures the path a person's orbit takes. Scrub and select
//! have nothing to click on the capture surface, where the selectors and the
//! layer panel are hidden, so they go through the handlers those controls
//! call, which the page exposes on the trace seam for this purpose.
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

use crate::browser::Page;
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
    /// Drag the pointer by a screen delta, in CSS pixels.
    Pan { dx: f64, dy: f64 },
    /// Multiply the view's scale by `factor`, about a point in CSS pixels
    /// from the canvas's top-left corner, or about its center when absent.
    Zoom {
        factor: f64,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        at: Option<[f64; 2]>,
    },
    /// Orbit by two angles in degrees: around the vertical axis, then the horizontal.
    Orbit { theta: f64, phi: f64 },
    /// Move a selector by a count of positions.
    Scrub { axis: ScrubAxis, count: i64 },
    /// Show or hide a channel of the dataset in hand, or a layer by dataset id.
    Select {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        channel: Option<u32>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        layer: Option<String>,
        #[serde(default = "visible_by_default")]
        visible: bool,
    },
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
            Self::Pan { dx, dy } => {
                if !dx.is_finite() || !dy.is_finite() {
                    return Err("a pan delta is two finite numbers".to_string());
                }
                if *dx == 0.0 && *dy == 0.0 {
                    return Err("a pan by 0,0 moves nothing".to_string());
                }
                Ok(())
            }
            Self::Zoom { factor, at } => {
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
                Ok(())
            }
            Self::Orbit { theta, phi } => {
                if !theta.is_finite() || !phi.is_finite() {
                    return Err("orbit angles are two finite numbers".to_string());
                }
                if *theta == 0.0 && *phi == 0.0 {
                    return Err("an orbit by 0,0 moves nothing".to_string());
                }
                Ok(())
            }
            Self::Scrub { count: 0, .. } => Err("a scrub by 0 moves nothing".to_string()),
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
        }
    }
}

impl std::fmt::Display for ScriptStep {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Wait => f.write_str("wait"),
            Self::Hold { ms } => write!(f, "hold {ms} ms"),
            Self::Pan { dx, dy } => write!(f, "pan {dx},{dy}"),
            Self::Zoom { factor, at: None } => write!(f, "zoom ×{factor}"),
            Self::Zoom {
                factor,
                at: Some([x, y]),
            } => write!(f, "zoom ×{factor} at {x},{y}"),
            Self::Orbit { theta, phi } => write!(f, "orbit {theta}°,{phi}°"),
            Self::Scrub { axis, count } => write!(f, "scrub {axis}:{count:+}"),
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
        }
    }
}

fn off_suffix(visible: bool) -> &'static str {
    if visible { "" } else { "=off" }
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
                "a step could not be read: {error}; the kinds are wait, hold, pan, zoom, orbit, scrub, and select"
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

/// The flag ids, in the order their help prints. `wait` and `hold` carry
/// no text to parse; the rest go through `step_from_flag`.
const STEP_FLAGS: [&str; 7] = ["wait", "hold", "pan", "zoom_by", "orbit", "scrub", "select"];

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
                    .value_name("DX,DY")
                    .action(ArgAction::Append)
                    .allow_hyphen_values(true)
                    .help(
                        "Drag the pointer by this screen delta, in CSS pixels: a plain drag in \
                         slice mode, a shift drag in volume mode",
                    ),
            )
            .arg(
                Arg::new("zoom_by")
                    .long("zoom-by")
                    .value_name("FACTOR[@X,Y]")
                    .action(ArgAction::Append)
                    .help(
                        "Multiply the view's scale by FACTOR, about a point in CSS pixels from the \
                         canvas's top-left corner, or about its center. Wheel events in slice mode, \
                         quantised to the viewer's notch; one wheel event in volume mode",
                    ),
            )
            .arg(
                Arg::new("orbit")
                    .long("orbit")
                    .value_name("THETA,PHI")
                    .action(ArgAction::Append)
                    .allow_hyphen_values(true)
                    .help("Orbit by two angles in degrees, as a drag in volume mode"),
            )
            .arg(
                Arg::new("scrub")
                    .long("scrub")
                    .value_name("AXIS:COUNT")
                    .action(ArgAction::Append)
                    .allow_hyphen_values(true)
                    .help("Move the z, t, or c selector by COUNT positions, for example t:1 or z:-5"),
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
            .next_help_heading(None)
    }

    fn augment_args_for_update(cmd: Command) -> Command {
        Self::augment_args(cmd)
    }
}

impl clap::FromArgMatches for ScriptArgs {
    fn from_arg_matches(matches: &ArgMatches) -> Result<Self, clap::Error> {
        let mut ordered: Vec<(usize, ScriptStep)> = Vec::new();
        if let Some(indices) = matches.indices_of("wait") {
            ordered.extend(indices.map(|index| (index, ScriptStep::Wait)));
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
            if id == "wait" || id == "hold" {
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
                    format!("step {} (--{}): {reason}\n", n + 1, step.kind()),
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

/// One flag's text as a step: `DX,DY`, `FACTOR[@X,Y]`, `THETA,PHI`,
/// `AXIS:COUNT`, or `channel:N[=off]` / `layer:ID[=off]`.
pub fn step_from_flag(id: &str, text: &str) -> Result<ScriptStep, String> {
    match id {
        "pan" => {
            let (dx, dy) = parse_pair(text)?;
            Ok(ScriptStep::Pan { dx, dy })
        }
        "orbit" => {
            let (theta, phi) = parse_pair(text)?;
            Ok(ScriptStep::Orbit { theta, phi })
        }
        "zoom_by" => {
            let (factor, at) = match text.split_once('@') {
                Some((factor, point)) => (factor, Some(parse_pair(point)?)),
                None => (text, None),
            };
            let factor = parse_number(factor)?;
            Ok(ScriptStep::Zoom {
                factor,
                at: at.map(|(x, y)| [x, y]),
            })
        }
        "scrub" => {
            let (axis, count) = text
                .split_once(':')
                .ok_or_else(|| "a scrub is AXIS:COUNT, for example t:1".to_string())?;
            let axis: ScrubAxis = axis.parse()?;
            let count: i64 = count
                .parse()
                .map_err(|_| format!("a scrub count is a whole number, not {count}"))?;
            Ok(ScriptStep::Scrub { axis, count })
        }
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

/// The one wheel delta that scales a volume view by `factor`: the camera
/// distance divides by the factor, so zooming in by 2 halves it.
pub fn volume_zoom_delta(factor: f64, scale: InputScale) -> f64 {
    (1.0 / factor - 1.0) / scale.volume_zoom_per_wheel_delta
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
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "sent", rename_all = "camelCase")]
pub enum SentInput {
    /// A pointer drag from `from` to `to` in CSS pixels, over `moves` move
    /// events, with Shift held when `shift` is true.
    Drag {
        from: [f64; 2],
        to: [f64; 2],
        moves: usize,
        shift: bool,
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
    },
    /// A call on the seam's control entry, and what the page answered.
    Control {
        applied: bool,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        reason: Option<String>,
    },
    /// Nothing: the step cannot land in the view the page is showing, so
    /// the driver sent no input rather than one the page would take as
    /// another gesture. An orbit on a slice view is the case.
    Withheld { reason: String },
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

/// Run `script` on `page`, which has finished its open. Each gesture step
/// waits for the run it opened to conclude, under the same deadline the open
/// had, and closes it as `timeout` when it does not. The record is left on
/// the page for the export to fill in each step's run and hand back, and the
/// last step's run is pinned as the run the file is about.
pub async fn run_script(page: &mut Page, script: &Script, wait: Duration) -> Result<(), CliError> {
    wait_for_script_seam(page, wait).await?;
    let mut steps = Vec::with_capacity(script.steps.len());
    for step in &script.steps {
        steps.push(run_step(page, step, wait).await?);
    }
    let record = ScriptRecord { steps };
    let json = serde_json::to_string(&record)?;
    page.evaluate(
        &format!("(window.__lucidaTraceScript = {json}, true)"),
        wait,
    )
    .await?;
    pin_run(page, record.last_run_id(), wait).await
}

async fn run_step(
    page: &mut Page,
    step: &ScriptStep,
    wait: Duration,
) -> Result<StepRecord, CliError> {
    let before = read_step_state(page, wait).await?;
    let scale = before.input_scale.unwrap_or_default();
    let mode = before.camera_mode();
    let mut input = None;
    let mut run_id = None;
    let mut timed_out = false;
    match step {
        ScriptStep::Wait => {
            timed_out = !wait_for_quiescence(page, wait, before.hold_ms).await?;
        }
        ScriptStep::Hold { ms } => tokio::time::sleep(Duration::from_millis(*ms)).await,
        // A drag pans the slice view and orbits the volume view, where a
        // shift drag pans instead. Sent only where it means what the step
        // says, so a step never lands as another gesture under another name.
        ScriptStep::Pan { dx, dy } => {
            input = Some(match mode {
                Some("slice") => drag(page, (*dx, *dy), false, wait).await?,
                Some("arcball") => drag(page, (*dx, *dy), true, wait).await?,
                other => withheld("a pan", "the slice or the volume view", other),
            });
        }
        ScriptStep::Orbit { theta, phi } => {
            input = Some(match mode {
                Some("arcball") => drag(page, orbit_drag(*theta, *phi, scale), false, wait).await?,
                other => withheld("an orbit", "the volume view", other),
            });
        }
        ScriptStep::Zoom { factor, at } => {
            input = Some(wheel_zoom(page, *factor, *at, mode, scale, wait).await?);
        }
        ScriptStep::Scrub { axis, count } => {
            let expression = format!(
                "JSON.stringify(window.lucidaTrace.scrub({}, {count}))",
                json_string(&axis.to_string())
            );
            input = Some(control_outcome(page, &expression, wait).await?);
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
    }
    if !matches!(step, ScriptStep::Wait | ScriptStep::Hold { .. }) {
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

/// After a gesture's input: the run it opened, once concluded, and whether
/// the deadline passed first. An input that opened no run, because it landed
/// on nothing or the page refused it, is reported as none rather than waited
/// for.
async fn settle_gesture(
    page: &mut Page,
    before: &RunState,
    wait: Duration,
) -> Result<(Option<String>, bool), CliError> {
    let deadline = tokio::time::Instant::now() + wait;
    let state = read_step_state(page, wait).await?.run_state;
    if !state.open && state.concluded == before.concluded {
        return Ok((None, false));
    }
    loop {
        let state = read_step_state(page, wait).await?.run_state;
        if state.concluded > before.concluded {
            return Ok((state.last_concluded_run_id, false));
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

async fn drag(
    page: &mut Page,
    delta: (f64, f64),
    shift: bool,
    wait: Duration,
) -> Result<SentInput, CliError> {
    let rect = canvas_rect(page, wait).await?;
    let from = rect.drag_origin(delta);
    let moves = drag_moves(delta);
    let modifiers = if shift { SHIFT_MODIFIER } else { 0 };
    page.dispatch_mouse_event(
        json!({ "type": "mousePressed", "x": from.0, "y": from.1, "button": "left", "buttons": 1, "clickCount": 1, "modifiers": modifiers }),
        wait,
    )
    .await?;
    let mut to = from;
    for offset in drag_path(delta, moves) {
        to = (from.0 + offset.0, from.1 + offset.1);
        page.dispatch_mouse_event(
            json!({ "type": "mouseMoved", "x": to.0, "y": to.1, "button": "left", "buttons": 1, "modifiers": modifiers }),
            wait,
        )
        .await?;
        tokio::time::sleep(MOVE_INTERVAL).await;
    }
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
    })
}

async fn wheel_zoom(
    page: &mut Page,
    factor: f64,
    at: Option<[f64; 2]>,
    mode: Option<&str>,
    scale: InputScale,
    wait: Duration,
) -> Result<SentInput, CliError> {
    let rect = canvas_rect(page, wait).await?;
    let point = at.map(|at| rect.point(at)).unwrap_or_else(|| rect.center());
    // The slice viewer zooms a fixed step per wheel event, the volume
    // viewer by the event's delta; the view says which is on screen.
    let (delta_y, notches, reached) = if mode == Some("slice") {
        let (notches, reached) = slice_zoom_notches(factor, scale);
        let delta = if notches > 0 {
            -WHEEL_NOTCH_DELTA
        } else {
            WHEEL_NOTCH_DELTA
        };
        (delta, notches.unsigned_abs() as u32, reached)
    } else {
        (volume_zoom_delta(factor, scale), 1, factor)
    };
    for _ in 0..notches {
        page.dispatch_mouse_event(
            json!({ "type": "mouseWheel", "x": point.0, "y": point.1, "deltaX": 0, "deltaY": delta_y }),
            wait,
        )
        .await?;
        tokio::time::sleep(MOVE_INTERVAL).await;
    }
    Ok(SentInput::Wheel {
        at: [point.0, point.1],
        delta_y,
        notches,
        factor: reached,
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
/// fields the page filled at export; nothing is derived here (ADR 0051).
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
        match &step.input {
            Some(SentInput::Control {
                applied: false,
                reason: Some(reason),
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
                    dy: -50.0
                },
                ScriptStep::Zoom {
                    factor: 2.0,
                    at: None
                },
                ScriptStep::Zoom {
                    factor: 0.5,
                    at: Some([10.0, 20.0])
                },
                ScriptStep::Orbit {
                    theta: 30.0,
                    phi: 15.0
                },
                ScriptStep::Scrub {
                    axis: ScrubAxis::T,
                    count: -2
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
            unknown.contains("wait, hold, pan, zoom, orbit, scrub, and select"),
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
                dy: -50.0
            }
        );
        assert_eq!(
            step_from_flag("orbit", "30,15").unwrap(),
            ScriptStep::Orbit {
                theta: 30.0,
                phi: 15.0
            }
        );
        assert_eq!(
            step_from_flag("zoom_by", "2").unwrap(),
            ScriptStep::Zoom {
                factor: 2.0,
                at: None
            }
        );
        assert_eq!(
            step_from_flag("zoom_by", "0.5@100,200").unwrap(),
            ScriptStep::Zoom {
                factor: 0.5,
                at: Some([100.0, 200.0])
            }
        );
        assert_eq!(
            step_from_flag("scrub", "t:1").unwrap(),
            ScriptStep::Scrub {
                axis: ScrubAxis::T,
                count: 1
            }
        );
        assert_eq!(
            step_from_flag("scrub", "Z:-5").unwrap(),
            ScriptStep::Scrub {
                axis: ScrubAxis::Z,
                count: -5
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
                    phi: 0.0
                },
                ScriptStep::Wait,
                ScriptStep::Scrub {
                    axis: ScrubAxis::T,
                    count: 1
                },
                ScriptStep::Hold { ms: 250 },
                ScriptStep::Wait,
                ScriptStep::Pan {
                    dx: -100.0,
                    dy: 0.0
                },
                ScriptStep::Zoom {
                    factor: 2.0,
                    at: Some([10.0, 10.0])
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
        assert!((volume_zoom_delta(2.0, scale) - (-500.0)).abs() < 1e-9);
        assert!((volume_zoom_delta(0.5, scale) - 1000.0).abs() < 1e-9);
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
                phi: 0.0
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
                    },
                    Some("run-3"),
                    true,
                ),
                record(
                    ScriptStep::Scrub {
                        axis: ScrubAxis::T,
                        count: 1,
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
        });
        let mut withheld_orbit = record(
            ScriptStep::Orbit {
                theta: 30.0,
                phi: 0.0,
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
                    },
                    Some("run-3"),
                    true,
                ),
                record(
                    ScriptStep::Scrub {
                        axis: ScrubAxis::T,
                        count: 1,
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
                dy: -50.0
            }
            .to_string(),
            "pan 100,-50"
        );
        assert_eq!(
            ScriptStep::Zoom {
                factor: 2.0,
                at: None
            }
            .to_string(),
            "zoom ×2"
        );
        assert_eq!(
            ScriptStep::Zoom {
                factor: 0.5,
                at: Some([10.0, 20.0])
            }
            .to_string(),
            "zoom ×0.5 at 10,20"
        );
        assert_eq!(
            ScriptStep::Orbit {
                theta: 30.0,
                phi: 15.0
            }
            .to_string(),
            "orbit 30°,15°"
        );
        assert_eq!(
            ScriptStep::Scrub {
                axis: ScrubAxis::Z,
                count: -5
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
}
