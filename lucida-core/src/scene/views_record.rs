//! A scene's views as a saved view and a presence carry them: how the canvas
//! divides, what each view shows and where it stands, which one commands
//! steer, and how they link. A scene of one view of every dataset records
//! none, so a reader that knows one view reads it as it always did.

use lucida_content::DatasetId;
use serde::{Deserialize, Serialize};

use super::links::Followed;
use super::{Comparison, LinksRecord, Scene};
use crate::camera::Camera;
use crate::placement::{CameraSpace, LineUp};
use crate::view::{AxisPositions, View, ViewDatasets, ViewId, ViewLayout, ViewRect};

/// Every view of a scene, in the layout's order.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ViewsRecord {
    pub layout: ViewLayout,
    /// Which of `views` commands steer.
    #[serde(default)]
    pub active: usize,
    /// Which of `views` is shown alone across the canvas, if one is.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub maximized: Option<usize>,
    pub views: Vec<ViewRecord>,
    /// Absent while the views link by no pair, as with other than two.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub links: Option<LinksRecord>,
}

/// One view. Its 2D or 3D mode, slice plane and transposed flag are its
/// camera's. A camera nothing has fitted yet, as a view showing nothing
/// holds, restores as one, which the scene fits once the view shows data.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ViewRecord {
    pub camera: Camera,
    #[serde(default)]
    pub axes: AxisPositions,
    #[serde(default = "every_dataset")]
    pub datasets: ViewDatasets,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub comparison: Option<Comparison>,
}

fn every_dataset() -> ViewDatasets {
    ViewDatasets::All
}

impl ViewsRecord {
    /// The canvas the views were laid out on, in device pixels: the active
    /// view's viewport over the part of the canvas it had. `None` when the
    /// record names no active view.
    pub fn canvas(&self) -> Option<[u32; 2]> {
        let viewport = self.views.get(self.active)?.camera.viewport();
        let rect = if self.maximized == Some(self.active) {
            ViewRect::WHOLE
        } else {
            *self.layout.rects().get(self.active)?
        };
        let across = |length: u32, fraction: f64| (f64::from(length) / fraction).round() as u32;
        Some([
            across(viewport[0], rect.width),
            across(viewport[1], rect.height),
        ])
    }

    /// Rewrite every dataset id through `remap` (old id → new id); an id it
    /// leaves out stays.
    pub fn remap_dataset_ids(&mut self, remap: &std::collections::HashMap<DatasetId, DatasetId>) {
        let mapped = |id: &mut DatasetId| {
            if let Some(new) = remap.get(id) {
                *id = new.clone();
            }
        };
        for view in &mut self.views {
            if let ViewDatasets::Only(ids) = &mut view.datasets {
                ids.iter_mut().for_each(mapped);
            }
            if let Some(comparison) = &mut view.comparison {
                mapped(&mut comparison.a);
                mapped(&mut comparison.b);
            }
        }
        if let Some(links) = &mut self.links {
            links.datasets.iter_mut().for_each(mapped);
        }
    }
}

/// What [`Scene::import_views`] compares to say what moved.
struct Standing {
    layout: ViewLayout,
    active: ViewId,
    maximized: Option<ViewId>,
    views: Vec<View>,
    set_aside: Vec<Vec<DatasetId>>,
}

impl Scene {
    /// The views as a saved view or a presence records them, each with its
    /// comparison when `comparisons` asks. `None` for one view of every
    /// dataset with nothing left out, which the active view's camera and
    /// axis positions describe alone.
    pub fn record_views(&self, comparisons: bool) -> Option<ViewsRecord> {
        let record = self.views_record(comparisons);
        let alone =
            |view: &ViewRecord| view.datasets == ViewDatasets::All && view.comparison.is_none();
        if record.layout == ViewLayout::Single && record.views.iter().all(alone) {
            return None;
        }
        Some(record)
    }

