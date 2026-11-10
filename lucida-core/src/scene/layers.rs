//! What each layer shows at the scene's selectors: which channels, through
//! which colormap and window, at which z and t. Decided here once, so the
//! renderer, the planner, the minimap, explore thumbnails, the pin-context
//! check and the CLI cannot disagree about it.

use std::ops::Range;

use lucida_content::{DatasetId, DatasetManifest};
use serde::{Deserialize, Serialize};

use super::{BlendMode, Colormap, DatasetDisplaySettings, RenderMode, Scene};
use crate::placement::Affine;
use crate::saved_view::SavedView;
use crate::slice_plane::SlicePlane;
use crate::view::{LegacyChannels, ViewState};
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

/// What one layer shows.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ResolvedLayer {
    pub dataset_id: DatasetId,
    /// A hidden layer still lists the channels it would show.
    pub visible: bool,
    pub opacity: f32,
    pub render_mode: RenderMode,
    pub channel_count: u32,
    pub solo: Option<u32>,
    /// Ascending by channel, never empty.
    pub channels: Vec<ShownChannel>,
    /// The scene's z slab, clamped into this layer's depth.
    pub z_range: Range<u32>,
    /// The scene's timepoint, clamped into this layer's timepoints.
    pub t: u32,
    /// The plane of this layer an XZ view cuts along Y, and the one a YZ
    /// view cuts along X: the scene's axis position, a place in the scene
    /// frame, in the layer's own samples.
    pub y: u32,
    pub x: u32,
    /// Whether the scene's z slab reaches past this layer, so it shows its
    /// nearest plane instead.
    pub z_clamped: bool,
    /// Whether the scene's timepoint is past this layer's last.
    pub t_clamped: bool,
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

    fn clamp_z(&self, range: &Range<u32>) -> Range<u32> {
        let start = range.start.min(self.z - 1);
        start..range.end.clamp(start + 1, self.z)
    }

    fn clamp_t(&self, t: u32) -> u32 {
        t.min(self.t - 1)
    }

    /// The plane of this layer an X or Y axis position cuts. The position is
    /// a place in the scene frame, absent its plane 0, read back through the
    /// layer's placement `to_scene`, so layers over one region cut the same
    /// plane. Past the layer it takes the nearest plane, as a shallow layer's
    /// Z does.
    fn cut_plane(&self, position: Option<u32>, axis: SpatialAxis, to_scene: &Affine) -> u32 {
        let a = axis.xyz();
        let mut at = [0.0; 3];
        at[a] = position.unwrap_or(0) as f64 + 0.5;
        let plane = to_scene.inverse().apply(at)[a].floor();
        plane.clamp(0.0, (self.along(axis) - 1) as f64) as u32
    }

    /// The planes a slice view of `plane` cuts here under `view`.
    fn clamp_cut(&self, view: &ViewState, plane: SlicePlane, to_scene: &Affine) -> Range<u32> {
        let single = |index: u32| index..index + 1;
        match plane.cut() {
            SpatialAxis::Z => self.clamp_z(&view.z_range),
            SpatialAxis::Y => single(self.cut_plane(view.y, SpatialAxis::Y, to_scene)),
            SpatialAxis::X => single(self.cut_plane(view.x, SpatialAxis::X, to_scene)),
        }
    }
}

/// What one layer shows with `settings` at the selectors in `view`.
fn resolve(
    dataset_id: &DatasetId,
    manifest: &DatasetManifest,
    settings: &DatasetDisplaySettings,
    view: &ViewState,
    to_scene: &Affine,
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
    let z_range = extent.clamp_z(&view.z_range);
    let t = extent.clamp_t(view.t);
    ResolvedLayer {
        dataset_id: dataset_id.clone(),
        visible: settings.visible,
        opacity: settings.opacity,
        render_mode: settings.render_mode,
        channel_count: extent.c,
        solo: settings.solo.filter(|&solo| solo < extent.c),
        channels,
        z_clamped: z_range != view.z_range,
        z_range,
        t_clamped: t != view.t,
        t,
        y: extent.cut_plane(view.y, SpatialAxis::Y, to_scene),
        x: extent.cut_plane(view.x, SpatialAxis::X, to_scene),
    }
}

impl Scene {
    /// Every layer in panel order, then any dataset the order does not list.
    pub fn resolved_layers(&self) -> Vec<ResolvedLayer> {
        self.layer_ids()
            .filter_map(|id| self.resolved_layer(id))
            .collect()
    }

