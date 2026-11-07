# The trace driver and the page export seam

Status: Accepted. Amended by [#1048]: opt-in push paths and scripted steps.

## Context

`lucida trace` drives a run in headless Chrome over CDP and prints the
diagnostic. An agent driving its own browser must get the same bytes without the
command. `lucida debug state` looked like the pipe to extend, but it reads the
server's handshake snapshot and computes in the CLI. It never reaches a
renderer, and its own caveats say it has no renderer, CPU-cache or worker state.

## Decision

The seam is a documented function on the page, `window.lucidaTrace`, present in
every build and returning the [0047](0047-trace-model-phases-runs-and-lifecycle-rows.md)
document with its schema version. The driver, an agent's own browser, the
monitor's save button and Send report all call it, and the CLI reaches it by CDP
evaluation. It is public interface, versioned like a wire type. Dev globals
behind `import.meta.env.DEV` are invisible to a driver against a production
bundle, and a diagnostic that only exists in development cannot explain a field
report.

The CLI holds no diagnostic logic, so an agent's own browser is not a
second-class caller. Thresholds, attribution and the verdict are computed behind
the seam, and the CLI, the dock, the HUD and the overlay modes render what they
are handed. A bundle the driver writes and one a person sends are the same
artifact, with a header that can replay the view elsewhere. The CLI fetches
nothing from the server, because server rows already reach the page
([0050](0050-server-timings-reach-the-monitor.md)) and the seam returns a merged
document to every caller.

For sessions the CLI did not start, the field-report case, two opt-in push paths
join the pull. Send report posts a bundle to a workspace inbox the CLI can list
and fetch. The watch toggle streams the per-tick aggregate and run boundaries
through the server to the CLI, which prints line-delimited JSON with a reading
labelled provisional that no gate reads. Both are off by default, the watch
toggle is off again after a reconnect, and rows never ride the watch stream.

Settling is a predicate the page publishes. `quiescent` holds when no dirty flag
is set, no frame is in flight, and the CPU cache has everything it was asked
for. The driver waits for it to hold for 500 ms, and the hold goes in the run
header because every duration includes it. Prefetch is left out, since a
timeseries keeps prefetching; what is outstanding at settle goes in coverage. A
run that never settles still closes on a timeout and prints, and every run
records why it ended. The driver writes the full document to disk, because it
kills its browser at teardown and the follow-up commands read the run by id.

Defaults are workload choices, recorded in the run header. Device pixel ratio
defaults to 2, because it quadruples the pixels to fill and DPR-1-only
verification has hidden whole defect classes. Image captures keep 1, where the
ratio only sets the image size. `?render=1` writes no persisted state, so a
headless run neither writes a camera into the workspace nor waits out a
debounce. The command needs a running server, and the header records server
warmth, since a repeat open through the source cache took 0.02 s against 5.8 s
cold ([#902]).

`lucida trace` is top level, since its follow-ups take a run id, not a dataset.
A stall exits zero unless `--gate` is passed, because every other non-zero exit
in the CLI means the command failed. The gate fails on a stall verdict or an
unsettled run, never on coverage alone, since most of a healthy cold open is
pre-instrument boot.

The driver also runs scripted steps, sets Dev controls knobs by the names the
panel shows, replays a bundle, and diffs two runs. Steps go through the page's
own input handling, and the view is read after each step so a step that did not
land shows in the run. The monitor stays observation only.

The launcher decides which GPU a run measures. On Linux, headless Chrome uses
SwiftShader unless started with `--enable-features=Vulkan --use-angle=vulkan
--disable-vulkan-surface`. The first `requestAdapter()` after a cold launch can
return `null` for seconds, so the page retries within a bound.

On headless Linux under Vulkan, DevTools `Page.captureScreenshot` leaves the
WebGPU canvas out and returns black in its place. So the frame in a bundle
(`--bundle`) is the page's own capture of its canvas. The driver's screenshot is
a fallback for when that capture fails, and a fallback whose canvas region is
one flat colour is recorded as an absent frame.

## Rejected alternatives

- Extending `lucida debug state`. It never reaches the browser.
- Routing the trace through the server as the main path. That adds a protocol
  variant, a size question on the socket and server-side retention, to move
  bytes CDP already reaches. It is now taken in part, with each cost bounded,
  for sessions the CLI did not start.
- Inferring settle by watching frames stop. A stalled pipeline and a finished
  one both stop drawing.
- Outwaiting the camera debounce. The run would still write user state.
- A non-zero exit on a stall by default, or a gate on coverage. The first breaks
  pipes that read non-zero as "the tool broke", and the second fires on every
  green run.

## Consequences

`?render=1` carries a behavioural rule, no state writes, on top of its visual
one. Anything added to the capture surface inherits it.

[#902]: https://github.com/aelefebv/lucida/issues/902
[#1048]: https://github.com/aelefebv/lucida/issues/1048
