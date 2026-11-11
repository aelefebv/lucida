//! How the two views of a layout follow each other. Pan, zoom, 3D
//! orientation, the depth a slice view cuts and the timepoint link one by
//! one. A linked property follows the steered view to the same value, a
//! relative one keeps the offset it had when it was linked, and one that is
//! off stays put.
//!
//! Each view links by its top visible dataset. Two that each declare
//! physical units compare as the scene frame places them, so they meet at
//! their true size and place. Any others compare in their own samples, the
//! voxel basis.

use serde::{Deserialize, Serialize};

use lucida_content::{DatasetId, SpatialAxis};

use super::Scene;
use super::link_notices::ViewLinkNotices;
use crate::camera::{Camera, Framing};
use crate::command::{Command, ViewportCommand};
use crate::placement::{Affine, LineUp};
use crate::slice_plane::SlicePlane;
use crate::view::{AxisPositions, View, ViewId};

/// A part of what a view shows that can follow the other view.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum LinkProperty {
    Pan,
    Zoom,
    Orientation,
    Z,
    T,
}

impl LinkProperty {
    pub const ALL: [LinkProperty; 5] = [
        LinkProperty::Pan,
        LinkProperty::Zoom,
        LinkProperty::Orientation,
        LinkProperty::Z,
        LinkProperty::T,
    ];

    fn index(self) -> usize {
        self as usize
    }
}

impl std::fmt::Display for LinkProperty {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(match self {
            LinkProperty::Pan => "pan",
            LinkProperty::Zoom => "zoom",
            LinkProperty::Orientation => "orientation",
            LinkProperty::Z => "z",
            LinkProperty::T => "t",
        })
    }
}

/// How a property follows the other view.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum LinkMode {
    #[default]
    Off,
    /// To the same value.
    Linked,
    /// Keeping the offset it had when it was linked.
    Relative,
}

impl std::fmt::Display for LinkMode {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(match self {
            LinkMode::Off => "off",
            LinkMode::Linked => "linked",
            LinkMode::Relative => "relative",
        })
    }
}

/// What linked positions and sizes compare in.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum LinkBasis {
    /// Physical lengths, as the scene frame places both datasets.
    Physical,
    /// Each dataset's own samples, so the same sample meets the same sample.
    Voxel,
}

/// Why a property can't link between the two views as they stand.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Unlinkable {
    /// A view shows nothing to compare.
    Empty,
    /// The two cameras don't share it. Pan and zoom need two slice views of
    /// one plane or two orbit cameras, orientation two orbit cameras, and
    /// depth two slice views of one plane.
    Cameras,
}

/// Why two datasets compared in their own samples link by default: the
/// views show the same samples in the same place.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Alike {
    /// Both views show one dataset.
    SameDataset,
    /// Two datasets of one extent, placed alike.
    SamePlacement,
}

/// One property's link as the views stand.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct PropertyLink {
    pub property: LinkProperty,
    pub mode: LinkMode,
    /// Why the mode can't apply now, if it can't.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub unlinkable: Option<Unlinkable>,
}

/// The links between the two views of a layout of two.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct LinksState {
    /// What the views compare in, once each shows a dataset.
    pub basis: Option<LinkBasis>,
    /// Why a pair in the voxel basis links by default, when it does.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub alike: Option<Alike>,
    pub properties: Vec<PropertyLink>,
    /// Where the links take each view past what it shows.
    pub notices: Vec<ViewLinkNotices>,
}

/// The views' links: each property's mode, and what a relative one keeps.
/// The modes belong to the pair of datasets the views link by. Another pair
/// takes the defaults again.
#[derive(Debug, Clone, Default, PartialEq)]
pub(crate) struct ViewLinks {
    /// The dataset the first and the second view each link by.
    references: [Option<DatasetId>; 2],
    modes: [LinkMode; 5],
    offsets: [Option<Offset>; 5],
}

impl ViewLinks {
    /// The datasets the views link by, once each shows one.
    fn pair(&self) -> Option<[DatasetId; 2]> {
        match &self.references {
            [Some(first), Some(second)] => Some([first.clone(), second.clone()]),
            _ => None,
        }
    }
}

/// One property's value in one view, in the numbers its camera or axis
/// positions hold.
#[derive(Debug, Clone, Copy, PartialEq)]
enum LinkValue {
    /// A slice view's center, in its plane of the scene frame.
    SliceCenter {
        plane: SlicePlane,
        at: [f64; 2],
    },
    /// A slice view's device pixels per scene-frame unit.
    SliceZoom {
        plane: SlicePlane,
        zoom: f64,
    },
    /// An orbit camera's target, in world space.
    OrbitTarget([f64; 3]),
    /// An orbit camera's distance from its target, in world units.
    OrbitDistance(f64),
    /// An orbit camera's angles, `[theta, phi]`.
    OrbitAngles([f64; 2]),
    /// A slice view's place along the axis its plane cuts, and along Z the
    /// slab's ends when it spans more than one position.
    Cut {
        plane: SlicePlane,
        at: f64,
        slab: Option<[f64; 2]>,
    },
    Timepoint(i64),
}

impl LinkValue {
    /// Whether `other` is a value of the same kind, so one can follow the
    /// other.
    fn pairs_with(self, other: LinkValue) -> bool {
        use LinkValue::*;
        match (self, other) {
            (SliceCenter { plane: a, .. }, SliceCenter { plane: b, .. })
            | (SliceZoom { plane: a, .. }, SliceZoom { plane: b, .. })
            | (Cut { plane: a, .. }, Cut { plane: b, .. }) => a == b,
            (OrbitTarget(_), OrbitTarget(_))
            | (OrbitDistance(_), OrbitDistance(_))
            | (OrbitAngles(_), OrbitAngles(_))
            | (Timepoint(_), Timepoint(_)) => true,
            _ => false,
        }
    }

    /// The offset between this value and `other`, `other` against this: a
    /// ratio for a size, a difference otherwise.
    fn offset_to(self, other: LinkValue) -> Option<Delta> {
        use LinkValue::*;
        Some(match (self, other) {
            (SliceCenter { at: a, .. }, SliceCenter { at: b, .. }) => {
                Delta::Shift([b[0] - a[0], b[1] - a[1], 0.0])
            }
            (OrbitTarget(a), OrbitTarget(b)) => Delta::Shift(std::array::from_fn(|i| b[i] - a[i])),
            (OrbitAngles(a), OrbitAngles(b)) => Delta::Shift([b[0] - a[0], b[1] - a[1], 0.0]),
            (Cut { at: a, .. }, Cut { at: b, .. }) => Delta::Shift([b - a, 0.0, 0.0]),
            (SliceZoom { zoom: a, .. }, SliceZoom { zoom: b, .. })
            | (OrbitDistance(a), OrbitDistance(b)) => Delta::Ratio(b / a),
            (Timepoint(a), Timepoint(b)) => Delta::Steps(b - a),
            _ => return None,
        })
    }

