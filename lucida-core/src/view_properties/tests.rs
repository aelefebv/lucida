//! The view producers that live in this crate, checked against every
//! property. A test marked `ignore` names behavior that breaks its property
//! today; it runs with `cargo test -- --ignored` and comes off the list when
//! the behavior is fixed.

use super::*;
use crate::camera::Camera;
use crate::command::{Command, DocumentCommand, ViewportCommand};
use crate::view_transform::{ExplorationSidecar, ViewExtent, children, home_view};

#[derive(Debug, Clone, Copy, PartialEq)]
enum Mode {
    Slice,
    Arcball,
}

/// The opener's page: the dataset opens on a page in either mode.
fn open(f: &Fixture, vp: Viewport, dpr: u32, mode: Mode) -> Shown {
    let mut scene = Scene::new(vp.device(dpr));
    if mode == Mode::Arcball {
        scene.apply(ViewportCommand::SetMode3D.into());
    }
    scene.apply(Command::Document(DocumentCommand::DatasetOpened(
        f.opened.clone(),
    )));
    Shown { scene, dpr }
}

/// A view saved on the opener's canvas `src` at `src_dpr`, restored on a page
/// at `vp` and `dpr`.
fn restored(
    f: &Fixture,
    mode: Mode,
    src: Viewport,
    src_dpr: u32,
    vp: Viewport,
    dpr: u32,
) -> Produced {
    let view = capture(&open(f, src, src_dpr, mode).scene);
    Produced::framing(
        format!("{mode:?} saved on {} {src_dpr}x", src.name),
        restore(&view, f, vp, dpr),
    )
}

fn other(vp: Viewport) -> Viewport {
    if vp.name == Viewport::LANDSCAPE.name {
        Viewport::PORTRAIT
    } else {
        Viewport::LANDSCAPE
    }
}

fn other_ratio(dpr: u32) -> u32 {
    if dpr == 1 { 2 } else { 1 }
}

/// What a guided-exploration cell owes, by the move that made it. A zoom out
/// halves its parent, and a rotation keeps a fitted view's bounding sphere in
/// view but can turn flat data toward edge-on, so both may show the dataset
/// at half the framing floor. A zoom in crops.
fn expect_for(transform: &str) -> Expect {
    if transform == "zoom:in" {
        Expect::Covers
    } else if transform == "zoom:out"
        || transform.starts_with("azimuth:")
        || transform.starts_with("elevation:")
    {
        Expect::Framed(FILL_FLOOR / 2.0)
    } else {
        Expect::Framed(FILL_FLOOR)
    }
}

/// The synthesized Home and its children, as `lucida dataset explore` builds
/// them on a headless window the size of `vp` and a page then opens them.
fn explore_home(f: &Fixture, vp: Viewport, dpr: u32) -> Vec<Produced> {
    let cli = join(f, vp, 1).scene;
    let home = home_view(&cli, &f.id(), vp.css).unwrap();
    let extent = ViewExtent::of(&cli, &f.id()).unwrap();
    let mut out = vec![Produced::framing("home", restore(&home, f, vp, dpr))];
    for child in children(&home, &extent) {
        out.push(Produced {
            label: format!("home > {}", child.transform),
            shown: restore(&child.view, f, vp, dpr),
            expect: expect_for(&child.transform),
        });
    }
    out
}

/// The viewer's Explore panel over its live view: the generator reads the
/// extent off the live scene, and the page applies the cell the user picks.
fn explore_live(f: &Fixture, vp: Viewport, dpr: u32) -> Vec<Produced> {
    let mut out = Vec::new();
    for mode in [Mode::Slice, Mode::Arcball] {
        let live = open(f, vp, dpr, mode);
        let extent = ViewExtent::of(&live.scene, &f.id()).unwrap();
        let sidecar = ExplorationSidecar::build(&capture(&live.scene), &extent, 0, Vec::new());
        out.extend(sidecar.cells.iter().map(|cell| Produced {
            label: format!("{mode:?} > {}", cell.transform),
            shown: restore(&cell.view, f, vp, dpr),
            expect: expect_for(&cell.transform),
        }));
    }
    out
}

