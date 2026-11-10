//! What every view producer owes the user, checked for every fixture, viewport
//! and device pixel ratio:
//!
//! - the data is on screen, and fills at least about half of the limiting axis;
//! - its size in CSS pixels does not depend on the device pixel ratio;
//! - the chunk plan is not empty for anything the view query reports visible.
//!
//! A producer is anything that sets the camera without the user steering it:
//! open, join, restore, the 2D/3D switch, a pixel ratio change, guided
//! exploration, montage cells, the CLI overview. The checks measure the scene
//! a producer leaves behind, never the mechanism, so a producer is free to
//! change how it gets there.
//!
//! Compiled for this crate's tests and, through the `test-support` feature,
//! for other crates' tests, since the CLI's producers live in the CLI.

mod fixtures;
#[cfg(test)]
mod tests;

pub use fixtures::Fixture;

use std::fmt;

use lucida_content::DatasetId;

use crate::saved_view::SavedView;
use crate::scene::{DocumentState, Scene};

/// The least share of the limiting viewport axis a framed dataset fills.
pub const FILL_FLOOR: f64 = 0.5;

/// Slack, in device pixels, for a framed dataset's edges against the viewport.
const EDGE_SLACK_PX: f64 = 1.0;

/// How far two CSS sizes may differ, as a share of the larger, and still count
/// as the same size.
const CSS_SIZE_TOLERANCE: f64 = 0.01;

/// A canvas size in CSS pixels.
#[derive(Debug, Clone, Copy)]
pub struct Viewport {
    pub name: &'static str,
    pub css: [u32; 2],
}

impl Viewport {
    pub const LANDSCAPE: Viewport = Viewport {
        name: "landscape",
        css: [1280, 800],
    };
    pub const PORTRAIT: Viewport = Viewport {
        name: "portrait",
        css: [390, 844],
    };
    pub const ALL: [Viewport; 2] = [Self::LANDSCAPE, Self::PORTRAIT];

    /// The canvas in device pixels at `dpr`, the size the scene's camera holds.
    pub fn device(&self, dpr: u32) -> [u32; 2] {
        [self.css[0] * dpr, self.css[1] * dpr]
    }
}

/// The device pixel ratios every producer runs at.
pub const PIXEL_RATIOS: [u32; 2] = [1, 2];

/// A scene showing the view a producer left, and the pixel ratio of the
/// canvas showing it.
#[derive(Debug, Clone)]
pub struct Shown {
    pub scene: Scene,
    pub dpr: u32,
}

/// What a produced view owes on screen.
#[derive(Debug, Clone, Copy)]
pub enum Expect {
    /// The whole dataset in view, filling at least this share of the limiting
    /// axis.
    Framed(f64),
    /// Zoomed in past the whole dataset, which then covers the screen.
    Covers,
    /// The whole dataset in view, at any size.
    Inside,
}

/// One view a producer left, labelled so the same view at the other pixel
/// ratio can be paired with it.
pub struct Produced {
    pub label: String,
    pub shown: Shown,
    pub expect: Expect,
}

impl Produced {
    /// A view that frames the whole dataset.
    pub fn framing(label: impl Into<String>, shown: Shown) -> Self {
        Self {
            label: label.into(),
            shown,
            expect: Expect::Framed(FILL_FLOOR),
        }
    }
}

/// A page that joins once the dataset is open: the document arrives in the
/// workspace snapshot, and no client asked this page to fit anything.
pub fn join(f: &Fixture, vp: Viewport, dpr: u32) -> Shown {
    let mut scene = Scene::new(vp.device(dpr));
    let mut document = DocumentState::default();
    document.register_dataset(f.opened.manifest.clone());
    scene.load_document(document);
    Shown { scene, dpr }
}

/// The camera, selection and display of `scene`, as a saved view records them.
pub fn capture(scene: &Scene) -> SavedView {
    let mut view = SavedView::empty(scene.camera.viewport());
    view.camera = scene.camera.clone();
    view.view = scene.view.clone();
    view.display = scene.display.clone();
    view.camera_space = scene.camera_space();
    view
}

/// A page at `vp` and `dpr` showing `view`. Saved views, the last view, pins,
/// follow, and explore and montage links all reach the scene through
/// `import_presence`, a stored view's camera carried into the page's spaces.
pub fn restore(view: &SavedView, f: &Fixture, vp: Viewport, dpr: u32) -> Shown {
    let mut shown = join(f, vp, dpr);
    let camera = view.camera_in(&shown.scene);
    shown
        .scene
        .import_presence(camera, view.view.clone(), view.display.clone());
    shown
}

