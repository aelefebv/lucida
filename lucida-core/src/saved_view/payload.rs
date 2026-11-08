//! A saved view as a URL's `#view=` fragment carries it: defaults left out,
//! then JSON, gzip and base64url without padding. The web viewer, the CLI and
//! the Python client all encode and decode here, so one view makes one
//! payload whichever of them wrote it.
//!
//! Leaving defaults out keeps a link to a collection of hundreds of members
//! under a kilobyte, because default channel settings repeat in every layer.
//! It also means a payload's meaning depends on the defaults it was written
//! against, so those are frozen per version ([`WireDefaults`]) and never read
//! from the policy that seeds a new view.
//!
//! The codec works on JSON rather than on [`SavedView`]: a field this build
//! does not know rides through untouched, and a version 1 view keeps its
//! scene-wide channel mode for the scene to resolve against each layer's real
//! channel count.

use std::fmt;
use std::io::{Read, Write};

use base64::Engine;
use base64::engine::{DecodePaddingMode, GeneralPurpose, GeneralPurposeConfig};
use flate2::Compression;
use flate2::read::GzDecoder;
use flate2::write::GzEncoder;
use serde_json::{Map, Number, Value};

#[cfg(target_arch = "wasm32")]
use wasm_bindgen::prelude::*;

use super::{SAVED_VIEW_VERSION, SavedView};

/// Why a payload could not be encoded or decoded.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PayloadError(String);

impl fmt::Display for PayloadError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.0)
    }
}

impl std::error::Error for PayloadError {}

/// A default a payload leaves out.
#[derive(Clone, Copy)]
enum Scalar {
    Bool(bool),
    Number(f64),
    Str(&'static str),
}

impl Scalar {
    fn matches(self, value: &Value) -> bool {
        match (self, value) {
            (Scalar::Bool(b), Value::Bool(v)) => b == *v,
            (Scalar::Number(n), Value::Number(v)) => v.as_f64() == Some(n),
            (Scalar::Str(s), Value::String(v)) => s == v,
            _ => false,
        }
    }

    fn to_value(self) -> Value {
        match self {
            Scalar::Bool(b) => Value::Bool(b),
            Scalar::Number(n) => Number::from_f64(n).map_or(Value::Null, Value::Number),
            Scalar::Str(s) => Value::String(s.to_string()),
        }
    }
}

type Fields = &'static [(&'static str, Scalar)];

/// The values a payload of one version leaves out.
///
/// Frozen once any payload has been written under it: changing a value here
/// changes how every payload that left it out restores. A new view may open
/// with other values, such as a one-channel image in gray; those differ from
/// this table, so the payload carries them.
struct WireDefaults {
    /// `view.c` and `view.multi_channel` as a payload left them out, for a
    /// version whose views chose their channels scene-wide.
    legacy_channels: Option<(u32, bool)>,
    z_range: (u32, u32),
    t: u32,
    display: Fields,
    layer: Fields,
    channel: Fields,
    /// A channel's colormap by its index, cycling.
    channel_colormaps: &'static [&'static str],
}

const WINDOW: Fields = &[
    ("contrast_min", Scalar::Number(0.0)),
    ("contrast_max", Scalar::Number(65535.0)),
    ("gamma", Scalar::Number(1.0)),
];

const V1: WireDefaults = WireDefaults {
    legacy_channels: Some((0, false)),
    z_range: (0, 1),
    t: 0,
    display: WINDOW,
    layer: &[
        ("visible", Scalar::Bool(true)),
        ("opacity", Scalar::Number(1.0)),
        ("contrast_min", Scalar::Number(0.0)),
        ("contrast_max", Scalar::Number(65535.0)),
        ("gamma", Scalar::Number(1.0)),
        ("blend_mode", Scalar::Str("alpha")),
        ("render_mode", Scalar::Str("translucent")),
        ("channel_blend_mode", Scalar::Str("additive")),
    ],
    channel: &[
        ("visible", Scalar::Bool(true)),
        ("contrast_min", Scalar::Number(0.0)),
        ("contrast_max", Scalar::Number(65535.0)),
        ("gamma", Scalar::Number(1.0)),
    ],
    channel_colormaps: &["magenta", "green", "cyan"],
};

/// Version 2 moved solo onto each layer, so a view has no scene-wide channel
/// to leave out.
const V2: WireDefaults = WireDefaults {
    legacy_channels: None,
    ..V1
};

