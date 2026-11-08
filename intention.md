# lucida intention

The north star for what lucida is and who it's for. Keep it short and durable.
If a change makes lucida worse against this document, it's the wrong change.

## In one line

A general, domain-neutral viewer for large n-dimensional array and image data.
Point it at a dataset, local or in object storage, and explore it in 2D or 3D
without downloading it or waiting for it to open. One chunk-lazy engine serves a
human GUI and an agent-driven interface, held to a correctness-first bar, so a
person and an agent can both look at very large data and trust what they see.

## What it's for

Modern n-dimensional data outgrew the download-then-open desktop path. lucida
makes it immediate, fluid, and trustworthy to look at, where it lives and at
full scale.

- Immediate at any size. OME-Zarr loads lazily in chunks, so multi-GB volumes,
  long multichannel timeseries, and collections of hundreds of members open in
  seconds and stream as you move. Scale is the normal case: never assume a
  dataset fits in memory or lives locally.
- Fluid to navigate. It stays smooth at scale.
- Trustworthy. A viewer must never show a value, level, or time as something
  it isn't. A user or agent who misreads the screen is the real failure, so
  correctness outranks smoothness, always.

## Who it's for

Every capability is reachable by a person and by an agent, on the same data and
the same engine.

- People explore and understand: open one dataset or many, fly around, scrub
  the extra dimensions, tune the display, mark things up, save and share a view.
- LLM agents use the engine as their eyes through the Python client, the CLI,
  and the server. An agent drives a specific view, captures what it renders,
  surveys a set, and follows an exploration branch, so it can reason about the
  data and not just its metadata.

## Planning

Planning decides, each tick, which chunks the viewer wants next. Its trade-offs
rank in this order.

1. Stay within memory. GPU and CPU memory caps are hardware limits, so every
   policy is bounded, and anything that holds memory ships with a budget, an
   eviction policy, and a defined behavior for when eviction can't keep up.
   This wins every tie. Under pressure the view covers less and says so, and it
   never lowers the level it asks for.
2. Within the bound, the smoother render beats the cheaper fetch. Between two
   equally correct policies, pick the one that doesn't flicker, even if it
   fetches a little more.
3. Fetch a step ahead of the user's likely next move, such as a zoom step or a
   scrub, because work that starts with the gesture arrives too late. The bound
   caps how far ahead, and within it the smoother path wins.

Every view settles. With no input it reaches a settled state in bounded time,
possibly covering less than it wants, and says so. Previews, captures, the
idle frame loop and agents all wait on settling, so a view that can only end
by timing out is a bug. One that stops making progress for any other reason
ends as stalled and says why.

Planning is a pure function of a snapshot: state carried between ticks is an
explicit input and output, never a hidden cache, so two strategies can be
compared on identical inputs. It does no view math of its own. What is visible,
and at what apparent size, is computed once in `lucida-core` for every client.
If planning needs a number the snapshot lacks, grow the snapshot.

When a change can't satisfy all of these, don't soften one to fit. Say in the PR
which one is being relaxed and why the trade is worth it.
