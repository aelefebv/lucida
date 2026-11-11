//! Capture record for the URL-as-app-state saved-views feature.
//!
//! `SavedView` spans both tiers of the document/viewport split: `datasets`
//! and `active_layouts` are document state (what is loaded), and the rest
//! mirror [`PresenceState`] (how it is being looked at). It rides the URL
//! hash and is also stored server-side under an opaque ID.
//!
//! The schema is a wire format. Every field that doesn't always serialize is
//! `#[serde(default)]` so older `v: 1` readers tolerate additive changes, and
//! the encoder rejects unknown major versions. The tests at the bottom lock it.
//
// The URL helpers live in `lucida-content::url` so server, store, and SPA
// share one implementation. The shims below re-export them through
// `#[wasm_bindgen]` for the SPA's `import { ... } from "lucida-core"`.

use indexmap::IndexMap;
use serde::{Deserialize, Serialize};

use lucida_content::{DatasetId, LayoutId};

#[cfg(target_arch = "wasm32")]
use wasm_bindgen::prelude::*;

use crate::camera::{Arcball, Camera, Framing};
use crate::placement::{CameraSpace, UserTransform};
use crate::scene::{DatasetDisplaySettings, DisplayState, Scene};
use crate::view::AxisPositions;

mod payload;

pub use payload::{PayloadError, decode_payload, encode_payload};

/// Schema version of the [`SavedView`] wire format. Encoders emit and
/// accept only this version. Recipients that see a higher version should
/// best-effort apply known fields and surface a warning; recipients that
/// see a missing/zero version should reject.
///
/// Version 2 moved solo onto each layer. A URL encoder that strips defaults
/// drops a version 1 view's `c: 0` and `multi_channel: false`, which meant
/// "solo channel 0", so only the version tells such a payload from a
/// version 2 composite.
pub const SAVED_VIEW_VERSION: u32 = 2;

/// Capture record for a "saved view": the user's complete view of one or
/// more datasets at a moment in time. Encoded into the URL hash by
/// lucida-web and applied on page load and `popstate`.
///
/// `PartialEq` (not `Eq`, since the camera and display hold `f64`) because
/// [`crate::scene::Annotation`] embeds one and derives `PartialEq`.
///
/// The per-dataset maps (`active_layouts`, `dataset_settings`,
/// `auto_contrast`) are [`IndexMap`], not `HashMap`. Embedded in an
/// [`Annotation`](crate::scene::Annotation), the view rides the document
/// wire, where the server's `from_str` → `to_string` rebroadcast must be
/// byte-identical to the inbound bytes (see [`crate::command`]). A `HashMap`
/// re-serializes in random order; `IndexMap` keeps insertion order, as
/// [`DocumentState`](crate::scene::DocumentState)'s collections do.
///
/// A view recorded before solo was per layer decodes with its scene-wide
/// channel mode moved onto each layer's
/// [`solo`](crate::scene::DatasetDisplaySettings::solo), and an arcball
/// recorded in level-0 sample units decodes as a fit at its orbit angles.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(from = "SavedViewWire")]
pub struct SavedView {
    /// Schema version, [`SAVED_VIEW_VERSION`] when this build records it.
    /// The decoder rejects payloads where this field is missing or zero.
    pub v: u32,

    /// Origin URLs of datasets this view depends on, in the order they
    /// were opened. The recipient computes a stable [`DatasetId`] per
    /// URL via [`dataset_id_for_url`] and opens any URL whose id is not
    /// already present in the local scene.
    #[serde(default)]
    pub datasets: Vec<String>,

    /// Active layout per dataset. Keyed by [`DatasetId`] so the order of
    /// `datasets` doesn't have to match. [`IndexMap`] (insertion order) so the
    /// embedded-on-the-wire form serializes deterministically — see the
    /// type-level doc.
    #[serde(default)]
    pub active_layouts: IndexMap<DatasetId, LayoutId>,

    /// 2D / arcball / fly camera. Reuses the same enum as
    /// [`crate::protocol::PresenceState`].
    pub camera: Camera,

    /// Z slab + T + C selection. Reuses the same struct as
    /// [`crate::protocol::PresenceState`].
    pub view: AxisPositions,

    /// Global contrast + gamma. Reuses the same struct as
    /// [`crate::protocol::PresenceState`].
    pub display: DisplayState,

