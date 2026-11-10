use std::ops::Range;

use serde::{Deserialize, Serialize};

use crate::camera::Camera;
use crate::placement::Affine;
use crate::scene::Comparison;
use crate::slice_plane::SlicePlane;
use lucida_content::{DatasetId, SpatialAxis};

/// A view's identity within its scene, kept while the scene holds the view.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(transparent)]
pub struct ViewId(pub u32);

/// Where a view is drawn on the canvas: a rectangle in fractions of the
/// canvas's width and height from its top-left corner, so a resize keeps the
/// layout.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct ViewRect {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

impl ViewRect {
    pub const WHOLE: Self = Self {
        x: 0.0,
        y: 0.0,
        width: 1.0,
        height: 1.0,
    };

    /// The rectangle's size in device pixels on a canvas of `canvas` device
    /// pixels. The whole canvas is the canvas exactly.
    pub fn size_on(&self, canvas: [u32; 2]) -> [u32; 2] {
        let along = |fraction: f64, length: u32| (fraction * f64::from(length)).round() as u32;
        [along(self.width, canvas[0]), along(self.height, canvas[1])]
    }
}

/// Which of the scene's datasets a view shows.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ViewDatasets {
    /// Every dataset the scene holds, including ones opened later.
    All,
    /// These alone.
    Only(Vec<DatasetId>),
}

impl ViewDatasets {
    pub fn shows(&self, dataset_id: &DatasetId) -> bool {
        match self {
            ViewDatasets::All => true,
            ViewDatasets::Only(ids) => ids.contains(dataset_id),
        }
    }
}

/// One view of a scene: a camera onto the datasets it shows, standing at its
/// own axis positions, drawn in its own rectangle of the canvas. Its 2D/3D
/// mode is its camera's family, and its slice plane is its slice camera's.
/// Every view shares the scene's datasets, display settings and memory
/// budgets.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct View {
    id: ViewId,
    pub camera: Camera,
    /// The last camera of the family not in use: the slice camera while a
    /// volume camera is active, and the other way round. Switching back
    /// brings it back, so each mode keeps the view it had. Client-local.
    #[serde(skip)]
    pub(crate) parked_camera: Option<Camera>,
    pub axes: AxisPositions,
    pub datasets: ViewDatasets,
    pub rect: ViewRect,
    /// Two datasets the view shows against each other. Client-local: nothing
    /// shares or saves it yet.
    #[serde(skip)]
    pub comparison: Option<Comparison>,
}

impl View {
    /// A view of every dataset across the whole canvas, through a slice
    /// camera on a canvas of `viewport` device pixels.
    pub fn new(id: ViewId, viewport: [u32; 2]) -> Self {
        Self {
            id,
            camera: Camera::new_2d(viewport),
            parked_camera: None,
            axes: AxisPositions::new(),
            datasets: ViewDatasets::All,
            rect: ViewRect::WHOLE,
            comparison: None,
        }
    }

    pub fn id(&self) -> ViewId {
        self.id
    }

    pub fn shows(&self, dataset_id: &DatasetId) -> bool {
        self.datasets.shows(dataset_id)
    }

    /// The plane the slice camera cuts, whether it is active or parked. A
    /// view that never had one cuts XY.
    pub fn slice_plane(&self) -> SlicePlane {
        match (&self.camera, &self.parked_camera) {
            (Camera::Slice(s), _) | (_, Some(Camera::Slice(s))) => s.plane,
            _ => SlicePlane::Xy,
        }
    }

    /// The axis position along the slice plane's cut axis, before any layer
    /// clamps it.
    pub fn cut_index(&self) -> u32 {
        self.axes.cut(self.slice_plane()).start
    }

    /// Both cameras, the active one first, so what every camera follows
    /// reaches the parked one too.
    pub(crate) fn cameras_mut(&mut self) -> impl Iterator<Item = &mut Camera> {
        std::iter::once(&mut self.camera).chain(self.parked_camera.as_mut())
    }

    /// Resize both cameras to `size` device pixels, the parked one too so it
    /// comes back sized for the canvas it returns to. A pixel ratio change,
    /// `(from, to)`, resizes the canvas in device pixels but not on screen,
    /// so the slice zoom scales with it and keeps the view's CSS size and
    /// region.
    pub(crate) fn resize(&mut self, size: [u32; 2], ratio: Option<(f64, f64)>) {
        for camera in self.cameras_mut() {
            if let (Some((from, to)), Camera::Slice(s)) = (ratio, &mut *camera) {
                s.set_zoom(s.zoom * to / from);
            }
            camera.set_viewport(size[0], size[1]);
        }
    }

    /// Switch to the slice camera: the one this view last had, or a new one.
    /// Returns whether the camera changed family.
    pub(crate) fn set_mode_2d(&mut self) -> bool {
        if !self.camera.is_volume() {
            return false;
        }
        let slice = match self.parked_camera.take() {
            Some(parked @ Camera::Slice(_)) => parked,
            _ => Camera::new_2d(self.camera.viewport()),
        };
        self.parked_camera = Some(std::mem::replace(&mut self.camera, slice));
        true
    }