    /// The views as [`Self::record_views`] records them, one view of every
    /// dataset included, for a reader that wants the layout spelled out.
    pub fn views_record(&self, comparisons: bool) -> ViewsRecord {
        let views: Vec<ViewRecord> = self
            .views
            .iter()
            .map(|view| ViewRecord {
                camera: view.camera.clone(),
                axes: view.axes.clone(),
                datasets: view.datasets.clone(),
                comparison: view.comparison.clone().filter(|_| comparisons),
            })
            .collect();
        ViewsRecord {
            layout: self.layout,
            active: self.view_index(self.active).unwrap_or(0),
            maximized: self.maximized.and_then(|id| self.view_index(id)),
            views,
            links: self.links_record(),
        }
    }

    /// Where `view` stands in the layout's order, from 0.
    pub fn view_index(&self, view: ViewId) -> Option<usize> {
        self.views.iter().position(|shown| shown.id() == view)
    }

    /// Lay the views out as `record` says, their cameras and axis positions
    /// carried from `from`, the spaces they were recorded in, should they
    /// differ. `None` is one view of every dataset: the active view, keeping
    /// its camera and axis positions for an import of them to follow.
    ///
    /// A view's comparison comes back only with `comparisons`, and only while
    /// its pair still lines up; without, every view shows none.
    ///
    /// A placed camera keeps the region it showed in the rectangle the view
    /// has here, and a framed one fits again, as [`Self::import_presence`]
    /// does for one view. The links come back when the views link by the
    /// pair they were recorded for ([`Self::restore_links`]).
    ///
    /// Each epoch moves only when what it covers changed, so a presence
    /// imported again unchanged invalidates nothing.
    pub fn import_views(
        &mut self,
        record: Option<&ViewsRecord>,
        from: Option<&CameraSpace>,
        comparisons: bool,
    ) {
        let before = self.standing();
        match record {
            Some(record) => self.lay_out(record, from, comparisons),
            None => {
                if self.layout != ViewLayout::Single {
                    self.set_view_layout(ViewLayout::Single);
                }
                let view = self.active_view_mut();
                view.comparison = None;
                if view.datasets != ViewDatasets::All {
                    view.datasets = ViewDatasets::All;
                    let id = view.id();
                    self.reframe(id);
                }
            }
        }
        self.keep_comparison_lined_up();
        let followed = self.restore_links(record.and_then(|r| r.links.as_ref()));
        self.note_import(&before, followed);
    }

    fn lay_out(&mut self, record: &ViewsRecord, from: Option<&CameraSpace>, comparisons: bool) {
        if self.layout != record.layout {
            self.set_view_layout(record.layout);
        }
        let maximized = record
            .maximized
            .and_then(|at| self.views.get(at))
            .map(View::id);
        if self.maximized != maximized {
            self.set_maximized(maximized);
        }
        let restored: Vec<(ViewId, &ViewRecord)> =
            self.views.iter().map(View::id).zip(&record.views).collect();
        // What every view shows first, since a framed camera fits it and
        // four-up fits each slice view at the zoom all of them share.
        for (id, saved) in &restored {
            let mut axes = saved.axes.clone();
            if let Some(from) = from {
                self.carry_axes(&mut axes, from);
            }
            let comparison = saved
                .comparison
                .clone()
                .filter(|c| comparisons && self.line_up(&c.a, &c.b) == LineUp::Yes);
            let Some(view) = self.view_mut(*id) else {
                continue;
            };
            view.datasets = saved.datasets.clone();
            view.axes = axes;
            view.comparison = comparison;
        }
        for (id, saved) in &restored {
            let mut camera = saved.camera.clone();
            if let Some(from) = from {
                self.carry_camera(&mut camera, from);
            }
            // A recorded camera must not hand the scene a state its own
            // mutators could never produce.
            camera.sanitize();
            let Some(view) = self.view_mut(*id) else {
                continue;
            };
            camera.fit_region_to_viewport(view.camera.viewport());
            view.adopt_camera(camera);
            self.reframe(*id);
        }
        if let Some(view) = self.views.get(record.active) {
            self.active = view.id();
        }
    }

