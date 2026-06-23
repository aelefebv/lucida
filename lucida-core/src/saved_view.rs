//! Capture record for the URL-as-app-state saved-views feature
//! (see `wiki/decisions/0013-url-as-app-state-for-saved-views.md`).
//!
//! `SavedView` spans both tiers of the [[document-vs-viewport-split]]: the
//! `datasets` + `active_layouts` fields are the document-state surface (what
//! is loaded), and `camera` + `view` + `display` + `dataset_order` +
//! `dataset_settings` mirror the [`PresenceState`] surface (how it's being
//! looked at). Inline in the URL hash; also stored server-side and addressed
//! by an opaque ID.
//!
//! The schema is a wire format: every field that doesn't always serialize is
//! marked `#[serde(default)]` so a recipient on an older `v: 1` codepath can
//! tolerate later additive evolution. The `v` field is the version gate —
//! `v: 1` is the only spec; the encoder rejects unknown major versions;
//! future bumps (`v: 2`+) require an explicit migration story.
//!
//! Tests at the bottom of this file lock the wire format. Don't touch them
//! casually — see [[gotchas/scene-document-state-json-compat]].
//
// The URL-derivation helpers (`dataset_id_for_url`, plus the new
// `normalize_dataset_url` and `is_local_dataset_url` from
// `wiki/decisions/0042-canonical-dataset-url-form.md`) live in
// `lucida-content::url` so server, store, and SPA share one
// implementation. The shims below re-export them via `#[wasm_bindgen]`
// so the existing `import { dataset_id_for_url } from "lucida-core"`
// call sites in the SPA continue to work, and the two new helpers are
// available under the same import.

use indexmap::IndexMap;
use serde::{Deserialize, Serialize};

use lucida_content::{DatasetId, LayoutId};

#[cfg(target_arch = "wasm32")]
use wasm_bindgen::prelude::*;

use crate::camera::Camera;
use crate::scene::{DatasetDisplaySettings, DisplayState};
use crate::view::ViewState;

/// Schema version of the [`SavedView`] wire format. Encoders emit and
/// accept only this version. Recipients that see a higher version should
/// best-effort apply known fields and surface a warning; recipients that
/// see a missing/zero version should reject.
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
///
/// `PartialEq` (not `Eq` — the camera/display fields hold `f64`) so a
/// `SavedView` can be embedded in a `PartialEq` type. In particular
/// [`crate::scene::Annotation`] derives `PartialEq` and captures the author's
/// view as an `Option<SavedView>`, so this derive is load-bearing for that.
///
/// The per-dataset maps (`active_layouts`, `dataset_settings`,
/// `auto_contrast`) are [`IndexMap`], NOT `std::collections::HashMap`. Once a
/// `SavedView` is embedded in an
/// [`Annotation`](crate::scene::Annotation)/`AddAnnotation` it rides the
/// collaborative-document wire (broadcast, persisted, snapshotted), which
/// requires **deterministic serialization**: the server rebroadcasts an
/// inbound command by `serde_json::from_str` → `to_string` (lucida-server's
/// `handler`), and that round-trip must be byte-identical to the inbound bytes
/// (see [`crate::command`]). `serde_json` emits a `HashMap` in
/// per-process-randomized hash order, so a multi-dataset view would
/// re-serialize in a *different* order than it arrived — breaking the
/// invariant. `IndexMap` preserves insertion order, and deserialize→serialize
/// round-trips that order verbatim, so the rebroadcast is byte-identical. This
/// matches the existing wire-borne document collections on
/// [`DocumentState`](crate::scene::DocumentState) — its `manifests`,
/// `asset_catalogs`, and `annotations` are `IndexMap` for exactly this reason
/// ([[scene-state-and-epochs]]).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
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
}

impl SavedView {
    /// Build an empty `v: 1` saved view from a viewport size — useful as a
    /// scaffold in tests and as a fallback when no scene state exists.
    pub fn empty(viewport: [u32; 2]) -> Self {
        Self {
            v: SAVED_VIEW_VERSION,
            datasets: Vec::new(),
            active_layouts: IndexMap::new(),
            camera: Camera::new_2d(viewport),
            view: ViewState::new(),
            display: DisplayState::default(),
            dataset_order: Vec::new(),
            dataset_settings: IndexMap::new(),
            auto_contrast: IndexMap::new(),
        }
    }
}