    /// This value moved by `delta`, or back by it with `back`.
    fn moved(self, delta: Delta, back: bool) -> LinkValue {
        use LinkValue::*;
        let shift = |v: f64, by: f64| if back { v - by } else { v + by };
        let scale = |v: f64, by: f64| if back { v / by } else { v * by };
        match (self, delta) {
            (SliceCenter { plane, at }, Delta::Shift(by)) => SliceCenter {
                plane,
                at: [shift(at[0], by[0]), shift(at[1], by[1])],
            },
            (OrbitTarget(at), Delta::Shift(by)) => {
                OrbitTarget(std::array::from_fn(|i| shift(at[i], by[i])))
            }
            (OrbitAngles(at), Delta::Shift(by)) => {
                OrbitAngles([shift(at[0], by[0]), shift(at[1], by[1])])
            }
            (Cut { plane, at, slab }, Delta::Shift(by)) => Cut {
                plane,
                at: shift(at, by[0]),
                slab: slab.map(|ends| ends.map(|end| shift(end, by[0]))),
            },
            (SliceZoom { plane, zoom }, Delta::Ratio(by)) => SliceZoom {
                plane,
                zoom: scale(zoom, by),
            },
            (OrbitDistance(d), Delta::Ratio(by)) => OrbitDistance(scale(d, by)),
            (Timepoint(t), Delta::Steps(by)) => Timepoint(if back { t - by } else { t + by }),
            (value, _) => value,
        }
    }
}

/// How far apart two values of one kind are: a shift, a ratio for a size,
/// or a count of positions.
#[derive(Debug, Clone, Copy, PartialEq)]
enum Delta {
    Shift([f64; 3]),
    Ratio(f64),
    Steps(i64),
}

/// What a relative link keeps: the second view's value against the first's
/// carried into its basis, with the first's value it was taken from, so a
/// change of camera takes a new one.
#[derive(Debug, Clone, Copy, PartialEq)]
struct Offset {
    from: LinkValue,
    delta: Delta,
}

/// The maps from the first view's numbers into the second's: `scene` for a
/// slice camera's, `world` for an orbit camera's.
#[derive(Debug, Clone, Copy)]
struct LinkMaps {
    scene: Affine,
    world: Affine,
}

impl LinkMaps {
    fn inverse(&self) -> LinkMaps {
        LinkMaps {
            scene: self.scene.inverse(),
            world: self.world.inverse(),
        }
    }

    /// `value` read in the other view's numbers. A size scales against the
    /// lengths it shows: a zoom divides by the map's stretch, since it counts
    /// pixels per unit, and a distance multiplies by it.
    fn carry(&self, value: LinkValue) -> LinkValue {
        use LinkValue::*;
        match value {
            SliceCenter { plane, at } => {
                let [across, down, _] = plane.axes().map(SpatialAxis::xyz);
                let mut point = [0.0; 3];
                (point[across], point[down]) = (at[0], at[1]);
                let moved = self.scene.apply(point);
                SliceCenter {
                    plane,
                    at: [moved[across], moved[down]],
                }
            }
            SliceZoom { plane, zoom } => SliceZoom {
                plane,
                zoom: zoom / self.scene.length_scale(),
            },
            Cut { plane, at, slab } => {
                let a = plane.cut().xyz();
                let along = |place: f64| {
                    let mut point = [0.0; 3];
                    point[a] = place;
                    self.scene.apply(point)[a]
                };
                Cut {
                    plane,
                    at: along(at),
                    slab: slab.map(|[start, end]| {
                        let (start, end) = (along(start), along(end));
                        [start.min(end), start.max(end)]
                    }),
                }
            }
            OrbitTarget(at) => OrbitTarget(self.world.apply(at)),
            OrbitDistance(d) => OrbitDistance(d * self.world.length_scale()),
            OrbitAngles(_) | Timepoint(_) => value,
        }
    }
}

/// A property's value in a view with `camera` standing at `axes`, or `None`
/// where the camera has no such value. A depth needs the view's grid, see
/// [`Scene::property_value`].
fn link_value(camera: &Camera, axes: &AxisPositions, property: LinkProperty) -> Option<LinkValue> {
    match (property, camera) {
        (LinkProperty::Pan, Camera::Slice(s)) => Some(LinkValue::SliceCenter {
            plane: s.plane,
            at: s.center,
        }),
        (LinkProperty::Zoom, Camera::Slice(s)) => Some(LinkValue::SliceZoom {
            plane: s.plane,
            zoom: s.zoom,
        }),
        (LinkProperty::Pan, Camera::Arcball(a)) => Some(LinkValue::OrbitTarget(a.target)),
        (LinkProperty::Zoom, Camera::Arcball(a)) => Some(LinkValue::OrbitDistance(a.distance)),
        (LinkProperty::Orientation, Camera::Arcball(a)) => {
            Some(LinkValue::OrbitAngles([a.theta, a.phi]))
        }
        (LinkProperty::T, _) => Some(LinkValue::Timepoint(i64::from(axes.t))),
        _ => None,
    }
}

/// Write `value` into `view`. A value its camera has no place for changes
/// nothing.
fn set_link_value(view: &mut View, value: LinkValue) {
    use LinkValue::*;
    match (value, &mut view.camera) {
        (SliceCenter { plane, at }, Camera::Slice(s)) if s.plane == plane => {
            s.set_center(at[0], at[1]);
        }
        (SliceZoom { plane, zoom }, Camera::Slice(s)) if s.plane == plane => s.set_zoom(zoom),
        (OrbitTarget(at), Camera::Arcball(a)) => a.set_target(at),
        (OrbitDistance(d), Camera::Arcball(a)) => a.set_distance(d),
        (OrbitAngles([theta, phi]), Camera::Arcball(a)) => a.set_angles(theta, phi),
        (Cut { plane, at, slab }, Camera::Slice(s)) if s.plane == plane => match plane.cut() {
            SpatialAxis::Z => view.axes.z = slab.map(|[start, end]| start..end),
            SpatialAxis::Y => view.axes.y = Some(at),
            SpatialAxis::X => view.axes.x = Some(at),
        },
        // A timepoint before the first stays at the first; past the last,
        // each layer shows its last, as it does for any timepoint.
        (Timepoint(t), _) => view.axes.t = t.clamp(0, i64::from(u32::MAX)) as u32,
        _ => {}
    }
}