    /// Switch to the arcball. From fly mode it converts, keeping the eye and
    /// the view direction. From 2D it brings back the volume camera this view
    /// last had, or a new arcball. Returns whether the camera changed.
    pub(crate) fn set_mode_3d(&mut self) -> bool {
        let arcball = match &self.camera {
            Camera::Arcball(_) => return false,
            Camera::Fly(fly) => fly.to_arcball(),
            Camera::Slice(_) => match self.parked_camera.take() {
                Some(Camera::Arcball(parked)) => parked,
                Some(Camera::Fly(parked)) => parked.to_arcball(),
                _ => crate::camera::Arcball::new(self.camera.viewport()),
            },
        };
        self.enter_volume(Camera::Arcball(arcball));
        true
    }

    /// Switch to the fly camera. From the arcball it converts, keeping the
    /// eye and the view direction. From 2D it brings back the volume camera
    /// this view last had, or a new fly camera. Returns whether the camera
    /// changed.
    pub(crate) fn set_mode_fly(&mut self) -> bool {
        let fly = match &self.camera {
            Camera::Fly(_) => return false,
            Camera::Arcball(arcball) => arcball.to_fly(),
            Camera::Slice(_) => match self.parked_camera.take() {
                Some(Camera::Fly(parked)) => parked,
                Some(Camera::Arcball(parked)) => parked.to_fly(),
                _ => crate::camera::Fly::new(self.camera.viewport()),
            },
        };
        self.enter_volume(Camera::Fly(fly));
        true
    }

    /// Make `camera`, a volume camera, the active one, parking the slice
    /// camera if that is what it replaces.
    fn enter_volume(&mut self, camera: Camera) {
        let previous = std::mem::replace(&mut self.camera, camera);
        if !previous.is_volume() {
            self.parked_camera = Some(previous);
        }
    }

    /// Make `camera` the active one. One of the other family parks the camera
    /// it replaces, as a mode switch does.
    pub(crate) fn adopt_camera(&mut self, camera: Camera) {
        let previous = std::mem::replace(&mut self.camera, camera);
        if previous.is_volume() != self.camera.is_volume() {
            self.parked_camera = Some(previous);
        }
    }
}

/// Where a view stands on the axes it does not draw: its Z slab, its
/// timepoint, and the Y or X place a side view cuts. Which channels show is
/// per layer, in [`crate::scene::DatasetDisplaySettings::solo`] and each
/// channel's `visible` flag.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct AxisPositions {
    /// Z slab range. A single slice is a range of length 1 (e.g. 42..43).
    pub z_range: Range<u32>,
    pub t: u32,
    /// The place in the scene frame an XZ view cuts along Y, and the one a YZ
    /// view cuts along X, in the frame's units. Absent until a view of that
    /// plane first opens, which picks the middle of the data; absent reads
    /// as 0.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub y: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub x: Option<u32>,
    /// The scene-wide channel of a view recorded before solo was per layer.
    /// Decoding only, see [`Self::legacy_channels`]; nothing writes it now.
    #[serde(rename = "c", default, skip_serializing_if = "Option::is_none")]
    pub legacy_c: Option<u32>,
    /// The scene-wide composite flag of a view recorded before solo was per
    /// layer. Decoding only, see [`Self::legacy_channels`].
    #[serde(
        rename = "multi_channel",
        default,
        skip_serializing_if = "Option::is_none"
    )]
    pub legacy_multi_channel: Option<bool>,
}

/// The scene-wide channel mode of a view recorded before solo was per layer.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LegacyChannels {
    /// Every layer showed its visible channels.
    Composite,
    /// Every layer with this channel showed it alone.
    Solo(u32),
}

impl AxisPositions {
    pub fn new() -> Self {
        Self {
            z_range: 0..1,
            t: 0,
            y: None,
            x: None,
            legacy_c: None,
            legacy_multi_channel: None,
        }
    }

    /// Set a single z slice (slab of thickness 1).
    pub fn set_z(&mut self, index: u32) {
        self.z_range = index..index + 1;
    }

    /// Set a z slab range.
    pub fn set_z_range(&mut self, range: Range<u32>) {
        self.z_range = range;
    }

    /// The plane a slice view of `plane` cuts, before any layer clamps it.
    pub fn cut(&self, plane: SlicePlane) -> Range<u32> {
        let single = |index: Option<u32>| {
            let index = index.unwrap_or(0);
            index..index.saturating_add(1)
        };
        match plane.cut() {
            SpatialAxis::Z => self.z_range.clone(),
            SpatialAxis::Y => single(self.y),
            SpatialAxis::X => single(self.x),
        }
    }

