---
created: 2026-04-18
modified: 2026-04-18
---

# Multi-Channel and Colormaps

How Lucida composes multiple fluorescence channels into one image and applies per-channel display settings. The pipeline runs from `ChannelSettings` in [[lucida-core]] through 15 LUT textures in `colormaps.ts` through composite-key naming in [[gpu-residency]] to `compositor.wgsl`.

## Why multichannel is its own subsystem

Microscopy datasets routinely have 3–6 channels representing different fluorophores. Each channel needs its own contrast, gamma, colormap, and visibility — and they composite together (additive blending by default) to produce the final image. Rolling that into the single-channel display path quickly became unmaintainable, so it lives as a dedicated layer in both the Rust state model and the GPU pipeline.

## Per-channel state

In [[lucida-core]] `scene/types.rs`:

- `ChannelSettings { visible, colormap, contrast_min, contrast_max, gamma }` — five fields, defaulted from the [[scene-state-and-epochs|DatasetDisplaySettings]] when a dataset opens.
- `DatasetDisplaySettings.channel_settings: Vec<ChannelSettings>` — one entry per channel, length set from the first image's `shape[1]` (C dimension).
- `DatasetDisplaySettings.channel_blend_mode: BlendMode` — `Additive` (default) or `Alpha`.

15 colormap variants enumerated in `Colormap` (`Gray`, `Magenta`, `Green`, `Cyan`, `Red`, `Blue`, `Yellow`, `Viridis`, `Inferno`, `Plasma`, `Magma`, `Turbo`, `Hot`, `Cool`, `Jet`). The `default_for_channel` helper rotates through `Magenta`, `Green`, `Cyan` so a fresh dataset opens with sensible per-channel colors.

## Wire commands

`ViewportCommand` variants in `command.rs`:

- `SetMultiChannel { enabled }` — toggles whether channels composite (vs single channel selected by `c`)
- `SetChannelVisible { dataset_id, channel, visible }`
- `SetChannelColormap { dataset_id, channel, colormap }`
- `SetChannelContrast { dataset_id, channel, min, max }`
- `SetChannelGamma { dataset_id, channel, gamma }`
- `SetChannelBlendMode { dataset_id, blend_mode }` — affects all channels of the dataset

Each bumps the `selection` epoch (cheap re-render, no chunk re-fetch).

## LUT pipeline (web)

`lucida-web/src/colormaps.ts` defines 15 RGBA8 ramps as 256-entry tables (1024 bytes each). At init the worker uploads them as a single 256×N texture. The per-channel descriptor (`EntityDescriptor`) carries a `colormap` index; the shader does `textureSample(lutTex, samplerLinear, vec2(intensity, colormapIndex / N))` to look up the color.

The shader path:

1. Sample the chunk atlas at the entity's voxel coords → raw intensity.
2. Apply contrast window: `(intensity - min) / (max - min)`.
3. Apply gamma: `pow(t, 1/gamma)`.
4. LUT sample: `textureSample(lutTex, samplerLinear, vec2(t, 0.5))` (single-channel) or with a per-channel row offset (multichannel).
5. Multiply by `opacity`.

## Composite key naming

Composite keys identify which compositor output buffer a render result lands in:

- **Multichannel**: `${memberId}:ch${channel}` — one buffer per (entity, channel) pair.
- **Single-channel**: bare `${memberId}` — one buffer per entity.

`compositor.wgsl` reads each buffer in turn and accumulates with the chosen blend mode. Mixing the two key formats (e.g. accidentally producing `member:ch0` when the dataset isn't multichannel) silently produces empty composites because the accumulator can't find the buffer.

## Interactions

- **State**: [[scene-state-and-epochs|DocumentState/DatasetDisplaySettings]] holds the per-channel settings.
- **UI**: `LayerPanel.tsx` exposes channel sublayers when multichannel is enabled. `ColormapSelector.tsx` is the dropdown. `ContrastControls.tsx` covers contrast/gamma.
- **Pipeline**: [[planning-domain]] reads `channel_settings[c].visible` to skip invisible channels in proxy enumeration. The orchestrator builds per-channel descriptor entries.
- **GPU**: descriptors carry per-channel colormap/contrast/gamma; the compositor blends.

## Invariants

- **Channel count is set on `DatasetOpened` from `shape[1]`** (the C dimension of the first image's level 0). It's not renegotiated — datasets with variable channel counts across images aren't supported.
- **`channel_settings` length always matches the channel count** after `DatasetOpened`. The `ensure_channel(c)` helper in `command.rs` extends the vector lazily on first use, but `DatasetOpened` initializes the full vector up front.
- **Multichannel mode is a global toggle, not per-dataset.** The `ViewState.multi_channel` boolean affects how every dataset is rendered. Single-mode falls back to the per-dataset `view.c` channel selection.
- **Backward-compat: pre-multichannel `DatasetDisplaySettings` JSON deserializes** with empty `channel_settings` and default `channel_blend_mode` (Additive). Tested in `dataset_display_settings_backward_compat`.

## Gotchas

- **Default colormap rotation is Magenta, Green, Cyan, repeating.** A 4-channel dataset gets `Magenta, Green, Cyan, Magenta`. Test asserts this in `dataset_opened_initializes_channel_settings`. Don't change without considering the visual regression.
- **`SetChannelBlendMode` payload is `dataset_id` + `blend_mode`** — no per-channel override. Wanting per-channel blending would require a new variant (or repurposing `channel_blend_mode` differently).
- **Gamma 0 is allowed by the type system** but explodes in the shader (`pow(t, 1/0)`). UI clamps to a min of ~0.1; if you bypass UI (CLI, Python), be aware.
- **Composite key collisions are silent.** Two datasets with the same `imageId` (which shouldn't happen, but…) collide on the bare-imageId key. Multichannel mode adds the `:chN` suffix and avoids this; single-channel mode is unprotected.