fn wire_defaults(version: f64) -> &'static WireDefaults {
    // A newer sender's payload is read best-effort with the newest table.
    if version < 2.0 { &V1 } else { &V2 }
}

/// Encode `view`, a [`SavedView`] as JSON, into a `#view=` payload.
///
/// The payload is always written as [`SAVED_VIEW_VERSION`], since that
/// version's defaults are the ones it leaves out. A view of an older version
/// is first read under its own defaults, so it keeps its meaning.
pub fn encode_payload(view: &Value) -> Result<String, PayloadError> {
    let mut view = view.clone();
    let object = view
        .as_object_mut()
        .ok_or_else(|| PayloadError("a saved view must be an object".into()))?;
    restore(object, wire_defaults(version(object)?));
    strip(object, wire_defaults(SAVED_VIEW_VERSION as f64));
    object.insert("v".into(), SAVED_VIEW_VERSION.into());
    canonicalize_numbers(&mut view);

    let json = serde_json::to_vec(&view).map_err(|e| PayloadError(e.to_string()))?;
    let mut gz = GzEncoder::new(Vec::new(), Compression::default());
    gz.write_all(&json)
        .map_err(|e| PayloadError(format!("gzip failed: {e}")))?;
    let bytes = gz
        .finish()
        .map_err(|e| PayloadError(format!("gzip failed: {e}")))?;
    Ok(base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(bytes))
}

/// Past this a payload is refused rather than inflated: no view comes near
/// it, and a small payload can otherwise inflate without bound.
const MAX_JSON_BYTES: u64 = 8 << 20;

/// Decode a `#view=` payload into a [`SavedView`] as JSON, with every default
/// it left out filled back in under its own version's defaults.
pub fn decode_payload(payload: &str) -> Result<Value, PayloadError> {
    if payload.is_empty() {
        return Err(PayloadError("empty payload".into()));
    }
    // Padding is optional so a payload that gained it in transit still reads.
    const URL_SAFE_ANY_PAD: GeneralPurpose = GeneralPurpose::new(
        &base64::alphabet::URL_SAFE,
        GeneralPurposeConfig::new().with_decode_padding_mode(DecodePaddingMode::Indifferent),
    );
    let bytes = URL_SAFE_ANY_PAD
        .decode(payload)
        .map_err(|e| PayloadError(format!("base64url decode failed: {e}")))?;
    let mut json = Vec::new();
    GzDecoder::new(bytes.as_slice())
        .take(MAX_JSON_BYTES + 1)
        .read_to_end(&mut json)
        .map_err(|e| PayloadError(format!("gunzip failed: {e}")))?;
    if json.len() as u64 > MAX_JSON_BYTES {
        return Err(PayloadError(format!(
            "payload inflates past {MAX_JSON_BYTES} bytes"
        )));
    }
    let mut view: Value = serde_json::from_slice(&json)
        .map_err(|e| PayloadError(format!("JSON parse failed: {e}")))?;
    let object = view
        .as_object_mut()
        .ok_or_else(|| PayloadError("payload must be an object".into()))?;
    restore(object, wire_defaults(version(object)?));
    canonicalize_numbers(&mut view);
    Ok(view)
}

impl SavedView {
    /// This view as a `#view=` payload.
    pub fn to_payload(&self) -> String {
        // Through a string, not `to_value`, so an `f32` keeps its shortest
        // digits instead of widening to `f64` ones.
        let json = serde_json::to_string(self).expect("a saved view serializes");
        let mut value: Value = serde_json::from_str(&json).expect("a saved view is JSON");
        // Deserializing moved any scene-wide channel mode onto the layers,
        // so the view is in the current form whatever `v` it was read from.
        value["v"] = SAVED_VIEW_VERSION.into();
        encode_payload(&value).expect("a serialized saved view is an object with a version")
    }
}

/// The view's `v`, which must be a positive number.
fn version(object: &Map<String, Value>) -> Result<f64, PayloadError> {
    match object.get("v").and_then(Value::as_f64) {
        Some(v) if v.is_finite() && v > 0.0 => Ok(v),
        _ => Err(PayloadError(format!(
            "missing or invalid version (got {})",
            object
                .get("v")
                .map_or("nothing".to_string(), Value::to_string)
        ))),
    }
}

