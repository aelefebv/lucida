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
use lucida_content::DatasetId;
use lucida_core::camera::{Camera, Slice};
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

/// One montage cell: the view it renders + a short human label.
#[derive(Debug, Clone, PartialEq)]
pub struct MontageCell {
    pub z: u32,
    pub t: u32,
    pub c: u32,
    /// Tile index (0 for a single-image dataset).
    pub tile: usize,
    /// Exact collection member selected for this cell.
    pub image_id: Option<String>,
    /// Top-left member position in the active layout, in full-res voxels.
    pub position: [f64; 2],
    /// Member extent `[Y, X]` used to frame its camera.
    pub extent: [u64; 2],
    pub label: String,
}

/// Authoritative collection membership supplied by `dataset info`.
#[derive(Debug, Clone, PartialEq)]
pub struct MontageMember {
    pub image_id: String,
    pub name: Option<String>,
    pub position: [f64; 2],
    pub dimensions: [u64; 5],
}

/// The full montage plan: the sampled cells and the grid they tile into.
#[derive(Debug, Clone, PartialEq)]
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

/// Plan a montage for a dataset of shape `dims = [T, C, Z, Y, X]` with an
/// authoritative active-layout member roster, sampling at most `max_cells`.
///
/// Axis priority: a multi-tile collection samples tiles; else a Z>1 stack samples
/// Z; else a T>1 series samples T; else a single cell. The mid Z (and t=0,
/// c=0) anchor the non-Z axes. `max_cols` caps the grid width.
pub fn plan_montage(
    dims: [u64; 5],
    members: &[MontageMember],
    max_cells: usize,
    max_cols: u32,
) -> MontagePlan {
    let [t_n, _c_n, z_n, _y, _x] = dims;
    let max_cells = max_cells.max(1);
    let fallback_extent = [dims[3].max(1), dims[4].max(1)];
    let first = members.first();
    let single_identity = || {
        (
            first.map(|member| member.image_id.clone()),
            first.map(|member| member.position).unwrap_or([0.0, 0.0]),
            first
                .map(|member| [member.dimensions[3].max(1), member.dimensions[4].max(1)])
                .unwrap_or(fallback_extent),
        )
    };

    let (axis, cells) = if members.len() > 1 {
        // Collection: sample the authoritative roster across its full extent,
        // not a fabricated 0..image_count list. Each cell carries the active
        // layout position and member dimensions used by its camera.
        let indices = even_samples(members.len() as u64, max_cells);
        let cells = indices
            .into_iter()
            .map(|index| {
                let tile = index as usize;
                let member = &members[tile];
                let z = member.dimensions[2].saturating_sub(1) / 2;
                let base = member
                    .name
                    .as_deref()
                    .filter(|name| !name.trim().is_empty())
                    .unwrap_or(&member.image_id);
                MontageCell {
                    z: z as u32,
                    t: 0,
                    c: 0,
                    tile,
                    image_id: Some(member.image_id.clone()),
                    position: member.position,
                    extent: [member.dimensions[3].max(1), member.dimensions[4].max(1)],
                    label: format!("tile {tile}: {base}"),
                }
            })
            .collect();
        (MontageAxis::Tile, cells)
    } else if z_n > 1 {
        let (image_id, position, extent) = single_identity();
        let cells = even_samples(z_n, max_cells)
            .into_iter()
            .map(|z| MontageCell {
                z,
                t: 0,
                c: 0,
                tile: 0,
                image_id: image_id.clone(),
                position,
                extent,
                label: format!("z={z}"),
            })
            .collect();
        (MontageAxis::Z, cells)
    } else if t_n > 1 {
        let (image_id, position, extent) = single_identity();
        let cells = even_samples(t_n, max_cells)
            .into_iter()
            .map(|t| MontageCell {
                z: 0,
                t,
                c: 0,
                tile: 0,
                image_id: image_id.clone(),
                position,
                extent,
                label: format!("t={t}"),
            })
            .collect();
        (MontageAxis::T, cells)
    } else {
        let (image_id, position, extent) = single_identity();
        (
            MontageAxis::Single,
            vec![MontageCell {
                z: 0,
                t: 0,
                c: 0,
                tile: 0,
                image_id,
                position,
                extent,
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
fn fit_slice_camera(position: [f64; 2], full_x: u64, full_y: u64, viewport: [u32; 2]) -> Slice {
    let x = full_x.max(1) as f64;
    let y = full_y.max(1) as f64;
    let zoom = (viewport[0] as f64 / x)
        .min(viewport[1] as f64 / y)
        .max(f64::MIN_POSITIVE);
    Slice {
        center: [position[0] + x / 2.0, position[1] + y / 2.0],
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
    viewport: [u32; 2],
    contrast: Option<[f64; 2]>,
) -> SavedView {
    let mut view = SavedView::empty(viewport);
    view.camera = Camera::Slice(fit_slice_camera(
        cell.position,
        cell.extent[1],
        cell.extent[0],
        viewport,
    ));
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
            tile: 0,
            image_id: Some("image-0".into()),
            position: [100.0, 50.0],
            extent: [200, 400],
            label: "z=42".into(),
        };
        let view = build_cell_view("wds-abc", &cell, [256, 256], None);
        match view.camera {
            Camera::Slice(s) => {
                assert_eq!(s.center, [300.0, 150.0]);
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
    fn backing_pixel_viewport_keeps_member_framing_dpr_invariant() {
        let cell = MontageCell {
            z: 0,
            t: 0,
            c: 0,
            tile: 7,
            image_id: Some("image-7".into()),
            position: [120.0, 340.0],
            extent: [900, 1200],
            label: "tile 7".into(),
        };
        let dpr1 = build_cell_view("wds", &cell, [320, 320], None);
        let dpr2 = build_cell_view("wds", &cell, [640, 640], None);
        let (Camera::Slice(dpr1), Camera::Slice(dpr2)) = (dpr1.camera, dpr2.camera) else {
            panic!("montage cells must use slice cameras");
        };

        assert_eq!(dpr1.center, dpr2.center);
        assert_eq!(dpr2.viewport, [640, 640]);
        assert!((dpr2.zoom - 2.0 * dpr1.zoom).abs() < 1e-12);
        // Physical viewport / physical-pixel zoom is the world field of view;
        // it must be identical at DPR 1 and DPR 2.
        assert!(
            (f64::from(dpr1.viewport[0]) / dpr1.zoom - f64::from(dpr2.viewport[0]) / dpr2.zoom)
                .abs()
                < 1e-9
        );
        assert!(
            (f64::from(dpr1.viewport[1]) / dpr1.zoom - f64::from(dpr2.viewport[1]) / dpr2.zoom)
                .abs()
                < 1e-9
        );
    }

    #[test]
    fn shared_contrast_pins_window_and_keeps_colormap() {
        let cell = MontageCell {
            z: 10,
            t: 0,
            c: 1,
            tile: 0,
            image_id: Some("image-0".into()),
            position: [0.0, 0.0],
            extent: [256, 256],
            label: "z=10".into(),
        };
        let view = build_cell_view("wds-x", &cell, [256, 256], Some([60.0, 196.0]));
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
            solid_png(64, 64, [255, 0, 0, 255]),
            solid_png(64, 64, [0, 255, 0, 255]),
            solid_png(64, 64, [0, 0, 255, 255]),
        ];
        let labels = vec!["z=0".to_string(), "z=1".to_string(), "z=2".to_string()];
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
        let plan = plan_montage([1, 1, 340, 512, 512], &[], 16, 4);
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
        // A 64-tile authoritative roster; tiles win over Z and are sampled
        // across the whole collection, not just the first 16 entries.
        let members: Vec<MontageMember> = (0..64)
            .map(|index| MontageMember {
                image_id: format!("image-{index}"),
                name: Some(format!("item-{index}")),
                position: [(index % 8) as f64 * 256.0, (index / 8) as f64 * 128.0],
                dimensions: [1, 4, 9, 128, 256],
            })
            .collect();
        let plan = plan_montage([1, 4, 9, 128, 256], &members, 16, 4);
        assert_eq!(plan.axis, MontageAxis::Tile);
        assert_eq!(plan.cells.len(), 16);
        assert_eq!(plan.cells[0].tile, 0);
        assert_eq!(plan.cells[15].tile, 63);
        assert_eq!(plan.cells[15].image_id.as_deref(), Some("image-63"));
        assert_eq!(plan.cells[15].position, members[63].position);
        assert_eq!(plan.cells[15].extent, [128, 256]);
        assert!(plan.cells[15].label.contains("item-63"));
        // Collection cells anchor at mid-Z.
        assert_eq!(plan.cells[0].z, 4);

        // The saved views frame distinct active-layout members.
        let first_view = build_cell_view("wds", &plan.cells[0], [320, 320], None);
        let last_view = build_cell_view("wds", &plan.cells[15], [320, 320], None);
        assert_ne!(first_view.camera, last_view.camera);
    }

    #[test]
    fn samples_t_for_a_timeseries() {
        // 30 timepoints, flat (Z=1), single image → sample T.
        let plan = plan_montage([30, 2, 1, 256, 256], &[], 16, 4);
        assert_eq!(plan.axis, MontageAxis::T);
        assert_eq!(plan.cells.len(), 16);
        assert_eq!(plan.cells.first().unwrap().t, 0);
        assert_eq!(plan.cells.last().unwrap().t, 29);
    }

    #[test]
    fn single_cell_for_a_flat_2d_image() {
        let plan = plan_montage([1, 1, 1, 1024, 1024], &[], 16, 4);
        assert_eq!(plan.axis, MontageAxis::Single);
        assert_eq!(plan.cells.len(), 1);
        assert_eq!(plan.cols, 1);
        assert_eq!(plan.rows, 1);
    }

    #[test]
    fn clamps_samples_to_extent() {
        // Only 5 z-slices but asked for 16 → 5 cells, no out-of-range index.
        let plan = plan_montage([1, 1, 5, 64, 64], &[], 16, 4);
        assert_eq!(plan.cells.len(), 5);
        assert!(plan.cells.iter().all(|cell| cell.z < 5));
        assert_eq!(plan.cells.last().unwrap().z, 4);
    }
}