    /// Render order for the loaded datasets (top-to-bottom in the
    /// layer panel). Mirrors [`crate::scene::Scene::dataset_order`].
    #[serde(default)]
    pub dataset_order: Vec<DatasetId>,

    /// Per-dataset visibility / opacity / contrast / colormap / channel
    /// settings. Mirrors [`crate::scene::Scene::dataset_settings`].
    /// [`IndexMap`] (insertion order) for deterministic on-the-wire
    /// serialization — see the type-level doc.
    #[serde(default)]
    pub dataset_settings: IndexMap<DatasetId, DatasetDisplaySettings>,

    /// Per-dataset auto-contrast preference. Client-side state (lives in
    /// `useDatasetSettings.autoContrastMap` on the web client, not in the
    /// WASM scene). Captured + restored so manually-set contrast values
    /// aren't immediately overwritten by the recipient's auto-contrast
    /// intensity batcher (`useIntensityBatcher.ts`). `true` is the
    /// default for any dataset not present in the map. [`IndexMap`]
    /// (insertion order) for deterministic on-the-wire serialization — see
    /// the type-level doc.
    #[serde(default, skip_serializing_if = "IndexMap::is_empty")]
    pub auto_contrast: IndexMap<DatasetId, bool>,

    /// The spaces `camera`'s numbers are in, those of the scene it was saved
    /// from. Its datasets fixed them, so a restore carries a placed camera
    /// from them into its own ([`Self::camera_in`]) and shows the region
    /// saved, whichever dataset the restoring document holds first. Absent,
    /// the numbers are in the restoring scene's own spaces, which every view
    /// saved before this field existed assumed.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub camera_space: Option<CameraSpace>,

    /// Where datasets sat by hand when the view was saved: a dataset the
    /// view names and the map leaves out sat where its declared frame put
    /// it. Absent, the view records no placement, and a restore leaves
    /// whatever the document holds. Every view saved before this field
    /// existed is one, and so is a viewer profile, which holds a camera and
    /// display settings while placement stays the document's.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub user_transforms: Option<IndexMap<DatasetId, UserTransform>>,
}

/// The JSON shape of [`SavedView`].
#[derive(Deserialize)]
struct SavedViewWire {
    v: u32,
    #[serde(default)]
    datasets: Vec<String>,
    #[serde(default)]
    active_layouts: IndexMap<DatasetId, LayoutId>,
    camera: Camera,
    view: AxisPositions,
    display: DisplayState,
    #[serde(default)]
    dataset_order: Vec<DatasetId>,
    #[serde(default)]
    dataset_settings: IndexMap<DatasetId, DatasetDisplaySettings>,
    #[serde(default)]
    auto_contrast: IndexMap<DatasetId, bool>,
    #[serde(default)]
    camera_space: Option<CameraSpace>,
    #[serde(default)]
    user_transforms: Option<IndexMap<DatasetId, UserTransform>>,
}

impl From<SavedViewWire> for SavedView {
    fn from(wire: SavedViewWire) -> Self {
        let mut view = wire.view;
        let mut dataset_settings = wire.dataset_settings;
        if let Some(legacy) = view.take_legacy_channels() {
            // A captured entry lists every channel of its layer, so its
            // length is the layer's channel count.
            for settings in dataset_settings.values_mut() {
                let channel_count = settings.channel_settings.len() as u32;
                settings.adopt_legacy_channels(legacy, channel_count);
            }
        }
        let mut camera = wire.camera;
        reframe_sample_unit_camera(&mut camera);
        Self {
            v: wire.v,
            datasets: wire.datasets,
            active_layouts: wire.active_layouts,
            camera,
            view,
            display: wire.display,
            dataset_order: wire.dataset_order,
            dataset_settings,
            auto_contrast: wire.auto_contrast,
            camera_space: wire.camera_space,
            user_transforms: wire.user_transforms,
        }
    }
}

/// Normalized world space holds every dataset at or below `y = 1` and within
/// `0 ≤ z ≤ 1`: a volume is the unit cube scaled down by its physical extent,
/// and a collection's members spread along `+x` and `−y`. An arcball framed
/// on level-0 samples instead aims at the middle of `[0, X] × [0, Y] × [0, Z]`,
/// far past both bounds once a volume is more than eight samples tall and
/// deep. The margin leaves a person room to pan the target off the data.
const SAMPLE_UNIT_TARGET_FLOOR: f64 = 4.0;

