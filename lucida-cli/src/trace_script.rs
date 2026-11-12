//! The trace driver's script: an ordered list of steps
//! the driver performs on the page once the open has settled, so an agent
//! can reproduce what a person does headlessly: pan, zoom, orbit, scrub,
//! select, switch mode, fit, resize, set contrast, add or remove a
//! dataset, click or drag on the minimap, and swipe or blink a comparison.
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
use lucida_core::scene::{LinkMode, LinkProperty};
use lucida_core::slice_plane::SlicePlane;

use crate::browser::{Page, Viewport};
use crate::error::{CliError, ErrorKind};
use crate::trace::{CLOSE_AS_TIMEOUT, RunState, json_string, pin_run};

// ---------------------------------------------------------------------------
// The steps
// ---------------------------------------------------------------------------

/// The selectors a scrub moves. `y` and `x` are the cuts of an XZ and a YZ
/// slice view.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ScrubAxis {
    Z,
    Y,
    X,
    T,
    C,
}

impl std::str::FromStr for ScrubAxis {
    type Err = String;

    fn from_str(text: &str) -> Result<Self, Self::Err> {
        match text {
            "z" | "Z" => Ok(Self::Z),
            "y" | "Y" => Ok(Self::Y),
            "x" | "X" => Ok(Self::X),
            "t" | "T" => Ok(Self::T),
            "c" | "C" => Ok(Self::C),
            other => Err(format!(
                "no selector is called {other}; the axes are z, y, x, t, and c"
            )),
        }
    }
}

impl std::fmt::Display for ScrubAxis {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(match self {
            Self::Z => "z",
            Self::Y => "y",
            Self::X => "x",
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

/// What a minimap step does with the pointer.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum MinimapAction {
    Click,
    Drag,
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
    /// Show or hide a channel of the dataset in hand, a layer by dataset id,
    /// or a label of the dataset in hand by its index among the labels.
    Select {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        channel: Option<u32>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        layer: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        label: Option<u32>,
        #[serde(default = "visible_by_default")]
        visible: bool,
    },
    /// Switch to the 2D slice view or the 3D volume view.
    Mode { to: ViewMode },
    /// Cut another plane with the slice view: `xy`, `xz` or `yz`.
    Plane { to: SlicePlane },
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
    /// Click on the minimap at `at`, or drag from `at` to `to`, in CSS
    /// pixels from the minimap's top-left corner. A drag lands as one burst
    /// or spread over `durationMs`. The minimap is on the full viewer page.
    Minimap {
        action: MinimapAction,
        at: [f64; 2],
        #[serde(default, skip_serializing_if = "Option::is_none")]
        to: Option<[f64; 2]>,
        #[serde(
            rename = "durationMs",
            default,
            skip_serializing_if = "Option::is_none"
        )]
        duration_ms: Option<u64>,
    },
    /// Show the view's comparison as a swipe with its divider at `at`, a
    /// fraction of the view's width from its left edge. With no comparison
    /// one starts between the two open datasets, or between the dataset in
    /// hand and the one opened from `with`. With `durationMs` the divider is
    /// dragged there at a person's pace by its handle, which is on the full
    /// viewer page.
    Swipe {
        at: f64,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        with: Option<String>,
        #[serde(
            rename = "durationMs",
            default,
            skip_serializing_if = "Option::is_none"
        )]
        duration_ms: Option<u64>,
    },
    /// Show the comparison as a blink and flip it to the other dataset
    /// `count` times, one after another or one every `intervalMs`. Starts a
    /// comparison as a swipe does.
    Blink {
        count: u32,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        with: Option<String>,
        #[serde(
            rename = "intervalMs",
            default,
            skip_serializing_if = "Option::is_none"
        )]
        interval_ms: Option<u64>,
    },
    /// Divide the canvas among views as `layout` does, `single`, `columns`,
    /// `rows`, `grid` or `four_up`, then move into each view, in order, the open datasets
    /// whose source URLs `show` lists for it, as a layer dropped on a view
    /// moves there; with `keep`, shows them there as well, as "Show in both
    /// views" does. Four-up shows one set of datasets in all four views, so
    /// there every dataset the lists name shows in each. Only a script file
    /// can name the datasets.
    Views {
        layout: String,
        #[serde(default, skip_serializing_if = "Vec::is_empty")]
        show: Vec<Vec<String>>,
        #[serde(default, skip_serializing_if = "std::ops::Not::not")]
        keep: bool,
    },
    /// Link `property` between the two views in `mode`, `linked`,
    /// `relative` or `off`, as the link popover does.
    Link {
        property: LinkProperty,
        mode: LinkMode,
    },
    /// Move the pointer by a screen delta, in CSS pixels, with no button
    /// down, from where a pan by it would start, as one burst or spread over
    /// `durationMs`. The view under it reads the samples there, and puts a
    /// crosshair in each view that looks at the same place.
    Hover {
        dx: f64,
        dy: f64,
        #[serde(
            rename = "durationMs",
            default,
            skip_serializing_if = "Option::is_none"
        )]
        duration_ms: Option<u64>,
    },
    /// Send the pans, zooms, orbits and hovers that follow to the `view`th view, by
    /// its place in the layout from 0, which a press or a wheel there makes
    /// the active view; to the canvas again when `view` is absent.
    Target {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        view: Option<usize>,
    },
}

