---
type: Flow
title: "Flow: Headless Capture (montage + viewer screenshot/overview)"
description: "How a CLI/agent command turns a dataset into a PNG without a human at a browser: lucida dataset montage out.png --json (a labeled contact sheet) and lucida view screenshot|overview (a single frame)."
tags: [lucida, flow]
source_path: wiki/flows/headless-capture.md
created: 2026-06-25
modified: 2026-06-25
---

# Flow: Headless Capture (montage + viewer screenshot/overview)

How a CLI/agent command turns a dataset into a PNG without a human at a browser: `lucida dataset montage out.png --json` (a labeled contact sheet) and `lucida view screenshot|overview` (a single frame). The CLI plans the shot, composes an inline [SavedView](../systems/subsystems/saved-views.md), drives a headless Chrome over raw CDP, waits on a render-readiness contract the viewer publishes, captures the PNG(s), and (for montage) stitches + writes a drill-in sidecar. It is a genuine cross-surface flow — CLI ↔ headless browser ↔ the WebGPU [render loop](chunk-lifecycle.md) — invisible from any single crate. All code is in [lucida-cli](../systems/crates/lucida-cli.md) (`montage.rs`, `main.rs`) and a small contract in [lucida-web](../systems/crates/lucida-web.md) (`App.tsx`, `renderLoop.ts`).

## Trace: `dataset montage`

1. **Fetch shape** — `DatasetWorkspaceClient::info` returns `dims = [T,C,Z,Y,X]` and the `workspace_dataset_id` (`main.rs:~2085`).
2. **Plan cells + grid** — `montage::plan_montage` (`montage.rs:82`) picks a `MontageAxis` by priority: a multi-field plate samples fields, else a Z>1 stack samples Z (evenly, both ends inclusive), else a T>1 series samples T, else a single cell. `grid_cols` lays a roughly-square grid capped at `--cols` (default 4).
3. **Probe one shared contrast window** — `build_cell_view` for the middle cell with `contrast: None` (auto on), wrapped in `with_render_param`, is loaded by `probe_montage_auto_contrast` → `capture_cdp_auto_contrast`, which reads `window.__lucidaAutoContrast`. The CLI then clips the low end (`BG_CLIP = 0.3`) to make ONE shared window for every cell. Per-cell auto-contrast would flatten a contact sheet (every cell the same brightness); a shared, background-clipped window keeps brightness comparable and through-stack structure visible. Best-effort: an unreadable probe falls back to per-cell auto.
4. **Compose per-cell inline views** — for each cell, `build_cell_view(ds_id, cell, full_x, full_y, viewport, shared_contrast)` (`montage.rs:179`) builds a `SavedView` with a fit 2D `Slice` camera, the cell's z/t/c, the dataset visible, and EMPTY `datasets` (workspace-dataset-id form — the dataset is already open in the target workspace). A pinned window also restores the channel's natural colormap (`default_for_channel`), which a bare explicit window would reset to gray. `viewer_inline_view_web_url` (`main.rs:3274`) encodes it as a `#view=<base64url(gzip(json))>` fragment.
5. **Two URLs per cell** — the clean interactive URL goes into the sidecar (`cells[].url`, for drill-in); `with_render_param` (`montage.rs:326`) adds `?render=1` ahead of the fragment for the actual capture.
6. **Capture in one browser session** — `capture_montage_pngs` (`main.rs:3360`) launches Chrome once (`--headless=new --enable-unsafe-webgpu --ignore-gpu-blocklist`, ephemeral user-data-dir), discovers the DevTools endpoint from stderr, and drives `capture_cdp_png` per URL (a fresh target each) — far cheaper than relaunching per cell.
7. **Stitch + label** — `stitch_grid` (`montage.rs:280`) decodes the thumbnails, lays them row-major on a dark backdrop, and burns each cell's slice label into its corner (8×8 bitmap font) so the sheet is self-identifying — an agent reads the slice straight off the image.
8. **Write outputs** — the montage PNG, plus (with `--json`) an `out.png.json` sidecar carrying axis/cols/rows, the shared `contrast`, and per-cell `{index,row,col,z,t,c,field,label,url}` so a cell at `(row,col)` maps to `cells[row*cols+col]` with no counting.

## Trace: `view screenshot` / `view overview`

Single-frame capture of a live or peer view (`main.rs:2968`/`:3020`).

1. **Resolve the view** — `--from-peer` pulls that peer's state and builds a `#view=` inline URL via `viewer_inline_view_web_url`; the default path uses the live viewer profile and a `?viewer_profile=<id>` URL via `viewer_profile_web_url` (`main.rs:3267`). `overview` requests an extents-fit framing.
2. **Capture** — `capture_viewer_screenshot` (`main.rs:3293`) launches Chrome and calls the same `capture_cdp_png`. It prints the URL + output path (or JSON).

## The CDP capture core (shared)

