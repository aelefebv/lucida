---
created: 2026-04-18
modified: 2026-05-17
---

# Upload Budgets Are Per-Frame and Per-Path

## The footgun

The uploader sends CpuCache deliverables to the GPU within a strict per-frame byte budget, separately for the main view and the minimap:

- **Main view (slice + volume)**: 8 MB / frame
- **Minimap**: 2 MB / frame

If a single chunk exceeds the remaining budget, the uploader still sends it when it is the next priority item, then stops after that one-item soft-cap overshoot. Multiple medium chunks deplete the budget proportionally.

The footgun: **changing the budget without measuring is risky**.

- Lower the budget → uploads stretch across more frames; visible loading takes longer; fewer chunks land per frame so other costs (descriptor updates, bind-group rebuilds) get amortized over fewer chunks.
- Raise the budget → individual frames take longer (visible jank during burst loading); GPU upload pipeline can saturate; competition with rendering increases.

## What to look at before changing

The [[lucida-web|debug panel]] surfaces:

- Bytes uploaded per frame (rolling average)
- Chunks pending decode
- Deliverables pending in [[cpu-cache]]
- Worker's `chunksEvicted` rate

If pending deliverables grow monotonically, the budget is too low. If render frame times spike during loading, it's too high.

## Where the constants live

`lucida-web/src/pipeline/upload/constants.ts` has `MAIN_VIEW_UPLOAD_BUDGET_BYTES`. The minimap equivalent lives with the minimap/render-loop path.

The minimap budget being separate (and smaller) is intentional: the minimap renders rarely, so it doesn't need to compete with main-view bandwidth.

## What to do

- **Profile before changing.** The defaults are tuned, not arbitrary.
- **Change in 2× steps** if you must, not 10×. Behavior is non-linear at the limits.
- **Check the per-second telemetry**, not just per-frame. A budget that looks fine per-frame can starve over a second.
- **Watch for cascade effects.** Lowering the budget can backpressure the [[cpu-cache]] into evicting more aggressively, which causes re-fetches.

## Related

- [[chunk-pipeline]]
- [[cpu-cache]]
- [[gpu-residency]]