    /// What `dataset_id` shows, or `None` for a dataset the document lacks.
    pub fn resolved_layer(&self, dataset_id: &DatasetId) -> Option<ResolvedLayer> {
        let manifest = self.document.manifests.get(dataset_id)?;
        let seeded;
        let settings = match self.dataset_settings.get(dataset_id) {
            Some(settings) => settings,
            None => {
                seeded = DatasetDisplaySettings::seeded_for(manifest);
                &seeded
            }
        };
        let to_scene = self.placement(dataset_id).unwrap_or(Affine::IDENTITY);
        Some(resolve(
            dataset_id, manifest, settings, &self.view, &to_scene,
        ))
    }

    /// What this scene's layers would show under `view`, as restoring it here
    /// leaves them: a layer the view styles takes the view's settings, except
    /// that channels the view lists no entry for keep this scene's styling.
    pub fn resolved_view_layers(&self, view: &SavedView) -> Vec<ResolvedLayer> {
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
                let to_scene = self.placement(id).unwrap_or(Affine::IDENTITY);
                Some(resolve(id, manifest, &settings, &view.view, &to_scene))
            })
            .collect()
    }

    fn layer_ids(&self) -> impl Iterator<Item = &DatasetId> {
        let unlisted = self
            .document
            .manifests
            .keys()
            .filter(|id| !self.dataset_order.contains(id));
        self.dataset_order.iter().chain(unlisted)
    }

    /// The scene's z slab clamped into `dataset_id`, or the slab itself for a
    /// dataset the document lacks.
    pub fn layer_z_range(&self, dataset_id: &DatasetId) -> Range<u32> {
        match self.document.manifests.get(dataset_id) {
            Some(manifest) => LayerExtent::of(manifest).clamp_z(&self.view.z_range),
            None => self.view.z_range.clone(),
        }
    }

    /// The planes a slice view of `plane` cuts in `dataset_id`, clamped into
    /// it, or the scene's own for a dataset the document lacks.
    pub fn layer_cut(&self, dataset_id: &DatasetId, plane: SlicePlane) -> Range<u32> {
        match (
            self.document.manifests.get(dataset_id),
            self.placement(dataset_id),
        ) {
            (Some(manifest), Some(to_scene)) => {
                LayerExtent::of(manifest).clamp_cut(&self.view, plane, &to_scene)
            }
            _ => self.view.cut(plane),
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
            .resolved_layer(&DatasetId(id.to_string()))
            .unwrap()
            .channel_indices()
    }

    #[test]
    fn a_multichannel_layer_opens_as_its_composite() {
        let scene = scene_with(&[("a", 3)]);
        let layer = scene.resolved_layer(&DatasetId("a".into())).unwrap();
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
        let layer = scene.resolved_layer(&DatasetId("a".into())).unwrap();
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
        let layer = scene.resolved_layer(&DatasetId("a".into())).unwrap();
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
        assert!(scene.resolved_layers().iter().all(|l| l.visible));

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
        let layer = scene.resolved_layer(&DatasetId("a".into())).unwrap();
        assert_eq!(layer.channels[0].blend_mode, BlendMode::Alpha);
    }

    #[test]
    fn a_global_z_or_t_past_a_layer_clamps_it_and_says_so() {
        let mut scene = Scene::new([800, 600]);
        for (id, shape) in [("deep", [4, 1, 40, 64, 64]), ("flat", [1, 1, 1, 64, 64])] {
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
        scene.apply(ViewportCommand::SetZ { z: 30 }.into());
        scene.apply(ViewportCommand::SetT { t: 3 }.into());
        let deep = scene.resolved_layer(&DatasetId("deep".into())).unwrap();
        assert_eq!((deep.z_range.clone(), deep.t), (30..31, 3));
        assert!(!deep.z_clamped && !deep.t_clamped);
        let flat = scene.resolved_layer(&DatasetId("flat".into())).unwrap();
        assert_eq!((flat.z_range.clone(), flat.t), (0..1, 0));
        assert!(flat.z_clamped && flat.t_clamped);

        // The plan asks for the clamped plane, not for nothing.
        let plans = scene.chunk_plan_for(&DatasetId("flat".into())).unwrap();
        assert!(plans.iter().any(|p| !p.needed.is_empty()));
        assert!(
            plans
                .iter()
                .flat_map(|p| &p.needed)
                .all(|c| c.z == 0 && c.t == 0)
        );
    }

    #[test]
    fn the_chunk_plan_covers_every_shown_channel() {
        let mut scene = scene_with(&[("a", 3)]);
        let channels = |scene: &Scene| {
            let mut cs: Vec<u32> = scene
                .chunk_plan_for(&DatasetId("a".into()))
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
        view.view = scene.view.clone();
        view.dataset_order = scene.dataset_order.clone();
        for id in &scene.dataset_order {
            view.dataset_settings
                .insert(id.clone(), scene.dataset_settings[id].clone());
        }
        assert_eq!(scene.resolved_view_layers(&view), scene.resolved_layers());
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
