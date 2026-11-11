//! What each layer shows at the scene's selectors: which channels, through
//! which colormap and window, at which z and t, whether a slice view's cut
//! passes through it, and whether the view's comparison sets it aside.
//! Decided here once, so the renderer, the planner, the minimap, explore
//! thumbnails, the pin-context check, the layer panel and the CLI cannot
//! disagree about it.

use std::ops::Range;

use lucida_content::{DatasetId, DatasetManifest};
use serde::{Deserialize, Serialize};

use super::{BlendMode, Colormap, DatasetDisplaySettings, RenderMode, Scene};
use crate::camera::Camera;
use crate::placement::Affine;
use crate::saved_view::SavedView;
use crate::slice_plane::SlicePlane;
use crate::view::{AxisPositions, LegacyChannels, ViewId};
use lucida_content::SpatialAxis;

/// One channel a layer shows.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ShownChannel {
    pub channel: u32,
    pub colormap: Colormap,
    pub contrast_min: f64,
    pub contrast_max: f64,
    pub gamma: f64,
    /// How this channel combines with what is drawn beneath it. A layer
    /// showing one channel uses its layer blend, and a layer showing several
    /// uses its channel blend for each.
    pub blend_mode: BlendMode,
}

/// How a slice view's cut along one axis meets a layer.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CutReach {
    /// The cut passes through the layer, which draws the plane it cuts.
    Through,
    /// The cut passes outside the layer, which draws nothing there: its
    /// nearest plane would show data from where the cut is not.
    Outside,
    /// The layer is one plane deep in Z under a cut along Z that steps
    /// through deeper layers, and draws that plane at every position, so a
    /// flat image can sit over a volume.
    Every,
}

/// What one layer shows in one view.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ResolvedLayer {
    pub dataset_id: DatasetId,
    /// Whether the view draws the layer: its own visibility, unless the
    /// view's comparison sets it aside. A hidden layer still lists the
    /// channels it would show.
    pub visible: bool,
    /// Visible by its own setting, but outside the pair the view compares,
    /// so it draws nothing until the comparison ends. The setting is left
    /// as it was.
    pub set_aside: bool,
    pub opacity: f32,
    pub render_mode: RenderMode,
    pub channel_count: u32,
    pub solo: Option<u32>,
    /// Ascending by channel, never empty.
    pub channels: Vec<ShownChannel>,
    /// The planes of this layer the view's places along Z read, clamped
    /// into its depth.
    pub z_range: Range<u32>,
    /// The view's timepoint, clamped into this layer's timepoints.
    pub t: u32,
    /// The plane of this layer an XZ view cuts along Y, and the one a YZ
    /// view cuts along X: the view's place read in the layer's own samples,
    /// in a collection from each tile's own edge.
    pub y: u32,
    pub x: u32,
    /// Whether the view's places along Z reach past this layer's planes.
    pub z_clamped: bool,
    /// Whether the view's timepoint is past this layer's last.
    pub t_clamped: bool,
    /// How the cut along Z, along Y and along X meets this layer. Where a
    /// cut misses, the planes above are the nearest, and none is drawn. A
    /// slice view reads the one its plane cuts, see [`Self::reach`].
    pub z_reach: CutReach,
    pub y_reach: CutReach,
    pub x_reach: CutReach,
}

impl ResolvedLayer {
    /// The channel indices shown, ascending.
    pub fn channel_indices(&self) -> Vec<u32> {
        self.channels.iter().map(|c| c.channel).collect()
    }

    /// The planes a slice view of `plane` cuts in this layer.
    pub fn cut(&self, plane: SlicePlane) -> Range<u32> {
        match plane.cut() {
            SpatialAxis::Z => self.z_range.clone(),
            SpatialAxis::Y => self.y..self.y + 1,
            SpatialAxis::X => self.x..self.x + 1,
        }
    }

    /// How a slice view of `plane` cuts this layer.
    pub fn reach(&self, plane: SlicePlane) -> CutReach {
        match plane.cut() {
            SpatialAxis::Z => self.z_reach,
            SpatialAxis::Y => self.y_reach,
            SpatialAxis::X => self.x_reach,
        }
    }
}

