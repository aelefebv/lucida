---
type: Flow
title: "Flow: Headless Capture (montage + viewer screenshot/overview)"
description: "How a CLI/agent command turns a dataset into a PNG without a human at a browser: lucida dataset montage --out (a labeled contact sheet) and lucida viewer screenshot|overview (a single frame)."
tags: [lucida, flow]
source_path: wiki/flows/headless-capture.md
created: 2026-06-25
modified: 2026-07-16
---

# Flow: Headless Capture (montage + viewer screenshot/overview)

How a CLI/agent command turns a dataset into a PNG without a human at a browser: `lucida dataset montage <dataset> --out out.png --json` (a labeled contact sheet) and `lucida viewer screenshot|overview` (a single frame). The CLI plans the shot, composes an inline [SavedView](../systems/subsystems/saved-views.md), drives a headless Chrome over raw CDP, waits on a render-readiness contract the viewer publishes, captures the PNG(s), and (for montage) stitches + writes a drill-in sidecar. It is a genuine cross-surface flow — CLI ↔ headless browser ↔ the WebGPU [render loop](chunk-lifecycle.md) — invisible from any single crate. The CLI pieces are `montage.rs` (planning/stitching), `main.rs` (command dispatch), and `capture.rs` (all browser/CDP ownership); the viewer contract lives in [lucida-web](../systems/crates/lucida-web.md) (`App.tsx`, `renderLoop.ts`).

## Trace: `dataset montage`

1. **Fetch shape + authoritative members** — `DatasetWorkspaceClient::info` returns `dims = [T,C,Z,Y,X]`, the `workspace_dataset_id`, and the dataset's image roster. Each image summary carries its id, human name, dimensions, and parent/transform-aware position in the active layout — the same derived placement the renderer uses.
2. **Plan cells + grid** — `montage::plan_montage` picks a `MontageAxis` by priority: a multi-member collection samples evenly across that authoritative roster (both ends inclusive), else a Z>1 stack samples Z, else a T>1 series samples T, else a single cell. A collection cell retains the exact `image_id`, active-layout position, member extent, mid-Z, and a human `tile N: name` label; it never fabricates membership from a count. `grid_cols` lays a roughly-square grid capped at `--cols` (default 4).
3. **Probe one shared contrast window** — `build_cell_view` for the middle cell with `contrast: None` (auto on), wrapped in `with_render_param`, is loaded through `capture::probe_auto_contrast`, which reads `window.__lucidaAutoContrast`. The CLI then clips the low end (`BG_CLIP = 0.3`) to make ONE shared window for every cell. Per-cell auto-contrast would flatten a contact sheet (every cell the same brightness); a shared, background-clipped window keeps brightness comparable and through-stack structure visible. Best-effort: an unreadable probe falls back to per-cell auto.
4. **Compose per-cell inline views** — `CaptureOptions::scene_viewport` validates the requested CSS size + DPR and converts it once into Lucida's physical-backing-pixel camera convention. For each cell, `build_cell_view(ds_id, cell, viewport, shared_contrast)` builds a fit 2D `Slice` camera around that member's authoritative position/extent, applies the cell's z/t/c, makes the dataset visible, and leaves `datasets` EMPTY (workspace-dataset-id form — the dataset is already open in the target workspace). A pinned window also restores the channel's natural colormap (`default_for_channel`), which a bare explicit window would reset to gray. `viewer_inline_view_web_url` encodes the view as a `#view=<base64url(gzip(json))>` fragment.
5. **Two URLs per cell** — the clean interactive URL goes into the sidecar (`cells[].url`, for drill-in); `with_render_param` (`montage.rs:326`) adds `?render=1` ahead of the fragment for the actual capture.
6. **Capture in one browser process** — `capture::capture_many` launches Chrome once (`--headless=new --enable-unsafe-webgpu --ignore-gpu-blocklist`, temporary profile), discovers the DevTools endpoint from stderr, and drives one disposable browser context + target + session per URL. Each cell is closed before the next opens, so target memory remains O(1) instead of accumulating across a montage.
7. **Stitch + label** — `stitch_grid` (`montage.rs:280`) decodes the thumbnails, lays them row-major on a dark backdrop, and burns each cell's slice label into its corner (8×8 bitmap font) so the sheet is self-identifying — an agent reads the slice straight off the image.
8. **Write outputs** — the montage PNG, plus (with `--write-sidecar`) an `out.png.json` sidecar carrying axis/cols/rows, logical `cell_px`, `device_scale_factor`, the shared `contrast`, and per-cell `{index,row,col,z,t,c,tile,image_id,position,extent_yx,label,url}`. A cell at `(row,col)` maps to `cells[row*cols+col]` with no counting; `--json` independently prints the same value to stdout.

## Trace: `view screenshot` / `view overview`

Single-frame capture of a live or peer view (`main.rs:2968`/`:3020`).

1. **Resolve the view** — `--from-peer` pulls that peer's state and builds a `#view=` inline URL via `viewer_inline_view_web_url`; the default path uses the live viewer profile and a `?viewer_profile=<id>` URL via `viewer_profile_web_url` (`main.rs:3267`). `overview` requests an extents-fit framing.
2. **Capture** — dispatch constructs an explicit `CaptureOptions` and calls `capture::screenshot_to_path`. It prints the URL + output path (or JSON).

## The CDP capture core (shared)

`capture.rs` is the single browser boundary both surfaces use:

