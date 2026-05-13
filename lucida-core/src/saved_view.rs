//! Capture record for the URL-as-app-state saved-views feature
//! (see `wiki/decisions/0013-url-as-app-state-for-saved-views.md`).
//!
//! `SavedView` spans both tiers of the [[document-vs-viewport-split]]: the
//! `datasets` + `active_layouts` fields are the document-state surface (what
//! is loaded), and `camera` + `view` + `display` + `dataset_order` +
//! `dataset_settings` mirror the [`PresenceState`] surface (how it's being
//! looked at). Slice 1 of #454 carries it inline in the URL hash; slice 2
//! will store the same record server-side, addressed by an opaque ID.
//!
//! The schema is a wire format: every field that doesn't always serialize is
//! marked `#[serde(default)]` so a recipient on an older `v: 1` codepath can
//! tolerate later additive evolution. The `v` field is the version gate —
//! `v: 1` is the only spec covered by this slice; the encoder rejects
//! unknown major versions; future bumps (`v: 2`+) require an explicit
//! migration story.
//!
//! Tests at the bottom of this file lock the wire format. Don't touch them
//! casually — see [[gotchas/scene-document-state-json-compat]].
//
// `blake3` is a small dep that already lives in the workspace via
// `lucida-server`. Lifting the URL-derivation here means the WASM bundle
// can compute `dataset_id_for_url(url)` directly so `lucida-web` doesn't
// need a parallel JS implementation.

use std::collections::HashMap;

use serde::{Deserialize, Serialize};

use lucida_content::{DatasetId, LayoutId};

use crate::camera::Camera;
use crate::scene::{DatasetDisplaySettings, DisplayState};
use crate::view::ViewState;

/// Schema version of the [`SavedView`] wire format. Slice 1 of PRD #454
/// emits and accepts only this version. Recipients that see a higher
/// version should best-effort apply known fields and surface a warning;
/// recipients that see a missing/zero version should reject.
pub const SAVED_VIEW_VERSION: u32 = 1;

/// Capture record for a "saved view" — the user's complete view of one or
/// more datasets at a moment in time. Encoded into the URL hash by
/// [[lucida-web]]; consumed by the apply orchestrator on page load /
/// `popstate`.
///
/// Crosses the document/viewport split:
///
/// - `datasets`, `active_layouts` mirror [[scene-state-and-epochs]]
///   document state (what is loaded; which layout is active).
/// - `camera`, `view`, `display`, `dataset_order`, `dataset_settings`
///   mirror [[presence-and-follow-mode]]'s `PresenceState` surface
///   (where the camera is, which slice, contrast, per-dataset display).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SavedView {
    /// Schema version. Always [`SAVED_VIEW_VERSION`] (currently `1`) in
    /// the on-the-wire payload. The decoder rejects payloads where this
    /// field is missing or zero.
    pub v: u32,

    /// Origin URLs of datasets this view depends on, in the order they
    /// were opened. The recipient computes a stable [`DatasetId`] per
    /// URL via [`dataset_id_for_url`] and opens any URL whose id is not
    /// already present in the local scene.
    #[serde(default)]
    pub datasets: Vec<String>,

    /// Active layout per dataset. Keyed by [`DatasetId`] so the order of
    /// `datasets` doesn't have to match.
    #[serde(default)]
    pub active_layouts: HashMap<DatasetId, LayoutId>,

    /// 2D / arcball / fly camera. Reuses the same enum as
    /// [`crate::protocol::PresenceState`].
    pub camera: Camera,

    /// Z slab + T + C selection. Reuses the same struct as
    /// [`crate::protocol::PresenceState`].
    pub view: ViewState,

    /// Global contrast + gamma. Reuses the same struct as
    /// [`crate::protocol::PresenceState`].
    pub display: DisplayState,

    /// Render order for the loaded datasets (top-to-bottom in the
    /// layer panel). Mirrors [`crate::scene::Scene::dataset_order`].
    #[serde(default)]
    pub dataset_order: Vec<DatasetId>,

    /// Per-dataset visibility / opacity / contrast / colormap / channel
    /// settings. Mirrors [`crate::scene::Scene::dataset_settings`].
    #[serde(default)]
    pub dataset_settings: HashMap<DatasetId, DatasetDisplaySettings>,

    /// Per-dataset auto-contrast preference. Client-side state (lives in
    /// `useDatasetSettings.autoContrastMap` on the web client, not in the
    /// WASM scene). Captured + restored so manually-set contrast values
    /// aren't immediately overwritten by the recipient's auto-contrast
    /// intensity batcher (`useIntensityBatcher.ts`). `true` is the
    /// default for any dataset not present in the map.
    #[serde(default, skip_serializing_if = "HashMap::is_empty")]
    pub auto_contrast: HashMap<DatasetId, bool>,
}

