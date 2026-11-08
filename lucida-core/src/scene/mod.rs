mod layers;
mod types;

pub(crate) use layers::LayerExtent;
pub use layers::{ResolvedLayer, ShownChannel, in_channel_context};
pub use types::{
    Annotation, AnnotationKind, BlendMode, ChannelSettings, Colormap, Comment,
    DatasetDisplaySettings, DisplayState, DocumentState, LabelSettings, MemberChunkPlan,
    RenderMode,
};

use std::collections::HashMap;

use serde::{Deserialize, Serialize};

use lucida_content::*;

use crate::camera::{Camera, Framing};
use crate::chunk::{self, ChunkCoord, ChunkQuery, ChunkView, CullCounts};
use crate::epoch::SceneEpochs;
use crate::framing::{FitBounds, VoxBox, WorldBox};
use crate::query::{EntityQueryResult, ViewQueryDelta, ViewQueryResult};
use crate::target_level::{
    self, IN_PLANE_AXES, MAX_RENDER_PIXEL_RATIO, VOLUME_AXES, level_shape_ratios,
};
use crate::transform::{self, VolumeTransform};
use crate::view::ViewState;

/// Per-dataset derived state for fast hot-path lookups.
/// Rebuilt on register/remove. Not serialized.
#[derive(Debug, Clone)]
pub struct DatasetDerivedState {
    pub volume_transforms: HashMap<ImageId, VolumeTransform>,
    pub active_layout: LayoutSpec,
    pub members: Vec<MemberState>,
    /// Member id (image id **or** entity id) → index into `members`. First
    /// occurrence wins, so a lookup lands on the same member a front-to-back
    /// scan matching either id would return. Lets per-member queries (model
    /// matrices, picking) stay O(1) instead of scanning tens of thousands of
    /// members per call in wide collections.
    pub member_index: HashMap<String, usize>,
    /// Max of every member's (positive-clamped) `max_physical_extent`; `0.0`
    /// for a dataset with no members so it is neutral in a cross-dataset
    /// `max` fold. Precomputed here so [`Scene::global_max_physical_extent`]
    /// folds over datasets, not over every member of every dataset.
    pub max_physical_extent: f64,
    /// Max of every member's physical Y extent (`model[5] * clamped extent`);
    /// `0.0` with no members. The per-dataset input to
    /// [`Scene::global_max_physical_y`], precomputed for the same reason as
    /// `max_physical_extent`.
    pub max_physical_y: f64,
}

impl DatasetDerivedState {
    /// Resolve a member by image id or entity id in O(1). Matches the member
    /// a linear scan testing `image_id == id || entity_id == id` would find
    /// first (see `member_index`). `None` for an unknown id.
    pub fn member_by_id(&self, id: &str) -> Option<&MemberState> {
        self.member_index.get(id).map(|&i| &self.members[i])
    }
}

/// Precomputed per image-bearing entity.
///
/// A *member* is a placed image-bearing entity as the scene and renderer refer
/// to it — an [`EntityKind::Tile`], or a single-image [`EntityKind::Image`].
/// This is a separate vocabulary from the three that meet here: the generic
/// "group" and "tile" used elsewhere as GPU pool and atlas units are pooling
/// concepts, distinct from the [`EntityKind::Group`] / [`EntityKind::Tile`]
/// content kinds a member is derived from.
#[derive(Debug, Clone)]
pub struct MemberState {
    pub entity_id: EntityId,
    pub image_id: ImageId,
    pub position: [f64; 2],
    pub volume_transform: VolumeTransform,
    pub levels: Vec<LevelGeometry>,
    pub data_type: DataType,
}

/// Aggregate XY extent for visible image content in scene coordinates.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct VisibleContentBounds2D {
    pub min_x: f64,
    pub min_y: f64,
    pub max_x: f64,
    pub max_y: f64,
    pub max_depth: u32,
}

impl VisibleContentBounds2D {
    pub fn width(&self) -> f64 {
        self.max_x - self.min_x
    }

    pub fn height(&self) -> f64 {
        self.max_y - self.min_y
    }

    pub fn center_x(&self) -> f64 {
        (self.min_x + self.max_x) / 2.0
    }

    pub fn center_y(&self) -> f64 {
        (self.min_y + self.max_y) / 2.0
    }
}

/// The multi-dataset placement correction for one volume, produced by
/// [`Scene::placement_correction`]: a uniform scale (`correction`, with its
/// exact reciprocal ratio `inv_correction`) that preserves relative physical
/// sizes across datasets, plus a Y translation (`top_align`) that top-aligns
/// volumes of different heights in 3D. Kept in `f64`; consumers that build
/// `f32` matrices cast at application time ([`Self::apply`]), consumers that
/// stay in `f64` (e.g. [`Scene::volume_diagonal`]) use the tiles directly.
#[derive(Debug, Clone, Copy)]
struct PlacementCorrection {
    correction: f64,
    inv_correction: f64,
    top_align: f64,
}

impl PlacementCorrection {
    /// Fold this correction into a forward/inverse matrix pair (column-major
    /// `[f32; 16]`): scale the diagonal and XY translation of `model` and add
    /// the top-align term to its Y translation; apply the reciprocal to
    /// `inv_model` so the pair keeps composing to the identity.
    fn apply(&self, model: &mut [f32; 16], inv_model: &mut [f32; 16]) {
        let correction = self.correction as f32;
        let inv_correction = self.inv_correction as f32;
        let top_align = self.top_align as f32;

        model[0] *= correction;
        model[5] *= correction;
        model[10] *= correction;
        model[12] *= correction;
        model[13] *= correction;
        model[13] += top_align;

        inv_model[0] *= inv_correction;
        inv_model[5] *= inv_correction;
        inv_model[10] *= inv_correction;
        inv_model[13] -= top_align * inv_model[5];
    }
}

/// What [`Scene::frame`] fits.
#[derive(Debug, Clone, PartialEq)]
pub enum FrameTarget {
    /// Every visible dataset.
    Visible,
    /// One dataset, shown or not.
    Dataset(DatasetId),
}

/// The complete viewer state.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Scene {
    pub camera: Camera,
    /// The last camera of the family not in use: the slice camera while a
    /// volume camera is active, and the other way round. Switching back
    /// brings it back, so each mode keeps the view it had. Client-local.
    #[serde(skip)]
    pub(crate) parked_camera: Option<Camera>,
    pub view: ViewState,
    /// Shared document state (dataset manifests).
    #[serde(flatten)]
    pub document: DocumentState,
    /// Display settings (contrast window + gamma). Per-client, not part of shared document.
    #[serde(default)]
    pub display: DisplayState,
    #[serde(default)]
    pub dataset_order: Vec<DatasetId>,
    #[serde(default)]
    pub dataset_settings: HashMap<DatasetId, DatasetDisplaySettings>,
    /// Derived state for fast hot-path lookups. Rebuilt on register/remove.
    #[serde(skip)]
    pub derived: HashMap<DatasetId, DatasetDerivedState>,
    /// Monotonic epoch counters for change detection.
    #[serde(default)]
    pub epochs: SceneEpochs,
    /// Per-dataset snapshot of the last [`Scene::view_query_delta`], used to
    /// diff successive queries. Client-local scratch, not part of shared or
    /// serialized state.
    #[serde(skip)]
    pub(crate) view_query_cursors: HashMap<DatasetId, ViewQueryCursor>,
    /// The device pixel ratio the canvas was last sized at, once the client
    /// has said. Client-local, like the canvas size.
    #[serde(skip)]
    pub(crate) pixel_ratio: Option<f64>,
}

/// The camera's geometry family. A change between families routes the entity
/// projection through a different path, so a delta across such a change is not
/// meaningful and the query resyncs to a full snapshot instead.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum CameraModeKind {
    Slice,
    Arcball,
    Fly,
}

impl CameraModeKind {
    fn of(camera: &Camera) -> Self {
        match camera {
            Camera::Slice(_) => Self::Slice,
            Camera::Arcball(_) => Self::Arcball,
            Camera::Fly(_) => Self::Fly,
        }
    }
}

/// The quantized state of one entity — the fields whose change is worth
/// reporting in a delta. Continuous geometry (importance, projected size,
/// centroid) is intentionally excluded so a camera nudge does not flag every
/// entity.
#[derive(Debug, Clone, PartialEq, Eq)]
struct QuantizedEntity {
    visible: bool,
    target_level: u32,
    level_pinned: bool,
    kind: EntityKind,
}

impl QuantizedEntity {
    fn of(entry: &EntityQueryResult) -> Self {
        Self {
            visible: entry.visible,
            target_level: entry.target_level,
            level_pinned: entry.level_pinned,
            kind: entry.kind.clone(),
        }
    }
}

/// Snapshot of the last query for one dataset. The delta compares against this
/// to decide what changed, and whether a full resync is required.
#[derive(Debug, Clone)]
pub(crate) struct ViewQueryCursor {
    /// Structural epochs at snapshot time. A move in any of these means the
    /// membership base was rebuilt, so the query resyncs to a full snapshot.
    content: u64,
    layout: u64,
    /// Camera geometry family at snapshot time. A change resyncs.
    mode: CameraModeKind,
    /// Quantized state per present record, keyed by the unique per-record
    /// `image_id` (an entity can own several images, so `entity_id` is not a
    /// unique key).
    entries: HashMap<ImageId, QuantizedEntity>,
}

impl ViewQueryCursor {
    /// Whether this snapshot still describes the current projection space,
    /// meaning the same membership base and the same camera family. A
    /// difference against any other snapshot means nothing.
    fn matches(&self, epochs: &SceneEpochs, mode: CameraModeKind) -> bool {
        self.content == epochs.content && self.layout == epochs.layout && self.mode == mode
    }
}

impl Scene {
    pub fn new(viewport: [u32; 2]) -> Self {
        Self {
            camera: Camera::new_2d(viewport),
            parked_camera: None,
            view: ViewState::new(),
            document: DocumentState::default(),
            display: DisplayState::default(),
            dataset_order: Vec::new(),
            dataset_settings: HashMap::new(),
            derived: HashMap::new(),
            epochs: SceneEpochs::default(),
            view_query_cursors: HashMap::new(),
            pixel_ratio: None,
        }
    }

    /// Get the volume transform for the first dataset's first image.
    pub fn volume_transform(&self) -> Option<&VolumeTransform> {
        self.derived
            .values()
            .next()
            .and_then(|d| d.members.first())
            .map(|m| &m.volume_transform)
    }

    /// Get the volume shape [Z, Y, X] for the first dataset's first image.
    pub fn volume_shape(&self) -> Option<[u32; 3]> {
        self.derived
            .values()
            .next()
            .and_then(|d| d.members.first())
            .and_then(|m| m.levels.first())
            .map(|l| [l.shape[2] as u32, l.shape[3] as u32, l.shape[4] as u32])
    }

    /// World-space bounding-box diagonal of the first dataset's first volume,
    /// **after** the multi-dataset global correction
    /// ([`Self::placement_correction`]) — the same scale the renderer draws it
    /// at. Consumers size world-space motion from it (fly-camera base speed,
    /// initial 3D framing). Returns `1.0` when no volume is loaded so speed
    /// seeding always has a sane basis.
    pub fn volume_diagonal(&self) -> f64 {
        let member = self.derived.values().next().and_then(|d| d.members.first());
        let Some(m) = member else {
            return 1.0;
        };
        let t = &m.volume_transform;
        let correction = self.placement_correction(t).correction;
        let sx = t.model[0] as f64 * correction;
        let sy = t.model[5] as f64 * correction;
        let sz = t.model[10] as f64 * correction;
        (sx * sx + sy * sy + sz * sz).sqrt()
    }

    /// Switch to the slice camera: the one this scene last had, or a new one
    /// fitted to the data.
    pub fn set_mode_2d(&mut self) {
        if self.camera.is_volume() {
            let slice = match self.parked_camera.take() {
                Some(parked @ Camera::Slice(_)) => parked,
                _ => Camera::new_2d(self.camera.viewport()),
            };
            self.parked_camera = Some(std::mem::replace(&mut self.camera, slice));
            self.reframe();
        }
    }

    /// Switch to the arcball. From fly mode it converts, keeping the eye and
    /// the view direction. From 2D it brings back the volume camera this
    /// scene last had, or a new arcball fitted to the data.
    pub fn set_mode_3d(&mut self) {
        let arcball = match &self.camera {
            Camera::Arcball(_) => return,
            Camera::Fly(fly) => fly.to_arcball(),
            Camera::Slice(_) => match self.parked_camera.take() {
                Some(Camera::Arcball(parked)) => parked,
                Some(Camera::Fly(parked)) => parked.to_arcball(),
                _ => crate::camera::Arcball::new(self.camera.viewport()),
            },
        };
        self.enter_volume(Camera::Arcball(arcball));
    }

    /// Switch to the fly camera. From the arcball it converts, keeping the
    /// eye and the view direction. From 2D it brings back the volume camera
    /// this scene last had, or a new fly camera fitted to the data.
    pub fn set_mode_fly(&mut self) {
        let fly = match &self.camera {
            Camera::Fly(_) => return,
            Camera::Arcball(arcball) => arcball.to_fly(),
            Camera::Slice(_) => match self.parked_camera.take() {
                Some(Camera::Fly(parked)) => parked,
                Some(Camera::Arcball(parked)) => parked.to_fly(),
                _ => crate::camera::Fly::new(self.camera.viewport()),
            },
        };
        self.enter_volume(Camera::Fly(fly));
    }

    /// Make `camera`, a volume camera, the active one, parking the slice
    /// camera if that is what it replaces.
    fn enter_volume(&mut self, camera: Camera) {
        let previous = std::mem::replace(&mut self.camera, camera);
        if !previous.is_volume() {
            self.parked_camera = Some(previous);
        }
        self.reframe();
    }

    /// Set viewport on camera (avoids name clash with ViewportCommand::SetViewport).
    ///
    /// A resize keeps a placed camera's zoom, and fits a framed or unframed
    /// one again on the new canvas. A new pixel ratio resizes the canvas in
    /// device pixels but not on screen, so the slice zoom scales with it and
    /// the view keeps its CSS size and region. A volume camera's view does not
    /// depend on the ratio.
    pub(crate) fn inner_set_viewport(&mut self, width: u32, height: u32, pixel_ratio: Option<f64>) {
        let before = self.camera.clone();
        self.resize(width, height, pixel_ratio);
        if self.camera != before {
            self.reframe();
        }
    }

    /// Resize both cameras' canvases, the parked one too so it comes back
    /// sized for the canvas it returns to.
    fn resize(&mut self, width: u32, height: u32, pixel_ratio: Option<f64>) {
        let to = pixel_ratio.filter(|r| r.is_finite() && *r > 0.0);
        let from = self.pixel_ratio;
        for camera in std::iter::once(&mut self.camera).chain(self.parked_camera.as_mut()) {
            if let (Some(from), Some(to), Camera::Slice(s)) = (from, to, &mut *camera)
                && from != to
            {
                s.set_zoom(s.zoom * to / from);
            }
            camera.set_viewport(width, height);
        }
        if to.is_some() {
            self.pixel_ratio = to;
        }
    }

    /// Fit the camera to `target` on a canvas of `viewport` device pixels,
    /// which this resizes it to. The canvas is an argument because a fit
    /// against a size the scene has not caught up with frames the wrong
    /// canvas.
    ///
    /// A fit of everything visible leaves the camera framed, so a new canvas
    /// or new content fits it again. A fit of one dataset among others is a
    /// choice like a zoom, and leaves it placed.
    ///
    /// Returns `false`, changing nothing, when the canvas has no area or the
    /// target no bounds. Bumps `epochs.view` when the camera changed.
    pub fn frame(&mut self, target: &FrameTarget, viewport: [u32; 2]) -> bool {
        if viewport[0] == 0 || viewport[1] == 0 {
            return false;
        }
        let bounds = match target {
            FrameTarget::Visible => self.visible_bounds(),
            FrameTarget::Dataset(id) => self.dataset_bounds(&id.0),
        };
        let Some(bounds) = bounds else {
            return false;
        };
        let framing = match target {
            FrameTarget::Visible => Framing::Framed,
            FrameTarget::Dataset(id) => {
                let mut visible = self.visible_dataset_ids();
                if visible.next() == Some(id) && visible.next().is_none() {
                    Framing::Framed
                } else {
                    Framing::Placed
                }
            }
        };
        let before = self.camera.clone();
        self.resize(viewport[0], viewport[1], None);
        self.camera.fit(&bounds);
        self.camera.set_framing(framing);
        if self.camera != before {
            self.epochs.view += 1;
        }
        true
    }

    /// Fit the slice camera to `region`, a voxel box, on its canvas: a part of
    /// the data, so the camera is left placed. A volume camera ignores it.
    /// Bumps `epochs.view` and returns `true` when the camera changed.
    pub fn frame_voxel_region(&mut self, region: VoxBox) -> bool {
        let Camera::Slice(slice) = &mut self.camera else {
            return false;
        };
        let before = slice.clone();
        slice.fit_to_bounds(region, crate::framing::FIT_MARGIN_2D);
        slice.framing = Framing::Placed;
        let changed = *slice != before;
        if changed {
            self.epochs.view += 1;
        }
        changed
    }

    /// Fit the camera to everything visible again when its pose is the fit or
    /// a stand-in, after something that fit depends on changed: the canvas,
    /// the content, what is visible, or the mode. A placed camera stays where
    /// it was put. Leaves the epochs to the caller and says whether the camera
    /// changed.
    pub(crate) fn reframe(&mut self) -> bool {
        if self.camera.framing() == Framing::Placed {
            return false;
        }
        let [width, height] = self.camera.viewport();
        if width == 0 || height == 0 {
            return false;
        }
        let Some(bounds) = self.visible_bounds() else {
            return false;
        };
        let before = self.camera.clone();
        self.camera.fit(&bounds);
        self.camera.set_framing(Framing::Framed);
        self.camera != before
    }

    /// Follow a change to the document's datasets. A scene with none left has
    /// nothing its cameras frame, so the active one becomes a stand-in and
    /// the parked one is dropped; otherwise the camera reframes. Bumps
    /// `epochs.view` when the camera changed.
    pub(crate) fn content_changed(&mut self) {
        let changed = if self.document.manifests.is_empty() {
            self.parked_camera = None;
            let stand_in = self.camera.framing() != Framing::Unframed;
            self.camera.set_framing(Framing::Unframed);
            stand_in
        } else {
            self.reframe()
        };
        if changed {
            self.epochs.view += 1;
        }
    }

    pub fn remove_dataset(&mut self, id: &DatasetId) {
        self.document.remove_dataset(id);
        self.dataset_order.retain(|s| s != id);
        self.dataset_settings.remove(id);
        self.derived.remove(id);
        self.view_query_cursors.remove(id);
        self.content_changed();
    }

    /// Returns the maximum `max_physical_extent` across all datasets.
    /// Used to apply a global normalization correction so multi-dataset
    /// scenes preserve relative physical sizes in 3D.
    ///
    /// Folds over the per-dataset maxima precomputed by
    /// [`build_derived_state`], so this is O(datasets) — cheap enough to sit
    /// inside [`Self::placement_correction`], which runs once per member on
    /// render-path passes. The maxima can only change when `derived` is
    /// rebuilt, so they are never stale mid-frame.
    pub fn global_max_physical_extent(&self) -> f64 {
        let max = self
            .derived
            .values()
            .map(|d| d.max_physical_extent)
            .fold(0.0_f64, f64::max);
        if max > 0.0 { max } else { 1.0 }
    }

    /// Returns the maximum physical Y extent across all datasets.
    /// Used to top-align datasets in 3D mode.
    ///
    /// O(datasets) via the precomputed per-dataset `max_physical_y`, same
    /// rationale as [`Self::global_max_physical_extent`].
    pub fn global_max_physical_y(&self) -> f64 {
        let max = self
            .derived
            .values()
            .map(|d| d.max_physical_y)
            .fold(0.0_f64, f64::max);
        if max > 0.0 { max } else { 1.0 }
    }

    /// The per-member **world placement matrix** (`[f32; 16]`, column-major):
    /// the scale-and-translate that maps the member's unit cube `[0,1]³` into the
    /// scene's normalized world space, including the member position, the 3D Y-flip,
    /// the multi-dataset global normalization (`global_max_physical_extent`), and
    /// the 3D top-alignment (`global_max_physical_y`).
    ///
    /// Returns the forward `model` of [`Self::rendering_transform`], so the
    /// renderer, minimap framing, and [`Self::dataset_world_bounds`] cannot
    /// drift from what is drawn. A member with no levels yields the identity.
    pub fn member_world_matrix(&self, member: &MemberState) -> [f32; 16] {
        self.rendering_transform(member).0.model
    }

    /// Every member's forward and inverse world matrix for one dataset: for
    /// member `i`, floats `i*32 .. i*32+16` are the forward `model` and
    /// `i*32+16 .. i*32+32` its `inv_model`, as [`Self::rendering_transform`]
    /// produces them.
    ///
    /// The flat layout lets a binding hand a whole collection's placement over
    /// in one crossing instead of two calls per member. Pair it with
    /// [`Self::member_render_ids`]. Empty for an unknown dataset.
    pub fn member_render_matrices(&self, dataset_id: &str) -> Vec<f32> {
        let ds_id = DatasetId(dataset_id.to_string());
        let Some(derived) = self.derived.get(&ds_id) else {
            return Vec::new();
        };
        let mut out = Vec::with_capacity(derived.members.len() * 32);
        for member in &derived.members {
            let (fwd, inv) = self.rendering_transform(member);
            out.extend_from_slice(&fwd.model);
            out.extend_from_slice(&inv.inv_model);
        }
        out
    }

    /// Image ids aligned with [`Self::member_render_matrices`]: entry `i`
    /// names the member whose matrices occupy floats `i*32 .. i*32+32`.
    /// Empty for an unknown dataset.
    pub fn member_render_ids(&self, dataset_id: &str) -> Vec<String> {
        let ds_id = DatasetId(dataset_id.to_string());
        let Some(derived) = self.derived.get(&ds_id) else {
            return Vec::new();
        };
        derived
            .members
            .iter()
            .map(|m| m.image_id.0.clone())
            .collect()
    }

    /// World-space bounds of a single dataset's members, never the union
    /// across datasets.
    ///
    /// Each member's unit-cube corners go through
    /// [`Self::rendering_transform`] into a [`crate::framing::Aabb`]. Returns
    /// `None` when no member has levels.
    pub fn dataset_world_bounds(&self, dataset_id: &str) -> Option<WorldBox> {
        let ds_id = DatasetId(dataset_id.to_string());
        let derived = self.derived.get(&ds_id)?;

        let mut aabb = crate::framing::Aabb::empty();
        for member in &derived.members {
            if member.levels.is_empty() {
                continue;
            }
            for corner in self.rendering_transform(member).0.world_corners() {
                aabb.add_point(corner);
            }
        }

        if aabb.is_empty() {
            None
        } else {
            Some(WorldBox::new(aabb.min, aabb.max))
        }
    }

    /// Bounds of a single dataset's members in voxel space, the space the
    /// [`Camera::Slice`] camera works in: the voxel twin of
    /// [`Self::dataset_world_bounds`].
    ///
    /// Each member with a level 0 contributes
    /// `[position[0], position[1], 0] .. [position[0] + X, position[1] + Y, Z]`
    /// from its level-0 shape, the voxel convention the slice-mode ray pick
    /// and chunk culling use. Returns `None` when no member has levels.
    pub fn dataset_voxel_bounds(&self, dataset_id: &str) -> Option<VoxBox> {
        let ds_id = DatasetId(dataset_id.to_string());
        let derived = self.derived.get(&ds_id)?;
        derived
            .members
            .iter()
            .filter_map(|member| {
                let level0 = member.levels.first()?;
                let [x0, y0] = member.position;
                Some(VoxBox::new(
                    [x0, y0, 0.0],
                    [
                        x0 + level0.shape[4] as f64,
                        y0 + level0.shape[3] as f64,
                        level0.shape[2] as f64,
                    ],
                ))
            })
            .reduce(VoxBox::union)
    }

    /// A dataset's bounds in both spaces, or `None` when it has none.
    pub fn dataset_bounds(&self, dataset_id: &str) -> Option<FitBounds> {
        Some(FitBounds {
            vox: self.dataset_voxel_bounds(dataset_id)?,
            world: self.dataset_world_bounds(dataset_id)?,
        })
    }

    /// The datasets a fit of everything visible covers: each one the document
    /// holds whose layer is shown.
    pub fn visible_dataset_ids(&self) -> impl Iterator<Item = &DatasetId> {
        self.document.manifests.keys().filter(|id| {
            self.dataset_settings
                .get(*id)
                .is_none_or(|settings| settings.visible)
        })
    }

    /// The union of every visible dataset's bounds, what a framed camera
    /// fits. `None` when nothing visible has bounds.
    pub fn visible_bounds(&self) -> Option<FitBounds> {
        self.visible_dataset_ids()
            .filter_map(|id| self.dataset_bounds(&id.0))
            .reduce(FitBounds::union)
    }

    /// The named dataset's box in the space the current camera works in, as
    /// `(min, max)`: voxel space with a zero Z extent for the slice camera,
    /// world space for a volume camera. `None` when it has no bounds.
    pub fn dataset_fit_bounds(&self, dataset_id: &str) -> Option<([f64; 3], [f64; 3])> {
        if let Camera::Slice(_) = self.camera {
            let b = self.dataset_voxel_bounds(dataset_id)?;
            Some(([b.min[0], b.min[1], 0.0], [b.max[0], b.max[1], 0.0]))
        } else {
            let b = self.dataset_world_bounds(dataset_id)?;
            Some((b.min, b.max))
        }
    }

    /// Fit the named dataset's full extent on the current canvas. See
    /// [`Self::frame`].
    pub fn fit_camera_to_dataset(&mut self, dataset_id: &str) -> bool {
        let viewport = self.camera.viewport();
        self.frame(
            &FrameTarget::Dataset(DatasetId(dataset_id.to_string())),
            viewport,
        )
    }