1. `Target.createBrowserContext(disposeOnDetach)` → `createTarget(about:blank)` → `attachToTarget(flatten)`.
2. `Network.enable`; if a token is present, Fetch interception adds `Authorization: Bearer …` only to the viewer origin rather than leaking it to cross-origin assets.
3. `Emulation.setDeviceMetricsOverride` receives width, height, and an explicit `deviceScaleFactor` (default 2; DPR 1 and 2 are contract-tested), then `Page.enable` + `Page.navigate(url)`.
4. **Two readiness gates**: `wait_for_page_ready` polls `document.readyState === 'complete' && a canvas exists`; then `wait_for_lucida_capture_ready` polls `LUCIDA_CAPTURE_READY_PROBE`.
5. `Page.captureScreenshot(fromSurface)` → base64 → `ensure_png_signature` → bytes.

The whole operation has one end-to-end deadline. Success and ordinary errors explicitly detach the session, close the target, dispose the context, stop/reap the browser, and close the temporary profile. Timeout or Ctrl-C cancellation drops the CDP socket (triggering `disposeOnDetach`), while child `kill_on_drop` and the profile's RAII guard prevent orphan processes and directories.

The probe reads `window.__lucidaCaptureReady` and only reports ready when `state.ready && frameCount > 0 && datasetCount > 0` AND the canvas has nonzero size — distinguishing "a real rendered frame with data" from "blank canvas mounted." The Rust mirror is `CaptureReadyProbe` (`main.rs:3912`); on timeout the failure reason is the probe's last `reason` (`missing_canvas` / `zero_size_canvas` / `missing_lucida_capture_ready` / a not-ready reason).

## The viewer side of the contract

Two pieces in [lucida-web](../systems/crates/lucida-web.md) make headless capture possible:

- **`?render=1` chrome-free surface** — `App.tsx` parses it once into `renderMode`; `useLayout` zeroes the sidebar and sizes the canvas to the full window, `App` drops the `ProfileMenu`, and render mode is authoritative over the inspector state so neither Saved Views nor Explore mounts even if one is selected/defaulted. The screenshot is pure data — no toolbar, sidebar, or fixed inspector covering a successfully rendered canvas.
- **`window.__lucidaCaptureReady`** — `renderLoop.ts::publishCaptureReady` (`:251`) writes the `LucidaCaptureReadyState` (`renderLoop.ts:21`: `ready`, `reason`, `frameCount`, `mode`, `datasetCount`, canvas size). `publishRenderedCaptureReady` sets `ready: true, reason: "rendered"` and increments `renderedFrameCount` only when datasets exist; an empty scene publishes `ready: false, reason: "no_datasets"`. This object IS the contract the CLI probe reads.

## Invariants

- **Inline capture views are workspace-dataset-id form** (empty `datasets`). The dataset is already open in the target workspace; the view never embeds source URLs.
- **The capture URL carries `render=1`; the sidecar URL does not.** Captures go through the chrome-free surface; drill-in links stay normal so a human/agent opens a usable viewer. `with_render_param` inserts the flag in the query string ahead of the `#view=` fragment.
- **A capture only proceeds on a real rendered frame.** `frameCount > 0 && datasetCount > 0` gates every CDP capture; a blank or dataset-less canvas never satisfies the probe and the command times out with a precise reason rather than saving an empty PNG.
- **Device scale factor is explicit.** Every capture contract carries it through `CaptureOptions`; the product default is DPR 2, and callers can select DPR 1–4 with `--device-scale-factor`. Pixel-limit checks count physical backing-store pixels, including the DPR-squared cost. CLI-synthesized SavedViews use `CaptureOptions::scene_viewport`, so both viewport and fit zoom scale with DPR and the world field of view stays invariant. Explicit caller-supplied Explore views are preserved rather than rewritten.
- **Only one montage target is live at a time.** The browser process is reused, but each context/target/session is disposed before the next cell begins.
- **One shared contrast window across a montage** (when the probe succeeds); the sidecar's `contrast` and every captured cell use the same window, so drilling into a cell matches what the sheet showed.

## Gotchas

- **`__lucidaCaptureReady` is a hand-shook contract, not an API.** A viewer change that stops publishing it, renames a field, or stops setting `ready`/`frameCount` silently breaks every CLI capture (montage, screenshot, overview, and the tryout harness) — the symptom is a render-timeout, not a build error. The Rust-side `LUCIDA_CAPTURE_READY_PROBE` JS string and the `LucidaCaptureReadyState` shape must stay in lockstep.
- **The CDP client is hand-rolled.** Raw `Target/Page/Runtime/Emulation` calls over a WebSocket (`cdp_call`), Chrome discovered by `find_browser_binary` (`LUCIDA_BROWSER` override, then known macOS/PATH names). No puppeteer; a Chrome protocol change lands here.
- **Collection identity comes from `dataset info`, not roster guesses.** Images without dimensions cannot be safely framed and are excluded from the montage-member input; every emitted collection cell carries the selected member id, active-layout position, and extent in its sidecar so a capture can be audited and reopened.
- **WebGPU must be available in headless Chrome.** The flags force it on, but a host without a usable GPU stack yields a never-ready probe (the frame never renders) rather than a clear "no GPU" message.

## Related

- [lucida-cli](../systems/crates/lucida-cli.md) — the command surface this flow lives in
- [Saved Views](../systems/subsystems/saved-views.md) — the `SavedView` type + `#view=` encoding the inline capture URL carries
- [Flow: Saved-View Recipient Apply](saved-view-recipient-apply.md) — how the viewer applies the `#view=` the CLI hands it
- [Flow: Chunk Lifecycle](chunk-lifecycle.md) — the render loop whose `renderedFrameCount` the readiness probe gates on
- [Flow: Dataset Opening](dataset-opening.md) — the path the captured viewer takes to load the dataset before the first frame