fn switched(f: &Fixture, vp: Viewport, dpr: u32, from: Mode) -> Shown {
    let mut shown = open(f, vp, dpr, from);
    let to = match from {
        Mode::Slice => ViewportCommand::SetMode3D,
        Mode::Arcball => ViewportCommand::SetMode2D,
    };
    shown.scene.apply(to.into());
    shown
}

fn opened(f: &Fixture, vp: Viewport, dpr: u32) -> Vec<Produced> {
    vec![
        Produced::framing("slice", open(f, vp, dpr, Mode::Slice)),
        Produced::framing("arcball", open(f, vp, dpr, Mode::Arcball)),
    ]
}

#[test]
fn open_frames_the_dataset() {
    assert_on_screen("open frames the dataset", &PIXEL_RATIOS, opened);
}

#[test]
fn open_shows_the_same_css_size_at_any_pixel_ratio() {
    assert_same_css_size("open shows the same CSS size", opened);
}

#[test]
fn open_plans_what_is_visible() {
    assert_plans("open plans what is visible", opened);
}

/// The opener's page once its canvas moved to `dpr` from the other pixel
/// ratio, as dragging the window to another display or zooming the browser
/// does. The render loop names the ratio with every size it asserts.
fn ratio_changed(f: &Fixture, vp: Viewport, dpr: u32) -> Vec<Produced> {
    let from = other_ratio(dpr);
    [Mode::Slice, Mode::Arcball]
        .map(|mode| {
            let mut shown = open(f, vp, from, mode);
            for ratio in [from, dpr] {
                let [width, height] = vp.device(ratio);
                shown.scene.apply(
                    ViewportCommand::SetViewport {
                        width,
                        height,
                        pixel_ratio: Some(ratio.into()),
                    }
                    .into(),
                );
            }
            shown.dpr = dpr;
            Produced::framing(format!("{mode:?} after a ratio change"), shown)
        })
        .into()
}

#[test]
fn a_pixel_ratio_change_keeps_the_dataset_framed() {
    assert_on_screen(
        "a pixel ratio change keeps the dataset framed",
        &PIXEL_RATIOS,
        ratio_changed,
    );
}

#[test]
fn a_pixel_ratio_change_keeps_the_css_size() {
    assert_same_css_size("a pixel ratio change keeps the CSS size", ratio_changed);
}

fn joined(f: &Fixture, vp: Viewport, dpr: u32) -> Vec<Produced> {
    vec![Produced::framing("joined", join(f, vp, dpr))]
}

#[test]
fn join_frames_the_dataset() {
    assert_on_screen("join frames the dataset", &PIXEL_RATIOS, joined);
}

#[test]
fn join_shows_the_same_css_size_at_any_pixel_ratio() {
    assert_same_css_size("join shows the same CSS size", joined);
}

#[test]
fn join_plans_what_is_visible() {
    assert_plans("join plans what is visible", joined);
}

#[test]
fn restore_frames_a_view_on_the_canvas_it_was_saved_on() {
    assert_on_screen(
        "restore frames a view on its own canvas",
        &PIXEL_RATIOS,
        |f, vp, dpr| {
            [Mode::Slice, Mode::Arcball]
                .map(|mode| restored(f, mode, vp, dpr, vp, dpr))
                .into()
        },
    );
}

#[test]
fn restore_frames_an_arcball_view_at_another_pixel_ratio() {
    assert_on_screen(
        "restore frames an arcball view at another pixel ratio",
        &PIXEL_RATIOS,
        |f, vp, dpr| vec![restored(f, Mode::Arcball, vp, other_ratio(dpr), vp, dpr)],
    );
}

#[test]
fn restore_frames_a_slice_view_at_another_pixel_ratio() {
    assert_on_screen(
        "restore frames a slice view at another pixel ratio",
        &PIXEL_RATIOS,
        |f, vp, dpr| vec![restored(f, Mode::Slice, vp, other_ratio(dpr), vp, dpr)],
    );
}

