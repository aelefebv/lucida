//! Screenshots of a viewer page: the whole page, one view's part of the
//! canvas, or the canvas and each view, every image taken from one settled
//! load so they agree.

use std::path::Path;
use std::time::Duration;

use lucida_core::scene::ViewsRecord;
use serde::{Deserialize, Serialize};

use crate::browser::{self, Page, Viewport};
use crate::credentials::EffectiveToken;
use crate::error::{CliError, ErrorKind};
use crate::montage;

/// What a capture writes. A view's image comes from the capture surface,
/// where no panel, toolbar or minimap lies over the canvas, so it holds the
/// view alone with what the view draws over itself, such as its scale bar.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CaptureParts {
    /// The whole viewer page, as a person sees it.
    Page,
    /// The view at this place in the layout, from 0.
    View(usize),
    /// The whole canvas, and each view shown beside it.
    CanvasAndViews,
}

/// How a capture renders: the browser window in CSS pixels, its device pixel
/// ratio, which scales the images' pixel size, and whether each view draws
/// its scale bar.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct CaptureOptions {
    pub width: u32,
    pub height: u32,
    pub device_pixel_ratio: f64,
    pub scale_bar: bool,
}

/// One image a capture wrote.
#[derive(Debug, Clone, Serialize)]
pub struct CapturedImage {
    /// The view it shows, absent for the whole page.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub view: Option<usize>,
    pub output: String,
    /// Its size in pixels.
    pub pixels: [u32; 2],
}

/// Load `url`, wait until every view has settled, and write `parts` of the
/// page: the page to `output`, one view to `output`, or the canvas to
/// `output` and each view shown to `<stem>-view-<N>.png` beside it. `views`
/// is the layout the page restores, which names each pane's view.
pub async fn capture_viewer(
    url: &str,
    token: Option<&EffectiveToken>,
    output: &str,
    size: CaptureOptions,
    parts: CaptureParts,
    views: &ViewsRecord,
    wait: Duration,
) -> Result<Vec<CapturedImage>, CliError> {
    if size.width == 0 || size.height == 0 {
        return Err(CliError::config(
            "viewer screenshot width and height must be positive",
        ));
    }
    if !(size.device_pixel_ratio.is_finite() && size.device_pixel_ratio > 0.0) {
        return Err(CliError::config(
            "viewer screenshot device pixel ratio must be positive",
        ));
    }
    let shown = shown_views(views);
    if let CaptureParts::View(view) = parts
        && !shown.contains(&view)
    {
        return Err(hidden_view(view, views));
    }
    let url = match parts {
        CaptureParts::Page => url.to_string(),
        CaptureParts::View(_) | CaptureParts::CanvasAndViews => montage::with_render_param(url),
    };
    let url = montage::with_scale_bar_param(&url, size.scale_bar);
    let viewport = Viewport::new(size.width, size.height, size.device_pixel_ratio);
    browser::with_browser(viewport, wait, async |browser| {
        let mut page = browser.open_page(&url, token, wait).await?;
        let mut written = Vec::new();
        if !matches!(parts, CaptureParts::View(_)) {
            let png = page.screenshot_png(wait).await?;
            written.push(write_png(output, None, &png).await?);
        }
        if parts != CaptureParts::Page {
            let panes = pane_rects(&mut page, wait).await?;
            if panes.len() != shown.len() {
                return Err(CliError::new(
                    ErrorKind::Protocol,
                    format!(
                        "the page shows {} view(s), and the layout {}",
                        panes.len(),
                        shown.len()
                    ),
                ));
            }
            for (view, rect) in shown.iter().zip(panes) {
                let target = match parts {
                    CaptureParts::View(wanted) if wanted == *view => output.to_string(),
                    CaptureParts::View(_) => continue,
                    _ => view_output(output, *view),
                };
                let rect = snap(rect, size.device_pixel_ratio);
                let png = page.screenshot_region_png(rect, wait).await?;
                written.push(write_png(&target, Some(*view), &png).await?);
            }
        }
        Ok(written)
    })
    .await
}

/// The views the page draws, by place: the maximized one alone, else all.
fn shown_views(views: &ViewsRecord) -> Vec<usize> {
    match views.maximized {
        Some(view) => vec![view],
        None => (0..views.views.len()).collect(),
    }
}

fn hidden_view(view: usize, views: &ViewsRecord) -> CliError {
    let message = match views.maximized {
        Some(shown) if view < views.views.len() => {
            format!(
                "view {view} is hidden while view {shown} fills the canvas; see `view maximize`"
            )
        }
        _ => format!(
            "the layout has {} view(s), counted from 0; view {view} was requested",
            views.views.len()
        ),
    };
    CliError::new(ErrorKind::MissingResource, message)
}

