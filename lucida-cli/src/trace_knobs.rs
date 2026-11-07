//! The Dev controls knobs, set from the trace driver (ADR 0051 as amended).
//!
//! An experiment is a flag. Every knob the Dev controls panel shows is a flag
//! here, named by the label the panel shows, kebab-cased: "Prefetch depth" is
//! `--prefetch-depth` and "Main budget (MB)" is `--main-budget-mb`. The value
//! is what a person would type into the panel, in the panel's unit, and it
//! lands where the panel's own edit lands: the persisted planning
//! configuration for the planning knobs, and a storage envelope for the four
//! session-scoped CPU cache knobs, which the panel writes onto the live cache
//! and which therefore need a place a page can read before its cache exists.
//! Both are written into the page's browser storage before the page loads,
//! so the page starts under them rather than switching to them after its
//! first requests are in flight.
//!
//! `--versus` splits the knob flags into two configurations: the knobs before
//! it are the first run's and the knobs after it are the second's. The driver
//! runs the same script under each and prints the diff. A knob given on
//! neither side is the page's default on both.
//!
//! A test holds [`KNOBS`] to the panel's own source: every knob the panel
//! shows is here by field and by label, with the panel's bounds, and nothing
//! is here that the panel does not show. The monitor gains no knob.

use std::collections::BTreeMap;

use clap::{Arg, ArgAction, ArgMatches, Command};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

use crate::trace::json_string;

/// Which store a knob lands in.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum KnobStore {
    /// The persisted planning configuration Dev controls writes.
    Planning,
    /// The CPU cache's envelope, read once when the session constructs its cache.
    Cache,
}

/// One Dev controls knob, as the panel shows it and as the driver takes it.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Knob {
    /// The flag without its dashes: the panel's label, kebab-cased.
    pub flag: &'static str,
    /// The panel's label, verbatim.
    pub label: &'static str,
    /// The store field the value lands in.
    pub field: &'static str,
    pub store: KnobStore,
    /// The value's name in the flag's help.
    pub value_name: &'static str,
    /// Whether the panel takes whole numbers.
    pub integer: bool,
    /// Whether the panel shows megabytes for a field the store keeps in bytes.
    pub megabytes: bool,
    /// The panel's bounds, inclusive. A cache knob has no slider and takes any positive number.
    pub min: f64,
    pub max: Option<f64>,
    pub help: &'static str,
}

const MIB: f64 = 1024.0 * 1024.0;

