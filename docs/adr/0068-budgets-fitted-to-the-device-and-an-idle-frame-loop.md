# Budgets fitted to the device, and an idle frame loop

Status: Accepted.

## Context

The viewer's GPU and memory budgets were fixed at desktop sizes: a 512 MB
volume atlas per pool allocated in full on the first 3D frame, 512 MB of label
atlas, about 830 MB of CPU cache, and a render target at the raw device pixel
ratio, so a 3x phone rendered nine times the pixels of its CSS size. Phones and
small tablets share that memory with the system and kill a tab that takes too
much. The layers that follow the camera also polled it every animation frame,
so an untouched viewer never let the device sleep.

## Decision

**Render resolution.** The render target gets at most 2 device pixels per CSS
pixel. While a gesture's frames run long (over 33 ms from dispatch until the
worker reports the GPU work done, on the page's own clock) the resolution steps
down by a fifth per frame drawn at the new size, to half, and comes back 250 ms
after the last input. The camera, planning, hit testing, and every overlay keep
working in device pixels at the full ratio; only the target shrinks and the
browser scales it up, as the 2D path already did past 4K. A machine whose
frames are quick never leaves full resolution.

**Budgets.** One function maps the device's memory to every budget. Today's
sizes are the ceiling, reached at 8 GiB or more and whenever the browser
doesn't say; below 8 GiB each scales linearly down to a floor that still fits a
viewport's chunks. The page reads `navigator.deviceMemory`. Safari reports
nothing, so a touch-only device that reports nothing is taken to have 4 GiB,
while a desktop that reports nothing keeps the ceiling. The page fits the CPU
cache and the label caps (fetch and render must agree on those, and both run on
the page); the render worker gets the page's reading at init and also holds each
GPU atlas to the adapter's `maxBufferSize`. Trace-driver knobs still override.

**Lazy volume atlas.** A volume pool starts one layer of slots deep and doubles
its layers when every slot holds a chunk, up to the budget. Slot positions
depend only on the row and column counts, which never change, so growing is one
texture copy and the indirection stays valid. A small volume never allocates the
budget; a large one reaches it only as it fills. Each step briefly holds the old
texture beside the new one, so the peak stays under twice the budget.

**Idle.** The render loop already ran only when dirty. The camera-following
layers now share one frame clock that runs while anything changes: input on the
page, any render-loop dirty (which covers data arrival, camera, peers, playback,
and resize), or a layer's own render. It stops 500 ms after the last wake, at
once when the page is hidden, and keeps going only while a subscriber says so,
as a held camera key does. The developer FPS readout keeps its own loop, since
measuring the frame rate is its job.

**No WebGPU.** A browser without `navigator.gpu`, or whose adapter request
fails, shows a message in place of the viewer saying what to use instead.

## Rejected

- Planning at the capped ratio. It would fetch less on a 3x phone, but it moves
  the level choice away from what `--zoom` and saved views mean, and the
  adaptive step would change levels mid-gesture.
- A total GPU budget across pools. The per-pool budget is what desktops have
  today, and growth already keeps a pool to what it holds.
- Growing pools in every axis. Moving resident slots means remapping the
  indirection and copying slot by slot.
- Driving the overlays from the render loop's tick. A held key, a draft shape,
  and a peer's cursor change without the canvas needing a new frame.