/// A producer: the views it leaves for one fixture on one canvas.
pub trait Produce: Fn(&Fixture, Viewport, u32) -> Vec<Produced> {}
impl<T: Fn(&Fixture, Viewport, u32) -> Vec<Produced>> Produce for T {}

fn case(f: &Fixture, vp: Viewport, dpr: u32, label: &str) -> String {
    format!("{} on {} {dpr}x, {label}", f.name, vp.name)
}

/// The dataset is on screen at a reasonable size in every view `produce`
/// leaves, for every fixture and viewport at the given pixel ratios.
pub fn assert_on_screen(property: &str, ratios: &[u32], produce: impl Produce) {
    let mut report = Report::new(property);
    for f in Fixture::all() {
        for vp in Viewport::ALL {
            for &dpr in ratios {
                for p in produce(&f, vp, dpr) {
                    let outcome = match p.expect {
                        Expect::Framed(floor) => framed(&p.shown, &f.id(), floor),
                        Expect::Covers => covers(&p.shown, &f.id()),
                        Expect::Inside => framed(&p.shown, &f.id(), 0.0),
                    };
                    report.check(case(&f, vp, dpr, &p.label), outcome);
                }
            }
        }
    }
    report.assert_holds();
}

/// Each view `produce` leaves shows the dataset at the same CSS size at pixel
/// ratio 1 and 2.
pub fn assert_same_css_size(property: &str, produce: impl Produce) {
    let mut report = Report::new(property);
    for f in Fixture::all() {
        for vp in Viewport::ALL {
            let at_2x = produce(&f, vp, 2);
            for a in produce(&f, vp, 1) {
                let b = at_2x
                    .iter()
                    .find(|b| b.label == a.label)
                    .unwrap_or_else(|| panic!("{} has no 2x twin", a.label));
                report.check(
                    format!("{} on {}, {}", f.name, vp.name, a.label),
                    same_css_size(&a.shown, &b.shown, &f.id()),
                );
            }
        }
    }
    report.assert_holds();
}

/// Every view `produce` leaves plans chunks for what the view query reports
/// visible, for every fixture, viewport and pixel ratio.
pub fn assert_plans(property: &str, produce: impl Produce) {
    let mut report = Report::new(property);
    for f in Fixture::all() {
        for vp in Viewport::ALL {
            for dpr in PIXEL_RATIOS {
                for p in produce(&f, vp, dpr) {
                    report.check(
                        case(&f, vp, dpr, &p.label),
                        plans_what_is_visible(&p.shown, &f.id()),
                    );
                }
            }
        }
    }
    report.assert_holds();
}

/// An axis-aligned box on screen, in device pixels.
#[derive(Debug, Clone, Copy, PartialEq)]
struct ScreenRect {
    min: [f64; 2],
    max: [f64; 2],
}

impl ScreenRect {
    fn size(&self) -> [f64; 2] {
        [self.max[0] - self.min[0], self.max[1] - self.min[1]]
    }
}

impl fmt::Display for ScreenRect {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(
            f,
            "[{:.0}, {:.0}]..[{:.0}, {:.0}]",
            self.min[0], self.min[1], self.max[0], self.max[1]
        )
    }
}

/// Where the dataset's bounding box lands on screen: every corner of
/// [`Scene::dataset_fit_bounds`] through the active camera.
fn screen_rect(shown: &Shown, id: &DatasetId) -> Result<ScreenRect, String> {
    let scene = &shown.scene;
    let (lo, hi) = scene
        .dataset_fit_bounds(&id.0)
        .ok_or("the dataset has no bounds")?;
    let mut rect = ScreenRect {
        min: [f64::INFINITY; 2],
        max: [f64::NEG_INFINITY; 2],
    };
    for corner in 0..8 {
        let pick = |axis: usize| {
            if corner >> axis & 1 == 1 {
                hi[axis]
            } else {
                lo[axis]
            }
        };
        let [x, y] = scene
            .camera
            .project_to_screen([pick(0), pick(1), pick(2)])
            .ok_or("part of the dataset is behind the camera")?;
        rect.min = [rect.min[0].min(x), rect.min[1].min(y)];
        rect.max = [rect.max[0].max(x), rect.max[1].max(y)];
    }
    Ok(rect)
}

/// The largest share of a viewport axis `size` spans.
fn fill(size: [f64; 2], viewport: [u32; 2]) -> f64 {
    (size[0] / viewport[0] as f64).max(size[1] / viewport[1] as f64)
}