    /// Move the X and Y axis positions, places in one scene frame, by `map`
    /// into another, keeping the plane each names.
    pub fn map_cut_positions(&mut self, map: &Affine) {
        for (a, position) in [(1, &mut self.y), (0, &mut self.x)] {
            if let Some(index) = position {
                let mut at = [0.0; 3];
                at[a] = *index as f64 + 0.5;
                *index = map.apply(at)[a].floor().clamp(0.0, u32::MAX as f64) as u32;
            }
        }
    }

    pub fn set_slice(&mut self, axis: &str, index: u32) -> Result<(), String> {
        match axis {
            "z" => self.set_z(index),
            "y" => self.y = Some(index),
            "x" => self.x = Some(index),
            "t" => self.t = index,
            "c" => {
                return Err(
                    "channels are shown per layer; solo a channel on a layer instead".to_string(),
                );
            }
            _ => return Err(format!("unknown axis: {axis}")),
        }
        Ok(())
    }

    /// The channel mode of a view recorded before solo was per layer, or
    /// `None` for a current view. Such a view always carried `c`, and without
    /// `multi_channel: true` it showed `c` alone.
    pub fn legacy_channels(&self) -> Option<LegacyChannels> {
        if self.legacy_c.is_none() && self.legacy_multi_channel.is_none() {
            return None;
        }
        Some(if self.legacy_multi_channel == Some(true) {
            LegacyChannels::Composite
        } else {
            LegacyChannels::Solo(self.legacy_c.unwrap_or(0))
        })
    }

    /// [`Self::legacy_channels`], leaving a current view behind.
    pub fn take_legacy_channels(&mut self) -> Option<LegacyChannels> {
        let legacy = self.legacy_channels();
        self.legacy_c = None;
        self.legacy_multi_channel = None;
        legacy
    }
}

impl Default for AxisPositions {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn default_view_starts_at_zero() {
        let v = AxisPositions::new();
        assert_eq!(v.z_range, 0..1);
        assert_eq!(v.t, 0);
        assert_eq!(v.legacy_channels(), None);
    }

    #[test]
    fn set_slice_updates_z_as_single_plane() {
        let mut v = AxisPositions::new();
        v.set_slice("z", 42).unwrap();
        assert_eq!(v.z_range, 42..43);
        assert_eq!(v.t, 0);
    }

    #[test]
    fn each_plane_cuts_at_its_own_axis_position() {
        let mut v = AxisPositions::new();
        v.set_z_range(4..6);
        assert_eq!(v.cut(SlicePlane::Xy), 4..6);
        assert_eq!(v.cut(SlicePlane::Xz), 0..1);
        v.set_slice("y", 9).unwrap();
        v.set_slice("x", 3).unwrap();
        assert_eq!(v.cut(SlicePlane::Xz), 9..10);
        assert_eq!(v.cut(SlicePlane::Yz), 3..4);
        let json = serde_json::to_string(&v).unwrap();
        assert_eq!(json, r#"{"z_range":{"start":4,"end":6},"t":0,"y":9,"x":3}"#);
        assert_eq!(serde_json::from_str::<AxisPositions>(&json).unwrap(), v);
    }

    #[test]
    fn set_z_range_for_slab() {
        let mut v = AxisPositions::new();
        v.set_z_range(10..20);
        assert_eq!(v.z_range, 10..20);
    }

    #[test]
    fn set_slice_rejects_unknown_axis_and_the_channel() {
        let mut v = AxisPositions::new();
        assert!(v.set_slice("q", 1).is_err());
        assert!(v.set_slice("c", 1).is_err());
    }

    #[test]
    fn a_current_view_serializes_no_channel_selector() {
        let json = serde_json::to_string(&AxisPositions::new()).unwrap();
        assert_eq!(json, r#"{"z_range":{"start":0,"end":1},"t":0}"#);
        let back: AxisPositions = serde_json::from_str(&json).unwrap();
        assert_eq!(back.legacy_channels(), None);
    }

    #[test]
    fn a_legacy_view_decodes_its_scene_wide_mode() {
        let single: AxisPositions = serde_json::from_str(
            r#"{"z_range":{"start":0,"end":1},"t":0,"c":2,"multi_channel":false}"#,
        )
        .unwrap();
        assert_eq!(single.legacy_channels(), Some(LegacyChannels::Solo(2)));

        // Views from before the flag existed meant single-channel.
        let flagless: AxisPositions =
            serde_json::from_str(r#"{"z_range":{"start":0,"end":1},"t":0,"c":1}"#).unwrap();
        assert_eq!(flagless.legacy_channels(), Some(LegacyChannels::Solo(1)));

        let mut composite: AxisPositions = serde_json::from_str(
            r#"{"z_range":{"start":0,"end":1},"t":0,"c":1,"multi_channel":true}"#,
        )
        .unwrap();
        assert_eq!(
            composite.take_legacy_channels(),
            Some(LegacyChannels::Composite)
        );
        assert_eq!(composite, AxisPositions::new());
    }
}
