# lucida — intention (the plot)

The north-star for **what lucida is and who it's for**. Keep it short and durable; the `wiki/`
holds the detailed intent, invariants, and gotchas. Litmus test: *if a change makes lucida worse
against this document, it's the wrong change.*

## In one line

A general, **domain-neutral viewer for large n-dimensional array/image data**: point it at a dataset
(local or in object storage) and explore it interactively, in 2D or 3D, without downloading it or
waiting for it to open.

## What it's for

Modern n-dimensional data outgrew the download-then-open desktop path. lucida makes that data
**immediate, fluid, and trustworthy to look at — where it lives, at full scale — for both people and
agents.** Three pillars:

- **Immediate at any size.** OME-Zarr loaded lazily in chunks: multi-GB volumes, long multichannel
  timeseries, and whole collections/plates of hundreds of members open in seconds and stream as you
  move. "Too big to open" is not a thing.
- **Fluid to navigate.** 2D-slice and 3D-volume views; pan / zoom / orbit; scrub time / Z / channels;
  per-channel contrast / gamma / colormap; a spatial minimap overview; label overlays; saved views;
  annotations; sharing. It must stay smooth at scale.
- **Trustworthy.** It is a *viewer*: it must never silently show a wrong / stale / mis-leveled tile.
  A user or agent who mis-reads the screen is the real failure. **Correctness outranks smoothness,
  always.**

## Who it's for

- **Humans** — the interactive *explore-and-understand loop*: open a dataset (or a whole experiment's
  worth at once), fly around, scrub the extra dimensions, tune the display, mark things up, save and
  share a view. The data should feel present and navigable, not something wrangled offline in batches.
- **LLM agents** — the same chunk-lazy engine as an agent's *eyes*, reached programmatically (Python
  client, wasm/CLI, the server): open a dataset, drive a specific view, and capture what it renders;
  plus purpose-built affordances like guided/branching exploration and thumbnail/contact-sheet
  surveys. Agents should be able to *see and reason about* large multidimensional data — render the
  right view, survey the set, follow an exploration branch — not just read its metadata.

## Invariants that follow (don't lose these)

- **Domain-neutral.** One engine for any n-dimensional array data. Vocabulary stays general
  (channel / dataset / volume / collection / sample / label) — no field-specific jargon anywhere
  (code, docs, tests, fixtures, commits, issues).
- **Chunk-lazy, remote-first.** Never assume the whole dataset fits in memory or lives locally. Scale
  (multi-GB / 3D / timeseries / collections / object storage) is the normal case, not the edge — so
  test against real large/3D/timeseries fixtures, not toys.
- **Correctness-first rendering.** Verify what the viewer actually renders, at retina/DPR2 — a fast
  wrong picture is a failure, not a win.
- **Two users, one system.** Every capability should be reachable by a human GUI *and* by an agent,
  on the same data and the same engine.

## The through-line

**One domain-neutral, chunk-lazy engine; rendered two ways (a human GUI and an agent-driven
interface); held to a correctness-first bar** — so both a person and an agent can look at very large
n-dimensional data and *trust what they see*.