impl SavedView {
    /// Build an empty `v: 1` saved view from a viewport size — useful as a
    /// scaffold in tests and as a fallback when no scene state exists.
    pub fn empty(viewport: [u32; 2]) -> Self {
        Self {
            v: SAVED_VIEW_VERSION,
            datasets: Vec::new(),
            active_layouts: HashMap::new(),
            camera: Camera::new_2d(viewport),
            view: ViewState::new(),
            display: DisplayState::default(),
            dataset_order: Vec::new(),
            dataset_settings: HashMap::new(),
            auto_contrast: HashMap::new(),
        }
    }
}

/// Stable, content-derived ID for a dataset URL. Mirrors
/// `lucida_server::handler::dataset_id_for_url` exactly so the IDs the web
/// client computes for `SavedView::datasets` URLs match the server's
/// per-binding ids. See [[decisions/0014-local-file-datasets-personal-only-in-saved-views]]
/// for the BLAKE3-collision sharp edge.
///
/// Format: `ds-{first_8_bytes_of_blake3(url)_as_le_u64_hex}`.
pub fn dataset_id_for_url(url: &str) -> String {
    let digest = blake3::hash(url.as_bytes());
    let bytes = digest.as_bytes();
    let prefix: [u8; 8] = bytes[..8].try_into().expect("blake3 always >= 8 bytes");
    format!("ds-{:016x}", u64::from_le_bytes(prefix))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::scene::{BlendMode, ChannelSettings, Colormap, RenderMode};

    fn sample_view() -> SavedView {
        let mut v = SavedView::empty([1024, 768]);
        v.datasets.push("gs://bucket/a.zarr".to_string());
        v.datasets.push("/data/b.zarr".to_string());
        v.active_layouts
            .insert(DatasetId("ds-aaaa".into()), LayoutId("plate-3x3".into()));
        v.dataset_order.push(DatasetId("ds-aaaa".into()));
        v.view.t = 7;
        v.view.c = 2;
        v.view.set_z_range(10..15);
        v.display.contrast_min = 100.0;
        v.display.contrast_max = 5000.0;
        v.display.gamma = 1.5;
        let s = DatasetDisplaySettings {
            opacity: 0.75,
            contrast_min: 50.0,
            contrast_max: 4000.0,
            gamma: 0.9,
            blend_mode: BlendMode::Additive,
            render_mode: RenderMode::MaxIntensity,
            channel_settings: vec![ChannelSettings {
                visible: true,
                colormap: Colormap::Viridis,
                contrast_min: 0.0,
                contrast_max: 1000.0,
                gamma: 1.0,
            }],
            ..Default::default()
        };
        v.dataset_settings.insert(DatasetId("ds-aaaa".into()), s);
        v
    }

    /// Round-trip equality check via JSON normalization (the inner Scene
    /// types don't all derive PartialEq, but the wire format is the
    /// stable contract anyway — equal JSON ⇒ equal SavedView).
    fn assert_round_trips(v: &SavedView) {
        let json1 = serde_json::to_string(v).unwrap();
        let back: SavedView = serde_json::from_str(&json1).unwrap();
        let json2 = serde_json::to_string(&back).unwrap();
        assert_eq!(json1, json2);
    }

    #[test]
    fn round_trips() {
        let v = sample_view();
        assert_round_trips(&v);
    }

    #[test]
    fn empty_round_trips() {
        let v = SavedView::empty([800, 600]);
        assert_round_trips(&v);
    }

    #[test]
    fn version_serialized_as_v_field() {
        let v = SavedView::empty([800, 600]);
        let json = serde_json::to_string(&v).unwrap();
        assert!(json.contains("\"v\":1"));
    }

    #[test]
    fn missing_optional_fields_default_on_decode() {
        // Minimum-payload SavedView: only v + camera + view + display.
        let json = r#"{
            "v": 1,
            "camera": {"mode": "slice", "center": [0.0, 0.0], "zoom": 1.0, "viewport": [800, 600]},
            "view": {"z_range": {"start": 0, "end": 1}, "t": 0, "c": 0},
            "display": {"contrast_min": 0.0, "contrast_max": 65535.0, "gamma": 1.0}
        }"#;
        let back: SavedView = serde_json::from_str(json).unwrap();
        assert_eq!(back.v, 1);
        assert!(back.datasets.is_empty());
        assert!(back.active_layouts.is_empty());
        assert!(back.dataset_order.is_empty());
        assert!(back.dataset_settings.is_empty());
        assert!(back.auto_contrast.is_empty());
    }

    #[test]
    fn auto_contrast_round_trips() {
        let mut v = SavedView::empty([800, 600]);
        v.auto_contrast.insert(DatasetId("ds-aaaa".into()), false);
        v.auto_contrast.insert(DatasetId("ds-bbbb".into()), true);
        let json = serde_json::to_string(&v).unwrap();
        assert!(json.contains("\"auto_contrast\""));
        let back: SavedView = serde_json::from_str(&json).unwrap();
        assert_eq!(back.auto_contrast.len(), 2);
        assert_eq!(
            back.auto_contrast.get(&DatasetId("ds-aaaa".into())),
            Some(&false)
        );
        assert_eq!(
            back.auto_contrast.get(&DatasetId("ds-bbbb".into())),
            Some(&true)
        );
    }

    #[test]
    fn empty_auto_contrast_is_skipped_on_serialize() {
        let v = SavedView::empty([800, 600]);
        let json = serde_json::to_string(&v).unwrap();
        assert!(
            !json.contains("auto_contrast"),
            "empty map should be skipped"
        );
    }

    #[test]
    fn fly_camera_round_trips() {
        use crate::camera::Fly;
        let mut v = SavedView::empty([1024, 768]);
        let mut fly = Fly::new([1024, 768]);
        fly.position = [10.0, 20.0, 30.0];
        v.camera = Camera::Fly(fly);
        assert_round_trips(&v);
        let json = serde_json::to_string(&v).unwrap();
        assert!(json.contains("\"mode\":\"fly\""));
        let back: SavedView = serde_json::from_str(&json).unwrap();
        match &back.camera {
            Camera::Fly(f) => assert_eq!(f.position, [10.0, 20.0, 30.0]),
            _ => panic!("expected Fly camera"),
        }
    }

    #[test]
    fn dataset_id_for_url_matches_server_format() {
        // Format: ds-{16 hex chars}. Two opens of the same URL produce
        // the same id; different URLs produce different ids.
        let id1 = dataset_id_for_url("gs://bucket/a.zarr");
        let id2 = dataset_id_for_url("gs://bucket/a.zarr");
        let id3 = dataset_id_for_url("gs://bucket/b.zarr");
        assert_eq!(id1, id2);
        assert_ne!(id1, id3);
        assert!(id1.starts_with("ds-"));
        assert_eq!(id1.len(), 3 + 16);
    }

    #[test]
    fn dataset_id_for_url_local_file_path() {
        let id = dataset_id_for_url("/data/scans/foo.zarr");
        assert!(id.starts_with("ds-"));
        assert_eq!(id.len(), 19);
    }

    #[test]
    fn dataset_id_for_url_empty_string() {
        // Edge case — should still produce a well-formed id.
        let id = dataset_id_for_url("");
        assert_eq!(id.len(), 19);
        assert!(id.starts_with("ds-"));
    }
}
