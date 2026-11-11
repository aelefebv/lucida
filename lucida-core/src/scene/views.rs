//! How a scene's views share the canvas and the datasets: the layout that
//! divides the canvas among them, the view commands steer, and which
//! datasets each shows.

use lucida_content::DatasetId;

use super::Scene;
use crate::camera::Camera;
use crate::view::{View, ViewDatasets, ViewId, ViewLayout, ViewRect};

impl Scene {
    pub fn view_layout(&self) -> ViewLayout {
        self.layout
    }

    /// Divide the canvas as `layout` does. A view the layout adds starts
    /// showing nothing, at the next id the scene has not used. A layout of
    /// fewer views keeps the active one and drops the others from the end.
    /// Four-up then gives each view its part, fitted.
    pub(crate) fn set_view_layout(&mut self, layout: ViewLayout) {
        let entering_four_up = layout == ViewLayout::FourUp && self.layout != layout;
        let rects = layout.rects();
        while self.views.len() > rects.len() {
            let drop = self
                .views
                .iter()
                .rposition(|view| view.id() != self.active)
                .expect("a layout holds at least the active view");
            self.views.remove(drop);
        }
        while self.views.len() < rects.len() {
            let id = ViewId(self.next_view_id);
            self.next_view_id += 1;
            let rect = rects[self.views.len()];
            self.views.push(View::empty(id, rect, self.canvas));
        }
        self.layout = layout;
        self.maximized = None;
        if entering_four_up {
            self.arrange_four_up();
        }
        let ids: Vec<ViewId> = self.views.iter().map(View::id).collect();
        self.view_query_cursors
            .retain(|(view, _), _| ids.contains(view));
        self.arrange();
        if entering_four_up {
            self.reframe_all();
            self.align_four_up();
        }
    }

    /// Give each view its rectangle: the layout's, or the whole canvas for a
    /// maximized view. A placed camera keeps the region it showed in its new
    /// rectangle, and one whose pose is the fit or a stand-in fits again.
    fn arrange(&mut self) {
        let rects = self.layout.rects();
        let canvas = self.canvas;
        let maximized = self.maximized;
        let mut resized = Vec::new();
        for (view, rect) in self.views.iter_mut().zip(rects) {
            let rect = if maximized == Some(view.id()) {
                ViewRect::WHOLE
            } else {
                rect
            };
            view.rect = rect;
            let before = view.camera.clone();
            view.keep_region_at(rect.size_on(canvas));
            if view.camera != before {
                resized.push(view.id());
            }
        }
        for id in resized {
            self.reframe(id);
        }
    }

    /// Show `view` alone across the canvas, or every view again with `None`.
    /// The others keep what they show, but while hidden they are neither
    /// drawn nor planned and hold no dataset's pools. A view the scene
    /// doesn't hold, or a layout of one view, changes nothing.
    pub(crate) fn set_maximized(&mut self, view: Option<ViewId>) {
        if view.is_some_and(|id| self.view(id).is_none() || self.views.len() < 2) {
            return;
        }
        self.maximized = view;
        if let Some(id) = view {
            self.active = id;
        }
        self.arrange();
    }

    /// The view shown alone across the canvas, if one is.
    pub fn maximized_view(&self) -> Option<ViewId> {
        self.maximized
    }

    /// Whether `view` is on the canvas: every view is, unless another is
    /// maximized.
    pub fn is_shown(&self, view: ViewId) -> bool {
        self.maximized.is_none_or(|id| id == view)
    }

    /// The views on the canvas, in the layout's order.
    pub fn shown_views(&self) -> impl Iterator<Item = &View> {
        self.views.iter().filter(|view| self.is_shown(view.id()))
    }

