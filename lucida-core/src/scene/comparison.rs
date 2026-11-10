//! Two datasets compared in one view: split by a divider dragged across the
//! view (swipe), or shown one at a time in turn (blink). Only a pair that
//! lines up in physical space can be compared, so whichever one shows at a
//! point of the screen shows the same place.
//!
//! Both datasets stay in the wanted set however the comparison shows them,
//! so the one that comes back into view never waits on a fetch. A
//! comparison only decides where on the screen each one is drawn.

use lucida_content::DatasetId;
use serde::{Deserialize, Serialize};

use crate::placement::LineUp;

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
}

impl Comparison {
    /// What of the view's width `dataset` shows, as `[from, to]` fractions
    /// from its left edge; equal ends show none of it. `None` for a dataset
    /// the comparison leaves alone, which shows across the whole view.
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
        }));
        Ok(())
    }

    /// Stop comparing; both datasets show across the view again.
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

    /// The one write to the active view's comparison, so `epochs.comparison`
    /// moves exactly when it does. Planning reads no epoch it bumps: what is
    /// wanted is the same however the pair is shown.
    fn set_comparison(&mut self, next: Option<Comparison>) {
        let comparison = &mut self.active_view_mut().comparison;
        if *comparison != next {
            *comparison = next;
            self.epochs.comparison += 1;
        }
    }

    /// End every comparison whose datasets no longer line up, as when one is
    /// removed or a layout moves it away.
    pub(crate) fn keep_comparison_lined_up(&mut self) {
        let apart: Vec<usize> = (0..self.views.len())
            .filter(|&i| {
                self.views[i]
                    .comparison
                    .as_ref()
                    .is_some_and(|c| self.line_up(&c.a, &c.b) != LineUp::Yes)
            })
            .collect();
        for i in &apart {
            self.views[*i].comparison = None;
        }
        if !apart.is_empty() {
            self.epochs.comparison += 1;
        }
    }
}

#[cfg(test)]
mod tests {
    use lucida_content::{DatasetId, PhysicalSpace};

    use super::super::test_helpers::make_dataset_opened_with_shape;
    use super::*;
    use crate::command::DocumentCommand;

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
    fn the_epoch_moves_with_the_comparison_and_nothing_else_does() {
        let mut scene = lined_up();
        let [a, b] = ids();
        let before = scene.epochs.clone();
        scene.compare(a, b, CompareMode::Swipe).unwrap();
        scene.set_comparison_divider(0.5);
        assert_eq!(scene.epochs.comparison, before.comparison + 1);
        scene.flip_comparison();
        scene.set_comparison_divider(0.7);
        scene.end_comparison();
        scene.end_comparison();
        assert_eq!(scene.epochs.comparison, before.comparison + 4);
        let mut after = scene.epochs.clone();
        after.comparison = before.comparison;
        assert_eq!(after, before);
    }

    #[test]
    fn removing_a_compared_dataset_ends_the_comparison() {
        let mut scene = lined_up();
        let [a, b] = ids();
        scene.compare(a, b.clone(), CompareMode::Blink).unwrap();
        let epoch = scene.epochs.comparison;
        open(&mut scene, "c", [1, 64, 64], 1.0, true);
        assert!(scene.comparison().is_some());
        scene.apply(DocumentCommand::RemoveDataset { id: b }.into());
        assert_eq!(scene.comparison(), None);
        assert!(scene.epochs.comparison > epoch);
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
}