fn restore(view: &mut Map<String, Value>, defaults: &WireDefaults) {
    for key in ["datasets", "dataset_order"] {
        fill(view, key, Value::Array(Vec::new()));
    }
    fill(view, "active_layouts", Value::Object(Map::new()));

    let selectors = object_at(view, "view");
    let (start, end) = defaults.z_range;
    fill(
        selectors,
        "z_range",
        serde_json::json!({ "start": start, "end": end }),
    );
    fill(selectors, "t", defaults.t.into());
    if let Some((c, multi_channel)) = defaults.legacy_channels {
        fill(selectors, "c", c.into());
        fill(selectors, "multi_channel", multi_channel.into());
    }

    fill_fields(object_at(view, "display"), defaults.display);

    let layers = object_at(view, "dataset_settings");
    for layer in layers.values_mut() {
        if !layer.is_object() {
            *layer = Value::Object(Map::new());
        }
        let layer = layer.as_object_mut().expect("made an object above");
        fill_fields(layer, defaults.layer);
        for key in ["detail_level_override", "solo"] {
            if layer.get(key).is_some_and(|v| !v.is_number()) {
                layer.remove(key);
            }
        }
        let channels = layer
            .entry("channel_settings")
            .or_insert_with(|| Value::Array(Vec::new()));
        if let Value::Array(channels) = channels {
            for (index, channel) in channels.iter_mut().enumerate() {
                if !channel.is_object() {
                    *channel = Value::Object(Map::new());
                }
                let channel = channel.as_object_mut().expect("made an object above");
                fill_fields(channel, defaults.channel);
                fill(channel, "colormap", colormap_for(defaults, index).into());
            }
        }
    }
}

fn strip(view: &mut Map<String, Value>, defaults: &WireDefaults) {
    for key in ["datasets", "dataset_order", "active_layouts"] {
        if view.get(key).is_some_and(is_empty_collection) {
            view.remove(key);
        }
    }

    if let Some(Value::Object(selectors)) = view.get_mut("view") {
        let (start, end) = defaults.z_range;
        let default_range = selectors.get("z_range").is_some_and(|range| {
            range.get("start").and_then(Value::as_f64) == Some(start as f64)
                && range.get("end").and_then(Value::as_f64) == Some(end as f64)
        });
        if default_range {
            selectors.remove("z_range");
        }
        if selectors.get("t").and_then(Value::as_f64) == Some(defaults.t as f64) {
            selectors.remove("t");
        }
        // `c` and `multi_channel` stay whatever they are: only a version 1
        // payload could leave them out, and this one is written as current.
    }
    remove_if_empty(view, "view");

    if let Some(Value::Object(display)) = view.get_mut("display") {
        strip_fields(display, defaults.display);
    }
    remove_if_empty(view, "display");

    if let Some(Value::Object(layers)) = view.get_mut("dataset_settings") {
        // Every layer stays, as `{}` when all default: its entry is what
        // says the view styles it, and its channel count is structural.
        for layer in layers.values_mut() {
            let Some(layer) = layer.as_object_mut() else {
                continue;
            };
            strip_fields(layer, defaults.layer);
            for key in ["detail_level_override", "solo"] {
                if layer.get(key).is_some_and(Value::is_null) {
                    layer.remove(key);
                }
            }
            if let Some(Value::Array(channels)) = layer.get_mut("channel_settings") {
                for (index, channel) in channels.iter_mut().enumerate() {
                    let Some(channel) = channel.as_object_mut() else {
                        continue;
                    };
                    strip_fields(channel, defaults.channel);
                    let colormap = colormap_for(defaults, index);
                    if channel.get("colormap").and_then(Value::as_str) == Some(colormap) {
                        channel.remove("colormap");
                    }
                }
            }
            if layer
                .get("channel_settings")
                .is_some_and(is_empty_collection)
            {
                layer.remove("channel_settings");
            }
        }
    }
    remove_if_empty(view, "dataset_settings");

    // A dataset the map leaves out keeps auto-contrast on.
    if let Some(Value::Object(auto_contrast)) = view.get_mut("auto_contrast") {
        auto_contrast.retain(|_, on| on != &Value::Bool(true));
    }
    remove_if_empty(view, "auto_contrast");
}

fn colormap_for(defaults: &WireDefaults, index: usize) -> &'static str {
    defaults.channel_colormaps[index % defaults.channel_colormaps.len()]
}

