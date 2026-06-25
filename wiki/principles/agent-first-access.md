---
created: 2026-06-25
modified: 2026-06-25
---

# Agent-First Access

> A product principle. What a *principle* is — and how these are read — is in [[principles/index]].

## Scope

Lucida should be drivable without a human in the loop: an LLM agent or a script can orient itself in a dataset, render any view reproducibly, drill to an exact slice, and read a dataset's health — all programmatically, all deterministically. This doc is the guiding light for keeping the product *legible to automation*, not just to a mouse.

## Principles

- **An LLM agent can get a montage overview of a dataset easily.**
  - today: `lucida dataset montage` samples a dataset across Z/T/fields into a labeled contact-sheet PNG, with an optional JSON sidecar mapping every cell to its z/t/c indices and a drill-in `#view=` URL. One command turns an opaque volume into an at-a-glance overview an agent can reason about.

- **Any view an agent can describe, it can render headless — no human clicking.**
  - today: `lucida viewer screenshot` / `viewer overview` render an arbitrary view (or a peer's current view) to a PNG. Honest caveat: rendering drives a *headless browser* (Chrome/Chromium + WebGPU over the DevTools Protocol), discovered via `LUCIDA_BROWSER` — there is no browserless native renderer yet, so "headless" means "no human," not "no browser."

- **The overview and the precise render are the same capability at two zoom levels.**
  - today: `dataset montage` and the `viewer` render path both compose an inline `SavedView` and capture it through the chrome-free `render=1` viewer URL — montage is just many SavedViews stitched into a grid. One render path, reused; the montage's drill-in links re-open the exact cell.

- **An agent can drill to an exact slice and get exactly that slice.**
  - today: `lucida view slice --axis {Z|T|C} --index N` sets a precise slice deterministically; the montage sidecar hands an agent the indices to drill into.

- **An agent can read a dataset's health and shape without rendering anything.**
  - today: `lucida dataset info` returns dimensions/channels/layouts and `lucida dataset health` returns server-authored runtime health (binding status, cache, generation) — both browser-free, so an agent can triage before deciding to render.

- **Anything an agent does is reproducible from its inputs.**
  - today: a render is fully determined by its `SavedView` (a versioned wire format with defaults stripped), so the same SavedView yields the same image; the montage's JSON sidecar makes each cell independently reproducible.

- **The programmatic surface should be as complete as the rendered one.**
  - aspirational: today the rich agent verbs (montage, headless render, slice, health) are CLI-first; the Python binding does not yet expose montage or render. The guiding light is parity of *capability*, reached through whichever surface an agent prefers — see [[principles/surface-parity]].

## Related

[[lucida-cli]] · [[saved-views]] · [[principles/surface-parity]] · [[principles/collaboration-and-reproducibility]]