    /// Show `dataset_id` in `view` and in no other view, as a layer dropped
    /// on a view moves there. A view that showed every dataset keeps the
    /// others. Each view whose datasets changed fits them when its pose is
    /// the fit or a stand-in.
    pub(crate) fn move_dataset_to_view(&mut self, view: ViewId, dataset_id: &DatasetId) {
        if self.view(view).is_none() || !self.document.manifests.contains_key(dataset_id) {
            return;
        }
        let all = self.dataset_order.clone();
        let mut changed = Vec::new();
        for shown in &mut self.views {
            let before = shown.datasets.clone();
            if shown.id() == view {
                if let ViewDatasets::Only(ids) = &mut shown.datasets
                    && !ids.contains(dataset_id)
                {
                    ids.push(dataset_id.clone());
                }
            } else {
                let mut ids = match &shown.datasets {
                    ViewDatasets::All => all.clone(),
                    ViewDatasets::Only(ids) => ids.clone(),
                };
                ids.retain(|id| id != dataset_id);
                shown.datasets = ViewDatasets::Only(ids);
            }
            if shown.datasets != before {
                changed.push(shown.id());
            }
        }
        for id in changed {
            self.reframe(id);
        }
    }

    /// The cameras of every view but the active one, in order.
    pub(crate) fn other_cameras(&self) -> Vec<Camera> {
        let active = self.active_view().id();
        self.views
            .iter()
            .filter(|view| view.id() != active)
            .map(|view| view.camera.clone())
            .collect()
    }

    /// Make `view` the one commands steer. An unknown view changes nothing.
    pub(crate) fn set_active_view(&mut self, view: ViewId) {
        if self.view(view).is_some() {
            self.active = view;
        }
    }

    /// Show `datasets` in `view`, which fits them when its pose is the fit or
    /// a stand-in, as an opened dataset is fitted. An unknown view changes
    /// nothing.
    pub(crate) fn set_view_datasets(&mut self, view: ViewId, datasets: ViewDatasets) {
        let Some(shown) = self.view_mut(view) else {
            return;
        };
        shown.datasets = datasets;
        self.reframe(view);
    }

    /// Whether `view` draws `dataset_id`: it shows the dataset. Views of one
    /// dataset share its GPU pools, each through indirection of its own, so
    /// each draws it at its own cut and timepoint.
    pub fn draws(&self, view: ViewId, dataset_id: &DatasetId) -> bool {
        self.view(view).is_some_and(|v| v.shows(dataset_id))
    }
}

#[cfg(test)]
mod tests {
    use lucida_content::DatasetId;

    use super::super::test_helpers::{make_dataset_opened_with_shape, unlink};
    use super::*;
    use crate::command::{Command, DocumentCommand, ViewportCommand};
    use crate::view::ViewRect;

    fn open(scene: &mut Scene, id: &str) {
        let opened =
            make_dataset_opened_with_shape(id, id, 1, [2, 1, 8, 64, 64], [1, 1, 4, 64, 64], 1);
        scene.apply(DocumentCommand::DatasetOpened(opened).into());
    }

    fn apply(scene: &mut Scene, cmd: ViewportCommand) {
        scene.apply(Command::Viewport(cmd));
    }

    fn id(name: &str) -> DatasetId {
        DatasetId::from(name)
    }

    fn layout(scene: &mut Scene, layout: ViewLayout) {
        apply(scene, ViewportCommand::SetViewLayout { layout });
    }

    /// Two datasets on an 800x600 canvas, split into two columns.
    fn split() -> Scene {
        let mut scene = Scene::new([800, 600]);
        open(&mut scene, "a");
        open(&mut scene, "b");
        layout(&mut scene, ViewLayout::Columns);
        scene
    }

    fn show(scene: &mut Scene, view: ViewId, names: &[&str]) {
        let datasets = ViewDatasets::Only(names.iter().map(|name| id(name)).collect());
        apply(scene, ViewportCommand::SetViewDatasets { view, datasets });
    }

    fn both(scene: &Scene) -> [ViewId; 2] {
        [scene.views()[0].id(), scene.views()[1].id()]
    }

