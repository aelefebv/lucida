---
type: Subsystem
title: "Camera and Navigation"
description: "How Lucida moves the viewpoint through a dataset, and how raw keyboard/pointer input becomes camera motion."
tags: [lucida, subsystem]
source_path: wiki/systems/subsystems/camera-and-navigation.md
created: 2026-06-25
modified: 2026-06-25
---

# Camera and Navigation

How Lucida moves the viewpoint through a dataset, and how raw keyboard/pointer input becomes camera motion. The camera *model* is canonical in [lucida-core](../crates/lucida-core.md)'s `camera.rs`; the *input layer* (keybinding registry, RAF-driven loops, the mode/focal-depth UI) lives in `lucida-web`. The two are deliberately split: the math is testable in Rust with no DOM, and the web side only ever calls into WASM.

## Three camera models, one enum

`Camera` is a tagged enum (`#[serde(tag = "mode")]`) with three variants, each a distinct navigation paradigm:

- **`Slice`** — 2D pan/zoom. `center` + `zoom` + `viewport`. This is the only model used in 2D viewing; `pan` divides by zoom (so panning feels constant in screen pixels) and `effective_zoom` *is* `zoom`.
- **`Arcball`** — 3D orbit. Spherical `(theta, phi, distance)` around a `target`. Phi is intentionally **unconstrained** (no gimbal clamp) — the spherical up-vector is recomputed every frame so the view matrix stays finite at any phi. This is the default 3D model.
- **`Fly`** — 3D first-person. `position` + quaternion `orientation`. Advanced by `fly_tick(dt, forward, right, up, yaw, pitch, roll)`; movement is in camera-local axes, scaled by `base_speed * speed_multiplier`.

The enum holds `f64`, so it derives `PartialEq` but not `Eq` — which is what lets a [SavedView](saved-views.md) embedded on an annotation derive `PartialEq` too.

`Camera` exposes a uniform surface regardless of variant: `viewport`/`set_viewport`, `effective_zoom`, `eye_position`, `project_to_screen` (returns `None` behind the camera in 3D), `unproject_ray`, and `visible_region`. Everything downstream — picking, [planning](planning-domain.md), presence — talks to this surface, not the variant.

## View mode is derived, not stored

There is no separate "2D vs 3D" flag in core. The **view mode is a function of the camera variant**: `Slice` ⇒ 2D, `Arcball`/`Fly` ⇒ 3D. The web mirrors this in two pieces of React state that must be kept in sync with the WASM camera:

- `viewMode` (`useDimensions.ts`) — `"2d" | "3d"`. The **2D/3D toggle** (`handleViewModeToggle`) flips it and issues `set_mode_arcball` / `set_mode_slice` to WASM. Going 2D also re-centers the slice on the dataset's XY midpoint (3D orbit has no notion of the 2D pan center).
- `cameraMode` (`App.tsx`) — the raw `"slice" | "arcball" | "fly"` string read back from `ws.camera_mode()`. The **camera-mode toggle** (`handleCameraModeToggle`, shown only in 3D) swaps `arcball` ⇄ `fly`.

