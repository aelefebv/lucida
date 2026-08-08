---
type: Principle
title: "Runs Anywhere, Open by Default"
description: "Lucida is one open, local-first product that runs on a laptop with no cloud account and scales to remote object stores without changing shape — and dataset size or dimensionality is never a reason not to open something."
tags: [lucida, principle]
source_path: wiki/principles/runs-anywhere-and-open.md
created: 2026-06-25
modified: 2026-06-25
---

# Runs Anywhere, Open by Default

> A product principle. What a *principle* is — and how these are read — is in [Principles](index.md).

## Scope

Lucida is one open, local-first product that runs on a laptop with no cloud account and scales to remote object stores without changing shape — and dataset size or dimensionality is never a reason not to open something. This doc is the guiding light for keeping deployment a single artifact, configuration first-class, and "just open it" the default posture toward big/3D/timeseries data.

## Principles

- **One server, one artifact — the API and the app ship together.**
  - today: the `lucida-server` binary serves both the SPA (with SPA-fallback so deep links survive refresh) and the API/WS routes from one process. There is no separate frontend host. (The *client* binary `lucida` from `lucida-cli` is distinct; "single deployable" refers to the server serving SPA + API.)

- **It runs fully local, with no account, by default.**
  - today: MIT-licensed and local-first; the server binds loopback by default, reads data straight from the filesystem, and treats Google OAuth and remote object stores (`gs://`, `s3://`, `http://`) as optional — point it at a local OME-Zarr and it works with zero credentials.

- **Configurable from day one, not as an afterthought.**
  - today: every operational knob (bind address, data dir, proxy and generated-chunk caches/concurrency, workspace idle TTL, log format, SPA dist path) is set via paired `--flag` / `LUCIDA_*` env var — there is no "edit the source to deploy" step. See [Configurable From Day One for OSS Release](../decisions/0017-configurable-from-day-one-for-oss-release.md).

- **Dataset size is never a reason to avoid opening data.**
  - today: OME-Zarr is read lazily — clients request individual chunks by key, the store fetches and caches them on demand under a memory-bounded LRU, and the whole volume is never loaded. Metadata is kilobytes, so a multi-GB volume opens instantly. (The budgeting/eviction *rule* is planning's — see [Principles — Planning Domain](planning.md) §2; this principle leans on its lazy/chunked consequence.)

- **3D and timeseries are first-class, not special cases.**
  - today: the same chunked path serves 2D slices, Z-slabs, multichannel, and timepoints; opening a 3D or multi-channel timeseries exercises *more* of the viewer, and is the recommended way to use it, not a stress test to avoid.

- **Local and remote data are the same product, not two modes.**
  - today: `object_store` abstracts local filesystem, GCS, S3, and HTTP behind one backend, so moving a dataset to a bucket doesn't change how the viewer, CLI, or Python see it.

## Related

Deployment · lucida-store · [Single-Image Container with `ServeDir` is the Canonical Deploy Unit](../decisions/0020-single-image-with-servedir.md) · [Surface Parity](surface-parity.md)
