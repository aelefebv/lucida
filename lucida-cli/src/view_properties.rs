//! The CLI's view producers, the overview and montage cells, checked against
//! the properties every view producer owes (`lucida_core::view_properties`).
//! A test marked `ignore` names behavior that breaks its property today.
//!
//! Both producers fit a camera to the viewport the CLI is given, a headless
//! window at pixel ratio 1, and a page shows the result by importing it.

use lucida_core::view_properties::{
    Fixture, PIXEL_RATIOS, Produced, Viewport, assert_on_screen, assert_plans,
    assert_same_css_size, capture, join, restore,
};

use crate::montage::{build_cell_view, plan_montage};

/// `lucida viewer overview` for a window the size of `vp`, shown on a page at
/// `vp` and `dpr`.
fn overview(f: &Fixture, vp: Viewport, dpr: u32) -> Vec<Produced> {
    let mut cli = join(f, vp, 1).scene;
    cli.frame_visible_2d(vp.css).unwrap();
    vec![Produced::framing(
        "overview",
        restore(&capture(&cli), f, vp, dpr),
    )]
}

/// Every cell of `lucida dataset montage` with cells the size of `vp`, each
/// shown on a page at `vp` and `dpr`. The montage plans every dataset as one
/// image, as the command does.
fn montage(f: &Fixture, vp: Viewport, dpr: u32) -> Vec<Produced> {
    let dims = f.dims();
    let id = f.id();
    plan_montage(dims, 1, 16, 4)
        .cells
        .iter()
        .map(|cell| {
            let view = build_cell_view(&id.0, cell, dims[4], dims[3], vp.css, None);
            Produced::framing(cell.label.clone(), restore(&view, f, vp, dpr))
        })
        .collect()
}

/// The montage of every fixture but the collection, whose tiles a montage
/// cell does not place.
fn montage_of_one_image(f: &Fixture, vp: Viewport, dpr: u32) -> Vec<Produced> {
    if f.image_count() > 1 {
        return Vec::new();
    }
    montage(f, vp, dpr)
}

fn montage_of_a_collection(f: &Fixture, vp: Viewport, dpr: u32) -> Vec<Produced> {
    if f.image_count() == 1 {
        return Vec::new();
    }
    montage(f, vp, dpr)
}

#[test]
fn overview_frames_the_dataset_on_a_1x_canvas() {
    assert_on_screen("overview frames the dataset at 1x", &[1], overview);
}

#[test]
#[ignore = "the overview is fitted to the CLI's window and a 2x page imports its zoom as device pixels, at half size"]
fn overview_frames_the_dataset_on_a_2x_canvas() {
    assert_on_screen("overview frames the dataset at 2x", &[2], overview);
}

#[test]
#[ignore = "the overview is fitted to the CLI's window and a page imports its zoom as device pixels"]
fn overview_shows_the_same_css_size_at_any_pixel_ratio() {
    assert_same_css_size("overview shows the same CSS size", overview);
}

#[test]
fn overview_plans_what_is_visible() {
    assert_plans("overview plans what is visible", overview);
}

// A cell fills its window edge to edge, so a 2x page showing it at half size
// sits exactly on the framing floor. The CSS-size property catches that case.
#[test]
fn montage_cells_frame_a_single_image_on_a_1x_canvas() {
    assert_on_screen(
        "montage cells frame a single image at 1x",
        &[1],
        montage_of_one_image,
    );
}

#[test]
#[ignore = "a montage cell fits the first image's extent at the origin, so a collection's cell shows one tile"]
fn montage_cells_frame_a_collection() {
    assert_on_screen(
        "montage cells frame a collection",
        &PIXEL_RATIOS,
        montage_of_a_collection,
    );
}

#[test]
#[ignore = "a montage cell is fitted to the CLI's window and a page imports its zoom as device pixels"]
fn montage_cells_show_the_same_css_size_at_any_pixel_ratio() {
    assert_same_css_size("montage cells show the same CSS size", montage);
}

#[test]
fn montage_cells_plan_what_is_visible() {
    assert_plans("montage cells plan what is visible", montage);
}