/// The knobs, in the order the panel shows them.
pub const KNOBS: &[Knob] = &[
    Knob {
        flag: "prefetch-depth",
        label: "Prefetch depth",
        field: "prefetchDepth",
        store: KnobStore::Planning,
        value_name: "STEPS",
        integer: true,
        megabytes: false,
        min: 0.0,
        max: Some(5.0),
        help: "Steps the prefetch lane looks ahead; 0 leaves the prefetch lane empty",
    },
    Knob {
        flag: "importance-weight",
        label: "Importance weight",
        field: "importanceWeight",
        store: KnobStore::Planning,
        value_name: "WEIGHT",
        integer: true,
        megabytes: false,
        min: 10.0,
        max: Some(2000.0),
        help: "Coefficient on (1 - importance) in the priority formula",
    },
    Knob {
        flag: "distance-weight",
        label: "Distance weight",
        field: "distanceWeight",
        store: KnobStore::Planning,
        value_name: "WEIGHT",
        integer: true,
        megabytes: false,
        min: 1.0,
        max: Some(100.0),
        help: "Coefficient on a chunk's distance from the view center",
    },
    Knob {
        flag: "group-proxy-priority-bump",
        label: "Group-proxy priority bump",
        field: "groupProxyPriorityBump",
        store: KnobStore::Planning,
        value_name: "BUMP",
        integer: true,
        megabytes: false,
        min: 0.0,
        max: Some(500.0),
        help: "Priority added to a parent-group proxy request, pushing it below per-tile proxies",
    },
    Knob {
        flag: "detail-render-radius-view",
        label: "Detail render radius (view)",
        field: "detailRenderRadiusView",
        store: KnobStore::Planning,
        value_name: "VIEWS",
        integer: false,
        megabytes: false,
        min: 0.0,
        max: Some(2.0),
        help: "Detail render radius as a multiple of the visible region; 2 disables the filter",
    },
    Knob {
        flag: "coarse-render-radius-view",
        label: "Coarse render radius (view)",
        field: "coarseRenderRadiusView",
        store: KnobStore::Planning,
        value_name: "VIEWS",
        integer: false,
        megabytes: false,
        min: 0.0,
        max: Some(2.0),
        help: "Coarse render radius as a multiple of the visible region; 2 disables the filter",
    },
    Knob {
        flag: "proxy-gpu-budget-bytes",
        label: "Proxy GPU budget (bytes)",
        field: "proxyResidencyBudgetBytes",
        store: KnobStore::Planning,
        value_name: "BYTES",
        integer: true,
        megabytes: false,
        min: 16.0 * MIB,
        max: Some(512.0 * MIB),
        help: "GPU proxy residency budget, in bytes",
    },
    Knob {
        flag: "minimap-lane-offset",
        label: "MINIMAP lane offset",
        field: "minimapLaneOffset",
        store: KnobStore::Planning,
        value_name: "OFFSET",
        integer: true,
        megabytes: false,
        min: 0.0,
        max: Some(5000.0),
        help: "Priority offset of the minimap lane. The canonical order is MINIMAP < DETAIL < PROXY < PREFETCH < COARSE",
    },
    Knob {
        flag: "detail-lane-offset",
        label: "DETAIL lane offset",
        field: "detailLaneOffset",
        store: KnobStore::Planning,
        value_name: "OFFSET",
        integer: true,
        megabytes: false,
        min: 0.0,
        max: Some(5000.0),
        help: "Priority offset of the detail lane",
    },
    Knob {
        flag: "proxy-lane-offset",
        label: "PROXY lane offset",
        field: "proxyLaneOffset",
        store: KnobStore::Planning,
        value_name: "OFFSET",
        integer: true,
        megabytes: false,
        min: 0.0,
        max: Some(5000.0),
        help: "Priority offset of the proxy lane",
    },
    Knob {
        flag: "prefetch-lane-offset",
        label: "PREFETCH lane offset",
        field: "prefetchLaneOffset",
        store: KnobStore::Planning,
        value_name: "OFFSET",
        integer: true,
        megabytes: false,
        min: 0.0,
        max: Some(5000.0),
        help: "Priority offset of the prefetch lane",
    },
    Knob {
        flag: "coarse-lane-offset",
        label: "COARSE lane offset",
        field: "coarseLaneOffset",
        store: KnobStore::Planning,
        value_name: "OFFSET",
        integer: true,
        megabytes: false,
        min: 0.0,
        max: Some(5000.0),
        help: "Priority offset of the coarse lane",
    },
    Knob {
        flag: "main-budget-mb",
        label: "Main budget (MB)",
        field: "mainBudgetBytes",
        store: KnobStore::Cache,
        value_name: "MB",
        integer: true,
        megabytes: true,
        min: 1.0,
        max: None,
        help: "The CPU cache's main store budget, in megabytes. Session-scoped, as in the panel",
    },
    Knob {
        flag: "overview-budget-mb",
        label: "Overview budget (MB)",
        field: "overviewBudgetBytes",
        store: KnobStore::Cache,
        value_name: "MB",
        integer: true,
        megabytes: true,
        min: 1.0,
        max: None,
        help: "The CPU cache's overview store budget, in megabytes. Session-scoped",
    },
    Knob {
        flag: "max-fetches",
        label: "Max fetches",
        field: "maxConcurrentFetches",
        store: KnobStore::Cache,
        value_name: "N",
        integer: true,
        megabytes: false,
        min: 1.0,
        max: None,
        help: "Concurrent fetches the CPU cache allows. Session-scoped",
    },
    Knob {
        flag: "max-in-flight-mb",
        label: "Max in-flight (MB)",
        field: "maxBytesInFlight",
        store: KnobStore::Cache,
        value_name: "MB",
        integer: true,
        megabytes: true,
        min: 1.0,
        max: None,
        help: "Bytes the CPU cache allows in flight at once, in megabytes. Session-scoped",
    },
];