/// Where `--each-view` writes view `view` of a capture written to `output`.
pub fn view_output(output: &str, view: usize) -> String {
    let extension = Path::new(output).extension().map_or(0, |ext| ext.len() + 1);
    let base = &output[..output.len() - extension];
    format!("{base}-view-{view}.png")
}

/// A pane's rectangle, in CSS pixels.
#[derive(Debug, Deserialize)]
struct PaneRect {
    x: f64,
    y: f64,
    width: f64,
    height: f64,
}

/// Every view pane on the page, in the layout's order.
async fn pane_rects(page: &mut Page, wait: Duration) -> Result<Vec<PaneRect>, CliError> {
    const PANES: &str = "JSON.stringify([...document.querySelectorAll('[data-view-pane]')]\
        .map((pane) => { const r = pane.getBoundingClientRect(); \
        return { x: r.left, y: r.top, width: r.width, height: r.height }; }))";
    let value = page.evaluate(PANES, wait).await?;
    let text = value.as_str().ok_or_else(|| {
        CliError::new(
            ErrorKind::Protocol,
            "the page did not report its view panes",
        )
    })?;
    serde_json::from_str(text).map_err(|error| {
        CliError::new(
            ErrorKind::Protocol,
            format!("the page's view panes did not parse: {error}"),
        )
    })
}

/// `rect` with each edge on the device pixel grid, so a view's image holds
/// whole pixels of its own pane and none of its neighbor's.
fn snap(rect: PaneRect, ratio: f64) -> [f64; 4] {
    let edge = |at: f64| (at * ratio).round() / ratio;
    let (left, top) = (edge(rect.x), edge(rect.y));
    let (right, bottom) = (edge(rect.x + rect.width), edge(rect.y + rect.height));
    [left, top, right - left, bottom - top]
}

async fn write_png(
    output: &str,
    view: Option<usize>,
    png: &[u8],
) -> Result<CapturedImage, CliError> {
    if let Some(parent) = Path::new(output).parent()
        && !parent.as_os_str().is_empty()
    {
        tokio::fs::create_dir_all(parent).await?;
    }
    tokio::fs::write(output, png).await?;
    Ok(CapturedImage {
        view,
        output: output.to_string(),
        pixels: png_size(png),
    })
}

/// The width and height a PNG's header declares.
fn png_size(png: &[u8]) -> [u32; 2] {
    let field = |at: usize| {
        png.get(at..at + 4)
            .and_then(|bytes| bytes.try_into().ok())
            .map_or(0, u32::from_be_bytes)
    };
    [field(16), field(20)]
}

#[cfg(test)]
mod tests {
    use super::*;
    use lucida_core::camera::Camera;
    use lucida_core::scene::ViewRecord;
    use lucida_core::view::{AxisPositions, ViewDatasets, ViewLayout};

    fn record(layout: ViewLayout, maximized: Option<usize>) -> ViewsRecord {
        let view = ViewRecord {
            camera: Camera::new_2d([400, 300]),
            axes: AxisPositions::default(),
            datasets: ViewDatasets::All,
            comparison: None,
        };
        ViewsRecord {
            layout,
            active: 0,
            maximized,
            views: vec![view; layout.rects().len()],
            links: None,
        }
    }

    #[test]
    fn each_view_is_written_beside_the_page() {
        assert_eq!(view_output("shots/pair.png", 1), "shots/pair-view-1.png");
        assert_eq!(view_output("pair.png", 0), "pair-view-0.png");
    }

    #[test]
    fn a_maximized_layout_shows_one_view() {
        assert_eq!(
            shown_views(&record(ViewLayout::Grid, None)),
            vec![0, 1, 2, 3]
        );
        assert_eq!(shown_views(&record(ViewLayout::Grid, Some(2))), vec![2]);
        let hidden = hidden_view(1, &record(ViewLayout::Grid, Some(2)));
        assert_eq!(hidden.kind, ErrorKind::MissingResource);
        assert!(hidden.message.contains("view 2 fills the canvas"));
        let past = hidden_view(4, &record(ViewLayout::Grid, None));
        assert!(past.message.contains("has 4 view(s)"));
    }

    #[test]
    fn a_pane_snaps_to_whole_device_pixels() {
        let pane = || PaneRect {
            x: 263.4,
            y: 48.0,
            width: 300.3,
            height: 200.0,
        };
        assert_eq!(snap(pane(), 1.0), [263.0, 48.0, 301.0, 200.0]);
        assert_eq!(snap(pane(), 2.0), [263.5, 48.0, 300.0, 200.0]);
    }

    #[test]
    fn the_png_header_gives_the_image_size() {
        let mut header = b"\x89PNG\r\n\x1a\n\0\0\0\rIHDR".to_vec();
        header.extend(800u32.to_be_bytes());
        header.extend(600u32.to_be_bytes());
        assert_eq!(png_size(&header), [800, 600]);
    }
}