/// What carrying the links moved in the views.
#[derive(Debug, Clone, Copy, Default, PartialEq)]
pub(crate) struct Followed {
    pub camera: bool,
    pub axes: bool,
}

impl Followed {
    fn add(&mut self, other: Followed) {
        self.camera |= other.camera;
        self.axes |= other.axes;
    }
}

impl Scene {
    /// The links between the two views, or `None` with one view.
    pub fn links(&self) -> Option<LinksState> {
        let views = self.linked_views()?;
        let pair = self.links.pair();
        let basis = pair.as_ref().map(|pair| self.link_basis(pair));
        let properties = LinkProperty::ALL
            .into_iter()
            .map(|property| PropertyLink {
                property,
                mode: self.links.modes[property.index()],
                unlinkable: self.unlinkable(property, views),
            })
            .collect();
        Some(LinksState {
            basis,
            alike: pair
                .filter(|_| basis == Some(LinkBasis::Voxel))
                .and_then(|pair| self.alike(&pair)),
            properties,
            notices: views
                .into_iter()
                .map(|view| ViewLinkNotices {
                    view,
                    notices: self.link_notices(view),
                })
                .collect(),
        })
    }

    /// Link `property` in `mode`. A linked property brings the other view to
    /// the active view's value at once, and a relative one keeps the offset
    /// the views have now. A view with nothing to link changes nothing.
    pub(crate) fn set_link(&mut self, property: LinkProperty, mode: LinkMode) {
        let Some(views) = self.linked_views() else {
            return;
        };
        if self.unlinkable(property, views) == Some(Unlinkable::Empty) {
            return;
        }
        self.links.modes[property.index()] = mode;
        self.links.offsets[property.index()] = None;
        self.settle_link(property, self.active);
    }

    /// Take the defaults when the views link by a new pair of datasets: a
    /// pair over one region, or showing the same samples, links everything;
    /// a pair at one scale but apart links zoom and orientation, and keeps
    /// each view's own center and depth by linking pan and depth relative;
    /// any other pair links nothing. Called after every command, since
    /// anything that changes what a view shows can change the pair. Returns
    /// what that moved in the views.
    ///
    /// The view that shows what it showed leads, and then one that showed
    /// something: a view given its first dataset, or another one, takes the
    /// pose the other already shows, as a view switching to the other's mode
    /// does. Between two alike, the active view leads.
    pub(crate) fn refresh_links(&mut self) -> Followed {
        let references = self.link_references();
        if references == self.links.references {
            return Followed::default();
        }
        let standing = [0, 1].map(|i| match &self.links.references[i] {
            Some(before) if references[i].as_ref() == Some(before) => 2,
            Some(_) => 1,
            None => 0,
        });
        self.links = ViewLinks {
            references,
            modes: [LinkMode::Off; 5],
            offsets: [None; 5],
        };
        self.epochs.links += 1;
        let (Some(views), Some(pair)) = (self.linked_views(), self.links.pair()) else {
            return Followed::default();
        };
        self.links.modes = self.default_link_modes(&pair);
        let leader = match standing[0].cmp(&standing[1]) {
            std::cmp::Ordering::Greater => views[0],
            std::cmp::Ordering::Less => views[1],
            std::cmp::Ordering::Equal => self.active,
        };
        let mut followed = Followed::default();
        for property in LinkProperty::ALL {
            followed.add(self.settle_link(property, leader));
        }
        followed
    }

    /// The active view as it stands before `cmd`, for the other view to
    /// follow what the command changes in it, when the views link. A new
    /// canvas, layout or active view is no change the other view follows:
    /// each view keeps its own region of its own rectangle, and a link set
    /// by hand starts from the views as they stand.
    pub(crate) fn link_leader(&self, cmd: &Command) -> Option<(ViewId, Camera, AxisPositions)> {
        self.links.pair()?;
        if matches!(
            cmd,
            Command::Viewport(
                ViewportCommand::SetViewport { .. }
                    | ViewportCommand::SetViewLayout { .. }
                    | ViewportCommand::MaximizeView { .. }
                    | ViewportCommand::SetActiveView { .. }
                    | ViewportCommand::SetViewLink { .. }
            )
        ) {
            return None;
        }
        let view = self.active_view();
        Some((view.id(), view.camera.clone(), view.axes.clone()))
    }

    /// Carry what changed in `leader` since it showed `before` and stood at
    /// `axes_before` to the other view, through each property's link.
    ///
    /// A property the change made linkable, as a switch to the other view's
    /// mode or plane does, goes the other way: the view that switched takes
    /// the pose the other view already shows.
    pub(crate) fn follow_links(
        &mut self,
        leader: ViewId,
        before: &Camera,
        axes_before: &AxisPositions,
    ) -> Followed {
        let (Some(views), Some(_)) = (self.linked_views(), self.links.pair()) else {
            return Followed::default();
        };
        let Some(other) = views.into_iter().find(|id| *id != leader) else {
            return Followed::default();
        };
        let Some(view) = self.view(leader) else {
            return Followed::default();
        };
        let (camera, axes) = (view.camera.clone(), view.axes.clone());
        let mut followed = Followed::default();
        for property in LinkProperty::ALL {
            let was = self.property_value(leader, before, axes_before, property);
            if was == self.property_value(leader, &camera, &axes, property) {
                continue;
            }
            let paired = was.zip(self.view_value(other, property));
            let from = if paired.is_some_and(|(was, other)| was.pairs_with(other)) {
                leader
            } else {
                other
            };
            followed.add(self.carry_link(property, from));
        }
        followed
    }

    /// The two views a link joins, in layout order.
    fn linked_views(&self) -> Option<[ViewId; 2]> {
        match self.views.as_slice() {
            [first, second] => Some([first.id(), second.id()]),
            _ => None,
        }
    }

    /// The dataset `view` links by: the top visible layer it shows that has
    /// an image to place.
    fn link_reference(&self, view: ViewId) -> Option<DatasetId> {
        let shown = self.view(view)?;
        self.dataset_order
            .iter()
            .rev()
            .filter(|id| shown.shows(id))
            .filter(|id| self.dataset_settings.get(*id).is_none_or(|s| s.visible))
            .find(|id| {
                self.derived
                    .get(*id)
                    .is_some_and(|d| d.members.iter().any(|m| !m.levels.is_empty()))
            })
            .cloned()
    }