/// The browser-storage key and envelope version of the persisted planning
/// configuration. The page's own constants; a test holds these to them.
pub const PLANNING_STORAGE_KEY: &str = "lucida.planning.config";
pub const PLANNING_SCHEMA_VERSION: u32 = 3;
/// The same for the CPU cache knobs' envelope.
pub const CACHE_STORAGE_KEY: &str = "lucida.cache.config";
pub const CACHE_SCHEMA_VERSION: u32 = 1;

/// The knob by its flag, for a test that has the flag's text.
#[cfg(test)]
pub fn knob_for_flag(flag: &str) -> Option<&'static Knob> {
    KNOBS.iter().find(|knob| knob.flag == flag)
}

/// The knobs one run is given: by store field, in the store's own units, as
/// the page reads them and as the run file's header records them. Empty is
/// the driver's default, which is the page's.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct KnobSettings {
    /// Planning fields, as written to the persisted planning configuration.
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub planning: BTreeMap<String, Value>,
    /// CPU cache fields, in bytes and counts, as written to the cache envelope.
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub cache: BTreeMap<String, Value>,
}

impl KnobSettings {
    pub fn is_empty(&self) -> bool {
        self.planning.is_empty() && self.cache.is_empty()
    }

    fn store(&self, store: KnobStore) -> &BTreeMap<String, Value> {
        match store {
            KnobStore::Planning => &self.planning,
            KnobStore::Cache => &self.cache,
        }
    }

    fn store_mut(&mut self, store: KnobStore) -> &mut BTreeMap<String, Value> {
        match store {
            KnobStore::Planning => &mut self.planning,
            KnobStore::Cache => &mut self.cache,
        }
    }

    /// Set `knob` from the value typed at its flag, in the panel's unit.
    /// Refuses what the panel would refuse, so a value the page would clamp
    /// is an error at the command line rather than a run under a different
    /// value than the one asked for.
    pub fn set(&mut self, knob: &Knob, typed: f64) -> Result<(), String> {
        if !typed.is_finite() {
            return Err(format!("{} is a finite number", knob.label));
        }
        if knob.integer && typed.fract() != 0.0 {
            return Err(format!("{} is a whole number, not {typed}", knob.label));
        }
        if typed < knob.min {
            return Err(format!(
                "{} is at least {}, not {typed}",
                knob.label,
                typed_text(knob.min)
            ));
        }
        if let Some(max) = knob.max
            && typed > max
        {
            return Err(format!(
                "{} is at most {}, not {typed}",
                knob.label,
                typed_text(max)
            ));
        }
        let stored = if knob.megabytes { typed * MIB } else { typed };
        let value = if knob.integer {
            json!(stored as i64)
        } else {
            json!(stored)
        };
        let store = self.store_mut(knob.store);
        if store.contains_key(knob.field) {
            return Err(format!(
                "--{} was given twice for one configuration",
                knob.flag
            ));
        }
        store.insert(knob.field.to_string(), value);
        Ok(())
    }

    /// The script the driver runs in the page before any of the page's own:
    /// each store's envelope, written into browser storage exactly as the
    /// panel writes it, so the page hydrates from it as it starts. None when
    /// nothing was set, and the page is left to its defaults.
    ///
    /// The storage write is guarded because the script also runs on the
    /// blank document the target is created with, whose opaque origin has no
    /// storage to write.
    pub fn new_document_script(&self) -> Option<String> {
        if self.is_empty() {
            return None;
        }
        let mut writes = Vec::new();
        if !self.planning.is_empty() {
            let envelope = json!({
                "schemaVersion": PLANNING_SCHEMA_VERSION,
                "config": self.planning,
            });
            writes.push(format!(
                "localStorage.setItem({}, {});",
                json_string(PLANNING_STORAGE_KEY),
                json_string(&envelope.to_string())
            ));
        }
        if !self.cache.is_empty() {
            let envelope = json!({
                "schemaVersion": CACHE_SCHEMA_VERSION,
                "config": self.cache,
            });
            writes.push(format!(
                "localStorage.setItem({}, {});",
                json_string(CACHE_STORAGE_KEY),
                json_string(&envelope.to_string())
            ));
        }
        Some(format!(
            "(() => {{ try {{ {} }} catch (error) {{ /* no storage on this origin */ }} }})();",
            writes.join(" ")
        ))
    }

