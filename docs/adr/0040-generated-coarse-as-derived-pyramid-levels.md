# Generated coarse as derived pyramid levels

Status: Accepted.

## Context

Every image or tile needs a coarse fallback level
([ADR 0061](0061-screen-chosen-target-level-with-resident-coarser-levels.md)), but not every
dataset has a source level small enough to hold for a whole collection. The viewer must
supply one without touching the user's data.

## Decision

Image metadata carries an explicit coarse level pointer. If a source level fits the coarse
bounds, the pointer names it. Otherwise the server generates a derived level and stores its
chunks in a server-managed cache. Generated levels are ordinary pyramid levels to the rest of
the pipeline: planning emits normal chunk keys, the server serves chunk bytes, and the client
decodes and samples them like any chunk. Only the server's chunk resolver knows which backing
store owns a level. Generated levels serve only as coarse, never as a detail target.

Invariants:

- The source Zarr is never written, including server-local file datasets.
- Generated levels are appended to metadata and never reorder or replace source levels. A
  level identity is never reused for a different generation config.
- Cached chunks are keyed by source content identity, generation config, image, derived level,
  and chunk key, and are published atomically: write a temporary file, rename it into place,
  then announce readiness.
- A request for a chunk not generated yet gets an explicit pending status, not an error. Real
  misses still fail.
- Readiness arrives as server-authored availability updates that merge into the client's
  manifest. They are not document commands and do not change document content.
- Generation is lazy and runs in the background. Opening a dataset never waits for it. One
  server-wide service owns concurrency, dedupe, and cancellation, and orders work by viewer
  interest: visible first, then predicted, then background fill.

## Rejected alternatives

- Write generated levels into the source store. That mutates the user's data, including
  server-local files ([ADR 0014](0014-local-file-datasets-personal-only-in-saved-views.md)).
- A separate fallback asset class, as proxies were. Duplicates the fetch, cache, upload, and
  shader paths that chunks already have.
- Report a not-yet-generated chunk as a fetch failure. It would look like a transient error
  and trigger retries and failure reporting for data that is simply on its way.
- Generate during open. Makes every open of a large dataset pay for work the view may never
  need.