    /// The dataset each of two views links by, or none with one view.
    fn link_references(&self) -> [Option<DatasetId>; 2] {
        self.linked_views().map_or([None, None], |views| {
            views.map(|view| self.link_reference(view))
        })
    }

    fn link_basis(&self, pair: &[DatasetId; 2]) -> LinkBasis {
        if pair.iter().all(|id| self.has_physical_scale(id)) {
            LinkBasis::Physical
        } else {
            LinkBasis::Voxel
        }
    }

    fn default_link_modes(&self, pair: &[DatasetId; 2]) -> [LinkMode; 5] {
        use LinkMode::*;
        let [first, second] = pair;
        // Pan, zoom, orientation, Z, T, as `LinkProperty::ALL` orders them.
        match self.line_up(first, second) {
            LineUp::Yes | LineUp::Same => [Linked; 5],
            // Where datasets without units sit says nothing physical, but
            // one dataset twice, or two of one extent placed alike, still
            // show the same samples in the same place.
            LineUp::NoPhysicalScale { .. } if self.alike(pair).is_some() => [Linked; 5],
            LineUp::Apart => [Relative, Linked, Linked, Relative, Off],
            LineUp::Missing { .. } | LineUp::NoPhysicalScale { .. } => [Off; 5],
        }
    }

    /// Whether `pair` shows the same samples in the same place: one dataset
    /// twice, or two of one extent placed alike. Every dataset without
    /// units sits at its declared numbers, so the placement alone would
    /// match unrelated ones.
    fn alike(&self, [first, second]: &[DatasetId; 2]) -> Option<Alike> {
        if first == second {
            return Some(Alike::SameDataset);
        }
        let placed = |id| Some((self.placement(id)?, self.placed_extent(id)?));
        (placed(first)? == placed(second)?).then_some(Alike::SamePlacement)
    }

    /// The maps from the first view's numbers into the second's. Both views
    /// look at one scene frame, so in the physical basis they share their
    /// numbers. In the voxel basis a point goes back to the first dataset's
    /// samples, and out from the second's.
    fn link_maps(&self, pair: &[DatasetId; 2]) -> LinkMaps {
        let scene = match (
            self.link_basis(pair),
            self.placement(&pair[0]),
            self.placement(&pair[1]),
        ) {
            (LinkBasis::Voxel, Some(first), Some(second)) => first.inverse().then(&second),
            _ => Affine::IDENTITY,
        };
        let to_world = self.world_space().from_scene();
        LinkMaps {
            scene,
            world: to_world.inverse().then(&scene).then(&to_world),
        }
    }

    fn unlinkable(
        &self,
        property: LinkProperty,
        [first, second]: [ViewId; 2],
    ) -> Option<Unlinkable> {
        if self.links.pair().is_none() {
            return Some(Unlinkable::Empty);
        }
        match (
            self.view_value(first, property),
            self.view_value(second, property),
        ) {
            (Some(a), Some(b)) if a.pairs_with(b) => None,
            _ => Some(Unlinkable::Cameras),
        }
    }

    /// Start `property`'s link from the views as they stand: a relative one
    /// keeps their offset, and a linked one brings the other view to
    /// `leader`.
    fn settle_link(&mut self, property: LinkProperty, leader: ViewId) -> Followed {
        match self.links.modes[property.index()] {
            LinkMode::Off => Followed::default(),
            LinkMode::Relative => {
                self.links.offsets[property.index()] = self.offset_now(property);
                Followed::default()
            }
            LinkMode::Linked => self.carry_link(property, leader),
        }
    }

    /// The offset of the second view's `property` against the first's as
    /// they stand, carried into the second's basis.
    fn offset_now(&self, property: LinkProperty) -> Option<Offset> {
        let [first, second] = self.linked_views()?;
        let maps = self.link_maps(&self.links.pair()?);
        let from = self.view_value(first, property)?;
        let to = self.view_value(second, property)?;
        if !from.pairs_with(to) {
            return None;
        }
        Some(Offset {
            from,
            delta: maps.carry(from).offset_to(to)?,
        })
    }

    /// Bring the other view's `property` to `leader`'s through its link.
    fn carry_link(&mut self, property: LinkProperty, leader: ViewId) -> Followed {
        let mode = self.links.modes[property.index()];
        let (Some(views), Some(pair)) = (self.linked_views(), self.links.pair()) else {
            return Followed::default();
        };
        if mode == LinkMode::Off || self.unlinkable(property, views).is_some() {
            return Followed::default();
        }
        let forward = leader == views[0];
        if !forward && leader != views[1] {
            return Followed::default();
        }
        let follower = views[usize::from(forward)];
        let delta = match mode {
            LinkMode::Relative => {
                // An offset taken from another kind of camera no longer
                // applies: the views keep the offset they have now.
                let kept = self.links.offsets[property.index()].filter(|offset| {
                    self.view_value(views[0], property)
                        .is_some_and(|v| offset.from.pairs_with(v))
                });
                match kept.or_else(|| self.offset_now(property)) {
                    Some(offset) => {
                        self.links.offsets[property.index()] = Some(offset);
                        Some(offset.delta)
                    }
                    None => return Followed::default(),
                }
            }
            _ => None,
        };
        let Some(lead) = self.view_value(leader, property) else {
            return Followed::default();
        };
        let maps = self.link_maps(&pair);
        let target = match (forward, delta) {
            (true, None) => maps.carry(lead),
            (true, Some(delta)) => maps.carry(lead).moved(delta, false),
            (false, None) => maps.inverse().carry(lead),
            (false, Some(delta)) => maps.inverse().carry(lead.moved(delta, true)),
        };
        let target = self.one_position_cut(follower, target);
        let Some(view) = self.view_mut(follower) else {
            return Followed::default();
        };
        let (camera, axes) = (view.camera.clone(), view.axes.clone());
        set_link_value(view, target);
        let followed = Followed {
            camera: view.camera != camera,
            axes: view.axes != axes,
        };
        // A view moved to follow another is placed, as one steered is.
        if followed.camera && view.camera.framing() == Framing::Framed {
            view.camera.set_framing(Framing::Placed);
        }
        followed
    }