/// Turn an arcball recorded in level-0 sample units into a fit at its orbit
/// angles. Read as world units it shows empty space, and a view holds no
/// geometry to map it back by, so only the angles carry over and the scene
/// fits the rest on import. Returns whether it converted.
pub(crate) fn reframe_sample_unit_camera(camera: &mut Camera) -> bool {
    let Camera::Arcball(arcball) = camera else {
        return false;
    };
    let [_, y, z] = arcball.target;
    if !(y > SAMPLE_UNIT_TARGET_FLOOR && z > SAMPLE_UNIT_TARGET_FLOOR) {
        return false;
    }
    *arcball = Arcball {
        theta: arcball.theta,
        phi: arcball.phi,
        fov: arcball.fov,
        clip_mode: arcball.clip_mode,
        framing: Framing::Framed,
        ..Arcball::new(arcball.viewport)
    };
    true
}

impl SavedView {
    /// Build an empty saved view from a viewport size — useful as a
    /// scaffold in tests and as a fallback when no scene state exists.
    pub fn empty(viewport: [u32; 2]) -> Self {
        Self {
            v: SAVED_VIEW_VERSION,
            datasets: Vec::new(),
            active_layouts: IndexMap::new(),
            camera: Camera::new_2d(viewport),
            view: AxisPositions::new(),
            display: DisplayState::default(),
            dataset_order: Vec::new(),
            dataset_settings: IndexMap::new(),
            auto_contrast: IndexMap::new(),
            camera_space: None,
            user_transforms: None,
        }
    }

    /// Record where `document` puts each dataset by hand, so a restore puts
    /// them there again.
    pub fn record_placement(&mut self, document: &crate::scene::DocumentState) {
        self.user_transforms = Some(document.user_transforms.clone());
    }

    /// Where a restore of this view puts `dataset_id`: its recorded
    /// transform, or the identity for a dataset it recorded none for.
    /// `None` when the view records no placement at all.
    pub fn user_transform_of(&self, dataset_id: &DatasetId) -> Option<UserTransform> {
        let recorded = self.user_transforms.as_ref()?;
        Some(recorded.get(dataset_id).copied().unwrap_or_default())
    }

    /// This view's camera in `scene`'s spaces, carried from the ones it was
    /// saved in should they differ.
    pub fn camera_in(&self, scene: &Scene) -> Camera {
        let mut camera = self.camera.clone();
        if let Some(from) = &self.camera_space {
            scene.carry_camera(&mut camera, from);
        }
        camera
    }

    /// This view's selectors in `scene`'s spaces: its side-view axis positions
    /// carried from the spaces it was saved in should they differ.
    pub fn view_in(&self, scene: &Scene) -> AxisPositions {
        let mut view = self.view.clone();
        if let Some(from) = &self.camera_space {
            scene.carry_axes(&mut view, from);
        }
        view
    }

    /// Clear the source-URL list (`datasets`), leaving every workspace-local
    /// id-keyed field intact.
    ///
    /// This is the workspace-dataset-id form an embedded view must take.
    /// Membership is owned by the workspace document, so a view carried
    /// inside it, on a pin ([`crate::scene::Annotation::view`]) or as a stored
    /// workspace saved view, must not also carry source URLs, local
    /// `file:///` paths included, into broadcast or persisted state. The
    /// apply and duplicate paths both enforce it through here.
    pub fn clear_source_urls(&mut self) {
        self.datasets.clear();
    }

    /// Rewrite every workspace-local [`DatasetId`] in this view through
    /// `remap` (old id → new id), preserving insertion order.
    ///
    /// A duplicated workspace gives its datasets fresh ids, so a view copied
    /// verbatim would reference the source's. An id missing from `remap` is
    /// left as-is. `datasets` (source URLs) is untouched: it is cleared before
    /// a workspace saved view is persisted.
    pub fn remap_dataset_ids(&mut self, remap: &std::collections::HashMap<DatasetId, DatasetId>) {
        fn mapped(
            remap: &std::collections::HashMap<DatasetId, DatasetId>,
            id: &DatasetId,
        ) -> DatasetId {
            remap.get(id).cloned().unwrap_or_else(|| id.clone())
        }
        self.active_layouts = self
            .active_layouts
            .drain(..)
            .map(|(id, layout)| (mapped(remap, &id), layout))
            .collect();
        for id in &mut self.dataset_order {
            *id = mapped(remap, id);
        }
        self.dataset_settings = self
            .dataset_settings
            .drain(..)
            .map(|(id, settings)| (mapped(remap, &id), settings))
            .collect();
        self.auto_contrast = self
            .auto_contrast
            .drain(..)
            .map(|(id, flag)| (mapped(remap, &id), flag))
            .collect();
        if let Some(transforms) = self.user_transforms.as_mut() {
            *transforms = transforms
                .drain(..)
                .map(|(id, transform)| (mapped(remap, &id), transform))
                .collect();
        }
    }
}

