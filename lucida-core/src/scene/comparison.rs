//! Two datasets compared in one view: split by a divider dragged across the
//! view (swipe), or shown one at a time in turn (blink). Only a pair that
//! lines up in physical space can be compared, so whichever one shows at a
//! point of the screen shows the same place.
//!
//! Both datasets stay in the wanted set however the comparison shows them,
//! so the one that comes back into view never waits on a fetch. Every other
//! layer the view shows is set aside while the comparison lasts: drawn
//! nowhere and planned for nothing, so each side shows exactly one of the
//! pair. Its own visibility is left alone, so ending the comparison brings
//! it back as it was.

use lucida_content::DatasetId;
use serde::{Deserialize, Serialize};

use crate::placement::LineUp;
use crate::view::ViewId;

use super::Scene;

/// How a comparison shows its two datasets.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CompareMode {
    /// `a` left of the divider, `b` right of it.
    Swipe,
    /// One of them across the whole view.
    Blink,
}

/// One of a comparison's two datasets.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Side {
    A,
    B,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Comparison {
    /// Left of the divider, and what a blink shows first.
    pub a: DatasetId,
    /// Right of the divider.
    pub b: DatasetId,
    pub mode: CompareMode,
    /// The divider, as a fraction of the view's width from its left edge.
    /// Kept through a blink, so switching back finds it where it was.
    pub divider: f64,
    /// What a blink shows.
    pub showing: Side,
    /// How many times a second a blink shows the other dataset by itself,
    /// one of [`BLINK_RATES`], or `None` while it waits to be flipped.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub rate: Option<f64>,
}

/// The rates a blink runs at, in flips a second, as the compare bar offers
/// them.
pub const BLINK_RATES: [f64; 3] = [1.0, 2.0, 4.0];

impl Comparison {
    /// Whether `dataset` is one of the pair.
    pub fn compares(&self, dataset: &DatasetId) -> bool {
        *dataset == self.a || *dataset == self.b
    }

    /// What of the view's width `dataset` shows, as `[from, to]` fractions
    /// from its left edge; equal ends show none of it. `None` for a dataset
    /// outside the pair, which the comparison sets aside.
    pub fn span(&self, dataset: &DatasetId) -> Option<[f64; 2]> {
        let side = if *dataset == self.a {
            Side::A
        } else if *dataset == self.b {
            Side::B
        } else {
            return None;
        };
        Some(match (self.mode, side) {
            (CompareMode::Swipe, Side::A) => [0.0, self.divider],
            (CompareMode::Swipe, Side::B) => [self.divider, 1.0],
            (CompareMode::Blink, side) if side == self.showing => [0.0, 1.0],
            (CompareMode::Blink, _) => [0.0, 0.0],
        })
    }
}

impl Scene {
    /// The comparison the active view shows, if any.
    pub fn comparison(&self) -> Option<&Comparison> {
        self.active_view().comparison.as_ref()
    }

    /// Compare `a` with `b` in the active view in `mode`, the divider in the
    /// middle and a blink showing `a`. Refused with the verdict unless the
    /// two line up.
    pub fn compare(&mut self, a: DatasetId, b: DatasetId, mode: CompareMode) -> Result<(), LineUp> {
        match self.line_up(&a, &b) {
            LineUp::Yes => {}
            verdict => return Err(verdict),
        }
        self.set_comparison(Some(Comparison {
            a,
            b,
            mode,
            divider: 0.5,
            showing: Side::A,
            rate: None,
        }));
        Ok(())
    }

    /// Stop comparing; both datasets show across the view again, and so do
    /// the layers it set aside.
    pub fn end_comparison(&mut self) {
        self.set_comparison(None);
    }

    /// Show the comparison in `mode`. Nothing without a comparison.
    pub fn set_comparison_mode(&mut self, mode: CompareMode) {
        self.edit_comparison(|c| c.mode = mode);
    }

    /// Put the divider at `at`, a fraction of the view's width, clamped to
    /// the view. A value that isn't a number is ignored.
    pub fn set_comparison_divider(&mut self, at: f64) {
        if at.is_nan() {
            return;
        }
        self.edit_comparison(|c| c.divider = at.clamp(0.0, 1.0));
    }

    /// Run a blink at `rate` flips a second, or stop it with `None`. A rate
    /// the compare bar doesn't offer is ignored.
    pub fn set_blink_rate(&mut self, rate: Option<f64>) {
        if rate.is_some_and(|rate| !BLINK_RATES.contains(&rate)) {
            return;
        }
        self.edit_comparison(|c| c.rate = rate);
    }

    /// Show the other dataset in a blink.
    pub fn flip_comparison(&mut self) {
        self.edit_comparison(|c| {
            c.showing = match c.showing {
                Side::A => Side::B,
                Side::B => Side::A,
            }
        });
    }