    /// Whether `property` links the views as they stand: its mode isn't
    /// off and nothing keeps it from applying.
    pub(super) fn link_applies(&self, property: LinkProperty) -> bool {
        self.links.modes[property.index()] != LinkMode::Off
            && self
                .linked_views()
                .is_some_and(|views| self.unlinkable(property, views).is_none())
    }

    fn view_value(&self, view: ViewId, property: LinkProperty) -> Option<LinkValue> {
        let shown = self.view(view)?;
        self.property_value(view, &shown.camera, &shown.axes, property)
    }

    /// `property`'s value in `view` with `camera` standing at `axes`. A
    /// depth with no place yet stands at the first position of the view's
    /// grid, and one position's cell is a single cut, not a slab.
    fn property_value(
        &self,
        view: ViewId,
        camera: &Camera,
        axes: &AxisPositions,
        property: LinkProperty,
    ) -> Option<LinkValue> {
        let (LinkProperty::Z, Camera::Slice(slice)) = (property, camera) else {
            return link_value(camera, axes, property);
        };
        let axis = slice.plane.cut();
        let (at, slab) = match axis {
            SpatialAxis::Z => {
                let z = self.z_cut(view, axes);
                let step = self.cut_grid(view, axis).step;
                let slab = (z.end - z.start > 1.5 * step).then_some([z.start, z.end]);
                ((z.start + z.end) / 2.0, slab)
            }
            _ => {
                let place = axes.place(axis);
                (
                    place.unwrap_or_else(|| self.cut_grid(view, axis).center(0)),
                    None,
                )
            }
        };
        Some(LinkValue::Cut {
            plane: slice.plane,
            at,
            slab,
        })
    }

    /// A single cut along Z as `view` stands on it: the cell of its own grid
    /// that holds the place, past the grid if the place is. The leader's
    /// cell would cover two planes of a dataset spaced finer than the
    /// leader's, a slab no one asked for.
    fn one_position_cut(&self, view: ViewId, value: LinkValue) -> LinkValue {
        match value {
            LinkValue::Cut {
                plane,
                at,
                slab: None,
            } if plane.cut() == SpatialAxis::Z => {
                let cell = self.cut_grid(view, SpatialAxis::Z).cell_at(at);
                LinkValue::Cut {
                    plane,
                    at,
                    slab: Some([cell.start, cell.end]),
                }
            }
            value => value,
        }
    }
}

#[cfg(test)]
mod tests {
    use lucida_content::PhysicalSpace;

    use std::ops::Range;

    use super::super::test_helpers::make_dataset_opened_with_shape;
    use super::*;
    use crate::command::{Command, DocumentCommand, ViewportCommand};
    use crate::view::{ViewDatasets, ViewLayout};

    /// An image of `shape` `[t, z, y, x]` samples, each `spacing` long, in
    /// micrometers when `physical` and in no unit otherwise, with its origin
    /// at `origin` `[z, y, x]`.
    fn open(
        scene: &mut Scene,
        id: &str,
        shape: [u64; 4],
        spacing: f64,
        physical: bool,
        origin: [f64; 3],
    ) {
        let [t, z, y, x] = shape;
        let mut opened =
            make_dataset_opened_with_shape(id, id, 1, [t, 1, z, y, x], [1, 1, 16, 64, 64], 1);
        for image in opened.manifest.images_mut() {
            image.multiscale.levels[0].scale = [1.0, 1.0, spacing, spacing, spacing];
        }
        let unit = physical.then(|| "micrometer".to_string());
        opened.manifest = opened.manifest.with_space(PhysicalSpace {
            units: [unit.clone(), unit.clone(), unit],
            origin,
        });
        scene.apply(DocumentCommand::DatasetOpened(opened).into());
    }

    fn apply(scene: &mut Scene, cmd: ViewportCommand) {
        scene.apply(Command::Viewport(cmd));
    }

    fn views(scene: &Scene) -> [ViewId; 2] {
        scene.linked_views().expect("two views")
    }

    /// Split the canvas into columns, move `second` into the second view,
    /// and steer the first.
    fn side_by_side(scene: &mut Scene, second: &str) {
        let layout = ViewLayout::Columns;
        apply(scene, ViewportCommand::SetViewLayout { layout });
        let [first, other] = views(scene);
        let dataset_id = DatasetId::from(second);
        apply(
            scene,
            ViewportCommand::MoveDatasetToView {
                view: other,
                dataset_id,
            },
        );
        apply(scene, ViewportCommand::SetActiveView { view: first });
    }

    /// A and B over the same 64 micrometers in two views, B in samples half
    /// as long, each with four timepoints.
    fn one_place() -> Scene {
        let mut scene = Scene::new([800, 600]);
        open(&mut scene, "a", [4, 32, 64, 64], 1.0, true, [0.0; 3]);
        open(&mut scene, "b", [4, 64, 128, 128], 0.5, true, [0.0; 3]);
        side_by_side(&mut scene, "b");
        scene
    }

    fn steer(scene: &mut Scene, view: ViewId, cmd: ViewportCommand) {
        apply(scene, ViewportCommand::SetActiveView { view });
        apply(scene, cmd);
    }

    fn link(scene: &mut Scene, property: LinkProperty, mode: LinkMode) {
        apply(scene, ViewportCommand::SetViewLink { property, mode });
    }

    fn slice(scene: &Scene, view: ViewId) -> ([f64; 2], f64) {
        match &scene.view(view).unwrap().camera {
            Camera::Slice(s) => (s.center, s.zoom),
            other => panic!("a slice camera, not {other:?}"),
        }
    }

    fn orbit(scene: &Scene, view: ViewId) -> ([f64; 3], f64, [f64; 2]) {
        match &scene.view(view).unwrap().camera {
            Camera::Arcball(a) => (a.target, a.distance, [a.theta, a.phi]),
            other => panic!("an orbit camera, not {other:?}"),
        }
    }

    fn t(scene: &Scene, view: ViewId) -> u32 {
        scene.view(view).unwrap().axes.t
    }

    fn modes(scene: &Scene) -> Vec<(LinkProperty, LinkMode, Option<Unlinkable>)> {
        scene
            .links()
            .expect("two views")
            .properties
            .into_iter()
            .map(|p| (p.property, p.mode, p.unlinkable))
            .collect()
    }

    fn close(a: f64, b: f64) -> bool {
        (a - b).abs() <= 1e-9 * a.abs().max(b.abs()).max(1.0)
    }