    #[test]
    fn a_layout_divides_the_canvas_and_sizes_each_camera_to_its_part() {
        let scene = split();
        let views = scene.views();
        assert_eq!(views.len(), 2);
        assert_eq!(views[0].rect, ViewLayout::Columns.rects()[0]);
        assert_eq!(views[1].rect.x, 0.5);
        assert_eq!(views[0].camera.viewport(), [400, 600]);
        assert_eq!(views[1].camera.viewport(), [400, 600]);
        // The view the layout adds shows nothing yet.
        assert_eq!(views[1].datasets, ViewDatasets::Only(Vec::new()));
        assert!(scene.resolved_layers(views[1].id()).is_empty());
    }

    #[test]
    fn a_placed_view_keeps_its_region_through_a_split_and_back() {
        let mut scene = Scene::new([800, 600]);
        open(&mut scene, "a");
        apply(&mut scene, ViewportCommand::SetZoom { value: 2.0 });
        let slice = |scene: &Scene| match &scene.active_view().camera {
            Camera::Slice(slice) => (slice.zoom, slice.center),
            _ => panic!("a slice camera"),
        };
        let (_, center) = slice(&scene);
        layout(&mut scene, ViewLayout::Columns);
        // Half as wide, so the region shows at half the zoom, around the same center.
        assert_eq!(slice(&scene), (1.0, center));
        // Back across the canvas it shows what it showed before the split,
        // however often the layout changes.
        for _ in 0..3 {
            layout(&mut scene, ViewLayout::Single);
            assert_eq!(slice(&scene), (2.0, center));
            layout(&mut scene, ViewLayout::Columns);
        }
        // A steer in the split is the region to keep from then on.
        apply(&mut scene, ViewportCommand::SetZoom { value: 3.0 });
        layout(&mut scene, ViewLayout::Single);
        assert_eq!(slice(&scene).0, 3.0);
    }

    #[test]
    fn a_resize_sizes_every_view_to_its_part() {
        let mut scene = split();
        let resize = ViewportCommand::SetViewport {
            width: 1000,
            height: 500,
            pixel_ratio: None,
        };
        apply(&mut scene, resize);
        let sizes: Vec<[u32; 2]> = scene.views().iter().map(|v| v.camera.viewport()).collect();
        assert_eq!(sizes, vec![[500, 500]; 2]);
        layout(&mut scene, ViewLayout::Rows);
        let sizes: Vec<[u32; 2]> = scene.views().iter().map(|v| v.camera.viewport()).collect();
        assert_eq!(sizes, vec![[1000, 250]; 2]);
    }

    #[test]
    fn one_view_again_keeps_the_active_view_and_never_reuses_an_id() {
        let mut scene = split();
        let [_, second] = both(&scene);
        apply(&mut scene, ViewportCommand::SetActiveView { view: second });
        assert_eq!(scene.active_view().id(), second);
        layout(&mut scene, ViewLayout::Single);
        assert_eq!(scene.views().len(), 1);
        assert_eq!(scene.active_view().id(), second);
        assert_eq!(scene.active_view().rect, ViewRect::WHOLE);
        layout(&mut scene, ViewLayout::Columns);
        let ids: Vec<ViewId> = scene.views().iter().map(View::id).collect();
        assert_eq!(ids, vec![second, ViewId(2)]);
    }

    #[test]
    fn commands_steer_the_active_view_alone() {
        let mut scene = split();
        let [first, second] = both(&scene);
        show(&mut scene, second, &["b"]);
        unlink(&mut scene);
        let before = scene.view(first).unwrap().camera.clone();
        apply(&mut scene, ViewportCommand::SetActiveView { view: second });
        let moved = scene.view(second).unwrap().camera.clone();
        apply(&mut scene, ViewportCommand::Pan { dx: 30.0, dy: 0.0 });
        assert_eq!(scene.view(first).unwrap().camera, before);
        assert_ne!(scene.view(second).unwrap().camera, moved);
    }

