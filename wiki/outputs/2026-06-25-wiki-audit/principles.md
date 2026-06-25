# Proposed principles docs (guiding-light) — 2026-06-25

These are draft **product/architecture principles** for `wiki/principles/`, written to match the directional, user-voiced register of the existing `planning.md` — but scoped at the *product* level rather than to one subsystem. Each statement is a guiding light, not a mechanic; each carries a one-line `today:` (grounded in the real system as of this date) or `aspirational:` note so the doc stays honest. Filenames are suggestions; merge or split as you see fit.

---

## `principles/surface-parity.md`

**Scope.** Lucida is reachable from a web viewer, a `lucida` CLI, Python, and (by design) an LLM agent. This doc states the tenet that none of those is a second-class citizen: every surface joins the same workspace, sees the same datasets and the same chunks, and observes the same live state. It governs how we add capabilities — a feature added to one surface should be reachable from the others, not siloed in the SPA.

- **Every surface is a first-class client of the same workspace, not a viewer bolted onto a server.**
  - today: web, CLI, and Python all connect to the same session protocol over `/ws/workspaces/{id}` (and anonymous `/ws`), speaking the same `ClientMessage`/`ServerMessage` envelope from `lucida-core::protocol`. The route, the message types, and the session handler are shared, not per-surface.

- **A Python developer can access the same chunks a user sees in the webview.**
  - today: chunk addressing and visibility math live once in `lucida-core` (compiled to WASM for the web, linked natively by the server, CLI, and Python), so a chunk key means the same thing on every surface; the server serves identical binary chunk frames to whoever asks.

- **What one surface can change, every surface can observe — live.**
  - today: edits broadcast to all connected clients as `CommandBroadcast`; presence, cursor, and per-dataset display flow through the same relay, so a web client, a CLI session, and a Python script can sit in one workspace and see each other's changes.

- **The view math has one home; no surface re-derives it.**
  - today: projected size, frustum, LOD, and importance are computed in `lucida-core` and read via snapshot — the web client does not reimplement them in JS (this is also planning principle 5, viewed from the product level). One implementation, no per-surface drift.

- **Identity and permissions mean the same thing on every surface.**
  - today: workspace auth and the server-authored peer identity apply uniformly; a CLI peer and a web peer are the same kind of participant in the snapshot's peer list.

- **A capability added to one surface should be reachable from the others.**
  - aspirational: partially true. The CLI is rich (peer list, follow capture/apply, slice, montage); Python today exposes scene state and store access (`PyScene`, `PyStore`) but not the full presence/follow or render surface. Treat Python feature gaps as debt against this principle, not as the intended design.

---

## `principles/agent-first-access.md`

**Scope.** Lucida should be drivable without a human in the loop: an LLM agent or a script can orient itself in a dataset, render any view reproducibly, drill to an exact slice, and read a dataset's health — all programmatically, all deterministically. This doc is the guiding light for keeping the product *legible to automation*, not just to a mouse.

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
  - today: a render is fully determined by its `SavedView` (a versioned `v: 1` wire format with defaults stripped), so the same SavedView yields the same image; the montage's JSON sidecar makes each cell independently reproducible.

- **The programmatic surface should be as complete as the rendered one.**
  - aspirational: today the rich agent verbs (montage, headless render, slice, health) are CLI-first; the Python binding does not yet expose montage or render. The guiding light is parity of *capability*, reached through whichever surface an agent prefers.

---

## `principles/collaboration-and-reproducibility.md`

**Scope.** A view in Lucida is a *thing you can hand to someone*. This doc states the tenet that what one user sees, a peer can see and re-open exactly — that a link is state, that any moment of looking is shareable and recoverable, and that collaboration is a property of the shared document, not a bolt-on. It governs how we treat view state: as a first-class, serializable, shareable value.

- **Any view is a link, and the link re-opens that exact view.**
  - today: the SPA continuously encodes the live view into the URL hash as `#view=<gzip+base64 SavedView>` (decision 0013, "URL as app state"); copying the URL shares the view, and loading it (or back/forward via `popstate`) restores it. No separate "save" step is required for a view to be shareable.

- **"Exactly" means the whole moment of looking — camera, slice, channels, contrast, layout.**
  - today: `SavedView` captures camera (2D/arcball/fly), Z-slab + T + C, global and per-dataset display (contrast, gamma, colormap, visibility, order), and the active layout per dataset — so a re-opened view reproduces the moment, not just the position.

- **A named view is the same value as a link, just stored.**
  - today: long or named views are persisted server-side and addressed by an opaque id (`#b=<id>`), with shared/personal/proposed visibility and an approval flow; on apply they collapse back to `#view=`. The id and the inline hash are two encodings of one `SavedView`.