    #[test]
    fn one_view_has_no_links() {
        let mut scene = Scene::new([800, 600]);
        open(&mut scene, "a", [1, 1, 64, 64], 1.0, true, [0.0; 3]);
        assert_eq!(scene.links(), None);
        let before = scene.epochs.clone();
        link(&mut scene, LinkProperty::Pan, LinkMode::Linked);
        assert_eq!(scene.epochs, before);
    }

    #[test]
    fn datasets_over_one_region_link_everything() {
        use LinkMode::*;
        use LinkProperty::*;
        let scene = one_place();
        assert_eq!(scene.links().unwrap().basis, Some(LinkBasis::Physical));
        assert_eq!(
            modes(&scene),
            vec![
                (Pan, Linked, None),
                (Zoom, Linked, None),
                (Orientation, Linked, Some(Unlinkable::Cameras)),
                (Z, Linked, None),
                (T, Linked, None),
            ]
        );
    }

    #[test]
    fn linked_views_stay_on_one_physical_point_through_pan_zoom_and_scrub() {
        let mut scene = one_place();
        let [first, second] = views(&scene);
        // The defaults brought the second view to the first's region.
        assert_eq!(slice(&scene, second), slice(&scene, first));
        steer(
            &mut scene,
            first,
            ViewportCommand::SetCenter { x: 12.0, y: 40.0 },
        );
        steer(&mut scene, first, ViewportCommand::SetZoom { value: 3.0 });
        assert_eq!(slice(&scene, second), ([12.0, 40.0], 3.0));
        steer(
            &mut scene,
            second,
            ViewportCommand::Pan {
                dx: 30.0,
                dy: -60.0,
            },
        );
        steer(&mut scene, second, ViewportCommand::ZoomBy { factor: 0.5 });
        assert_eq!(slice(&scene, first), slice(&scene, second));
        steer(&mut scene, first, ViewportCommand::SetT { t: 3 });
        assert_eq!(t(&scene, second), 3);
    }

    #[test]
    fn linked_volume_views_orbit_zoom_and_pan_together() {
        let mut scene = one_place();
        let [first, second] = views(&scene);
        steer(&mut scene, first, ViewportCommand::SetMode3D);
        let (d_theta, d_phi) = (0.4, -0.2);
        steer(
            &mut scene,
            first,
            ViewportCommand::Rotate3D { d_theta, d_phi },
        );
        // The view that switches takes the pose the other already shows.
        steer(&mut scene, second, ViewportCommand::SetMode3D);
        assert_eq!(orbit(&scene, second), orbit(&scene, first));
        let (d_theta, d_phi) = (-1.0, 0.3);
        steer(
            &mut scene,
            second,
            ViewportCommand::Rotate3D { d_theta, d_phi },
        );
        steer(&mut scene, second, ViewportCommand::Zoom3D { delta: -0.25 });
        steer(
            &mut scene,
            second,
            ViewportCommand::Pan3D { dx: 40.0, dy: 10.0 },
        );
        let (target, distance, angles) = orbit(&scene, second);
        let (followed, d, a) = orbit(&scene, first);
        assert!(
            target.iter().zip(followed).all(|(x, y)| close(*x, y)),
            "{target:?} against {followed:?}"
        );
        assert!(close(distance, d));
        assert_eq!(angles, a);
    }

    #[test]
    fn the_view_given_a_dataset_takes_the_other_views_region_even_when_active() {
        let mut scene = Scene::new([800, 600]);
        open(&mut scene, "a", [1, 1, 64, 64], 1.0, true, [0.0; 3]);
        open(&mut scene, "b", [1, 1, 128, 128], 0.5, true, [0.0; 3]);
        let layout = ViewLayout::Columns;
        apply(&mut scene, ViewportCommand::SetViewLayout { layout });
        let [first, second] = views(&scene);
        steer(
            &mut scene,
            first,
            ViewportCommand::SetCenter { x: 9.0, y: 30.0 },
        );
        steer(&mut scene, first, ViewportCommand::SetZoom { value: 6.0 });
        apply(&mut scene, ViewportCommand::SetActiveView { view: second });
        let dataset_id = DatasetId::from("b");
        apply(
            &mut scene,
            ViewportCommand::MoveDatasetToView {
                view: second,
                dataset_id,
            },
        );
        assert_eq!(slice(&scene, first), ([9.0, 30.0], 6.0));
        assert_eq!(slice(&scene, second), ([9.0, 30.0], 6.0));
    }

    #[test]
    fn the_other_view_follows_a_fit_to_new_content() {
        let mut scene = Scene::new([800, 600]);
        open(&mut scene, "wide", [1, 1, 64, 256], 1.0, true, [0.0; 3]);
        open(&mut scene, "a", [1, 1, 64, 64], 1.0, true, [0.0; 3]);
        open(&mut scene, "b", [1, 1, 128, 128], 0.5, true, [0.0; 3]);
        side_by_side(&mut scene, "b");
        let [first, second] = views(&scene);
        let framed = scene.view(first).unwrap().camera.framing();
        assert_eq!(framed, Framing::Framed);
        let wide = slice(&scene, first);
        let dataset_id = "wide".to_string();
        let visible = false;
        apply(
            &mut scene,
            ViewportCommand::SetDatasetVisible {
                dataset_id,
                visible,
            },
        );
        assert_ne!(
            slice(&scene, first),
            wide,
            "the first view fits what it shows now"
        );
        assert_eq!(slice(&scene, second), slice(&scene, first));
    }

    #[test]
    fn unrelated_datasets_open_unlinked_and_link_by_hand_in_samples() {
        let mut scene = Scene::new([800, 600]);
        open(&mut scene, "a", [1, 1, 64, 64], 1.0, true, [0.0; 3]);
        // Placed by its declared numbers alone: two units a sample.
        open(&mut scene, "c", [1, 1, 32, 32], 2.0, false, [0.0; 3]);
        side_by_side(&mut scene, "c");
        let [first, second] = views(&scene);
        let links = scene.links().unwrap();
        assert_eq!(links.basis, Some(LinkBasis::Voxel));
        assert!(links.properties.iter().all(|p| p.mode == LinkMode::Off));
        steer(
            &mut scene,
            first,
            ViewportCommand::SetCenter { x: 10.0, y: 20.0 },
        );
        steer(&mut scene, first, ViewportCommand::SetZoom { value: 4.0 });
        link(&mut scene, LinkProperty::Pan, LinkMode::Linked);
        link(&mut scene, LinkProperty::Zoom, LinkMode::Linked);
        // Sample (10, 20) of the first is sample (10, 20) of the second, two
        // units a sample, shown at the same pixels per sample.
        assert_eq!(slice(&scene, second), ([20.0, 40.0], 2.0));
        steer(
            &mut scene,
            second,
            ViewportCommand::SetCenter { x: 8.0, y: 6.0 },
        );
        assert_eq!(slice(&scene, first).0, [4.0, 3.0]);
    }

