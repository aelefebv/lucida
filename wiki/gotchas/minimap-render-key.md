---
created: 2026-04-18
modified: 2026-04-18
---

# Minimap Skip-When-Stationary via Render Key

## The footgun

The minimap doesn't re-render every frame. It computes a **render key** from camera state, dataset list, and visible region; if the key matches the previous frame's key, the minimap render is skipped entirely. This saves a non-trivial amount of GPU work because the minimap atlas tends to be hot but the minimap itself rarely needs updating.

The footgun: **adding a new input to minimap rendering without updating the render key** results in a stale minimap. The render visibly fails to reflect the new input — and there's no error.

## Where the key lives

`lucida-web/src/components/Minimap.tsx` (and friends in `renderer/minimapHandlers.ts`) compute and compare the render key. The key is a stringified concatenation of:

- Camera center, zoom, viewport size
- Dataset list (added/removed)
- Visible region bounds
- Active layout id (if applicable)

If you add a new input that affects the minimap visually — e.g. a new "show entity outlines" toggle — you must include it in the render-key computation. Otherwise toggling the option doesn't repaint the minimap until *some other* key-affecting input changes.

## What to do

- **Find the render-key computation** in the minimap path before adding new inputs.
- **Include the new input** in the key, even if it seems unlikely to change.
- **Test by toggling** while everything else is stationary; if the minimap doesn't update, the key is missing the input.

## Why we don't just always render

The minimap renders are cheap individually but add up: each frame's render is one composite pass plus indirection lookups across the entire dataset's overview atlas. Pre-key, the minimap was a measurable fraction of frame time during stationary viewing. The key skip restored that to ~zero cost.

## Related

- [[chunk-pipeline]] — minimap is one of four phases per tick
- [[lucida-web]]
- [[decisions/pull-based-raf-with-typed-dirty]] — related render-skip mechanism