- **A comment points at what its author was looking at.**
  - today: annotations capture the author's `SavedView`; the deep-link `#a=<id>` restores that captured view, so a pin or comment carries its own viewpoint.

- **A peer can see, and follow, what another peer sees.**
  - today: presence (camera/view/display/cursor) broadcasts to all peers via the relay, and a `Follow`/`FollowChanged` handshake exists. Honest caveat: the web client does not yet auto-apply a followed peer's presence in real time (you apply it explicitly today); the CLI captures/applies via `view capture --from-peer` / `view apply`. Live auto-follow in the web viewer is the aspirational end-state.

- **A shared view must mean the same thing on every machine that opens it.**
  - today: the SavedView wire format is deterministic (per-dataset maps are `IndexMap`, not `HashMap`) so the server's rebroadcast is byte-identical — a locked invariant. Local `file://` dataset paths are stripped from shared/stored views (decision 0014) so a link doesn't leak or break across machines.

---

## `principles/runs-anywhere-and-open.md`

**Scope.** Lucida is one open, local-first product that runs on a laptop with no cloud account and scales to remote object stores without changing shape — and dataset size or dimensionality is never a reason not to open something. This doc is the guiding light for keeping deployment a single artifact, configuration first-class, and "just open it" the default posture toward big/3D/timeseries data.

- **One server, one artifact — the API and the app ship together.**
  - today: the `lucida-server` binary serves both the SPA (via `tower_http::ServeDir`/`ServeFile`, with SPA-fallback so deep links survive refresh) and the API/WS routes from one Axum process. There is no separate frontend host. (Note: the *client* binary `lucida` from `lucida-cli` is distinct; "single deployable" refers to the server serving SPA + API.)

- **It runs fully local, with no account, by default.**
  - today: MIT-licensed and local-first; the server binds loopback (`127.0.0.1:9876`) by default, reads data straight from the filesystem, and treats Google OAuth and remote object stores (`gs://`, `s3://`, `http://`) as optional — point it at a local OME-Zarr and it works with zero credentials.

- **Configurable from day one, not as an afterthought.**
  - today: every operational knob (bind address, data dir, proxy and generated-chunk caches/concurrency, workspace idle TTL, log format, SPA dist path) is set via paired `--flag` / `LUCIDA_*` env var through clap — there is no "edit the source to deploy" step.

- **Dataset size is never a reason to avoid opening data.**
  - today: OME-Zarr is read lazily — clients request individual chunks by key (`ChunkRequest`), the store fetches and caches them on demand under a memory-bounded LRU (`CachedStore`), and the whole volume is never loaded. Metadata is kilobytes, so a multi-GB volume opens instantly.

- **3D and timeseries are first-class, not special cases.**
  - today: the same chunked path serves 2D slices, Z-slabs, multichannel, and timepoints; opening a 3D or multi-channel timeseries exercises *more* of the viewer, and is the recommended way to use it, not a stress test to avoid (this is also why CLAUDE.md insists on real, large fixtures).

- **Local and remote data are the same product, not two modes.**
  - today: `object_store` abstracts local filesystem, GCS, S3, and HTTP behind one backend, so moving a dataset to a bucket doesn't change how the viewer, CLI, or Python see it.

---

## How these relate to the existing `planning.md`

`planning.md` is **subsystem-scoped**: it states what the per-tick chunk planner optimizes for (visual smoothness over fetch-optimality, memory as the binding constraint, well coherence, planner purity, WASM-as-truth, anticipation) and is read by the ADRs that cite it. The four docs above are **product-scoped** — they govern cross-cutting tenets (who the clients are, what an agent can do, how views are shared, how/where the thing runs) rather than what any one subsystem optimizes for. They sit alongside `planning.md` under the same "principles are read by, never read from, the rest of the wiki; ADRs cite them" contract.

Intended seams, not overlaps:
- **WASM-as-truth** appears in both: `planning.md` §5 owns it as a *planner* rule ("planning never re-derives projected size"); `surface-parity` restates the same single-implementation fact as the *product* reason multiple surfaces agree. Phrase the surface-parity line as a cross-reference to planning §5 rather than a competing claim.
- **Memory as the binding constraint** stays planning's (`planning.md` §2). `runs-anywhere` deliberately leans on the *lazy/chunked* consequence (size is no barrier) and should defer the budgeting/eviction rule to planning rather than re-litigate it.
- Everything else (multi-surface protocol, agent verbs, SavedView-as-link, single-binary/local-first) is new ground planning.md never covers.

Suggested index update: add the four new entries to `principles/index.md` under "Articles," and note there that planning.md is the one *subsystem* principles doc while these four are *product* principles — so a reader knows which altitude they're reading at.