/// The view layouts, as a views step spells them, and how many views each holds.
const VIEW_LAYOUTS: [(&str, usize); 5] = [
    ("single", 1),
    ("columns", 2),
    ("rows", 2),
    ("grid", 4),
    ("four_up", 4),
];

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
            Self::Plane { .. } => "plane",
            Self::Fit => "fit",
            Self::Resize { .. } => "resize",
            Self::Contrast { .. } => "contrast",
            Self::Add { .. } => "add",
            Self::Remove { .. } => "remove",
            Self::Minimap { .. } => "minimap",
            Self::Swipe { .. } => "swipe",
            Self::Blink { .. } => "blink",
            Self::Views { .. } => "views",
            Self::Link { .. } => "link",
            Self::Hover { .. } => "hover",
            Self::Target { .. } => "target",
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
            Self::Select {
                channel,
                layer,
                label,
                ..
            } => match (channel, layer, label) {
                (Some(_), None, None) | (None, None, Some(_)) => Ok(()),
                (None, Some(layer), None) if !layer.is_empty() => Ok(()),
                (None, Some(_), None) => Err("a layer is named by its dataset id".to_string()),
                (None, None, None) => {
                    Err("a select names a channel, a layer or a label".to_string())
                }
                _ => Err("a select names one channel, layer or label".to_string()),
            },
            Self::Mode { .. } | Self::Plane { .. } | Self::Fit => Ok(()),
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
            Self::Minimap {
                action,
                at,
                to,
                duration_ms,
            } => {
                let on_minimap =
                    |point: &[f64; 2]| point.iter().all(|v| v.is_finite() && *v >= 0.0);
                if !on_minimap(at) || to.as_ref().is_some_and(|to| !on_minimap(to)) {
                    return Err(
                        "a minimap point is two finite numbers from its top-left corner"
                            .to_string(),
                    );
                }
                match (action, to) {
                    (MinimapAction::Click, None) if duration_ms.is_none() => Ok(()),
                    (MinimapAction::Click, _) => {
                        Err("a minimap click has one point and no duration".to_string())
                    }
                    (MinimapAction::Drag, None) => {
                        Err("a minimap drag goes from at to to".to_string())
                    }
                    (MinimapAction::Drag, Some(to)) if to == at => {
                        Err("a minimap drag to where it started moves nothing".to_string())
                    }
                    (MinimapAction::Drag, Some(_)) => {
                        validate_duration("a minimap drag", *duration_ms)
                    }
                }
            }
            Self::Swipe {
                at,
                with,
                duration_ms,
            } => {
                if !(at.is_finite() && (0.0..=1.0).contains(at)) {
                    return Err(format!(
                        "a divider is a fraction of the view's width from 0 to 1, not {at}"
                    ));
                }
                validate_with(with.as_deref())?;
                validate_duration("a swipe", *duration_ms)
            }
            Self::Blink { count: 0, .. } => Err("a blink of 0 flips shows nothing".to_string()),
            Self::Blink {
                interval_ms: Some(0),
                ..
            } => Err(
                "a blink interval of 0 ms flips at once; leave the interval out for that"
                    .to_string(),
            ),
            Self::Blink { with, .. } => validate_with(with.as_deref()),
            Self::Views { layout, show, .. } => {
                let Some((_, views)) = VIEW_LAYOUTS.iter().find(|(name, _)| name == layout) else {
                    return Err(format!(
                        "a layout is single, columns, rows, grid or four_up, not {layout}"
                    ));
                };
                if show.len() > *views {
                    return Err(format!(
                        "a {layout} layout has {views} view(s), not {}",
                        show.len()
                    ));
                }
                show.iter()
                    .flatten()
                    .try_for_each(|url| validate_with(Some(url)))
            }
            Self::Hover {
                dx,
                dy,
                duration_ms,
            } => {
                if !dx.is_finite() || !dy.is_finite() {
                    return Err("a hover delta is two finite numbers".to_string());
                }
                if *dx == 0.0 && *dy == 0.0 {
                    return Err("a hover by 0,0 moves nothing".to_string());
                }
                validate_duration("a hover", *duration_ms)
            }
            Self::Link { .. } | Self::Target { .. } => Ok(()),
        }
    }

    /// How long the gesture's events are spread over, or None for a burst.
    fn pace(&self) -> Option<Duration> {
        match self {
            Self::Pan { duration_ms, .. }
            | Self::Hover { duration_ms, .. }
            | Self::Zoom { duration_ms, .. }
            | Self::Orbit { duration_ms, .. }
            | Self::Minimap { duration_ms, .. }
            | Self::Swipe { duration_ms, .. } => duration_ms.map(Duration::from_millis),
            _ => None,
        }
    }
}

fn validate_with(with: Option<&str>) -> Result<(), String> {
    match with {
        Some(url) if url.trim().is_empty() => {
            Err("a comparison names the dataset to compare with by its source URL".to_string())
        }
        _ => Ok(()),
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
            Self::Select {
                label: Some(label),
                visible,
                ..
            } => write!(f, "select label:{label}{}", off_suffix(*visible)),
            Self::Select { layer, visible, .. } => write!(
                f,
                "select layer:{}{}",
                layer.as_deref().unwrap_or(""),
                off_suffix(*visible)
            ),
            Self::Mode { to } => write!(f, "mode {to}"),
            Self::Plane { to } => write!(f, "plane {to}"),
            Self::Fit => f.write_str("fit"),
            Self::Resize { width, height } => write!(f, "resize {width}x{height}"),
            Self::Contrast { channel, min, max } => write!(f, "contrast {channel}:{min},{max}"),
            Self::Add { url } => write!(f, "add {url}"),
            Self::Remove { url } => write!(f, "remove {url}"),
            Self::Minimap {
                at,
                to,
                duration_ms,
                ..
            } => {
                write!(f, "minimap {},{}", at[0], at[1])?;
                if let Some(to) = to {
                    write!(f, ":{},{}", to[0], to[1])?;
                }
                f.write_str(&pace_suffix(*duration_ms))
            }
            Self::Swipe {
                at,
                with,
                duration_ms,
            } => write!(
                f,
                "swipe {at}{}{}",
                pace_suffix(*duration_ms),
                with_suffix(with.as_deref())
            ),
            Self::Blink {
                count,
                with,
                interval_ms,
            } => write!(
                f,
                "blink {count}{}{}",
                pace_suffix(*interval_ms),
                with_suffix(with.as_deref())
            ),
            Self::Views { layout, .. } => write!(f, "views {layout}"),
            Self::Link { property, mode } => write!(f, "link {property} {mode}"),
            Self::Hover {
                dx,
                dy,
                duration_ms,
            } => write!(f, "hover {dx},{dy}{}", pace_suffix(*duration_ms)),
            Self::Target { view: Some(view) } => write!(f, "target view {view}"),
            Self::Target { view: None } => f.write_str("target canvas"),
        }
    }
}