/// Whether a pin placed while `placement` showed belongs to a view showing
/// `shown`: some channel shows now that showed then. A pin placed in the
/// composite stays in context when any of its channels is soloed.
pub fn in_channel_context(placement: &[u32], shown: &[u32]) -> bool {
    shown.iter().any(|c| placement.contains(c))
}

/// A layer's timepoint, channel and spatial counts, from its first image.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct LayerExtent {
    pub t: u32,
    pub c: u32,
    pub z: u32,
    pub y: u32,
    pub x: u32,
}

impl LayerExtent {
    pub(crate) fn of(manifest: &DatasetManifest) -> Self {
        let shape = manifest
            .images()
            .first()
            .and_then(|img| img.multiscale.levels.first())
            .map(|level| level.shape);
        let axis = |i: usize| shape.map_or(1, |s| (s[i] as u32).max(1));
        Self {
            t: axis(0),
            c: axis(1),
            z: axis(2),
            y: axis(3),
            x: axis(4),
        }
    }

    /// The count along a spatial axis.
    pub(crate) fn along(&self, axis: SpatialAxis) -> u32 {
        match axis {
            SpatialAxis::X => self.x,
            SpatialAxis::Y => self.y,
            SpatialAxis::Z => self.z,
        }
    }

    fn clamp_t(&self, t: u32) -> u32 {
        t.min(self.t - 1)
    }

    /// `plane` clamped into this layer along `axis`.
    fn clamp(&self, axis: SpatialAxis, plane: i64) -> u32 {
        plane.clamp(0, i64::from(self.along(axis)) - 1) as u32
    }

    /// The planes of this layer a cut along Z across the places `z` reads,
    /// through `to_scene`: those whose middles lie in the range, or with
    /// none, the plane holding its middle, so a layer coarser than one
    /// position still shows a plane. Unclamped, so a range past the layer
    /// names planes it lacks.
    fn z_planes(&self, z: &Range<f64>, to_scene: &Affine) -> Range<i64> {
        let at = |place: f64| to_scene.inverse().apply([0.0, 0.0, place])[2];
        let (start, end) = (at(z.start), at(z.end));
        let (start, end) = (start.min(end), start.max(end));
        let first = (start - 0.5).ceil();
        let past = (end - 0.5).ceil();
        if past > first {
            first as i64..past as i64
        } else {
            let middle = at((z.start + z.end) / 2.0).floor() as i64;
            middle..middle + 1
        }
    }

    /// The plane of this layer a place along `axis` reads through
    /// `to_scene`. Unclamped, so a place past the layer names a plane it
    /// lacks.
    fn plane_at(&self, place: f64, axis: SpatialAxis, to_scene: &Affine) -> i64 {
        let a = axis.xyz();
        let mut at = [0.0; 3];
        at[a] = place;
        to_scene.inverse().apply(at)[a].floor() as i64
    }

    /// How a cut naming `planes` along `axis` meets this layer.
    fn reach(&self, axis: SpatialAxis, planes: &Range<i64>) -> CutReach {
        let count = i64::from(self.along(axis));
        if planes.start < count && planes.end > 0 {
            CutReach::Through
        } else {
            CutReach::Outside
        }
    }

    /// How a cut along Z naming `planes` meets this layer, in a view whose
    /// Z grid has `depth` positions.
    fn reach_z(&self, planes: &Range<i64>, depth: u32) -> CutReach {
        if self.z == 1 {
            // Alone, a flat layer has no Z to step through, so it says nothing.
            return if depth > 1 {
                CutReach::Every
            } else {
                CutReach::Through
            };
        }
        self.reach(SpatialAxis::Z, planes)
    }
}

/// Where a view cuts each axis, as places in the scene frame, worked out
/// once from its positions and its grids.
#[derive(Debug, Clone, PartialEq)]
pub(crate) struct ViewCuts {
    pub z: Range<f64>,
    pub y: f64,
    pub x: f64,
    /// How many positions the view's Z grid has, so a layer one plane deep
    /// knows whether it stands in at every Z.
    pub depth: u32,
}