    fn standing(&self) -> Standing {
        Standing {
            layout: self.layout,
            active: self.active,
            maximized: self.maximized,
            views: self.views.clone(),
            set_aside: self
                .views
                .iter()
                .map(|view| self.set_aside(view.id()))
                .collect(),
        }
    }

    /// Move the epochs for what an import changed since `before`, with what
    /// the links moved.
    fn note_import(&mut self, before: &Standing, followed: Followed) {
        let (now, was) = (&self.views, &before.views);
        let structure = self.layout != before.layout
            || self.active != before.active
            || self.maximized != before.maximized
            || moved(now, was, |view| &view.datasets);
        let cameras = moved(now, was, |view| &view.camera);
        let axes = moved(now, was, |view| &view.axes);
        let compared = moved(now, was, |view| &view.comparison);
        let set_aside: Vec<Vec<DatasetId>> = self
            .views
            .iter()
            .map(|view| self.set_aside(view.id()))
            .collect();
        if structure || cameras || followed.camera {
            self.epochs.view += 1;
        }
        if structure || axes || set_aside != before.set_aside || followed.axes || followed.settings
        {
            self.epochs.selection += 1;
        }
        if compared {
            self.epochs.comparison += 1;
        }
    }
}

/// Whether the views differ, by id or in `part`.
fn moved<T: PartialEq>(now: &[View], was: &[View], part: fn(&View) -> &T) -> bool {
    now.len() != was.len()
        || now
            .iter()
            .zip(was)
            .any(|(a, b)| a.id() != b.id() || part(a) != part(b))
}

#[cfg(test)]
mod tests {
    use lucida_content::PhysicalSpace;

    use super::super::test_helpers::make_dataset_opened_with_shape;
    use super::*;
    use crate::camera::Framing;
    use crate::command::{Command, DocumentCommand, ViewportCommand};
    use crate::scene::{CompareMode, LinkMode, LinkProperty};

    /// A micrometer volume of `[z, y, x]` samples, each one micrometer, with
    /// its origin at `origin` `[z, y, x]` and two timepoints.
    fn open(scene: &mut Scene, id: &str, [z, y, x]: [u64; 3], origin: [f64; 3]) {
        let mut opened =
            make_dataset_opened_with_shape(id, id, 1, [2, 1, z, y, x], [1, 1, 16, 64, 64], 1);
        let unit = Some("micrometer".to_string());
        opened.manifest = opened.manifest.with_space(PhysicalSpace {
            units: [unit.clone(), unit.clone(), unit],
            origin,
        });
        scene.apply(DocumentCommand::DatasetOpened(opened).into());
    }

    fn apply(scene: &mut Scene, cmd: ViewportCommand) {
        scene.apply(Command::Viewport(cmd));
    }

    /// A and B over one region, or B beside A when `apart`, on a canvas of
    /// `canvas` device pixels.
    fn page(canvas: [u32; 2], apart: bool) -> Scene {
        let mut scene = Scene::new(canvas);
        open(&mut scene, "a", [32, 128, 128], [0.0; 3]);
        let origin = if apart { [0.0, 0.0, 500.0] } else { [0.0; 3] };
        open(&mut scene, "b", [32, 128, 128], origin);
        scene
    }

    fn id(name: &str) -> DatasetId {
        DatasetId::from(name)
    }

    fn view_ids(scene: &Scene) -> Vec<ViewId> {
        scene.views().iter().map(View::id).collect()
    }

    fn steer(scene: &mut Scene, view: ViewId, cmd: ViewportCommand) {
        apply(scene, ViewportCommand::SetActiveView { view });
        apply(scene, cmd);
    }