/// The dataset a comparison step names, which only a script file can.
fn with_suffix(with: Option<&str>) -> String {
    with.map(|url| format!(" with {url}")).unwrap_or_default()
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
                 scrub, select, mode, plane, fit, resize, contrast, add, remove, minimap, \
                 swipe, and blink"
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
        self.steps.iter_mut().flat_map(|step| -> Vec<&mut String> {
            match step {
                ScriptStep::Add { url } | ScriptStep::Remove { url } => vec![url],
                ScriptStep::Swipe { with, .. } | ScriptStep::Blink { with, .. } => {
                    with.as_mut().into_iter().collect()
                }
                ScriptStep::Views { show, .. } => show.iter_mut().flatten().collect(),
                _ => Vec::new(),
            }
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
const STEP_FLAGS: [&str; 17] = [
    "wait",
    "hold",
    "pan",
    "zoom_by",
    "orbit",
    "scrub",
    "select",
    "mode",
    "plane",
    "fit",
    "resize",
    "set_contrast",
    "add",
    "remove",
    "minimap",
    "swipe",
    "blink",
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
                         canvas's top-left corner, or about its center, as wheel events of about a \
                         mouse notch each. Add /MS to send one per display frame over that many \
                         milliseconds instead",
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
                        "Show a channel of the dataset in hand, a layer by dataset id, or a label of \
                         the dataset in hand by its index among the labels: channel:1, layer:ID or \
                         label:0. Add =off to hide it instead",
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
                Arg::new("plane")
                    .long("plane")
                    .value_name("xy|xz|yz")
                    .action(ArgAction::Append)
                    .help("Cut another plane with the slice view, as its plane toggle does"),
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
            .arg(
                Arg::new("minimap")
                    .long("minimap")
                    .value_name("X,Y[:X2,Y2][/MS]")
                    .action(ArgAction::Append)
                    .help(
                        "Click on the minimap at a point in CSS pixels from its top-left corner, \
                         or drag from X,Y to X2,Y2. Add /MS to spread a drag over that many \
                         milliseconds. The minimap is on the full viewer page (--full-ui)",
                    ),
            )
            .arg(
                Arg::new("swipe")
                    .long("swipe")
                    .value_name("AT[/MS]")
                    .action(ArgAction::Append)
                    .help(
                        "Show the comparison as a swipe with its divider at AT, a fraction of the \
                         view's width from 0 to 1, starting one between the two open datasets if \
                         none is shown. Add /MS to drag the divider there by its handle over that \
                         many milliseconds; the handle is on the full viewer page (--full-ui)",
                    ),
            )
            .arg(
                Arg::new("blink")
                    .long("blink")
                    .value_name("COUNT[/MS]")
                    .action(ArgAction::Append)
                    .help(
                        "Show the comparison as a blink and flip it to the other dataset COUNT \
                         times, starting one as --swipe does. Add /MS to flip once every MS \
                         milliseconds",
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
        "plane" => Ok(ScriptStep::Plane { to: text.parse()? }),
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
        "minimap" => {
            let (text, duration_ms) = split_pace(text)?;
            let (at, to) = match text.split_once(':') {
                Some((at, to)) => (parse_pair(at)?, Some(parse_pair(to)?)),
                None => (parse_pair(text)?, None),
            };
            Ok(ScriptStep::Minimap {
                action: if to.is_some() {
                    MinimapAction::Drag
                } else {
                    MinimapAction::Click
                },
                at: [at.0, at.1],
                to: to.map(|(x, y)| [x, y]),
                duration_ms,
            })
        }
        "swipe" => {
            let (text, duration_ms) = split_pace(text)?;
            Ok(ScriptStep::Swipe {
                at: parse_number(text)?,
                with: None,
                duration_ms,
            })
        }
        "blink" => {
            let (text, interval_ms) = split_pace(text)?;
            let count: u32 = text
                .trim()
                .parse()
                .map_err(|_| format!("a blink count is a whole number, not {text}"))?;
            Ok(ScriptStep::Blink {
                count,
                with: None,
                interval_ms,
            })
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
                .ok_or_else(|| "a select is channel:N, layer:ID or label:N".to_string())?;
            match kind {
                "channel" => {
                    let channel: u32 = name
                        .parse()
                        .map_err(|_| format!("a channel is a whole number from 0, not {name}"))?;
                    Ok(ScriptStep::Select {
                        channel: Some(channel),
                        layer: None,
                        label: None,
                        visible,
                    })
                }
                "layer" if !name.is_empty() => Ok(ScriptStep::Select {
                    channel: None,
                    layer: Some(name.to_string()),
                    label: None,
                    visible,
                }),
                "layer" => Err("a layer is named by its dataset id".to_string()),
                "label" => {
                    let label: u32 = name
                        .parse()
                        .map_err(|_| format!("a label is a whole number from 0, not {name}"))?;
                    Ok(ScriptStep::Select {
                        channel: None,
                        layer: None,
                        label: Some(label),
                        visible,
                    })
                }
                other => Err(format!(
                    "a select is channel:N, layer:ID or label:N, not {other}:…"
                )),
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
#[serde(default, rename_all = "camelCase")]
pub struct InputScale {
    /// Radians of orbit per CSS pixel of drag in the volume view.
    pub orbit_radians_per_pixel: f64,
    /// Every view zooms by `exp(-deltaY × this)` per wheel event, so events
    /// compound to the zoom of their summed delta.
    pub wheel_zoom_per_pixel: f64,
}

impl Default for InputScale {
    fn default() -> Self {
        Self {
            orbit_radians_per_pixel: 0.005,
            wheel_zoom_per_pixel: 1.1_f64.ln() / WHEEL_NOTCH_DELTA,
        }
    }
}

/// The wheel delta of one notch, the value a mouse wheel raises.
pub const WHEEL_NOTCH_DELTA: f64 = 100.0;

/// The `Input.dispatchMouseEvent` request whose wheel event reaches the page
/// at `point` carrying `delta_y`. Chrome's device-metrics emulation divides a
/// dispatched wheel delta by the emulated device pixel ratio, which a real
/// display at that ratio does not, so the request carries it multiplied back.
pub fn wheel_event(point: (f64, f64), delta_y: f64, device_pixel_ratio: f64) -> Value {
    json!({
        "type": "mouseWheel",
        "x": point.0,
        "y": point.1,
        "deltaX": 0,
        "deltaY": delta_y * device_pixel_ratio,
    })
}

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

/// The wheel delta, in CSS pixels, that zooms a view by `factor`: negative
/// in, positive out.
pub fn wheel_zoom_delta(factor: f64, scale: InputScale) -> f64 {
    -factor.ln() / scale.wheel_zoom_per_pixel
}

/// The wheel events a burst splits a zoom's `delta` into: about a notch
/// each, as a mouse sends them, and at least one, because a zoom step that
/// sent nothing would not be a zoom.
pub fn wheel_notches(delta: f64) -> u32 {
    (delta.abs() / WHEEL_NOTCH_DELTA).round().max(1.0) as u32
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

    /// Whether a point given relative to the top-left corner lies on the canvas.
    pub fn holds(&self, at: [f64; 2]) -> bool {
        (0.0..=self.width).contains(&at[0]) && (0.0..=self.height).contains(&at[1])
    }

    /// Where a drag of `delta` starts so that it is centered on the canvas
    /// and stays inside it where it can: half the delta before the center,
    /// clamped to the canvas. A press on the far edge would land past the
    /// last pixel, on whatever lies beyond, so the clamp stops a pixel short.
    pub fn drag_origin(&self, delta: (f64, f64)) -> (f64, f64) {
        let (cx, cy) = self.center();
        let x = (cx - delta.0 / 2.0).clamp(self.x, self.x + (self.width - 1.0).max(0.0));
        let y = (cy - delta.1 / 2.0).clamp(self.y, self.y + (self.height - 1.0).max(0.0));
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
    /// `notches` wheel events at `at`, each reaching the page with `delta_y`,
    /// which amount to a zoom by `factor`.
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
    /// The pointer moved from `from` to `to` in CSS pixels with no button
    /// down, over `moves` move events.
    #[serde(rename_all = "camelCase")]
    Move {
        from: [f64; 2],
        to: [f64; 2],
        moves: usize,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        span_ms: Option<f64>,
    },
    /// A key pressed and released, named as the viewer's shortcuts name it.
    Key { key: String },
    /// A left-button press and release at `at`, in CSS pixels.
    Click { at: [f64; 2] },
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
            | Self::Move { span_ms, .. }
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

/// Whether a verdict kind fails the gate: a failing finding, a run that
/// never settled, or a steady-state finding after the view settled. A
/// `bound` verdict names where a settled run spent its time and passes. The
/// kinds are the page's ruleset's. A page whose ruleset predates `fail`
/// reports a failing finding as `stall`, and a gate over that page still
/// fails on it.
pub fn failing_verdict(kind: &str) -> bool {
    matches!(kind, "fail" | "unsettled" | "steady-state" | "stall")
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
    /// The load reading of the run the step opened, as the page's diagnostic
    /// states it: first frame, settle, prefetch, what the wire delivered,
    /// and the wanted chunks it went without.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub load: Option<Value>,
    /// What the run the step opened waited on, and how sure the page is.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub attribution: Option<Value>,
    /// Whether the driver's deadline passed while waiting for this step: for
    /// a wait, for quiescence; for a gesture, for its run to conclude.
    pub timed_out: bool,
    /// The view as the page would save it, before and after. Its `camera`
    /// is the active view's, and a gesture aimed at another view makes that
    /// one active, so with several views each one's own camera is the one
    /// under `views.views`, in the layout's order.
    pub view_before: Value,
    pub view_after: Value,
    /// Whether the page's view signature differs between the two: each
    /// view's camera, the selectors, and what is shown, by the page's own
    /// rule.
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

/// The minimap's input surface, or null when the page shows none: the
/// capture surface and a folded or hidden minimap lay it out at no size.
const MINIMAP_RECT_PROBE: &str = r#"(() => {
  const surface = document.querySelector('canvas.minimap-overlay');
  if (!surface) return null;
  const rect = surface.getBoundingClientRect();
  if (rect.width === 0 || rect.height === 0) return null;
  return JSON.stringify({ x: rect.left, y: rect.top, width: rect.width, height: rect.height });
})()"#;

/// The active view's swipe divider handle, or null when the page shows none:
/// the capture surface lays it out at no size. Another view's comparison
/// keeps a divider of its own.
const SWIPE_DIVIDER_PROBE: &str = r#"(() => {
  const divider = document.querySelector('.lc-view-overlay[data-active] .lc-swipe-divider');
  if (!divider) return null;
  const rect = divider.getBoundingClientRect();
  if (rect.width === 0 || rect.height === 0) return null;
  return JSON.stringify({ x: rect.left, y: rect.top, width: rect.width, height: rect.height });
})()"#;

/// The span the active view's divider slides along: the view's rectangle,
/// which a divider's place is a fraction of.
const SWIPE_TRACK_PROBE: &str = r#"(() => {
  const track = document.querySelector('.lc-view-overlay[data-active] .lc-swipe');
  if (!track) return null;
  const rect = track.getBoundingClientRect();
  if (rect.width === 0 || rect.height === 0) return null;
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
    let mut target = None;
    let mut steps = Vec::with_capacity(script.steps.len());
    for step in &script.steps {
        steps.push(run_step(page, step, &mut viewport, &mut target, wait).await?);
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
    target: &mut Option<usize>,
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
        ScriptStep::Target { view } => *target = *view,
        ScriptStep::Pan { dx, dy, .. } => {
            let (rect, mode) = gesture_target(page, *target, mode, wait).await?;
            input = Some(match mode.as_deref() {
                Some("slice") => drag(page, rect, (*dx, *dy), false, pace, wait).await?,
                Some("arcball") => drag(page, rect, (*dx, *dy), true, pace, wait).await?,
                other => withheld("a pan", "the slice or the volume view", other),
            });
        }
        ScriptStep::Hover { dx, dy, .. } => {
            let (rect, _) = gesture_target(page, *target, mode, wait).await?;
            input = Some(hover(page, rect, (*dx, *dy), pace, wait).await?);
        }
        ScriptStep::Orbit { theta, phi, .. } => {
            let (rect, mode) = gesture_target(page, *target, mode, wait).await?;
            input = Some(match mode.as_deref() {
                Some("arcball") => {
                    let delta = orbit_drag(*theta, *phi, scale);
                    drag(page, rect, delta, false, pace, wait).await?
                }
                other => withheld("an orbit", "the volume view", other),
            });
        }
        ScriptStep::Zoom { factor, at, .. } => {
            let (rect, _) = gesture_target(page, *target, mode, wait).await?;
            let zoom = wheel_zoom(
                page,
                rect,
                *factor,
                *at,
                scale,
                viewport.device_scale_factor,
                pace,
                wait,
            );
            input = Some(zoom.await?);
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
            label,
            visible,
        } => {
            let target = match (channel, label, layer) {
                (Some(channel), _, _) => json!({ "channel": channel }),
                (None, Some(label), _) => json!({ "label": label }),
                (None, None, layer) => json!({ "layer": layer }),
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
        // The capture surface hides the plane toggle, so the step calls the
        // handler it would, which the recorder hears as the plane input.
        ScriptStep::Plane { to } => {
            let expression = seam_call("plane", &json_string(&to.to_string()));
            input = Some(control_outcome(page, &expression, wait).await?);
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
                let to = Viewport {
                    width: *width,
                    height: *height,
                    ..*viewport
                };
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
        ScriptStep::Swipe {
            at,
            with,
            duration_ms: None,
        } => {
            let args = format!("{at}, {}", with_arg(with.as_deref()));
            input = Some(control_outcome(page, &seam_call("swipe", &args), wait).await?);
        }
        ScriptStep::Swipe {
            at,
            with,
            duration_ms: Some(_),
        } => {
            input = Some(drag_divider(page, *at, with.as_deref(), pace, wait).await?);
        }
        ScriptStep::Blink {
            count,
            with,
            interval_ms,
        } => {
            let expression = seam_call("blink", &with_arg(with.as_deref()));
            let interval = Duration::from_millis(interval_ms.unwrap_or(0));
            input = Some(repeat_control(page, &expression, *count, interval, "flips", wait).await?);
        }
        ScriptStep::Views { layout, show, keep } => {
            let show = serde_json::to_string(show).expect("a list of URL lists serializes");
            let args = format!("{}, {show}, {keep}", json_string(layout));
            let expression = seam_call("views", &args);
            input = Some(control_outcome(page, &expression, wait).await?);
        }
        ScriptStep::Link { property, mode } => {
            let args = format!(
                "{}, {}",
                json_string(&property.to_string()),
                json_string(&mode.to_string())
            );
            let expression = seam_call("link", &args);
            input = Some(control_outcome(page, &expression, wait).await?);
        }
        // The minimap steers the slice view and the orbit camera; the fly
        // camera ignores it.
        ScriptStep::Minimap { action, at, to, .. } => {
            input = Some(match mode {
                Some("slice" | "arcball") => {
                    minimap_input(page, *action, *at, *to, pace, wait).await?
                }
                other => withheld(
                    "a minimap step",
                    "the slice view or the orbit camera",
                    other,
                ),
            });
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
        load: None,
        attribution: None,
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
    rect: CanvasRect,
    delta: (f64, f64),
    shift: bool,
    pace: Option<Duration>,
    wait: Duration,
) -> Result<SentInput, CliError> {
    drag_from(page, rect.drag_origin(delta), delta, shift, pace, wait).await
}

/// Where a gesture goes and the camera it steers there: the canvas and the
/// page's camera, or with `view`, that view's pane and its own camera.
async fn gesture_target(
    page: &mut Page,
    view: Option<usize>,
    mode: Option<&str>,
    wait: Duration,
) -> Result<(CanvasRect, Option<String>), CliError> {
    let Some(index) = view else {
        return Ok((canvas_rect(page, wait).await?, mode.map(str::to_string)));
    };
    let pane: ViewPaneRect = evaluate_json(
        page,
        &view_pane_probe(index),
        &format!("the page has no view {index} to send a gesture to"),
        "a view's pane",
        wait,
    )
    .await?;
    Ok((pane.rect, Some(pane.camera)))
}

/// A view's pane and its camera mode, as the page lays them out.
#[derive(Debug, Deserialize)]
struct ViewPaneRect {
    #[serde(flatten)]
    rect: CanvasRect,
    camera: String,
}

/// The `index`th view's pane in layout order, and its camera mode.
fn view_pane_probe(index: usize) -> String {
    format!(
        "(() => {{ const pane = document.querySelectorAll('[data-view-pane]')[{index}]; \
         if (!pane) return null; const rect = pane.getBoundingClientRect(); \
         return JSON.stringify({{ x: rect.left, y: rect.top, width: rect.width, \
         height: rect.height, camera: pane.dataset.camera }}); }})()"
    )
}

/// A move of the pointer by `delta` with no button down, from where a drag
/// of it would start, paced as [`drag`] is. The pointer stays where it ends.
async fn hover(
    page: &mut Page,
    rect: CanvasRect,
    delta: (f64, f64),
    pace: Option<Duration>,
    wait: Duration,
) -> Result<SentInput, CliError> {
    let from = rect.drag_origin(delta);
    let moves = pace.map_or_else(|| drag_moves(delta), paced_moves);
    let moved = |at: (f64, f64)| json!({ "type": "mouseMoved", "x": at.0, "y": at.1, "button": "none", "buttons": 0 });
    let start = tokio::time::Instant::now();
    page.dispatch_mouse_event(moved(from), wait).await?;
    let mut to = from;
    for (n, offset) in drag_path(delta, moves).into_iter().enumerate() {
        if let Some(span) = pace {
            tokio::time::sleep_until(start + paced_offset(n + 1, moves + 1, span)).await;
        }
        to = (from.0 + offset.0, from.1 + offset.1);
        if pace.is_some() {
            page.dispatch_mouse_event_unacknowledged(moved(to)).await?;
        } else {
            page.dispatch_mouse_event(moved(to), wait).await?;
            tokio::time::sleep(MOVE_INTERVAL).await;
        }
    }
    Ok(SentInput::Move {
        from: [from.0, from.1],
        to: [to.0, to.1],
        moves,
        span_ms: pace.map(|_| elapsed_ms(start)),
    })
}

/// A drag of `delta` from `from`, in page CSS pixels, paced as [`drag`] is.
async fn drag_from(
    page: &mut Page,
    from: (f64, f64),
    delta: (f64, f64),
    shift: bool,
    pace: Option<Duration>,
    wait: Duration,
) -> Result<SentInput, CliError> {
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
    rect: CanvasRect,
    factor: f64,
    at: Option<[f64; 2]>,
    scale: InputScale,
    device_pixel_ratio: f64,
    pace: Option<Duration>,
    wait: Duration,
) -> Result<SentInput, CliError> {
    let point = at.map(|at| rect.point(at)).unwrap_or_else(|| rect.center());
    // Every view zooms by the delta, so any split reaches the factor. A
    // burst sends a mouse's notches, and a paced zoom one event per frame,
    // as a trackpad does.
    let delta = wheel_zoom_delta(factor, scale);
    let notches = pace.map_or_else(|| wheel_notches(delta), |span| paced_moves(span) as u32 + 1);
    let delta_y = delta / f64::from(notches);
    // Paced, every event but the last goes out on time without waiting for
    // the page, as a drag's moves do, and the last waits for it.
    let start = tokio::time::Instant::now();
    let mut span_ms = None;
    for n in 0..notches {
        let event = wheel_event(point, delta_y, device_pixel_ratio);
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
        factor,
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
    let expression = format!(
        "JSON.stringify(window.lucidaTrace.scrub({}, {}))",
        json_string(&axis.to_string()),
        count.signum()
    );
    let positions = count.unsigned_abs() as u32;
    repeat_control(page, &expression, positions, interval, "positions", wait).await
}

/// A seam call made `times` times, one every `interval`, the first at once.
/// It stops at the first call the page refuses and says how many of what,
/// `unit`, landed before it.
async fn repeat_control(
    page: &mut Page,
    expression: &str,
    times: u32,
    interval: Duration,
    unit: &str,
    wait: Duration,
) -> Result<SentInput, CliError> {
    let start = tokio::time::Instant::now();
    let mut moves = 0;
    let mut refusal = None;
    let mut span_ms = 0.0;
    for n in 0..times {
        tokio::time::sleep_until(start + interval * n).await;
        span_ms = elapsed_ms(start);
        let outcome = control_outcome(page, expression, wait).await?;
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
                format!("after {moves} of {times} {unit}: {reason}")
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

/// A comparison step's dataset as the seam takes it: a JSON string, or null.
fn with_arg(with: Option<&str>) -> String {
    with.map_or_else(|| "null".to_string(), json_string)
}

/// Drag the swipe divider's handle to `at` across the canvas at `pace`,
/// after showing the comparison as a swipe through the seam, which starts
/// one if none is shown. Nothing is dragged when the page refuses the swipe
/// or shows no handle.
async fn drag_divider(
    page: &mut Page,
    at: f64,
    with: Option<&str>,
    pace: Option<Duration>,
    wait: Duration,
) -> Result<SentInput, CliError> {
    let shown = control_outcome(
        page,
        &seam_call("swipe", &format!("null, {}", with_arg(with))),
        wait,
    )
    .await?;
    if matches!(shown, SentInput::Control { applied: false, .. }) {
        return Ok(shown);
    }
    // The handle mounts with the render that follows the swipe.
    let deadline = tokio::time::Instant::now() + RUN_OPEN_GRACE.min(wait);
    let handle = loop {
        if let Some(handle) = rect_probe(page, SWIPE_DIVIDER_PROBE, "a swipe divider", wait).await?
        {
            break handle;
        }
        if tokio::time::Instant::now() >= deadline {
            return Ok(SentInput::Withheld {
                reason:
                    "the page shows no swipe divider; it is on the full viewer page (--full-ui)"
                        .to_string(),
            });
        }
        tokio::time::sleep(POLL).await;
    };
    let Some(track) = rect_probe(page, SWIPE_TRACK_PROBE, "a swipe divider's view", wait).await?
    else {
        return Ok(SentInput::Withheld {
            reason: "the page shows the swipe divider over no view".to_string(),
        });
    };
    let from = handle.center();
    let to_x = track.x + at * track.width;
    drag_from(page, from, (to_x - from.0, 0.0), false, pace, wait).await
}

/// A click at `at` or a drag from `at` to `to` on the minimap, or nothing
/// when the page shows no minimap or a point lies off it.
async fn minimap_input(
    page: &mut Page,
    action: MinimapAction,
    at: [f64; 2],
    to: Option<[f64; 2]>,
    pace: Option<Duration>,
    wait: Duration,
) -> Result<SentInput, CliError> {
    let Some(rect) = minimap_rect(page, wait).await? else {
        return Ok(SentInput::Withheld {
            reason: "the page shows no minimap; it is open on the full viewer page (--full-ui), \
                     and starts hidden on a phone"
                .to_string(),
        });
    };
    if let Some(off) = [Some(at), to]
        .into_iter()
        .flatten()
        .find(|p| !rect.holds(*p))
    {
        return Ok(SentInput::Withheld {
            reason: format!(
                "{},{} is off the {}x{} minimap",
                off[0], off[1], rect.width, rect.height
            ),
        });
    }
    match (action, to) {
        (MinimapAction::Drag, Some(to)) => {
            let delta = (to[0] - at[0], to[1] - at[1]);
            drag_from(page, rect.point(at), delta, false, pace, wait).await
        }
        _ => click(page, rect.point(at), wait).await,
    }
}

/// A left-button press and release at `at`, in page CSS pixels.
async fn click(page: &mut Page, at: (f64, f64), wait: Duration) -> Result<SentInput, CliError> {
    for (kind, buttons) in [("mousePressed", 1), ("mouseReleased", 0)] {
        page.dispatch_mouse_event(
            json!({ "type": kind, "x": at.0, "y": at.1, "button": "left", "buttons": buttons, "clickCount": 1 }),
            wait,
        )
        .await?;
    }
    Ok(SentInput::Click { at: [at.0, at.1] })
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

/// The minimap's input surface in page CSS pixels, or None when the page shows none.
async fn minimap_rect(page: &mut Page, wait: Duration) -> Result<Option<CanvasRect>, CliError> {
    rect_probe(page, MINIMAP_RECT_PROBE, "a minimap", wait).await
}

/// The rect a probe answers with in page CSS pixels, or None when it answers
/// null. `what` names the element for an answer this CLI cannot read.
async fn rect_probe(
    page: &mut Page,
    probe: &str,
    what: &str,
    wait: Duration,
) -> Result<Option<CanvasRect>, CliError> {
    let value = page.evaluate(probe, wait).await?;
    let Some(json) = value.as_str() else {
        return Ok(None);
    };
    serde_json::from_str(json).map(Some).map_err(|error| {
        CliError::new(
            ErrorKind::Protocol,
            format!("the page returned {what} this CLI cannot read: {error}"),
        )
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
/// run never settled, or whose run's verdict fails. Read from the same
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
/// frame for the first input, at p95 and max, and the frames dropped when any
/// were.
fn describe_lag(lag: &Value) -> Option<String> {
    let timing = lag.get("inputToFrame")?;
    let p95 = timing.get("p95Ms")?.as_f64()?;
    let max = timing.get("maxMs")?.as_f64()?;
    let first = lag
        .get("firstInputMs")
        .and_then(Value::as_f64)
        .map(|first| format!("first {first} ms, "))
        .unwrap_or_default();
    let mut text = format!("input to frame {first}p95 {p95} ms, max {max} ms");
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
                    label: None,
                    visible: true
                },
                ScriptStep::Select {
                    channel: None,
                    layer: Some("ds-1".to_string()),
                    label: None,
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
                "wait, hold, pan, zoom, orbit, scrub, select, mode, plane, fit, resize, contrast, \
                 add, remove, minimap, swipe, and blink"
            ),
            "{unknown}"
        );
        let both = Script::from_json(
            r#"[{"kind": "wait"}, {"kind": "select", "channel": 1, "layer": "ds"}]"#,
        )
        .unwrap_err();
        assert_eq!(
            both,
            "step 2 (select): a select names one channel, layer or label"
        );
        let neither = Script::from_json(r#"[{"kind": "select"}]"#).unwrap_err();
        assert_eq!(
            neither,
            "step 1 (select): a select names a channel, a layer or a label"
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
                label: None,
                visible: true
            }
        );
        assert_eq!(
            step_from_flag("select", "channel:1=off").unwrap(),
            ScriptStep::Select {
                channel: Some(1),
                layer: None,
                label: None,
                visible: false
            }
        );
        assert_eq!(
            step_from_flag("select", "layer:ds-1").unwrap(),
            ScriptStep::Select {
                channel: None,
                layer: Some("ds-1".to_string()),
                label: None,
                visible: true
            }
        );
        assert_eq!(
            step_from_flag("select", "label:0").unwrap(),
            ScriptStep::Select {
                channel: None,
                layer: None,
                label: Some(0),
                visible: true
            }
        );
        assert_eq!(
            ScriptStep::Select {
                channel: None,
                layer: None,
                label: Some(2),
                visible: false
            }
            .to_string(),
            "select label:2=off"
        );
        assert_eq!(
            Script::from_json(r#"[{"kind": "select", "label": 0, "layer": "ds"}]"#).unwrap_err(),
            "step 1 (select): a select names one channel, layer or label"
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
            "no selector is called q; the axes are z, y, x, t, and c"
        );
        assert_eq!(
            step_from_flag("scrub", "y:-3").unwrap(),
            ScriptStep::Scrub {
                axis: ScrubAxis::Y,
                count: -3,
                interval_ms: None,
            }
        );
        assert_eq!(
            step_from_flag("plane", "XZ").unwrap(),
            ScriptStep::Plane { to: SlicePlane::Xz }
        );
        assert_eq!(
            step_from_flag("plane", "zz").unwrap_err(),
            "a slice plane is xy, xz or yz, not zz"
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
            step_from_flag("select", "label:x").unwrap_err(),
            "a label is a whole number from 0, not x"
        );
        assert_eq!(
            step_from_flag("select", "row:1").unwrap_err(),
            "a select is channel:N, layer:ID or label:N, not row:…"
        );
        assert_eq!(
            step_from_flag("select", "1").unwrap_err(),
            "a select is channel:N, layer:ID or label:N"
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
                    label: None,
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
            "wheelZoomPerPixel": 0.002
        }))
        .unwrap();
        assert_eq!(published.wheel_zoom_per_pixel, 0.002);
        // A page that publishes another shape keeps the defaults for what it lacks.
        let older: InputScale = serde_json::from_value(json!({
            "orbitRadiansPerPixel": 0.01,
            "sliceZoomInPerNotch": 1.1
        }))
        .unwrap();
        assert_eq!(older.wheel_zoom_per_pixel, scale.wheel_zoom_per_pixel);
    }

    /// A notch, 100 px, zooms a view by 1.1, and a zoom's delta is the sum
    /// its events compound to.
    #[test]
    fn a_zoom_is_the_wheel_delta_whose_notches_reach_its_factor() {
        let scale = InputScale::default();
        assert!((wheel_zoom_delta(1.1, scale) + 100.0).abs() < 1e-9);
        assert!((wheel_zoom_delta(1.0 / 1.1, scale) - 100.0).abs() < 1e-9);
        let delta = wheel_zoom_delta(2.0, scale);
        assert!((delta + 2.0_f64.ln() / 1.1_f64.ln() * 100.0).abs() < 1e-9);
        assert_eq!(wheel_notches(delta), 7);
        assert_eq!(wheel_notches(wheel_zoom_delta(0.5, scale)), 7);
        assert_eq!(wheel_notches(wheel_zoom_delta(4.0, scale)), 15);
        // A factor short of one notch still sends one: a zoom sends something.
        assert_eq!(wheel_notches(wheel_zoom_delta(1.01, scale)), 1);
        let notches = wheel_notches(delta);
        let reached = (-delta / f64::from(notches) * scale.wheel_zoom_per_pixel)
            .exp()
            .powi(notches as i32);
        assert!((reached - 2.0).abs() < 1e-9, "{reached}");
    }

    /// Chrome's device-metrics emulation hands the page a dispatched wheel
    /// delta divided by the emulated ratio, as headless Chrome measures at
    /// 1, 2 and 3. So a step of one notch reaches the page as the 100 px a
    /// mouse notch raises, and any zoom step's events, burst or paced,
    /// compound to its factor at every ratio.
    #[test]
    fn a_zoom_scales_the_view_alike_at_every_device_pixel_ratio() {
        let scale = InputScale::default();
        for ratio in [1.0, 2.0, 3.0] {
            let notch = wheel_event((720.0, 450.0), wheel_zoom_delta(1.1, scale), ratio);
            let received = notch["deltaY"].as_f64().unwrap() / ratio;
            assert!(
                (received + WHEEL_NOTCH_DELTA).abs() < 1e-9,
                "ratio {ratio}: {received}"
            );
            assert_eq!(notch["type"], "mouseWheel");
            assert_eq!(
                (notch["x"].as_f64(), notch["y"].as_f64()),
                (Some(720.0), Some(450.0))
            );
            for factor in [1.1, 2.0, 0.5] {
                let delta = wheel_zoom_delta(factor, scale);
                let paced = paced_moves(Duration::from_millis(500)) as u32 + 1;
                for events in [wheel_notches(delta), paced] {
                    let zoom: f64 = (0..events)
                        .map(|_| {
                            let event =
                                wheel_event((720.0, 450.0), delta / f64::from(events), ratio);
                            let received = event["deltaY"].as_f64().unwrap() / ratio;
                            (-received * scale.wheel_zoom_per_pixel).exp()
                        })
                        .product();
                    assert!(
                        (zoom - factor).abs() < 1e-9,
                        "ratio {ratio}, {events} events: {zoom}, not {factor}"
                    );
                }
            }
        }
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
        // A drag leftward starts on the last pixel, not past it.
        assert_eq!(rect.drag_origin((-4000.0, 0.0)), (1439.0, 450.0));
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
            load: None,
            attribution: None,
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
                label: None,
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
    fn the_gate_fails_on_a_step_that_never_settled_or_failed_and_names_it() {
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

        // Where a settled step spent its time is not a failure.
        script.steps[1].verdict = Some(StepVerdict {
            kind: "bound".to_string(),
            text: "bound by browser.upload: it held 270 ms, 31% of the chain, and nothing failed"
                .to_string(),
        });
        assert_eq!(script_gate_failure(&script), None);

        script.steps[1].verdict = Some(StepVerdict {
            kind: "fail".to_string(),
            text: "frame time over the ceiling".to_string(),
        });
        assert_eq!(
            script_gate_failure(&script).as_deref(),
            Some("step 2 (orbit 30°,0°) fail: frame time over the ceiling")
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
            "firstInputMs": 38.5,
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
                "view changed · input to frame first 38.5 ms, p95 34.1 ms, max 40 ms, 2 frame(s) dropped"
            ),
            "{text}"
        );
    }

    #[test]
    fn a_step_keeps_its_runs_load_reading_and_attribution() {
        let mut add = record(
            ScriptStep::Add {
                url: "/data/image.ome.zarr".to_string(),
            },
            Some("run-6"),
            true,
        );
        add.load = Some(json!({
            "firstFrameMs": 61.0,
            "settleMs": 412.5,
            "prefetchMs": null,
            "coverageLossChunks": 0,
            "received": { "bytes": 4_500_000, "requests": 34 }
        }));
        add.attribution = Some(json!({ "cause": "browser.upload", "confidence": "partial" }));
        let json = serde_json::to_value(&add).unwrap();
        assert_eq!(json["load"]["settleMs"], 412.5);
        assert_eq!(json["attribution"]["cause"], "browser.upload");
        let back: StepRecord = serde_json::from_value(json).unwrap();
        assert_eq!(back, add);
        let wait = serde_json::to_value(record(ScriptStep::Wait, None, false)).unwrap();
        assert!(wait.get("load").is_none() && wait.get("attribution").is_none());
    }

    #[test]
    fn the_text_names_each_steps_run_and_says_when_the_view_did_not_change() {
        let mut refused = record(
            ScriptStep::Select {
                channel: Some(3),
                layer: None,
                label: None,
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
                label: None,
                visible: false
            }
            .to_string(),
            "select channel:1=off"
        );
        assert_eq!(
            ScriptStep::Select {
                channel: None,
                layer: Some("ds-1".to_string()),
                label: None,
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
    /// the first at the start and the last at the end, and a paced zoom's
    /// events compound to the asked-for factor.
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
        let step = wheel_zoom_delta(2.0, scale) / f64::from(events);
        let zoom = (-step * scale.wheel_zoom_per_pixel).exp().powi(events);
        assert!((zoom - 2.0).abs() < 1e-9, "{zoom}");
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

    #[test]
    fn a_minimap_step_reads_from_a_file_and_a_flag_and_prints_as_typed() {
        let script = Script::from_json(
            r#"[
                {"kind": "minimap", "action": "click", "at": [150, 40]},
                {"kind": "minimap", "action": "drag", "at": [100, 100], "to": [140, 120.5], "durationMs": 500}
            ]"#,
        )
        .unwrap();
        let click = ScriptStep::Minimap {
            action: MinimapAction::Click,
            at: [150.0, 40.0],
            to: None,
            duration_ms: None,
        };
        let drag = ScriptStep::Minimap {
            action: MinimapAction::Drag,
            at: [100.0, 100.0],
            to: Some([140.0, 120.5]),
            duration_ms: Some(500),
        };
        assert_eq!(script.steps, vec![click.clone(), drag.clone()]);
        assert_eq!(step_from_flag("minimap", "150,40").unwrap(), click);
        assert_eq!(
            step_from_flag("minimap", "100,100:140,120.5/500").unwrap(),
            drag
        );
        assert_eq!(click.to_string(), "minimap 150,40");
        assert_eq!(drag.to_string(), "minimap 100,100:140,120.5/500");
        assert_eq!(drag.pace(), Some(Duration::from_millis(500)));
        let args = parse_flags(&["--wait", "--minimap", "10,20", "ds.zarr"]).unwrap();
        assert_eq!(args.steps.len(), 2);

        let refused = |json: &str| Script::from_json(json).unwrap_err();
        assert_eq!(
            refused(r#"[{"kind": "minimap", "action": "drag", "at": [1, 2]}]"#),
            "step 1 (minimap): a minimap drag goes from at to to"
        );
        assert_eq!(
            refused(r#"[{"kind": "minimap", "action": "drag", "at": [1, 2], "to": [1, 2]}]"#),
            "step 1 (minimap): a minimap drag to where it started moves nothing"
        );
        assert_eq!(
            refused(r#"[{"kind": "minimap", "action": "click", "at": [1, 2], "to": [3, 4]}]"#),
            "step 1 (minimap): a minimap click has one point and no duration"
        );
        assert_eq!(
            refused(r#"[{"kind": "minimap", "action": "click", "at": [-1, 2]}]"#),
            "step 1 (minimap): a minimap point is two finite numbers from its top-left corner"
        );
    }

    #[test]
    fn a_comparison_step_reads_from_a_file_and_a_flag_and_prints_as_typed() {
        let mut script = Script::from_json(
            r#"[
                {"kind": "swipe", "at": 0.25},
                {"kind": "swipe", "at": 0.8, "with": "b.zarr", "durationMs": 1500},
                {"kind": "blink", "count": 6, "intervalMs": 250}
            ]"#,
        )
        .unwrap();
        let swipe = ScriptStep::Swipe {
            at: 0.25,
            with: None,
            duration_ms: None,
        };
        let drag = ScriptStep::Swipe {
            at: 0.8,
            with: Some("b.zarr".to_string()),
            duration_ms: Some(1500),
        };
        let blink = ScriptStep::Blink {
            count: 6,
            with: None,
            interval_ms: Some(250),
        };
        assert_eq!(
            script.steps,
            vec![swipe.clone(), drag.clone(), blink.clone()]
        );
        assert_eq!(step_from_flag("swipe", "0.25").unwrap(), swipe);
        assert_eq!(step_from_flag("blink", "6/250").unwrap(), blink);
        assert_eq!(swipe.to_string(), "swipe 0.25");
        assert_eq!(drag.to_string(), "swipe 0.8/1500 with b.zarr");
        assert_eq!(blink.to_string(), "blink 6/250");
        // A drag is paced input; a blink's interval paces seam calls, as a scrub's does.
        assert_eq!(drag.pace(), Some(Duration::from_millis(1500)));
        assert_eq!(blink.pace(), None);
        // The dataset a comparison names resolves as an add's does.
        let urls: Vec<&mut String> = script.dataset_urls_mut().collect();
        assert_eq!(urls, vec!["b.zarr"]);
        let args = parse_flags(&["--swipe", "0.5", "--blink", "2", "ds.zarr"]).unwrap();
        assert_eq!(args.steps.len(), 2);

        let refused = |json: &str| Script::from_json(json).unwrap_err();
        assert_eq!(
            refused(r#"[{"kind": "swipe", "at": 1.5}]"#),
            "step 1 (swipe): a divider is a fraction of the view's width from 0 to 1, not 1.5"
        );
        assert_eq!(
            refused(r#"[{"kind": "blink", "count": 0}]"#),
            "step 1 (blink): a blink of 0 flips shows nothing"
        );
        assert_eq!(
            refused(r#"[{"kind": "blink", "count": 2, "with": " "}]"#),
            "step 1 (blink): a comparison names the dataset to compare with by its source URL"
        );
    }

    #[test]
    fn a_target_step_points_the_gestures_that_follow_at_a_view() {
        let script = Script::from_json(
            r#"[{"kind": "target", "view": 1}, {"kind": "pan", "dx": 10, "dy": 0}, {"kind": "target"}]"#,
        )
        .unwrap();
        assert_eq!(script.steps[0], ScriptStep::Target { view: Some(1) });
        assert_eq!(script.steps[0].to_string(), "target view 1");
        assert_eq!(script.steps[2].to_string(), "target canvas");
        assert_eq!(script.steps[0].kind(), "target");
    }

    #[test]
    fn a_views_step_names_a_layout_and_the_datasets_each_view_shows() {
        let mut script = Script::from_json(
            r#"[{"kind": "views", "layout": "columns", "show": [["a.zarr"], ["b.zarr"]]}]"#,
        )
        .unwrap();
        let views = ScriptStep::Views {
            layout: "columns".to_string(),
            show: vec![vec!["a.zarr".to_string()], vec!["b.zarr".to_string()]],
            keep: false,
        };
        assert_eq!(script.steps, vec![views.clone()]);
        assert_eq!(views.to_string(), "views columns");
        // The datasets a layout shows resolve as an add's do.
        let urls: Vec<&mut String> = script.dataset_urls_mut().collect();
        assert_eq!(urls, vec!["a.zarr", "b.zarr"]);

        let refused = |json: &str| Script::from_json(json).unwrap_err();
        assert_eq!(
            refused(r#"[{"kind": "views", "layout": "triple"}]"#),
            "step 1 (views): a layout is single, columns, rows, grid or four_up, not triple"
        );
        assert_eq!(
            refused(r#"[{"kind": "views", "layout": "single", "show": [["a.zarr"], ["b.zarr"]]}]"#),
            "step 1 (views): a single layout has 1 view(s), not 2"
        );
    }

    #[test]
    fn a_link_step_names_a_property_and_its_mode() {
        let script =
            Script::from_json(r#"[{"kind": "link", "property": "zoom", "mode": "relative"}]"#)
                .unwrap();
        let link = ScriptStep::Link {
            property: LinkProperty::Zoom,
            mode: LinkMode::Relative,
        };
        assert_eq!(script.steps, vec![link.clone()]);
        assert_eq!(link.to_string(), "link zoom relative");
        assert_eq!(link.kind(), "link");
        let refused = Script::from_json(r#"[{"kind": "link", "property": "pan", "mode": "on"}]"#)
            .unwrap_err();
        assert!(refused.contains("unknown variant `on`"), "{refused}");
    }

    #[test]
    fn a_hover_step_moves_the_pointer_with_no_button_down() {
        let script =
            Script::from_json(r#"[{"kind": "hover", "dx": -300, "dy": -150, "durationMs": 3000}]"#)
                .unwrap();
        let hover = ScriptStep::Hover {
            dx: -300.0,
            dy: -150.0,
            duration_ms: Some(3000),
        };
        assert_eq!(script.steps, vec![hover.clone()]);
        assert_eq!(hover.to_string(), "hover -300,-150/3000");
        assert_eq!(hover.pace(), Some(Duration::from_secs(3)));
        let refused = |json: &str| Script::from_json(json).unwrap_err();
        assert_eq!(
            refused(r#"[{"kind": "hover", "dx": 0, "dy": 0}]"#),
            "step 1 (hover): a hover by 0,0 moves nothing"
        );
        assert_eq!(
            serde_json::to_value(SentInput::Move {
                from: [10.0, 20.0],
                to: [5.0, 20.0],
                moves: 2,
                span_ms: None,
            })
            .unwrap(),
            json!({ "sent": "move", "from": [10.0, 20.0], "to": [5.0, 20.0], "moves": 2 })
        );
    }

    #[test]
    fn a_minimap_point_has_to_lie_on_the_minimap() {
        let rect = CanvasRect {
            x: 1000.0,
            y: 500.0,
            width: 200.0,
            height: 200.0,
        };
        assert!(rect.holds([0.0, 200.0]));
        assert!(!rect.holds([200.5, 10.0]));
        assert_eq!(rect.point([20.0, 30.0]), (1020.0, 530.0));
        assert_eq!(
            serde_json::to_value(SentInput::Click {
                at: [1020.0, 530.0]
            })
            .unwrap(),
            json!({ "sent": "click", "at": [1020.0, 530.0] })
        );
    }
}