    /// Return aggregate bounds for all visible image members in scene XY space.
    pub fn visible_content_bounds_2d(&self) -> Option<VisibleContentBounds2D> {
        let mut bounds: Option<VisibleContentBounds2D> = None;

        for id in &self.dataset_order {
            self.accumulate_visible_dataset_bounds_2d(id, &mut bounds);
        }

        // Be tolerant of partially hydrated scenes where derived state exists
        // before dataset_order is fully populated.
        for id in self.derived.keys() {
            if !self.dataset_order.contains(id) {
                self.accumulate_visible_dataset_bounds_2d(id, &mut bounds);
            }
        }

        bounds
    }

    fn accumulate_visible_dataset_bounds_2d(
        &self,
        id: &DatasetId,
        bounds: &mut Option<VisibleContentBounds2D>,
    ) {
        let settings = self.dataset_settings.get(id).cloned().unwrap_or_default();
        if !settings.visible {
            return;
        }
        let Some(derived) = self.derived.get(id) else {
            return;
        };

        for member in &derived.members {
            let Some(level) = member.levels.first() else {
                continue;
            };
            let width = level.shape[4] as f64;
            let height = level.shape[3] as f64;
            if width <= 0.0 || height <= 0.0 {
                continue;
            }
            let candidate = VisibleContentBounds2D {
                min_x: member.position[0],
                min_y: member.position[1],
                max_x: member.position[0] + width,
                max_y: member.position[1] + height,
                max_depth: level.shape[2].min(u32::MAX as u64) as u32,
            };
            *bounds = Some(match *bounds {
                Some(existing) => VisibleContentBounds2D {
                    min_x: existing.min_x.min(candidate.min_x),
                    min_y: existing.min_y.min(candidate.min_y),
                    max_x: existing.max_x.max(candidate.max_x),
                    max_y: existing.max_y.max(candidate.max_y),
                    max_depth: existing.max_depth.max(candidate.max_depth),
                },
                None => candidate,
            });
        }
    }

    /// The chunks the first dataset's view needs, every member's in turn.
    pub fn chunk_plan(&self) -> Vec<ChunkCoord> {
        let Some(ds_id) = self.document.manifests.keys().next() else {
            return Vec::new();
        };
        self.chunk_plan_for(ds_id)
            .into_iter()
            .flatten()
            .flat_map(|member| member.needed)
            .collect()
    }

    /// Compute the chunk request plan for a specific dataset by ID.
    ///
    /// Returns one `MemberChunkPlan` per visible member.
    ///
    /// Every chunk of a member is at the member's target level, from
    /// [`Scene::member_target_level`]. That is the rule and the hysteresis
    /// history [`Scene::view_query`] reports as `target_level`, so this plan
    /// and the browser agree on the level for a camera. A scene that never
    /// ran [`Scene::view_query_delta`] applies the rule without history, and
    /// can sit one level away from a browser that zoomed to the same camera
    /// through a level boundary.
    ///
    /// For multi-member datasets (collections), each member's AABB is checked
    /// against the visible region, and chunk planning is done in
    /// member-local coordinates.
    pub fn chunk_plan_for(&self, dataset_id: &DatasetId) -> Option<Vec<MemberChunkPlan>> {
        let derived = self.derived.get(dataset_id)?;
        let manifest = self.document.manifests.get(dataset_id)?;

        let last_query = self.last_query_entries(dataset_id);
        let pin = self.level_pin(dataset_id);
        let multiscale_by_image = multiscale_by_image(manifest);
        let layer = self.resolved_layer(dataset_id)?;
        let channels = layer.channel_indices();

        let mut plans = Vec::new();
        for member in &derived.members {
            if member.levels.is_empty() {
                continue;
            }

            let level0 = &member.levels[0];
            let tile_w = level0.shape[4] as f64; // X
            let tile_h = level0.shape[3] as f64; // Y

            // Compute visible region using the member's volume transform.
            let vol_shape = [
                level0.shape[2] as u32,
                level0.shape[3] as u32,
                level0.shape[4] as u32,
            ];
            let region = self.camera.visible_region(
                &layer.z_range,
                Some(&member.volume_transform),
                Some(&vol_shape),
            );

            // AABB culling (same logic as current but using member.position)
            let pos_x = member.position[0];
            let pos_y = member.position[1];
            let member_max_x = pos_x + tile_w;
            let member_max_y = pos_y + tile_h;

            let [vis_min_x, vis_min_y, vis_max_x, vis_max_y] = region.xy_bounds;

            // AABB overlap test
            if member_max_x <= vis_min_x
                || pos_x >= vis_max_x
                || member_max_y <= vis_min_y
                || pos_y >= vis_max_y
            {
                continue; // member is fully outside the visible region
            }

            // Offset visible region by member position
            let local_region = crate::camera::VisibleRegion {
                xy_bounds: [
                    vis_min_x - pos_x,
                    vis_min_y - pos_y,
                    vis_max_x - pos_x,
                    vis_max_y - pos_y,
                ],
                z_range: region.z_range.clone(),
                effective_zoom: region.effective_zoom,
                radius_basis_vox: region.radius_basis_vox,
                sort_center: region
                    .sort_center
                    .map(|[cx, cy, cz]| [cx - pos_x, cy - pos_y, cz]),
                frustum_planes: region
                    .frustum_planes
                    .map(|planes| planes.map(|[a, b, c, d]| [a, b, c, d + a * pos_x + b * pos_y])),
            };

            let (level, _) = self.member_target_level(
                member,
                multiscale_by_image[&member.image_id],
                pin,
                self.member_pixels_per_sample(member),
                last_query,
            );
            let level_geo = &member.levels[level as usize];

            let query =
                ChunkQuery::new(level_geo, level0, [0.0, 0.0], chunk::RENDER_RADIUS_DISABLED);
            let mut cells = Vec::new();
            chunk::enumerate_chunks(
                &ChunkView::new(&local_region, 0.0),
                &query,
                &mut CullCounts::default(),
                &mut cells,
            );
            cells.sort_by(|a, b| a.distance.total_cmp(&b.distance));
            let needed = channels
                .iter()
                .flat_map(|&c| {
                    cells.iter().map(move |cell| ChunkCoord {
                        level,
                        x: cell.x,
                        y: cell.y,
                        z: cell.z,
                        t: layer.t,
                        c,
                    })
                })
                .collect();

            plans.push(MemberChunkPlan {
                image_id: member.image_id.clone(),
                position: member.position,
                target_level: level,
                needed,
            });
        }

        Some(plans)
    }

    /// The scene-global placement correction for one volume: the multi-dataset
    /// scale normalization (`max_physical_extent / global_max_physical_extent`)
    /// and the 3D top-alignment translation
    /// (`(global_max_physical_y - phys_y) / global_max`).
    ///
    /// The only owner of that arithmetic, so a policy change reaches the
    /// renderer, minimap, picking, and framing together.
    fn placement_correction(&self, t: &VolumeTransform) -> PlacementCorrection {
        let max_phys = if t.max_physical_extent > 0.0 {
            t.max_physical_extent
        } else {
            1.0
        };
        let global_max = self.global_max_physical_extent();
        let phys_y = t.model[5] as f64 * max_phys;
        let global_max_y = self.global_max_physical_y();
        PlacementCorrection {
            correction: max_phys / global_max,
            inv_correction: global_max / max_phys,
            top_align: (global_max_y - phys_y) / global_max,
        }
    }

    /// Build the rendering model matrix for a member — the same transform
    /// the GPU uses, including Y-flip, global normalization, and top-alignment.
    ///
    /// Returns (model, inv_model) in the camera's coordinate space.
    pub fn rendering_transform(&self, member: &MemberState) -> (VolumeTransform, VolumeTransform) {
        let level0 = match member.levels.first() {
            Some(l) => l,
            None => {
                let id = VolumeTransform {
                    model: [
                        1.0, 0.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 0.0,
                        1.0,
                    ],
                    inv_model: [
                        1.0, 0.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 0.0,
                        1.0,
                    ],
                    max_physical_extent: 1.0,
                };
                return (id.clone(), id);
            }
        };

        let t = &member.volume_transform;
        let max_phys = if t.max_physical_extent > 0.0 {
            t.max_physical_extent
        } else {
            1.0
        };
        let vol_shape = [
            level0.shape[2] as u32,
            level0.shape[3] as u32,
            level0.shape[4] as u32,
        ];

        // Recover voxel scale from volume transform
        let scale_x = if vol_shape[2] > 0 {
            t.model[0] as f64 * max_phys / vol_shape[2] as f64
        } else {
            1.0
        };
        let scale_y = if vol_shape[1] > 0 {
            t.model[5] as f64 * max_phys / vol_shape[1] as f64
        } else {
            1.0
        };
        let scale_z = if vol_shape[0] > 0 {
            t.model[10] as f64 * max_phys / vol_shape[0] as f64
        } else {
            1.0
        };

        // Y-flip for 3D (Y-up convention)
        let flipped_offset = [
            member.position[0],
            vol_shape[1] as f64 - member.position[1] - vol_shape[1] as f64,
        ];
        let mt = transform::compute_member_transform(
            vol_shape,
            [scale_z, scale_y, scale_x],
            flipped_offset,
            max_phys,
        );

        // Global correction for multi-dataset scenes
        let mut model = mt.model;
        let mut inv_model = mt.inv_model;
        self.placement_correction(t)
            .apply(&mut model, &mut inv_model);

        let fwd = VolumeTransform {
            model,
            inv_model: [0.0; 16],
            max_physical_extent: max_phys,
        };
        let inv = VolumeTransform {
            model: [0.0; 16],
            inv_model,
            max_physical_extent: max_phys,
        };
        (fwd, inv)
    }

    /// The dataset-level model matrix (column-major `[f32; 16]`): the first
    /// member's volume transform with the same correction and top-alignment as
    /// [`Self::rendering_transform`], but without the member's layout offset.
    /// The minimap projects orbit rays through it, and `ray_hit_local` uses the
    /// inverse to express hits in `[0,1]³`.
    ///
    /// Returns the identity for an unknown dataset or one with no members.
    pub fn dataset_model_matrix(&self, dataset_id: &str) -> [f32; 16] {
        self.dataset_placement_matrices(dataset_id).0
    }

    /// Inverse of [`Self::dataset_model_matrix`] (world space → the first
    /// member's `[0,1]³` unit space), built from the same
    /// [`Self::placement_correction`] so the pair composes to the identity.
    /// Returns the identity for an unknown dataset or one with no members.
    pub fn dataset_inv_model_matrix(&self, dataset_id: &str) -> [f32; 16] {
        self.dataset_placement_matrices(dataset_id).1
    }

    /// Shared body of [`Self::dataset_model_matrix`] /
    /// [`Self::dataset_inv_model_matrix`]: resolve the first member and fold
    /// the placement correction into its volume transform pair.
    fn dataset_placement_matrices(&self, dataset_id: &str) -> ([f32; 16], [f32; 16]) {
        let identity = [
            1.0, 0.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 0.0, 1.0,
        ];
        let ds_id = DatasetId(dataset_id.to_string());
        let member = self.derived.get(&ds_id).and_then(|d| d.members.first());
        let Some(m) = member else {
            return (identity, identity);
        };
        let t = &m.volume_transform;
        let mut model = t.model;
        let mut inv_model = t.inv_model;
        self.placement_correction(t)
            .apply(&mut model, &mut inv_model);
        (model, inv_model)
    }

    /// Pick the closest entity hit by a ray cast from screen coordinates.
    ///
    /// For Slice (2D) mode: tests the voxel-space ray against each member's
    /// voxel-space AABB (position + shape). The Slice camera operates in
    /// voxel coordinates, so the ray and member bounds are in the same space.
    ///
    /// For 3D modes (Arcball/Fly): uses the rendering transform (which
    /// includes Y-flip, global correction, and top-alignment) so the ray
    /// test matches what the camera actually sees.
    pub fn ray_pick(
        &self,
        dataset_id: &DatasetId,
        screen_x: f64,
        screen_y: f64,
    ) -> Option<crate::ray::RayHit> {
        let derived = self.derived.get(dataset_id)?;
        let world_ray = self.camera.unproject_ray(screen_x, screen_y);
        let is_2d = matches!(self.camera, Camera::Slice(_));
        let mut closest: Option<crate::ray::RayHit> = None;

        for member in &derived.members {
            let level0 = match member.levels.first() {
                Some(l) => l,
                None => continue,
            };

            let hit_result = if is_2d {
                // Slice mode: ray and member positions are both in voxel space.
                let pos_x = member.position[0];
                let pos_y = member.position[1];
                let tile_w = level0.shape[4] as f64;
                let tile_h = level0.shape[3] as f64;

                let rx = world_ray.origin[0];
                let ry = world_ray.origin[1];

                if rx >= pos_x && rx <= pos_x + tile_w && ry >= pos_y && ry <= pos_y + tile_h {
                    Some(([rx, ry, 0.0], 0.0))
                } else {
                    None
                }
            } else {
                // 3D mode: use rendering transform to match camera space.
                let (fwd, inv) = self.rendering_transform(member);

                let local_ray = crate::ray::transform_ray(&world_ray, &inv.inv_model);

                local_ray.intersect_unit_cube().map(|t| {
                    let hit_local = [
                        local_ray.origin[0] + t * local_ray.direction[0],
                        local_ray.origin[1] + t * local_ray.direction[1],
                        local_ray.origin[2] + t * local_ray.direction[2],
                    ];
                    let hit_world = crate::ray::transform_point(&hit_local, &fwd.model);
                    let dx = hit_world[0] - world_ray.origin[0];
                    let dy = hit_world[1] - world_ray.origin[1];
                    let dz = hit_world[2] - world_ray.origin[2];
                    (hit_world, (dx * dx + dy * dy + dz * dz).sqrt())
                })
            };

            if let Some((hit_world, distance)) = hit_result
                && closest.as_ref().is_none_or(|c| distance < c.distance)
            {
                closest = Some(crate::ray::RayHit {
                    entity_id: member.entity_id.clone(),
                    image_id: member.image_id.clone(),
                    world_position: hit_world,
                    distance,
                });
            }
        }

        closest
    }

    // A pin's stored world point `(position[0], position[1], z)` is in the 2D
    // pin frame: in-plane voxels plus voxel depth (x right, y down, z = slice
    // index). The helpers below convert it to and from arcball world space by
    // reusing `rendering_transform` and the camera's own `project_to_screen` /
    // `ray_pick`, so a marker tracks the volume exactly and a depth pick is the
    // exact inverse of the projection that draws it.

    /// Resolve the first member of `dataset_id`, with its level-0 voxel shape
    /// `[X, Y, Z]`. Pins are dataset-scoped and anchored against the dataset's
    /// primary member (the same member `ray_pick`/`view_query` treat as the
    /// volume), so depth is consistent between drop and render.
    fn annotation_member(&self, dataset_id: &DatasetId) -> Option<(&MemberState, [f64; 3])> {
        let derived = self.derived.get(dataset_id)?;
        let member = derived.members.first()?;
        let level0 = member.levels.first()?;
        let shape = [
            level0.shape[4] as f64, // X
            level0.shape[3] as f64, // Y
            level0.shape[2] as f64, // Z
        ];
        Some((member, shape))
    }

    /// Map an in-plane-voxel + voxel-depth pin point to arcball-world space
    /// using the dataset's rendering transform. Image-convention Y (0 = top) is
    /// flipped to the renderer's Y-up unit cube exactly like
    /// `ray_hit_local_image` does in reverse, so a pin drawn here lands where
    /// the matching voxel is drawn in the volume.
    fn annotation_world_point(
        &self,
        member: &MemberState,
        shape: [f64; 3],
        point: [f64; 3],
    ) -> [f64; 3] {
        let (fwd, _) = self.rendering_transform(member);
        let ux = if shape[0] > 0.0 {
            point[0] / shape[0]
        } else {
            0.0
        };
        // Image y-down -> unit y-up.
        let uy = if shape[1] > 0.0 {
            1.0 - point[1] / shape[1]
        } else {
            0.0
        };
        let uz = if shape[2] > 0.0 {
            point[2] / shape[2]
        } else {
            0.0
        };
        crate::ray::transform_point(&[ux, uy, uz], &fwd.model)
    }

    /// Project a pin's stored world point `(x, y, z)` (in-plane voxel + voxel
    /// depth) to screen-space pixels through the active camera.
    ///
    /// In 2D slice mode this is the in-plane projection, depth ignored. In a 3D
    /// mode the point is first lifted to arcball world via the rendering
    /// transform, so the marker tracks the volume as the camera orbits.
    /// Returns `None` when the point is behind the camera or the dataset has no
    /// anchorable member; the caller then hides the marker.
    pub fn project_annotation(
        &self,
        dataset_id: &DatasetId,
        x: f64,
        y: f64,
        z: f64,
    ) -> Option<[f64; 2]> {
        if matches!(self.camera, Camera::Slice(_)) {
            // 2D: keep the long-standing in-plane behavior verbatim.
            return self.camera.project_to_screen([x, y, z]);
        }
        let (member, shape) = self.annotation_member(dataset_id)?;
        let world = self.annotation_world_point(member, shape, [x, y, z]);
        self.camera.project_to_screen(world)
    }

    /// Lift a pin's stored voxel point `(x, y, z)` to arcball world space, the
    /// same lift [`Self::project_annotation`] does before projecting. Returns
    /// `None` for an unknown or unanchorable dataset.
    ///
    /// `CenterOnVoxel3D` targets this point, so the recenter and the marker
    /// projection share one definition of the pin's world position.
    pub(crate) fn annotation_world_point_for(
        &self,
        dataset_id: &DatasetId,
        point: [f64; 3],
    ) -> Option<[f64; 3]> {
        let (member, shape) = self.annotation_member(dataset_id)?;
        Some(self.annotation_world_point(member, shape, point))
    }

    /// Depth pick for a pin dropped in a 3D view: ray-cast from screen into the
    /// volume and return the hit as an in-plane-voxel + voxel-depth point
    /// `[x, y, z]`, ready to store as `(position, z)`. This is the exact inverse
    /// of [`Self::annotation_world_point`] (so the new marker re-projects to the
    /// cursor), built on the shared `ray_pick`. Returns `None` if the ray misses
    /// the volume; the caller then declines to drop a pin into empty space.
    pub fn pick_annotation_voxel(
        &self,
        dataset_id: &DatasetId,
        screen_x: f64,
        screen_y: f64,
    ) -> Option<[f64; 3]> {
        let hit = self.ray_pick(dataset_id, screen_x, screen_y)?;
        let (member, shape) = self.annotation_member(dataset_id)?;
        let (_, inv) = self.rendering_transform(member);
        // World -> unit cube, then unit -> image-convention voxel (un-flip Y).
        let unit = crate::ray::transform_point(&hit.world_position, &inv.inv_model);
        let vx = unit[0] * shape[0];
        let vy = (1.0 - unit[1]) * shape[1];
        let vz = unit[2] * shape[2];
        Some([vx, vy, vz])
    }

    /// Replace the document portion (content graphs) wholesale, preserving the
    /// local camera/view/display, then make every document-derived piece of
    /// state consistent with it:
    ///
    /// - `derived` is rebuilt for all manifests (via [`Self::rebuild_derived`]).
    /// - `dataset_order` gains any restored dataset it did not list and drops
    ///   ids missing from the document.
    /// - `dataset_settings` is seeded for each new manifest with
    ///   [`DatasetDisplaySettings::seeded_for`], not a bare `Default`, which has
    ///   no channel or label entries for the layer panel to render. Existing
    ///   entries are kept; entries for removed datasets are pruned.
    ///
    /// It bumps every document-scoped epoch (`content`, `layout`,
    /// `annotation`) plus `selection`. `view` bumps only when the camera
    /// reframed: a placed camera is untouched, and a framed or unframed one
    /// fits the loaded content, so a page that joins an open dataset shows it
    /// fitted.
    pub fn load_document(&mut self, doc: DocumentState) {
        self.document = doc;
        self.rebuild_derived();

        for id in self.document.manifests.keys().cloned().collect::<Vec<_>>() {
            if !self.dataset_order.contains(&id) {
                self.dataset_order.push(id.clone());
            }
            if !self.dataset_settings.contains_key(&id) {
                let seeded = self
                    .document
                    .manifests
                    .get(&id)
                    .map(DatasetDisplaySettings::seeded_for)
                    .unwrap_or_default();
                self.dataset_settings.insert(id, seeded);
            }
        }
        let dataset_ids: std::collections::HashSet<&DatasetId> =
            self.document.manifests.keys().collect();
        self.dataset_order.retain(|id| dataset_ids.contains(id));
        self.dataset_settings
            .retain(|id, _| dataset_ids.contains(id));
        self.view_query_cursors
            .retain(|id, _| dataset_ids.contains(id));

        // Kept settings may have been adopted from a peer whose label list
        // differs; realign them to the restored manifest's labels by name.
        // Entries without `label_names` stay positional.
        for (id, settings) in self.dataset_settings.iter_mut() {
            if settings.label_names.is_empty() {
                continue;
            }
            if let Some(manifest) = self.document.manifests.get(id) {
                let current: Vec<String> = manifest
                    .label_specs()
                    .iter()
                    .map(|l| l.name.clone())
                    .collect();
                if settings.label_names != current {
                    settings.label_settings = DatasetDisplaySettings::reconcile_label_settings(
                        &settings.label_settings,
                        &settings.label_names,
                        &current,
                    );
                    settings.label_names = current;
                }
            }
        }

        self.epochs.content += 1;
        self.epochs.layout += 1;
        self.epochs.annotation += 1;
        self.epochs.selection += 1;
        self.content_changed();
    }

    /// Adopt another client's camera + view + display: follow, and every
    /// restore of a stored view. A placed camera keeps the region it showed on
    /// the canvas it came from, fitted to this scene's viewport
    /// ([`Camera::fit_region_to_viewport`]), so a view crosses pixel ratios and
    /// canvas shapes without changing what it shows. A framed or unframed one
    /// fits this scene's visible datasets on this canvas instead, so a fit
    /// made on a wide canvas fills a tall one.
    ///
    /// A camera of the other family parks the one it replaces, as a mode
    /// switch does.
    ///
    /// The fit reads this scene's viewport, so a caller that has not ticked
    /// since the canvas last resized asserts its size first.
    ///
    /// A view recorded before solo was per layer carries a scene-wide channel
    /// mode, which lands here as each layer's solo.
    ///
    /// `epochs.view` bumps iff the camera changed, and `epochs.selection` iff
    /// view, display or a solo changed, so an unchanged presence heartbeat does
    /// not invalidate consumers' caches but a real remote camera move does.
    pub fn import_presence(&mut self, camera: Camera, view: ViewState, display: DisplayState) {
        let mut view = view;
        if let Some(legacy) = view.take_legacy_channels()
            && self.adopt_legacy_channels(legacy)
        {
            self.epochs.selection += 1;
        }
        let mut camera = camera;
        // A follow target must not hand this scene state its own mutators could
        // never produce, such as a `zoom: 0.0` that would NaN-poison the next
        // pan. Sanitize is bit-preserving in range and both fits are pure
        // functions of their inputs, so the equality check below still sees
        // an unchanged re-import as unchanged.
        camera.sanitize();
        camera.fit_region_to_viewport(self.camera.viewport());
        let before = self.camera.clone();
        let previous = std::mem::replace(&mut self.camera, camera);
        if previous.is_volume() != self.camera.is_volume() {
            self.parked_camera = Some(previous);
        }
        self.reframe();
        if self.camera != before {
            self.epochs.view += 1;
        }
        if self.view != view || self.display != display {
            self.view = view;
            self.display = display;
            self.epochs.selection += 1;
        }
    }

    /// Adopt another client's dataset ordering + per-dataset display settings
    /// (the layer-panel half of follow mode), merged per dataset known to both
    /// sides:
    ///
    /// - The peer's order sets the place of every dataset it lists that this
    ///   document holds. Datasets it doesn't list keep their relative order
    ///   after those.
    /// - The peer's settings replace this scene's for each dataset this
    ///   document holds. A dataset only this scene has keeps its settings.
    /// - Entries for datasets this document lacks are dropped, so a peer's
    ///   stale presence can't add a dataset here. An empty blob changes nothing.
    ///
    /// Bumps `epochs.selection` iff something actually changed — the epoch the
    /// per-dataset display commands bump — so consumers re-read settings
    /// without an unchanged rebroadcast forcing a replan.
    pub fn import_dataset_presence(
        &mut self,
        dataset_order: Vec<DatasetId>,
        dataset_settings: HashMap<DatasetId, DatasetDisplaySettings>,
    ) {
        let manifests = &self.document.manifests;
        let mut order: Vec<DatasetId> = Vec::with_capacity(self.dataset_order.len());
        let peer_known = dataset_order
            .into_iter()
            .filter(|id| manifests.contains_key(id));
        for id in peer_known.chain(self.dataset_order.iter().cloned()) {
            if !order.contains(&id) {
                order.push(id);
            }
        }

        let mut settings = self.dataset_settings.clone();
        for (id, mut incoming) in dataset_settings {
            let Some(manifest) = manifests.get(&id) else {
                continue;
            };
            // Remap the peer blob onto this scene's label order by name. A blob
            // without `label_names`, from an older peer, stays positional.
            if !incoming.label_names.is_empty() {
                let current: Vec<String> = manifest
                    .label_specs()
                    .iter()
                    .map(|l| l.name.clone())
                    .collect();
                incoming.label_settings = DatasetDisplaySettings::reconcile_label_settings(
                    &incoming.label_settings,
                    &incoming.label_names,
                    &current,
                );
                incoming.label_names = current;
            }
            settings.insert(id, incoming);
        }

        if self.dataset_order != order || self.dataset_settings != settings {
            let visible_before = self.visible_set();
            self.dataset_order = order;
            self.dataset_settings = settings;
            self.epochs.selection += 1;
            self.visibility_changed(visible_before);
        }
    }