    /// `layout` with B moved into the second view where there is one, each
    /// view steered its own way, and the first view left active.
    fn laid_out(layout: ViewLayout, canvas: [u32; 2]) -> Scene {
        let mut scene = page(canvas, false);
        apply(&mut scene, ViewportCommand::SetViewLayout { layout });
        let views = view_ids(&scene);
        if layout == ViewLayout::Single {
            let datasets = ViewDatasets::Only(vec![id("b")]);
            let view = views[0];
            apply(
                &mut scene,
                ViewportCommand::SetViewDatasets { view, datasets },
            );
        } else if layout != ViewLayout::FourUp {
            let (view, dataset_id) = (views[1], id("b"));
            apply(
                &mut scene,
                ViewportCommand::MoveDatasetToView { view, dataset_id },
            );
        }
        let last = *views.last().unwrap();
        if layout != ViewLayout::FourUp {
            steer(&mut scene, last, ViewportCommand::SetMode3D);
            let (d_theta, d_phi) = (0.4, -0.2);
            steer(
                &mut scene,
                last,
                ViewportCommand::Rotate3D { d_theta, d_phi },
            );
        }
        steer(
            &mut scene,
            views[0],
            ViewportCommand::SetZoom { value: 3.0 },
        );
        steer(&mut scene, views[0], ViewportCommand::SetZ { z: 7 });
        scene
    }

    #[test]
    fn one_view_of_every_dataset_records_nothing() {
        let mut scene = page([800, 600], false);
        assert_eq!(scene.record_views(true), None);
        let view = scene.active_view().id();
        let datasets = ViewDatasets::Only(vec![id("a")]);
        apply(
            &mut scene,
            ViewportCommand::SetViewDatasets { view, datasets },
        );
        let record = scene
            .record_views(true)
            .expect("a view showing one dataset");
        assert_eq!(record.layout, ViewLayout::Single);
        assert_eq!(record.views[0].datasets, ViewDatasets::Only(vec![id("a")]));
    }

    #[test]
    fn every_preset_restores_as_it_was_recorded() {
        for layout in [
            ViewLayout::Single,
            ViewLayout::Columns,
            ViewLayout::Rows,
            ViewLayout::Grid,
            ViewLayout::FourUp,
        ] {
            let recorded = laid_out(layout, [800, 600])
                .record_views(true)
                .unwrap_or_else(|| panic!("{layout:?} records its views"));
            assert_eq!(recorded.layout, layout);
            let mut restored = page([800, 600], false);
            restored.import_views(Some(&recorded), None, true);
            assert_eq!(
                restored.record_views(true).as_ref(),
                Some(&recorded),
                "{layout:?}"
            );
        }
    }

    #[test]
    fn a_restore_on_a_canvas_of_twice_the_pixels_keeps_each_views_region() {
        let recorded = laid_out(ViewLayout::Columns, [800, 600])
            .record_views(true)
            .unwrap();
        let mut restored = page([1600, 1200], false);
        restored.import_views(Some(&recorded), None, true);
        let record = restored.record_views(true).unwrap();
        let (Camera::Slice(was), Camera::Slice(now)) =
            (&recorded.views[0].camera, &record.views[0].camera)
        else {
            panic!("the first view is a slice view");
        };
        assert_eq!(now.viewport, [800, 1200]);
        assert_eq!(now.center, was.center);
        assert_eq!(now.zoom, was.zoom * 2.0);
        assert_eq!(record.views[1].camera.viewport(), [800, 1200]);
        assert_eq!(record.links, recorded.links);
    }

    #[test]
    fn four_up_comes_back_crossing_at_one_point() {
        let recorded = laid_out(ViewLayout::FourUp, [800, 600])
            .record_views(true)
            .unwrap();
        let mut restored = page([800, 600], false);
        restored.import_views(Some(&recorded), None, true);
        let crossing = |scene: &Scene| {
            let axes: Vec<&AxisPositions> = scene.views().iter().map(|v| &v.axes).collect();
            axes.windows(2).all(|pair| pair[0] == pair[1])
        };
        assert!(crossing(&restored));
        // A move of one view's position moves them all.
        let xz = view_ids(&restored)[2];
        steer(&mut restored, xz, ViewportCommand::SetY { y: 3 });
        assert!(crossing(&restored));
    }

