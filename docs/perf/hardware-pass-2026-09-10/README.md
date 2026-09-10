# Hardware pass: the monitor on an NVIDIA L4

The monitor redesign (#1048, tickets #1049 to #1068) merged with every pull
request marked "not verified on hardware". This pass ran the merged main
(`16e36a19`, build 0.15.0) on a real GPU and recorded what each surface did.

## Environment

| Item | Value |
| --- | --- |
| GPU | NVIDIA L4, 23 GiB, driver 580.173.02, Secure Boot on |
| OS and browser | Ubuntu 24.04, Google Chrome 153 headless with the Vulkan flags from #1091 |
| Adapter as the page sees it | `nvidia` / `lovelace`, hardware adapter, timestamp queries on |
| Server | `lucida-server` on loopback, `fixtures/ome-zarr/level-index.ome.zarr` (32 x 64 x 64, 16³ chunks, 4 levels) |
| Viewport | 1440 x 900 CSS pixels at device pixel ratio 2 |

## The driver

Every command ran against the loopback server with the CLI's own launcher.

| Command | Result |
| --- | --- |
| `lucida trace <id> --bundle --screenshot` | Settled after 690 ms. `header.gpu` reads `nvidia lovelace`, `fallback: false`, `timestampQueries: true`. The bundle carries a 2880 x 1800 frame from the driver ([slice](driver-frame-slice.png)). |
| `trace show` at every depth | Default, `--phases`, `--phase browser.wire`, `--window 0..300`, `--spatial`, and `--chunk` all render. The window depth restates coverage over the window. |
| `--pan 120,60 --zoom-by 1.5 --scrub z:1 --hold 300 --wait` | One run per step, each with its cause and verdict. GPU pass recorded through timestamp queries: p50 1.2 ms, n=12. |
| `--camera arcball --orbit 30,10` | An orbit run in volume mode ([frame](driver-frame-volume.png)). GPU pass p50 0.9 ms, n=28. |
| `--prefetch-depth 2 ... --versus --prefetch-depth 0` | Two runs, comparable, with `planning.prefetchDepth 2 → 0` listed as the experiment. |
| `trace diff` of unlike runs | Leads with `NOT COMPARABLE` for cause and browser cache warmth. |
| `trace replay <bundle>` | Restored the dataset, view URL, viewport, pixel ratio, mode, planning configuration, pins, and cache warmth. Not restored: build and adapter, each with the reason. The diff against the original is clean, wall +1%. |
| `trace watch --seconds 10 --json` | Boundaries (`watch_started`, `run_opened`, `run_closed`, `watch_stopped`) and aggregates with `gpuPassUs` about 1029. |
| `trace inbox list` and `fetch` | The report the dock sent is listed with its run, view, sender, and expiry, fetches as a bundle, and `trace show` reads it. |

## The page

Headless Chrome on the L4, driven over the DevTools protocol by
[`scripts/ui_pass.py`](scripts/ui_pass.py) with a standard-library client
([`scripts/cdp.py`](scripts/cdp.py)). Each frame is a 1440 x 900 capture,
halved from the device-pixel original. [`ui-summary.json`](ui-summary.json)
holds what the page said at each step.

| Surface | Frame | What it shows |
| --- | --- | --- |
| Viewer, quiet | [01](01-viewer-slice.png) | Slice mode after the open settled. |
| HUD strip (`h`) | [02](02-hud.png) | Sent and received sparklines, tier bars, in-flight by lane, quiescence, the adapter line, and the overlay legend. |
| Phase overlay | [03](03-overlay-phase.png) | Cells coloured by phase during a cold load. The overlay reads the open interval, so the frame is taken while the open's run is recording. |
| Churn overlay | [04](04-overlay-churn.png) | The absence statement on a quiet page: no chunk on screen has a row in the open interval. |
| Inspector | [05](05-overlay-inspector.png) | Hovering a cell: phase, `present took 144 ms`, queue rank, age, fetched once. |
| Dock | [06](06-dock.png), [06b](06b-dock-timeline.png) | The report over the open's run and the timeline beneath it. |
| Brush | [07](07-brush.png) | A window brushed on the axis; 17 of 17 chunks highlighted on the viewport, the show command printed. |
| Brush, drilled | [08](08-brush-drill.png) | Drilling into the verdict narrows the published set to `browser.present`. |
| Send report | [09](09-send-report.png) | The receipt with the entry id and the fetch command. |
| Watch stream | [10](10-watch.png) | The toggle on, the session banner, while the CLI received the stream. |
| Compare mode | [11](11-compare.png), [12](12-compare-timelines.png), [12b](12b-compare-tables.png) | The baseline bundle against its replay: two aligned timelines, header, phase, and finding tables, and the CLI's text. |
| Dropped bundle | [12c](12c-dropped-bundle.png) | A bundle read on its own, with its settled frame beside the report. |
| Boxes, phase | [13](13-boxes-phase.png) | Wireframe boxes coloured by phase while the volume loads. |
| Boxes, grid | [13b](13b-boxes-grid.png) | The chunk grid as boxes in volume mode, batched by style. |
| Box hover | [14](14-box-hover.png) | The box under the pointer drawn on its own, with the inspector. |
| Boxes, brushed | [15](15-boxes-brush.png) | 33 chunks highlighted as boxes; the rest faded. |

## Findings

1. **The dock's header does not wrap at 1440 px.** With every action offered, the watch status text is squeezed to one word per line and the run select and buttons stretch to match ([06](06-dock.png)). `.monitor-chrome-actions` has no `flex-wrap`.
2. **`browser.present` ran p95 about 140 ms on the page's own cold open**, three loads out of three, and the verdict calls it a stall ([08](08-brush-drill.png)). The same open on the chrome-free capture surface presents in about 17 ms. The difference is the page's chrome mounting during the first frames.
3. **A bundle sent from the page carries no frame on this host.** The receipt's bundle lists the frame as absent, "the render worker could not read its canvas". The driver's bundles carry the frame.
4. **The steady-state ruleset was not exercised.** An empty steady-state interval is not retained, and on a local fixture nothing follows the open, so `trace show` reports no interval to read. This is by design.
5. **The trace-reading overlays colour only the open interval.** On a local fixture a run is open for well under a second, so the phase and churn frames had to be taken during a cold load. On a slow open this is the moment they are for.
6. **The HUD's GPU pool reads "not reported"** in slice and volume mode alike. By design: the render worker reports no resident bytes.
7. **`trace watch` replays earlier items on subscribe.** The stream began with runs from earlier sessions in the workspace before the live ones.
8. Cosmetic: the frame-time legend wraps "GPU pass" across two lines with its value between them ([08](08-brush-drill.png)).

## Reproduce

Build on a host with the toolchain, copy the binaries, `lucida-web/dist`, and
the fixture to the GPU host, start the server against the dist, open the
fixture in a fresh workspace, then run the driver commands in the first table
and `python3 scripts/ui_pass.py <lucida dir> <out dir>` beside the server.