/// The opener's view after a person nudged it by a pixel, which makes it
/// theirs rather than the fit.
fn nudged(f: &Fixture, vp: Viewport, dpr: u32, mode: Mode) -> Shown {
    let mut shown = open(f, vp, dpr, mode);
    let nudge = match mode {
        Mode::Slice => ViewportCommand::Pan { dx: 1.0, dy: 0.0 },
        Mode::Arcball => ViewportCommand::Pan3D { dx: 1.0, dy: 0.0 },
    };
    shown.scene.apply(nudge.into());
    assert_eq!(shown.scene.camera.framing(), crate::camera::Framing::Placed);
    shown
}

/// A view someone placed keeps the whole region it showed on a canvas of
/// another shape, so the dataset it framed stays in view however small that
/// leaves it.
#[test]
fn restore_keeps_a_placed_view_in_view_on_another_canvas_shape() {
    assert_on_screen(
        "restore keeps a placed view in view on another canvas shape",
        &PIXEL_RATIOS,
        |f, vp, dpr| {
            [Mode::Slice, Mode::Arcball]
                .map(|mode| Produced {
                    label: format!("{mode:?} placed on {} {dpr}x", other(vp).name),
                    shown: restore(&capture(&nudged(f, other(vp), dpr, mode).scene), f, vp, dpr),
                    expect: Expect::Inside,
                })
                .into()
        },
    );
}

#[test]
fn restore_frames_a_view_on_another_canvas_shape() {
    assert_on_screen(
        "restore frames a view on another canvas shape",
        &PIXEL_RATIOS,
        |f, vp, dpr| {
            [Mode::Slice, Mode::Arcball]
                .map(|mode| restored(f, mode, other(vp), dpr, vp, dpr))
                .into()
        },
    );
}

fn restored_from_everywhere(mode: Mode) -> impl Fn(&Fixture, Viewport, u32) -> Vec<Produced> {
    move |f, vp, dpr| {
        let mut out = Vec::new();
        for src in Viewport::ALL {
            for src_dpr in PIXEL_RATIOS {
                out.push(restored(f, mode, src, src_dpr, vp, dpr));
            }
        }
        out
    }
}

#[test]
fn restore_shows_an_arcball_view_at_the_same_css_size_at_any_pixel_ratio() {
    assert_same_css_size(
        "restore shows an arcball view at the same CSS size",
        restored_from_everywhere(Mode::Arcball),
    );
}

#[test]
fn restore_shows_a_slice_view_at_the_same_css_size_at_any_pixel_ratio() {
    assert_same_css_size(
        "restore shows a slice view at the same CSS size",
        restored_from_everywhere(Mode::Slice),
    );
}

#[test]
fn restore_plans_what_is_visible() {
    assert_plans("restore plans what is visible", |f, vp, dpr| {
        let mut out = restored_from_everywhere(Mode::Slice)(f, vp, dpr);
        out.extend(restored_from_everywhere(Mode::Arcball)(f, vp, dpr));
        out
    });
}

#[test]
fn switching_to_3d_frames_the_dataset() {
    assert_on_screen(
        "switching to 3D frames the dataset",
        &PIXEL_RATIOS,
        |f, vp, dpr| {
            vec![Produced::framing(
                "to 3D",
                switched(f, vp, dpr, Mode::Slice),
            )]
        },
    );
}

#[test]
fn switching_to_2d_frames_the_dataset() {
    assert_on_screen(
        "switching to 2D frames the dataset",
        &PIXEL_RATIOS,
        |f, vp, dpr| {
            vec![Produced::framing(
                "to 2D",
                switched(f, vp, dpr, Mode::Arcball),
            )]
        },
    );
}

#[test]
fn switching_to_3d_shows_the_same_css_size_at_any_pixel_ratio() {
    assert_same_css_size("switching to 3D shows the same CSS size", |f, vp, dpr| {
        vec![Produced::framing(
            "to 3D",
            switched(f, vp, dpr, Mode::Slice),
        )]
    });
}

#[test]
fn switching_to_2d_shows_the_same_css_size_at_any_pixel_ratio() {
    assert_same_css_size("switching to 2D shows the same CSS size", |f, vp, dpr| {
        vec![Produced::framing(
            "to 2D",
            switched(f, vp, dpr, Mode::Arcball),
        )]
    });
}