These are two different toggles: view-mode crosses the 2D/3D boundary; camera-mode picks the 3D navigation style. Both call `bridge.breakFollow()` (you can't be follow-driven and also steer) and re-emit presence. **Gotcha:** `cameraMode` is React state that *mirrors* WASM — the scene command is the source of truth, and the mirror is best-effort (`try/catch` around `camera_mode()`), so a restore path always re-reads from WASM rather than trusting the React copy.

Each mode setter (`set_mode_slice/arcball/fly` in `wasm.rs`) bumps the **`view` epoch** so the [epoch fast-path](scene-state-and-epochs.md) knows the camera changed. Switching arcball→fly is not a no-op state-wise: it also seeds `base_speed = volume_diagonal * 0.3` so fly speed scales to dataset size. Core provides `Fly::to_arcball` / `Arcball::to_fly` to convert *preserving eye position and view direction*, so a toggle doesn't teleport the viewpoint.

## Input layer: keybindings + RAF loops

Key→action mapping is centralized in `lucida-web/src/config/keyBindings.ts` — a single `keyBindings` record (`fly.forward`=`w`, `camera.toggleFly`=`f`, `clip.increase`=`]`, etc.) plus `getBoundKeys()` and `isActionPressed()`. Nothing reads raw key strings directly; everything goes through `ActionName`. This is the one place to rebind.

`useKeyState` tracks the live pressed-key `Set` on the canvas element, returning a **stable ref read each frame without re-rendering** (RAF loops can't afford React churn). It `preventDefault`s only bound keys and ignores keystrokes while a form input is focused.

Two RAF loops consume that set:

- `useFlyCameraInput` — active only in fly mode. Per frame it folds WASD/QE into translation and IJKL/OU + accumulated pointer delta into yaw/pitch/roll, then fires one `fly_tick` viewport command. Pointer-drag mouselook is captured via `setPointerCapture`. While input is live it forces low-res (interactive) frames and schedules full-res once input stops.
- The `VolumeViewer` loop — handles `clip.increase/decrease` (calls `adjust_clip_distance`) and **edge-detects** `camera.toggleFly` (the `f` key) to swap arcball⇄fly, mirroring `handleCameraModeToggle`. Edge detection matters: a held `f` must toggle once, not every frame.

`ClipMode` (`Plane` | `Sphere`) and `clip_distance` make near samples transparent so you can cut into a volume; both arcball and fly carry them, and `to_arcball`/`to_fly` preserve them across a mode swap.

## 3D chunk-spawn focal depth (#532)

3D chunk loading spawns **center-out** from the view focus (the ray-hit on the volume surface drives `sort_center` in `VisibleRegion`). This feature keeps that priority model but makes the focal *center* movable along the near↔far (Z) axis, so when exploring a large volume the user can bias which depth's chunks load first.

It is purely a **fetch-priority hint** — not camera state, not saved-view/display state. The knob is `depthBiasView` (range −1 near .. +1 far, default `0` = centered) on the planning config store, surfaced by `FocalDepthControl` (a slider in the 3D dimension-controls row, the one discoverable home — no Debug panel needed). In `emit.ts`, `chunkDistanceFromCenter` calls `applyDepthBias`, which shifts `centerZ` by `bias * halfDepth` clamped to the visible Z range.

**Invariant (load-bearing):** at `depthBiasView === 0`, `applyDepthBias` early-returns `centerZ` with *no arithmetic and no clamp* — so the default ordering is byte-identical to the pre-feature behavior, locked by a planner test. Everything else in the center-out priority (importance/distance weights, lane offsets) is untouched.

## Interactions

- **[Planning Domain](planning-domain.md)** — `Camera::visible_region` is the planner's primary input: voxel `xy_bounds`, `z_range`, `effective_zoom` (LOD selection), `sort_center` (center-out order), and `frustum_planes` (per-chunk culling, Gribb-Hartmann from the MVP). The 3D path derives `effective_zoom` from distance *to the ray-hit surface*, not the orbit-target distance, so LOD resolves what you're actually looking at. `depthBiasView` rides the same planning config as every other tunable.
- **[GPU Residency](gpu-residency.md)** — the worker renders from `view_proj` / `inv_view_proj` matrices the camera produces. Camera motion → `view` epoch bump → render path wakes; residency changes only when planning re-runs.
- **[Scene State and Epochs](scene-state-and-epochs.md)** — every camera mutation bumps the `view` epoch and only that; this is what makes a pan or orbit cheap.
- **[Presence and Follow Mode](presence-and-follow-mode.md)** — the camera is part of per-client presence; navigation re-emits it (throttled). Following another peer is mutually exclusive with steering, hence the `breakFollow()` on every toggle.
- **[lucida-web](../crates/lucida-web.md)** — `App.tsx` owns the toggles + `FocalDepthControl`; `VolumeViewer` owns the in-3D input loops.

## Gotchas

- **`viewMode` and `cameraMode` are two separate React states**, both mirrors of the canonical WASM camera. They can drift if a code path mutates the camera without updating the mirror — always re-read `camera_mode()` after a restore rather than trusting the React copy.
- **`set_mode_*` is the conventional path; calling `set_mode_2d/3d/fly` on the inner scene directly bypasses the epoch bump** in `wasm.rs` and the renderer goes silently stale.
- **XY frustum bounds are not clamped to the volume** (only Z is) — for plates the camera may look at a well at a large XY offset, and per-member AABB tests handle visibility downstream. Don't "fix" this by clamping XY.
- **Fly mode key handling is edge-detected and input-focus-gated.** A toggle that fires every frame, or one that steals keystrokes from a text field, means the edge-detect or `isInputFocused` guard was bypassed.