    #[test]
    fn a_relative_link_keeps_its_offset_through_a_gesture() {
        let mut scene = one_place();
        let [first, second] = views(&scene);
        link(&mut scene, LinkProperty::Pan, LinkMode::Off);
        link(&mut scene, LinkProperty::Zoom, LinkMode::Off);
        steer(
            &mut scene,
            first,
            ViewportCommand::SetCenter { x: 10.0, y: 10.0 },
        );
        steer(&mut scene, first, ViewportCommand::SetZoom { value: 2.0 });
        steer(
            &mut scene,
            second,
            ViewportCommand::SetCenter { x: 30.0, y: 5.0 },
        );
        steer(&mut scene, second, ViewportCommand::SetZoom { value: 4.0 });
        link(&mut scene, LinkProperty::Pan, LinkMode::Relative);
        link(&mut scene, LinkProperty::Zoom, LinkMode::Relative);
        // Setting a relative link moves nothing.
        assert_eq!(slice(&scene, second), ([30.0, 5.0], 4.0));
        steer(
            &mut scene,
            first,
            ViewportCommand::SetCenter { x: 15.0, y: 7.0 },
        );
        steer(&mut scene, first, ViewportCommand::ZoomBy { factor: 1.5 });
        assert_eq!(slice(&scene, second), ([35.0, 2.0], 6.0));
        steer(
            &mut scene,
            second,
            ViewportCommand::SetCenter { x: 20.0, y: 20.0 },
        );
        steer(&mut scene, second, ViewportCommand::SetZoom { value: 1.0 });
        assert_eq!(slice(&scene, first), ([0.0, 25.0], 0.5));
    }

    #[test]
    fn a_relative_timepoint_keeps_its_offset_and_stops_at_the_first() {
        let mut scene = one_place();
        let [first, second] = views(&scene);
        link(&mut scene, LinkProperty::T, LinkMode::Off);
        steer(&mut scene, second, ViewportCommand::SetT { t: 2 });
        link(&mut scene, LinkProperty::T, LinkMode::Relative);
        steer(&mut scene, first, ViewportCommand::SetT { t: 1 });
        assert_eq!(t(&scene, second), 3);
        steer(&mut scene, second, ViewportCommand::SetT { t: 1 });
        assert_eq!(t(&scene, first), 0);
    }

    #[test]
    fn datasets_at_one_scale_but_apart_link_zoom_and_keep_their_own_centers() {
        use LinkMode::*;
        let mut scene = Scene::new([800, 600]);
        open(&mut scene, "a", [4, 1, 64, 64], 1.0, true, [0.0; 3]);
        open(
            &mut scene,
            "far",
            [4, 1, 64, 64],
            1.0,
            true,
            [0.0, 0.0, 500.0],
        );
        side_by_side(&mut scene, "far");
        let [first, second] = views(&scene);
        let shown: Vec<LinkMode> = modes(&scene).into_iter().map(|(_, m, _)| m).collect();
        assert_eq!(shown, vec![Relative, Linked, Linked, Relative, Off]);
        let (center, _) = slice(&scene, second);
        assert!(
            center[0] > 500.0,
            "the second view keeps its own center, {center:?}"
        );
        let (start, _) = slice(&scene, first);
        steer(
            &mut scene,
            first,
            ViewportCommand::SetCenter {
                x: start[0] + 7.0,
                y: start[1],
            },
        );
        steer(&mut scene, first, ViewportCommand::SetZoom { value: 5.0 });
        let (moved, zoom) = slice(&scene, second);
        assert_eq!(zoom, 5.0);
        assert!(
            close(moved[0], center[0] + 7.0),
            "{moved:?} from {center:?}"
        );
    }

    #[test]
    fn pan_and_zoom_link_only_between_like_cameras_and_t_links_across() {
        let mut scene = one_place();
        let [first, second] = views(&scene);
        steer(&mut scene, second, ViewportCommand::SetMode3D);
        let unlinkable: Vec<Option<Unlinkable>> =
            modes(&scene).into_iter().map(|(_, _, u)| u).collect();
        assert_eq!(
            unlinkable,
            vec![
                Some(Unlinkable::Cameras),
                Some(Unlinkable::Cameras),
                Some(Unlinkable::Cameras),
                Some(Unlinkable::Cameras),
                None
            ]
        );
        let orbit_before = orbit(&scene, second);
        steer(
            &mut scene,
            first,
            ViewportCommand::SetCenter { x: 3.0, y: 4.0 },
        );
        steer(&mut scene, first, ViewportCommand::SetT { t: 2 });
        assert_eq!(orbit(&scene, second), orbit_before);
        assert_eq!(t(&scene, second), 2);
        // Back in 2D, the second view takes the first view's region.
        steer(&mut scene, second, ViewportCommand::SetMode2D);
        assert_eq!(slice(&scene, second), slice(&scene, first));
        // Another plane is another camera.
        let plane = SlicePlane::Xz;
        steer(&mut scene, second, ViewportCommand::SetSlicePlane { plane });
        assert_eq!(modes(&scene)[0].2, Some(Unlinkable::Cameras));
    }

    /// The position `view` stands at along `axis`, and the planes its one
    /// layer reads there.
    fn depth(scene: &Scene, view: ViewId, axis: SpatialAxis) -> (u32, Range<u32>) {
        let layer = scene.resolved_layers(view).remove(0);
        let planes = match axis {
            SpatialAxis::Z => layer.z_range,
            SpatialAxis::Y => layer.y..layer.y + 1,
            SpatialAxis::X => layer.x..layer.x + 1,
        };
        (scene.axis_index(view, axis), planes)
    }

    #[test]
    fn linked_depth_cuts_one_physical_place_in_both_views() {
        let mut scene = one_place();
        let [first, second] = views(&scene);
        // A's plane 10 is 10 to 11 micrometers; B's samples are half as
        // long, and its plane holding 10.5 is 21, one plane, not a slab.
        steer(&mut scene, first, ViewportCommand::SetZ { z: 10 });
        assert_eq!(depth(&scene, second, SpatialAxis::Z), (21, 21..22));
        steer(&mut scene, second, ViewportCommand::SetZ { z: 7 });
        assert_eq!(depth(&scene, first, SpatialAxis::Z), (3, 3..4));
        // A slab carries its physical range.
        let (start, end) = (4, 6);
        steer(&mut scene, first, ViewportCommand::SetZRange { start, end });
        assert_eq!(depth(&scene, second, SpatialAxis::Z).1, 8..12);
    }