/// The object at `key`, made one if it is missing or something else.
fn object_at<'a>(map: &'a mut Map<String, Value>, key: &str) -> &'a mut Map<String, Value> {
    let slot = map.entry(key).or_insert_with(|| Value::Object(Map::new()));
    if !slot.is_object() {
        *slot = Value::Object(Map::new());
    }
    slot.as_object_mut().expect("made an object above")
}

/// Set `key` to `value` when it is missing or null.
fn fill(map: &mut Map<String, Value>, key: &str, value: Value) {
    if map.get(key).is_none_or(Value::is_null) {
        map.insert(key.to_string(), value);
    }
}

fn fill_fields(map: &mut Map<String, Value>, fields: Fields) {
    for &(key, default) in fields {
        fill(map, key, default.to_value());
    }
}

fn strip_fields(map: &mut Map<String, Value>, fields: Fields) {
    for &(key, default) in fields {
        if map.get(key).is_some_and(|value| default.matches(value)) {
            map.remove(key);
        }
    }
}

fn is_empty_collection(value: &Value) -> bool {
    match value {
        Value::Array(items) => items.is_empty(),
        Value::Object(entries) => entries.is_empty(),
        _ => false,
    }
}

fn remove_if_empty(map: &mut Map<String, Value>, key: &str) {
    if map.get(key).is_some_and(is_empty_collection) {
        map.remove(key);
    }
}

/// Write every whole number as an integer, so a view serialized by Rust
/// (`1.0`) and by a browser (`1`) makes the same payload.
fn canonicalize_numbers(value: &mut Value) {
    const MAX_EXACT: f64 = 9_007_199_254_740_992.0;
    match value {
        Value::Number(n) => {
            if n.is_f64()
                && let Some(f) = n.as_f64()
                && f.fract() == 0.0
                && f.abs() <= MAX_EXACT
            {
                *n = Number::from(f as i64);
            }
        }
        Value::Array(items) => items.iter_mut().for_each(canonicalize_numbers),
        Value::Object(entries) => entries.values_mut().for_each(canonicalize_numbers),
        _ => {}
    }
}

/// [`encode_payload`] for the web viewer, which hands the view over as JSON.
#[cfg(target_arch = "wasm32")]
#[wasm_bindgen]
pub fn encode_view_payload(view_json: &str) -> Result<String, JsError> {
    let view: Value = serde_json::from_str(view_json)?;
    encode_payload(&view).map_err(|e| JsError::new(&e.to_string()))
}