    /// The visible datasets, to compare across a settings change.
    pub(crate) fn visible_set(&self) -> Vec<DatasetId> {
        self.visible_dataset_ids().cloned().collect()
    }

    /// Reframe when the visible datasets differ from `before`, since a framed
    /// camera fits exactly those. Bumps `epochs.view` when the camera changed.
    pub(crate) fn visibility_changed(&mut self, before: Vec<DatasetId>) {
        if self.visible_set() != before && self.reframe() {
            self.epochs.view += 1;
        }
    }

    /// Rebuild derived state from the document's dataset manifests.
    /// Call this after deserializing a Scene (since derived is not serialized).
    pub fn rebuild_derived(&mut self) {
        self.derived.clear();
        for (id, manifest) in &self.document.manifests {
            let layout = resolve_layout(
                manifest,
                self.document.registered_layouts.get(id),
                self.document.active_layout_ids.get(id),
            );
            self.derived
                .insert(id.clone(), build_derived_state(manifest, &layout));
        }
    }

    /// A dataset's layouts, source then registered, each marked with whether
    /// the dataset shows it now. That is the layout [`resolve_layout`] picked,
    /// so a fallback to the default counts, and a first match shadows a later
    /// layout with the same id.
    pub fn available_layouts(&self, dataset_id: &DatasetId) -> Vec<AvailableLayout> {
        let shown = self.derived.get(dataset_id).map(|d| &d.active_layout.id);
        let source = self
            .document
            .manifests
            .get(dataset_id)
            .map(|manifest| manifest.source_layouts())
            .unwrap_or_default();
        let registered = self
            .document
            .registered_layouts
            .get(dataset_id)
            .map(Vec::as_slice)
            .unwrap_or_default();
        let mut marked = false;
        source
            .iter()
            .chain(registered)
            .map(|layout| {
                let active = !marked && shown == Some(&layout.id);
                marked |= active;
                AvailableLayout {
                    id: layout.id.clone(),
                    name: layout.name.clone(),
                    active,
                }
            })
            .collect()
    }

    /// The box the renderer draws for `member`, as one transform with both
    /// directions filled in. [`Scene::rendering_transform`] returns the two
    /// halves. The camera projects and measures against this.
    fn placed_transform(&self, member: &MemberState) -> VolumeTransform {
        let (forward, inverse) = self.rendering_transform(member);
        VolumeTransform {
            model: forward.model,
            inv_model: inverse.inv_model,
            max_physical_extent: forward.max_physical_extent,
        }
    }

    /// Device pixels per level-0 sample of `member`, the measure its target
    /// level is chosen from. A slice view spaces every sample `zoom` device
    /// pixels apart. A volume view measures where the center-screen ray meets
    /// the box the renderer draws for the member, so a scene-global placement
    /// correction counts.
    fn member_pixels_per_sample(&self, member: &MemberState) -> f64 {
        match self.camera {
            Camera::Slice(_) => self.camera.effective_zoom(),
            _ => self
                .camera
                .pixels_per_sample(&self.placed_transform(member), level0_shape(member)),
        }
    }

    /// The quantized record per image that the last [`Scene::view_query_delta`]
    /// for `dataset_id` left behind, when it still describes the current
    /// membership base and camera family. `None` without such a query.
    fn last_query_entries(
        &self,
        dataset_id: &DatasetId,
    ) -> Option<&HashMap<ImageId, QuantizedEntity>> {
        self.view_query_cursors
            .get(dataset_id)
            .filter(|c| c.matches(&self.epochs, CameraModeKind::of(&self.camera)))
            .map(|c| &c.entries)
    }

    /// The level the screen calls for in `member`. Applies
    /// [`crate::target_level::target_level`] to `pixels_per_sample` and the
    /// member's level geometry along the axes the camera resolves.
    ///
    /// `last_query` is [`Scene::last_query_entries`] for the member's dataset.
    /// The level it holds for the member while on screen is the hysteresis
    /// history. A parked off-screen level is not history, so a member coming
    /// back into view starts fresh, as does a scene that never ran a delta
    /// query.
    fn screen_target_level(
        &self,
        member: &MemberState,
        pixels_per_sample: f64,
        last_query: Option<&HashMap<ImageId, QuantizedEntity>>,
    ) -> u32 {
        let previous = last_query
            .and_then(|entries| entries.get(&member.image_id))
            .filter(|entry| entry.visible)
            .map(|entry| entry.target_level);
        let axes: &[usize] = match self.camera {
            Camera::Slice(_) => &IN_PLANE_AXES,
            _ => &VOLUME_AXES,
        };
        let ratios = level_shape_ratios(&member.levels, axes);
        target_level::target_level(
            pixels_per_sample * self.render_ratio_scale(),
            &ratios,
            previous,
        )
    }

    /// The share of device pixels the render target keeps. A browser draws at
    /// no more than [`MAX_RENDER_PIXEL_RATIO`], so a level finer than that
    /// density shows would be fetched and never seen. The adaptive scale a
    /// long gesture applies on top is left out, so the level holds still
    /// mid-gesture.
    fn render_ratio_scale(&self) -> f64 {
        match self.pixel_ratio {
            Some(ratio) if ratio > MAX_RENDER_PIXEL_RATIO => MAX_RENDER_PIXEL_RATIO / ratio,
            _ => 1.0,
        }
    }

    /// The dataset's level pin, as stored. `None` means the target follows
    /// the screen.
    fn level_pin(&self, dataset_id: &DatasetId) -> Option<u32> {
        self.dataset_settings
            .get(dataset_id)
            .and_then(|settings| settings.detail_level_override)
    }

    /// The target level of `member`, the level its detail tier requests, and
    /// whether it is the pin rather than the screen's choice.
    ///
    /// The dataset's level pin wins when it has one. Otherwise it is the level
    /// the screen calls for, from [`Scene::screen_target_level`]. Either is
    /// clamped to the member's source levels by the one rule,
    /// [`MultiscaleInfo::clamp_to_source_levels`]. The clamp runs per member
    /// for two reasons. The pin command clamps against the first image only,
    /// and settings imported from a peer or a saved view arrive as they are.
    /// The screen rule ranks every level the pyramid lists, so zoomed far out
    /// it names a generated coarse level, which belongs to the coarse tier and
    /// is never a target.
    ///
    /// A pinned level is also the history the screen rule resumes from once
    /// the pin is cleared. Clearing a pin one level away from the screen's
    /// choice, with the measure inside the hysteresis band, therefore holds
    /// the pinned level until the measure leaves the band, as a zoom to that
    /// point would.
    fn member_target_level(
        &self,
        member: &MemberState,
        multiscale: &MultiscaleInfo,
        pin: Option<u32>,
        pixels_per_sample: f64,
        last_query: Option<&HashMap<ImageId, QuantizedEntity>>,
    ) -> (u32, bool) {
        if let Some(pinned) = pin.and_then(|pin| multiscale.clamp_to_source_levels(pin)) {
            return (pinned, true);
        }
        let screen = self.screen_target_level(member, pixels_per_sample, last_query);
        (
            multiscale.clamp_to_source_levels(screen).unwrap_or(screen),
            false,
        )
    }

    /// The levels a level pin on `dataset_id` may hold: the source levels of
    /// its first image, level 0 included, with generated coarse levels left
    /// out because they belong to the coarse tier. The same image the pin
    /// command clamps against. Empty for an unknown dataset.
    pub fn pinnable_levels(&self, dataset_id: &DatasetId) -> Vec<u32> {
        self.document
            .manifests
            .get(dataset_id)
            .and_then(|manifest| manifest.images().first())
            .map(|image| image.multiscale.selectable_detail_levels())
            .unwrap_or_default()
    }

    /// Query the scene for geometric information about all entities in a dataset
    /// from the current camera viewpoint.
    ///
    /// Each record's `target_level` comes from [`Scene::member_target_level`],
    /// the dataset's level pin when it has one and otherwise
    /// [`crate::target_level::target_level`] applied to the camera's
    /// [`Camera::pixels_per_sample`] measure and the image's level geometry,
    /// either clamped to the image's source levels. The hysteresis history
    /// the rule takes is the level this scene last reported for the record
    /// through [`Scene::view_query_delta`], so a full query agrees with the
    /// delta a caller is folding. A caller that only ever asks for full
    /// queries has no history and gets the rule without hysteresis.
    pub fn view_query(&self, dataset_id: &DatasetId) -> Option<ViewQueryResult> {
        let derived = self.derived.get(dataset_id)?;
        let manifest = self.document.manifests.get(dataset_id)?;
        let vp = self.camera.viewport();
        let eye = self.camera.eye_position();
        let pin = self.level_pin(dataset_id);
        let multiscale_by_image = multiscale_by_image(manifest);

        // Entity id → kind, first occurrence winning (same entity a linear
        // front-to-back scan would find), so the per-member kind lookup below
        // is O(1) rather than O(entities) per member.
        let mut kind_by_entity: HashMap<&EntityId, &EntityKind> =
            HashMap::with_capacity(manifest.entities().len());
        for entity in manifest.entities() {
            kind_by_entity.entry(&entity.id).or_insert(&entity.kind);
        }

        let mut results = Vec::with_capacity(derived.members.len());

        let is_2d = matches!(self.camera, Camera::Slice(_));
        let last_query = self.last_query_entries(dataset_id);

        for member in &derived.members {
            let pos = member.position;

            // Compute screen-space bounding box.
            // 2D: corners in voxel space (pos to pos+tile_size).
            // 3D: corners from rendering_transform (includes position, Y-flip, global correction).
            let mut screen_min = [f64::MAX, f64::MAX];
            let mut screen_max = [f64::MIN, f64::MIN];
            let mut any_visible = false;

            let centroid;

            let pixels_per_sample = if is_2d {
                let level0 = member.levels.first();
                let (fw, fh, fd) = level0
                    .map(|l| (l.shape[4] as f64, l.shape[3] as f64, l.shape[2] as f64))
                    .unwrap_or((1.0, 1.0, 1.0));
                centroid = [pos[0] + fw / 2.0, pos[1] + fh / 2.0, fd / 2.0];
                let corners = [
                    [pos[0], pos[1], 0.0],
                    [pos[0] + fw, pos[1], 0.0],
                    [pos[0], pos[1] + fh, 0.0],
                    [pos[0] + fw, pos[1] + fh, 0.0],
                ];
                for corner in &corners {
                    if let Some([sx, sy]) = self.camera.project_to_screen(*corner) {
                        screen_min[0] = screen_min[0].min(sx);
                        screen_min[1] = screen_min[1].min(sy);
                        screen_max[0] = screen_max[0].max(sx);
                        screen_max[1] = screen_max[1].max(sy);
                        any_visible = true;
                    }
                }
                self.camera.effective_zoom()
            } else {
                let placed = self.placed_transform(member);
                let corners = placed.world_corners();
                centroid = placed.world_centroid();
                for corner in &corners {
                    if let Some([sx, sy]) = self.camera.project_to_screen(*corner) {
                        screen_min[0] = screen_min[0].min(sx);
                        screen_min[1] = screen_min[1].min(sy);
                        screen_max[0] = screen_max[0].max(sx);
                        screen_max[1] = screen_max[1].max(sy);
                        any_visible = true;
                    }
                }
                self.camera.pixels_per_sample(&placed, level0_shape(member))
            };

            // Check if screen rect overlaps viewport
            let visible = any_visible
                && screen_max[0] > 0.0
                && screen_max[1] > 0.0
                && screen_min[0] < vp[0] as f64
                && screen_min[1] < vp[1] as f64;

            let (projected_diagonal_px, projected_area_px2) = if visible {
                let w = (screen_max[0] - screen_min[0]).max(0.0);
                let h = (screen_max[1] - screen_min[1]).max(0.0);
                ((w * w + h * h).sqrt(), w * h)
            } else {
                (0.0, 0.0)
            };

            let (level, level_pinned) = if visible {
                self.member_target_level(
                    member,
                    multiscale_by_image[&member.image_id],
                    pin,
                    pixels_per_sample,
                    last_query,
                )
            } else {
                ((member.levels.len() as u32).saturating_sub(1), false)
            };

            // Distance from camera
            let dx = centroid[0] - eye[0];
            let dy = centroid[1] - eye[1];
            let dz = centroid[2] - eye[2];
            let distance = (dx * dx + dy * dy + dz * dz).sqrt();

            // Importance: larger on screen + closer = more important
            let importance = if distance > 1e-6 {
                projected_area_px2 / distance
            } else {
                projected_area_px2
            };

            // Determine entity kind
            let kind = kind_by_entity
                .get(&member.entity_id)
                .map(|k| (*k).clone())
                .unwrap_or(EntityKind::Image);

            results.push(EntityQueryResult {
                entity_id: member.entity_id.clone(),
                image_id: member.image_id.clone(),
                kind,
                visible,
                projected_diagonal_px,
                projected_area_px2,
                centroid_world: centroid,
                target_level: level,
                level_pinned,
                importance,
            });
        }

        // Sort by importance descending
        results.sort_by(|a, b| {
            b.importance
                .partial_cmp(&a.importance)
                .unwrap_or(std::cmp::Ordering::Equal)
        });

        Some(ViewQueryResult {
            epochs: self.epochs.clone(),
            visible_entities: results,
        })
    }

    /// Incremental counterpart to [`Scene::view_query`].
    ///
    /// The first query for a dataset, a query after the membership base was
    /// rebuilt (a move in the content or layout epoch), and a query
    /// after the camera changed geometry family all return
    /// [`ViewQueryDelta::Full`] — a complete snapshot that also (re)seeds this
    /// dataset's cursor. Any other query returns [`ViewQueryDelta::Delta`]
    /// describing only the entities that entered, left, or whose quantized
    /// state changed since the previous query.
    ///
    /// The per-entity records are produced by [`Scene::view_query`] itself, so
    /// they are byte-for-byte what a full query would report. The delta only
    /// decides *which* of those records to carry. Returns `None` exactly when
    /// [`Scene::view_query`] would (an unknown dataset).
    ///
    /// Each dataset keeps an independent cursor, so datasets resync on their
    /// own schedule. A resync fully drops the prior snapshot before reseeding,
    /// so an entity that leaves and later returns arrives in `entered` with a
    /// full record rather than being silently retained.
    ///
    /// A delta reports only quantized changes; see [`ViewQueryDelta`] for the
    /// tracked set and the two obligations it places on consumers. In short: a
    /// record's continuous fields may be stale while it is absent from deltas, so
    /// a decision derived from a continuous field (a discrete choice keyed off a
    /// projected size, say) must be recomputed by the consumer rather than
    /// inferred from delta membership; and selection or structural changes surface
    /// only through the returned `epochs`, not through entered/left/changed.
    pub fn view_query_delta(&mut self, dataset_id: &DatasetId) -> Option<ViewQueryDelta> {
        // Reuse the full projection verbatim: the records the delta hands back
        // are exactly what a full query produces this frame.
        let result = self.view_query(dataset_id)?;

        let content = self.epochs.content;
        let layout = self.epochs.layout;
        let mode = CameraModeKind::of(&self.camera);

        // A cursor whose structural epochs and camera family match the current
        // scene describes the same projection space, so a difference against it
        // is meaningful. Anything else — no cursor, a rebuilt membership base,
        // or a camera-family change — forces a full resync. When in doubt, a
        // full snapshot is slow-but-correct; a delta computed across a changed
        // base could ship a wrong tile.
        let can_delta = self
            .view_query_cursors
            .get(dataset_id)
            .is_some_and(|c| c.matches(&self.epochs, mode));

        let new_entries: HashMap<ImageId, QuantizedEntity> = result
            .visible_entities
            .iter()
            .map(|e| (e.image_id.clone(), QuantizedEntity::of(e)))
            .collect();

        if !can_delta {
            self.view_query_cursors.insert(
                dataset_id.clone(),
                ViewQueryCursor {
                    content,
                    layout,
                    mode,
                    entries: new_entries,
                },
            );
            return Some(ViewQueryDelta::Full(result));
        }

        let epochs = result.epochs.clone();

        let (entered, left, changed) = {
            // Present because `can_delta` is true.
            let cursor = &self.view_query_cursors[dataset_id];
            view_query_diff(&cursor.entries, &result.visible_entities, &new_entries)
        };

        self.view_query_cursors.insert(
            dataset_id.clone(),
            ViewQueryCursor {
                content,
                layout,
                mode,
                entries: new_entries,
            },
        );

        Some(ViewQueryDelta::Delta {
            epochs,
            entered,
            left,
            changed,
        })
    }
}

/// Each image's multiscale by image id, for the per-member level clamp. Every
/// member of the dataset's derived state is built from one of these images,
/// so a lookup by a member's image id always lands.
fn multiscale_by_image(manifest: &DatasetManifest) -> HashMap<&ImageId, &MultiscaleInfo> {
    manifest
        .images()
        .iter()
        .map(|image| (&image.image_id, &image.multiscale))
        .collect()
}

/// The `[z, y, x]` sample counts of `member` at level 0, or a unit box for a
/// member with no levels.
fn level0_shape(member: &MemberState) -> [u32; 3] {
    member.levels.first().map_or([1, 1, 1], |l| {
        [l.shape[2] as u32, l.shape[3] as u32, l.shape[4] as u32]
    })
}

/// Classify the current query against the prior snapshot into the delta
/// vectors, each ordered by `image_id`.
///
/// Records are keyed by their unique `image_id`, never `entity_id` — an entity
/// can own several images (each its own member/record with its own pyramid
/// depth), so keying on `entity_id` would collapse distinct records and lose
/// their individual `target_level`.
///
/// - `entered`: a current record whose `image_id` is absent from `prev`.
/// - `changed`: a current record whose `image_id` is in `prev` with a differing
///   quantized state.
/// - `left`: a `prev` `image_id` absent from the current set (`new_entries`).
///
/// `new_entries` is the current set already reduced to quantized state and
/// keyed by `image_id`, passed in so the caller can reuse it to reseed the
/// cursor without rebuilding it.
fn view_query_diff(
    prev: &HashMap<ImageId, QuantizedEntity>,
    current: &[EntityQueryResult],
    new_entries: &HashMap<ImageId, QuantizedEntity>,
) -> (Vec<EntityQueryResult>, Vec<ImageId>, Vec<EntityQueryResult>) {
    let mut entered = Vec::new();
    let mut changed = Vec::new();
    for entry in current {
        match prev.get(&entry.image_id) {
            None => entered.push(entry.clone()),
            Some(before) if *before != QuantizedEntity::of(entry) => changed.push(entry.clone()),
            Some(_) => {}
        }
    }

    let mut left: Vec<ImageId> = prev
        .keys()
        .filter(|id| !new_entries.contains_key(*id))
        .cloned()
        .collect();

    entered.sort_by(|a, b| a.image_id.0.cmp(&b.image_id.0));
    changed.sort_by(|a, b| a.image_id.0.cmp(&b.image_id.0));
    left.sort_by(|a, b| a.0.cmp(&b.0));

    (entered, left, changed)
}

/// One entry of [`Scene::available_layouts`].
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct AvailableLayout {
    pub id: LayoutId,
    pub name: String,
    pub active: bool,
}

/// Resolve which layout to use for a dataset.
///
/// Search order:
/// 1. If `active_id` is Some, search source_layouts then registered for matching ID
/// 2. Otherwise use `manifest.default_layout_id` to search source_layouts
/// 3. Fallback to first source layout
/// 4. Fallback to empty LayoutSpec
pub fn resolve_layout(
    manifest: &DatasetManifest,
    registered: Option<&Vec<LayoutSpec>>,
    active_id: Option<&LayoutId>,
) -> LayoutSpec {
    if let Some(id) = active_id {
        // Search source layouts first
        if let Some(layout) = manifest.source_layouts().iter().find(|l| &l.id == id) {
            return layout.clone();
        }
        // Then registered layouts
        if let Some(layouts) = registered
            && let Some(layout) = layouts.iter().find(|l| &l.id == id)
        {
            return layout.clone();
        }
    }

    // Fallback: use default_layout_id from the manifest
    manifest
        .default_layout_id
        .as_ref()
        .and_then(|id| manifest.source_layouts().iter().find(|l| &l.id == id))
        .or_else(|| manifest.source_layouts().first())
        .cloned()
        .unwrap_or_else(|| LayoutSpec {
            id: LayoutId("default".into()),
            name: "Default".into(),
            placements: vec![],
        })
}

pub fn build_derived_state(manifest: &DatasetManifest, layout: &LayoutSpec) -> DatasetDerivedState {
    let active_layout = layout.clone();

    // One position index for the whole rebuild: resolving every image through
    // it is O(placements + entities + transforms + images) total, where the
    // per-image scans of `find_entity_position` would make a wide collection's
    // rebuild quadratic in its member count.
    let position_index =
        LayoutPositionIndex::new(&active_layout, manifest.entities(), manifest.transforms());

    // Build per-image member state
    let mut members = Vec::new();
    let mut volume_transforms = HashMap::new();

    for image in manifest.images() {
        // Find position from layout placements
        let position = position_index.resolve(&image.owner).unwrap_or([0.0, 0.0]);

        // Compute volume transform from level 0 geometry
        let vt = if let Some(level0) = image.multiscale.levels.first() {
            let shape_3d = [
                level0.shape[2] as u32,
                level0.shape[3] as u32,
                level0.shape[4] as u32,
            ];
            let scale_3d = [level0.scale[2], level0.scale[3], level0.scale[4]];
            transform::compute_volume_transform(shape_3d, scale_3d)
        } else {
            VolumeTransform {
                model: [
                    1.0, 0.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 0.0, 1.0,
                ],
                inv_model: [
                    1.0, 0.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 0.0, 1.0,
                ],
                max_physical_extent: 1.0,
            }
        };

        volume_transforms.insert(image.image_id.clone(), vt.clone());

        members.push(MemberState {
            entity_id: image.owner.clone(),
            image_id: image.image_id.clone(),
            position,
            volume_transform: vt,
            levels: image.multiscale.levels.clone(),
            data_type: image.multiscale.data_type,
        });
    }

    // Id → index (first occurrence wins, both id namespaces) and the
    // per-dataset extent maxima the scene-global placement correction folds
    // over. Derived entirely from `members`, so they can never disagree with
    // a linear pass over it.
    let mut member_index = HashMap::with_capacity(members.len() * 2);
    let mut max_physical_extent = 0.0_f64;
    let mut max_physical_y = 0.0_f64;
    for (i, member) in members.iter().enumerate() {
        member_index.entry(member.image_id.0.clone()).or_insert(i);
        member_index.entry(member.entity_id.0.clone()).or_insert(i);
        let extent = member.volume_transform.max_physical_extent;
        let extent = if extent > 0.0 { extent } else { 1.0 };
        max_physical_extent = max_physical_extent.max(extent);
        max_physical_y = max_physical_y.max(member.volume_transform.model[5] as f64 * extent);
    }

    DatasetDerivedState {
        volume_transforms,
        active_layout,
        members,
        member_index,
        max_physical_extent,
        max_physical_y,
    }
}

/// Hash-indexed resolver for entity positions in a layout, with the exact
/// first-match semantics of [`resolve_entity_position`] but O(1) per lookup.
///
/// [`build_derived_state`] constructs one per rebuild and resolves every image
/// through it; [`resolve_entity_position`] remains the single-lookup form for
/// callers resolving a handful of entities (annotation anchoring), where
/// building an index would cost more than the scan it replaces.
pub(crate) struct LayoutPositionIndex<'a> {
    /// First placement per entity id.
    placement_by_entity: HashMap<&'a EntityId, [f64; 2]>,
    /// First entity per id → its parent (if any).
    parent_by_entity: HashMap<&'a EntityId, Option<&'a EntityId>>,
    /// First transform edge per `from` id → per `to` id → XY translation.
    offset_by_edge: HashMap<&'a EntityId, HashMap<&'a EntityId, [f64; 2]>>,
}

impl<'a> LayoutPositionIndex<'a> {
    pub(crate) fn new(
        layout: &'a LayoutSpec,
        entities: &'a [Entity],
        transforms: &'a [TransformEdge],
    ) -> Self {
        let mut placement_by_entity = HashMap::with_capacity(layout.placements.len());
        for p in &layout.placements {
            placement_by_entity
                .entry(&p.entity_id)
                .or_insert(p.position);
        }
        let mut parent_by_entity = HashMap::with_capacity(entities.len());
        for e in entities {
            parent_by_entity.entry(&e.id).or_insert(e.parent.as_ref());
        }
        let mut offset_by_edge: HashMap<&EntityId, HashMap<&EntityId, [f64; 2]>> = HashMap::new();
        for t in transforms {
            offset_by_edge
                .entry(&t.from)
                .or_default()
                .entry(&t.to)
                .or_insert([t.transform.matrix()[12], t.transform.matrix()[13]]);
        }
        Self {
            placement_by_entity,
            parent_by_entity,
            offset_by_edge,
        }
    }

    /// Resolve an entity's `[x, y]`, or `None` when it has no placement —
    /// mirrors [`resolve_entity_position`] step for step (direct placement,
    /// else parent placement + tile→parent transform translation, defaulting
    /// the translation to `[0, 0]` when no edge exists).
    pub(crate) fn resolve(&self, entity_id: &EntityId) -> Option<[f64; 2]> {
        if let Some(p) = self.placement_by_entity.get(entity_id) {
            return Some(*p);
        }
        let parent = (*self.parent_by_entity.get(entity_id)?)?;
        let parent_pos = *self.placement_by_entity.get(parent)?;
        let offset = self
            .offset_by_edge
            .get(entity_id)
            .and_then(|by_to| by_to.get(parent))
            .copied()
            .unwrap_or([0.0, 0.0]);
        Some([parent_pos[0] + offset[0], parent_pos[1] + offset[1]])
    }
}