/// What one layer shows with `settings` where `cuts` cut it and at
/// timepoint `t`, set aside or not by the view's comparison. `to_scene` is
/// the layer's placement, which each place reads its planes back through.
fn resolve(
    dataset_id: &DatasetId,
    manifest: &DatasetManifest,
    settings: &DatasetDisplaySettings,
    (cuts, t): (&ViewCuts, u32),
    to_scene: &Affine,
    outside_comparison: bool,
) -> ResolvedLayer {
    let extent = LayerExtent::of(manifest);
    let shown = settings.shown_channels(extent.c);
    let blend_mode = if shown.len() == 1 {
        settings.blend_mode
    } else {
        settings.channel_blend_mode
    };
    let channels = shown
        .into_iter()
        .map(|channel| {
            let entry = settings.channel_settings.get(channel as usize);
            ShownChannel {
                channel,
                // An entry-less channel has never been styled, so it draws
                // through the layer's window in gray.
                colormap: entry.map_or(Colormap::Gray, |e| e.colormap),
                contrast_min: entry.map_or(settings.contrast_min, |e| e.contrast_min),
                contrast_max: entry.map_or(settings.contrast_max, |e| e.contrast_max),
                gamma: entry.map_or(settings.gamma, |e| e.gamma),
                blend_mode,
            }
        })
        .collect();
    let z_planes = extent.z_planes(&cuts.z, to_scene);
    let z_range = extent.clamp(SpatialAxis::Z, z_planes.start)
        ..extent.clamp(SpatialAxis::Z, z_planes.end - 1) + 1;
    let [y, x] = [(cuts.y, SpatialAxis::Y), (cuts.x, SpatialAxis::X)]
        .map(|(place, axis)| extent.plane_at(place, axis, to_scene));
    let set_aside = settings.visible && outside_comparison;
    ResolvedLayer {
        dataset_id: dataset_id.clone(),
        visible: settings.visible && !set_aside,
        set_aside,
        opacity: settings.opacity,
        render_mode: settings.render_mode,
        channel_count: extent.c,
        solo: settings.solo.filter(|&solo| solo < extent.c),
        channels,
        z_clamped: (i64::from(z_range.start)..i64::from(z_range.end)) != z_planes,
        z_range,
        t_clamped: extent.clamp_t(t) != t,
        t: extent.clamp_t(t),
        y: extent.clamp(SpatialAxis::Y, y),
        x: extent.clamp(SpatialAxis::X, x),
        z_reach: extent.reach_z(&z_planes, cuts.depth),
        y_reach: extent.reach(SpatialAxis::Y, &(y..y + 1)),
        x_reach: extent.reach(SpatialAxis::X, &(x..x + 1)),
    }
}

impl Scene {
    /// Every layer `view` draws, as it shows it, in panel order, then any
    /// dataset the order does not list. Empty for an unknown view.
    pub fn resolved_layers(&self, view: ViewId) -> Vec<ResolvedLayer> {
        let Some(shown) = self.view(view) else {
            return Vec::new();
        };
        // Where the view cuts is one answer for every layer.
        let cuts = self.view_cuts(view, &shown.axes);
        self.layer_ids()
            .filter(|id| self.draws(view, id))
            .filter_map(|id| self.resolve_at(view, id, &cuts))
            .collect()
    }

    /// What `dataset_id` shows in `view`, or `None` for a dataset the
    /// document lacks or an unknown view.
    pub fn resolved_layer(&self, view: ViewId, dataset_id: &DatasetId) -> Option<ResolvedLayer> {
        let cuts = self.view_cuts(view, &self.view(view)?.axes);
        self.resolve_at(view, dataset_id, &cuts)
    }

    /// [`Self::resolved_layer`] where `view` cuts at `cuts`.
    fn resolve_at(
        &self,
        view: ViewId,
        dataset_id: &DatasetId,
        cuts: &ViewCuts,
    ) -> Option<ResolvedLayer> {
        let shown = self.view(view)?;
        let manifest = self.document.manifests.get(dataset_id)?;
        let seeded;
        let settings = match self.dataset_settings.get(dataset_id) {
            Some(settings) => settings,
            None => {
                seeded = DatasetDisplaySettings::seeded_for(manifest);
                &seeded
            }
        };
        Some(resolve(
            dataset_id,
            manifest,
            settings,
            (cuts, shown.axes.t),
            &self.placement(dataset_id).unwrap_or(Affine::IDENTITY),
            shown.sets_aside(dataset_id),
        ))
    }