    #[test]
    fn links_come_back_with_their_modes_and_offsets() {
        // B beside A: pan and depth link relative by default.
        let mut scene = page([800, 600], true);
        let layout = ViewLayout::Columns;
        apply(&mut scene, ViewportCommand::SetViewLayout { layout });
        let views = view_ids(&scene);
        let (view, dataset_id) = (views[1], id("b"));
        apply(
            &mut scene,
            ViewportCommand::MoveDatasetToView { view, dataset_id },
        );
        steer(
            &mut scene,
            views[1],
            ViewportCommand::Pan { dx: 40.0, dy: 0.0 },
        );
        let (property, mode) = (LinkProperty::Zoom, LinkMode::Off);
        apply(&mut scene, ViewportCommand::SetViewLink { property, mode });
        let recorded = scene.record_views(true).unwrap();
        let links = recorded.links.as_ref().expect("the views link by a pair");
        assert_eq!(links.datasets, [id("a"), id("b")]);
        assert_eq!(links.modes.pan, LinkMode::Relative);
        assert_eq!(links.modes.zoom, LinkMode::Off);

        let mut restored = page([800, 600], true);
        restored.import_views(Some(&recorded), None, true);
        assert_eq!(restored.record_views(true), Some(recorded));
        // The offset they were saved at is the one a pan keeps.
        let first = view_ids(&restored)[0];
        let pan = ViewportCommand::Pan {
            dx: -25.0,
            dy: 10.0,
        };
        steer(&mut scene, views[0], pan.clone());
        steer(&mut restored, first, pan);
        assert_eq!(restored.views()[1].camera, scene.views()[1].camera);
    }

    /// A linked view that never stood anywhere but where the link left it
    /// comes back unplaced, as it was recorded.
    #[test]
    fn a_restore_moves_nothing_a_link_already_agrees_on() {
        let mut scene = page([800, 600], false);
        let layout = ViewLayout::Rows;
        apply(&mut scene, ViewportCommand::SetViewLayout { layout });
        let views = view_ids(&scene);
        let (view, dataset_id) = (views[1], id("b"));
        apply(
            &mut scene,
            ViewportCommand::MoveDatasetToView { view, dataset_id },
        );
        apply(
            &mut scene,
            ViewportCommand::SetActiveView { view: views[1] },
        );
        let recorded = scene.record_views(true).unwrap();
        assert_eq!(recorded.views[0].axes.z, None);
        let mut restored = page([800, 600], false);
        restored.import_views(Some(&recorded), None, true);
        assert_eq!(restored.record_views(true), Some(recorded));
    }

    #[test]
    fn links_recorded_for_another_pair_take_the_defaults() {
        let mut scene = laid_out(ViewLayout::Columns, [800, 600]);
        let (property, mode) = (LinkProperty::Pan, LinkMode::Off);
        apply(&mut scene, ViewportCommand::SetViewLink { property, mode });
        let mut recorded = scene.record_views(true).unwrap();
        recorded.links.as_mut().unwrap().datasets = [id("b"), id("a")];
        let mut restored = page([800, 600], false);
        restored.import_views(Some(&recorded), None, true);
        let links = restored.record_views(true).unwrap().links.unwrap();
        assert_eq!(links.datasets, [id("a"), id("b")]);
        assert_eq!(links.modes.pan, LinkMode::Linked);
    }

    #[test]
    fn a_comparison_comes_back_only_when_asked() {
        let mut scene = page([800, 600], false);
        scene.compare(id("a"), id("b"), CompareMode::Blink).unwrap();
        scene.flip_comparison();
        let recorded = scene.record_views(true).expect("one view comparing two");
        assert_eq!(scene.record_views(false), None);

        let mut restored = page([800, 600], false);
        restored.import_views(Some(&recorded), None, false);
        assert_eq!(restored.comparison(), None);
        assert_eq!(restored.record_views(true), None);
        restored.import_views(Some(&recorded), None, true);
        assert_eq!(restored.comparison(), scene.comparison());
        assert_eq!(restored.record_views(true), Some(recorded));
    }