    #[test]
    fn linked_side_views_cut_one_physical_place() {
        let mut scene = one_place();
        let [first, second] = views(&scene);
        let plane = SlicePlane::Xz;
        steer(&mut scene, first, ViewportCommand::SetSlicePlane { plane });
        steer(&mut scene, second, ViewportCommand::SetSlicePlane { plane });
        steer(&mut scene, first, ViewportCommand::SetY { y: 20 });
        assert_eq!(depth(&scene, second, SpatialAxis::Y), (41, 41..42));
        // Two planes are two cameras.
        let plane = SlicePlane::Yz;
        steer(&mut scene, second, ViewportCommand::SetSlicePlane { plane });
        assert_eq!(modes(&scene)[3].2, Some(Unlinkable::Cameras));
    }

    #[test]
    fn a_relative_depth_keeps_its_offset() {
        let mut scene = one_place();
        let [first, second] = views(&scene);
        link(&mut scene, LinkProperty::Z, LinkMode::Off);
        steer(&mut scene, first, ViewportCommand::SetZ { z: 2 });
        steer(&mut scene, second, ViewportCommand::SetZ { z: 20 });
        link(&mut scene, LinkProperty::Z, LinkMode::Relative);
        // Eight micrometers apart, and still so after a step of five.
        steer(&mut scene, first, ViewportCommand::SetZ { z: 7 });
        assert_eq!(depth(&scene, second, SpatialAxis::Z).0, 30);
    }

    #[test]
    fn unrelated_datasets_link_depth_by_hand_in_samples() {
        let mut scene = Scene::new([800, 600]);
        open(&mut scene, "a", [1, 32, 64, 64], 1.0, true, [0.0; 3]);
        open(&mut scene, "c", [1, 16, 32, 32], 2.0, false, [0.0; 3]);
        side_by_side(&mut scene, "c");
        let [first, second] = views(&scene);
        assert_eq!(modes(&scene)[3].1, LinkMode::Off);
        link(&mut scene, LinkProperty::Z, LinkMode::Linked);
        // Sample 10 of the first meets sample 10 of the second.
        steer(&mut scene, first, ViewportCommand::SetZ { z: 10 });
        assert_eq!(depth(&scene, second, SpatialAxis::Z), (10, 10..11));
    }

    #[test]
    fn one_dataset_without_units_links_by_default_in_samples() {
        use LinkMode::*;
        let mut scene = Scene::new([800, 600]);
        open(&mut scene, "u", [2, 8, 32, 32], 2.0, false, [0.0; 3]);
        let layout = ViewLayout::Columns;
        apply(&mut scene, ViewportCommand::SetViewLayout { layout });
        let [_, second] = views(&scene);
        let datasets = ViewDatasets::All;
        apply(
            &mut scene,
            ViewportCommand::SetViewDatasets {
                view: second,
                datasets,
            },
        );
        let links = scene.links().unwrap();
        assert_eq!(links.basis, Some(LinkBasis::Voxel));
        assert_eq!(links.alike, Some(Alike::SameDataset));
        let shown: Vec<LinkMode> = modes(&scene).into_iter().map(|(_, m, _)| m).collect();
        assert_eq!(shown, vec![Linked; 5]);
    }

    #[test]
    fn datasets_without_units_link_only_when_placed_alike() {
        let mut scene = Scene::new([800, 600]);
        open(&mut scene, "u", [1, 8, 32, 32], 2.0, false, [0.0; 3]);
        open(&mut scene, "v", [1, 8, 32, 32], 2.0, false, [0.0; 3]);
        side_by_side(&mut scene, "v");
        let links = scene.links().unwrap();
        assert_eq!(links.alike, Some(Alike::SamePlacement));
        assert_eq!(modes(&scene)[3].1, LinkMode::Linked);
        let mut scene = Scene::new([800, 600]);
        open(&mut scene, "u", [1, 8, 32, 32], 2.0, false, [0.0; 3]);
        open(&mut scene, "w", [1, 8, 16, 16], 2.0, false, [0.0; 3]);
        side_by_side(&mut scene, "w");
        let links = scene.links().unwrap();
        assert_eq!(links.alike, None);
        assert!(links.properties.iter().all(|p| p.mode == LinkMode::Off));
    }

    #[test]
    fn a_new_pair_takes_the_defaults_and_a_hand_choice_stands_until_then() {
        let mut scene = one_place();
        let [first, second] = views(&scene);
        link(&mut scene, LinkProperty::Zoom, LinkMode::Off);
        steer(
            &mut scene,
            first,
            ViewportCommand::SetCenter { x: 1.0, y: 2.0 },
        );
        assert_eq!(modes(&scene)[1].1, LinkMode::Off);
        open(&mut scene, "c", [1, 1, 32, 32], 2.0, false, [0.0; 3]);
        let dataset_id = DatasetId::from("c");
        apply(
            &mut scene,
            ViewportCommand::MoveDatasetToView {
                view: second,
                dataset_id,
            },
        );
        // The second view links by its new top layer, which has no units.
        assert!(modes(&scene).iter().all(|(_, m, _)| *m == LinkMode::Off));
        let layout = ViewLayout::Single;
        apply(&mut scene, ViewportCommand::SetViewLayout { layout });
        assert_eq!(scene.links(), None);
    }

    #[test]
    fn a_link_moves_its_epoch_and_a_followed_view_moves_the_view_epoch() {
        let mut scene = one_place();
        let [first, _] = views(&scene);
        let before = scene.epochs.clone();
        link(&mut scene, LinkProperty::Pan, LinkMode::Relative);
        assert_eq!(scene.epochs.links, before.links + 1);
        assert_eq!(scene.epochs.view, before.view);
        let before = scene.epochs.clone();
        link(&mut scene, LinkProperty::Pan, LinkMode::Relative);
        assert_eq!(scene.epochs, before, "the same mode again changes nothing");
        steer(&mut scene, first, ViewportCommand::Pan { dx: 5.0, dy: 0.0 });
        assert_eq!(scene.epochs.view, before.view + 1);
        let before = scene.epochs.clone();
        steer(&mut scene, first, ViewportCommand::SetT { t: 1 });
        assert_eq!(scene.epochs.selection, before.selection + 1);
    }
}