    /// Each knob as it was typed, `flag value`, in the panel's units and the
    /// panel's order, for a header line or a side's label. Empty when nothing
    /// was set.
    pub fn describe(&self) -> String {
        let mut parts = Vec::new();
        for knob in KNOBS {
            let Some(stored) = self
                .store(knob.store)
                .get(knob.field)
                .and_then(Value::as_f64)
            else {
                continue;
            };
            let typed = if knob.megabytes { stored / MIB } else { stored };
            parts.push(format!("{} {}", knob.flag, typed_text(typed)));
        }
        parts.join(" · ")
    }
}

/// A number as a person typed it: no trailing `.0` on a whole number.
fn typed_text(value: f64) -> String {
    if value.fract() == 0.0 && value.abs() < 1e15 {
        format!("{}", value as i64)
    } else {
        value.to_string()
    }
}

// ---------------------------------------------------------------------------
// The flags
// ---------------------------------------------------------------------------

/// The knob flags and `--versus`, flattened onto `lucida trace`.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct KnobArgs {
    /// The first configuration: every knob before `--versus`, or every knob when it was not given.
    pub first: KnobSettings,
    /// The second configuration when `--versus` was given: every knob after
    /// it. Empty means the page's defaults, so `--prefetch-depth 0 --versus`
    /// compares a run at depth 0 with one at the default.
    pub versus: Option<KnobSettings>,
}

/// The clap id of `--versus`. The knobs use their store field as their id.
pub const VERSUS: &str = "versus";

impl clap::Args for KnobArgs {
    fn augment_args(cmd: Command) -> Command {
        let mut cmd = cmd.next_help_heading(
            "Dev controls knobs, by the name the panel shows, applied before the page loads",
        );
        for knob in KNOBS {
            cmd = cmd.arg(
                // Appended rather than overwritten, so a knob typed on both
                // sides of --versus keeps both values with their positions.
                Arg::new(knob.field)
                    .long(knob.flag)
                    .value_name(knob.value_name)
                    .action(ArgAction::Append)
                    .value_parser(clap::value_parser!(f64))
                    .help(knob.help),
            );
        }
        cmd.arg(
            // Appended with no value, as the script's --wait is: a counted
            // or set flag reports an index even when absent, and an index
            // here means a second run.
            Arg::new(VERSUS)
                .long(VERSUS)
                .action(ArgAction::Append)
                .num_args(0)
                .default_missing_value(VERSUS)
                .value_parser(clap::value_parser!(String))
                .help(
                    "Run the same script a second time under the knobs after this flag and print \
                     the diff of the two runs. Knobs before it are the first run's; a knob on \
                     neither side is the page's default on both",
                ),
        )
        .next_help_heading(None)
    }

    fn augment_args_for_update(cmd: Command) -> Command {
        Self::augment_args(cmd)
    }
}

impl clap::FromArgMatches for KnobArgs {
    fn from_arg_matches(matches: &ArgMatches) -> Result<Self, clap::Error> {
        let versus_at: Vec<usize> = matches
            .indices_of(VERSUS)
            .map(Iterator::collect)
            .unwrap_or_default();
        if versus_at.len() > 1 {
            return Err(clap::Error::raw(
                clap::error::ErrorKind::ArgumentConflict,
                "--versus was given more than once; a run compares two configurations\n",
            ));
        }
        let split = versus_at.first().copied();
        let mut first = KnobSettings::default();
        let mut second = KnobSettings::default();
        for knob in KNOBS {
            let (Some(values), Some(indices)) = (
                matches.get_many::<f64>(knob.field),
                matches.indices_of(knob.field),
            ) else {
                continue;
            };
            for (value, index) in values.zip(indices) {
                let target = match split {
                    Some(split) if index > split => &mut second,
                    _ => &mut first,
                };
                target.set(knob, *value).map_err(|reason| {
                    clap::Error::raw(
                        clap::error::ErrorKind::ValueValidation,
                        format!("invalid value '{value}' for '--{}': {reason}\n", knob.flag),
                    )
                })?;
            }
        }
        Ok(Self {
            first,
            versus: split.map(|_| second),
        })
    }

