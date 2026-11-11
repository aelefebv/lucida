use std::ops::Range;

use serde::{Deserialize, Serialize};

use crate::camera::Camera;
use crate::placement::{Affine, SceneFrame};
use crate::scene::Comparison;
use crate::slice_plane::SlicePlane;
use lucida_content::{DatasetId, SpatialAxis};

/// A view's identity within its scene, kept while the scene holds the view.
#[derive(
    Debug, Clone, Copy, Default, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize,
)]
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

/// How the canvas divides among the views: one view across it, two side by
/// side, or two stacked, the form a narrow screen takes.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ViewLayout {
    #[default]
    Single,
    Columns,
    Rows,
}

impl ViewLayout {
    /// The rectangle of each view in order. Adjacent views meet at the same
    /// fraction, so their pixels tile the canvas.
    pub fn rects(self) -> Vec<ViewRect> {
        let half = |x, y, width, height| ViewRect {
            x,
            y,
            width,
            height,
        };
        match self {
            ViewLayout::Single => vec![ViewRect::WHOLE],
            ViewLayout::Columns => vec![half(0.0, 0.0, 0.5, 1.0), half(0.5, 0.0, 0.5, 1.0)],
            ViewLayout::Rows => vec![half(0.0, 0.0, 1.0, 0.5), half(0.0, 0.5, 1.0, 0.5)],
        }
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
    /// The cameras before the layout last moved them, kept while nothing else
    /// moves them ([`Self::keep_region_at`]). Client-local.
    #[serde(skip)]
    layout_base: Option<LayoutBase>,
}

/// A view's cameras before and after the layout last gave it a rectangle.
#[derive(Debug, Clone, PartialEq)]
struct LayoutBase {
    chosen: (Camera, Option<Camera>),
    arranged: (Camera, Option<Camera>),
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
            layout_base: None,
        }
    }

    /// A view of no dataset yet at `rect`, through a slice camera sized to
    /// its part of a canvas of `canvas` device pixels.
    pub fn empty(id: ViewId, rect: ViewRect, canvas: [u32; 2]) -> Self {
        Self {
            camera: Camera::new_2d(rect.size_on(canvas)),
            datasets: ViewDatasets::Only(Vec::new()),
            rect,
            ..Self::new(id, canvas)
        }
    }

    pub fn id(&self) -> ViewId {
        self.id
    }

    pub fn shows(&self, dataset_id: &DatasetId) -> bool {
        self.datasets.shows(dataset_id)
    }

    /// Whether the view's comparison sets `dataset_id` aside: one is under
    /// way and the dataset is not one of its pair.
    pub fn sets_aside(&self, dataset_id: &DatasetId) -> bool {
        self.comparison
            .as_ref()
            .is_some_and(|c| !c.compares(dataset_id))
    }

    /// The plane the slice camera cuts, whether it is active or parked. A
    /// view that never had one cuts XY.
    pub fn slice_plane(&self) -> SlicePlane {
        match (&self.camera, &self.parked_camera) {
            (Camera::Slice(s), _) | (_, Some(Camera::Slice(s))) => s.plane,
            _ => SlicePlane::Xy,
        }
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

    /// Move both cameras onto a rectangle of `size` device pixels, each
    /// keeping the region it showed ([`Camera::fit_region_to_viewport`]), as
    /// a layout that halves or restores the view's rectangle does. A framed
    /// camera fits again afterwards anyway.
    ///
    /// The region is the one the cameras showed before the layout last moved
    /// them, while nothing else has: fitting the region each new rectangle
    /// shows would grow it with every split and restore.
    pub(crate) fn keep_region_at(&mut self, size: [u32; 2]) {
        let now = (self.camera.clone(), self.parked_camera.clone());
        let (camera, parked) = match self.layout_base.take() {
            Some(LayoutBase { chosen, arranged }) if arranged == now => chosen,
            _ => now,
        };
        let chosen = (camera.clone(), parked.clone());
        self.camera = camera;
        self.parked_camera = parked;
        for camera in self.cameras_mut() {
            camera.fit_region_to_viewport(size);
        }
        let arranged = (self.camera.clone(), self.parked_camera.clone());
        self.layout_base = Some(LayoutBase { chosen, arranged });
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

/// Where a view stands on the axes it does not draw: the places along Z, Y
/// and X its slice planes cut, and its timepoint. Each place is in the scene
/// frame, so one position cuts the same physical place in every layer, and
/// each layer reads its own plane there ([`crate::scene::Scene::cut_grid`]).
/// Which channels show is per layer, in
/// [`crate::scene::DatasetDisplaySettings::solo`] and each channel's
/// `visible` flag.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct AxisPositions {
    /// The Z slab of a view recorded before positions were places: plane
    /// numbers, which each layer read as its own. Decoding only, see
    /// [`Self::place_legacy_z`]; nothing writes it now. First, so a
    /// view read with one writes it back where it was.
    #[serde(rename = "z_range", default, skip_serializing_if = "Option::is_none")]
    pub legacy_z_range: Option<Range<u32>>,
    /// The places along Z an XY view cuts, in the scene frame's units: one
    /// position of the view's grid for a single cut, several for a slab.
    /// Absent until something places it, which reads as the grid's first
    /// position.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub z: Option<Range<f64>>,
    pub t: u32,
    /// The place an XZ view cuts along Y, and the one a YZ view cuts along
    /// X, in the scene frame's units. Absent until a view of that plane
    /// first opens, which picks the middle of the data; absent reads as the
    /// grid's first position.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub y: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub x: Option<f64>,
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
            z: None,
            t: 0,
            y: None,
            x: None,
            legacy_z_range: None,
            legacy_c: None,
            legacy_multi_channel: None,
        }
    }

    /// The place `axis` is cut at, if anything placed it: the middle of the
    /// Z range, or the Y or X place.
    pub fn place(&self, axis: SpatialAxis) -> Option<f64> {
        match axis {
            SpatialAxis::Z => self.z.as_ref().map(|z| (z.start + z.end) / 2.0),
            SpatialAxis::Y => self.y,
            SpatialAxis::X => self.x,
        }
    }

    /// Move the places, in one scene frame, by `map` into another, keeping
    /// the planes each cuts.
    pub fn map_cut_positions(&mut self, map: &Affine) {
        let along = |a: usize, place: f64| {
            let mut at = [0.0; 3];
            at[a] = place;
            map.apply(at)[a]
        };
        if let Some(z) = &mut self.z {
            let (start, end) = (along(2, z.start), along(2, z.end));
            *z = start.min(end)..start.max(end);
        }
        for (a, place) in [(1, &mut self.y), (0, &mut self.x)] {
            if let Some(place) = place {
                *place = along(a, *place);
            }
        }
    }

    /// Turn a Z slab recorded before positions were places into the places
    /// it named in `frame`: the planes of the dataset that fixed the frame,
    /// which every layer of a scene of one dataset, or of datasets on that
    /// dataset's Z grid, cut there.
    pub fn place_legacy_z(&mut self, frame: &SceneFrame) {
        if let Some(planes) = self.legacy_z_range.take() {
            let to_scene = frame.place_reference();
            let at = |plane: u32| to_scene.apply([0.0, 0.0, f64::from(plane)])[2];
            let end = planes.end.max(planes.start.saturating_add(1));
            let (start, end) = (at(planes.start), at(end));
            self.z = Some(start.min(end)..start.max(end));
        }
    }

    /// The Y and X places of a view recorded before positions were places:
    /// each named a whole unit of the scene frame, cut through its middle.
    pub fn place_legacy_units(&mut self) {
        for place in [&mut self.y, &mut self.x].into_iter().flatten() {
            *place += 0.5;
        }
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
    use crate::placement::DeclaredFrame;

    #[test]
    fn default_view_starts_unplaced() {
        let v = AxisPositions::new();
        assert_eq!((v.z.clone(), v.y, v.x), (None, None, None));
        assert_eq!(v.t, 0);
        assert_eq!(v.legacy_channels(), None);
    }

    #[test]
    fn each_axis_is_cut_at_its_own_place() {
        let mut v = AxisPositions::new();
        v.z = Some(4.0..6.0);
        v.y = Some(9.5);
        v.x = Some(-3.5);
        assert_eq!(v.place(SpatialAxis::Z), Some(5.0));
        assert_eq!(v.place(SpatialAxis::Y), Some(9.5));
        assert_eq!(v.place(SpatialAxis::X), Some(-3.5));
        let json = serde_json::to_string(&v).unwrap();
        assert_eq!(
            json,
            r#"{"z":{"start":4.0,"end":6.0},"t":0,"y":9.5,"x":-3.5}"#
        );
        assert_eq!(serde_json::from_str::<AxisPositions>(&json).unwrap(), v);
    }

    #[test]
    fn places_move_with_the_scene_frame() {
        let mut v = AxisPositions::new();
        v.z = Some(4.0..6.0);
        v.y = Some(9.5);
        v.map_cut_positions(&Affine::axis_aligned([1.0, 2.0, -0.5], [0.0, 1.0, 10.0]));
        assert_eq!(v.z, Some(7.0..8.0));
        assert_eq!(v.y, Some(20.0));
        assert_eq!(v.x, None);
    }

    #[test]
    fn a_legacy_slab_names_the_planes_of_the_frames_dataset() {
        let mut v: AxisPositions =
            serde_json::from_str(r#"{"z_range":{"start":3,"end":5},"t":0,"y":7}"#).unwrap();
        assert_eq!(v.legacy_z_range, Some(3..5));
        // Z samples twice as long as X ones, which measure one unit.
        let frame = SceneFrame::new(DeclaredFrame::from_parts([1.0, 1.0, 2.0], [0.0; 3], None));
        v.place_legacy_z(&frame);
        v.place_legacy_units();
        assert_eq!(v.z, Some(6.0..10.0));
        assert_eq!(v.y, Some(7.5));
        assert_eq!(v.legacy_z_range, None);
        let json = serde_json::to_string(&v).unwrap();
        assert!(!json.contains("z_range"), "{json}");
    }

    #[test]
    fn a_current_view_serializes_no_channel_selector() {
        let json = serde_json::to_string(&AxisPositions::new()).unwrap();
        assert_eq!(json, r#"{"t":0}"#);
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
        composite.legacy_z_range = None;
        assert_eq!(composite, AxisPositions::new());
    }
}