/// Resolve an entity's `[x, y]` in `layout`, or `None` when it has no placement
/// there (neither a direct placement nor a placed parent to compose against).
///
/// For Image entities: look up directly in layout placements. For Tile
/// entities: parent group's placement + tile→group transform translation.
/// This is the single-lookup owner of that composition rule;
/// [`LayoutPositionIndex`] is its hash-indexed bulk twin (used by
/// [`build_derived_state`], where the render path collapses an unresolvable
/// entity to `[0.0, 0.0]` so it always gets *some* position).
///
/// Unlike that render-path fallback, the `Option` here distinguishes
/// "genuinely placed at the origin" from "not placeable in this layout".
/// Annotation anchoring (`DocumentState::apply` in `scene::types`) depends on
/// that distinction:
///   - picking the nearest entity must not treat unplaceable entities as if they
///     sat at the origin, and
///   - re-anchoring on a layout switch must skip a pin whose anchor isn't placed
///     in *both* layouts (leaving it untouched) rather than yanking it toward a
///     phantom `[0, 0]`.
pub(crate) fn resolve_entity_position(
    entity_id: &EntityId,
    layout: &LayoutSpec,
    entities: &[Entity],
    transforms: &[TransformEdge],
) -> Option<[f64; 2]> {
    // Direct placement?
    if let Some(p) = layout.placements.iter().find(|p| &p.entity_id == entity_id) {
        return Some(p.position);
    }

    // Otherwise, compose a tile's position from its parent group's placement plus
    // the tile->group transform translation. Only resolvable if the parent is
    // itself placed in this layout.
    let entity = entities.iter().find(|e| &e.id == entity_id)?;
    let parent_id = entity.parent.as_ref()?;
    let parent_pos = layout
        .placements
        .iter()
        .find(|p| &p.entity_id == parent_id)
        .map(|p| p.position)?;

    let transform_offset = transforms
        .iter()
        .find(|t| &t.from == entity_id && &t.to == parent_id)
        .map(|t| [t.transform.matrix()[12], t.transform.matrix()[13]])
        .unwrap_or([0.0, 0.0]);

    Some([
        parent_pos[0] + transform_offset[0],
        parent_pos[1] + transform_offset[1],
    ])
}

/// Test helpers for constructing dataset manifests and DatasetOpened events.
#[cfg(test)]
pub(crate) mod test_helpers {
    use lucida_content::*;
    use lucida_protocol::*;

    /// A scene whose slice camera is placed at the origin at one sample per
    /// device pixel, so opening a dataset leaves it there.
    pub fn placed_scene(viewport: [u32; 2]) -> super::Scene {
        let mut scene = super::Scene::new(viewport);
        scene.camera.set_framing(crate::camera::Framing::Placed);
        scene
    }

    /// Create a DatasetOpened with a simple single-image manifest.
    pub fn make_dataset_opened(id: &str, name: &str, channels: u64) -> DatasetOpened {
        let entity_id = EntityId(format!("{id}-entity"));
        let image_id = ImageId(format!("{id}-image"));

        let manifest = DatasetManifest::new(
            DatasetId(id.to_string()),
            name.to_string(),
            DatasetKind::Single,
            vec![Entity {
                id: entity_id.clone(),
                kind: EntityKind::Image,
                parent: None,
                labels: EntityLabels {
                    name: Some(name.to_string()),
                    ..Default::default()
                },
            }],
            vec![],
            vec![ImageSpec {
                image_id: image_id.clone(),
                owner: entity_id,
                multiscale: MultiscaleInfo {
                    axes: vec![
                        Axis {
                            name: "t".to_string(),
                            kind: AxisKind::Time,
                        },
                        Axis {
                            name: "c".to_string(),
                            kind: AxisKind::Channel,
                        },
                        Axis {
                            name: "z".to_string(),
                            kind: AxisKind::Space,
                        },
                        Axis {
                            name: "y".to_string(),
                            kind: AxisKind::Space,
                        },
                        Axis {
                            name: "x".to_string(),
                            kind: AxisKind::Space,
                        },
                    ],
                    levels: vec![LevelGeometry {
                        level_index: 0,
                        shape: [1, channels, 10, 256, 256],
                        chunk_shape: [1, 1, 1, 128, 128],
                        grid_shape: [1, channels, 10, 2, 2],
                        scale: [1.0, 1.0, 1.0, 1.0, 1.0],
                    }],
                    coarse_level_index: None,
                    generated_levels: vec![],
                    data_type: DataType::Uint16,
                    pinned_axes: vec![],
                    downsampling_method: None,
                    channel_infos: vec![],
                },
            }],
            vec![],
            None,
        );

        let fetch = FetchSource::Proxied(ProxiedFetchDescriptor {
            images: vec![ProxiedImageSpec {
                image_id,
                wire_format: WireFormat::Raw {
                    data_type: DataType::Uint16,
                },
            }],
        });

        DatasetOpened {
            manifest,
            fetch,
            opener_client_id: None,
        }
    }

    /// Create a DatasetOpened with specific shape and `num_levels` regular
    /// levels, each level halving z, y, and x.
    pub fn make_dataset_opened_with_shape(
        id: &str,
        name: &str,
        _channels: u64,
        shape: [u64; 5],
        chunk_shape: [u64; 5],
        num_levels: u32,
    ) -> DatasetOpened {
        let level_shapes: Vec<[u64; 3]> = (0..num_levels)
            .map(|l| {
                let scale = 1u64 << l;
                [
                    shape[2].div_ceil(scale),
                    shape[3].div_ceil(scale),
                    shape[4].div_ceil(scale),
                ]
            })
            .collect();
        make_dataset_opened_with_named_level_shapes(
            id,
            name,
            [shape[0], shape[1]],
            &level_shapes,
            chunk_shape,
        )
    }

    /// Create a single-image DatasetOpened whose pyramid has exactly the given
    /// `[z, y, x]` shape per level, so a test can describe an irregular or
    /// anisotropic pyramid directly.
    pub fn make_dataset_opened_with_level_shapes(
        id: &str,
        level_shapes: &[[u64; 3]],
    ) -> DatasetOpened {
        make_dataset_opened_with_named_level_shapes(
            id,
            id,
            [1, 1],
            level_shapes,
            [1, 1, 1, 256, 256],
        )
    }

    fn make_dataset_opened_with_named_level_shapes(
        id: &str,
        name: &str,
        tc: [u64; 2],
        level_shapes: &[[u64; 3]],
        chunk_shape: [u64; 5],
    ) -> DatasetOpened {
        let entity_id = EntityId(format!("{id}-entity"));
        let image_id = ImageId(format!("{id}-image"));

        let levels = level_shapes
            .iter()
            .enumerate()
            .map(|(l, &[z, y, x])| {
                let shape = [tc[0], tc[1], z, y, x];
                LevelGeometry {
                    level_index: l as u32,
                    shape,
                    chunk_shape,
                    grid_shape: [
                        shape[0].div_ceil(chunk_shape[0]),
                        shape[1].div_ceil(chunk_shape[1]),
                        shape[2].div_ceil(chunk_shape[2]),
                        shape[3].div_ceil(chunk_shape[3]),
                        shape[4].div_ceil(chunk_shape[4]),
                    ],
                    scale: [1.0, 1.0, 1.0, 1.0, 1.0],
                }
            })
            .collect();

        let manifest = DatasetManifest::new(
            DatasetId(id.to_string()),
            name.to_string(),
            DatasetKind::Single,
            vec![Entity {
                id: entity_id.clone(),
                kind: EntityKind::Image,
                parent: None,
                labels: EntityLabels {
                    name: Some(name.to_string()),
                    ..Default::default()
                },
            }],
            vec![],
            vec![ImageSpec {
                image_id: image_id.clone(),
                owner: entity_id,
                multiscale: MultiscaleInfo {
                    axes: vec![
                        Axis {
                            name: "t".to_string(),
                            kind: AxisKind::Time,
                        },
                        Axis {
                            name: "c".to_string(),
                            kind: AxisKind::Channel,
                        },
                        Axis {
                            name: "z".to_string(),
                            kind: AxisKind::Space,
                        },
                        Axis {
                            name: "y".to_string(),
                            kind: AxisKind::Space,
                        },
                        Axis {
                            name: "x".to_string(),
                            kind: AxisKind::Space,
                        },
                    ],
                    levels,
                    coarse_level_index: None,
                    generated_levels: vec![],
                    data_type: DataType::Uint16,
                    pinned_axes: vec![],
                    downsampling_method: None,
                    channel_infos: vec![],
                },
            }],
            vec![],
            None,
        );

        let fetch = FetchSource::Proxied(ProxiedFetchDescriptor {
            images: vec![ProxiedImageSpec {
                image_id,
                wire_format: WireFormat::Raw {
                    data_type: DataType::Uint16,
                },
            }],
        });

        DatasetOpened {
            manifest,
            fetch,
            opener_client_id: None,
        }
    }

    /// Create a DatasetOpened whose manifest carries `n_labels` uint32
    /// segmentation labels attached to its single image — for exercising the
    /// per-label display-settings path (seeding on open, per-label commands).
    pub fn make_dataset_opened_with_labels(
        id: &str,
        name: &str,
        channels: u64,
        n_labels: usize,
    ) -> DatasetOpened {
        make_dataset_opened_with_label_dtypes(id, name, channels, &vec![DataType::Uint32; n_labels])
    }

    /// Like [`make_dataset_opened_with_labels`] but with an explicit per-label
    /// dtype list, so tests can exercise mixed-dtype ordering (e.g. a uint16
    /// label sorting before a uint32 one).
    pub fn make_dataset_opened_with_label_dtypes(
        id: &str,
        name: &str,
        channels: u64,
        dtypes: &[DataType],
    ) -> DatasetOpened {
        let mut opened = make_dataset_opened(id, name, channels);
        let source_image_id = ImageId(format!("{id}-image"));
        let owner = EntityId(format!("{id}-entity"));
        let labels = dtypes
            .iter()
            .enumerate()
            .map(|(i, &dtype)| LabelSpec {
                name: format!("label-{i}"),
                source_image_id: source_image_id.clone(),
                image: ImageSpec {
                    image_id: ImageId(format!("{id}-image:label:{i}")),
                    owner: owner.clone(),
                    multiscale: MultiscaleInfo {
                        axes: vec![
                            Axis {
                                name: "t".to_string(),
                                kind: AxisKind::Time,
                            },
                            Axis {
                                name: "z".to_string(),
                                kind: AxisKind::Space,
                            },
                            Axis {
                                name: "y".to_string(),
                                kind: AxisKind::Space,
                            },
                            Axis {
                                name: "x".to_string(),
                                kind: AxisKind::Space,
                            },
                        ],
                        levels: vec![LevelGeometry {
                            level_index: 0,
                            shape: [1, 1, 1, 64, 64],
                            chunk_shape: [1, 1, 1, 64, 64],
                            grid_shape: [1, 1, 1, 1, 1],
                            scale: [1.0, 1.0, 1.0, 1.0, 1.0],
                        }],
                        coarse_level_index: None,
                        generated_levels: vec![],
                        data_type: dtype,
                        pinned_axes: vec![],
                        downsampling_method: None,
                        channel_infos: vec![],
                    },
                },
                colors: vec![],
                names: vec![],
                source_declared: true,
            })
            .collect();
        opened.manifest = opened.manifest.with_labels(labels);
        opened
    }

    /// Create a DatasetOpened for a collection with multiple image members,
    /// each a single-level image.
    pub fn make_collection_dataset_opened(
        id: &str,
        name: &str,
        members: Vec<(&str, [f64; 2])>,
        image_shape: [u64; 5],
        chunk_shape: [u64; 5],
    ) -> DatasetOpened {
        let members = members
            .into_iter()
            .map(|(member_id, position)| (member_id, position, 1))
            .collect();
        make_collection_dataset_opened_with_level_counts(
            id,
            name,
            members,
            image_shape,
            chunk_shape,
        )
    }

    /// Create a DatasetOpened for a collection whose members each carry a
    /// regular pyramid of the given depth: `(member id, position, levels)`.
    /// Every level halves each spatial axis of `image_shape` and keeps
    /// `chunk_shape`.
    pub fn make_collection_dataset_opened_with_level_counts(
        id: &str,
        name: &str,
        members: Vec<(&str, [f64; 2], u32)>,
        image_shape: [u64; 5],
        chunk_shape: [u64; 5],
    ) -> DatasetOpened {
        use lucida_content::layout::EntityPlacement;

        let mut entities = Vec::new();
        let mut images = Vec::new();
        let mut placements = Vec::new();
        let mut fetch_images = Vec::new();

        for (member_id, position, level_count) in &members {
            let entity_id = EntityId(member_id.to_string());
            let image_id = ImageId(format!("{member_id}-image"));

            entities.push(Entity {
                id: entity_id.clone(),
                kind: EntityKind::Image,
                parent: None,
                labels: EntityLabels {
                    name: Some(member_id.to_string()),
                    ..Default::default()
                },
            });

            placements.push(EntityPlacement {
                entity_id: entity_id.clone(),
                position: *position,
            });

            images.push(ImageSpec {
                image_id: image_id.clone(),
                owner: entity_id,
                multiscale: MultiscaleInfo {
                    axes: vec![
                        Axis {
                            name: "t".to_string(),
                            kind: AxisKind::Time,
                        },
                        Axis {
                            name: "c".to_string(),
                            kind: AxisKind::Channel,
                        },
                        Axis {
                            name: "z".to_string(),
                            kind: AxisKind::Space,
                        },
                        Axis {
                            name: "y".to_string(),
                            kind: AxisKind::Space,
                        },
                        Axis {
                            name: "x".to_string(),
                            kind: AxisKind::Space,
                        },
                    ],
                    levels: (0..*level_count)
                        .map(|level| {
                            let factor = 1u64 << level;
                            let shape = [
                                image_shape[0],
                                image_shape[1],
                                image_shape[2].div_ceil(factor),
                                image_shape[3].div_ceil(factor),
                                image_shape[4].div_ceil(factor),
                            ];
                            LevelGeometry {
                                level_index: level,
                                shape,
                                chunk_shape,
                                grid_shape: std::array::from_fn(|d| {
                                    shape[d].div_ceil(chunk_shape[d])
                                }),
                                scale: [1.0, 1.0, 1.0, 1.0, 1.0],
                            }
                        })
                        .collect(),
                    coarse_level_index: None,
                    generated_levels: vec![],
                    data_type: DataType::Uint16,
                    pinned_axes: vec![],
                    downsampling_method: None,
                    channel_infos: vec![],
                },
            });

            fetch_images.push(ProxiedImageSpec {
                image_id,
                wire_format: WireFormat::Raw {
                    data_type: DataType::Uint16,
                },
            });
        }

        let layout = LayoutSpec {
            id: LayoutId("default".into()),
            name: "Default".into(),
            placements,
        };

        let manifest = DatasetManifest::new(
            DatasetId(id.to_string()),
            name.to_string(),
            DatasetKind::Collection {
                rows: vec!["A".to_string()],
                columns: vec!["1".to_string(), "2".to_string()],
                positioning_mode: PositioningMode::Derived,
                has_explicit_positions: false,
            },
            entities,
            vec![],
            images,
            vec![layout],
            Some(LayoutId("default".into())),
        );

        let fetch = FetchSource::Proxied(ProxiedFetchDescriptor {
            images: fetch_images,
        });

        DatasetOpened {
            manifest,
            fetch,
            opener_client_id: None,
        }
    }

    /// A Single-kind dataset with one entity (`owner`, EntityKind::Image) at `position`,
    /// owning multiple images with differing pyramid depths, for exercising the
    /// duplicate-owner delta path. Each `(image_id, num_levels, base_px)` yields an
    /// ImageSpec owned by `owner` whose multiscale has `num_levels` levels (level i is a
    /// square `base_px >> i` on X/Y, single Z/T/C, chunk 256), Uint16, Proxied fetch.
    pub fn make_multi_image_owner_opened(
        id: &str,
        owner: &str,
        images: &[(&str, u32, u64)], // (image_id, num_levels, base_px_xy)
        position: [f64; 2],
    ) -> DatasetOpened {
        use lucida_content::layout::EntityPlacement;

        let owner_id = EntityId(owner.to_string());

        let entities = vec![Entity {
            id: owner_id.clone(),
            kind: EntityKind::Image,
            parent: None,
            labels: EntityLabels {
                name: Some(owner.to_string()),
                ..Default::default()
            },
        }];

        let placements = vec![EntityPlacement {
            entity_id: owner_id.clone(),
            position,
        }];

        let mut image_specs = Vec::new();
        let mut fetch_images = Vec::new();

        for (image_id, num_levels, base_px) in images {
            let image_id = ImageId(image_id.to_string());
            let chunk_shape = [1, 1, 1, 256, 256];
            let levels = (0..*num_levels)
                .map(|i| {
                    let dim = (base_px >> i).max(1);
                    let shape = [1, 1, 1, dim, dim];
                    LevelGeometry {
                        level_index: i,
                        shape,
                        chunk_shape,
                        grid_shape: [
                            shape[0].div_ceil(chunk_shape[0]),
                            shape[1].div_ceil(chunk_shape[1]),
                            shape[2].div_ceil(chunk_shape[2]),
                            shape[3].div_ceil(chunk_shape[3]),
                            shape[4].div_ceil(chunk_shape[4]),
                        ],
                        scale: [1.0, 1.0, 1.0, 1.0, 1.0],
                    }
                })
                .collect();

            image_specs.push(ImageSpec {
                image_id: image_id.clone(),
                owner: owner_id.clone(),
                multiscale: MultiscaleInfo {
                    axes: vec![
                        Axis {
                            name: "t".to_string(),
                            kind: AxisKind::Time,
                        },
                        Axis {
                            name: "c".to_string(),
                            kind: AxisKind::Channel,
                        },
                        Axis {
                            name: "z".to_string(),
                            kind: AxisKind::Space,
                        },
                        Axis {
                            name: "y".to_string(),
                            kind: AxisKind::Space,
                        },
                        Axis {
                            name: "x".to_string(),
                            kind: AxisKind::Space,
                        },
                    ],
                    levels,
                    coarse_level_index: None,
                    generated_levels: vec![],
                    data_type: DataType::Uint16,
                    pinned_axes: vec![],
                    downsampling_method: None,
                    channel_infos: vec![],
                },
            });

            fetch_images.push(ProxiedImageSpec {
                image_id,
                wire_format: WireFormat::Raw {
                    data_type: DataType::Uint16,
                },
            });
        }

        let layout = LayoutSpec {
            id: LayoutId("default".into()),
            name: "Default".into(),
            placements,
        };

        let manifest = DatasetManifest::new(
            DatasetId(id.to_string()),
            id.to_string(),
            DatasetKind::Single,
            entities,
            vec![],
            image_specs,
            vec![layout],
            Some(LayoutId("default".into())),
        );

        let fetch = FetchSource::Proxied(ProxiedFetchDescriptor {
            images: fetch_images,
        });

        DatasetOpened {
            manifest,
            fetch,
            opener_client_id: None,
        }
    }