    /// How `view`'s slice cut meets `dataset_id`, or `None` for a volume
    /// view, which cuts nothing, a dataset the document lacks or an unknown
    /// view.
    pub fn layer_reach(&self, view: ViewId, dataset_id: &DatasetId) -> Option<CutReach> {
        let Camera::Slice(slice) = &self.view(view)?.camera else {
            return None;
        };
        Some(self.resolved_layer(view, dataset_id)?.reach(slice.plane))
    }

    /// Where `view` standing at `axes` cuts each axis: its places, or the
    /// first position of each grid it has none on.
    pub(crate) fn view_cuts(&self, view: ViewId, axes: &AxisPositions) -> ViewCuts {
        let grid = |axis| self.cut_grid(view, axis);
        ViewCuts {
            z: self.z_cut(view, axes),
            y: axes.y.unwrap_or_else(|| grid(SpatialAxis::Y).center(0)),
            x: axes.x.unwrap_or_else(|| grid(SpatialAxis::X).center(0)),
            depth: grid(SpatialAxis::Z).count,
        }
    }

    /// What this scene's layers would show under `view`, as restoring it into
    /// the active view leaves them: a layer the view styles takes the view's
    /// settings, except that channels the view lists no entry for keep this
    /// scene's styling.
    pub fn resolved_view_layers(&self, view: &SavedView) -> Vec<ResolvedLayer> {
        let mut axes = view.view_in(self);
        self.place_legacy_axes(&mut axes);
        let cuts = self.view_cuts(self.active_view().id(), &axes);
        self.layer_ids()
            .filter_map(|id| {
                let manifest = self.document.manifests.get(id)?;
                let mut settings = self
                    .dataset_settings
                    .get(id)
                    .cloned()
                    .unwrap_or_else(|| DatasetDisplaySettings::seeded_for(manifest));
                if let Some(styled) = view.dataset_settings.get(id) {
                    let mut channels = settings.channel_settings;
                    for (i, entry) in styled.channel_settings.iter().enumerate() {
                        match channels.get_mut(i) {
                            Some(slot) => *slot = entry.clone(),
                            None => channels.push(entry.clone()),
                        }
                    }
                    settings = DatasetDisplaySettings {
                        channel_settings: channels,
                        ..styled.clone()
                    };
                }
                // A saved view records no comparison, so it sets nothing aside.
                Some(resolve(
                    id,
                    manifest,
                    &settings,
                    (&cuts, axes.t),
                    &self.placement(id).unwrap_or(Affine::IDENTITY),
                    false,
                ))
            })
            .collect()
    }

    pub(super) fn layer_ids(&self) -> impl Iterator<Item = &DatasetId> {
        let unlisted = self
            .document
            .manifests
            .keys()
            .filter(|id| !self.dataset_order.contains(id));
        self.dataset_order.iter().chain(unlisted)
    }

    /// The planes of `dataset_id` a slice view of `plane` cuts where `view`
    /// stands, clamped into it. A dataset the document lacks has none to
    /// read and reads its first.
    pub(crate) fn layer_cut(
        &self,
        view: ViewId,
        dataset_id: &DatasetId,
        plane: SlicePlane,
    ) -> Range<u32> {
        let (Some(shown), Some(manifest), Some(to_scene)) = (
            self.view(view),
            self.document.manifests.get(dataset_id),
            self.placement(dataset_id),
        ) else {
            return 0..1;
        };
        let extent = LayerExtent::of(manifest);
        let cuts = self.view_cuts(view, &shown.axes);
        let single = |axis| {
            let place = if axis == SpatialAxis::Y {
                cuts.y
            } else {
                cuts.x
            };
            let plane = extent.clamp(axis, extent.plane_at(place, axis, &to_scene));
            plane..plane + 1
        };
        match plane.cut() {
            SpatialAxis::Z => {
                let planes = extent.z_planes(&cuts.z, &to_scene);
                extent.clamp(SpatialAxis::Z, planes.start)
                    ..extent.clamp(SpatialAxis::Z, planes.end - 1) + 1
            }
            axis => single(axis),
        }
    }