    fn update_from_arg_matches(&mut self, matches: &ArgMatches) -> Result<(), clap::Error> {
        *self = Self::from_arg_matches(matches)?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use clap::{Args as _, FromArgMatches as _};
    use std::path::PathBuf;

    fn web_source(relative: &str) -> String {
        let path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("..")
            .join("lucida-web")
            .join("src")
            .join(relative);
        std::fs::read_to_string(&path)
            .unwrap_or_else(|error| panic!("could not read {}: {error}", path.display()))
    }

    /// The panel's label, kebab-cased: the rule the flags are named by.
    fn kebab(label: &str) -> String {
        let mut out = String::new();
        for ch in label.chars() {
            if ch.is_ascii_alphanumeric() {
                out.push(ch.to_ascii_lowercase());
            } else if !out.ends_with('-') {
                out.push('-');
            }
        }
        out.trim_matches('-').to_string()
    }

    /// One knob as the panel's source declares it.
    #[derive(Debug, PartialEq)]
    struct PanelKnob {
        field: String,
        label: String,
        min: Option<f64>,
        max: Option<f64>,
        step: Option<f64>,
        megabytes: Option<bool>,
    }

    /// A number literal or a product of them, as the panel writes `16 * 1024 * 1024`.
    fn literal(text: &str) -> f64 {
        text.split('*')
            .map(|part| {
                part.trim()
                    .parse::<f64>()
                    .unwrap_or_else(|_| panic!("not a number: {text:?}"))
            })
            .product()
    }

    /// The value after `key:` inside one object literal, up to the next comma or brace.
    fn property<'a>(object: &'a str, key: &str) -> Option<&'a str> {
        let start = object.find(&format!("{key}:"))? + key.len() + 1;
        let rest = &object[start..];
        let end = rest.find([',', '}']).unwrap_or(rest.len());
        Some(rest[..end].trim())
    }

    /// Every `{ field: "...", label: "...", ... }` object in the panel's source.
    fn panel_knobs() -> Vec<PanelKnob> {
        let source = web_source("debug/DevControls.tsx");
        let mut knobs = Vec::new();
        let mut rest = source.as_str();
        while let Some(at) = rest.find("field: \"") {
            let object_start = rest[..at].rfind('{').expect("a field inside an object");
            let object_end = at + rest[at..].find('}').expect("the object closes");
            let object = &rest[object_start..=object_end];
            let quoted =
                |key: &str| property(object, key).map(|value| value.trim_matches('"').to_string());
            knobs.push(PanelKnob {
                field: quoted("field").expect("a field"),
                label: quoted("label").expect("a label"),
                min: property(object, "min").map(literal),
                max: property(object, "max").map(literal),
                step: property(object, "step").map(literal),
                megabytes: property(object, "megabytes").map(|value| value == "true"),
            });
            rest = &rest[object_end..];
        }
        knobs
    }

    /// The acceptance criterion: every knob the panel shows is settable by
    /// the name the panel shows, and nothing is settable that the panel
    /// does not show. Read from the panel's own source, so a knob added to
    /// the panel fails here until the driver gains it.
    #[test]
    fn every_panel_knob_is_a_flag_named_by_its_label_and_nothing_else_is() {
        let panel = panel_knobs();
        assert!(
            panel.len() >= 16,
            "the panel declares {} knobs",
            panel.len()
        );

        for shown in &panel {
            let knob = KNOBS
                .iter()
                .find(|knob| knob.field == shown.field)
                .unwrap_or_else(|| {
                    panic!("the panel shows {:?}, which the driver cannot set", shown)
                });
            assert_eq!(knob.label, shown.label, "{}", shown.field);
            assert_eq!(knob.flag, kebab(&shown.label), "{}", shown.field);
            // The panel declares `megabytes` only on its cache rows; a row
            // without it is a planning slider.
            match shown.megabytes {
                None => {
                    assert_eq!(knob.store, KnobStore::Planning, "{}", shown.field);
                    assert!(!knob.megabytes, "{}", shown.field);
                    assert_eq!(Some(knob.min), shown.min, "{} min", shown.field);
                    assert_eq!(knob.max, shown.max, "{} max", shown.field);
                    let step = shown.step.expect("a slider has a step");
                    assert_eq!(
                        knob.integer,
                        step.fract() == 0.0,
                        "{} step {step}",
                        shown.field
                    );
                }
                Some(megabytes) => {
                    assert_eq!(knob.store, KnobStore::Cache, "{}", shown.field);
                    assert_eq!(knob.megabytes, megabytes, "{}", shown.field);
                    assert!(knob.integer, "{}", shown.field);
                    assert_eq!(knob.min, 1.0, "{}", shown.field);
                    assert_eq!(knob.max, None, "{}", shown.field);
                }
            }
        }
        for knob in KNOBS {
            assert!(
                panel.iter().any(|shown| shown.field == knob.field),
                "the driver sets {}, which the panel does not show",
                knob.field
            );
        }
    }

    /// The envelopes are read by the page's own constants, and a version bump
    /// on either side has to be met here.
    #[test]
    fn the_store_keys_and_versions_are_the_pages() {
        let planning = web_source("pipeline/planning/configStore.ts");
        assert!(
            planning.contains(&format!("const STORAGE_KEY = \"{PLANNING_STORAGE_KEY}\";")),
            "the page's planning storage key moved"
        );
        assert!(
            planning.contains(&format!(
                "const SCHEMA_VERSION = {PLANNING_SCHEMA_VERSION};"
            )),
            "the page's planning schema version moved"
        );
        let cache = web_source("pipeline/fetch/cacheKnobs.ts");
        assert!(
            cache.contains(&format!(
                "const CACHE_KNOBS_STORAGE_KEY = \"{CACHE_STORAGE_KEY}\";"
            )),
            "the page's cache knobs storage key moved"
        );
        assert!(
            cache.contains(&format!(
                "const CACHE_KNOBS_SCHEMA_VERSION = {CACHE_SCHEMA_VERSION};"
            )),
            "the page's cache knobs schema version moved"
        );
        // The page reads only the fields its own list names.
        for knob in KNOBS.iter().filter(|knob| knob.store == KnobStore::Cache) {
            assert!(
                cache.contains(&format!("\"{}\",", knob.field)),
                "the page's cache knob list does not name {}",
                knob.field
            );
        }
    }

    #[test]
    fn a_value_the_panel_would_refuse_is_an_error() {
        let prefetch = knob_for_flag("prefetch-depth").unwrap();
        let mut settings = KnobSettings::default();
        assert!(
            settings
                .set(prefetch, 6.0)
                .unwrap_err()
                .contains("at most 5")
        );
        assert!(
            settings
                .set(prefetch, 1.5)
                .unwrap_err()
                .contains("whole number")
        );
        assert!(
            settings
                .set(prefetch, -1.0)
                .unwrap_err()
                .contains("at least 0")
        );
        assert!(
            settings
                .set(prefetch, f64::NAN)
                .unwrap_err()
                .contains("finite")
        );
        settings.set(prefetch, 0.0).unwrap();
        assert!(
            settings
                .set(prefetch, 2.0)
                .unwrap_err()
                .contains("given twice")
        );

        let fetches = knob_for_flag("max-fetches").unwrap();
        assert!(
            settings
                .set(fetches, 0.0)
                .unwrap_err()
                .contains("at least 1")
        );
        settings.set(fetches, 4.0).unwrap();

        let radius = knob_for_flag("detail-render-radius-view").unwrap();
        settings.set(radius, 0.35).unwrap();
        assert_eq!(settings.planning["prefetchDepth"], json!(0));
        assert_eq!(settings.planning["detailRenderRadiusView"], json!(0.35));
        assert_eq!(settings.cache["maxConcurrentFetches"], json!(4));
    }

    #[test]
    fn a_megabyte_knob_is_stored_in_bytes_and_described_in_megabytes() {
        let mut settings = KnobSettings::default();
        settings
            .set(knob_for_flag("main-budget-mb").unwrap(), 256.0)
            .unwrap();
        settings
            .set(knob_for_flag("prefetch-depth").unwrap(), 0.0)
            .unwrap();
        assert_eq!(settings.cache["mainBudgetBytes"], json!(268_435_456));
        assert_eq!(settings.describe(), "prefetch-depth 0 · main-budget-mb 256");
        assert_eq!(KnobSettings::default().describe(), "");
    }

    /// The script writes each store's envelope in the shape the page's store
    /// hydrates from, and nothing when nothing was set.
    #[test]
    fn the_new_document_script_writes_the_envelopes_the_page_reads() {
        assert_eq!(KnobSettings::default().new_document_script(), None);

        let mut settings = KnobSettings::default();
        settings
            .set(knob_for_flag("prefetch-depth").unwrap(), 0.0)
            .unwrap();
        let script = settings.new_document_script().unwrap();
        assert!(script.contains("localStorage.setItem(\"lucida.planning.config\", "));
        // The envelope rides as a JSON string literal, quotes escaped.
        assert!(script.contains(r#"\"schemaVersion\":3"#), "{script}");
        assert!(
            script.contains(r#"\"config\":{\"prefetchDepth\":0}"#),
            "{script}"
        );
        assert!(!script.contains("lucida.cache.config"));
        assert!(script.starts_with("(() => { try {"));

        settings
            .set(knob_for_flag("max-fetches").unwrap(), 2.0)
            .unwrap();
        let script = settings.new_document_script().unwrap();
        assert!(script.contains("localStorage.setItem(\"lucida.cache.config\", "));
        assert!(script.contains(r#"\"schemaVersion\":1"#), "{script}");
        assert!(
            script.contains(r#"\"config\":{\"maxConcurrentFetches\":2}"#),
            "{script}"
        );
    }

    fn parse(args: &[&str]) -> Result<KnobArgs, clap::Error> {
        let command = KnobArgs::augment_args(Command::new("trace"));
        let matches =
            command.try_get_matches_from(std::iter::once("trace").chain(args.iter().copied()))?;
        KnobArgs::from_arg_matches(&matches)
    }

    #[test]
    fn knobs_before_versus_are_the_first_configuration_and_after_it_the_second() {
        let args = parse(&[
            "--prefetch-depth",
            "0",
            "--main-budget-mb",
            "128",
            "--versus",
            "--prefetch-depth",
            "3",
            "--max-fetches",
            "2",
        ])
        .unwrap();
        assert_eq!(args.first.planning["prefetchDepth"], json!(0));
        assert_eq!(
            args.first.cache["mainBudgetBytes"],
            json!(128 * 1024 * 1024)
        );
        assert!(!args.first.cache.contains_key("maxConcurrentFetches"));
        let second = args.versus.unwrap();
        assert_eq!(second.planning["prefetchDepth"], json!(3));
        assert_eq!(second.cache["maxConcurrentFetches"], json!(2));
        assert!(!second.cache.contains_key("mainBudgetBytes"));
    }

    #[test]
    fn versus_alone_compares_against_the_defaults_and_no_versus_is_one_run() {
        let against_defaults = parse(&["--prefetch-depth", "0", "--versus"]).unwrap();
        assert_eq!(against_defaults.versus, Some(KnobSettings::default()));

        let defaults_against = parse(&["--versus", "--prefetch-depth", "0"]).unwrap();
        assert!(defaults_against.first.is_empty());
        assert_eq!(
            defaults_against.versus.unwrap().planning["prefetchDepth"],
            json!(0)
        );

        let one = parse(&["--prefetch-depth", "0"]).unwrap();
        assert_eq!(one.versus, None);
        assert!(parse(&[]).unwrap().first.is_empty());
    }

    #[test]
    fn a_knob_twice_on_one_side_and_versus_twice_are_errors() {
        let twice = parse(&["--prefetch-depth", "0", "--prefetch-depth", "1"]).unwrap_err();
        assert!(twice.to_string().contains("given twice"), "{twice}");
        // The same knob on each side is the experiment, not a repeat.
        assert!(parse(&["--prefetch-depth", "0", "--versus", "--prefetch-depth", "1"]).is_ok());
        let versus_twice = parse(&["--versus", "--versus"]).unwrap_err();
        assert!(
            versus_twice.to_string().contains("more than once"),
            "{versus_twice}"
        );
        let out_of_range = parse(&["--prefetch-depth", "9"]).unwrap_err();
        assert!(
            out_of_range.to_string().contains("at most 5"),
            "{out_of_range}"
        );
    }
}