    fn edit_comparison(&mut self, edit: impl FnOnce(&mut Comparison)) {
        let Some(mut next) = self.comparison().cloned() else {
            return;
        };
        edit(&mut next);
        self.set_comparison(Some(next));
    }

    /// The layers `view`'s comparison sets aside, in layer order: each it
    /// shows, visible by its own setting, outside the pair. Empty without a
    /// comparison or for an unknown view.
    pub fn set_aside(&self, view: ViewId) -> Vec<DatasetId> {
        let Some(view) = self.view(view) else {
            return Vec::new();
        };
        self.layer_ids()
            .filter(|id| view.shows(id) && view.sets_aside(id))
            .filter(|id| self.dataset_settings.get(*id).is_none_or(|s| s.visible))
            .cloned()
            .collect()
    }

    /// The one write to the active view's comparison, so `epochs.comparison`
    /// moves exactly when it does. Setting layers aside or bringing them back
    /// changes what is drawn and planned, as a visibility toggle does, so it
    /// moves `epochs.selection` too.
    fn set_comparison(&mut self, next: Option<Comparison>) {
        let view = self.active_view().id();
        if self.active_view().comparison == next {
            return;
        }
        let aside = self.set_aside(view);
        self.active_view_mut().comparison = next;
        self.epochs.comparison += 1;
        if self.set_aside(view) != aside {
            self.epochs.selection += 1;
        }
    }

    /// End every comparison whose datasets no longer line up, as when one is
    /// removed or a layout moves it away, or that its view no longer shows
    /// both of, as when one moves to another view. A comparison belongs to
    /// its view, its divider a fraction of that view's width and its set
    /// aside that view's other layers, so it never follows its pair
    /// elsewhere: moved together, they start in the other view uncompared,
    /// as they would one move at a time.
    pub(crate) fn keep_comparison_lined_up(&mut self) {
        let apart: Vec<usize> = (0..self.views.len())
            .filter(|&i| {
                let view = &self.views[i];
                view.comparison.as_ref().is_some_and(|c| {
                    !view.shows(&c.a)
                        || !view.shows(&c.b)
                        || self.line_up(&c.a, &c.b) != LineUp::Yes
                })
            })
            .collect();
        let set_aside = apart
            .iter()
            .any(|&i| !self.set_aside(self.views[i].id()).is_empty());
        for i in &apart {
            self.views[*i].comparison = None;
        }
        if !apart.is_empty() {
            self.epochs.comparison += 1;
        }
        if set_aside {
            self.epochs.selection += 1;
        }
    }
}

#[cfg(test)]
mod tests {
    use lucida_content::{DatasetId, PhysicalSpace};

    use super::super::test_helpers::make_dataset_opened_with_shape;
    use super::*;
    use crate::command::{DocumentCommand, ViewportCommand};

    /// A single image of `shape` `[z, y, x]` samples, `spacing` long in
    /// micrometers each when `physical`, else in no unit.
    fn open(scene: &mut Scene, id: &str, shape: [u64; 3], spacing: f64, physical: bool) {
        let mut opened = make_dataset_opened_with_shape(
            id,
            id,
            1,
            [1, 1, shape[0], shape[1], shape[2]],
            [1, 1, 16, 64, 64],
            1,
        );
        for image in opened.manifest.images_mut() {
            image.multiscale.levels[0].scale = [1.0, 1.0, spacing, spacing, spacing];
        }
        let unit = physical.then(|| "micrometer".to_string());
        opened.manifest = opened.manifest.with_space(PhysicalSpace {
            units: [unit.clone(), unit.clone(), unit],
            origin: [0.0; 3],
        });
        scene.apply(DocumentCommand::DatasetOpened(opened).into());
    }

    fn ids() -> [DatasetId; 2] {
        ["a", "b"].map(DatasetId::from)
    }

    /// A and B over the same 64 micrometers, B in samples half as long.
    fn lined_up() -> Scene {
        let mut scene = Scene::new([800, 600]);
        open(&mut scene, "a", [1, 64, 64], 1.0, true);
        open(&mut scene, "b", [1, 128, 128], 0.5, true);
        scene
    }

    #[test]
    fn a_swipe_splits_the_view_at_the_divider() {
        let mut scene = lined_up();
        let [a, b] = ids();
        scene
            .compare(a.clone(), b.clone(), CompareMode::Swipe)
            .unwrap();
        scene.set_comparison_divider(0.25);
        let c = scene.comparison().unwrap();
        assert_eq!(c.span(&a), Some([0.0, 0.25]));
        assert_eq!(c.span(&b), Some([0.25, 1.0]));
        assert_eq!(c.span(&DatasetId::from("other")), None);
        scene.set_comparison_divider(4.0);
        assert_eq!(scene.comparison().unwrap().divider, 1.0);
    }