    /// Create a DatasetOpened for a collection of `groups` placed group
    /// entities, each parenting `tiles_per_group` tile entities whose
    /// positions compose from the group placement plus a tile→group
    /// transform translation — the wide-collection shape (groups × tiles)
    /// that exercises the parent-composition position path at scale.
    pub fn make_grouped_collection_opened(
        id: &str,
        groups: usize,
        tiles_per_group: usize,
    ) -> DatasetOpened {
        use lucida_content::layout::EntityPlacement;

        let mut entities = Vec::new();
        let mut transforms = Vec::new();
        let mut images = Vec::new();
        let mut placements = Vec::new();
        let mut fetch_images = Vec::new();

        for g in 0..groups {
            let group_id = EntityId(format!("{id}-g{g}"));
            entities.push(Entity {
                id: group_id.clone(),
                kind: EntityKind::Group,
                parent: None,
                labels: EntityLabels {
                    name: Some(format!("g{g}")),
                    ..Default::default()
                },
            });
            placements.push(EntityPlacement {
                entity_id: group_id.clone(),
                position: [(g % 16) as f64 * 800.0, (g / 16) as f64 * 800.0],
            });

            for t in 0..tiles_per_group {
                let tile_id = EntityId(format!("{id}-g{g}-t{t}"));
                let image_id = ImageId(format!("{id}-g{g}-t{t}-image"));
                entities.push(Entity {
                    id: tile_id.clone(),
                    kind: EntityKind::Tile,
                    parent: Some(group_id.clone()),
                    labels: EntityLabels::default(),
                });
                transforms.push(TransformEdge {
                    from: tile_id.clone(),
                    to: group_id.clone(),
                    transform: VoxelTransform::from_voxel_translation_2d(
                        (t % 8) as f64 * 64.0,
                        (t / 8) as f64 * 64.0,
                    ),
                });
                images.push(ImageSpec {
                    image_id: image_id.clone(),
                    owner: tile_id,
                    multiscale: MultiscaleInfo {
                        axes: vec![
                            Axis {
                                name: "t".to_string(),
                                kind: AxisKind::Time,
                            },
                            Axis {
                                name: "c".to_string(),
                                kind: AxisKind::Channel,
                            },
                            Axis {
                                name: "z".to_string(),
                                kind: AxisKind::Space,
                            },
                            Axis {
                                name: "y".to_string(),
                                kind: AxisKind::Space,
                            },
                            Axis {
                                name: "x".to_string(),
                                kind: AxisKind::Space,
                            },
                        ],
                        levels: vec![LevelGeometry {
                            level_index: 0,
                            shape: [1, 1, 1, 64, 64],
                            chunk_shape: [1, 1, 1, 64, 64],
                            grid_shape: [1, 1, 1, 1, 1],
                            scale: [1.0, 1.0, 1.0, 1.0, 1.0],
                        }],
                        coarse_level_index: None,
                        generated_levels: vec![],
                        data_type: DataType::Uint16,
                        pinned_axes: vec![],
                        downsampling_method: None,
                        channel_infos: vec![],
                    },
                });
                fetch_images.push(ProxiedImageSpec {
                    image_id,
                    wire_format: WireFormat::Raw {
                        data_type: DataType::Uint16,
                    },
                });
            }
        }

        let layout = LayoutSpec {
            id: LayoutId("default".into()),
            name: "Default".into(),
            placements,
        };

        let manifest = DatasetManifest::new(
            DatasetId(id.to_string()),
            id.to_string(),
            DatasetKind::Collection {
                rows: vec!["A".to_string()],
                columns: (0..groups).map(|g| format!("{}", g + 1)).collect(),
                positioning_mode: PositioningMode::Derived,
                has_explicit_positions: false,
            },
            entities,
            transforms,
            images,
            vec![layout],
            Some(LayoutId("default".into())),
        );

        let fetch = FetchSource::Proxied(ProxiedFetchDescriptor {
            images: fetch_images,
        });

        DatasetOpened {
            manifest,
            fetch,
            opener_client_id: None,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::command::DocumentCommand;

    #[test]
    fn empty_scene_produces_empty_plan() {
        let scene = Scene::new([800, 600]);
        assert!(scene.chunk_plan().is_empty());
    }

    #[test]
    fn available_layouts_mark_the_one_shown() {
        let mut scene = Scene::new([800, 600]);
        let reg = test_helpers::make_collection_dataset_opened(
            "c",
            "c",
            vec![("m1", [0.0, 0.0]), ("m2", [256.0, 0.0])],
            [1, 1, 1, 256, 256],
            [1, 1, 1, 256, 256],
        );
        scene.apply(DocumentCommand::DatasetOpened(reg).into());
        let ds = DatasetId("c".into());
        let active = |scene: &Scene| -> Vec<(String, bool)> {
            scene
                .available_layouts(&ds)
                .into_iter()
                .map(|l| (l.id.0, l.active))
                .collect()
        };

        // Nothing chosen yet: the manifest's default is the one shown.
        assert_eq!(active(&scene), [("default".into(), true)]);

        scene.apply(
            DocumentCommand::RegisterLayout {
                dataset_id: ds.clone(),
                layout: LayoutSpec {
                    id: LayoutId("alt".into()),
                    name: "Alt".into(),
                    placements: vec![],
                },
            }
            .into(),
        );
        scene.apply(
            DocumentCommand::SetActiveLayout {
                dataset_id: ds.clone(),
                layout_id: LayoutId("alt".into()),
            }
            .into(),
        );
        assert_eq!(
            active(&scene),
            [("default".into(), false), ("alt".into(), true)]
        );
        assert!(
            scene
                .available_layouts(&DatasetId("missing".into()))
                .is_empty()
        );
    }

    #[test]
    fn registered_dataset_produces_chunks() {
        let mut scene = Scene::new([512, 512]);
        let reg = test_helpers::make_dataset_opened_with_shape(
            "ds1",
            "test",
            1,
            [1, 1, 256, 4096, 4096],
            [1, 1, 64, 256, 256],
            5,
        );
        scene.apply(DocumentCommand::DatasetOpened(reg).into());
        assert!(!scene.chunk_plan().is_empty());
    }

    #[test]
    fn changing_slice_updates_chunk_coords() {
        let mut scene = test_helpers::placed_scene([512, 512]);
        let reg = test_helpers::make_dataset_opened_with_shape(
            "ds1",
            "test",
            1,
            [1, 1, 256, 4096, 4096],
            [1, 1, 64, 256, 256],
            5,
        );
        scene.apply(DocumentCommand::DatasetOpened(reg).into());

        let plan_z0 = scene.chunk_plan();
        scene.view.set_slice("z", 100).unwrap();
        let plan_z100 = scene.chunk_plan();

        assert_eq!(plan_z0[0].z, 0);
        assert_eq!(plan_z100[0].z, 1);
    }

    #[test]
    fn z_slab_produces_chunks_across_z() {
        let mut scene = test_helpers::placed_scene([512, 512]);
        let reg = test_helpers::make_dataset_opened_with_shape(
            "ds1",
            "test",
            1,
            [1, 1, 256, 4096, 4096],
            [1, 1, 64, 256, 256],
            5,
        );
        scene.apply(DocumentCommand::DatasetOpened(reg).into());
        scene.view.set_z_range(0..128);
        let plan = scene.chunk_plan();
        let z_values: Vec<u32> = plan.iter().map(|c| c.z).collect();
        assert!(z_values.contains(&0));
        assert!(z_values.contains(&1));
    }

    #[test]
    fn mode_switching_preserves_viewport() {
        let mut scene = Scene::new([800, 600]);
        assert!(matches!(scene.camera, Camera::Slice(_)));

        scene.set_mode_3d();
        assert!(matches!(scene.camera, Camera::Arcball(_)));
        assert_eq!(scene.camera.viewport(), [800, 600]);

        scene.set_mode_2d();
        assert!(matches!(scene.camera, Camera::Slice(_)));
        assert_eq!(scene.camera.viewport(), [800, 600]);
    }

    #[test]
    fn scene_serialization_round_trip() {
        let mut scene = Scene::new([800, 600]);
        scene.view.set_z(5);
        scene.view.t = 2;

        let reg = test_helpers::make_dataset_opened("ds1", "test", 1);
        scene.apply(DocumentCommand::DatasetOpened(reg).into());

        let json = serde_json::to_string(&scene).unwrap();
        let mut parsed: Scene = serde_json::from_str(&json).unwrap();
        // Rebuild derived state after deserialization
        parsed.rebuild_derived();

        assert_eq!(parsed.view.z_range, 5..6);
        assert_eq!(parsed.view.t, 2);
        assert_eq!(parsed.document.manifests.len(), 1);
        assert!(
            parsed
                .document
                .manifests
                .contains_key(&DatasetId("ds1".into()))
        );
        if let Camera::Slice(v) = &parsed.camera {
            assert_eq!(v.viewport, [800, 600]);
        } else {
            panic!("expected Slice");
        }
    }

    #[test]
    fn dataset_opened_populates_dataset_order_and_settings() {
        let mut scene = Scene::new([800, 600]);
        let reg = test_helpers::make_dataset_opened("ds1", "first", 1);
        scene.apply(DocumentCommand::DatasetOpened(reg).into());
        let ds_id = DatasetId("ds1".into());
        assert_eq!(scene.dataset_order, vec![ds_id.clone()]);
        assert!(scene.dataset_settings.contains_key(&ds_id));
        let settings = &scene.dataset_settings[&ds_id];
        assert!(settings.visible);
        assert_eq!(settings.opacity, 1.0);
    }

    #[test]
    fn remove_dataset_cleans_up_state() {
        let mut scene = Scene::new([800, 600]);
        let reg1 = test_helpers::make_dataset_opened("ds1", "first", 1);
        let reg2 = test_helpers::make_dataset_opened("ds2", "second", 1);
        scene.apply(DocumentCommand::DatasetOpened(reg1).into());
        scene.apply(DocumentCommand::DatasetOpened(reg2).into());
        let ds1_id = DatasetId("ds1".into());
        let ds2_id = DatasetId("ds2".into());
        scene.remove_dataset(&ds1_id);
        assert_eq!(scene.dataset_order, vec![ds2_id.clone()]);
        assert!(!scene.dataset_settings.contains_key(&ds1_id));
        assert!(scene.dataset_settings.contains_key(&ds2_id));
        assert!(!scene.derived.contains_key(&ds1_id));
    }

    #[test]
    fn remove_dataset_command_clears_view_query_cursor() {
        let mut scene = Scene::new([800, 600]);
        scene.apply(
            DocumentCommand::DatasetOpened(test_helpers::make_dataset_opened("ds1", "first", 1))
                .into(),
        );

        // A first delta query seeds the per-dataset cursor.
        scene.view_query_delta(&DatasetId("ds1".into()));
        assert!(
            scene
                .view_query_cursors
                .contains_key(&DatasetId("ds1".into()))
        );

        // The reachable production removal path (command apply) must prune it.
        scene.apply(
            DocumentCommand::RemoveDataset {
                id: DatasetId("ds1".into()),
            }
            .into(),
        );
        assert!(
            !scene
                .view_query_cursors
                .contains_key(&DatasetId("ds1".into()))
        );
    }

    #[test]
    fn scene_backward_compat_deserialization_without_settings() {
        // JSON without dataset_order/dataset_settings should deserialize with defaults
        let mut scene = Scene::new([800, 600]);
        let reg = test_helpers::make_dataset_opened("ds1", "test", 1);
        scene.apply(DocumentCommand::DatasetOpened(reg).into());
        // Serialize, then strip optional tiles
        let json = serde_json::to_string(&scene).unwrap();
        let mut val: serde_json::Value = serde_json::from_str(&json).unwrap();
        val.as_object_mut().unwrap().remove("dataset_order");
        val.as_object_mut().unwrap().remove("dataset_settings");
        let parsed: Scene = serde_json::from_value(val).unwrap();
        assert!(parsed.dataset_order.is_empty());
        assert!(parsed.dataset_settings.is_empty());
    }

    #[test]
    fn dataset_opened_deduplicates_by_id() {
        let mut scene = Scene::new([800, 600]);
        let reg1 = test_helpers::make_dataset_opened("ds1", "first", 1);
        scene.apply(DocumentCommand::DatasetOpened(reg1).into());
        assert_eq!(scene.document.manifests.len(), 1);
        let reg2 = test_helpers::make_dataset_opened("ds1", "updated", 1);
        scene.apply(DocumentCommand::DatasetOpened(reg2).into());
        assert_eq!(scene.document.manifests.len(), 1);
        assert_eq!(
            scene.document.manifests[&DatasetId("ds1".into())].name,
            "updated"
        );
    }

    #[test]
    fn remove_dataset_by_id() {
        let mut scene = Scene::new([800, 600]);
        let reg1 = test_helpers::make_dataset_opened("ds1", "first", 1);
        let reg2 = test_helpers::make_dataset_opened("ds2", "second", 1);
        scene.apply(DocumentCommand::DatasetOpened(reg1).into());
        scene.apply(DocumentCommand::DatasetOpened(reg2).into());
        assert_eq!(scene.document.manifests.len(), 2);
        scene.remove_dataset(&DatasetId("ds1".into()));
        assert_eq!(scene.document.manifests.len(), 1);
        assert!(
            scene
                .document
                .manifests
                .contains_key(&DatasetId("ds2".into()))
        );
    }

    #[test]
    fn chunk_plan_for_returns_member_plans() {
        let mut scene = Scene::new([512, 512]);
        let reg = test_helpers::make_dataset_opened_with_shape(
            "ds1",
            "test",
            1,
            [1, 1, 256, 4096, 4096],
            [1, 1, 64, 256, 256],
            5,
        );
        scene.apply(DocumentCommand::DatasetOpened(reg).into());
        let ds_id = DatasetId("ds1".into());
        let plans = scene.chunk_plan_for(&ds_id).unwrap();
        assert_eq!(plans.len(), 1);
        assert_eq!(plans[0].image_id, ImageId("ds1-image".into()));
        assert!(!plans[0].needed.is_empty());
    }

    #[test]
    fn chunk_plan_for_single_member_matches_flat_plan() {
        let mut scene = Scene::new([512, 512]);
        let reg = test_helpers::make_dataset_opened_with_shape(
            "ds1",
            "test",
            1,
            [1, 1, 256, 4096, 4096],
            [1, 1, 64, 256, 256],
            5,
        );
        scene.apply(DocumentCommand::DatasetOpened(reg).into());
        let flat = scene.chunk_plan();
        let ds_id = DatasetId("ds1".into());
        let member_plans = scene.chunk_plan_for(&ds_id).unwrap();
        assert_eq!(member_plans.len(), 1);
        assert_eq!(flat.len(), member_plans[0].needed.len());
        for (a, b) in flat.iter().zip(member_plans[0].needed.iter()) {
            assert_eq!(a.key(), b.key());
        }
    }

    #[test]
    fn chunk_plan_for_missing_dataset_returns_none() {
        let scene = Scene::new([512, 512]);
        let ds_id = DatasetId("nonexistent".into());
        assert!(scene.chunk_plan_for(&ds_id).is_none());
    }

    fn set_slice_zoom(scene: &mut Scene, zoom: f64) {
        if let Camera::Slice(s) = &mut scene.camera {
            s.set_zoom(zoom);
        }
    }

    fn set_slice_center(scene: &mut Scene, x: f64, y: f64) {
        if let Camera::Slice(s) = &mut scene.camera {
            s.set_center(x, y);
        }
    }

    /// The distinct levels across every planned chunk of `ds`, in ascending
    /// order.
    fn planned_levels(scene: &Scene, ds: &DatasetId) -> Vec<u32> {
        let mut levels: Vec<u32> = scene
            .chunk_plan_for(ds)
            .unwrap()
            .iter()
            .flat_map(|plan| &plan.needed)
            .map(|chunk| chunk.level)
            .collect();
        levels.sort_unstable();
        levels.dedup();
        assert!(!levels.is_empty(), "the plan must hold at least one chunk");
        levels
    }

    #[test]
    fn chunk_plan_fetches_the_level_the_real_level_shapes_call_for() {
        // Level 1 is four times coarser than level 0, so a picker assuming a
        // factor of two per level would fetch level 2 at a quarter pixel per
        // sample.
        let mut scene = Scene::new([512, 512]);
        let reg = test_helpers::make_dataset_opened_with_level_shapes(
            "irregular",
            &[
                [1, 4096, 4096],
                [1, 1024, 1024],
                [1, 512, 512],
                [1, 128, 128],
            ],
        );
        scene.apply(DocumentCommand::DatasetOpened(reg).into());
        let ds = DatasetId::from("irregular");
        set_slice_center(&mut scene, 2048.0, 2048.0);
        for (zoom, level) in [(0.26, 0), (0.25, 1), (0.125, 2), (0.03, 3)] {
            set_slice_zoom(&mut scene, zoom);
            assert_eq!(planned_levels(&scene, &ds), vec![level], "zoom {zoom}");
        }
    }

    #[test]
    fn chunk_plan_in_a_slice_view_skips_a_level_that_only_downsamples_z() {
        // A picker counting levels would fetch level 1 at half a pixel per
        // sample.
        let mut scene = Scene::new([512, 512]);
        let reg = test_helpers::make_dataset_opened_with_level_shapes(
            "aniso",
            &[[64, 2048, 2048], [32, 2048, 2048], [32, 1024, 1024]],
        );
        scene.apply(DocumentCommand::DatasetOpened(reg).into());
        let ds = DatasetId::from("aniso");
        set_slice_center(&mut scene, 1024.0, 1024.0);
        set_slice_zoom(&mut scene, 0.9);
        assert_eq!(planned_levels(&scene, &ds), vec![0]);
        set_slice_zoom(&mut scene, 0.5);
        assert_eq!(planned_levels(&scene, &ds), vec![2]);
    }

    /// The level the view query reports for the one image of `ds`.
    fn queried_target(scene: &Scene, ds: &DatasetId) -> u32 {
        let result = scene.view_query(ds).unwrap();
        assert_eq!(result.visible_entities.len(), 1);
        assert!(
            result.visible_entities[0].visible,
            "the image must be on screen"
        );
        result.visible_entities[0].target_level
    }

    /// A 4096² image with four regular levels, viewed from its middle in a
    /// viewport of `viewport` device pixels.
    fn regular_slice_scene(viewport: [u32; 2]) -> (Scene, DatasetId) {
        let mut scene = Scene::new(viewport);
        let reg = test_helpers::make_dataset_opened_with_shape(
            "img",
            "img",
            1,
            [1, 1, 1, 4096, 4096],
            [1, 1, 1, 256, 256],
            4,
        );
        scene.apply(DocumentCommand::DatasetOpened(reg).into());
        set_slice_center(&mut scene, 2048.0, 2048.0);
        (scene, DatasetId::from("img"))
    }

    #[test]
    fn chunk_plan_fetches_the_level_the_view_query_targets_at_either_pixel_density() {
        // At twice the pixel density the backing viewport and the zoom both
        // double, so the same world extent is on screen and the target is one
        // level finer.
        let (mut dpr1, ds) = regular_slice_scene([400, 300]);
        let (mut dpr2, _) = regular_slice_scene([800, 600]);
        for (css_zoom, dpr1_level) in [(1.0, 0), (0.5, 1), (0.25, 2), (0.12, 3)] {
            set_slice_zoom(&mut dpr1, css_zoom);
            set_slice_zoom(&mut dpr2, css_zoom * 2.0);
            assert_eq!(queried_target(&dpr1, &ds), dpr1_level, "zoom {css_zoom}");
            assert_eq!(
                planned_levels(&dpr1, &ds),
                vec![dpr1_level],
                "zoom {css_zoom}"
            );
            let dpr2_level = dpr1_level.saturating_sub(1);
            assert_eq!(queried_target(&dpr2, &ds), dpr2_level, "zoom {css_zoom}");
            assert_eq!(
                planned_levels(&dpr2, &ds),
                vec![dpr2_level],
                "zoom {css_zoom}"
            );
        }
    }

    #[test]
    fn chunk_plan_in_a_volume_view_fetches_the_level_the_view_query_targets() {
        // Zoomed from the fit, from inside the volume to far enough out that
        // the coarsest level is the target, so the plan holds chunks at every
        // distance and the walk crosses every level.
        let mut scene = Scene::new([800, 600]);
        let reg = test_helpers::make_dataset_opened_with_shape(
            "vol",
            "vol",
            1,
            [1, 1, 256, 1024, 1024],
            [1, 1, 64, 256, 256],
            5,
        );
        scene.apply(DocumentCommand::DatasetOpened(reg).into());
        let ds = DatasetId::from("vol");
        scene.set_mode_3d();
        assert!(scene.fit_camera_to_dataset("vol"));
        let fitted = scene.camera.clone();

        let mut levels = Vec::new();
        for factor in [0.1, 0.25, 0.5, 0.75, 1.0, 2.0, 4.0, 8.0, 64.0] {
            scene.camera = fitted.clone();
            if let Camera::Arcball(a) = &mut scene.camera {
                a.zoom(factor - 1.0);
            }
            let target = queried_target(&scene, &ds);
            assert_eq!(planned_levels(&scene, &ds), vec![target], "factor {factor}");
            levels.push(target);
        }
        assert_eq!(levels, vec![0, 0, 0, 0, 1, 2, 3, 4, 4]);
    }

    fn pin_level(scene: &mut Scene, ds: &DatasetId, level: Option<u32>) {
        scene.apply(
            crate::command::ViewportCommand::SetDatasetDetailLevelOverride {
                dataset_id: ds.0.clone(),
                level,
            }
            .into(),
        );
    }

    #[test]
    fn chunk_plan_fetches_a_pinned_level_whatever_the_screen_calls_for() {
        let (mut scene, ds) = regular_slice_scene([512, 512]);

        set_slice_zoom(&mut scene, 4.0);
        pin_level(&mut scene, &ds, Some(2));
        assert_eq!(planned_levels(&scene, &ds), vec![2]);
        assert_eq!(scene.chunk_plan_for(&ds).unwrap()[0].target_level, 2);

        set_slice_zoom(&mut scene, 0.01);
        pin_level(&mut scene, &ds, Some(0));
        assert_eq!(planned_levels(&scene, &ds), vec![0]);
        assert_eq!(scene.chunk_plan_for(&ds).unwrap()[0].target_level, 0);

        pin_level(&mut scene, &ds, None);
        assert_eq!(planned_levels(&scene, &ds), vec![3]);
        assert_eq!(scene.chunk_plan_for(&ds).unwrap()[0].target_level, 3);
    }

    /// A two-member collection whose members have pyramids of different
    /// depths, both on screen, pinned to a level only the deeper one has. The
    /// command clamps the pin against the first image only.
    fn mixed_depth_scene_pinned_to_2() -> (Scene, DatasetId) {
        let mut scene = Scene::new([1024, 512]);
        let reg = test_helpers::make_collection_dataset_opened_with_level_counts(
            "mixed",
            "mixed",
            vec![("deep", [0.0, 0.0], 3), ("shallow", [256.0, 0.0], 2)],
            [1, 1, 1, 256, 256],
            [1, 1, 1, 64, 64],
        );
        scene.apply(DocumentCommand::DatasetOpened(reg).into());
        let ds = DatasetId::from("mixed");
        set_slice_center(&mut scene, 256.0, 128.0);
        set_slice_zoom(&mut scene, 2.0);
        pin_level(&mut scene, &ds, Some(2));
        (scene, ds)
    }

    #[test]
    fn chunk_plan_clamps_a_pin_past_a_members_pyramid_to_its_coarsest_level() {
        let (scene, ds) = mixed_depth_scene_pinned_to_2();

        let plans = scene.chunk_plan_for(&ds).unwrap();
        let by_image: HashMap<&str, &MemberChunkPlan> =
            plans.iter().map(|p| (p.image_id.0.as_str(), p)).collect();
        assert_eq!(by_image["deep-image"].target_level, 2);
        assert!(by_image["deep-image"].needed.iter().all(|c| c.level == 2));
        assert_eq!(by_image["shallow-image"].target_level, 1);
        assert!(
            by_image["shallow-image"]
                .needed
                .iter()
                .all(|c| c.level == 1)
        );
    }

    /// A 4096² image with three source levels and a generated coarse level 3,
    /// viewed from its middle.
    fn generated_coarse_scene() -> (Scene, DatasetId) {
        let mut scene = Scene::new([512, 512]);
        let mut reg = test_helpers::make_dataset_opened_with_shape(
            "gen",
            "gen",
            1,
            [1, 1, 1, 4096, 4096],
            [1, 1, 1, 256, 256],
            4,
        );
        let multiscale = &mut reg.manifest.images_mut()[0].multiscale;
        multiscale.coarse_level_index = Some(3);
        multiscale
            .generated_levels
            .push(lucida_content::GeneratedLevelInfo {
                level_index: 3,
                role: lucida_content::GeneratedLevelRole::Coarse,
                provenance: lucida_content::GeneratedLevelProvenance {
                    generator: "test".into(),
                    config_id: "coarse".into(),
                    source_content_id: None,
                },
            });
        scene.apply(DocumentCommand::DatasetOpened(reg).into());
        set_slice_center(&mut scene, 2048.0, 2048.0);
        (scene, DatasetId::from("gen"))
    }

    #[test]
    fn chunk_plan_never_pins_to_a_generated_level() {
        let (mut scene, ds) = generated_coarse_scene();
        set_slice_zoom(&mut scene, 4.0);
        // Written directly, as settings imported from a peer arrive, so the
        // command's clamp never runs.
        scene
            .dataset_settings
            .get_mut(&ds)
            .unwrap()
            .detail_level_override = Some(3);

        assert_eq!(planned_levels(&scene, &ds), vec![2]);
        assert_eq!(scene.chunk_plan_for(&ds).unwrap()[0].target_level, 2);
        assert_eq!(queried_target(&scene, &ds), 2);
    }

    #[test]
    fn view_query_reports_the_pinned_level_whatever_the_screen_calls_for() {
        let (mut scene, ds) = regular_slice_scene([512, 512]);

        set_slice_zoom(&mut scene, 4.0);
        pin_level(&mut scene, &ds, Some(2));
        assert_eq!(queried_target(&scene, &ds), 2);

        set_slice_zoom(&mut scene, 0.01);
        pin_level(&mut scene, &ds, Some(0));
        assert_eq!(queried_target(&scene, &ds), 0);

        pin_level(&mut scene, &ds, None);
        assert_eq!(queried_target(&scene, &ds), 3);
    }

    #[test]
    fn view_query_clamps_a_stale_pin_per_member() {
        let (scene, ds) = mixed_depth_scene_pinned_to_2();

        let result = scene.view_query(&ds).unwrap();
        let by_image: HashMap<&str, &EntityQueryResult> = result
            .visible_entities
            .iter()
            .map(|e| (e.image_id.0.as_str(), e))
            .collect();
        assert!(by_image["deep-image"].visible && by_image["shallow-image"].visible);
        assert_eq!(by_image["deep-image"].target_level, 2);
        assert_eq!(by_image["shallow-image"].target_level, 1);
    }

    #[test]
    fn the_screen_never_targets_a_generated_level_in_the_query_or_the_plan() {
        let (mut scene, ds) = generated_coarse_scene();
        // Far enough out that the raw rule names the generated level 3.
        set_slice_zoom(&mut scene, 0.01);
        assert_eq!(queried_target(&scene, &ds), 2);
        assert_eq!(planned_levels(&scene, &ds), vec![2]);
        assert_eq!(scene.chunk_plan_for(&ds).unwrap()[0].target_level, 2);
    }

    #[test]
    fn a_pin_change_arrives_through_the_view_query_delta_as_a_changed_record() {
        let (mut scene, ds) = regular_slice_scene([512, 512]);
        set_slice_zoom(&mut scene, 4.0);
        assert!(matches!(
            scene.view_query_delta(&ds).unwrap(),
            ViewQueryDelta::Full(_)
        ));

        fn changed_level(scene: &mut Scene, ds: &DatasetId) -> Option<u32> {
            match scene.view_query_delta(ds).unwrap() {
                ViewQueryDelta::Delta {
                    entered,
                    left,
                    changed,
                    ..
                } => {
                    assert!(entered.is_empty() && left.is_empty());
                    assert!(changed.len() <= 1);
                    changed.first().map(|e| e.target_level)
                }
                ViewQueryDelta::Full(_) => panic!("a pin edit must not force a full resync"),
            }
        }

        pin_level(&mut scene, &ds, Some(2));
        assert_eq!(changed_level(&mut scene, &ds), Some(2));
        assert_eq!(changed_level(&mut scene, &ds), None);

        pin_level(&mut scene, &ds, None);
        assert_eq!(changed_level(&mut scene, &ds), Some(0));
    }

    #[test]
    fn a_pin_set_to_the_screens_own_level_still_reports_a_changed_record() {
        // The prefetch lane reads `level_pinned` off the record, so the flag
        // has to reach it even when the level itself does not move.
        let (mut scene, ds) = regular_slice_scene([512, 512]);
        set_slice_zoom(&mut scene, 4.0);
        let ViewQueryDelta::Full(full) = scene.view_query_delta(&ds).unwrap() else {
            panic!("the first query must be a full snapshot");
        };
        assert_eq!(full.visible_entities[0].target_level, 0);
        assert!(!full.visible_entities[0].level_pinned);

        pin_level(&mut scene, &ds, Some(0));
        match scene.view_query_delta(&ds).unwrap() {
            ViewQueryDelta::Delta { changed, .. } => {
                assert_eq!(changed.len(), 1);
                assert_eq!(changed[0].target_level, 0);
                assert!(changed[0].level_pinned);
            }
            ViewQueryDelta::Full(_) => panic!("a pin edit must not force a full resync"),
        }
    }

    #[test]
    fn clearing_a_pin_resumes_the_screen_rule_from_the_pinned_level() {
        // At zoom 0.12 the raw rule names level 3, just inside the hysteresis
        // band past the 2/3 boundary at 0.125, so the history decides.
        let (mut scene, ds) = regular_slice_scene([512, 512]);
        set_slice_zoom(&mut scene, 0.12);
        assert_eq!(queried_target(&scene, &ds), 3);

        pin_level(&mut scene, &ds, Some(2));
        scene.view_query_delta(&ds).unwrap();
        pin_level(&mut scene, &ds, None);
        assert_eq!(queried_target(&scene, &ds), 2);

        set_slice_zoom(&mut scene, 0.1);
        assert_eq!(queried_target(&scene, &ds), 3);
    }

    #[test]
    fn pinnable_levels_are_the_source_levels_including_zero() {
        let (scene, ds) = generated_coarse_scene();
        assert_eq!(scene.pinnable_levels(&ds), vec![0, 1, 2]);

        let (scene, ds) = regular_slice_scene([512, 512]);
        assert_eq!(scene.pinnable_levels(&ds), vec![0, 1, 2, 3]);

        assert!(scene.pinnable_levels(&DatasetId::from("absent")).is_empty());
    }

    #[test]
    fn visible_content_bounds_include_all_visible_collection_members() {
        let mut scene = Scene::new([512, 512]);
        let reg = test_helpers::make_collection_dataset_opened(
            "collection",
            "collection",
            vec![("m1", [0.0, 0.0]), ("m2", [300.0, 100.0])],
            [1, 1, 5, 64, 32],
            [1, 1, 1, 32, 32],
        );
        scene.apply(DocumentCommand::DatasetOpened(reg).into());

        let bounds = scene.visible_content_bounds_2d().unwrap();
        assert_eq!(
            bounds,
            VisibleContentBounds2D {
                min_x: 0.0,
                min_y: 0.0,
                max_x: 332.0,
                max_y: 164.0,
                max_depth: 5,
            },
        );

        scene
            .dataset_settings
            .get_mut(&DatasetId("collection".into()))
            .unwrap()
            .visible = false;
        assert_eq!(scene.visible_content_bounds_2d(), None);
    }

    #[test]
    fn multi_member_aabb_culling() {
        // Two members side-by-side, each 256x256 in XY. Camera at origin
        // should see member at [0,0] but not the one at [10000, 0].
        let mut scene = test_helpers::placed_scene([512, 512]);
        let reg = test_helpers::make_collection_dataset_opened(
            "collection",
            "collection",
            vec![("m1", [0.0, 0.0]), ("m2", [10000.0, 0.0])],
            [1, 1, 1, 256, 256],
            [1, 1, 1, 256, 256],
        );
        scene.apply(DocumentCommand::DatasetOpened(reg).into());
        let ds_id = DatasetId("collection".into());
        let plans = scene.chunk_plan_for(&ds_id).unwrap();
        // Only the member at origin should be visible
        assert_eq!(plans.len(), 1);
        assert_eq!(plans[0].image_id, ImageId("m1-image".into()));
        assert!(!plans[0].needed.is_empty());
    }

    #[test]
    fn ray_pick_single_image_center() {
        let mut scene = Scene::new([800, 600]);
        let reg = test_helpers::make_dataset_opened("ds1", "test", 1);
        scene.apply(DocumentCommand::DatasetOpened(reg).into());
        // Ray through viewport center should hit the single image
        let hit = scene.ray_pick(&DatasetId::from("ds1"), 400.0, 300.0);
        assert!(hit.is_some());
        let h = hit.unwrap();
        assert_eq!(h.entity_id, EntityId::from("ds1-entity"));
    }

    #[test]
    fn ray_pick_miss() {
        let mut scene = Scene::new([800, 600]);
        let reg = test_helpers::make_dataset_opened("ds1", "test", 1);
        scene.apply(DocumentCommand::DatasetOpened(reg).into());
        // Ray way off screen should miss
        let hit = scene.ray_pick(&DatasetId::from("ds1"), -10000.0, -10000.0);
        assert!(hit.is_none());
    }

    #[test]
    fn ray_pick_nonexistent_dataset() {
        let scene = Scene::new([800, 600]);
        assert!(
            scene
                .ray_pick(&DatasetId::from("nope"), 400.0, 300.0)
                .is_none()
        );
    }

    #[test]
    fn project_annotation_2d_matches_in_plane_projection() {
        // In slice mode the pin projection is exactly the in-plane projection
        // the 2D overlay uses; depth is ignored.
        let mut scene = Scene::new([800, 600]);
        let reg = test_helpers::make_dataset_opened("ds1", "test", 1);
        scene.apply(DocumentCommand::DatasetOpened(reg).into());
        let id = DatasetId::from("ds1");
        let with_z = scene.project_annotation(&id, 40.0, 30.0, 7.0).unwrap();
        let without_z = scene.camera.project_to_screen([40.0, 30.0, 0.0]).unwrap();
        assert_eq!(with_z, without_z);
    }

    #[test]
    fn pick_annotation_voxel_round_trips_through_projection_in_3d() {
        // A depth pick stored as a voxel triple must re-project to the same
        // screen point, so the marker lands under the cursor that dropped it at
        // any camera angle. A cubic volume makes the viewport-center ray
        // reliably strike a face.
        let mut scene = Scene::new([800, 600]);
        let reg = test_helpers::make_dataset_opened_with_shape(
            "ds1",
            "test",
            1,
            [1, 1, 64, 64, 64],
            [1, 1, 64, 64, 64],
            1,
        );
        scene.apply(DocumentCommand::DatasetOpened(reg).into());
        scene.set_mode_3d();
        // Orbit a little so we're not in a degenerate head-on view.
        scene.apply(
            crate::command::ViewportCommand::Rotate3D {
                d_theta: 0.5,
                d_phi: 0.3,
            }
            .into(),
        );
        let id = DatasetId::from("ds1");
        let (sx, sy) = (400.0, 300.0); // viewport center → hits the cube
        let voxel = scene
            .pick_annotation_voxel(&id, sx, sy)
            .expect("center ray should hit the volume");
        let screen = scene
            .project_annotation(&id, voxel[0], voxel[1], voxel[2])
            .expect("picked point should project in front of the camera");
        assert!(
            (screen[0] - sx).abs() < 1.0 && (screen[1] - sy).abs() < 1.0,
            "re-projected pin {screen:?} should land at the pick point [{sx}, {sy}]",
        );
    }

    #[test]
    fn annotation_world_point_is_inside_volume_world_bounds() {
        // A pin at the volume's voxel center must map to a world point inside
        // the volume's world AABB — a sanity check that the voxel→world lift
        // uses the same transform as the rendered volume (so the marker can't
        // float off in space).
        let mut scene = Scene::new([800, 600]);
        let reg = test_helpers::make_dataset_opened("ds1", "test", 1); // 256x256x10
        scene.apply(DocumentCommand::DatasetOpened(reg).into());
        scene.set_mode_3d();
        let id = DatasetId::from("ds1");
        let (member, shape) = scene.annotation_member(&id).unwrap();
        let center = [shape[0] / 2.0, shape[1] / 2.0, shape[2] / 2.0];
        let world = scene.annotation_world_point(member, shape, center);
        let (fwd, _) = scene.rendering_transform(member);
        let corners = fwd.world_corners();
        let mut lo = [f64::MAX; 3];
        let mut hi = [f64::MIN; 3];
        for corner in &corners {
            for k in 0..3 {
                lo[k] = lo[k].min(corner[k]);
                hi[k] = hi[k].max(corner[k]);
            }
        }
        for k in 0..3 {
            assert!(
                world[k] >= lo[k] - 1e-6 && world[k] <= hi[k] + 1e-6,
                "axis {k}: {} not within [{}, {}]",
                world[k],
                lo[k],
                hi[k],
            );
        }
    }

    #[test]
    fn pick_annotation_voxel_misses_return_none() {
        // A ray that misses the volume yields no depth, so the caller declines
        // to drop a pin into empty space rather than anchoring it nowhere.
        let mut scene = Scene::new([800, 600]);
        let reg = test_helpers::make_dataset_opened("ds1", "test", 1);
        scene.apply(DocumentCommand::DatasetOpened(reg).into());
        scene.set_mode_3d();
        let id = DatasetId::from("ds1");
        assert!(
            scene
                .pick_annotation_voxel(&id, -10_000.0, -10_000.0)
                .is_none()
        );
    }

    #[test]
    fn project_annotation_unknown_dataset_is_none_in_3d() {
        let mut scene = Scene::new([800, 600]);
        scene.set_mode_3d();
        assert!(
            scene
                .project_annotation(&DatasetId::from("nope"), 1.0, 2.0, 3.0)
                .is_none()
        );
    }

    #[test]
    fn center_on_voxel_3d_brings_an_off_center_pin_to_the_viewport_center() {
        // Jumping to a mention in 3D: the 2D `SetCenter` only moves the slice
        // camera, so `CenterOnVoxel3D` must move the 3D projection itself. The
        // web tests cannot see the camera math, so this checks the pin moves
        // and lands at the viewport center.
        let mut scene = Scene::new([800, 600]);
        let reg = test_helpers::make_dataset_opened_with_shape(
            "ds1",
            "test",
            1,
            [1, 1, 64, 64, 64],
            [1, 1, 64, 64, 64],
            1,
        );
        scene.apply(DocumentCommand::DatasetOpened(reg).into());
        scene.set_mode_3d();
        // Orbit off head-on so the view is a generic 3D pose, not a degenerate
        // axis-aligned one (matches the sibling pick round-trip test).
        scene.apply(
            crate::command::ViewportCommand::Rotate3D {
                d_theta: 0.5,
                d_phi: 0.3,
            }
            .into(),
        );
        let id = DatasetId::from("ds1");
        let center = [400.0, 300.0]; // viewport center in pixels (800x600)

        // A pin near a corner of the volume, so its marker starts well away
        // from the viewport center.
        let pin = [8.0, 8.0, 8.0];
        let before = scene
            .project_annotation(&id, pin[0], pin[1], pin[2])
            .expect("corner pin should project in front of the camera");
        let off_center = ((before[0] - center[0]).powi(2) + (before[1] - center[1]).powi(2)).sqrt();
        assert!(
            off_center > 50.0,
            "precondition: the pin should start off-center, was {before:?} ({off_center} px from center)",
        );

        scene.apply(
            crate::command::ViewportCommand::CenterOnVoxel3D {
                dataset_id: "ds1".to_string(),
                x: pin[0],
                y: pin[1],
                z: pin[2],
            }
            .into(),
        );

        let after = scene
            .project_annotation(&id, pin[0], pin[1], pin[2])
            .expect("pin should still project in front of the camera after centering");

        let moved = ((after[0] - before[0]).powi(2) + (after[1] - before[1]).powi(2)).sqrt();
        assert!(
            moved > 1.0,
            "CenterOnVoxel3D should move the projection: before {before:?}, after {after:?}",
        );

        // The arcball target puts the look-at axis through the pin's world
        // point, so it projects to screen center.
        assert!(
            (after[0] - center[0]).abs() < 1.0 && (after[1] - center[1]).abs() < 1.0,
            "after centering the pin {after:?} should land at the viewport center {center:?}",
        );
    }

    #[test]
    fn center_on_voxel_3d_is_a_noop_for_unknown_dataset() {
        // An unanchorable/unknown dataset yields no world point, so the camera is
        // left untouched (a stale pin id can never wedge the view). The arcball
        // target is unchanged and the same point projects to the same place.
        let mut scene = Scene::new([800, 600]);
        let reg = test_helpers::make_dataset_opened_with_shape(
            "ds1",
            "test",
            1,
            [1, 1, 64, 64, 64],
            [1, 1, 64, 64, 64],
            1,
        );
        scene.apply(DocumentCommand::DatasetOpened(reg).into());
        scene.set_mode_3d();
        let id = DatasetId::from("ds1");
        let before = scene.project_annotation(&id, 8.0, 8.0, 8.0).unwrap();
        scene.apply(
            crate::command::ViewportCommand::CenterOnVoxel3D {
                dataset_id: "does-not-exist".to_string(),
                x: 8.0,
                y: 8.0,
                z: 8.0,
            }
            .into(),
        );
        let after = scene.project_annotation(&id, 8.0, 8.0, 8.0).unwrap();
        assert_eq!(before, after, "unknown dataset must not move the camera");
    }

    #[test]
    fn multi_member_both_visible_when_overlapping_view() {
        // Two adjacent members within the viewport.
        let mut scene = Scene::new([1024, 512]);
        // Pan camera to see both members
        if let Camera::Slice(ref mut v) = scene.camera {
            v.center = [256.0, 128.0];
        }
        let reg = test_helpers::make_collection_dataset_opened(
            "collection",
            "collection",
            vec![("m1", [0.0, 0.0]), ("m2", [256.0, 0.0])],
            [1, 1, 1, 256, 256],
            [1, 1, 1, 256, 256],
        );
        scene.apply(DocumentCommand::DatasetOpened(reg).into());
        let ds_id = DatasetId("collection".into());
        let plans = scene.chunk_plan_for(&ds_id).unwrap();
        let ids: Vec<&ImageId> = plans.iter().map(|p| &p.image_id).collect();
        assert!(
            ids.contains(&&ImageId("m1-image".into())),
            "m1 should be visible"
        );
        assert!(
            ids.contains(&&ImageId("m2-image".into())),
            "m2 should be visible"
        );
    }

    #[test]
    fn dataset_world_bounds_is_some_and_finite_for_known_id() {
        let mut scene = Scene::new([800, 600]);
        let reg = test_helpers::make_dataset_opened("ds1", "test", 1);
        scene.apply(DocumentCommand::DatasetOpened(reg).into());

        let WorldBox { min, max } = scene
            .dataset_world_bounds("ds1")
            .expect("known dataset has bounds");
        for v in min.iter().chain(max.iter()) {
            assert!(v.is_finite(), "non-finite bound leaked: {v}");
        }
        // Properly ordered, non-degenerate in XY (256x256 footprint, isotropic).
        assert!(min[0] <= max[0] && min[1] <= max[1] && min[2] <= max[2]);
        assert!(
            max[0] > min[0] && max[1] > min[1],
            "XY extent should be > 0"
        );
    }

    #[test]
    fn dataset_world_bounds_none_for_unknown_id() {
        let mut scene = Scene::new([800, 600]);
        let reg = test_helpers::make_dataset_opened("ds1", "test", 1);
        scene.apply(DocumentCommand::DatasetOpened(reg).into());
        assert!(scene.dataset_world_bounds("nope").is_none());
    }

    #[test]
    fn dataset_world_bounds_frames_each_dataset_not_the_union() {
        // A single image at the origin plus a 2-group collection offset along X. The
        // single dataset's box must be its OWN footprint, never the union that
        // would also include the offset collection group.
        let mut scene = Scene::new([800, 600]);
        scene.apply(
            DocumentCommand::DatasetOpened(test_helpers::make_dataset_opened("a", "a", 1)).into(),
        );
        scene.apply(
            DocumentCommand::DatasetOpened(test_helpers::make_collection_dataset_opened(
                "b",
                "b",
                vec![("b-m1", [0.0, 0.0]), ("b-m2", [256.0, 0.0])],
                [1, 1, 1, 256, 256],
                [1, 1, 1, 256, 256],
            ))
            .into(),
        );

        let WorldBox {
            min: a_min,
            max: a_max,
        } = scene.dataset_world_bounds("a").expect("a has bounds");
        let WorldBox {
            min: b_min,
            max: b_max,
        } = scene.dataset_world_bounds("b").expect("b has bounds");

        // Each frames its own dataset → different boxes.
        assert!(
            a_min != b_min || a_max != b_max,
            "per-dataset bounds must differ for differently-placed datasets"
        );
        // The collection spans two groups along X, so it is wider than the single image.
        let a_width = a_max[0] - a_min[0];
        let b_width = b_max[0] - b_min[0];
        assert!(
            b_width > a_width + 1e-9,
            "collection width {b_width} should exceed single-image width {a_width}"
        );
        // "a" must not grow to the union: its max-x stays near its own
        // footprint, short of the offset collection's far edge.
        assert!(
            a_max[0] < b_max[0] - 1e-9,
            "dataset_world_bounds('a') leaked the union (max-x {} vs collection max-x {})",
            a_max[0],
            b_max[0]
        );
    }

    #[test]
    fn dataset_world_bounds_matches_member_world_matrix_corners() {
        // The bounds are exactly the AABB of the per-member world matrix the
        // renderer and minimap use.
        let mut scene = Scene::new([800, 600]);
        scene.apply(
            DocumentCommand::DatasetOpened(test_helpers::make_collection_dataset_opened(
                "p",
                "p",
                vec![("p-m1", [0.0, 0.0]), ("p-m2", [256.0, 128.0])],
                [1, 1, 4, 256, 256],
                [1, 1, 4, 256, 256],
            ))
            .into(),
        );

        let mut expected = crate::framing::Aabb::empty();
        let derived = scene
            .derived
            .get(&DatasetId("p".into()))
            .expect("derived state");
        for member in &derived.members {
            let vt = VolumeTransform {
                model: scene.member_world_matrix(member),
                inv_model: [0.0; 16],
                max_physical_extent: 1.0,
            };
            for corner in vt.world_corners() {
                expected.add_point(corner);
            }
        }

        let WorldBox { min, max } = scene.dataset_world_bounds("p").expect("p has bounds");
        assert_eq!(min, expected.min);
        assert_eq!(max, expected.max);
    }

    /// `member_world_matrix` returns `rendering_transform`'s forward `model`
    /// element for element, for a single dataset, an XY-offset member, and a
    /// multi-dataset scene, so it cannot drift from the render path.
    #[test]
    fn member_world_matrix_equals_rendering_transform_forward_model() {
        let mut scene = Scene::new([800, 600]);
        // Config 1: a single dataset at the origin (256x256 footprint).
        scene.apply(
            DocumentCommand::DatasetOpened(test_helpers::make_dataset_opened("solo", "solo", 1))
                .into(),
        );
        // Config 2 + 3: a second, multi-member dataset — one group at the origin
        // and one with a non-trivial XY offset + anisotropic footprint.
        scene.apply(
            DocumentCommand::DatasetOpened(test_helpers::make_collection_dataset_opened(
                "collection",
                "collection",
                vec![
                    ("collection-m1", [0.0, 0.0]),
                    ("collection-m2", [256.0, 128.0]),
                ],
                [1, 1, 4, 200, 256],
                [1, 1, 4, 200, 256],
            ))
            .into(),
        );

        let mut members_seen = 0;
        for ds in ["solo", "collection"] {
            let derived = scene
                .derived
                .get(&DatasetId(ds.into()))
                .expect("derived state");
            for member in &derived.members {
                let wrapper = scene.member_world_matrix(member);
                let canonical = scene.rendering_transform(member).0.model;
                for i in 0..16 {
                    assert!(
                        (wrapper[i] - canonical[i]).abs() < 1e-6,
                        "member_world_matrix drifted from rendering_transform at \
                         element {i}: {} vs {} (dataset {ds})",
                        wrapper[i],
                        canonical[i],
                    );
                }
                members_seen += 1;
            }
        }
        // Guard the test itself: we really exercised ≥3 member configs.
        assert!(
            members_seen >= 3,
            "expected at least 3 members across the configs, saw {members_seen}"
        );
    }

    /// The forward and inverse halves of `rendering_transform` must compose to
    /// the identity (within fp epsilon) — picking/upload run the inverse, the
    /// render runs the forward, so a broken round-trip would desync them. Check
    /// it for an offset, anisotropic member inside a multi-dataset scene (the
    /// hardest case: non-zero translation + global correction + top-align).
    #[test]
    fn rendering_transform_forward_inverse_round_trips_to_identity() {
        let mut scene = Scene::new([800, 600]);
        scene.apply(
            DocumentCommand::DatasetOpened(test_helpers::make_dataset_opened("a", "a", 1)).into(),
        );
        scene.apply(
            DocumentCommand::DatasetOpened(test_helpers::make_collection_dataset_opened(
                "b",
                "b",
                vec![("b-m1", [0.0, 0.0]), ("b-m2", [256.0, 128.0])],
                [1, 1, 4, 200, 256],
                [1, 1, 4, 200, 256],
            ))
            .into(),
        );

        // Multiply two column-major 4x4 matrices: returns a*b.
        let mul = |a: &[f32; 16], b: &[f32; 16]| -> [f32; 16] {
            let mut out = [0.0f32; 16];
            for col in 0..4 {
                for row in 0..4 {
                    let mut sum = 0.0f32;
                    for k in 0..4 {
                        sum += a[k * 4 + row] * b[col * 4 + k];
                    }
                    out[col * 4 + row] = sum;
                }
            }
            out
        };
        let identity = [
            1.0, 0.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 0.0, 1.0,
        ];

        for ds in ["a", "b"] {
            let derived = scene
                .derived
                .get(&DatasetId(ds.into()))
                .expect("derived state");
            for member in &derived.members {
                let (fwd, inv) = scene.rendering_transform(member);
                let composed = mul(&fwd.model, &inv.inv_model);
                for i in 0..16 {
                    assert!(
                        (composed[i] - identity[i]).abs() < 1e-5,
                        "model · inv_model not identity at element {i}: {} \
                         (expected {}) for dataset {ds}",
                        composed[i],
                        identity[i],
                    );
                }
            }
        }
    }

    /// Open a 512-voxel-cube dataset ("big") next to a two-group collection whose
    /// groups are 256 voxels across ("collection", first group at the layout origin,
    /// second offset). With isotropic unit spacing the collection's global
    /// correction is a real 0.5 and its top-align term is (512-200)/512 —
    /// non-trivial placement on every axis this module corrects.
    fn scene_with_big_and_collection() -> Scene {
        let mut scene = Scene::new([800, 600]);
        scene.apply(
            DocumentCommand::DatasetOpened(test_helpers::make_dataset_opened_with_shape(
                "big",
                "big",
                1,
                [1, 1, 10, 512, 512],
                [1, 1, 1, 128, 128],
                1,
            ))
            .into(),
        );
        scene.apply(
            DocumentCommand::DatasetOpened(test_helpers::make_collection_dataset_opened(
                "collection",
                "collection",
                vec![("m1", [0.0, 0.0]), ("m2", [256.0, 128.0])],
                [1, 1, 4, 200, 256],
                [1, 1, 1, 128, 128],
            ))
            .into(),
        );
        scene
    }

    /// For a first member at the layout origin, the dataset-level model matrix
    /// equals `rendering_transform`'s forward model, so a placement policy
    /// change cannot silently desync the minimap. Checked for a single-image
    /// dataset and a collection whose correction is a real 0.5.
    #[test]
    fn dataset_model_matrix_matches_rendering_transform_for_origin_member() {
        let scene = scene_with_big_and_collection();

        for ds in ["big", "collection"] {
            let derived = scene
                .derived
                .get(&DatasetId(ds.into()))
                .expect("derived state");
            let first = derived.members.first().expect("first member");
            assert_eq!(
                first.position,
                [0.0, 0.0],
                "fixture invariant: first member sits at the layout origin"
            );
            let canonical = scene.rendering_transform(first).0.model;
            let dataset = scene.dataset_model_matrix(ds);
            for i in 0..16 {
                assert!(
                    (dataset[i] - canonical[i]).abs() < 1e-6,
                    "dataset_model_matrix drifted from rendering_transform at \
                     element {i}: {} vs {} (dataset {ds})",
                    dataset[i],
                    canonical[i],
                );
            }
        }

        // The collection is half the physical size of "big": its correction is a
        // real 0.5 and it is top-aligned below the taller dataset's rim.
        let collection = scene.dataset_model_matrix("collection");
        assert!(
            (collection[0] - 0.5).abs() < 1e-6,
            "global correction should halve the collection's X scale, got {}",
            collection[0]
        );
        assert!(
            (collection[5] - 0.5 * 200.0 / 256.0).abs() < 1e-6,
            "corrected Y scale wrong: {}",
            collection[5]
        );
        assert!(
            (collection[13] - (512.0 - 200.0) / 512.0).abs() < 1e-6,
            "top-align term missing or wrong: {}",
            collection[13]
        );
        // "big" attains the global max: correction 1, no top-align shift.
        let big = scene.dataset_model_matrix("big");
        assert!((big[0] - 1.0).abs() < 1e-6, "big X scale: {}", big[0]);
        assert!(
            big[13].abs() < 1e-6,
            "big top-align should be 0: {}",
            big[13]
        );
    }

    /// The dataset-level inverse must be the render path's inverse (for an
    /// origin member) and must compose with the forward matrix to the
    /// identity — the minimap runs rays through both halves, so a one-sided
    /// change would scramble picking.
    #[test]
    fn dataset_inv_model_matrix_matches_render_inverse_and_round_trips() {
        let scene = scene_with_big_and_collection();

        // Multiply two column-major 4x4 matrices: returns a*b.
        let mul = |a: &[f32; 16], b: &[f32; 16]| -> [f32; 16] {
            let mut out = [0.0f32; 16];
            for col in 0..4 {
                for row in 0..4 {
                    let mut sum = 0.0f32;
                    for k in 0..4 {
                        sum += a[k * 4 + row] * b[col * 4 + k];
                    }
                    out[col * 4 + row] = sum;
                }
            }
            out
        };
        let identity = [
            1.0, 0.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 0.0, 1.0,
        ];

        for ds in ["big", "collection"] {
            let derived = scene
                .derived
                .get(&DatasetId(ds.into()))
                .expect("derived state");
            let first = derived.members.first().expect("first member");
            let canonical_inv = scene.rendering_transform(first).1.inv_model;
            let inv = scene.dataset_inv_model_matrix(ds);
            for i in 0..16 {
                assert!(
                    (inv[i] - canonical_inv[i]).abs() < 1e-6,
                    "dataset_inv_model_matrix drifted from rendering_transform \
                     at element {i}: {} vs {} (dataset {ds})",
                    inv[i],
                    canonical_inv[i],
                );
            }

            let fwd = scene.dataset_model_matrix(ds);
            let composed = mul(&inv, &fwd);
            for i in 0..16 {
                assert!(
                    (composed[i] - identity[i]).abs() < 1e-5,
                    "inverse · forward not identity at element {i}: {} \
                     (dataset {ds})",
                    composed[i],
                );
            }
        }
    }

    /// `volume_diagonal` must be the diagonal of the corrected render scale,
    /// the size the volume is drawn at, not the uncorrected unit-cube size.
    #[test]
    fn volume_diagonal_is_the_corrected_scale_diagonal() {
        // Alone in the scene, the collection needs no correction: the diagonal is
        // its anisotropic normalized-cube diagonal.
        let mut scene = Scene::new([800, 600]);
        scene.apply(
            DocumentCommand::DatasetOpened(test_helpers::make_collection_dataset_opened(
                "collection",
                "collection",
                vec![("m1", [0.0, 0.0]), ("m2", [256.0, 128.0])],
                [1, 1, 4, 200, 256],
                [1, 1, 1, 128, 128],
            ))
            .into(),
        );
        let collection_alone: f64 =
            (1.0f64 + (200.0f64 / 256.0).powi(2) + (4.0f64 / 256.0).powi(2)).sqrt();
        assert!(
            (scene.volume_diagonal() - collection_alone).abs() < 1e-6,
            "uncorrected diagonal wrong: {}",
            scene.volume_diagonal()
        );

        // Opening a physically larger dataset re-normalizes the scene.
        // Whichever dataset happens to be first, the diagonal must equal the
        // diagonal of ITS corrected render scale (the diagonal terms of
        // rendering_transform's forward model).
        scene.apply(
            DocumentCommand::DatasetOpened(test_helpers::make_dataset_opened_with_shape(
                "big",
                "big",
                1,
                [1, 1, 10, 512, 512],
                [1, 1, 1, 128, 128],
                1,
            ))
            .into(),
        );
        let first = scene
            .derived
            .values()
            .next()
            .and_then(|d| d.members.first())
            .expect("first member");
        let rt = scene.rendering_transform(first).0.model;
        let expected =
            ((rt[0] as f64).powi(2) + (rt[5] as f64).powi(2) + (rt[10] as f64).powi(2)).sqrt();
        assert!(
            (scene.volume_diagonal() - expected).abs() < 1e-6,
            "corrected diagonal drifted from render scale: {} vs {}",
            scene.volume_diagonal(),
            expected
        );

        // Deterministic correction!=1 coverage (independent of map order):
        // through the dataset-level matrix, the collection's corrected diagonal is
        // exactly half its standalone diagonal.
        let m = scene.dataset_model_matrix("collection");
        let collection_diag =
            ((m[0] as f64).powi(2) + (m[5] as f64).powi(2) + (m[10] as f64).powi(2)).sqrt();
        assert!(
            (collection_diag - 0.5 * collection_alone).abs() < 1e-6,
            "collection's corrected diagonal should be half its standalone one: {collection_diag}"
        );
    }

    /// Absent-dataset fallbacks: identity matrices and a 1.0 diagonal, both on
    /// an empty scene and for an unknown id in a populated one — consumers
    /// degrade to an uncorrected unit cube instead of panicking.
    #[test]
    fn dataset_matrix_and_diagonal_fallbacks() {
        let identity = [
            1.0f32, 0.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 0.0, 1.0,
        ];
        let mut scene = Scene::new([800, 600]);
        assert_eq!(scene.volume_diagonal(), 1.0);
        assert_eq!(scene.dataset_model_matrix("nope"), identity);
        assert_eq!(scene.dataset_inv_model_matrix("nope"), identity);

        scene.apply(
            DocumentCommand::DatasetOpened(test_helpers::make_dataset_opened("ds1", "ds1", 1))
                .into(),
        );
        assert_eq!(scene.dataset_model_matrix("nope"), identity);
        assert_eq!(scene.dataset_inv_model_matrix("nope"), identity);
        assert!(
            scene.volume_diagonal().is_finite() && scene.volume_diagonal() > 0.0,
            "diagonal must stay finite once data is loaded"
        );
    }

    /// `dataset_world_bounds` is folded directly from
    /// `rendering_transform(member).0.world_corners()`. Assert it returns finite,
    /// sensible bounds that match recomputing that exact fold — the same AABB the
    /// renderer's transform yields, with no second, drifting derivation.
    #[test]
    fn dataset_world_bounds_equals_rendering_transform_corner_fold() {
        let mut scene = Scene::new([800, 600]);
        scene.apply(
            DocumentCommand::DatasetOpened(test_helpers::make_collection_dataset_opened(
                "p",
                "p",
                vec![("p-m1", [0.0, 0.0]), ("p-m2", [256.0, 128.0])],
                [1, 1, 4, 200, 256],
                [1, 1, 4, 200, 256],
            ))
            .into(),
        );

        let mut expected = crate::framing::Aabb::empty();
        let derived = scene
            .derived
            .get(&DatasetId("p".into()))
            .expect("derived state");
        for member in &derived.members {
            if member.levels.is_empty() {
                continue;
            }
            for corner in scene.rendering_transform(member).0.world_corners() {
                expected.add_point(corner);
            }
        }

        let WorldBox { min, max } = scene.dataset_world_bounds("p").expect("p has bounds");
        // Folded from the same source → identical, and finite/non-degenerate.
        assert_eq!(min, expected.min);
        assert_eq!(max, expected.max);
        for v in min.iter().chain(max.iter()) {
            assert!(v.is_finite(), "non-finite bound leaked: {v}");
        }
        assert!(min[0] <= max[0] && min[1] <= max[1] && min[2] <= max[2]);
        assert!(
            max[0] > min[0] && max[1] > min[1],
            "XY extent should be > 0"
        );
    }

    #[test]
    fn fit_camera_to_dataset_centers_slice_on_voxel_xy_midpoint() {
        // The Slice camera lives in voxel space (see ray_pick), so the 2D fit
        // centers on the voxel midpoint [W/2, H/2]. The normalized midpoint
        // (~0.5) would frame a sub-pixel speck at the origin.
        let mut scene = Scene::new([800, 600]);
        let reg = test_helpers::make_dataset_opened("ds1", "test", 1); // 256x256 XY
        scene.apply(DocumentCommand::DatasetOpened(reg).into());

        let VoxBox {
            min: min2,
            max: max2,
        } = scene
            .dataset_voxel_bounds("ds1")
            .expect("known dataset has voxel bounds");
        let mid_x = (min2[0] + max2[0]) / 2.0;
        let mid_y = (min2[1] + max2[1]) / 2.0;

        assert!(scene.fit_camera_to_dataset("ds1"));
        match &scene.camera {
            Camera::Slice(s) => {
                assert!(
                    (s.center[0] - mid_x).abs() < 1e-9 && (s.center[1] - mid_y).abs() < 1e-9,
                    "2D center {:?} should be the VOXEL XY midpoint ({mid_x}, {mid_y})",
                    s.center
                );
                assert!(
                    (s.center[0] - 128.0).abs() < 1e-9 && (s.center[1] - 128.0).abs() < 1e-9,
                    "2D center {:?} should be [128, 128] (256/2), not normalized ~[0.5, 0.5]",
                    s.center
                );
            }
            other => panic!("expected a Slice camera, got {other:?}"),
        }
    }

    #[test]
    fn fit_camera_to_dataset_targets_midpoint_in_3d_with_valid_clip() {
        let mut scene = Scene::new([800, 600]);
        // Put the camera in 3D arcball mode first; the fit must preserve it.
        scene.camera = Camera::new_3d([800, 600]);
        let reg = test_helpers::make_dataset_opened("ds1", "test", 1);
        scene.apply(DocumentCommand::DatasetOpened(reg).into());

        let WorldBox { min, max } = scene.dataset_world_bounds("ds1").unwrap();
        let mid = [
            (min[0] + max[0]) / 2.0,
            (min[1] + max[1]) / 2.0,
            (min[2] + max[2]) / 2.0,
        ];

        assert!(scene.fit_camera_to_dataset("ds1"));
        match &scene.camera {
            Camera::Arcball(a) => {
                for (axis, &m) in mid.iter().enumerate() {
                    assert!(
                        (a.target[axis] - m).abs() < 1e-9,
                        "arcball target[{axis}] {} != midpoint {m}",
                        a.target[axis],
                    );
                }
                assert!(
                    a.distance.is_finite() && a.distance > 0.0,
                    "distance {}",
                    a.distance
                );
                assert!(
                    a.near.is_finite() && a.far.is_finite() && 0.0 < a.near && a.near < a.far,
                    "clip range near {} far {}",
                    a.near,
                    a.far
                );
            }
            other => panic!("expected an Arcball camera, got {other:?}"),
        }
    }

    #[test]
    fn fit_camera_to_dataset_unknown_id_returns_false_and_leaves_camera_unchanged() {
        let mut scene = Scene::new([800, 600]);
        let reg = test_helpers::make_dataset_opened("ds1", "test", 1);
        scene.apply(DocumentCommand::DatasetOpened(reg).into());
        let before = scene.camera.clone();
        assert!(!scene.fit_camera_to_dataset("ghost"));
        assert_eq!(
            scene.camera, before,
            "camera must be untouched on no-bounds"
        );
    }

    #[test]
    fn dataset_voxel_bounds_is_origin_to_voxel_extent() {
        // A single image of shape [1,1,Z,H,W] at the origin yields
        // [0,0,0]..[W,H,Z], whose XY rect is the AABB the slice-mode ray pick
        // and chunk culling test against.
        let mut scene = Scene::new([800, 600]);
        let (w, h) = (2048u64, 2048u64);
        let reg = test_helpers::make_dataset_opened_with_shape(
            "ds1",
            "test",
            1,
            [1, 1, 16, h, w],
            [1, 1, 1, 256, 256],
            1,
        );
        scene.apply(DocumentCommand::DatasetOpened(reg).into());

        let VoxBox { min, max } = scene
            .dataset_voxel_bounds("ds1")
            .expect("known dataset has voxel bounds");
        for v in min.iter().chain(max.iter()) {
            assert!(v.is_finite(), "non-finite voxel bound leaked: {v}");
        }
        assert!(
            min[0] <= max[0] && min[1] <= max[1],
            "bounds must be ordered"
        );
        assert_eq!(min, [0.0, 0.0, 0.0], "min should be the origin placement");
        assert_eq!(
            max,
            [w as f64, h as f64, 16.0],
            "max should be the level-0 X/Y/Z voxel extent"
        );
    }

    #[test]
    fn dataset_fit_bounds_follows_the_camera_space() {
        // The box a Home move frames must be the one the viewer's own fit
        // uses: voxel space for the slice camera, normalized world space for 3D.
        let mut scene = Scene::new([800, 600]);
        let reg = test_helpers::make_dataset_opened_with_shape(
            "ds1",
            "test",
            1,
            [1, 1, 16, 1024, 2048],
            [1, 1, 1, 256, 256],
            1,
        );
        scene.apply(DocumentCommand::DatasetOpened(reg).into());

        let (min, max) = scene.dataset_fit_bounds("ds1").expect("slice bounds");
        assert_eq!((min, max), ([0.0, 0.0, 0.0], [2048.0, 1024.0, 0.0]));

        scene.camera = Camera::new_3d([800, 600]);
        assert_eq!(
            scene.dataset_fit_bounds("ds1"),
            scene.dataset_world_bounds("ds1").map(|b| (b.min, b.max)),
        );
        assert!(scene.dataset_fit_bounds("nope").is_none());
    }

    #[test]
    fn dataset_voxel_bounds_none_for_unknown_id() {
        let mut scene = Scene::new([800, 600]);
        let reg = test_helpers::make_dataset_opened("ds1", "test", 1);
        scene.apply(DocumentCommand::DatasetOpened(reg).into());
        assert!(scene.dataset_voxel_bounds("nope").is_none());
    }

    #[test]
    fn fit_camera_to_dataset_2d_puts_data_on_screen_in_voxel_space() {
        // In 2D the fit centers on the voxel midpoint [W/2, H/2] and the
        // resulting world_bounds() contains the full footprint [0,0,W,H].
        let (vw, vh) = (1280u32, 800u32);
        let (w, h) = (2048u64, 2048u64);
        let mut scene = Scene::new([vw, vh]);
        let reg = test_helpers::make_dataset_opened_with_shape(
            "ds1",
            "test",
            1,
            [1, 1, 16, h, w],
            [1, 1, 1, 256, 256],
            1,
        );
        scene.apply(DocumentCommand::DatasetOpened(reg).into());

        scene.camera = Camera::new_2d([vw, vh]);
        assert!(scene.fit_camera_to_dataset("ds1"));

        match &scene.camera {
            Camera::Slice(s) => {
                assert!(
                    (s.center[0] - w as f64 / 2.0).abs() < 1e-9
                        && (s.center[1] - h as f64 / 2.0).abs() < 1e-9,
                    "2D center {:?} should be the voxel midpoint [{}, {}]",
                    s.center,
                    w as f64 / 2.0,
                    h as f64 / 2.0,
                );
                // world_bounds() is [min_x, min_y, max_x, max_y].
                let [bx0, by0, bx1, by1] = s.world_bounds();
                assert!(
                    bx0 <= 0.0 && by0 <= 0.0 && bx1 >= w as f64 && by1 >= h as f64,
                    "visible world_bounds {:?} must contain the footprint [0,0,{w},{h}]",
                    [bx0, by0, bx1, by1],
                );
            }
            other => panic!("expected a Slice camera, got {other:?}"),
        }
    }

    #[test]
    fn fit_camera_to_dataset_3d_path_is_unchanged_and_uses_normalized_bounds() {
        // In 3D the fit frames the normalized unit-cube bounds from
        // dataset_world_bounds, so the arcball target is the normalized midpoint.
        let (vw, vh) = (1280u32, 800u32);
        let mut scene = Scene::new([vw, vh]);
        let reg = test_helpers::make_dataset_opened_with_shape(
            "ds1",
            "test",
            1,
            [1, 1, 16, 2048, 2048],
            [1, 1, 1, 256, 256],
            1,
        );
        scene.apply(DocumentCommand::DatasetOpened(reg).into());

        let WorldBox {
            min: min3,
            max: max3,
        } = scene
            .dataset_world_bounds("ds1")
            .expect("known dataset has normalized bounds");
        let mid = [
            (min3[0] + max3[0]) / 2.0,
            (min3[1] + max3[1]) / 2.0,
            (min3[2] + max3[2]) / 2.0,
        ];

        scene.camera = Camera::new_3d([vw, vh]);
        assert!(scene.fit_camera_to_dataset("ds1"));

        match &scene.camera {
            Camera::Arcball(a) => {
                for (axis, &m) in mid.iter().enumerate() {
                    assert!(
                        (a.target[axis] - m).abs() < 1e-9,
                        "arcball target[{axis}] {} should be the normalized midpoint {m}",
                        a.target[axis],
                    );
                }
                assert!(
                    a.target[0] < 2.0 && a.target[1] < 2.0,
                    "3D target {:?} should be normalized (~0.5), not voxel (~1024)",
                    a.target,
                );
                assert!(
                    a.distance.is_finite() && a.distance > 0.0,
                    "distance {} should be finite and positive",
                    a.distance,
                );
            }
            other => panic!("expected an Arcball camera, got {other:?}"),
        }
    }

    fn opened_volume(viewport: [u32; 2]) -> Scene {
        let mut scene = Scene::new(viewport);
        let reg = test_helpers::make_dataset_opened_with_shape(
            "vol",
            "vol",
            1,
            [1, 1, 128, 512, 512],
            [1, 1, 64, 128, 128],
            3,
        );
        scene.apply(DocumentCommand::DatasetOpened(reg).into());
        scene
    }

    fn apply_vp(scene: &mut Scene, cmd: crate::command::ViewportCommand) {
        scene.apply(cmd.into());
    }

    #[test]
    fn opening_a_dataset_frames_a_new_scene() {
        let scene = opened_volume([800, 600]);
        assert_eq!(scene.camera.framing(), Framing::Framed);
        let mut fitted = Scene::new([800, 600]);
        fitted.document = scene.document.clone();
        fitted.rebuild_derived();
        fitted.camera.fit(&fitted.visible_bounds().unwrap());
        fitted.camera.set_framing(Framing::Framed);
        assert_eq!(scene.camera, fitted.camera);
    }

    #[test]
    fn each_mode_keeps_its_own_view_across_a_switch() {
        use crate::command::ViewportCommand::*;
        let mut scene = opened_volume([800, 600]);
        apply_vp(
            &mut scene,
            Pan {
                dx: 30.0,
                dy: -10.0,
            },
        );
        let slice = scene.camera.clone();
        assert_eq!(slice.framing(), Framing::Placed);

        // The first visit to 3D fits the data.
        apply_vp(&mut scene, SetMode3D);
        assert_eq!(scene.camera.framing(), Framing::Framed);
        apply_vp(
            &mut scene,
            Rotate3D {
                d_theta: 0.4,
                d_phi: 0.1,
            },
        );
        let arcball = scene.camera.clone();

        apply_vp(&mut scene, SetMode2D);
        assert_eq!(scene.camera, slice, "2D comes back as the person left it");
        apply_vp(&mut scene, SetMode3D);
        assert_eq!(scene.camera, arcball, "3D comes back as the person left it");
    }

    #[test]
    fn a_parked_camera_follows_the_canvas() {
        use crate::command::ViewportCommand::*;
        let mut scene = opened_volume([800, 600]);
        apply_vp(&mut scene, Pan { dx: 30.0, dy: 0.0 });
        let zoom = scene.camera.effective_zoom();
        apply_vp(&mut scene, SetMode3D);
        apply_vp(
            &mut scene,
            SetViewport {
                width: 1000,
                height: 700,
                pixel_ratio: None,
            },
        );
        apply_vp(&mut scene, SetMode2D);
        assert_eq!(scene.camera.viewport(), [1000, 700]);
        assert_eq!(
            scene.camera.effective_zoom(),
            zoom,
            "a resize keeps a placed zoom"
        );
    }

    #[test]
    fn a_framed_camera_fits_a_resized_canvas_and_a_placed_one_keeps_its_zoom() {
        use crate::command::ViewportCommand::*;
        let mut framed = opened_volume([800, 600]);
        let zoom = framed.camera.effective_zoom();
        let resize = SetViewport {
            width: 400,
            height: 600,
            pixel_ratio: None,
        };
        apply_vp(&mut framed, resize.clone());
        assert_eq!(framed.camera.framing(), Framing::Framed);
        assert!(
            framed.camera.effective_zoom() < zoom,
            "a narrower canvas fits smaller"
        );

        let mut placed = opened_volume([800, 600]);
        apply_vp(&mut placed, Pan { dx: 1.0, dy: 0.0 });
        let zoom = placed.camera.effective_zoom();
        apply_vp(&mut placed, resize);
        assert_eq!(placed.camera.effective_zoom(), zoom);
    }

    #[test]
    fn steering_a_stand_in_keeps_it_unframed_until_there_is_data() {
        use crate::command::ViewportCommand::*;
        let mut scene = Scene::new([800, 600]);
        apply_vp(&mut scene, Pan { dx: 50.0, dy: 50.0 });
        assert_eq!(scene.camera.framing(), Framing::Unframed);
        let reg = test_helpers::make_dataset_opened("ds1", "test", 1);
        scene.apply(DocumentCommand::DatasetOpened(reg).into());
        assert_eq!(scene.camera.framing(), Framing::Framed);
    }

    #[test]
    fn removing_the_last_dataset_makes_the_next_open_fit() {
        use crate::command::ViewportCommand::*;
        let mut scene = opened_volume([800, 600]);
        apply_vp(&mut scene, Pan { dx: 30.0, dy: 0.0 });
        apply_vp(&mut scene, SetMode3D);
        scene.apply(
            DocumentCommand::RemoveDataset {
                id: DatasetId("vol".into()),
            }
            .into(),
        );
        assert_eq!(scene.camera.framing(), Framing::Unframed);
        assert!(scene.parked_camera.is_none());
        let reg = test_helpers::make_dataset_opened("ds1", "test", 1);
        scene.apply(DocumentCommand::DatasetOpened(reg).into());
        assert_eq!(scene.camera.framing(), Framing::Framed);
    }

    #[test]
    fn hiding_a_dataset_refits_a_framed_camera_to_what_is_left() {
        use crate::command::ViewportCommand::*;
        let mut scene = Scene::new([800, 600]);
        for (id, size) in [("small", 64), ("big", 4096)] {
            let reg = test_helpers::make_dataset_opened_with_shape(
                id,
                id,
                1,
                [1, 1, 1, size, size],
                [1, 1, 1, 64, 64],
                1,
            );
            scene.apply(DocumentCommand::DatasetOpened(reg).into());
        }
        let both = scene.camera.effective_zoom();
        apply_vp(
            &mut scene,
            SetDatasetVisible {
                dataset_id: "big".into(),
                visible: false,
            },
        );
        assert!(scene.camera.effective_zoom() > both * 10.0);
        assert_eq!(scene.camera.framing(), Framing::Framed);
    }

    #[test]
    fn a_framed_import_fits_this_canvas() {
        let source = opened_volume([1280, 800]);
        let mut page = opened_volume([390, 844]);
        page.apply(crate::command::ViewportCommand::Pan { dx: 9.0, dy: 0.0 }.into());
        page.import_presence(
            source.camera.clone(),
            source.view.clone(),
            source.display.clone(),
        );
        assert_eq!(page.camera, opened_volume([390, 844]).camera);
    }

    #[test]
    fn a_volume_import_parks_the_slice_camera() {
        use crate::command::ViewportCommand::*;
        let mut leader = opened_volume([800, 600]);
        apply_vp(&mut leader, SetMode3D);
        let mut page = opened_volume([800, 600]);
        apply_vp(&mut page, Pan { dx: 9.0, dy: 0.0 });
        let own = page.camera.clone();
        page.import_presence(
            leader.camera.clone(),
            leader.view.clone(),
            leader.display.clone(),
        );
        assert!(page.camera.is_volume());
        apply_vp(&mut page, SetMode2D);
        assert_eq!(page.camera, own);
    }

    #[test]
    fn fit_camera_to_dataset_bumps_view_epoch_on_success_only() {
        let mut scene = Scene::new([800, 600]);
        let reg = test_helpers::make_dataset_opened("ds1", "test", 1);
        scene.apply(DocumentCommand::DatasetOpened(reg).into());
        scene.apply(crate::command::ViewportCommand::Pan { dx: 40.0, dy: 0.0 }.into());
        let baseline = scene.epochs.clone();

        assert!(!scene.fit_camera_to_dataset("ghost"));
        assert_eq!(scene.epochs, baseline);

        // Success bumps only the view epoch, once.
        assert!(scene.fit_camera_to_dataset("ds1"));
        assert_eq!(scene.epochs.view, baseline.view + 1);
        assert_eq!(scene.epochs.selection, baseline.selection);
        assert_eq!(scene.epochs.content, baseline.content);
        assert_eq!(scene.epochs.layout, baseline.layout);
    }

    #[test]
    fn load_document_restores_state_and_advances_epochs() {
        // Donor: a live document with one 2-channel dataset.
        let mut donor = Scene::new([800, 600]);
        let reg = test_helpers::make_dataset_opened("ds1", "test", 2);
        donor.apply(DocumentCommand::DatasetOpened(reg).into());
        let doc = donor.document.clone();

        // Restore into a fresh scene with a distinctive local camera.
        let mut scene = test_helpers::placed_scene([640, 480]);
        scene.apply(crate::command::ViewportCommand::SetCenter { x: 42.0, y: 7.0 }.into());
        let baseline = scene.epochs.clone();
        let camera_before = scene.camera.clone();

        scene.load_document(doc);

        let ds_id = DatasetId("ds1".into());
        assert!(scene.document.manifests.contains_key(&ds_id));
        assert!(
            scene.derived.contains_key(&ds_id),
            "derived must be rebuilt"
        );
        assert!(scene.dataset_order.contains(&ds_id));
        // Settings are seeded with per-channel entries, not a bare Default.
        let settings = scene
            .dataset_settings
            .get(&ds_id)
            .expect("settings seeded for restored dataset");
        assert!(
            settings.channel_settings.len() >= 2,
            "expected per-channel settings seeded from the manifest, got {}",
            settings.channel_settings.len()
        );

        // Every document-scoped epoch advances so consumers re-read...
        assert!(scene.epochs.content > baseline.content);
        assert!(scene.epochs.layout > baseline.layout);
        assert!(scene.epochs.annotation > baseline.annotation);
        assert!(scene.epochs.selection > baseline.selection);
        // ...but the local camera is placed and untouched, so view does not.
        assert_eq!(scene.epochs.view, baseline.view);
        assert_eq!(scene.camera, camera_before);
    }

    #[test]
    fn load_document_keeps_local_settings_and_prunes_removed_datasets() {
        let mut donor = Scene::new([800, 600]);
        let reg = test_helpers::make_dataset_opened("ds1", "test", 1);
        donor.apply(DocumentCommand::DatasetOpened(reg).into());
        let doc = donor.document.clone();

        // The receiving scene already has ds1 (locally hidden) plus a stale
        // entry for a dataset the incoming document no longer contains.
        let mut scene = Scene::new([800, 600]);
        let reg = test_helpers::make_dataset_opened("ds1", "test", 1);
        scene.apply(DocumentCommand::DatasetOpened(reg).into());
        scene.apply(
            crate::command::ViewportCommand::SetDatasetVisible {
                dataset_id: "ds1".into(),
                visible: false,
            }
            .into(),
        );
        let stale = DatasetId("gone".into());
        scene.dataset_order.push(stale.clone());
        scene
            .dataset_settings
            .insert(stale.clone(), DatasetDisplaySettings::default());

        scene.load_document(doc);

        let ds_id = DatasetId("ds1".into());
        assert!(
            !scene.dataset_settings[&ds_id].visible,
            "locally adjusted settings must survive a re-load"
        );
        assert!(!scene.dataset_order.contains(&stale));
        assert!(!scene.dataset_settings.contains_key(&stale));
    }

    #[test]
    fn import_presence_keeps_the_region_and_bumps_iff_changed() {
        let mut scene = Scene::new([800, 600]);
        let baseline = scene.epochs.clone();

        // A peer's presence: different camera center, T selector, and gamma,
        // captured on a wider canvas.
        let remote_camera = Camera::Slice(crate::camera::Slice {
            center: [100.0, 200.0],
            zoom: 2.0,
            viewport: [1920, 1080],
            framing: Framing::Placed,
        });
        let mut remote_view = ViewState::new();
        remote_view.t = 3;
        let remote_display = DisplayState {
            gamma: 2.0,
            ..DisplayState::default()
        };

        scene.import_presence(
            remote_camera.clone(),
            remote_view.clone(),
            remote_display.clone(),
        );

        // The peer's 960 x 540 region spans this canvas's width, centered
        // where it was, with more of the world above and below.
        let Camera::Slice(v) = &scene.camera else {
            panic!("expected Slice camera");
        };
        assert_eq!(v.viewport, [800, 600]);
        let [x0, y0, x1, y1] = v.world_bounds();
        assert!((x0 - (100.0 - 480.0)).abs() < 1e-9 && (x1 - (100.0 + 480.0)).abs() < 1e-9);
        assert!(y0 < 200.0 - 270.0 && y1 > 200.0 + 270.0);
        assert_eq!(v.center, [100.0, 200.0]);
        assert_eq!(scene.view.t, 3);
        assert_eq!(scene.display.gamma, 2.0);
        assert_eq!(scene.epochs.view, baseline.view + 1);
        assert_eq!(scene.epochs.selection, baseline.selection + 1);

        // Re-importing the identical presence (an unchanged heartbeat) must
        // not invalidate consumers' epoch-keyed caches.
        let after_first = scene.epochs.clone();
        scene.import_presence(remote_camera, remote_view, remote_display);
        assert_eq!(scene.epochs, after_first);
    }

    #[test]
    fn imported_presence_camera_is_clamped_to_mutator_ranges() {
        use crate::camera::{Arcball, SLICE_ZOOM_MIN, Slice};
        use crate::scene::DisplayState;

        // A peer's zoom of 0.0 is finite and serializes fine, but unclamped it
        // turns the next pan into a 0/0 = NaN center.
        let mut scene = Scene::new([800, 600]);
        let zero_zoom = Camera::Slice(Slice {
            center: [10.0, 20.0],
            zoom: 0.0,
            viewport: [64, 64],
            framing: Framing::Placed,
        });
        scene.import_presence(zero_zoom.clone(), ViewState::new(), DisplayState::default());
        match &scene.camera {
            Camera::Slice(v) => {
                assert!(
                    v.zoom >= SLICE_ZOOM_MIN && v.zoom.is_finite(),
                    "imported zoom {} must be clamped",
                    v.zoom
                );
                assert_eq!(v.viewport, [800, 600], "local viewport wins");
            }
            other => panic!("expected Slice camera, got {other:?}"),
        }

        // Sanitizing is idempotent: re-importing the identical (still
        // out-of-range) presence clamps to the same camera → epoch-silent.
        let epochs = scene.epochs.clone();
        scene.import_presence(zero_zoom, ViewState::new(), DisplayState::default());
        assert_eq!(scene.epochs, epochs);

        // Pan after the clamp stays finite.
        scene.apply(crate::command::ViewportCommand::Pan { dx: 3.0, dy: 0.0 }.into());
        match &scene.camera {
            Camera::Slice(v) => {
                assert!(v.center[0].is_finite() && v.center[1].is_finite());
            }
            other => panic!("expected Slice camera, got {other:?}"),
        }

        // Same rule for a 3D peer: a zero orbit distance clamps to >= near
        // (what the arcball's own zoom mutator enforces).
        let bad_arcball = Camera::Arcball(Arcball {
            distance: 0.0,
            ..Arcball::new([32, 32])
        });
        scene.import_presence(bad_arcball, ViewState::new(), DisplayState::default());
        match &scene.camera {
            Camera::Arcball(v) => {
                assert!(
                    v.distance.is_finite() && v.distance >= v.near && v.near > 0.0,
                    "imported distance {} must be clamped to >= near {}",
                    v.distance,
                    v.near
                );
            }
            other => panic!("expected Arcball camera, got {other:?}"),
        }
    }

    #[test]
    fn import_dataset_presence_bumps_selection_iff_changed() {
        let mut scene = Scene::new([800, 600]);
        let reg = test_helpers::make_dataset_opened("ds1", "test", 1);
        scene.apply(DocumentCommand::DatasetOpened(reg).into());
        let baseline = scene.epochs.clone();

        let ds_id = DatasetId("ds1".into());
        let order = vec![ds_id.clone()];
        let mut settings = scene.dataset_settings.clone();
        settings.get_mut(&ds_id).unwrap().opacity = 0.25;

        scene.import_dataset_presence(order.clone(), settings.clone());
        assert_eq!(scene.dataset_settings[&ds_id].opacity, 0.25);
        assert_eq!(scene.epochs.selection, baseline.selection + 1);
        assert_eq!(scene.epochs.view, baseline.view);

        // Identical rebroadcast: no further bump.
        scene.import_dataset_presence(order, settings);
        assert_eq!(scene.epochs.selection, baseline.selection + 1);
    }

    #[test]
    fn import_dataset_presence_reconciles_per_label_by_name() {
        // The recipient holds a dataset whose labels are, in order,
        // label-0, label-1, label-2.
        let mut scene = Scene::new([800, 600]);
        let reg = test_helpers::make_dataset_opened_with_labels("ds1", "test", 1, 3);
        scene.apply(DocumentCommand::DatasetOpened(reg).into());
        let ds_id = DatasetId("ds1".into());

        // The peer's label list is in a different order (label-2, label-0,
        // label-1). Applied positionally each opacity would land on the wrong
        // label.
        let mut settings = scene.dataset_settings.clone();
        {
            let s = settings.get_mut(&ds_id).unwrap();
            s.label_names = vec!["label-2".into(), "label-0".into(), "label-1".into()];
            s.label_settings = vec![
                LabelSettings {
                    visible: true,
                    opacity: 0.2,
                },
                LabelSettings {
                    visible: true,
                    opacity: 0.0,
                },
                LabelSettings {
                    visible: true,
                    opacity: 0.1,
                },
            ];
        }

        scene.import_dataset_presence(vec![ds_id.clone()], settings);

        let applied = &scene.dataset_settings[&ds_id];
        // Remapped onto the recipient's [label-0, label-1, label-2] order.
        assert_eq!(applied.label_settings[0].opacity, 0.0); // label-0
        assert_eq!(applied.label_settings[1].opacity, 0.1); // label-1
        assert_eq!(applied.label_settings[2].opacity, 0.2); // label-2
        // The stored names now describe the recipient's current order.
        assert_eq!(applied.label_names, vec!["label-0", "label-1", "label-2"]);
    }

    #[test]
    fn import_dataset_presence_legacy_blob_stays_positional() {
        // An older peer sends no label_names, so settings apply by index.
        let mut scene = Scene::new([800, 600]);
        let reg = test_helpers::make_dataset_opened_with_labels("ds1", "test", 1, 3);
        scene.apply(DocumentCommand::DatasetOpened(reg).into());
        let ds_id = DatasetId("ds1".into());

        let mut settings = scene.dataset_settings.clone();
        {
            let s = settings.get_mut(&ds_id).unwrap();
            s.label_names = Vec::new(); // legacy
            s.label_settings = vec![
                LabelSettings {
                    visible: true,
                    opacity: 0.0,
                },
                LabelSettings {
                    visible: true,
                    opacity: 0.1,
                },
                LabelSettings {
                    visible: true,
                    opacity: 0.2,
                },
            ];
        }

        scene.import_dataset_presence(vec![ds_id.clone()], settings);

        let applied = &scene.dataset_settings[&ds_id];
        assert_eq!(applied.label_settings[0].opacity, 0.0);
        assert_eq!(applied.label_settings[1].opacity, 0.1);
        assert_eq!(applied.label_settings[2].opacity, 0.2);
    }

    fn scene_with_datasets(ids: &[&str]) -> Scene {
        let mut scene = Scene::new([800, 600]);
        for id in ids {
            let reg = test_helpers::make_dataset_opened(id, id, 2);
            scene.apply(DocumentCommand::DatasetOpened(reg).into());
        }
        scene
    }

    #[test]
    fn import_empty_dataset_presence_leaves_layers_unchanged() {
        let mut scene = scene_with_datasets(&["ds1", "ds2"]);
        let ds1 = DatasetId("ds1".into());
        scene.dataset_settings.get_mut(&ds1).unwrap().opacity = 0.4;
        let order = scene.dataset_order.clone();
        let settings = scene.dataset_settings.clone();
        let epochs = scene.epochs.clone();

        scene.import_dataset_presence(Vec::new(), HashMap::new());

        assert_eq!(scene.dataset_order, order);
        assert_eq!(scene.dataset_settings, settings);
        assert_eq!(scene.epochs, epochs);
    }

    #[test]
    fn import_dataset_presence_merges_per_dataset() {
        let mut scene = scene_with_datasets(&["ds1", "ds2", "ds3"]);
        let [ds1, ds2, ds3] = ["ds1", "ds2", "ds3"].map(|id| DatasetId(id.into()));
        scene.dataset_settings.get_mut(&ds3).unwrap().opacity = 0.3;

        // The peer knows ds1 and ds2 in the other order, and one dataset this
        // document never had.
        let gone = DatasetId("gone".into());
        let mut peer_ds2 = scene.dataset_settings[&ds2].clone();
        peer_ds2.visible = false;
        let peer_settings = HashMap::from([
            (ds2.clone(), peer_ds2),
            (ds1.clone(), scene.dataset_settings[&ds1].clone()),
            (gone.clone(), DatasetDisplaySettings::default()),
        ]);
        scene.import_dataset_presence(vec![ds2.clone(), gone.clone(), ds1.clone()], peer_settings);

        assert_eq!(scene.dataset_order, vec![ds2.clone(), ds1, ds3.clone()]);
        assert!(!scene.dataset_settings[&ds2].visible);
        // Only the follower has ds3, so its settings stay.
        assert_eq!(scene.dataset_settings[&ds3].opacity, 0.3);
        assert!(!scene.dataset_settings.contains_key(&gone));
    }

    // The hash indexes (member_index, LayoutPositionIndex, the per-dataset
    // extent maxima, the bulk matrix export) exist only for speed. Each test
    // pins one to its linear-scan definition, on fixtures with duplicate ids,
    // unplaced parents, and missing transform edges.

    #[test]
    fn member_by_id_matches_linear_scan_for_both_id_namespaces() {
        let mut scene = Scene::new([800, 600]);
        let reg = test_helpers::make_grouped_collection_opened("coll", 4, 6);
        scene.apply(DocumentCommand::DatasetOpened(reg).into());
        let derived = scene.derived.get(&DatasetId("coll".into())).unwrap();

        for member in &derived.members {
            for id in [member.image_id.0.as_str(), member.entity_id.0.as_str()] {
                let expected = derived
                    .members
                    .iter()
                    .find(|m| m.image_id.0 == id || m.entity_id.0 == id)
                    .unwrap();
                let got = derived.member_by_id(id).unwrap();
                assert_eq!(got.entity_id, expected.entity_id);
                assert_eq!(got.image_id, expected.image_id);
            }
        }
        assert!(derived.member_by_id("no-such-member").is_none());
    }

    #[test]
    fn layout_position_index_matches_single_lookup_resolver() {
        use lucida_content::layout::EntityPlacement;

        let ent = |id: &str, parent: Option<&str>| Entity {
            id: EntityId(id.into()),
            kind: EntityKind::Tile,
            parent: parent.map(|p| EntityId(p.into())),
            labels: EntityLabels::default(),
        };
        let entities = vec![
            ent("placed-direct", None),
            ent("tile-with-edge", Some("placed-direct")),
            ent("tile-without-edge", Some("placed-direct")),
            ent("tile-unplaced-parent", Some("nowhere")),
            ent("tile-no-parent", None),
            // Duplicate entity id with a different parent: first must win.
            ent("tile-with-edge", Some("nowhere")),
        ];
        let transforms = vec![
            TransformEdge {
                from: EntityId("tile-with-edge".into()),
                to: EntityId("placed-direct".into()),
                transform: VoxelTransform::from_voxel_translation_2d(10.0, 20.0),
            },
            // Duplicate edge with a different offset: first must win.
            TransformEdge {
                from: EntityId("tile-with-edge".into()),
                to: EntityId("placed-direct".into()),
                transform: VoxelTransform::from_voxel_translation_2d(999.0, 999.0),
            },
        ];
        let layout = LayoutSpec {
            id: LayoutId("l".into()),
            name: "L".into(),
            placements: vec![
                EntityPlacement {
                    entity_id: EntityId("placed-direct".into()),
                    position: [5.0, 7.0],
                },
                // Duplicate placement: first must win.
                EntityPlacement {
                    entity_id: EntityId("placed-direct".into()),
                    position: [-1.0, -1.0],
                },
            ],
        };

        let index = LayoutPositionIndex::new(&layout, &entities, &transforms);
        for id in [
            "placed-direct",
            "tile-with-edge",
            "tile-without-edge",
            "tile-unplaced-parent",
            "tile-no-parent",
            "unknown-entity",
        ] {
            let entity_id = EntityId(id.into());
            assert_eq!(
                index.resolve(&entity_id),
                resolve_entity_position(&entity_id, &layout, &entities, &transforms),
                "position mismatch for entity '{id}'"
            );
        }
    }

    #[test]
    fn per_dataset_extent_maxima_match_member_folds() {
        let mut scene = Scene::new([800, 600]);
        scene.apply(
            DocumentCommand::DatasetOpened(test_helpers::make_dataset_opened_with_shape(
                "small",
                "small",
                1,
                [1, 1, 8, 128, 128],
                [1, 1, 8, 64, 64],
                1,
            ))
            .into(),
        );
        scene.apply(
            DocumentCommand::DatasetOpened(test_helpers::make_dataset_opened_with_shape(
                "large",
                "large",
                1,
                [1, 1, 64, 4096, 2048],
                [1, 1, 16, 256, 256],
                3,
            ))
            .into(),
        );

        let fold_extent = |members: &[MemberState]| {
            members
                .iter()
                .map(|m| {
                    let e = m.volume_transform.max_physical_extent;
                    if e > 0.0 { e } else { 1.0 }
                })
                .fold(0.0_f64, f64::max)
        };
        let fold_y = |members: &[MemberState]| {
            members
                .iter()
                .map(|m| {
                    let t = &m.volume_transform;
                    let e = if t.max_physical_extent > 0.0 {
                        t.max_physical_extent
                    } else {
                        1.0
                    };
                    t.model[5] as f64 * e
                })
                .fold(0.0_f64, f64::max)
        };

        let mut expected_extent = 0.0_f64;
        let mut expected_y = 0.0_f64;
        for derived in scene.derived.values() {
            assert_eq!(derived.max_physical_extent, fold_extent(&derived.members));
            assert_eq!(derived.max_physical_y, fold_y(&derived.members));
            expected_extent = expected_extent.max(derived.max_physical_extent);
            expected_y = expected_y.max(derived.max_physical_y);
        }
        assert_eq!(scene.global_max_physical_extent(), expected_extent);
        assert_eq!(scene.global_max_physical_y(), expected_y);
    }

    #[test]
    fn member_render_matrices_match_per_member_queries() {
        let mut scene = Scene::new([800, 600]);
        let reg = test_helpers::make_grouped_collection_opened("coll", 3, 5);
        scene.apply(DocumentCommand::DatasetOpened(reg).into());
        // 3D mode so the global correction + top-alignment terms are exercised.
        scene.set_mode_3d();

        let ids = scene.member_render_ids("coll");
        let flat = scene.member_render_matrices("coll");
        let derived = scene.derived.get(&DatasetId("coll".into())).unwrap();

        assert_eq!(ids.len(), derived.members.len());
        assert_eq!(flat.len(), derived.members.len() * 32);

        for (i, member) in derived.members.iter().enumerate() {
            assert_eq!(ids[i], member.image_id.0);
            let fwd = scene.member_world_matrix(member);
            let inv = scene.rendering_transform(member).1.inv_model;
            assert_eq!(&flat[i * 32..i * 32 + 16], &fwd[..]);
            assert_eq!(&flat[i * 32 + 16..i * 32 + 32], &inv[..]);
        }

        assert!(scene.member_render_ids("missing").is_empty());
        assert!(scene.member_render_matrices("missing").is_empty());
    }

    // Wide collections (hundreds of groups × tens of thousands of tiles) make
    // any per-member linear scan quadratic in the member count. Each test
    // times the same operation at 1× and 4× member count and bounds the
    // ratio: linear work lands near 4×, quadratic near 16×. The bound of 10×
    // is deliberately loose (shared CI machines are noisy; best-of-3 damps
    // scheduling spikes) while still cleanly separating the two regimes.

    fn best_of_3<F: FnMut()>(mut f: F) -> std::time::Duration {
        let mut best = std::time::Duration::MAX;
        for _ in 0..3 {
            let start = std::time::Instant::now();
            f();
            best = best.min(start.elapsed());
        }
        best
    }

    const SCALING_GROUPS_1X: usize = 100; // × 40 tiles = 4_000 members
    const SCALING_GROUPS_4X: usize = 400; // × 40 tiles = 16_000 members
    const SCALING_TILES_PER_GROUP: usize = 40;
    const SCALING_RATIO_BOUND: f64 = 10.0;

    fn grouped_scene(groups: usize) -> Scene {
        let mut scene = Scene::new([800, 600]);
        let reg =
            test_helpers::make_grouped_collection_opened("coll", groups, SCALING_TILES_PER_GROUP);
        scene.apply(DocumentCommand::DatasetOpened(reg).into());
        scene
    }

    #[test]
    fn dataset_open_apply_scales_linearly_with_member_count() {
        let time_apply = |groups: usize| {
            let reg = test_helpers::make_grouped_collection_opened(
                "coll",
                groups,
                SCALING_TILES_PER_GROUP,
            );
            best_of_3(|| {
                let mut scene = Scene::new([800, 600]);
                scene.apply(DocumentCommand::DatasetOpened(reg.clone()).into());
            })
        };

        let t1 = time_apply(SCALING_GROUPS_1X);
        let t4 = time_apply(SCALING_GROUPS_4X);
        let ratio = t4.as_secs_f64() / t1.as_secs_f64().max(1e-9);
        assert!(
            ratio < SCALING_RATIO_BOUND,
            "4× members took {ratio:.1}× as long ({t1:?} → {t4:?}); \
             expected near-linear scaling"
        );
    }

    #[test]
    fn full_member_matrix_pass_scales_linearly_with_member_count() {
        // The per-member matrix queries the render/minimap paths issue for
        // every member: resolve by id, then build the forward + inverse
        // transform (which folds in the scene-global placement correction).
        let time_pass = |groups: usize| {
            let scene = grouped_scene(groups);
            let derived = scene.derived.get(&DatasetId("coll".into())).unwrap();
            let ids: Vec<String> = derived
                .members
                .iter()
                .map(|m| m.image_id.0.clone())
                .collect();
            best_of_3(|| {
                for id in &ids {
                    let member = derived.member_by_id(id).unwrap();
                    let (fwd, inv) = scene.rendering_transform(member);
                    std::hint::black_box((fwd.model[12], inv.inv_model[12]));
                }
            })
        };

        let t1 = time_pass(SCALING_GROUPS_1X);
        let t4 = time_pass(SCALING_GROUPS_4X);
        let ratio = t4.as_secs_f64() / t1.as_secs_f64().max(1e-9);
        assert!(
            ratio < SCALING_RATIO_BOUND,
            "4× members took {ratio:.1}× as long ({t1:?} → {t4:?}); \
             expected near-linear scaling"
        );
    }

    #[test]
    fn view_query_scales_linearly_with_member_count() {
        let time_query = |groups: usize| {
            let scene = grouped_scene(groups);
            let ds_id = DatasetId("coll".into());
            best_of_3(|| {
                std::hint::black_box(scene.view_query(&ds_id).unwrap());
            })
        };

        let t1 = time_query(SCALING_GROUPS_1X);
        let t4 = time_query(SCALING_GROUPS_4X);
        let ratio = t4.as_secs_f64() / t1.as_secs_f64().max(1e-9);
        assert!(
            ratio < SCALING_RATIO_BOUND,
            "4× members took {ratio:.1}× as long ({t1:?} → {t4:?}); \
             expected near-linear scaling"
        );
    }

    fn record(id: &str, visible: bool, lod: u32, kind: EntityKind) -> EntityQueryResult {
        EntityQueryResult {
            entity_id: EntityId(id.to_string()),
            image_id: ImageId(format!("{id}-image")),
            kind,
            visible,
            projected_diagonal_px: 1.0,
            projected_area_px2: 1.0,
            centroid_world: [0.0, 0.0, 0.0],
            target_level: lod,
            level_pinned: false,
            importance: 1.0,
        }
    }

    fn snapshot(current: &[EntityQueryResult]) -> HashMap<ImageId, QuantizedEntity> {
        current
            .iter()
            .map(|e| (e.image_id.clone(), QuantizedEntity::of(e)))
            .collect()
    }

    #[test]
    fn diff_reports_entered_left_and_changed() {
        // prev: a (visible, lod 0), b (visible, lod 1)
        let prev_records = [
            record("a", true, 0, EntityKind::Image),
            record("b", true, 1, EntityKind::Image),
        ];
        let prev = snapshot(&prev_records);

        // current: a unchanged, b changed (lod 1 → 2), c entered; b's continuous
        // fields differ too but that is irrelevant.
        let current = [
            record("a", true, 0, EntityKind::Image),
            record("b", true, 2, EntityKind::Image),
            record("c", false, 3, EntityKind::Tile),
        ];
        let new_entries = snapshot(&current);
        let (entered, left, changed) = view_query_diff(&prev, &current, &new_entries);

        assert_eq!(
            entered
                .iter()
                .map(|e| e.entity_id.0.as_str())
                .collect::<Vec<_>>(),
            vec!["c"]
        );
        assert_eq!(
            changed
                .iter()
                .map(|e| e.entity_id.0.as_str())
                .collect::<Vec<_>>(),
            vec!["b"]
        );
        assert!(left.is_empty());
        // `a` is unchanged, so it appears in none of the vectors.
        assert!(!entered.iter().chain(&changed).any(|e| e.entity_id.0 == "a"));
    }

    #[test]
    fn diff_reports_left_when_membership_shrinks() {
        let prev_records = [
            record("a", true, 0, EntityKind::Image),
            record("b", true, 0, EntityKind::Image),
        ];
        let prev = snapshot(&prev_records);
        let current = [record("a", true, 0, EntityKind::Image)];
        let new_entries = snapshot(&current);

        let (entered, left, changed) = view_query_diff(&prev, &current, &new_entries);
        assert!(entered.is_empty());
        assert!(changed.is_empty());
        assert_eq!(left, vec![ImageId("b-image".into())]);
    }

    #[test]
    fn diff_visibility_flip_is_a_change_not_a_departure() {
        // An entity that stays in the set but flips visible is `changed`,
        // never `left` — presence is membership, not on-screen visibility.
        let prev_records = [record("a", true, 0, EntityKind::Image)];
        let prev = snapshot(&prev_records);
        let current = [record("a", false, 0, EntityKind::Image)];
        let new_entries = snapshot(&current);

        let (entered, left, changed) = view_query_diff(&prev, &current, &new_entries);
        assert!(entered.is_empty());
        assert!(left.is_empty());
        assert_eq!(changed.len(), 1);
        assert!(!changed[0].visible);
    }

    #[test]
    fn diff_kind_change_is_a_change() {
        let prev_records = [record("a", true, 0, EntityKind::Image)];
        let prev = snapshot(&prev_records);
        let current = [record("a", true, 0, EntityKind::Tile)];
        let new_entries = snapshot(&current);

        let (_, _, changed) = view_query_diff(&prev, &current, &new_entries);
        assert_eq!(changed.len(), 1);
        assert_eq!(changed[0].kind, EntityKind::Tile);
    }

    #[test]
    fn diff_ignores_continuous_only_changes() {
        let prev_records = [record("a", true, 0, EntityKind::Image)];
        let prev = snapshot(&prev_records);
        // Same quantized state, different continuous fields.
        let mut moved = record("a", true, 0, EntityKind::Image);
        moved.importance = 999.0;
        moved.projected_area_px2 = 42.0;
        moved.centroid_world = [7.0, 8.0, 9.0];
        let current = [moved];
        let new_entries = snapshot(&current);

        let (entered, left, changed) = view_query_diff(&prev, &current, &new_entries);
        assert!(entered.is_empty());
        assert!(left.is_empty());
        assert!(changed.is_empty());
    }

    #[test]
    fn diff_vectors_are_sorted_by_image_id() {
        // Records are keyed and ordered by `image_id`, not `entity_id`. Here
        // entity_id order is the reverse of image_id order, so sorting by
        // `entity_id` would fail.
        let rec = |entity_id: &str, image_id: &str, lod: u32| EntityQueryResult {
            entity_id: EntityId(entity_id.to_string()),
            image_id: ImageId(image_id.to_string()),
            kind: EntityKind::Image,
            visible: true,
            projected_diagonal_px: 1.0,
            projected_area_px2: 1.0,
            centroid_world: [0.0, 0.0, 0.0],
            target_level: lod,
            level_pinned: false,
            importance: 1.0,
        };

        // (entity_id, image_id): ("z", "img-a"), ("y", "img-b"), ("x", "img-c").
        // image_id order is a→b→c; entity_id order is x→y→z (the reverse).

        // entered: fresh membership, supplied in a shuffled input order.
        let entered_fixture = [
            rec("y", "img-b", 0),
            rec("x", "img-c", 0),
            rec("z", "img-a", 0),
        ];
        let entered_entries = snapshot(&entered_fixture);
        let (entered, _, _) = view_query_diff(&HashMap::new(), &entered_fixture, &entered_entries);
        assert_eq!(
            entered
                .iter()
                .map(|e| e.image_id.0.as_str())
                .collect::<Vec<_>>(),
            vec!["img-a", "img-b", "img-c"]
        );
        // Sanity: those correspond to entity_ids in reverse order, proving the
        // keys diverge (an entity_id sort would yield img-c, img-b, img-a).
        assert_eq!(
            entered
                .iter()
                .map(|e| e.entity_id.0.as_str())
                .collect::<Vec<_>>(),
            vec!["z", "y", "x"]
        );

        // changed: same membership, quantized state (lod) differs; shuffled.
        let prev_changed = [
            rec("z", "img-a", 0),
            rec("y", "img-b", 0),
            rec("x", "img-c", 0),
        ];
        let current_changed = [
            rec("y", "img-b", 5),
            rec("x", "img-c", 5),
            rec("z", "img-a", 5),
        ];
        let changed_entries = snapshot(&current_changed);
        let (_, _, changed) =
            view_query_diff(&snapshot(&prev_changed), &current_changed, &changed_entries);
        assert_eq!(
            changed
                .iter()
                .map(|e| e.image_id.0.as_str())
                .collect::<Vec<_>>(),
            vec!["img-a", "img-b", "img-c"]
        );

        // left: entities present in prev, dropped from current; shuffled prev.
        let prev_left = [
            rec("y", "img-b", 0),
            rec("x", "img-c", 0),
            rec("z", "img-a", 0),
        ];
        let current_left: [EntityQueryResult; 0] = [];
        let left_entries = snapshot(&current_left);
        let (_, left, _) = view_query_diff(&snapshot(&prev_left), &current_left, &left_entries);
        assert_eq!(
            left.iter().map(|id| id.0.as_str()).collect::<Vec<_>>(),
            vec!["img-a", "img-b", "img-c"]
        );
    }

    #[test]
    fn diff_re_entry_after_departure_arrives_in_entered() {
        // Step 1: a leaves.
        let s0 = [
            record("a", true, 0, EntityKind::Image),
            record("b", true, 0, EntityKind::Image),
        ];
        let s1 = [record("b", true, 0, EntityKind::Image)];
        let m1 = snapshot(&s1);
        let (_, left, _) = view_query_diff(&snapshot(&s0), &s1, &m1);
        assert_eq!(left, vec![ImageId("a-image".into())]);

        // Step 2: a returns — because the prior snapshot fully dropped it, it
        // reappears as `entered` with a full record, not silently retained.
        let s2 = [
            record("a", true, 5, EntityKind::Image),
            record("b", true, 0, EntityKind::Image),
        ];
        let m2 = snapshot(&s2);
        let (entered, left, changed) = view_query_diff(&m1, &s2, &m2);
        assert_eq!(entered.len(), 1);
        assert_eq!(entered[0].entity_id.0, "a");
        assert_eq!(entered[0].target_level, 5);
        assert!(left.is_empty());
        assert!(changed.is_empty());
    }
}