    #[test]
    fn an_unchanged_record_imported_again_moves_no_epoch() {
        let recorded = laid_out(ViewLayout::Columns, [800, 600])
            .record_views(false)
            .unwrap();
        let mut restored = page([800, 600], false);
        restored.import_views(Some(&recorded), None, false);
        let epochs = restored.epochs.clone();
        restored.import_views(Some(&recorded), None, false);
        assert_eq!(restored.epochs, epochs);
        restored.import_views(None, None, false);
        assert_ne!(restored.epochs, epochs);
        let epochs = restored.epochs.clone();
        restored.import_views(None, None, false);
        assert_eq!(restored.epochs, epochs);
    }

    #[test]
    fn no_record_is_one_view_of_every_dataset() {
        let mut scene = laid_out(ViewLayout::Columns, [800, 600]);
        let second = view_ids(&scene)[1];
        apply(&mut scene, ViewportCommand::SetActiveView { view: second });
        scene.import_views(None, None, false);
        assert_eq!(scene.view_layout(), ViewLayout::Single);
        assert_eq!(view_ids(&scene), vec![second]);
        assert_eq!(scene.active_view().datasets, ViewDatasets::All);
        assert_eq!(scene.links(), None);
        assert_eq!(scene.record_views(true), None);
    }

    #[test]
    fn a_new_view_showing_nothing_restores_as_one() {
        let mut scene = page([800, 600], false);
        let layout = ViewLayout::Grid;
        apply(&mut scene, ViewportCommand::SetViewLayout { layout });
        let recorded = scene.record_views(true).unwrap();
        assert_eq!(recorded.views[3].datasets, ViewDatasets::Only(Vec::new()));
        assert_eq!(recorded.views[3].camera.framing(), Framing::Unframed);
        let mut restored = page([800, 600], false);
        restored.import_views(Some(&recorded), None, true);
        assert_eq!(restored.record_views(true), Some(recorded));
    }

    #[test]
    fn a_maximized_view_comes_back_alone_on_the_canvas_it_was_saved_on() {
        let recorded = laid_out(ViewLayout::Columns, [800, 600])
            .record_views(true)
            .unwrap();
        assert_eq!(recorded.canvas(), Some([800, 600]));
        let mut maximized = laid_out(ViewLayout::Grid, [800, 600]);
        let view = Some(view_ids(&maximized)[2]);
        apply(&mut maximized, ViewportCommand::MaximizeView { view });
        let recorded = maximized.record_views(true).unwrap();
        assert_eq!((recorded.active, recorded.maximized), (2, Some(2)));
        assert_eq!(recorded.canvas(), Some([800, 600]));
        let mut restored = page([800, 600], false);
        restored.import_views(Some(&recorded), None, true);
        assert_eq!(restored.record_views(true), Some(recorded));
    }

    #[test]
    fn remapping_ids_reaches_every_view_comparison_and_link() {
        let mut scene = laid_out(ViewLayout::Columns, [800, 600]);
        let first = view_ids(&scene)[0];
        let datasets = ViewDatasets::Only(vec![id("a"), id("b")]);
        apply(
            &mut scene,
            ViewportCommand::SetViewDatasets {
                view: first,
                datasets,
            },
        );
        scene.compare(id("a"), id("b"), CompareMode::Swipe).unwrap();
        let mut record = scene.record_views(true).unwrap();
        let remap = std::collections::HashMap::from([(id("b"), id("c"))]);
        record.remap_dataset_ids(&remap);
        assert_eq!(record.views[1].datasets, ViewDatasets::Only(vec![id("c")]));
        let comparison = record.views[0].comparison.as_ref().unwrap();
        assert_eq!((&comparison.a, &comparison.b), (&id("a"), &id("c")));
        assert_eq!(record.links.unwrap().datasets[1], id("c"));
    }
}