    #[test]
    fn a_blink_shows_one_at_a_time_and_keeps_the_divider() {
        let mut scene = lined_up();
        let [a, b] = ids();
        scene
            .compare(a.clone(), b.clone(), CompareMode::Swipe)
            .unwrap();
        scene.set_comparison_divider(0.3);
        scene.set_comparison_mode(CompareMode::Blink);
        let c = scene.comparison().unwrap();
        assert_eq!(
            (c.span(&a), c.span(&b)),
            (Some([0.0, 1.0]), Some([0.0, 0.0]))
        );
        scene.flip_comparison();
        let c = scene.comparison().unwrap();
        assert_eq!(
            (c.span(&a), c.span(&b)),
            (Some([0.0, 0.0]), Some([0.0, 1.0]))
        );
        scene.set_comparison_mode(CompareMode::Swipe);
        assert_eq!(scene.comparison().unwrap().span(&a), Some([0.0, 0.3]));
    }

    #[test]
    fn only_a_pair_that_lines_up_is_compared() {
        let mut scene = lined_up();
        open(&mut scene, "bare", [1, 64, 64], 1.0, false);
        let [a, _] = ids();
        let bare = DatasetId::from("bare");
        assert_eq!(
            scene.compare(a.clone(), bare.clone(), CompareMode::Blink),
            Err(LineUp::NoPhysicalScale {
                datasets: vec![bare]
            })
        );
        assert_eq!(scene.comparison(), None);
    }

    #[test]
    fn the_epoch_moves_with_the_comparison_and_selection_with_what_it_sets_aside() {
        let mut scene = lined_up();
        let [a, b] = ids();
        let before = scene.epochs.clone();
        scene
            .compare(a.clone(), b.clone(), CompareMode::Swipe)
            .unwrap();
        scene.set_comparison_divider(0.5);
        scene.flip_comparison();
        scene.set_comparison_divider(0.7);
        scene.set_comparison_mode(CompareMode::Blink);
        scene.end_comparison();
        scene.end_comparison();
        // With nothing else to set aside, only where the pair draws changed.
        let mut after = scene.epochs.clone();
        assert_eq!(after.comparison, before.comparison + 5);
        after.comparison = before.comparison;
        assert_eq!(after, before);

        open(&mut scene, "c", [1, 64, 64], 1.0, true);
        let before = scene.epochs.clone();
        scene.compare(a, b, CompareMode::Swipe).unwrap();
        assert_eq!(
            scene.set_aside(scene.active_view().id()),
            [DatasetId::from("c")]
        );
        assert_eq!(scene.epochs.selection, before.selection + 1);
        scene.set_comparison_divider(0.2);
        scene.set_comparison_mode(CompareMode::Blink);
        assert_eq!(scene.epochs.selection, before.selection + 1);
        scene.end_comparison();
        assert_eq!(scene.epochs.selection, before.selection + 2);
    }

    #[test]
    fn only_the_pair_draws_and_ending_the_comparison_brings_the_others_back() {
        let mut scene = lined_up();
        open(&mut scene, "c", [1, 64, 64], 1.0, true);
        open(&mut scene, "hidden", [1, 64, 64], 1.0, true);
        scene.apply(
            ViewportCommand::SetDatasetVisible {
                dataset_id: "hidden".into(),
                visible: false,
            }
            .into(),
        );
        let view = scene.active_view().id();
        let layers = scene.resolved_layers(view);
        let settings = scene.dataset_settings.clone();
        let drawn = |scene: &Scene, id: &str| {
            let layer = scene.resolved_layer(view, &DatasetId::from(id)).unwrap();
            (layer.visible, layer.set_aside)
        };

        let [a, b] = ids();
        scene.compare(a, b, CompareMode::Blink).unwrap();
        // The one a blink hides stays drawn, so it never waits on a fetch.
        assert_eq!(drawn(&scene, "a"), (true, false));
        assert_eq!(drawn(&scene, "b"), (true, false));
        assert_eq!(drawn(&scene, "c"), (false, true));
        // A layer hidden by its own setting was never the comparison's to hide.
        assert_eq!(drawn(&scene, "hidden"), (false, false));
        assert_eq!(scene.dataset_settings, settings);

        scene.end_comparison();
        assert_eq!(scene.resolved_layers(view), layers);
    }

    #[test]
    fn removing_a_compared_dataset_ends_the_comparison() {
        let mut scene = lined_up();
        let [a, b] = ids();
        scene.compare(a, b.clone(), CompareMode::Blink).unwrap();
        let epoch = scene.epochs.comparison;
        open(&mut scene, "c", [1, 64, 64], 1.0, true);
        assert!(scene.comparison().is_some());
        let selection = scene.epochs.selection;
        scene.apply(DocumentCommand::RemoveDataset { id: b }.into());
        assert_eq!(scene.comparison(), None);
        assert!(scene.epochs.comparison > epoch);
        // The layer it set aside draws again.
        assert!(scene.epochs.selection > selection);
        let c = scene.resolved_layer(scene.active_view().id(), &DatasetId::from("c"));
        assert_eq!(c.map(|c| (c.visible, c.set_aside)), Some((true, false)));
    }

