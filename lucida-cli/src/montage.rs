//! Planning + composition for `lucida dataset montage` — the agent-facing
//! contact sheet.
//!
//! Pure logic: given a dataset's shape, decide which axis to sample, which
//! cells (z/t/c) to render, the montage grid layout, the per-cell view
//! (`SavedView`), and how to stitch the rendered thumbnails into one image.
//! Kept free of network/browser I/O so it is unit-testable; the command wires
//! this to the headless render.

use std::io::Cursor;

use image::{ImageFormat, Rgba, RgbaImage};
use lucida_content::DatasetId;
use lucida_core::camera::{Camera, Slice};
use lucida_core::saved_view::SavedView;
use lucida_core::scene::{ChannelSettings, Colormap, DatasetDisplaySettings};
use lucida_core::view::ViewState;

/// Which dataset axis the montage sweeps. Picked from the dataset's shape: a
/// multi-field plate samples fields; otherwise a depth stack samples Z, a
/// timeseries samples T, and a flat single image yields one cell.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MontageAxis {
    Field,
    Z,
    T,
    Single,
}

/// One montage cell: the view it renders + a short human label.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MontageCell {
    pub z: u32,
    pub t: u32,
    pub c: u32,
    /// Member/field index (0 for a single-image dataset).
    pub field: usize,
    pub label: String,
}

/// The full montage plan: the sampled cells and the grid they tile into.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MontagePlan {
    pub axis: MontageAxis,
    pub cells: Vec<MontageCell>,
    pub cols: u32,
    pub rows: u32,
}

/// Evenly-spaced sample indices across `[0, extent)`, inclusive of both ends.
/// `n` samples (clamped to `extent`); `extent` 0/1 yields `[0]`.
fn even_samples(extent: u64, n: usize) -> Vec<u32> {
    if extent <= 1 {
        return vec![0];
    }
    let n = n.clamp(1, extent as usize);
    if n == 1 {
        return vec![0];
    }
    (0..n)
        .map(|i| ((i as u64 * (extent - 1)) / (n as u64 - 1)) as u32)
        .collect()
}

/// Grid columns for `n` cells: a roughly-square layout capped at `max_cols`
/// wide (4 by default), so a 16-cell montage is 4×4 and a 3-cell one is 3×1.
fn grid_cols(n: usize, max_cols: u32) -> u32 {
    if n == 0 {
        return 1;
    }
    let sqrt_ceil = (n as f64).sqrt().ceil() as u32;
    sqrt_ceil.clamp(1, max_cols.max(1))
}

/// Plan a montage for a dataset of shape `dims = [T, C, Z, Y, X]` with
/// `image_count` members (fields), sampling at most `max_cells` positions.
///
/// Axis priority: a multi-field plate samples fields; else a Z>1 stack samples
/// Z; else a T>1 series samples T; else a single cell. The mid Z (and t=0,
/// c=0) anchor the non-Z axes. `max_cols` caps the grid width.
pub fn plan_montage(
    dims: [u64; 5],
    image_count: usize,
    max_cells: usize,
    max_cols: u32,
) -> MontagePlan {
    let [t_n, _c_n, z_n, _y, _x] = dims;
    let max_cells = max_cells.max(1);
    let mid_z = (z_n.saturating_sub(1) / 2) as u32;

    let (axis, cells) = if image_count > 1 {
        // Plate / multi-field: one cell per field (capped), at mid-Z.
        let n = image_count.min(max_cells);
        let cells = (0..n)
            .map(|f| MontageCell {
                z: mid_z,
                t: 0,
                c: 0,
                field: f,
                label: format!("field {f}"),
            })
            .collect();
        (MontageAxis::Field, cells)
    } else if z_n > 1 {
        let cells = even_samples(z_n, max_cells)
            .into_iter()
            .map(|z| MontageCell {
                z,
                t: 0,
                c: 0,
                field: 0,
                label: format!("z={z}"),
            })
            .collect();
        (MontageAxis::Z, cells)
    } else if t_n > 1 {
        let cells = even_samples(t_n, max_cells)
            .into_iter()
            .map(|t| MontageCell {
                z: 0,
                t,
                c: 0,
                field: 0,
                label: format!("t={t}"),
            })
            .collect();
        (MontageAxis::T, cells)
    } else {
        (
            MontageAxis::Single,
            vec![MontageCell {
                z: 0,
                t: 0,
                c: 0,
                field: 0,
                label: "z=0".into(),
            }],
        )
    };

    let cols = grid_cols(cells.len(), max_cols);
    let rows = (cells.len() as u32).div_ceil(cols.max(1));
    MontagePlan {
        axis,
        cells,
        cols,
        rows,
    }
}