#[test]
fn switching_plans_what_is_visible() {
    assert_plans("switching plans what is visible", |f, vp, dpr| {
        vec![
            Produced::framing("to 3D", switched(f, vp, dpr, Mode::Slice)),
            Produced::framing("to 2D", switched(f, vp, dpr, Mode::Arcball)),
        ]
    });
}

#[test]
fn explore_home_frames_the_dataset_on_a_1x_canvas() {
    assert_on_screen("explore Home frames the dataset at 1x", &[1], explore_home);
}

#[test]
fn explore_home_frames_the_dataset_on_a_2x_canvas() {
    assert_on_screen("explore Home frames the dataset at 2x", &[2], explore_home);
}

#[test]
fn explore_home_shows_the_same_css_size_at_any_pixel_ratio() {
    assert_same_css_size("explore Home shows the same CSS size", explore_home);
}

#[test]
fn explore_home_plans_what_is_visible() {
    assert_plans("explore Home plans what is visible", explore_home);
}

#[test]
fn explore_from_the_live_view_frames_the_dataset() {
    assert_on_screen(
        "explore from the live view frames the dataset",
        &PIXEL_RATIOS,
        explore_live,
    );
}

#[test]
fn explore_from_the_live_view_shows_the_same_css_size_at_any_pixel_ratio() {
    assert_same_css_size(
        "explore from the live view shows the same CSS size",
        explore_live,
    );
}

#[test]
fn explore_from_the_live_view_plans_what_is_visible() {
    assert_plans(
        "explore from the live view plans what is visible",
        explore_live,
    );
}

/// The fitted arcball zoomed by the interactive command to each multiple of
/// the fit distance.
fn arcball_zoomed(f: &Fixture, vp: Viewport, dpr: u32) -> Vec<Produced> {
    [0.1, 0.25, 0.5, 0.75, 1.0, 2.0, 4.0, 8.0, 64.0]
        .into_iter()
        .map(|multiple: f64| {
            let mut shown = open(f, vp, dpr, Mode::Arcball);
            shown.scene.apply(
                ViewportCommand::Zoom3D {
                    delta: multiple - 1.0,
                }
                .into(),
            );
            Produced::framing(format!("{multiple} times the fit distance"), shown)
        })
        .collect()
}

#[test]
fn arcball_zoom_plans_what_is_visible_from_a_tenth_to_64x_the_fit() {
    assert_plans("arcball zoom plans what is visible", arcball_zoomed);
}

/// The fitted fly camera flown along its view axis, by the interactive tick,
/// to each multiple of the fit distance from the data's center: in to the
/// middle of the data and back out past it.
fn fly_flown(f: &Fixture, vp: Viewport, dpr: u32) -> Vec<Produced> {
    const TICKS: u32 = 8;
    const DT: f64 = 0.1;
    [0.1, 0.25, 0.5, 0.75, 1.0, 2.0, 4.0, 8.0, 64.0]
        .into_iter()
        .map(|multiple: f64| {
            let mut shown = open(f, vp, dpr, Mode::Arcball);
            shown.scene.apply(ViewportCommand::SetModeFly.into());
            let world = shown.scene.visible_bounds().unwrap().world;
            let Camera::Fly(fly) = &shown.scene.camera else {
                panic!("the scene is not in fly mode");
            };
            let fitted = (0..3)
                .map(|i| (fly.position[i] - (world.min[i] + world.max[i]) / 2.0).powi(2))
                .sum::<f64>()
                .sqrt();
            let travel = (multiple - 1.0) * fitted;
            shown.scene.apply(
                ViewportCommand::FlySetBaseSpeed {
                    speed: travel.abs() / (DT * f64::from(TICKS)),
                }
                .into(),
            );
            for _ in 0..TICKS {
                shown.scene.apply(
                    ViewportCommand::FlyTick {
                        dt: DT,
                        forward: -travel.signum(),
                        right: 0.0,
                        up: 0.0,
                        yaw: 0.0,
                        pitch: 0.0,
                        roll: 0.0,
                    }
                    .into(),
                );
            }
            Produced::framing(format!("{multiple} times the fit distance"), shown)
        })
        .collect()
}

#[test]
fn fly_plans_what_is_visible_from_a_tenth_to_64x_the_fit() {
    assert_plans("fly plans what is visible", fly_flown);
}
