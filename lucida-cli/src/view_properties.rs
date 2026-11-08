//! The CLI's view producers, the overview and montage cells, checked against
//! the properties every view producer owes (`lucida_core::view_properties`).
//! A test marked `ignore` names behavior that breaks its property today.
//!
//! The CLI works on a headless window at pixel ratio 1, and a page shows what
//! it made by importing it. The overview fits the CLI's own scene; a montage
//! cell leaves its camera unframed for the page to fit.

use lucida_core::view_properties::{
    Fixture, PIXEL_RATIOS, Produced, Viewport, assert_on_screen, assert_plans,
    assert_same_css_size, capture, join, restore,
};

use crate::montage::{build_cell_view, plan_montage};
use crate::view::apply_overview_to_scene;

/// `lucida viewer overview` for a window the size of `vp`, shown on a page at
/// `vp` and `dpr`.
fn overview(f: &Fixture, vp: Viewport, dpr: u32) -> Vec<Produced> {
    let mut cli = join(f, vp, 1).scene;
    apply_overview_to_scene(&mut cli, vp.css).unwrap();
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
            let view = build_cell_view(&id.0, cell, vp.css, None);
            Produced::framing(cell.label.clone(), restore(&view, f, vp, dpr))
        })
        .collect()
}

#[test]
fn overview_frames_the_dataset_on_a_1x_canvas() {
    assert_on_screen("overview frames the dataset at 1x", &[1], overview);
}

#[test]
fn overview_frames_the_dataset_on_a_2x_canvas() {
    assert_on_screen("overview frames the dataset at 2x", &[2], overview);
}

#[test]
fn overview_shows_the_same_css_size_at_any_pixel_ratio() {
    assert_same_css_size("overview shows the same CSS size", overview);
}

#[test]
fn overview_plans_what_is_visible() {
    assert_plans("overview plans what is visible", overview);
}

#[test]
fn montage_cells_frame_the_dataset() {
    assert_on_screen("montage cells frame the dataset", &PIXEL_RATIOS, montage);
}

#[test]
fn montage_cells_show_the_same_css_size_at_any_pixel_ratio() {
    assert_same_css_size("montage cells show the same CSS size", montage);
}

#[test]
fn montage_cells_plan_what_is_visible() {
    assert_plans("montage cells plan what is visible", montage);
}