/// A 2D slice camera framing the full `full_x × full_y` voxel extent inside
/// `viewport` pixels (centered, zoomed so the whole image fits). zoom = 1.0 is
/// native (1 px/voxel); fit picks the smaller per-axis ratio so nothing clips.
fn fit_slice_camera(full_x: u64, full_y: u64, viewport: [u32; 2]) -> Slice {
    let x = full_x.max(1) as f64;
    let y = full_y.max(1) as f64;
    let zoom = (viewport[0] as f64 / x)
        .min(viewport[1] as f64 / y)
        .max(f64::MIN_POSITIVE);
    Slice {
        center: [x / 2.0, y / 2.0],
        zoom,
        viewport,
    }
}

/// Build the inline `SavedView` for one montage cell: a fit 2D camera at the
/// cell's z/t/c with the dataset visible. Source URLs are left empty
/// (workspace-dataset-id form — the dataset is already open in the target
/// workspace); the caller encodes this into a `#view=` URL.
///
/// `contrast` controls the window: `None` leaves auto-contrast on (each cell
/// stretches its own slice — fine for a single view, but flattens a contact
/// sheet of a densely-labelled stack). `Some([lo, hi])` pins one **shared**
/// window across all cells (auto off) so brightness is comparable and a clipped
/// `lo` suppresses the background — and restores the channel's natural colormap
/// (`default_for_channel`), which an explicit window would otherwise reset to gray.
pub fn build_cell_view(
    ds_id: &str,
    cell: &MontageCell,
    full_x: u64,
    full_y: u64,
    viewport: [u32; 2],
    contrast: Option<[f64; 2]>,
) -> SavedView {
    let mut view = SavedView::empty(viewport);
    view.camera = Camera::Slice(fit_slice_camera(full_x, full_y, viewport));
    view.view = ViewState {
        z_range: cell.z..cell.z + 1,
        t: cell.t,
        c: cell.c,
        multi_channel: false,
    };
    let id = DatasetId(ds_id.to_string());
    view.dataset_order = vec![id.clone()];
    match contrast {
        Some([lo, hi]) => {
            // Per-channel settings carry the colormap (an explicit dataset
            // setting otherwise resets it to gray) and the same window, up to
            // the active channel; the dataset-level contrast covers the
            // single-channel render path.
            let channel_settings = (0..=cell.c as usize)
                .map(|i| ChannelSettings {
                    colormap: Colormap::default_for_channel(i),
                    contrast_min: lo,
                    contrast_max: hi,
                    ..ChannelSettings::default()
                })
                .collect();
            let settings = DatasetDisplaySettings {
                contrast_min: lo,
                contrast_max: hi,
                channel_settings,
                ..DatasetDisplaySettings::default()
            };
            view.dataset_settings.insert(id.clone(), settings);
            view.auto_contrast.insert(id, false);
        }
        None => {
            view.dataset_settings
                .insert(id.clone(), DatasetDisplaySettings::default());
            view.auto_contrast.insert(id, true);
        }
    }
    view
}

