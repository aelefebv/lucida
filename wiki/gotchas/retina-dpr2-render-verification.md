---
type: Gotcha
title: "Verify Rendering at devicePixelRatio 2, Not Just 1"
description: "A retina backing store doubles the pixels the GPU fills per frame; per-tile-scaled frame cost can hit a completion cliff invisible at DPR 1, and headless browsers default to DPR 1."
tags: [lucida, gotcha]
source_path: wiki/gotchas/retina-dpr2-render-verification.md
created: 2026-07-08
modified: 2026-07-08
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

## Interactions

- [Upload Budgets Are Per-Frame and Per-Path](upload-budgets-per-frame.md) —
  per-frame budgets interact with backing size; profile at DPR 2.
- [Minimap Skip-When-Stationary via Render Key](minimap-render-key.md) — the
  render-cost story the overview path had to learn from.
- The camera/viewport sets the WebGPU viewport from `clientWidth ×
  devicePixelRatio` (see `lucida-web/src/slicePath.ts`), which is where the
  DPR multiplier enters the render path.