/// Stable, content-derived ID for a dataset URL. Thin shim over
/// [`lucida_content::url::dataset_id_for_url`], the one implementation the
/// SPA, the server, and the storage layer share.
///
/// On `target_arch = "wasm32"` this is also exported via `wasm-bindgen`, which
/// is what the SPA's `import { dataset_id_for_url } from "lucida-core"`
/// resolves.
#[cfg_attr(target_arch = "wasm32", wasm_bindgen)]
pub fn dataset_id_for_url(url: &str) -> String {
    lucida_content::url::dataset_id_for_url(url)
}

/// Canonicalize a user-typed dataset URL. Thin `#[wasm_bindgen]` shim
/// over [`lucida_content::url::normalize_dataset_url`] — see that
/// function for the full table of behaviors. Exposed here so the SPA
/// can normalize URL-bar input before submit (the canonical form is
/// what gets hashed, broadcast, and shown).
#[cfg_attr(target_arch = "wasm32", wasm_bindgen)]
pub fn normalize_dataset_url(raw: &str) -> String {
    lucida_content::url::normalize_dataset_url(raw)
}

/// `true` if `url` parses as a local filesystem path. Thin
/// `#[wasm_bindgen]` shim over
/// [`lucida_content::url::is_local_dataset_url`]. Exposed here so the
/// SPA's share-warning classifier (`captureBuilder.ts`) can call into
/// the same Rust implementation the server uses, eliminating
/// classifier-drift bugs.
#[cfg_attr(target_arch = "wasm32", wasm_bindgen)]
pub fn is_local_dataset_url(url: &str) -> bool {
    lucida_content::url::is_local_dataset_url(url)
}