/// Stitch rendered thumbnail PNGs (row-major, `cols` wide) into one montage
/// PNG. Cells are sized to the largest thumbnail and laid on a dark backdrop so
/// ragged sizes (e.g. a final short row) still align. Returns encoded PNG bytes.
pub fn stitch_grid(thumbs: &[Vec<u8>], cols: u32) -> Result<Vec<u8>, String> {
    if thumbs.is_empty() {
        return Err("no thumbnails to stitch".into());
    }
    let cols = cols.max(1);
    let decoded: Vec<RgbaImage> = thumbs
        .iter()
        .map(|bytes| {
            image::load_from_memory(bytes)
                .map(|img| img.to_rgba8())
                .map_err(|e| format!("decode thumbnail: {e}"))
        })
        .collect::<Result<_, _>>()?;
    let cell_w = decoded.iter().map(|t| t.width()).max().unwrap_or(1).max(1);
    let cell_h = decoded.iter().map(|t| t.height()).max().unwrap_or(1).max(1);
    let rows = (decoded.len() as u32).div_ceil(cols);
    let mut canvas = RgbaImage::from_pixel(cols * cell_w, rows * cell_h, Rgba([12, 12, 16, 255]));
    for (i, thumb) in decoded.iter().enumerate() {
        let cx = (i as u32 % cols) * cell_w;
        let cy = (i as u32 / cols) * cell_h;
        image::imageops::overlay(&mut canvas, thumb, cx as i64, cy as i64);
    }
    let mut out = Vec::new();
    image::DynamicImage::ImageRgba8(canvas)
        .write_to(&mut Cursor::new(&mut out), ImageFormat::Png)
        .map_err(|e| format!("encode montage: {e}"))?;
    Ok(out)
}