    /// Set every layer's solo from the scene-wide mode of a view recorded
    /// before solo was per layer. Returns whether any solo changed.
    pub(crate) fn adopt_legacy_channels(&mut self, legacy: LegacyChannels) -> bool {
        let mut changed = false;
        for (id, settings) in self.dataset_settings.iter_mut() {
            let channel_count = match self.document.manifests.get(id) {
                Some(manifest) => LayerExtent::of(manifest).c,
                None => settings.channel_settings.len() as u32,
            };
            let before = settings.solo;
            settings.adopt_legacy_channels(legacy, channel_count);
            changed |= settings.solo != before;
        }
        changed
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::command::ViewportCommand;
    use crate::scene::test_helpers::{make_dataset_opened, make_dataset_opened_with_shape};

    fn scene_with(datasets: &[(&str, u64)]) -> Scene {
        let mut scene = Scene::new([800, 600]);
        for (id, channels) in datasets {
            scene.apply(
                crate::command::DocumentCommand::DatasetOpened(make_dataset_opened(
                    id, id, *channels,
                ))
                .into(),
            );
        }
        scene
    }

    fn solo(scene: &mut Scene, id: &str, channel: Option<u32>) {
        scene.apply(
            ViewportCommand::SetChannelSolo {
                dataset_id: id.to_string(),
                channel,
            }
            .into(),
        );
    }

    fn shown(scene: &Scene, id: &str) -> Vec<u32> {
        scene
            .resolved_layer(scene.active_view().id(), &DatasetId(id.to_string()))
            .unwrap()
            .channel_indices()
    }

    #[test]
    fn a_multichannel_layer_opens_as_its_composite() {
        let scene = scene_with(&[("a", 3)]);
        let layer = scene
            .resolved_layer(scene.active_view().id(), &DatasetId("a".into()))
            .unwrap();
        assert_eq!(layer.channel_indices(), vec![0, 1, 2]);
        assert_eq!(layer.solo, None);
        let colormaps: Vec<Colormap> = layer.channels.iter().map(|c| c.colormap).collect();
        assert_eq!(
            colormaps,
            vec![Colormap::Magenta, Colormap::Green, Colormap::Cyan]
        );
        assert!(
            layer
                .channels
                .iter()
                .all(|c| c.blend_mode == BlendMode::Additive)
        );
    }

    #[test]
    fn a_one_channel_layer_opens_gray() {
        let mut scene = scene_with(&[("a", 1)]);
        let layer = scene
            .resolved_layer(scene.active_view().id(), &DatasetId("a".into()))
            .unwrap();
        assert_eq!(layer.channels[0].colormap, Colormap::Gray);

        // A channel entry made by a command, not by the open, is gray too.
        scene
            .dataset_settings
            .get_mut(&DatasetId("a".into()))
            .unwrap()
            .channel_settings
            .clear();
        scene.apply(
            ViewportCommand::SetChannelGamma {
                dataset_id: "a".into(),
                channel: 0,
                gamma: 0.5,
            }
            .into(),
        );
        let layer = scene
            .resolved_layer(scene.active_view().id(), &DatasetId("a".into()))
            .unwrap();
        assert_eq!(layer.channels[0].colormap, Colormap::Gray);
    }

    #[test]
    fn solo_on_one_layer_leaves_the_others_as_they_were() {
        let mut scene = scene_with(&[("a", 3), ("b", 2), ("c", 1)]);
        solo(&mut scene, "a", Some(2));
        assert_eq!(shown(&scene, "a"), vec![2]);
        assert_eq!(shown(&scene, "b"), vec![0, 1]);
        // A layer with fewer channels than the solo stays visible.
        assert_eq!(shown(&scene, "c"), vec![0]);
        assert!(
            scene
                .resolved_layers(scene.active_view().id())
                .iter()
                .all(|l| l.visible)
        );

        solo(&mut scene, "a", None);
        assert_eq!(shown(&scene, "a"), vec![0, 1, 2]);
    }

    #[test]
    fn solo_keeps_the_visibility_flags_it_returns_to() {
        let mut scene = scene_with(&[("a", 3)]);
        scene.apply(
            ViewportCommand::SetChannelVisible {
                dataset_id: "a".into(),
                channel: 1,
                visible: false,
            }
            .into(),
        );
        solo(&mut scene, "a", Some(1));
        assert_eq!(shown(&scene, "a"), vec![1]);
        solo(&mut scene, "a", None);
        assert_eq!(shown(&scene, "a"), vec![0, 2]);
    }

    #[test]
    fn a_solo_past_the_layer_is_refused() {
        let mut scene = scene_with(&[("a", 2)]);
        solo(&mut scene, "a", Some(5));
        assert_eq!(scene.dataset_settings[&DatasetId("a".into())].solo, None);
        assert_eq!(shown(&scene, "a"), vec![0, 1]);
    }

    #[test]
    fn a_soloed_layer_draws_through_its_layer_blend() {
        let mut scene = scene_with(&[("a", 3)]);
        solo(&mut scene, "a", Some(0));
        let layer = scene
            .resolved_layer(scene.active_view().id(), &DatasetId("a".into()))
            .unwrap();
        assert_eq!(layer.channels[0].blend_mode, BlendMode::Alpha);
    }

    fn open_shaped(scene: &mut Scene, id: &str, shape: [u64; 5]) {
        scene.apply(
            crate::command::DocumentCommand::DatasetOpened(make_dataset_opened_with_shape(
                id,
                id,
                1,
                shape,
                [1, 1, 8, 64, 64],
                1,
            ))
            .into(),
        );
    }

    fn layer(scene: &Scene, id: &str) -> ResolvedLayer {
        scene
            .resolved_layer(scene.active_view().id(), &DatasetId(id.to_string()))
            .unwrap()
    }

    fn wanted(scene: &Scene, id: &str) -> Vec<crate::chunk::ChunkCoord> {
        let plans = scene
            .chunk_plan_for(scene.active_view().id(), &DatasetId(id.to_string()))
            .unwrap();
        plans.into_iter().flat_map(|p| p.needed).collect()
    }

    #[test]
    fn a_z_past_a_layer_misses_it_and_a_flat_layer_shows_at_every_z() {
        let mut scene = Scene::new([800, 600]);
        open_shaped(&mut scene, "deep", [4, 1, 40, 64, 64]);
        open_shaped(&mut scene, "shallow", [1, 1, 12, 64, 64]);
        open_shaped(&mut scene, "flat", [1, 1, 1, 64, 64]);

        scene.apply(ViewportCommand::SetZ { z: 5 }.into());
        let reach = |scene: &Scene, id| layer(scene, id).reach(SlicePlane::Xy);
        assert_eq!(reach(&scene, "deep"), CutReach::Through);
        assert_eq!(reach(&scene, "shallow"), CutReach::Through);
        // A flat layer over deeper ones says so wherever Z stands.
        assert_eq!(reach(&scene, "flat"), CutReach::Every);

        scene.apply(ViewportCommand::SetZ { z: 30 }.into());
        scene.apply(ViewportCommand::SetT { t: 3 }.into());
        let deep = layer(&scene, "deep");
        assert_eq!((deep.z_range.clone(), deep.t), (30..31, 3));
        assert!(!deep.z_clamped && !deep.t_clamped);
        assert_eq!(deep.z_reach, CutReach::Through);

        // Past its last plane the layer draws nothing, and nothing is planned.
        assert_eq!(reach(&scene, "shallow"), CutReach::Outside);
        assert!(wanted(&scene, "shallow").is_empty());
        assert_eq!(
            scene.layer_reach(scene.active_view().id(), &DatasetId("shallow".into())),
            Some(CutReach::Outside)
        );

        // The flat layer shows its one plane and last timepoint.
        let flat = layer(&scene, "flat");
        assert_eq!((flat.z_range.clone(), flat.t), (0..1, 0));
        assert!(flat.z_clamped && flat.t_clamped);
        assert_eq!(flat.z_reach, CutReach::Every);
        let flat_wanted = wanted(&scene, "flat");
        assert!(!flat_wanted.is_empty());
        assert!(flat_wanted.iter().all(|c| c.z == 0 && c.t == 0));

        // A volume view cuts nothing.
        scene.set_mode_3d();
        assert_eq!(
            scene.layer_reach(scene.active_view().id(), &DatasetId("shallow".into())),
            None
        );
    }

    #[test]
    fn a_flat_layer_alone_has_no_z_to_show_at() {
        let mut scene = Scene::new([800, 600]);
        open_shaped(&mut scene, "flat", [1, 1, 1, 64, 64]);
        assert_eq!(layer(&scene, "flat").z_reach, CutReach::Through);
        // A deeper layer that is hidden leaves no Z to step through either.
        open_shaped(&mut scene, "deep", [1, 1, 40, 64, 64]);
        assert_eq!(layer(&scene, "flat").z_reach, CutReach::Every);
        scene.apply(
            ViewportCommand::SetDatasetVisible {
                dataset_id: "deep".into(),
                visible: false,
            }
            .into(),
        );
        assert_eq!(layer(&scene, "flat").z_reach, CutReach::Through);
    }

    #[test]
    fn the_chunk_plan_covers_every_shown_channel() {
        let mut scene = scene_with(&[("a", 3)]);
        let channels = |scene: &Scene| {
            let mut cs: Vec<u32> = scene
                .chunk_plan_for(scene.active_view().id(), &DatasetId("a".into()))
                .unwrap()
                .iter()
                .flat_map(|p| p.needed.iter().map(|c| c.c))
                .collect();
            cs.sort();
            cs.dedup();
            cs
        };
        assert_eq!(channels(&scene), vec![0, 1, 2]);
        solo(&mut scene, "a", Some(1));
        assert_eq!(channels(&scene), vec![1]);
    }

    #[test]
    fn a_captured_view_resolves_to_what_the_scene_shows() {
        let mut scene = scene_with(&[("a", 3), ("b", 2)]);
        scene.apply(
            ViewportCommand::SetChannelVisible {
                dataset_id: "a".into(),
                channel: 1,
                visible: false,
            }
            .into(),
        );
        solo(&mut scene, "b", Some(1));
        let mut view = SavedView::empty([800, 600]);
        view.view = scene.active_view().axes.clone();
        view.dataset_order = scene.dataset_order.clone();
        for id in &scene.dataset_order {
            view.dataset_settings
                .insert(id.clone(), scene.dataset_settings[id].clone());
        }
        assert_eq!(
            scene.resolved_view_layers(&view),
            scene.resolved_layers(scene.active_view().id())
        );
    }

    #[test]
    fn a_view_that_solos_resolves_to_its_solo_with_the_scene_styling() {
        let scene = scene_with(&[("a", 3)]);
        let mut view = SavedView::empty([800, 600]);
        // An entry listing no channels, as Home's does, keeps the scene's.
        view.dataset_settings.insert(
            DatasetId("a".into()),
            DatasetDisplaySettings {
                solo: Some(2),
                ..Default::default()
            },
        );
        let layers = scene.resolved_view_layers(&view);
        assert_eq!(layers[0].channel_indices(), vec![2]);
        assert_eq!(layers[0].channels[0].colormap, Colormap::Cyan);
    }

    #[test]
    fn pin_context_needs_one_shared_channel() {
        assert!(in_channel_context(&[0, 1, 2], &[1]));
        assert!(in_channel_context(&[1], &[0, 1, 2]));
        assert!(!in_channel_context(&[1], &[2]));
        assert!(!in_channel_context(&[0, 1], &[2]));
    }

    #[test]
    fn a_legacy_solo_lands_on_each_layer_that_has_the_channel() {
        let mut scene = scene_with(&[("a", 3), ("b", 2), ("c", 1)]);
        assert!(scene.adopt_legacy_channels(LegacyChannels::Solo(2)));
        assert_eq!(shown(&scene, "a"), vec![2]);
        assert_eq!(shown(&scene, "b"), vec![0, 1]);
        assert_eq!(shown(&scene, "c"), vec![0]);
        assert!(scene.adopt_legacy_channels(LegacyChannels::Composite));
        assert_eq!(shown(&scene, "a"), vec![0, 1, 2]);
        assert!(!scene.adopt_legacy_channels(LegacyChannels::Composite));
    }
}