    #[test]
    fn a_view_fits_the_datasets_it_is_shown() {
        let mut scene = split();
        let [_, second] = both(&scene);
        let before = scene.view(second).unwrap().camera.clone();
        show(&mut scene, second, &["b"]);
        let camera = &scene.view(second).unwrap().camera;
        assert_ne!(*camera, before);
        assert_eq!(camera.framing(), crate::camera::Framing::Framed);
    }

    #[test]
    fn views_of_different_datasets_each_draw_their_own() {
        let mut scene = split();
        let [first, second] = both(&scene);
        show(&mut scene, first, &["a"]);
        show(&mut scene, second, &["b"]);
        assert!(scene.draws(first, &id("a")) && !scene.draws(first, &id("b")));
        assert!(scene.draws(second, &id("b")) && !scene.draws(second, &id("a")));
        assert!(scene.view_query(first, &id("b")).is_none());
        assert!(scene.view_query(second, &id("b")).is_some());
    }

    #[test]
    fn views_of_one_dataset_each_draw_it_at_their_own_cut_and_timepoint() {
        let mut scene = split();
        let [first, second] = both(&scene);
        show(&mut scene, second, &["a"]);
        unlink(&mut scene);
        // Another Z in the second view, then another timepoint in 3D.
        apply(&mut scene, ViewportCommand::SetActiveView { view: second });
        apply(&mut scene, ViewportCommand::SetZ { z: 5 });
        assert!(scene.draws(first, &id("a")) && scene.draws(second, &id("a")));
        assert!(scene.view_query(second, &id("a")).is_some());
        apply(&mut scene, ViewportCommand::SetMode3D);
        apply(&mut scene, ViewportCommand::SetT { t: 1 });
        apply(&mut scene, ViewportCommand::SetActiveView { view: first });
        apply(&mut scene, ViewportCommand::SetMode3D);
        assert!(scene.draws(first, &id("a")) && scene.draws(second, &id("a")));
        assert!(scene.view_query(first, &id("a")).is_some());
        assert!(scene.view_query(second, &id("a")).is_some());
    }

    #[test]
    fn a_dataset_moved_into_a_view_leaves_the_others() {
        let mut scene = split();
        let [first, second] = both(&scene);
        let moved = ViewportCommand::MoveDatasetToView {
            view: second,
            dataset_id: id("b"),
        };
        apply(&mut scene, moved);
        assert_eq!(
            scene.view(first).unwrap().datasets,
            ViewDatasets::Only(vec![id("a")])
        );
        assert_eq!(
            scene.view(second).unwrap().datasets,
            ViewDatasets::Only(vec![id("b")])
        );
        assert!(scene.draws(second, &id("b")) && !scene.draws(first, &id("b")));
    }

    #[test]
    fn a_maximized_view_takes_the_canvas_and_the_others_keep_what_they_show() {
        let mut scene = split();
        let [first, second] = both(&scene);
        show(&mut scene, second, &["a"]);

        let maximize = |view| ViewportCommand::MaximizeView { view };
        apply(&mut scene, maximize(Some(second)));
        let shown: Vec<ViewId> = scene.shown_views().map(View::id).collect();
        assert_eq!(shown, vec![second]);
        assert_eq!(scene.active_view().id(), second);
        assert_eq!(scene.view(second).unwrap().camera.viewport(), [800, 600]);
        assert!(scene.draws(second, &id("a")));
        assert!(scene.view(first).unwrap().shows(&id("a")));

        apply(&mut scene, maximize(None));
        assert_eq!(scene.shown_views().count(), 2);
        assert_eq!(scene.view(second).unwrap().camera.viewport(), [400, 600]);
        // A layout change shows every view again.
        apply(&mut scene, maximize(Some(first)));
        layout(&mut scene, ViewLayout::Rows);
        assert_eq!(scene.maximized_view(), None);
    }

    #[test]
    fn one_view_draws_everything_it_shows() {
        let mut scene = Scene::new([800, 600]);
        open(&mut scene, "a");
        let only = scene.active_view().id();
        assert!(scene.draws(only, &id("a")));
        assert_eq!(scene.resolved_layers(only).len(), 1);
    }
}