`capture_cdp_png` (`main.rs:3685`) is the single capture primitive both surfaces use:

1. `Target.createTarget` (`about:blank`) → `attachToTarget(flatten)` → a session id.
2. `Network.enable`; if a token is present, `Network.setExtraHTTPHeaders` with `Authorization: Bearer …` (so authed servers load).
3. `Emulation.setDeviceMetricsOverride` to the requested width/height, then `Page.enable` + `Page.navigate(url)`.
4. **Two readiness gates**: `wait_for_page_ready` polls `document.readyState === 'complete' && a canvas exists`; then `wait_for_lucida_capture_ready` polls the `LUCIDA_CAPTURE_READY_PROBE` (`main.rs:3860`).
5. `Page.captureScreenshot(fromSurface)` → base64 → `ensure_png_signature` → bytes.

The probe reads `window.__lucidaCaptureReady` and only reports ready when `state.ready && frameCount > 0 && datasetCount > 0` AND the canvas has nonzero size — distinguishing "a real rendered frame with data" from "blank canvas mounted." The Rust mirror is `CaptureReadyProbe` (`main.rs:3912`); on timeout the failure reason is the probe's last `reason` (`missing_canvas` / `zero_size_canvas` / `missing_lucida_capture_ready` / a not-ready reason).

## The viewer side of the contract

Two pieces in [lucida-web](../systems/crates/lucida-web.md) make headless capture possible:

- **`?render=1` chrome-free surface** — `App.tsx` parses it once into `renderMode` (`:116`); `useLayout` zeroes the sidebar and sizes the canvas to the full window (`useLayout.ts`), and `App` drops the `ProfileMenu` and adds the `render-mode` class. The screenshot is pure data — no toolbar/sidebar.
- **`window.__lucidaCaptureReady`** — `renderLoop.ts::publishCaptureReady` (`:251`) writes the `LucidaCaptureReadyState` (`renderLoop.ts:21`: `ready`, `reason`, `frameCount`, `mode`, `datasetCount`, canvas size). `publishRenderedCaptureReady` sets `ready: true, reason: "rendered"` and increments `renderedFrameCount` only when datasets exist; an empty scene publishes `ready: false, reason: "no_datasets"`. This object IS the contract the CLI probe reads.

## Invariants

- **Inline capture views are workspace-dataset-id form** (empty `datasets`). The dataset is already open in the target workspace; the view never embeds source URLs.
- **The capture URL carries `render=1`; the sidecar URL does not.** Captures go through the chrome-free surface; drill-in links stay normal so a human/agent opens a usable viewer. `with_render_param` inserts the flag in the query string ahead of the `#view=` fragment.
- **A capture only proceeds on a real rendered frame.** `frameCount > 0 && datasetCount > 0` gates every CDP capture; a blank or dataset-less canvas never satisfies the probe and the command times out with a precise reason rather than saving an empty PNG.
- **One shared contrast window across a montage** (when the probe succeeds); the sidecar's `contrast` and every captured cell use the same window, so drilling into a cell matches what the sheet showed.

## Gotchas

- **`__lucidaCaptureReady` is a hand-shook contract, not an API.** A viewer change that stops publishing it, renames a field, or stops setting `ready`/`frameCount` silently breaks every CLI capture (montage, screenshot, overview, and the tryout harness) — the symptom is a render-timeout, not a build error. The Rust-side `LUCIDA_CAPTURE_READY_PROBE` JS string and the `LucidaCaptureReadyState` shape must stay in lockstep.
- **The CDP client is hand-rolled.** Raw `Target/Page/Runtime/Emulation` calls over a WebSocket (`cdp_call`), Chrome discovered by `find_browser_binary` (`LUCIDA_BROWSER` override, then known macOS/PATH names). No puppeteer; a Chrome protocol change lands here.
- **Per-field plate montage is not wired yet.** `dataset montage` plans as a single image (`plan_montage(dims, 1, …)` at the call site) even though `MontageAxis::Field` exists — member positions are a follow-up slice. A plate currently montages by Z/T of field 0.
- **WebGPU must be available in headless Chrome.** The flags force it on, but a host without a usable GPU stack yields a never-ready probe (the frame never renders) rather than a clear "no GPU" message.

## Related

- [lucida-cli](../systems/crates/lucida-cli.md) — the command surface this flow lives in
- [Saved Views](../systems/subsystems/saved-views.md) — the `SavedView` type + `#view=` encoding the inline capture URL carries
- [Flow: Saved-View Recipient Apply](saved-view-recipient-apply.md) — how the viewer applies the `#view=` the CLI hands it
- [Flow: Chunk Lifecycle](chunk-lifecycle.md) — the render loop whose `renderedFrameCount` the readiness probe gates on
- [Flow: Dataset Opening](dataset-opening.md) — the path the captured viewer takes to load the dataset before the first frame