/// Stable, content-derived ID for a dataset URL. Thin shim over
/// [`lucida_content::url::dataset_id_for_url`] — the single source of
/// truth for the BLAKE3-derived id, shared between the SPA, the server
/// (`lucida-server::handler`), and the storage layer
/// (`lucida-store::backend::open`). See
/// `wiki/decisions/0042-canonical-dataset-url-form.md` for placement
/// rationale and
/// `wiki/decisions/0014-local-file-datasets-personal-only-in-saved-views.md`
/// for the BLAKE3-collision sharp edge.
///
/// On `target_arch = "wasm32"` this function is also exported via
/// `wasm-bindgen`; that's why the SPA's existing
/// `import { dataset_id_for_url } from "lucida-core"` resolves.
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

/// `true` if `canonical` (already normalized) refers to a local
/// filesystem path. Thin `#[wasm_bindgen]` shim over
/// [`lucida_content::url::is_local_dataset_url`]. Exposed here so the
/// SPA's share-warning classifier (`captureBuilder.ts`) can call into
/// the same Rust implementation the server uses, eliminating
/// classifier-drift bugs.
#[cfg_attr(target_arch = "wasm32", wasm_bindgen)]
pub fn is_local_dataset_url(canonical: &str) -> bool {
    lucida_content::url::is_local_dataset_url(canonical)
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

    // ---- Deterministic on-the-wire serialization (>=2 datasets) ----------
    //
    // Once a `SavedView` is embedded in an `Annotation`/`AddAnnotation` it
    // rides the collaborative-document wire, whose locked invariant is that an
    // inbound command and its server rebroadcast are byte-identical (the server
    // rebroadcasts via `serde_json::from_str` -> `to_string`; see
    // `crate::command`'s `AddAnnotation` doc and
    // `protocol::add_annotation_broadcast_is_byte_identical_to_inbound_command`).
    // The per-dataset maps (`active_layouts`, `dataset_settings`,
    // `auto_contrast`) are `IndexMap` precisely so that round-trip preserves
    // key order; a `std::collections::HashMap` would re-emit them in
    // per-process-randomized order and break this with >=2 entries.
    //
    // These guard the byte-identity of the wire STRING (NOT a `serde_json::Value`
    // compare, which is order-insensitive and would pass even on the buggy
    // `HashMap` form). Derived from the red-team determinism family.

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

    /// THE invariant: the server's rebroadcast path (`from_str` -> `to_string`)
    /// on a >=2-dataset view reproduces the inbound wire bytes byte-for-byte.
    /// This is a *fixed golden* client wire (insertion order ds-aaaa < ds-bbbb <
    /// ds-cccc in every map) — exactly what a browser emits via `JSON.stringify`.
    /// With `HashMap` the re-serialization reordered the maps and this diverged;
    /// `IndexMap` preserves the parsed order, so it round-trips verbatim.
    #[test]
    fn rebroadcast_of_multi_dataset_view_is_byte_identical() {
        const CLIENT_WIRE: &str = r#"{"v":1,"datasets":[],"active_layouts":{"ds-aaaa":"L-a","ds-bbbb":"L-b","ds-cccc":"L-c"},"camera":{"mode":"slice","center":[0.0,0.0],"zoom":1.0,"viewport":[1024,768]},"view":{"z_range":{"start":0,"end":1},"t":0,"c":0,"multi_channel":false},"display":{"contrast_min":0.0,"contrast_max":65535.0,"gamma":1.0},"dataset_order":["ds-aaaa","ds-bbbb","ds-cccc"],"dataset_settings":{"ds-aaaa":{"visible":true,"opacity":1.0,"contrast_min":0.0,"contrast_max":65535.0,"gamma":1.0,"blend_mode":"alpha","render_mode":"translucent","channel_settings":[],"channel_blend_mode":"additive"},"ds-bbbb":{"visible":true,"opacity":1.0,"contrast_min":0.0,"contrast_max":65535.0,"gamma":1.0,"blend_mode":"alpha","render_mode":"translucent","channel_settings":[],"channel_blend_mode":"additive"},"ds-cccc":{"visible":true,"opacity":1.0,"contrast_min":0.0,"contrast_max":65535.0,"gamma":1.0,"blend_mode":"alpha","render_mode":"translucent","channel_settings":[],"channel_blend_mode":"additive"}},"auto_contrast":{"ds-aaaa":false,"ds-bbbb":false,"ds-cccc":false}}"#;
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
