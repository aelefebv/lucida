//! Planning + composition for `lucida dataset montage` — the agent-facing
//! contact sheet.
//!
//! Pure logic: given a dataset's shape, decide which axis to sample, which
//! cells (z/t/c) to render, the montage grid layout, the per-cell view
//! (`SavedView`), and how to stitch the rendered thumbnails into one image.
//! Kept free of network/browser I/O so it is unit-testable; the command wires
//! this to the headless render.

use std::io::Cursor;

use font8x8::{BASIC_FONTS, UnicodeFonts};
use image::{ImageFormat, Rgba, RgbaImage};
use lucida_content::{ChannelInfo, DatasetId};
use lucida_core::camera::Camera;
use lucida_core::saved_view::SavedView;
use lucida_core::scene::{ChannelSettings, Colormap, DatasetDisplaySettings};
use lucida_core::view::ViewState;

/// Which dataset axis the montage sweeps. Picked from the dataset's shape: a
/// multi-tile collection samples tiles; otherwise a depth stack samples Z, a
/// timeseries samples T, and a flat single image yields one cell.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MontageAxis {
    Tile,
    Z,
    T,
    Single,
}

/// One montage cell: the view it renders + a short human label. Every cell
/// shows the dataset's composite.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MontageCell {
    pub z: u32,
    pub t: u32,
    /// Tile index (0 for a single-image dataset).
    pub tile: usize,
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