/// [`decode_payload`] for the web viewer, returning the view as JSON.
#[cfg(target_arch = "wasm32")]
#[wasm_bindgen]
pub fn decode_view_payload(payload: &str) -> Result<String, JsError> {
    let view = decode_payload(payload).map_err(|e| JsError::new(&e.to_string()))?;
    Ok(view.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::scene::{ChannelSettings, Colormap, DatasetDisplaySettings};
    use lucida_content::DatasetId;
    use serde_json::json;

    fn gzip_base64(json: &str) -> String {
        let mut gz = GzEncoder::new(Vec::new(), Compression::default());
        gz.write_all(json.as_bytes()).unwrap();
        base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(gz.finish().unwrap())
    }

    fn inflate(payload: &str) -> Value {
        let bytes = base64::engine::general_purpose::URL_SAFE_NO_PAD
            .decode(payload)
            .unwrap();
        let mut json = String::new();
        GzDecoder::new(bytes.as_slice())
            .read_to_string(&mut json)
            .unwrap();
        serde_json::from_str(&json).unwrap()
    }

    fn layer(channels: Vec<ChannelSettings>) -> DatasetDisplaySettings {
        DatasetDisplaySettings {
            channel_settings: channels,
            ..Default::default()
        }
    }

    fn channel(colormap: Colormap) -> ChannelSettings {
        ChannelSettings {
            colormap,
            ..Default::default()
        }
    }

    fn view_with(layers: &[(&str, DatasetDisplaySettings)]) -> SavedView {
        let mut view = SavedView::empty([800, 600]);
        for (id, settings) in layers {
            view.dataset_order.push(DatasetId((*id).into()));
            view.dataset_settings
                .insert(DatasetId((*id).into()), settings.clone());
        }
        view
    }

    fn decoded(payload: &str) -> SavedView {
        serde_json::from_value(decode_payload(payload).unwrap()).unwrap()
    }

    #[test]
    fn a_view_round_trips() {
        let mut view = view_with(&[
            ("one", layer(vec![channel(Colormap::Gray)])),
            (
                "three",
                layer(vec![
                    channel(Colormap::Magenta),
                    channel(Colormap::Green),
                    channel(Colormap::Yellow),
                ]),
            ),
        ]);
        view.view.set_z_range(3..9);
        view.view.t = 2;
        view.display.gamma = 0.8;
        view.dataset_settings[0].opacity = 0.3;
        view.dataset_settings[1].solo = Some(2);
        view.dataset_settings[1].detail_level_override = Some(0);
        view.dataset_settings[1].channel_settings[1].name = Some("Region B".into());
        view.auto_contrast.insert(DatasetId("one".into()), false);

        let payload = view.to_payload();
        assert_eq!(decoded(&payload), view);
        assert_eq!(decoded(&payload).to_payload(), payload);
    }

    #[test]
    fn defaults_are_left_out_and_a_one_channel_gray_is_not() {
        let view = view_with(&[
            ("one", layer(vec![channel(Colormap::Gray)])),
            (
                "three",
                layer(
                    (0..3)
                        .map(|i| channel(Colormap::default_for_channel(i, 3)))
                        .collect(),
                ),
            ),
        ]);
        let wire = inflate(&view.to_payload());
        assert_eq!(
            wire,
            json!({
                "v": SAVED_VIEW_VERSION,
                "camera": {"mode": "slice", "center": [0, 0], "zoom": 1, "viewport": [800, 600], "framing": "unframed"},
                "dataset_order": ["one", "three"],
                "dataset_settings": {
                    "one": {"channel_settings": [{"colormap": "gray"}], "label_settings": []},
                    "three": {"channel_settings": [{}, {}, {}], "label_settings": []},
                },
            })
        );
    }

    #[test]
    fn a_payload_that_left_out_a_magenta_channel_still_restores_magenta() {
        let payload = gzip_base64(
            r#"{"v":2,"camera":{"mode":"slice","center":[0,0],"zoom":1,"viewport":[8,6]},"dataset_settings":{"one":{"channel_settings":[{}]}}}"#,
        );
        let view = decoded(&payload);
        let channels = &view.dataset_settings[&DatasetId("one".into())].channel_settings;
        assert_eq!(channels[0].colormap, Colormap::Magenta);
    }

    #[test]
    fn a_version_1_payload_keeps_its_scene_wide_channel_when_re_encoded() {
        let payload = gzip_base64(
            r#"{"v":1,"camera":{"mode":"slice","center":[0,0],"zoom":1,"viewport":[8,6]}}"#,
        );
        let view = decode_payload(&payload).unwrap();
        assert_eq!(view["view"]["c"], json!(0));
        assert_eq!(view["view"]["multi_channel"], json!(false));

        let again = encode_payload(&view).unwrap();
        let wire = inflate(&again);
        assert_eq!(wire["v"], json!(SAVED_VIEW_VERSION));
        assert_eq!(wire["view"], json!({"c": 0, "multi_channel": false}));
        assert_eq!(decode_payload(&again).unwrap()["view"], view["view"]);
    }

    #[test]
    fn a_typed_view_read_from_version_1_encodes_as_current() {
        let json = r#"{"v":1,"camera":{"mode":"slice","center":[0,0],"zoom":1,"viewport":[8,6]},"view":{"z_range":{"start":0,"end":1},"t":0,"c":1,"multi_channel":false},"display":{"contrast_min":0,"contrast_max":65535,"gamma":1},"dataset_settings":{"a":{"visible":true,"opacity":1,"contrast_min":0,"contrast_max":65535,"gamma":1,"blend_mode":"alpha","channel_settings":[{"visible":true,"colormap":"magenta","contrast_min":0,"contrast_max":65535,"gamma":1},{"visible":true,"colormap":"green","contrast_min":0,"contrast_max":65535,"gamma":1}]}}}"#;
        let view: SavedView = serde_json::from_str(json).unwrap();
        let back = decoded(&view.to_payload());
        assert_eq!(back.v, SAVED_VIEW_VERSION);
        assert_eq!(back.view.legacy_channels(), None);
        assert_eq!(back.dataset_settings[0].solo, Some(1));
    }

    #[test]
    fn a_field_this_build_does_not_know_rides_through() {
        let view = json!({
            "v": SAVED_VIEW_VERSION,
            "camera": {"mode": "slice", "center": [0, 0], "zoom": 1, "viewport": [8, 6]},
            "later": {"x": 1},
            "dataset_settings": {"a": {"later": true, "channel_settings": [{"later": 2}]}},
        });
        let back = decode_payload(&encode_payload(&view).unwrap()).unwrap();
        assert_eq!(back["later"], json!({"x": 1}));
        assert_eq!(back["dataset_settings"]["a"]["later"], json!(true));
        assert_eq!(
            back["dataset_settings"]["a"]["channel_settings"][0]["later"],
            json!(2)
        );
    }

    #[test]
    fn a_browser_and_rust_serialization_make_one_payload() {
        let view = view_with(&[("one", layer(vec![channel(Colormap::Gray)]))]);
        let from_browser = json!({
            "v": 2,
            "datasets": [],
            "active_layouts": {},
            "camera": {"mode": "slice", "center": [0, 0], "zoom": 1, "viewport": [800, 600], "framing": "unframed"},
            "view": {"z_range": {"start": 0, "end": 1}, "t": 0},
            "display": {"contrast_min": 0, "contrast_max": 65535, "gamma": 1},
            "dataset_order": ["one"],
            "dataset_settings": {"one": {
                "visible": true, "opacity": 1, "contrast_min": 0, "contrast_max": 65535,
                "gamma": 1, "blend_mode": "alpha", "render_mode": "translucent",
                "channel_blend_mode": "additive", "label_settings": [],
                "channel_settings": [{"visible": true, "colormap": "gray", "contrast_min": 0, "contrast_max": 65535, "gamma": 1}],
            }},
        });
        assert_eq!(encode_payload(&from_browser).unwrap(), view.to_payload());
    }

    #[test]
    fn a_payload_without_a_version_is_refused() {
        for json in [r#"{"camera":{}}"#, r#"{"v":0,"camera":{}}"#, "[]"] {
            assert!(decode_payload(&gzip_base64(json)).is_err(), "{json}");
        }
        assert!(decode_payload("").is_err());
        assert!(decode_payload("not!!valid").is_err());
        assert!(encode_payload(&json!({"camera": {}})).is_err());
    }

    #[test]
    fn a_newer_version_reads_best_effort() {
        let payload = gzip_base64(
            r#"{"v":99,"camera":{"mode":"slice","center":[0,0],"zoom":1,"viewport":[8,6]}}"#,
        );
        let view = decode_payload(&payload).unwrap();
        assert_eq!(view["v"], json!(99));
        assert!(view["view"].get("c").is_none());
    }

    #[test]
    fn padding_is_optional() {
        let payload = SavedView::empty([8, 6]).to_payload();
        let padded = format!("{payload}{}", "=".repeat((4 - payload.len() % 4) % 4));
        assert_eq!(
            decode_payload(&padded).unwrap(),
            decode_payload(&payload).unwrap()
        );
    }

    #[test]
    fn a_payload_that_inflates_too_far_is_refused() {
        let mut gz = GzEncoder::new(Vec::new(), Compression::best());
        gz.write_all(b"[").unwrap();
        gz.write_all(&vec![b' '; MAX_JSON_BYTES as usize]).unwrap();
        gz.write_all(b"]").unwrap();
        let payload = base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(gz.finish().unwrap());
        let error = decode_payload(&payload).unwrap_err();
        assert!(error.to_string().contains("inflates"), "{error}");
    }

    #[test]
    fn every_float_survives_bit_for_bit() {
        let mut view = SavedView::empty([800, 600]);
        let mut arcball = crate::camera::Arcball::new([800, 600]);
        arcball.theta = 1.2853981633974483;
        arcball.far = 2.8834740896113678;
        arcball.target = [0.1 + 0.2, -1e-300, 123456.78901234567];
        view.camera = crate::camera::Camera::Arcball(arcball.clone());
        let back = decoded(&view.to_payload());
        let crate::camera::Camera::Arcball(back) = back.camera else {
            panic!("expected an arcball camera");
        };
        assert_eq!(back.theta.to_bits(), arcball.theta.to_bits());
        assert_eq!(back.far.to_bits(), arcball.far.to_bits());
        for (a, b) in back.target.iter().zip(arcball.target) {
            assert_eq!(a.to_bits(), b.to_bits());
        }
    }
}