    #[test]
    fn a_comparison_belongs_to_the_view_it_was_made_in() {
        let mut scene = lined_up();
        let second = crate::view::ViewId(1);
        scene.views.push(crate::view::View::new(second, [400, 600]));
        let [a, b] = ids();
        scene.compare(a.clone(), b, CompareMode::Swipe).unwrap();
        assert_eq!(scene.view(second).unwrap().comparison, None);

        // A dataset going away ends every view's comparison of it.
        scene.views[1].comparison = scene.comparison().cloned();
        scene.apply(DocumentCommand::RemoveDataset { id: a }.into());
        assert!(scene.views().iter().all(|view| view.comparison.is_none()));
    }

    /// A, B and C over one region, in two views, the first comparing A and
    /// B by swipe and so setting C aside.
    fn comparing_in_two_views() -> (Scene, [crate::view::ViewId; 2]) {
        let mut scene = lined_up();
        open(&mut scene, "c", [1, 64, 64], 1.0, true);
        let layout = crate::view::ViewLayout::Columns;
        scene.apply(ViewportCommand::SetViewLayout { layout }.into());
        let views = [scene.views()[0].id(), scene.views()[1].id()];
        let [a, b] = ids();
        scene.compare(a, b, CompareMode::Swipe).unwrap();
        assert_eq!(scene.set_aside(views[0]), vec![DatasetId::from("c")]);
        (scene, views)
    }

    fn drawn(scene: &Scene, view: crate::view::ViewId, id: &str) -> Option<(bool, bool)> {
        let layer = scene.resolved_layer(view, &DatasetId::from(id))?;
        Some((layer.visible, layer.set_aside))
    }

    #[test]
    fn moving_a_compared_dataset_to_another_view_ends_the_comparison() {
        let (mut scene, [first, second]) = comparing_in_two_views();
        let (epoch, selection) = (scene.epochs.comparison, scene.epochs.selection);
        let [_, b] = ids();
        scene.apply(
            ViewportCommand::MoveDatasetToView {
                view: second,
                dataset_id: b.clone(),
            }
            .into(),
        );
        assert_eq!(scene.view(first).unwrap().comparison, None);
        assert!(scene.epochs.comparison > epoch);
        assert!(scene.epochs.selection > selection);
        // What it set aside draws again, and B draws where it went.
        assert!(scene.set_aside(first).is_empty());
        assert_eq!(drawn(&scene, first, "c"), Some((true, false)));
        assert_eq!(drawn(&scene, first, "a"), Some((true, false)));
        assert_eq!(drawn(&scene, second, "b"), Some((true, false)));
    }

    #[test]
    fn showing_a_view_without_one_of_its_pair_ends_the_comparison() {
        let (mut scene, [first, _]) = comparing_in_two_views();
        let datasets = crate::view::ViewDatasets::Only(vec!["a".into(), "c".into()]);
        scene.apply(
            ViewportCommand::SetViewDatasets {
                view: first,
                datasets,
            }
            .into(),
        );
        assert_eq!(scene.view(first).unwrap().comparison, None);
        assert_eq!(drawn(&scene, first, "c"), Some((true, false)));
    }

    /// The pair moved together starts in the other view uncompared: the
    /// comparison stays with the view it divided, which ends it.
    #[test]
    fn moving_both_compared_datasets_leaves_the_comparison_behind() {
        let (mut scene, [first, second]) = comparing_in_two_views();
        for dataset_id in ids() {
            scene.apply(
                ViewportCommand::MoveDatasetToView {
                    view: second,
                    dataset_id,
                }
                .into(),
            );
        }
        assert!(scene.views().iter().all(|view| view.comparison.is_none()));
        assert_eq!(drawn(&scene, first, "c"), Some((true, false)));
        assert_eq!(drawn(&scene, second, "a"), Some((true, false)));
        assert_eq!(drawn(&scene, second, "b"), Some((true, false)));
    }

    #[test]
    fn a_recorded_comparison_of_a_dataset_its_view_no_longer_shows_stays_out() {
        let (mut scene, [first, _]) = comparing_in_two_views();
        let mut record = scene.record_views(true).unwrap();
        record.views[0].datasets = crate::view::ViewDatasets::Only(vec!["a".into(), "c".into()]);
        assert!(record.views[0].comparison.is_some());
        scene.import_views(Some(&record), None, true);
        assert_eq!(scene.view(first).unwrap().comparison, None);
        assert_eq!(drawn(&scene, first, "c"), Some((true, false)));
    }
}
