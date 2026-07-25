---
type: Gotcha
title: "Verify Rendering at devicePixelRatio 2, Not Just 1"
description: "A retina backing store doubles the pixels the GPU fills per frame; per-tile-scaled frame cost can hit a completion cliff invisible at DPR 1, and headless browsers default to DPR 1."
tags: [lucida, gotcha]
source_path: wiki/gotchas/retina-dpr2-render-verification.md
created: 2026-07-08
modified: 2026-07-25
---

# Verify Rendering at devicePixelRatio 2, Not Just 1

## The footgun

The canvas backing store is sized in **device** pixels: `cssPixels ×
devicePixelRatio`. On a retina display (DPR 2) an ~800×600 CSS canvas is a
1600×1200 backing — **4× the pixels** the GPU must fill every frame — for the
same window. Any per-frame cost that scales with *screen* pixels (or, worse,
with something proportional to it) therefore has ~4× the headroom pressure at
DPR 2 than at DPR 1.

When that pressure crosses the frame-completion budget, the failure is
**silent and total**, not a graceful slowdown: the frame never presents, so
there is no first paint, no residency/upload feedback, and no auto-contrast
bootstrap — a permanently **black viewer with zero console errors** (the FPS
badge may even read ~120, because the compositor worker keeps presenting empty
frames). See the wide-collection overview case: at DPR 1 it limped at 21–28
FPS; at DPR 2 the same code was a permanent black screen (fixed by making
overview render passes screen-bounded rather than one-per-tile).

## Why it hides

**Headless Chromium and Playwright default to `deviceScaleFactor: 1`.** So
does most CI. An all-headless verification pass — however thorough — only ever
exercises the easy half of the matrix. This exact blind spot let a
retina-only black-screen defect survive multiple full verification passes over
two days: every automated browser ran DPR 1, every human reviewer's machine
was a retina Mac. The bug wasn't subtle; the *environment* was.

## The rule

Any live/rendering verification (Playwright/CDP drive, tryout harness,
screenshot gate) must run **both** `deviceScaleFactor: 2` and `1` — and the
DPR 2 arm is the one that gates, since it is the stricter and the one real
users on retina hardware actually hit. In Playwright: `browser.newContext({
deviceScaleFactor: 2 })`; via raw CDP: `Emulation.setDeviceMetricsOverride`
with `deviceScaleFactor: 2`. Confirm a *content* frame actually presents (pixel
sample the main canvas, or check the frame counter advances) — a green unit
suite and a "loads without error" check both pass while the screen is black.

## Where the rule is enforced

The tryout harness's web-surface ceiling is the durable backstop: it drives the
real SPA at `deviceScaleFactor` **2 and 1** on every run and the DPR 2 arm gates
the surface (`extras/tryout/tryout/surfaces/web_surface.py` —
`judge_render_arm` / `build_render_gate`). Three properties make it able to catch
this defect class rather than merely mention it:

- **The verdict is canvas pixels, not the absence of an error.** An arm passes
  only if the **centre 60% × 60%** of the main canvas is not one flat colour.
  Neither of the cheaper checks works: the full page is richly coloured because
  the SPA chrome renders fine while the viewer is black, and an element-clipped
  canvas shot composites the corner-anchored overlays (FPS badge, orientation
  cube, minimap) that supply a spurious second colour. Against a black stand-in
  viewer the canvas crop had 27 distinct colours and the repo's own
  `scripts/assert_png_nonblank.py` passed it; the centre had 1.
- **`window.__lucidaCaptureReady` is checked but never trusted alone.** It is
  published from the JS side of a WebGPU submit, so it reports `ready: true` with
  a climbing `frameCount` on a frame the GPU never presented — which is precisely
  what this defect does.
- **Each arm proves it really was the scale factor it claims** (observed
  `devicePixelRatio` *and* the captured image's scale versus its CSS box), so a
  retina arm that silently degrades to DPR 1 fails loudly instead of manufacturing
  confidence about the untested half of the matrix. For the same reason, a run
  where no browser could be provisioned reports the gate as **not enforced**
  rather than passing (`LUCIDA_TRYOUT_REQUIRE_DPR2=1` makes it fatal).

Scenario UI captures (`extras/tryout/tryout/scenarios/_browser.py`) default to
`deviceScaleFactor` 2 for the same reason. Still **not** covered: the product
CLI's own capture path (`lucida-cli/src/main.rs`) hardcodes `deviceScaleFactor: 1`
in its `Emulation.setDeviceMetricsOverride` calls, so the harness *floor* is DPR 1
only.

## Interactions

- [Upload Budgets Are Per-Frame and Per-Path](upload-budgets-per-frame.md) —
  per-frame budgets interact with backing size; profile at DPR 2.
- [Minimap Skip-When-Stationary via Render Key](minimap-render-key.md) — the
  render-cost story the overview path had to learn from.
- The camera/viewport sets the WebGPU viewport from `clientWidth ×
  devicePixelRatio` (see `lucida-web/src/slicePath.ts`), which is where the
  DPR multiplier enters the render path.