/// Add the chrome-free capture flag (`render=1`) to a viewer URL, inserting it
/// into the query string while preserving any `#view=…` fragment. Cells are
/// captured through this clean surface (no sidebar/toolbar), but the sidecar
/// keeps the normal interactive URLs so an agent or human can drill in.
pub fn with_render_param(url: &str) -> String {
    let (base, fragment) = match url.split_once('#') {
        Some((base, fragment)) => (base, Some(fragment)),
        None => (url, None),
    };
    let separator = if base.contains('?') { '&' } else { '?' };
    let mut out = format!("{base}{separator}render=1");
    if let Some(fragment) = fragment {
        out.push('#');
        out.push_str(fragment);
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use image::GenericImageView;

    #[test]
    fn render_param_inserts_before_fragment() {
        // The viewer URL carries the SavedView in the `#view=` fragment; the
        // render flag must land in the query string ahead of it.
        assert_eq!(
            with_render_param("http://h/w/ws#view=ABC"),
            "http://h/w/ws?render=1#view=ABC"
        );
        // Existing query → append with `&`.
        assert_eq!(
            with_render_param("http://h/w/ws?x=1#view=ABC"),
            "http://h/w/ws?x=1&render=1#view=ABC"
        );
        // No fragment at all.
        assert_eq!(with_render_param("http://h/w/ws"), "http://h/w/ws?render=1");
    }

    /// A tiny solid-color PNG for stitch tests.
    fn solid_png(w: u32, h: u32, color: [u8; 4]) -> Vec<u8> {
        let img = RgbaImage::from_pixel(w, h, Rgba(color));
        let mut out = Vec::new();
        image::DynamicImage::ImageRgba8(img)
            .write_to(&mut Cursor::new(&mut out), ImageFormat::Png)
            .unwrap();
        out
    }

    #[test]
    fn cell_view_sets_slice_z_and_visible_dataset() {
        let cell = MontageCell {
            z: 42,
            t: 3,
            c: 1,
            field: 0,
            label: "z=42".into(),
        };
        let view = build_cell_view("wds-abc", &cell, 400, 200, [256, 256], None);
        match view.camera {
            Camera::Slice(s) => {
                assert_eq!(s.center, [200.0, 100.0]);
                // fit: min(256/400, 256/200) = 0.64
                assert!((s.zoom - 0.64).abs() < 1e-9, "zoom {}", s.zoom);
            }
            _ => panic!("expected 2D slice camera"),
        }
        assert_eq!(view.view.z_range, 42..43);
        assert_eq!(view.view.t, 3);
        assert_eq!(view.view.c, 1);
        let id = DatasetId("wds-abc".into());
        assert_eq!(view.dataset_order, vec![id.clone()]);
        assert_eq!(view.auto_contrast.get(&id), Some(&true));
        assert!(
            view.datasets.is_empty(),
            "inline view must be workspace-id form"
        );
    }

    #[test]
    fn shared_contrast_pins_window_and_keeps_colormap() {
        let cell = MontageCell {
            z: 10,
            t: 0,
            c: 1,
            field: 0,
            label: "z=10".into(),
        };
        let view = build_cell_view("wds-x", &cell, 256, 256, [256, 256], Some([60.0, 196.0]));
        let id = DatasetId("wds-x".into());
        // Auto OFF so the window is shared across all cells, not per-slice.
        assert_eq!(view.auto_contrast.get(&id), Some(&false));
        let settings = view.dataset_settings.get(&id).expect("settings");
        assert_eq!(settings.contrast_min, 60.0);
        assert_eq!(settings.contrast_max, 196.0);
        // Channel settings exist up to the active channel and keep the natural
        // per-channel colormap (not reset to gray) + the shared window.
        assert_eq!(settings.channel_settings.len(), 2);
        assert_eq!(
            settings.channel_settings[1].colormap,
            Colormap::default_for_channel(1)
        );
        assert_eq!(settings.channel_settings[1].contrast_min, 60.0);
        assert_eq!(settings.channel_settings[1].contrast_max, 196.0);
    }

    #[test]
    fn stitch_lays_thumbs_in_a_grid() {
        let thumbs = vec![
            solid_png(8, 8, [255, 0, 0, 255]),
            solid_png(8, 8, [0, 255, 0, 255]),
            solid_png(8, 8, [0, 0, 255, 255]),
        ];
        let png = stitch_grid(&thumbs, 2).unwrap();
        let img = image::load_from_memory(&png).unwrap();
        // 3 cells, 2 cols → 2x2 grid of 8px cells = 16x16.
        assert_eq!(img.dimensions(), (16, 16));
    }

    #[test]
    fn stitch_rejects_empty() {
        assert!(stitch_grid(&[], 4).is_err());
    }

    #[test]
    fn samples_z_for_a_3d_volume() {
        // [T,C,Z,Y,X] = 1 timepoint, 1 channel, 340 z, single image.
        let plan = plan_montage([1, 1, 340, 512, 512], 1, 16, 4);
        assert_eq!(plan.axis, MontageAxis::Z);
        assert_eq!(plan.cells.len(), 16);
        // Evenly spaced, inclusive of both ends.
        assert_eq!(plan.cells.first().unwrap().z, 0);
        assert_eq!(plan.cells.last().unwrap().z, 339);
        assert_eq!(plan.cols, 4);
        assert_eq!(plan.rows, 4);
    }

    #[test]
    fn samples_fields_for_a_plate() {
        // 64-field plate (image_count 64); fields win over Z.
        let plan = plan_montage([1, 4, 9, 256, 256], 64, 16, 4);
        assert_eq!(plan.axis, MontageAxis::Field);
        assert_eq!(plan.cells.len(), 16);
        assert_eq!(plan.cells[0].field, 0);
        assert_eq!(plan.cells[15].field, 15);
        // Plate cells anchor at mid-Z.
        assert_eq!(plan.cells[0].z, 4);
    }

    #[test]
    fn samples_t_for_a_timeseries() {
        // 30 timepoints, flat (Z=1), single image → sample T.
        let plan = plan_montage([30, 2, 1, 256, 256], 1, 16, 4);
        assert_eq!(plan.axis, MontageAxis::T);
        assert_eq!(plan.cells.len(), 16);
        assert_eq!(plan.cells.first().unwrap().t, 0);
        assert_eq!(plan.cells.last().unwrap().t, 29);
    }

    #[test]
    fn single_cell_for_a_flat_2d_image() {
        let plan = plan_montage([1, 1, 1, 1024, 1024], 1, 16, 4);
        assert_eq!(plan.axis, MontageAxis::Single);
        assert_eq!(plan.cells.len(), 1);
        assert_eq!(plan.cols, 1);
        assert_eq!(plan.rows, 1);
    }

    #[test]
    fn clamps_samples_to_extent() {
        // Only 5 z-slices but asked for 16 → 5 cells, no out-of-range index.
        let plan = plan_montage([1, 1, 5, 64, 64], 1, 16, 4);
        assert_eq!(plan.cells.len(), 5);
        assert!(plan.cells.iter().all(|cell| cell.z < 5));
        assert_eq!(plan.cells.last().unwrap().z, 4);
    }
}