/// A position as a person reads it, counted from 1, as the web's
/// `positionLabel` writes it, so a label burned into a cell names the same
/// slice the viewer does. The sidecar's `z`/`t`/`c`/`tile` fields and the CLI
/// flags stay 0-based.
fn position_label(axis: &str, index: impl Into<u64>) -> String {
    format!("{axis} {}", index.into() + 1)
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
/// `image_count` members (tiles), sampling at most `max_cells` positions.
///
/// Axis priority: a multi-tile collection samples tiles; else a Z>1 stack samples
/// Z; else a T>1 series samples T; else a single cell. The mid Z (and t=0)
/// anchor the non-Z axes. `max_cols` caps the grid width.
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
        // Collection / multi-tile: one cell per tile (capped), at mid-Z.
        let n = image_count.min(max_cells);
        let cells = (0..n)
            .map(|f| MontageCell {
                z: mid_z,
                t: 0,
                tile: f,
                label: position_label("tile", f as u64),
            })
            .collect();
        (MontageAxis::Tile, cells)
    } else if z_n > 1 {
        let cells = even_samples(z_n, max_cells)
            .into_iter()
            .map(|z| MontageCell {
                z,
                t: 0,
                tile: 0,
                label: position_label("Z", z),
            })
            .collect();
        (MontageAxis::Z, cells)
    } else if t_n > 1 {
        let cells = even_samples(t_n, max_cells)
            .into_iter()
            .map(|t| MontageCell {
                z: 0,
                t,
                tile: 0,
                label: position_label("T", t),
            })
            .collect();
        (MontageAxis::T, cells)
    } else {
        (
            MontageAxis::Single,
            vec![MontageCell {
                z: 0,
                t: 0,
                tile: 0,
                label: position_label("Z", 0u32),
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

/// Build the inline `SavedView` for one montage cell: an unframed 2D camera at
/// the cell's z/t with the dataset's composite visible. The page that renders the cell
/// fits an unframed camera to the whole dataset on its own canvas, so the
/// montage keeps no fit math of its own. Source URLs are left empty
/// (workspace-dataset-id form — the dataset is already open in the target
/// workspace); the caller encodes this into a `#view=` URL.
///
/// `contrast` controls the window: `None` leaves auto-contrast on (each cell
/// stretches its own slice — fine for a single view, but flattens a contact
/// sheet of a densely-labelled stack). `Some([lo, hi])` pins one **shared**
/// window across all cells (auto off) so brightness is comparable and a clipped
/// `lo` suppresses the background — and restores each channel's natural colormap
/// (`default_for_channel`, from the `declared` channel metadata), which an
/// explicit window would otherwise reset to gray.
pub fn build_cell_view(
    ds_id: &str,
    cell: &MontageCell,
    viewport: [u32; 2],
    contrast: Option<[f64; 2]>,
    channel_count: u64,
    declared: &[ChannelInfo],
) -> SavedView {
    let mut view = SavedView::empty(viewport);
    view.camera = Camera::new_2d(viewport);
    view.view = ViewState {
        z_range: cell.z..cell.z + 1,
        t: cell.t,
        ..ViewState::new()
    };
    let id = DatasetId(ds_id.to_string());
    view.dataset_order = vec![id.clone()];
    match contrast {
        Some([lo, hi]) => {
            // Per-channel settings carry the colormap (an explicit dataset
            // setting otherwise resets it to gray) and the same window, for
            // every channel of the composite.
            let channel_count = channel_count.max(1) as usize;
            let channel_settings = (0..channel_count)
                .map(|i| ChannelSettings {
                    colormap: Colormap::default_for_channel(i, channel_count, declared),
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

/// Draw `text` in white (8×8 bitmap font, `scale`×) at `(ox, oy)` over a dark
/// translucent backing, so the label is legible on any cell content. Clipped to
/// the canvas. This is what makes a montage self-identifying: each cell carries
/// its own slice label, so an agent reads the slice straight off the image.
fn draw_label(canvas: &mut RgbaImage, ox: i64, oy: i64, text: &str, scale: i64) {
    let (cw, chh) = (canvas.width() as i64, canvas.height() as i64);
    let glyph = 8 * scale;
    let text_w = text.chars().count() as i64 * glyph;
    let pad = scale.max(1);
    // Darken a backing rectangle so white glyphs read on bright cells.
    for y in (oy - pad)..(oy + glyph + pad) {
        for x in (ox - pad)..(ox + text_w + pad) {
            if (0..cw).contains(&x) && (0..chh).contains(&y) {
                let p = canvas.get_pixel_mut(x as u32, y as u32);
                p[0] = (p[0] as u32 * 3 / 10) as u8;
                p[1] = (p[1] as u32 * 3 / 10) as u8;
                p[2] = (p[2] as u32 * 3 / 10) as u8;
                p[3] = 255;
            }
        }
    }
    for (i, ch) in text.chars().enumerate() {
        let Some(bitmap) = BASIC_FONTS.get(ch) else {
            continue;
        };
        for (row, bits) in bitmap.iter().enumerate() {
            for col in 0..8 {
                if bits & (1 << col) == 0 {
                    continue; // bit `col` (LSB = leftmost) lit?
                }
                let gx = ox + (i as i64 * 8 + col) * scale;
                let gy = oy + row as i64 * scale;
                for dy in 0..scale {
                    for dx in 0..scale {
                        let (x, y) = (gx + dx, gy + dy);
                        if (0..cw).contains(&x) && (0..chh).contains(&y) {
                            canvas.put_pixel(x as u32, y as u32, Rgba([255, 255, 255, 255]));
                        }
                    }
                }
            }
        }
    }
}

/// Stitch rendered thumbnail PNGs (row-major, `cols` wide) into one montage
/// PNG, burning each cell's `label` into its top-left corner so the sheet is
/// self-identifying. Cells are sized to the largest thumbnail and laid on a dark
/// backdrop so ragged sizes (e.g. a final short row) still align. `labels` is
/// indexed in step with `thumbs` (a missing label just draws nothing). Returns
/// encoded PNG bytes.
pub fn stitch_grid(thumbs: &[Vec<u8>], labels: &[String], cols: u32) -> Result<Vec<u8>, String> {
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
    // Scale the label to the cell: ~2px glyphs per 160px of cell width, min 2×.
    let scale = (cell_w as i64 / 160).max(2);
    for (i, thumb) in decoded.iter().enumerate() {
        let cx = (i as u32 % cols) * cell_w;
        let cy = (i as u32 / cols) * cell_h;
        image::imageops::overlay(&mut canvas, thumb, cx as i64, cy as i64);
        if let Some(label) = labels.get(i)
            && !label.is_empty()
        {
            draw_label(
                &mut canvas,
                cx as i64 + 2 * scale,
                cy as i64 + 2 * scale,
                label,
                scale,
            );
        }
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
    use lucida_core::camera::Framing;

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
            tile: 0,
            label: "Z 43".into(),
        };
        let view = build_cell_view("wds-abc", &cell, [256, 256], None, 3, &[]);
        // The page fits the camera, so the cell asks for a slice and no pose.
        assert!(matches!(view.camera, Camera::Slice(_)));
        assert_eq!(view.camera.framing(), Framing::Unframed);
        assert_eq!(view.view.z_range, 42..43);
        assert_eq!(view.view.t, 3);
        let id = DatasetId("wds-abc".into());
        assert_eq!(view.dataset_order, vec![id.clone()]);
        assert_eq!(
            view.dataset_settings[&id].solo, None,
            "a cell shows the composite"
        );
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
            tile: 0,
            label: "Z 11".into(),
        };
        let view = build_cell_view("wds-x", &cell, [256, 256], Some([60.0, 196.0]), 2, &[]);
        let id = DatasetId("wds-x".into());
        // Auto OFF so the window is shared across all cells, not per-slice.
        assert_eq!(view.auto_contrast.get(&id), Some(&false));
        let settings = view.dataset_settings.get(&id).expect("settings");
        assert_eq!(settings.contrast_min, 60.0);
        assert_eq!(settings.contrast_max, 196.0);
        // Every channel of the composite has settings that keep the natural
        // per-channel colormap (not reset to gray) + the shared window.
        assert_eq!(settings.channel_settings.len(), 2);
        assert_eq!(
            settings.channel_settings[1].colormap,
            Colormap::default_for_channel(1, 2, &[])
        );
        assert_eq!(settings.channel_settings[1].contrast_min, 60.0);
        assert_eq!(settings.channel_settings[1].contrast_max, 196.0);

        // A one-channel image keeps the gray it opens with.
        let view = build_cell_view("wds-x", &cell, [256, 256], Some([60.0, 196.0]), 1, &[]);
        let settings = view.dataset_settings.get(&id).expect("settings");
        assert_eq!(settings.channel_settings[0].colormap, Colormap::Gray);
    }

    #[test]
    fn stitch_lays_thumbs_in_a_grid() {
        let thumbs = vec![
            solid_png(64, 64, [255, 0, 0, 255]),
            solid_png(64, 64, [0, 255, 0, 255]),
            solid_png(64, 64, [0, 0, 255, 255]),
        ];
        let labels = vec!["Z 1".to_string(), "Z 2".to_string(), "Z 3".to_string()];
        let png = stitch_grid(&thumbs, &labels, 2).unwrap();
        let img = image::load_from_memory(&png).unwrap();
        // 3 cells, 2 cols → 2x2 grid of 64px cells = 128x128.
        assert_eq!(img.dimensions(), (128, 128));
        // A label burns white (255,255,255) glyph pixels into the first cell's
        // top-left corner — the solid red cell alone has none.
        let rgba = img.to_rgba8();
        let has_white = (0..40)
            .flat_map(|y| (0..60).map(move |x| (x, y)))
            .any(|(x, y)| {
                let p = rgba.get_pixel(x, y);
                p[0] > 200 && p[1] > 200 && p[2] > 200
            });
        assert!(has_white, "expected burned-in label glyph pixels");
    }

    #[test]
    fn stitch_rejects_empty() {
        assert!(stitch_grid(&[], &[], 4).is_err());
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
    fn samples_tiles_for_a_collection() {
        // 64-tile collection (image_count 64); tiles win over Z.
        let plan = plan_montage([1, 4, 9, 256, 256], 64, 16, 4);
        assert_eq!(plan.axis, MontageAxis::Tile);
        assert_eq!(plan.cells.len(), 16);
        assert_eq!(plan.cells[0].tile, 0);
        assert_eq!(plan.cells[15].tile, 15);
        // Collection cells anchor at mid-Z.
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
    fn labels_count_from_one_while_fields_stay_zero_based() {
        let z = plan_montage([1, 1, 340, 512, 512], 1, 16, 4);
        assert_eq!((z.cells[0].z, z.cells[0].label.as_str()), (0, "Z 1"));
        assert_eq!((z.cells[15].z, z.cells[15].label.as_str()), (339, "Z 340"));
        let t = plan_montage([30, 2, 1, 256, 256], 1, 16, 4);
        assert_eq!((t.cells[0].t, t.cells[0].label.as_str()), (0, "T 1"));
        let tiles = plan_montage([1, 4, 9, 256, 256], 64, 16, 4);
        assert_eq!(
            (tiles.cells[0].tile, tiles.cells[0].label.as_str()),
            (0, "tile 1")
        );
        let single = plan_montage([1, 1, 1, 1024, 1024], 1, 16, 4);
        assert_eq!(single.cells[0].label, "Z 1");
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