/// The whole dataset is inside the viewport and fills at least `floor` of the
/// limiting axis.
fn framed(shown: &Shown, id: &DatasetId, floor: f64) -> Result<(), String> {
    let vp = shown.scene.camera.viewport();
    let rect = screen_rect(shown, id)?;
    let inside = rect.min[0] >= -EDGE_SLACK_PX
        && rect.min[1] >= -EDGE_SLACK_PX
        && rect.max[0] <= vp[0] as f64 + EDGE_SLACK_PX
        && rect.max[1] <= vp[1] as f64 + EDGE_SLACK_PX;
    if !inside {
        return Err(format!(
            "clipped: the dataset spans {rect} in a {}x{} viewport",
            vp[0], vp[1]
        ));
    }
    let share = fill(rect.size(), vp);
    if share < floor {
        return Err(format!(
            "too small: the dataset fills {share:.2} of the limiting axis, under {floor:.2}"
        ));
    }
    Ok(())
}

/// The part of the dataset inside the viewport fills at least [`FILL_FLOOR`]
/// of the limiting axis.
fn covers(shown: &Shown, id: &DatasetId) -> Result<(), String> {
    let vp = shown.scene.camera.viewport();
    let rect = screen_rect(shown, id)?;
    let visible = [
        (rect.max[0].min(vp[0] as f64) - rect.min[0].max(0.0)).max(0.0),
        (rect.max[1].min(vp[1] as f64) - rect.min[1].max(0.0)).max(0.0),
    ];
    let share = fill(visible, vp);
    if share < FILL_FLOOR || visible[0] == 0.0 || visible[1] == 0.0 {
        return Err(format!(
            "off screen: the dataset spans {rect} in a {}x{} viewport, filling {share:.2}",
            vp[0], vp[1]
        ));
    }
    Ok(())
}

/// The dataset shows at the same size in CSS pixels in both scenes.
fn same_css_size(a: &Shown, b: &Shown, id: &DatasetId) -> Result<(), String> {
    let css = |shown: &Shown| -> Result<[f64; 2], String> {
        let [w, h] = screen_rect(shown, id)?.size();
        Ok([w / shown.dpr as f64, h / shown.dpr as f64])
    };
    let (sa, sb) = (css(a)?, css(b)?);
    let differs = (0..2).any(|axis| {
        let larger = sa[axis].abs().max(sb[axis].abs()).max(f64::MIN_POSITIVE);
        (sa[axis] - sb[axis]).abs() / larger > CSS_SIZE_TOLERANCE
    });
    if differs {
        return Err(format!(
            "{:.0}x{:.0} CSS px at {}x, {:.0}x{:.0} CSS px at {}x",
            sa[0], sa[1], a.dpr, sb[0], sb[1], b.dpr
        ));
    }
    Ok(())
}

/// Every entity the view query reports visible has chunks in the plan.
fn plans_what_is_visible(shown: &Shown, id: &DatasetId) -> Result<(), String> {
    let scene = &shown.scene;
    let query = scene
        .view_query(id)
        .ok_or("the view query does not know the dataset")?;
    let plans = scene
        .chunk_plan_for(id)
        .ok_or("the chunk plan does not know the dataset")?;
    let unplanned: Vec<String> = query
        .visible_entities
        .iter()
        .filter(|entity| entity.visible)
        .filter(|entity| {
            !plans
                .iter()
                .any(|plan| plan.image_id == entity.image_id && !plan.needed.is_empty())
        })
        .map(|entity| format!("{} at level {}", entity.image_id.0, entity.target_level))
        .collect();
    if !unplanned.is_empty() {
        return Err(format!(
            "visible but no chunks planned: {}",
            unplanned.join(", ")
        ));
    }
    Ok(())
}

/// The outcome of one property over many cases. It fails once, naming every
/// case that broke the property, so one run shows the whole extent of a
/// defect instead of its first instance.
struct Report {
    property: String,
    cases: usize,
    failures: Vec<String>,
}

impl Report {
    fn new(property: &str) -> Self {
        Self {
            property: property.to_string(),
            cases: 0,
            failures: Vec::new(),
        }
    }

    fn check(&mut self, case: String, outcome: Result<(), String>) {
        self.cases += 1;
        if let Err(reason) = outcome {
            self.failures.push(format!("{case}: {reason}"));
        }
    }

    fn assert_holds(&self) {
        assert!(self.cases > 0, "{}: no cases ran", self.property);
        assert!(
            self.failures.is_empty(),
            "{} fails in {} of {} cases:\n  {}",
            self.property,
            self.failures.len(),
            self.cases,
            self.failures.join("\n  ")
        );
    }
}