/// Why `raw` is not a dataset location, as a
/// [`lucida_content::url::LocationError::kind`], or `None` when it parses.
/// Exposed so the SPA words a rejection from the parse the server runs.
#[cfg_attr(target_arch = "wasm32", wasm_bindgen)]
pub fn dataset_location_error(raw: &str) -> Option<String> {
    lucida_content::url::DatasetLocation::parse(raw)
        .err()
        .map(|error| error.kind().to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::scene::{BlendMode, ChannelSettings, Colormap, RenderMode};

    fn sample_view() -> SavedView {
        let mut v = SavedView::empty([1024, 768]);
        v.datasets.push("gs://bucket/a.zarr".to_string());
        v.datasets.push("/data/b.zarr".to_string());
        v.active_layouts.insert(
            DatasetId("ds-aaaa".into()),
            LayoutId("collection-3x3".into()),
        );
        v.dataset_order.push(DatasetId("ds-aaaa".into()));
        v.view.t = 7;
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
                // A user channel-name override rides the saved view too.
                name: Some("Region A".into()),
            }],
            solo: Some(0),
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

    /// `remap_dataset_ids` moves every workspace-local id key (active_layouts,
    /// dataset_order, dataset_settings, auto_contrast) onto the new id — the
    /// workspace-duplicate contract for a copied saved view. `datasets` (source
    /// URLs) is left alone.
    #[test]
    fn remap_dataset_ids_rewrites_all_id_keyed_fields() {
        use std::collections::HashMap;

        let old = DatasetId("ds-aaaa".into());
        let new = DatasetId("ds-copy".into());
        let mut v = sample_view();
        v.auto_contrast.insert(old.clone(), false);

        let mut remap = HashMap::new();
        remap.insert(old.clone(), new.clone());
        v.remap_dataset_ids(&remap);

        assert!(v.active_layouts.contains_key(&new));
        assert!(!v.active_layouts.contains_key(&old));
        assert_eq!(v.dataset_order, vec![new.clone()]);
        assert!(v.dataset_settings.contains_key(&new));
        assert!(!v.dataset_settings.contains_key(&old));
        assert!(v.auto_contrast.contains_key(&new));
        assert!(!v.auto_contrast.contains_key(&old));
        // Source URLs are URL-keyed, not id-keyed — untouched by the remap.
        assert_eq!(v.datasets, vec!["gs://bucket/a.zarr", "/data/b.zarr"]);
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
        assert!(json.contains("\"v\":2"));
    }

    fn legacy_view(view: &str) -> SavedView {
        let channels = |n: usize| {
            let entry = r#"{"visible":true,"colormap":"gray","contrast_min":0.0,"contrast_max":1.0,"gamma":1.0}"#;
            vec![entry; n].join(",")
        };
        let settings = |n: usize| {
            format!(
                r#"{{"visible":true,"opacity":1.0,"contrast_min":0.0,"contrast_max":65535.0,"gamma":1.0,"blend_mode":"alpha","channel_settings":[{}]}}"#,
                channels(n)
            )
        };
        let json = format!(
            r#"{{"v":1,"camera":{{"mode":"slice","center":[0.0,0.0],"zoom":1.0,"viewport":[800,600]}},"view":{view},"display":{{"contrast_min":0.0,"contrast_max":65535.0,"gamma":1.0}},"dataset_settings":{{"three":{},"two":{},"one":{}}}}}"#,
            settings(3),
            settings(2),
            settings(1)
        );
        serde_json::from_str(&json).unwrap()
    }

    fn solos(v: &SavedView) -> Vec<Option<u32>> {
        ["three", "two", "one"]
            .iter()
            .map(|id| v.dataset_settings[&DatasetId((*id).into())].solo)
            .collect()
    }

    #[test]
    fn a_legacy_single_channel_view_solos_each_layer_that_has_the_channel() {
        let v = legacy_view(r#"{"z_range":{"start":0,"end":1},"t":0,"c":2,"multi_channel":false}"#);
        assert_eq!(solos(&v), vec![Some(2), None, None]);
        assert_eq!(v.view.legacy_channels(), None);

        let v = legacy_view(r#"{"z_range":{"start":0,"end":1},"t":0,"c":1}"#);
        assert_eq!(solos(&v), vec![Some(1), Some(1), None]);
    }

    #[test]
    fn a_legacy_composite_view_restores_as_the_composite() {
        let v = legacy_view(r#"{"z_range":{"start":0,"end":1},"t":0,"c":1,"multi_channel":true}"#);
        assert_eq!(solos(&v), vec![None, None, None]);
    }

    #[test]
    fn a_decoded_legacy_view_encodes_in_the_current_form() {
        let v = legacy_view(r#"{"z_range":{"start":0,"end":1},"t":0,"c":0,"multi_channel":false}"#);
        let json = serde_json::to_string(&v).unwrap();
        assert!(!json.contains("multi_channel"), "{json}");
        assert!(json.contains(r#""solo":0"#), "{json}");
        let again: SavedView = serde_json::from_str(&json).unwrap();
        assert_eq!(again, v);
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
        assert!(back.camera_space.is_none());
    }

    #[test]
    fn the_camera_space_rides_last_and_only_when_recorded() {
        const SPACE: &str = r#"{"frame":{"spacing":[0.5,0.5,2.0],"origin":[3.0,0.0,0.0],"meters":[1e-6,1e-6,1e-6]},"world":{"extent":512.0,"top":256.0}}"#;
        let mut v = sample_view();
        let without = serde_json::to_string(&v).unwrap();
        assert!(!without.contains("camera_space"), "{without}");

        v.camera_space = Some(serde_json::from_str(SPACE).unwrap());
        let json = serde_json::to_string(&v).unwrap();
        assert!(
            json.ends_with(&format!(r#","camera_space":{SPACE}}}"#)),
            "{json}"
        );
        assert_round_trips(&v);
        let back: SavedView = serde_json::from_str(&json).unwrap();
        assert_eq!(back.camera_space, v.camera_space);
        // The link codec leaves it as it is.
        let decoded: SavedView =
            serde_json::from_value(decode_payload(&v.to_payload()).unwrap()).unwrap();
        assert_eq!(decoded.camera_space, v.camera_space);
    }

    #[test]
    fn user_transforms_ride_only_when_recorded_and_say_where_each_dataset_sat() {
        let moved = DatasetId("ds-aaaa".into());
        let other = DatasetId("ds-bbbb".into());
        let mut v = sample_view();
        let without = serde_json::to_string(&v).unwrap();
        assert!(!without.contains("user_transforms"), "{without}");
        assert_eq!(v.user_transform_of(&moved), None);

        let transform = UserTransform {
            translation: [2.0, 0.0, 0.0],
            scale: [3.0; 3],
            ..UserTransform::IDENTITY
        };
        v.user_transforms = Some(IndexMap::from([(moved.clone(), transform)]));
        assert_round_trips(&v);
        assert_eq!(v.user_transform_of(&moved), Some(transform));
        // Recorded, so a dataset the map leaves out sat where it declares.
        assert_eq!(v.user_transform_of(&other), Some(UserTransform::IDENTITY));
        let decoded: SavedView =
            serde_json::from_value(decode_payload(&v.to_payload()).unwrap()).unwrap();
        assert_eq!(decoded.user_transforms, v.user_transforms);

        // An empty record still says every dataset sat where it declares.
        v.user_transforms = Some(IndexMap::new());
        let json = serde_json::to_string(&v).unwrap();
        assert!(json.ends_with(r#","user_transforms":{}}"#), "{json}");
        let back: SavedView = serde_json::from_str(&json).unwrap();
        assert_eq!(
            back.user_transform_of(&moved),
            Some(UserTransform::IDENTITY)
        );

        let mut remap = std::collections::HashMap::new();
        remap.insert(moved.clone(), other.clone());
        v.user_transforms = Some(IndexMap::from([(moved, transform)]));
        v.remap_dataset_ids(&remap);
        assert_eq!(v.user_transform_of(&other), Some(transform));
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

    /// The scene fits a reframed arcball as it would a fresh open, at the
    /// angles the view recorded.
    #[test]
    fn a_reframed_arcball_frames_the_data_on_import() {
        use crate::command::DocumentCommand;
        use crate::framing::WorldBox;
        use crate::scene::{Scene, test_helpers::make_dataset_opened_with_shape};

        let mut scene = Scene::new([800, 600]);
        scene.apply(
            DocumentCommand::DatasetOpened(make_dataset_opened_with_shape(
                "v",
                "v",
                1,
                [1, 1, 128, 512, 512],
                [1, 1, 32, 32, 32],
                4,
            ))
            .into(),
        );
        let mut recorded = Arcball::new([320, 320]);
        recorded.target = [256.0, 256.0, 64.0];
        recorded.distance = 1056.8;
        recorded.theta = 1.285;
        recorded.framing = Framing::Placed;
        let mut camera = Camera::Arcball(recorded);
        assert!(reframe_sample_unit_camera(&mut camera));
        scene.import_presence(camera, AxisPositions::new(), DisplayState::default());

        let Camera::Arcball(arcball) = &scene.active_view().camera else {
            panic!(
                "expected an arcball camera, got {:?}",
                scene.active_view().camera
            );
        };
        let WorldBox { min, max } = scene.dataset_world_bounds("v").unwrap();
        assert_eq!(arcball.framing, Framing::Framed);
        assert_eq!(arcball.theta, 1.285);
        for axis in 0..3 {
            let middle = (min[axis] + max[axis]) / 2.0;
            assert!(
                (arcball.target[axis] - middle).abs() < 1e-9,
                "{:?} is not the middle of {min:?}..{max:?}",
                arcball.target
            );
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

    // Embedded in an `Annotation`/`AddAnnotation`, a `SavedView` rides the
    // document wire, where an inbound command and its server rebroadcast
    // (`serde_json::from_str` -> `to_string`) must be byte-identical. The
    // per-dataset maps are `IndexMap` so that round-trip keeps key order; a
    // `HashMap` would break it with >=2 entries. These compare the wire
    // string, not a `serde_json::Value`, which ignores order.

    /// A `SavedView` whose three maps each carry the same `keys`, inserted in
    /// the given order (so we can build the "same logical view, opposite
    /// insertion order" pair).
    fn view_with_keys(keys: &[&str]) -> SavedView {
        let mut v = SavedView::empty([1024, 768]);
        for k in keys {
            v.active_layouts
                .insert(DatasetId((*k).into()), LayoutId(format!("L-{k}")));
            v.dataset_settings
                .insert(DatasetId((*k).into()), DatasetDisplaySettings::default());
            v.auto_contrast.insert(DatasetId((*k).into()), false);
            v.dataset_order.push(DatasetId((*k).into()));
        }
        v
    }

    /// The invariant: the server's rebroadcast path (`from_str` -> `to_string`)
    /// on a >=2-dataset view reproduces the inbound wire bytes byte-for-byte.
    /// The fixed golden client wire has insertion order ds-aaaa < ds-bbbb <
    /// ds-cccc in every map, as a browser's `JSON.stringify` emits. `IndexMap`
    /// keeps the parsed order, so it round-trips verbatim.
    #[test]
    fn rebroadcast_of_multi_dataset_view_is_byte_identical() {
        const CLIENT_WIRE: &str = r#"{"v":2,"datasets":[],"active_layouts":{"ds-aaaa":"L-a","ds-bbbb":"L-b","ds-cccc":"L-c"},"camera":{"mode":"slice","center":[0.0,0.0],"zoom":1.0,"viewport":[1024,768]},"view":{"z_range":{"start":0,"end":1},"t":0},"display":{"contrast_min":0.0,"contrast_max":65535.0,"gamma":1.0},"dataset_order":["ds-aaaa","ds-bbbb","ds-cccc"],"dataset_settings":{"ds-aaaa":{"visible":true,"opacity":1.0,"contrast_min":0.0,"contrast_max":65535.0,"gamma":1.0,"blend_mode":"alpha","render_mode":"translucent","channel_settings":[],"label_settings":[],"channel_blend_mode":"additive"},"ds-bbbb":{"visible":true,"opacity":1.0,"contrast_min":0.0,"contrast_max":65535.0,"gamma":1.0,"blend_mode":"alpha","render_mode":"translucent","channel_settings":[],"label_settings":[],"channel_blend_mode":"additive"},"ds-cccc":{"visible":true,"opacity":1.0,"contrast_min":0.0,"contrast_max":65535.0,"gamma":1.0,"blend_mode":"alpha","render_mode":"translucent","channel_settings":[],"label_settings":[],"channel_blend_mode":"additive"}},"auto_contrast":{"ds-aaaa":false,"ds-bbbb":false,"ds-cccc":false}}"#;
        let parsed: SavedView = serde_json::from_str(CLIENT_WIRE).unwrap();
        let rebroadcast = serde_json::to_string(&parsed).unwrap();
        assert_eq!(
            CLIENT_WIRE, rebroadcast,
            "server rebroadcast (from_str -> to_string) of a >=2-dataset SavedView \
             must be byte-identical to the inbound wire"
        );
        // Sanity: the maps really do carry >=2 entries (so this isn't a
        // vacuous 0/1-entry pass).
        assert!(parsed.active_layouts.len() >= 2);
        assert!(parsed.dataset_settings.len() >= 2);
        assert!(parsed.auto_contrast.len() >= 2);
    }

    /// Repeated `from_str` -> `to_string` is a fixpoint for a >=2-dataset view:
    /// re-parsing and re-serializing the rebroadcast yields the same bytes. (A
    /// `HashMap` could land on a different order on each pass within a process.)
    #[test]
    fn multi_dataset_view_rebroadcast_is_a_fixpoint() {
        let v = view_with_keys(&["ds-aaaa", "ds-bbbb", "ds-cccc", "ds-dddd"]);
        let once = serde_json::to_string(&v).unwrap();
        let parsed: SavedView = serde_json::from_str(&once).unwrap();
        let twice = serde_json::to_string(&parsed).unwrap();
        assert_eq!(once, twice, "from_str -> to_string must be a byte fixpoint");
    }

    /// The map key order in the serialized blob follows insertion order
    /// (`IndexMap` semantics), so a view captured the way the web client builds
    /// it — iterating the scene's canonical dataset order — serializes in that
    /// dataset order, and any peer deriving the same logical view from the same
    /// canonical order produces the same bytes.
    #[test]
    fn multi_dataset_view_serializes_in_insertion_order() {
        let v = view_with_keys(&["ds-aaaa", "ds-bbbb", "ds-cccc"]);
        let json = serde_json::to_string(&v).unwrap();
        let a = json.find("ds-aaaa").unwrap();
        let b = json.find("ds-bbbb").unwrap();
        let c = json.find("ds-cccc").unwrap();
        assert!(
            a < b && b < c,
            "map keys must serialize in insertion order: {json}"
        );
    }
}
